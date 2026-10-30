/**
 * Heightmap worker: fetches and decodes a map's heightmap off the main thread (squadHeightmaps.js).
 * Decoding the largest precise heightmaps (6851 x 6870 px, 16-bit) takes 2-3.5 s of JavaScript,
 * which froze the page on every map switch when done on the main thread.
 *
 * Message in: {preciseBase, fallbackUrl, fallbackScale}
 *   - preciseBase: URL of this deployment's /heightmaps/<map>/ (heightmap.png + meta.json)
 *   - fallbackUrl: SquadCalc's 8-bit R/B heightmap.png, used when there is no precise one
 *   - fallbackScale: metres per level of the 8-bit heightmap (SDK_data.heightmapPNG.scale[2])
 * Message out: {levels, width, height, step, precise, preciseLost, url}, `levels` a Uint16Array
 * (transferred) of width x height integer levels, row-major, height in metres = level * step;
 * `preciseLost` when the precise heightmap could not be fetched (network) and the 8-bit one is used
 * instead; or {error, url}.
 *
 * Requests the network drops (connection lost, a server error) are tried again, RETRY_DELAYS_MS
 * apart, before giving up; an HTTP client error (404: this deployment has no precise heightmap)
 * is final at once.
 */
import { decode } from "fast-png";


// Waits before each new attempt of a failed request: 4 attempts over about 7 s
const RETRY_DELAYS_MS = [1000, 2000, 4000];


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


/**
 * The precise heightmap of this deployment: a 16-bit grayscale heightmap.png, height = value * z_step_m
 * of its meta.json. Both files are fetched at once.
 * @param {string} base - URL of /heightmaps/<map>/
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number}|null>} -
 *   null when this deployment has none for the map (or the dev server answers with index.html)
 * @throws {TypeError} - when the network kept failing (fetchBytes)
 */
async function loadPrecise(base) {
    const [metaBytes, bytes] = await Promise.all([fetchBytes(`${base}meta.json`), fetchBytes(`${base}heightmap.png`)]);
    if (!metaBytes || !bytes) return null;
    try {
        const meta = JSON.parse(new TextDecoder().decode(metaBytes));
        const img = decode(bytes);
        if (img.depth !== 16 || img.channels !== 1 || !(meta.z_step_m > 0)) return null;
        return { levels: img.data, width: img.width, height: img.height, step: meta.z_step_m };
    } catch {
        return null;
    }
}


/**
 * SquadCalc's 8-bit heightmap: level = 255 + red - blue (0 to 510)
 * @param {string} url
 * @param {number} scale - metres per level
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number}>}
 * @throws {Error} - when it cannot be fetched
 */
async function loadFallback(url, scale) {
    const bytes = await fetchBytes(url);
    if (!bytes) throw new Error(`HTTP error for ${url}`);
    const { data, width, height, channels } = decode(bytes);
    const levels = new Uint16Array(width * height);
    for (let i = 0; i < levels.length; i++) levels[i] = 255 + data[i * channels] - data[i * channels + 2];
    return { levels, width, height, step: scale };
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
        const url = precise ? `${preciseBase}heightmap.png` : fallbackUrl;
        self.postMessage({ ...result, precise: Boolean(precise), preciseLost, url }, [result.levels.buffer]);
    } catch (error) {
        self.postMessage({ error: String(error), url: fallbackUrl });
    }
};
