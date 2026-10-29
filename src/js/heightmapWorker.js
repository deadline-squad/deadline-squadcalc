/**
 * Heightmap worker: fetches and decodes a map's heightmap off the main thread (squadHeightmaps.js).
 * Decoding the largest precise heightmaps (6851 x 6870 px, 16-bit) takes 2-3.5 s of JavaScript,
 * which froze the page on every map switch when done on the main thread.
 *
 * Message in: {preciseBase, fallbackUrl, fallbackScale}
 *   - preciseBase: URL of this deployment's /heightmaps/<map>/ (heightmap.png + meta.json)
 *   - fallbackUrl: SquadCalc's 8-bit R/B heightmap.png, used when there is no precise one
 *   - fallbackScale: metres per level of the 8-bit heightmap (SDK_data.heightmapPNG.scale[2])
 * Message out: {levels, width, height, step, precise, url}, `levels` a Uint16Array (transferred) of
 * width x height integer levels, row-major, height in metres = level * step; or {error, url}.
 */
import { decode } from "fast-png";


/**
 * Fetch a URL as bytes
 * @param {string} url
 * @returns {Promise<Uint8Array|null>} - null on an HTTP error
 */
async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
}


/**
 * The precise heightmap of this deployment: a 16-bit grayscale heightmap.png, height = value * z_step_m
 * of its meta.json. Both files are fetched at once.
 * @param {string} base - URL of /heightmaps/<map>/
 * @returns {Promise<{levels: Uint16Array, width: number, height: number, step: number}|null>} -
 *   null when this deployment has none for the map (or the dev server answers with index.html)
 */
async function loadPrecise(base) {
    try {
        const [metaResponse, bytes] = await Promise.all([fetch(`${base}meta.json`), fetchBytes(`${base}heightmap.png`)]);
        if (!metaResponse.ok || !bytes) return null;
        const meta = await metaResponse.json();
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
    try {
        const precise = await loadPrecise(preciseBase);
        const result = precise || await loadFallback(fallbackUrl, fallbackScale);
        const url = precise ? `${preciseBase}heightmap.png` : fallbackUrl;
        self.postMessage({ ...result, precise: Boolean(precise), url }, [result.levels.buffer]);
    } catch (error) {
        self.postMessage({ error: String(error), url: fallbackUrl });
    }
};
