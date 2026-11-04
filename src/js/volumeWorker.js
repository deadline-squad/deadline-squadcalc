/**
 * Volume worker: the objects on the landscape (buildings, walls, bridges, trees) as voxel columns, for the line of
 * fire and the fire coverage. Started by squadVolume.js only when the user turned the volume layer on and the map
 * has one (meta.json `volume`); everything heavy is loaded here, off the page:
 *   - the WebAssembly engine (public/engine, built by scripts/build-engine.sh from engine/ and loaded at run
 *     time, so the page builds and runs without it), which holds the voxel columns and answers segment queries
 *     with an exact voxel-column walk (engine/README.md, "Voxel columns");
 *   - the voxel file (volume.vcol, `VCOL1`) and the landscape heights (terrain.bin, `TER1`, volumeTerrain.js)
 *     that publish_volume.py put next to the map's heightmap; both are fetched as <file>?v=<generated> and
 *     checked against the sha256 of meta.json when the browser has crypto.subtle.
 * Positions are in the frame of the files: Unreal metres, X east, Y south, Z up in the game's own Z (the page's
 * heights count from the heightmap's lowest level, meta.json `z_min_m`: squadVolume.js converts).
 * Landscape holes (rivers) and vertices without landscape do not stop a shell; voxels do, wherever they are, so
 * an open window or doorway lets a shell through and a closed one does not.
 *
 * Messages in (handled one at a time, in order):
 *   - `{load: {base, volume, generated, engineUrl, wasmUrl}}`: `base` is the URL of /heightmaps/<map>/, `volume`
 *     the meta.json entry. Answers `{loaded: true}` or `{error}`.
 *   - `{trace: id, paths}`: `paths` are Float64Array polylines (x, y, z per point). For each one the first point
 *     where it meets the landscape or a voxel. Answers `{traced: id, hits}`, a hit `{index, t, z}` or null:
 *     the polyline meets something on the segment ending at point `index`, a fraction `t` of the way from
 *     point `index - 1` (1 for a landscape hit, which is at the point itself), at height `z`.
 *   - `{column: id, x, y}`: the vertical ray through the column at (x, y), for the heights a target can have
 *     there (targetHeights.js). Answers `{columned: id, solids, walled}` or `{columned: id, solids: null}` where
 *     there is no landscape: `solids` are the `[bottom, top]` heights of the landscape (bottom -Infinity) and the
 *     voxel runs above it (cut to start at the ground), ascending; `walled[i]` tells whether the free space above
 *     solid `i` (at least MIN_OPENING high) has solid on both sides of the ray along X or Y within WALL_PROBE metres.
 *   - `{coverageInit: {job, params, origin, east, north}}`, then `{coverageRays: {job, first, size}}` per batch
 *     and `{coverageFinish: job}`: the fire coverage (squadCoverageRays.js) of a weapon at `origin` (x, y), `east`
 *     and `north` being the file-frame displacement of one metre east and north. The rays are sampled here (the
 *     landscape and the voxels), not on the page. Answers `{coverageBatch: job}` per batch and
 *     `{coverageValues: job, values}` (transferred) after the finish; a newer `coverageInit` drops the job.
 */
import { computeCoveragePeaks, createRayClassifier } from "./squadCoverageRays.js";
import { decodeTerrain, terrainHeight } from "./volumeTerrain.js";
import { MIN_OPENING, WALL_PROBE } from "./targetHeights.js";

const VOXEL = "volume";

// Highest index of a voxel column (engine/README.md: at most 4096 height indices per column)
const MAX_HEIGHT_INDICES = 4096;

// Metres above the landscape the vertical ray of a `column` message looks for solids, and below it (a slab
// that starts under the ground still ends above it)
const COLUMN_SCAN_UP = 120;
const COLUMN_SCAN_DOWN = 1;

let engine = null;
let terrain = null;
let topZ = 0;
let bottomZ = 0;
let voxelHeight = 0;
let job = null;
let queue = Promise.resolve();


/**
 * Fetch a file of the volume layer and check its sha256
 * @param {string} url
 * @param {{bytes: number, sha256: string}} entry - the file's meta.json entry
 * @returns {Promise<Uint8Array>}
 * @throws {Error} - on an HTTP error, a wrong size or a failed checksum
 */
async function fetchChecked(url, entry) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== entry.bytes) throw new Error(`${url}: ${bytes.length} bytes, meta.json says ${entry.bytes}`);
    if (crypto.subtle) {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== entry.sha256) throw new Error(`${url}: checksum mismatch`);
    }
    return bytes;
}


/**
 * gunzip bytes with the browser's DecompressionStream
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}


/**
 * Load the engine, the voxel columns and the landscape
 * @param {{base: string, volume: object, generated?: string, engineUrl: string, wasmUrl: string}} request
 */
async function load({ base, volume, generated, engineUrl, wasmUrl }) {
    const query = generated ? `?v=${encodeURIComponent(generated)}` : "";
    const [{ loadEngine }, vcol, terrainBytes] = await Promise.all([
        import(/* webpackIgnore: true */ engineUrl),
        fetchChecked(`${base}${volume.file}${query}`, volume),
        fetchChecked(`${base}${volume.terrain.file}${query}`, volume.terrain),
    ]);
    engine = await loadEngine(wasmUrl);
    engine.loadVcol(VOXEL, vcol);
    terrain = decodeTerrain(await gunzip(terrainBytes));
    bottomZ = volume.z_min_m;
    voxelHeight = volume.dz;
    topZ = bottomZ + MAX_HEIGHT_INDICES * voxelHeight;
}


/**
 * First point of a polyline that meets the landscape or a voxel
 * @param {Float64Array} path - x, y, z per point
 * @returns {{index: number, t: number, z: number}|null}
 */
function firstHit(path) {
    for (let i = 0; i < path.length / 3; i++) {
        const x = path[3 * i];
        const y = path[3 * i + 1];
        const z = path[3 * i + 2];
        if (i > 0) {
            const hit = engine.voxelFirstBlock(VOXEL, [path[3 * i - 3], path[3 * i - 2], path[3 * i - 1], x, y, z]);
            if (hit) return { index: i, t: hit.t, z: path[3 * i - 1] + hit.t * (z - path[3 * i - 1]) };
        }
        const ground = terrainHeight(terrain, x, y);
        if (z < ground) return { index: i, t: 1, z: ground };
    }
    return null;
}


/**
 * Whether the landscape or a voxel is at a point
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {boolean}
 */
function solidAt(x, y, z) {
    if (z < terrainHeight(terrain, x, y)) return true;
    return Boolean(engine.voxelFirstBlock(VOXEL, [x, y, z, x, y, z + 1e-3]));
}


/**
 * The solids on the vertical ray through a position, and whether each free space above them is part of a wall
 * @param {number} x
 * @param {number} y
 * @returns {{solids: Array<[number, number]>, walled: boolean[]}|null} - null where there is no landscape
 */
function columnAt(x, y) {
    const ground = terrainHeight(terrain, x, y);
    if (Number.isNaN(ground)) return null;

    // Voxel runs from just under the ground up, probed at the centre of every voxel; a run that starts under the
    // ground is cut to start at it
    const solids = [[-Infinity, ground]];
    const first = Math.max(0, Math.floor((ground - COLUMN_SCAN_DOWN - bottomZ) / voxelHeight));
    const last = Math.min(MAX_HEIGHT_INDICES - 1, Math.ceil((ground + COLUMN_SCAN_UP - bottomZ) / voxelHeight));
    let runStart = null;
    for (let index = first; index <= last + 1; index++) {
        const occupied = index <= last && Boolean(engine.voxelFirstBlock(VOXEL, [x, y, bottomZ + (index + 0.5) * voxelHeight, x, y, bottomZ + (index + 0.5) * voxelHeight + 1e-3]));
        if (occupied && runStart === null) runStart = index;
        if (!occupied && runStart !== null) {
            const top = bottomZ + index * voxelHeight;
            if (top > ground) solids.push([Math.max(bottomZ + runStart * voxelHeight, ground), top]);
            runStart = null;
        }
    }

    const walled = solids.map(([, top], i) => {
        if (!solids[i + 1] || solids[i + 1][0] - top < MIN_OPENING) return false;
        const middle = (top + solids[i + 1][0]) / 2;
        const jambs = (dx, dy) => solidAt(x - dx, y - dy, middle) && solidAt(x + dx, y + dy, middle);
        return jambs(WALL_PROBE, 0) || jambs(0, WALL_PROBE);
    });
    return { solids, walled };
}


/**
 * Start a coverage job: the geometry of the rays and the buffers the batches fill
 * @param {{job: number, params: object, origin: number[], east: number[], north: number[]}} init
 */
function startCoverage({ job: id, params, origin, east, north }) {
    const peaks = computeCoveragePeaks(params).peaks;
    const classifier = createRayClassifier({ ...params, peaks });
    const { range, cell, rays } = params;
    const stride = classifier.stride;
    const step = Math.max(1, Math.min(3, cell / 4));
    const samples = classifier.samples;
    job = {
        id, params, origin, east, north, classifier, step, samples, stride,
        values: new Uint8Array(rays * stride),
        profile: new Float64Array(samples),
        targetHeights: new Float64Array(stride),
        top: new Float64Array(samples),
        range, cell, rays,
    };
}


/**
 * Sample the landscape and the structures along a ray and classify its cells
 * @param {number} ray
 */
function classifyRay(ray) {
    const { origin, east, north, classifier, step, samples, stride, values, profile, targetHeights, top, cell, rays } = job;
    const heading = (2 * Math.PI * ray) / rays;
    const dx = Math.cos(heading) * east[0] + Math.sin(heading) * north[0];
    const dy = Math.cos(heading) * east[1] + Math.sin(heading) * north[1];

    const structureSamples = [];
    for (let i = 0; i < samples; i++) {
        const x = origin[0] + dx * i * step;
        const y = origin[1] + dy * i * step;
        const ground = terrainHeight(terrain, x, y);
        profile[i] = Number.isNaN(ground) ? -Infinity : ground;
        // The first voxel under the tallest column: the top of what stands here
        const hit = engine.voxelFirstBlock(VOXEL, [x, y, topZ, x, y, Number.isNaN(ground) ? bottomZ : ground]);
        if (hit) {
            const from = Number.isNaN(ground) ? bottomZ : ground;
            top[i] = topZ + hit.t * (from - topZ);
            structureSamples.push(i);
            if (i + 1 < samples) structureSamples.push(i + 1);
        } else {
            top[i] = profile[i];
        }
    }
    const indices = Int32Array.from(new Set(structureSamples));

    for (let j = 1; j < stride; j++) {
        const ground = terrainHeight(terrain, origin[0] + (dx * j * cell), origin[1] + (dy * j * cell));
        targetHeights[j] = ground;
    }

    const structures = {
        top,
        indices,
        blocked: (i, before, at) => Boolean(engine.voxelFirstBlock(VOXEL, [
            origin[0] + dx * (i - 1) * step, origin[1] + dy * (i - 1) * step, before,
            origin[0] + dx * i * step, origin[1] + dy * i * step, at,
        ])),
    };
    classifier.classify(ray, profile, targetHeights, values, structures);
}


async function handle(data) {
    if (data.load) {
        await load(data.load);
        postMessage({ loaded: true });
    } else if (data.trace !== undefined) {
        postMessage({ traced: data.trace, hits: data.paths.map(firstHit) });
    } else if (data.column !== undefined) {
        postMessage({ columned: data.column, ...(columnAt(data.x, data.y) ?? { solids: null }) });
    } else if (data.coverageInit) {
        startCoverage(data.coverageInit);
    } else if (data.coverageRays) {
        const { job: id, first, size } = data.coverageRays;
        if (job?.id !== id) return;
        for (let ray = first; ray < first + size; ray++) classifyRay(ray);
        postMessage({ coverageBatch: id });
    } else if (data.coverageFinish) {
        if (job?.id !== data.coverageFinish) return;
        const { values } = job;
        job = null;
        postMessage({ coverageValues: data.coverageFinish, values }, [values.buffer]);
    }
}


onmessage = ({ data }) => {
    queue = queue.then(() => handle(data)).catch((error) => postMessage({ error: String(error?.message ?? error), request: Object.keys(data)[0] }));
};
