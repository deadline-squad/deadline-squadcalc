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
 *   - `{heatInit: {job, params, target, east, north, region}}`, then `{heatRays: {job, first, size}}` per batch and
 *     `{heatFinish: job}`: the reverse-position heatmap (positionHeatmap.js) of a target at `target` (x, y), `east` and
 *     `north` being the file-frame displacement of one metre east and north; `params` are those of
 *     createPositionClassifier without `heightAt`, `pathBlocked` (the worker supplies the landscape and the engine);
 *     `region` is the meta.json entry of a precision region of the target or null. The line of fire is traced with the
 *     voxel-column walk, and inside the region with the exact triangles too (engine/README.md, "Precision pass").
 *     Answers `{heatReady: job, exact, loadMs}` to the init (`exact`: the region was loaded), `{heatBatch: job}` per
 *     batch and `{heatValues: job, values, computeMs}` (transferred) after the finish; a newer `heatInit` drops the job.
 *   - `{cover: {id, explosion, cell, impact, east, north, impactZ}}`: the damage zone of an explosion (squadDamage.damageField)
 *     with the objects as cover: `impact` is the (x, y) of the round, `east` and `north` the file-frame displacement of
 *     one metre east and north, `impactZ` the height it lands at (file Z). Answers `{covered: id, damage, exposed, size}`
 *     (the two fields transferred), or `{covered: id, size: 0}` where the impact is not on the landscape.
 */
import { computeCoveragePeaks, createRayClassifier } from "./squadCoverageRays.js";
import { decodeTerrain, terrainHeight } from "./volumeTerrain.js";
import { MIN_OPENING, WALL_PROBE } from "./targetHeights.js";
import { damageField } from "./squadDamage.js";
import { createPositionClassifier } from "./positionHeatmap.js";

const VOXEL = "volume";
const REGION = "region";

// Metres a point may lie under the landscape without meeting it: the trajectory solver lands a shell on the target
// within 1e-9 m, so a target on the landscape itself ends a hair under it
const TERRAIN_TOLERANCE = 1e-4;

// Highest index of a voxel column (engine/README.md: at most 4096 height indices per column)
const MAX_HEIGHT_INDICES = 4096;

// Metres above the landscape the vertical ray of a `column` message looks for solids, and below it (a slab
// that starts under the ground still ends above it)
const COLUMN_SCAN_UP = 120;
const COLUMN_SCAN_DOWN = 1;

// URL of the map's files and the cache key their requests carry, for the files fetched later (precision regions)
let mapBase = "";
let mapQuery = "";
let engine = null;
let terrain = null;
let topZ = 0;
let bottomZ = 0;
let voxelHeight = 0;
let job = null;
let heat = null;
let regionLoaded = false;
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
    mapBase = base;
    mapQuery = query;
    engine = await loadEngine(wasmUrl);
    engine.loadVcol(VOXEL, vcol);
    terrain = decodeTerrain(await gunzip(terrainBytes));
    bottomZ = volume.z_min_m;
    voxelHeight = volume.dz;
    topZ = bottomZ + MAX_HEIGHT_INDICES * voxelHeight;
}


/**
 * First point of a polyline that meets the landscape or a voxel. The landscape is met at a point that lies more than
 * TERRAIN_TOLERANCE under it. Of a voxel and the landscape on the same segment (a voxel buried under the ground) the
 * one the segment reaches first is reported, the landscape at the height where the segment crosses it.
 * @param {Float64Array} path - x, y, z per point
 * @returns {{index: number, t: number, z: number}|null}
 */
function firstHit(path) {
    for (let i = 0; i < path.length / 3; i++) {
        const x = path[3 * i];
        const y = path[3 * i + 1];
        const z = path[3 * i + 2];
        const ground = terrainHeight(terrain, x, y);
        const underGround = z < ground - TERRAIN_TOLERANCE;
        if (i > 0) {
            const fromX = path[3 * i - 3];
            const fromY = path[3 * i - 2];
            const fromZ = path[3 * i - 1];
            const hit = engine.voxelFirstBlock(VOXEL, [fromX, fromY, fromZ, x, y, z]);
            if (hit) {
                const voxelHit = { index: i, t: hit.t, z: fromZ + hit.t * (z - fromZ) };
                if (!underGround) return voxelHit;
                const clearance = fromZ - terrainHeight(terrain, fromX, fromY);
                const crossing = clearance / (clearance - (z - ground));
                if (!(crossing < hit.t)) return voxelHit;
                return { index: i, t: crossing, z: fromZ + crossing * (z - fromZ) };
            }
        }
        if (underGround) return { index: i, t: 1, z: ground };
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


/**
 * Start a heatmap job: load the target's precision region, if it has one, and build the classifier of the rays
 * @param {{job: number, params: object, target: number[], east: number[], north: number[], region: object|null}} init
 * @returns {Promise<{exact: boolean, loadMs: number}>}
 */
async function startHeatmap({ job: id, params, target, east, north, region }) {
    heat = null;
    const started = performance.now();
    regionLoaded = false;
    if (region) {
        // A region that cannot be loaded leaves the voxel walk to decide
        try {
            engine.loadRegion(REGION, VOXEL, await fetchChecked(`${mapBase}${region.file}${mapQuery}`, region));
            regionLoaded = true;
        } catch (error) {
            console.warn("[VOLUME] The precision region could not be loaded, using the voxels alone:", error.message ?? error);
        }
    }
    const loadMs = performance.now() - started;

    const worldX = (e, n) => target[0] + e * east[0] + n * north[0];
    const worldY = (e, n) => target[1] + e * east[1] + n * north[1];
    const segment = new Array(6);
    const firstBlock = regionLoaded
        ? (seg) => engine.precisionFirstBlock(REGION, VOXEL, seg)
        : (seg) => engine.voxelFirstBlock(VOXEL, seg);
    const classifier = createPositionClassifier({
        ...params,
        heightAt: (e, n) => terrainHeight(terrain, worldX(e, n), worldY(e, n)),
        pathBlocked: (points, count) => {
            for (let i = 1; i < count; i++) {
                for (let k = 0; k < 2; k++) {
                    const p = 3 * (i - 1 + k);
                    segment[3 * k] = worldX(points[p], points[p + 1]);
                    segment[3 * k + 1] = worldY(points[p], points[p + 1]);
                    segment[3 * k + 2] = points[p + 2];
                }
                if (firstBlock(segment)) return true;
            }
            return false;
        },
    });
    heat = { id, classifier, values: new Uint8Array(params.rays * classifier.stride), computeMs: 0 };
    return { exact: regionLoaded, loadMs };
}


/**
 * The damage zone of an explosion with the landscape and the objects as cover
 * @param {{explosion: object, cell: number, impact: number[], east: number[], north: number[], impactZ: number}} request
 * @returns {{damage: Float32Array, exposed: Float32Array, size: number}|null} - null where the impact is off the landscape
 */
function coverZone({ explosion, cell, impact, east, north, impactZ }) {
    if (Number.isNaN(terrainHeight(terrain, impact[0], impact[1]))) return null;
    const worldX = (e, n) => impact[0] + e * east[0] + n * north[0];
    const worldY = (e, n) => impact[1] + e * east[1] + n * north[1];
    // Off the landscape no soldier stands, and nothing hides one: -Infinity keeps the horizon sweep finite
    const heightAt = (e, n) => {
        const ground = terrainHeight(terrain, worldX(e, n), worldY(e, n));
        return Number.isNaN(ground) ? -Infinity : ground;
    };
    const objects = {
        impactZ,
        blocked: (e0, n0, z0, e1, n1, z1) => Boolean(engine.voxelFirstBlock(VOXEL, [worldX(e0, n0), worldY(e0, n0), z0, worldX(e1, n1), worldY(e1, n1), z1])),
    };
    const { damage, exposed, size } = damageField(heightAt, explosion, cell, {}, objects);
    return { damage, exposed, size };
}


async function handle(data) {
    if (data.load) {
        await load(data.load);
        postMessage({ loaded: true });
    } else if (data.trace !== undefined) {
        postMessage({ traced: data.trace, hits: data.paths.map(firstHit) });
    } else if (data.column !== undefined) {
        postMessage({ columned: data.column, ...(columnAt(data.x, data.y) ?? { solids: null }) });
    } else if (data.heatInit) {
        const { exact, loadMs } = await startHeatmap(data.heatInit);
        postMessage({ heatReady: data.heatInit.job, exact, loadMs });
    } else if (data.heatRays) {
        const { job: id, first, size } = data.heatRays;
        if (heat?.id !== id) return;
        const started = performance.now();
        for (let ray = first; ray < first + size; ray++) heat.classifier.classifyRay(ray, heat.values);
        heat.computeMs += performance.now() - started;
        postMessage({ heatBatch: id });
    } else if (data.heatFinish) {
        if (heat?.id !== data.heatFinish) return;
        const { values, computeMs } = heat;
        heat = null;
        postMessage({ heatValues: data.heatFinish, values, computeMs }, [values.buffer]);
    } else if (data.cover) {
        const zone = coverZone(data.cover);
        if (!zone) postMessage({ covered: data.cover.id, size: 0 });
        else postMessage({ covered: data.cover.id, ...zone }, [zone.damage.buffer, zone.exposed.buffer]);
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
