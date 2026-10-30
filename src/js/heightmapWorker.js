/**
 * Heightmap worker: fetches and decodes a map's heightmap off the main thread (squadHeightmaps.js).
 * Decoding the largest precise heightmaps (6851 x 6870 px, 16-bit) takes seconds of JavaScript,
 * which froze the page on every map switch when done on the main thread.
 *
 * Message in: {preciseBase, fallbackUrl, fallbackScale}
 *   - preciseBase: URL of this deployment's /heightmaps/<map>/ (meta.json, heightmap.webp, heightmap.png)
 *   - fallbackUrl: SquadCalc's 8-bit R/B heightmap.png, used when there is no precise one
 *   - fallbackScale: metres per level of the 8-bit heightmap (SDK_data.heightmapPNG.scale[2])
 * Message out: {levels, width, height, step, precise, preciseLost, url}, `levels` a Uint16Array
 * (transferred) of width x height integer levels, row-major, height in metres = level * step;
 * `preciseLost` when the precise heightmap could not be fetched (network) and the 8-bit one is used
 * instead; or {error, url}.
 *
 * The precise heightmap is announced by meta.json, fetched first: with `format: "webp-rg16"` the heavy file is
 * heightmap.webp (lossless WebP, high byte of the level in red, low byte in green, decoded by the
 * browser itself; tools/heightmaps/py/heightmap_webp.py in the deployment repository), else, or when the
 * WebP cannot be used (the browser cannot decode it, a failed checksum, a missing file), the 16-bit
 * grayscale heightmap.png. A meta.json that is missing means no precise heightmap and no further request.
 * With `generated` in meta.json the heavy file is requested as <file>?v=<generated>: the server can cache it
 * for good, and a rebuilt heightmap has a new URL.
 *
 * Requests the network drops (connection lost, a server error) are tried again, RETRY_DELAYS_MS
 * apart, before giving up; an HTTP client error (404: this deployment has no precise heightmap)
 * is final at once.
 */
import { decode } from "fast-png";


// Waits before each new attempt of a failed request: 4 attempts over about 7 s
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// meta.json `format` of a heightmap that also has a heightmap.webp
const WEBP_FORMAT = "webp-rg16";


/**
 * Fetch a URL as bytes, trying again after a network error or an HTTP server error (5xx)
 * @param {string} url
 * @returns {Promise<Uint8Array|null>} - null on an HTTP client error (404), or a server error on the last attempt
 * @throws {TypeError} - the network error of the last attempt
 */
async function fetchBytes(url) {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return new Uint8Array(await response.arrayBuffer());
            if (response.status < 500 || attempt === RETRY_DELAYS_MS.length) return null;
        } catch (error) {
            if (attempt === RETRY_DELAYS_MS.length) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
}


// Rows of the WebP drawn and read back at a time: the canvas stays small whatever the map's size
const WEBP_STRIP_ROWS = 256;


/**
 * Sum of all levels modulo 2^32: the checksum of meta.json's `webp.levels_sum`
 * @param {Uint16Array} levels
 * @returns {number}
 */
function sumLevels(levels) {
    let sum = 0;
    for (let i = 0; i < levels.length; i++) sum += levels[i];
    return sum % 2 ** 32;
}


/**
 * Decode a heightmap.webp with the browser's WebP decoder: level = red * 256 + green
 * @param {Uint8Array} bytes
 * @returns {Promise<{levels: Uint16Array, width: number, height: number}>}
 * @throws {Error} - when the browser cannot decode it
 */
async function decodeWebp(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    try {
        const { width, height } = bitmap;
        const levels = new Uint16Array(width * height);
        const canvas = new OffscreenCanvas(width, WEBP_STRIP_ROWS);
        const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
        for (let top = 0; top < height; top += WEBP_STRIP_ROWS) {
            const rows = Math.min(WEBP_STRIP_ROWS, height - top);
            context.drawImage(bitmap, 0, top, width, rows, 0, 0, width, rows);
            const pixels = context.getImageData(0, 0, width, rows).data;
            const first = top * width;
            for (let i = 0; i < width * rows; i++) levels[first + i] = (pixels[i * 4] << 8) | pixels[i * 4 + 1];
        }
        return { levels, width, height };
    } finally {
        bitmap.close();
    }
}


/**
 * Decode a 16-bit grayscale PNG (not interlaced): the zlib stream is inflated by the browser
 * (DecompressionStream, several times faster than JavaScript's inflate), the scanline filters undone here.
 * @param {Uint8Array} bytes
 * @returns {Promise<{levels: Uint16Array, width: number, height: number}|null>} - null when it is
 *   another kind of PNG
 */
async function decodePng16(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;

    let width = 0;
    let height = 0;
    let supported = false;
    const compressed = [];
    for (let offset = 8; offset + 8 <= bytes.length;) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            width = view.getUint32(offset + 8);
            height = view.getUint32(offset + 12);
            const [depth, colorType, , , interlace] = data.subarray(8);
            supported = depth === 16 && colorType === 0 && interlace === 0;
        } else if (type === "IDAT") {
            compressed.push(data);
        } else if (type === "IEND") {
            break;
        }
        offset += 12 + length;
    }
    if (!supported) return null;

    // Each scanline: a filter byte, then width 16-bit samples (2 bytes each)
    const stride = width * 2;
    const raw = new Uint8Array((stride + 1) * height);
    const reader = new Blob(compressed).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    let filled = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        if (filled + chunk.value.length > raw.length) return null;
        raw.set(chunk.value, filled);
        filled += chunk.value.length;
    }
    if (filled !== raw.length) return null;

    const levels = new Uint16Array(width * height);
    const noRow = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const row = y * (stride + 1) + 1;
        const filter = raw[row - 1];
        if (filter > 4) return null;
        // The first row has no row above: a row of zeros stands in
        const prev = y > 0 ? raw : noRow;
        const above = y > 0 ? row - stride - 1 : 0;
        if (filter === 1) {
            for (let i = 2; i < stride; i++) raw[row + i] += raw[row + i - 2];
        } else if (filter === 2) {
            for (let i = 0; i < stride; i++) raw[row + i] += prev[above + i];
        } else if (filter === 3) {
            for (let i = 0; i < stride; i++) raw[row + i] += ((i >= 2 ? raw[row + i - 2] : 0) + prev[above + i]) >> 1;
        } else if (filter === 4) {
            for (let i = 0; i < stride; i++) {
                const left = i >= 2 ? raw[row + i - 2] : 0;
                const up = prev[above + i];
                const upLeft = i >= 2 ? prev[above + i - 2] : 0;
                const distLeft = Math.abs(up - upLeft);
                const distUp = Math.abs(left - upLeft);
                const distUpLeft = Math.abs(left + up - 2 * upLeft);
                raw[row + i] += distLeft <= distUp && distLeft <= distUpLeft ? left : distUp <= distUpLeft ? up : upLeft;
            }
        }
        for (let x = 0; x < width; x++) levels[y * width + x] = (raw[row + x * 2] << 8) | raw[row + x * 2 + 1];
    }
    return { levels, width, height };
}


/**
 * The heightmap.webp announced by `meta`
 * @param {string} base - URL of /heightmaps/<map>/
 * @param {object} meta - parsed meta.json with format "webp-rg16"
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number, url: string}|null>} -
 *   null when the file is missing or cannot be used (the PNG is then read)
 * @throws {TypeError} - when the network kept failing (fetchBytes)
 */
async function loadWebp(base, meta) {
    if (!(meta.webp?.z_step_m > 0) || !meta.webp.file) return null;
    const url = versionedUrl(`${base}${meta.webp.file}`, meta);
    const bytes = await fetchBytes(url);
    if (!bytes) return null;
    try {
        const image = await decodeWebp(bytes);
        if ("levels_sum" in meta.webp && sumLevels(image.levels) !== meta.webp.levels_sum) return null;
        return { ...image, step: meta.webp.z_step_m, url };
    } catch {
        return null;
    }
}


/**
 * The heightmap.png of this deployment: 16-bit grayscale, height = value * z_step_m of `meta`
 * @param {string} base - URL of /heightmaps/<map>/
 * @param {object} meta - parsed meta.json
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number, url: string}|null>} -
 *   null when the file is missing or is not a 16-bit grayscale PNG
 * @throws {TypeError} - when the network kept failing (fetchBytes)
 */
async function loadPng(base, meta) {
    const url = versionedUrl(`${base}heightmap.png`, meta);
    const bytes = await fetchBytes(url);
    if (!bytes) return null;
    try {
        const image = await decodePng16(bytes);
        return image && { ...image, step: meta.z_step_m, url };
    } catch {
        return null;
    }
}


/**
 * `url` for the heavy files of a heightmap: with `?v=<meta.generated>` when meta.json has it
 * @param {string} url
 * @param {{generated?: string}} meta
 * @returns {string}
 */
function versionedUrl(url, meta) {
    return meta.generated ? `${url}?v=${encodeURIComponent(meta.generated)}` : url;
}


/**
 * The precise heightmap of this deployment, described by its meta.json (fetched first: a deployment
 * without precise heightmaps costs one small request, not the heavy file).
 * @param {string} base - URL of /heightmaps/<map>/
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number, url: string}|null>} -
 *   null when this deployment has none for the map (or the dev server answers with index.html)
 * @throws {TypeError} - when the network kept failing (fetchBytes)
 */
async function loadPrecise(base) {
    const metaBytes = await fetchBytes(`${base}meta.json`);
    if (!metaBytes) return null;
    let meta;
    try {
        meta = JSON.parse(new TextDecoder().decode(metaBytes));
    } catch {
        return null;
    }
    if (!(meta.z_step_m > 0)) return null;
    const webp = meta.format === WEBP_FORMAT ? await loadWebp(base, meta) : null;
    return webp || loadPng(base, meta);
}


/**
 * SquadCalc's 8-bit heightmap: level = 255 + red - blue (0 to 510)
 * @param {string} url
 * @param {number} scale - metres per level
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number, url: string}>}
 * @throws {Error} - when it cannot be fetched
 */
async function loadFallback(url, scale) {
    const bytes = await fetchBytes(url);
    if (!bytes) throw new Error(`HTTP error for ${url}`);
    const { data, width, height, channels } = decode(bytes);
    const levels = new Uint16Array(width * height);
    for (let i = 0; i < levels.length; i++) levels[i] = 255 + data[i * channels] - data[i * channels + 2];
    return { levels, width, height, step: scale, url };
}


self.onmessage = async ({ data: { preciseBase, fallbackUrl, fallbackScale } }) => {
    let precise = null;
    let preciseLost = false;
    try {
        precise = await loadPrecise(preciseBase);
    } catch {
        preciseLost = true;
    }
    try {
        const result = precise || await loadFallback(fallbackUrl, fallbackScale);
        self.postMessage({ ...result, precise: Boolean(precise), preciseLost }, [result.levels.buffer]);
    } catch (error) {
        self.postMessage({ error: String(error), url: fallbackUrl });
    }
};
