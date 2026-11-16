import { App } from "../app.js";
import { loadCore } from "./squadEngine.js";

// What the page spends on the engine's copy of the levels and on the detail's decoding before it lets the page work: one
// task of at most about this long (the engine does a few milliseconds of work between two checks)
const SLICE_BUDGET_MS = 8;

// Thrown by a pause of the build in slices when a map switch replaced the heightmap meanwhile
const SUPERSEDED = new Error("the heightmap was replaced");

/**
 * Wait for the next task: input and rendering are handled before it. A MessageChannel message starts it without the 4 ms
 * minimum of a chain of setTimeout(0), as in squadCoverage.js.
 * @returns {Promise<void>}
 */
function nextTask() {
    return new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => {
            port1.close();
            resolve();
        };
        port2.postMessage(null);
    });
}


/**
 * Squad Heightmap
 * Load the heightmap of a map in memory and give the height of the game's collision at LatLng points.
 * The heightmap of this deployment (/heightmaps/<map>/: 16-bit levels and meta.json, built from the game's landscape
 * collision fused with its static meshes and SquadHeight's buildings, tools/heightmaps in the deployment repository, and
 * the finer grid where objects stand, `HMD1`) is fetched and decoded into levels in a worker (heightmapWorker.js) so a
 * map switch does not freeze the page, and read by the engine's Rust core (engine/src/heightmap.rs, loaded once by
 * squadEngine.js): the lattice of the samples, the triangle rule and the detail all live there. The core has to live on
 * the page (the heights are read synchronously), so the copy of the levels into it and the decoding of the detail
 * (engine/js/index.mjs, `Heightmap.fromSlices` and `loadDetailInSlices`) run on the page in slices that let it work in
 * between: done in one call they take 47 to 67 ms on Skorpo and 128 ms on Chora, the largest map (8129 x 8129 samples), in
 * Chromium. Sliced, the longest task on Chora is the start of the detail's decoding (`begin_detail`: it allocates the
 * 8 MB bitset and the nodes' buffer). Median / maximum over runs on a machine shared with other jobs, cold (the first
 * load of the map in a browser or process) and warm (the following ones): Chromium 33 / 40 ms cold (5 runs) and 18 / 24
 * ms warm (10 runs); Node 24 / 26 ms cold (13 runs) and 20 / 46 ms warm (55 runs); on Skorpo in Node 16 ms cold and 8 ms
 * warm. Chromium reports no task of 50 ms on Skorpo, Chora or Yehorivka.
 * Events on `document` once the heights of the active map are known (never for a heightmap a map
 * switch replaced meanwhile):
 *   - `heightmapPNG:loaded` when they loaded;
 *   - `heightmap:loaded` after it, also when they failed to load (sessions and imports wait for it
 *     to place their markers).
 * A failed load shows an error toast and sets `failed`: there are no heights then, and the firing
 * solutions say they have no height data (SquadFiringSolution.hasHeightData). A heightmap that loaded without its
 * detail layer (the request failed, or the file is damaged) works on the coarse surface, shows a warning toast and
 * sets `detailFailed`: the firing solution and the coverage say so too.
 * @class squadHeightmap
 */
export default class SquadHeightmap {

    /**
     * Load the heightmap for the given map
     * @param {LeafletMap} [map]
     */
    constructor(map) {
        this.map = map;
        // The engine's Heightmap (engine/js/index.mjs) once the heights loaded, null before, on failure and after dispose
        this.core = null;
        // The engine's frame (X east, Y north, metres) of a LatLng: x = x + lng * xPerLng, y = y + lat * yPerLat; null
        // until a heightmap loaded
        this.toEngine = null;
        // Meters between two samples (the landscape's vertex spacing: 1 m on most maps, 0.5 m on Chora and Kokan, 0.75 m
        // on Anvil, 1.2 m on Skorpo); 0 until a heightmap loaded
        this.resolution = 0;
        // Whether the heights loaded (`heightmapPNG:loaded`), or failed to load: there are none then
        this.ready = false;
        this.failed = false;
        // Whether the finer grid where objects stand is missing on a heightmap that loaded: the heights are the coarse
        // surface's, off by decimetres next to walls and roof edges; `detailError` says why
        this.detailFailed = false;
        this.detailError = "";
        this.worker = null;
        // Start the engine now: it loads while the worker fetches the images
        loadCore().catch(() => {});
        this.load();
    }


    /**
     * Load the heights of the active map in the worker, from /heightmaps/<map>/ of this deployment
     * @returns {void} - the engine reads the heights once `heightmapPNG:loaded` fired; there are none on failure
     */
    load() {
        const mapName = this.map.activeMap.mapURL.split("/").filter(Boolean).pop();
        const base = new URL(`/heightmaps/${mapName}/`, window.location.origin).href;
        this.worker = new Worker(new URL("./heightmapWorker.js", import.meta.url));
        this.worker.onmessage = ({ data }) => this.receive(data);
        this.worker.onerror = (event) => this.receive({ error: event.message, url: base });
        this.worker.postMessage({ base });
    }


    /**
     * Hand the worker's result to the engine and announce it
     * @param {{levels: Uint16Array, width: number, height: number, step: number, url: string,
     *   lattice: {originX: number, originY: number, resolution: number, yawDeg: number},
     *   bounds: {min_x: number, max_x: number, min_y: number, max_y: number},
     *   detail?: Uint8Array|null, detailError?: string}|{error: string, url: string}} data - the levels, and the bytes of
     *   the `HMD1` detail when there is one
     * @returns {Promise<void>} - settles once the engine read the heights (or failed to), and the events fired
     */
    async receive(data) {
        this.stopWorker();
        if (this.map.heightmap !== this) return;

        let error = data.error;
        if (!error) {
            try {
                const engine = await loadCore();
                if (this.map.heightmap !== this) return;
                await this.open(engine, data);
            } catch (failure) {
                if (this.map.heightmap !== this) return;
                error = failure.message ?? String(failure);
            }
        }

        if (error) {
            console.error("[HEIGHTMAP] Failed to load the heightmap:", data.url);
            console.error("[HEIGHTMAP]   -> ", error);
            this.failed = true;
            App.openToast("error", "heightmapFailed", "heightmapFailedDesc");
        } else {
            console.debug(`[HEIGHTMAP] Loaded ${data.url} precision: ${(data.step * 100).toFixed(1)}cm`);
            $(document).trigger("heightmapPNG:loaded");
        }
        $(document).trigger("heightmap:loaded");
    }


    /**
     * Give the levels and the detail to the engine, in slices of SLICE_BUDGET_MS, and set the LatLng frame
     * @param {typeof import("../../engine/js/index.mjs")} engine - the module loaded by squadEngine.js
     * @param {object} data - the worker's result (receive)
     * @returns {Promise<void>} - settles once the heights are readable (`ready`); rejects when the engine refuses the
     *   levels or the frame, and with SUPERSEDED when a map switch replaced this heightmap meanwhile
     */
    async open(engine, { levels, width, height, step, lattice, bounds, detail, detailError }) {
        const pause = this.slicePause();
        // The engine's frame has Y north and yaw counter-clockwise, meta.json's (the worker's gridLattice) Unreal's Y south
        // and yaw clockwise; the heights count from the lowest level (z_min 0): squadVolume.js converts to the game's Z
        const core = await engine.Heightmap.fromSlices(levels, {
            width, height, zStep: step, origin: [lattice.originX, -lattice.originY], spacing: lattice.resolution, yawDeg: -lattice.yawDeg,
        }, pause);

        this.detailError = detailError ?? "";
        if (detail) {
            try {
                await core.loadDetailInSlices(detail, pause);
            } catch (failure) {
                if (failure === SUPERSEDED) {
                    core.free();
                    throw failure;
                }
                this.detailError = failure.message ?? String(failure);
            }
        }

        this.core = core;
        this.resolution = lattice.resolution;
        // The map spans the minimap bounds: a LatLng is at world x = min_x + lng * size_x / pixelSize,
        // y = min_y - lat * size_y / pixelSize (Unreal's Y south), which is Y = lat * size_y / pixelSize - min_y north
        this.toEngine = {
            x: bounds.min_x, xPerLng: (bounds.max_x - bounds.min_x) / this.map.pixelSize,
            y: -bounds.min_y, yPerLat: (bounds.max_y - bounds.min_y) / this.map.pixelSize,
        };
        this.ready = true;

        if (this.detailError) {
            this.detailFailed = true;
            console.warn("[HEIGHTMAP] Heights without the detail where objects stand:", this.detailError);
            App.openToast("warning", "heightmapDetailFailed", "heightmapDetailFailedDesc");
        }
    }


    /**
     * The pause of a build in slices (open): lets the page work once SLICE_BUDGET_MS went by since the last time
     * @returns {function(): Promise<void>} - throws SUPERSEDED after the wait when a map switch replaced this heightmap,
     *   which stops the build
     */
    slicePause() {
        let deadline = performance.now() + SLICE_BUDGET_MS;
        return async () => {
            if (performance.now() < deadline) return;
            await nextTask();
            if (this.map.heightmap !== this) throw SUPERSEDED;
            deadline = performance.now() + SLICE_BUDGET_MS;
        };
    }


    /**
     * Stop a load in progress (the map switched to another one) and free the engine's copy of the heights
     */
    dispose() {
        this.stopWorker();
        this.core?.free();
        this.core = null;
        this.ready = false;
    }


    /**
     * Terminate the worker, which has delivered or is no longer wanted
     */
    stopWorker() {
        if (this.worker) this.worker.terminate();
        this.worker = null;
    }


    /**
     * Height at a LatLng Point on the game's collision surface: every quad of four heightmap samples
     * is two triangles split along the diagonal from its (row, col) corner to its (row + 1, col + 1)
     * corner, the split of the game's landscape collision (found with positions the game server logged:
     * tools/heightmaps/py/audit_ground_truth.py in the deployment repository), and the height is
     * interpolated on the triangle the point is in. The samples are the landscape's own vertices, so on bare
     * ground this is the game's collision exactly. Bilinear interpolation differs from it by the quad's twist times
     * fy * (1 - fx), up to a quarter of the twist at the quad's centre (1.1 m on the steepest Al Basrah quad). A quad that
     * has detail (next to a wall or a roof edge) is read the same way on its sub-grid, and a quad without it beside one
     * that has it shares the nodes of their edge: the surface has no jump (engine/src/heightmap.rs).
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Altitude
     * @param {LatLng} latlng - LatLng Point
     * @param {number} [none=NaN] - what to give where there is no height: before the heightmap loaded, after it failed to,
     *   for a coordinate that is not a number, and more than half a sample outside the lattice (the edge sample holds
     *   within half a sample, and the lattice covers the whole minimap on every map). The firing solution reads NaN as
     *   "no height data"; the callers that sample the ground around a point, which may lie off the map, pass 0
     *   (the lowest level, nothing the shell or the explosion meets)
     * @returns {number} - height in meters above the heightmap's lowest level, or `none`
     */
    getHeight(latlng, none = NaN) {
        if (!this.core) return none;
        const { x, xPerLng, y, yPerLat } = this.toEngine;
        const height = this.core.heightAt(x + latlng.lng * xPerLng, y + latlng.lat * yPerLat);
        return Number.isNaN(height) ? none : height;
    }


    /**
     * Heights at many LatLng points in one call to the engine, `getHeight` for each
     * @param {Float64Array} latLngs - lat0, lng0, lat1, lng1, ...
     * @param {number} [none=NaN] - the height of a point without one (see getHeight)
     * @returns {Float64Array} - one height per point
     */
    getHeights(latLngs, none = NaN) {
        const count = latLngs.length / 2;
        if (!this.core) return new Float64Array(count).fill(none);
        const { x, xPerLng, y, yPerLat } = this.toEngine;
        const xy = new Float64Array(latLngs.length);
        for (let i = 0; i < latLngs.length; i += 2) {
            xy[i] = x + latLngs[i + 1] * xPerLng;
            xy[i + 1] = y + latLngs[i] * yPerLat;
        }
        const heights = this.core.heights(xy);
        if (!Number.isNaN(none)) {
            for (let i = 0; i < count; i++) if (Number.isNaN(heights[i])) heights[i] = none;
        }
        return heights;
    }


    /**
     * Calculate a path of heights between two points, with optional terrain margins
     * @param {LatLng} mortarLatlng
     * @param {LatLng} targetLatlng
     * @param {number} STEP - samples between weapon and target
     * @param {number} extraBefore - fraction of path to extend before weapon
     * @param {number} extraAfter  - fraction of path to extend after target
     * @returns {{ path: number[], weaponIndex: number, targetIndex: number }} - the margins may reach off the map: 0 there
     */
    getHeightPath(mortarLatlng, targetLatlng, STEP = 100, extraBefore = 0.15, extraAfter = 0.15) {
        const latDiff = targetLatlng.lat - mortarLatlng.lat;
        const lngDiff = targetLatlng.lng - mortarLatlng.lng;

        const extraBeforeSteps = Math.round(STEP * extraBefore);
        const extraAfterSteps  = Math.round(STEP * extraAfter);
        const totalSteps = STEP + extraBeforeSteps + extraAfterSteps;

        const START = {
            lat: mortarLatlng.lat - latDiff * extraBefore,
            lng: mortarLatlng.lng - lngDiff * extraBefore,
        };
        const totalLatDiff = latDiff * (1 + extraBefore + extraAfter);
        const totalLngDiff = lngDiff * (1 + extraBefore + extraAfter);

        const latLngs = new Float64Array(totalSteps * 2);
        for (let i = 0; i < totalSteps; i++) {
            latLngs.set([START.lat, START.lng], i * 2);
            START.lat += totalLatDiff / totalSteps;
            START.lng += totalLngDiff / totalSteps;
        }

        return {
            path: Array.from(this.getHeights(latLngs, 0)),
            weaponIndex: extraBeforeSteps,
            targetIndex: extraBeforeSteps + STEP - 1,
        };
    }

}
