import { App } from "../app.js";
import pkg from "../../package.json";
import { classifyColumn } from "./targetHeights.js";
import { pickRegion } from "./positionHeatmap.js";

// Entries the line-of-fire answers are remembered for: more than a session needs, far below any memory concern
const MAX_CACHED_ANSWERS = 2000;

// Rays the page sends to the worker in one message: the worker answers a firing solution between two batches
const RAYS_PER_BATCH = 16;

// Rays of a position heatmap per message: each ray has up to 160 positions with five lines of fire traced
const HEAT_RAYS_PER_BATCH = 8;

/**
 * Volume layer of a squadMinimap: the objects on the landscape (buildings, walls, bridges, trees) as voxel
 * columns, loaded in a worker (volumeWorker.js) only when the user turned the setting on and the map has a volume
 * file (meta.json `volume`, written by publish_volume.py). While it is not `ready` (setting off, map without
 * volume layer, still loading, failed to load) every consumer keeps using the heightmap, which fuses the
 * buildings with the landscape.
 * Consumers: SquadFiringSolution.getObstacle (the line of fire to a target) and SquadCoverage (the fire coverage).
 * Event on `document` when the layer became usable: `volume:ready`.
 */
export default class SquadVolume {

    /**
     * @param {squadMinimap} map
     */
    constructor(map) {
        this.map = map;
        this.state = "idle";
        this.heightmap = null;
        this.worker = null;
        this.bounds = null;
        // The page's heights (SquadHeightmap.getHeight) are metres above the heightmap's lowest level, `z_min_m` of
        // meta.json; the files of the layer hold the game's own Z: add zMin to a height of the page to get theirs
        this.zMin = 0;
        this.requests = new Map();
        this.requestId = 0;
        this.answers = new Map();
        this.pending = new Set();
        this.refreshQueued = false;
        // Counts the loads (and disposals): a load that finds another one started after it, or the layer disposed, stops
        this.loadId = 0;
        this.coverageJob = null;
        this.coverageJobs = 0;
        this.heatJob = null;
        this.heatJobs = 0;
        // Precision regions of the active map (meta.json `volume.regions`)
        this.regions = [];
        $(document).on("heightmapPNG:loaded", () => this.load());
    }

    /**
     * Whether the user wants the layer (the setting)
     * @returns {boolean}
     */
    get enabled() {
        return Boolean(App.userSettings?.volumeLayer);
    }

    /**
     * Whether the layer of the active map can answer: on, loaded, and for the heightmap that is on the map now
     * @returns {boolean}
     */
    get ready() {
        return this.state === "ready" && this.heightmap === this.map.heightmap && this.enabled;
    }

    /**
     * React to the setting: load the layer when it was turned on, drop it when it was turned off
     */
    applySetting() {
        if (this.enabled) this.load();
        else this.dispose();
        this.map.updateTargets();
    }

    /**
     * Load the layer of the active map, once: meta.json first, then the worker with the engine and the files.
     * Does nothing when the setting is off, the heightmap is not there yet, or the layer is loading or loaded for it.
     * A map without volume entry, or a load that fails, leaves the state "unavailable" (the heightmap is kept).
     * @returns {Promise<void>}
     */
    async load() {
        const heightmap = this.map.heightmap;
        if (!this.enabled || !heightmap || heightmap.failed) return;
        if (this.heightmap === heightmap && this.state !== "idle") return;
        this.dispose();
        const loadId = this.loadId;
        this.heightmap = heightmap;
        this.state = "loading";

        const mapName = this.map.activeMap.mapURL.split("/").filter(Boolean).pop();
        const base = new URL(`/heightmaps/${mapName}/`, window.location.origin).href;
        try {
            const response = await fetch(`${base}meta.json`);
            const meta = response.ok ? await response.json() : null;
            if (loadId !== this.loadId) return;
            if (!meta?.volume) {
                console.debug(`[VOLUME] ${mapName} has no volume layer`);
                this.state = "unavailable";
                return;
            }
            this.bounds = meta.bounds_m;
            this.zMin = meta.z_min_m;
            this.regions = meta.volume.regions ?? [];
            await this.start(base, meta);
            if (loadId !== this.loadId) return;
            this.state = "ready";
            console.debug(`[VOLUME] Loaded ${mapName}: ${meta.volume.bytes} + ${meta.volume.terrain.bytes} bytes`);
            $(document).trigger("volume:ready");
            this.map.updateTargets();
        } catch (error) {
            if (loadId !== this.loadId) return;
            console.warn("[VOLUME] The volume layer could not be loaded, using the heightmap:", error.message ?? error);
            this.dispose();
            this.heightmap = heightmap;
            this.state = "unavailable";
        }
    }

    /**
     * Start the worker and wait for it to load the engine and the files
     * @param {string} base - URL of /heightmaps/<map>/
     * @param {object} meta - its meta.json
     * @returns {Promise<void>}
     * @throws {Error} - when the worker cannot start or fails to load
     */
    start(base, meta) {
        const worker = new Worker(new URL("./volumeWorker.js", import.meta.url));
        this.worker = worker;
        return new Promise((resolve, reject) => {
            worker.onerror = (event) => {
                this.failWorker(event.message);
                reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
                if (data.loaded) {
                    worker.onmessage = (message) => this.receive(message.data);
                    resolve();
                } else if (data.error) {
                    reject(new Error(data.error));
                }
            };
            worker.postMessage({
                load: {
                    base,
                    volume: meta.volume,
                    generated: meta.generated,
                    engineUrl: new URL(`/engine/index.mjs?v=${pkg.version}`, window.location.origin).href,
                    wasmUrl: new URL(`/engine/pkg/squad_engine_bg.wasm?v=${pkg.version}`, window.location.origin).href,
                },
            });
        });
    }

    /**
     * A worker that failed after loading: answer what waits with nothing and fall back to the heightmap
     * @param {string} message
     */
    failWorker(message) {
        console.warn("[VOLUME] The worker failed, using the heightmap:", message);
        this.requests.forEach((resolve) => resolve(null));
        this.requests.clear();
        this.coverageJob?.resolve(null);
        this.coverageJob = null;
        this.heatJob?.resolve(null);
        this.heatJob = null;
        this.state = "unavailable";
        this.worker?.terminate();
        this.worker = null;
        this.map.updateTargets();
    }

    /**
     * Handle a message of the loaded worker
     * @param {object} data
     */
    receive(data) {
        if (data.traced !== undefined) {
            this.requests.get(data.traced)?.(data.hits);
            this.requests.delete(data.traced);
        } else if (data.columned !== undefined) {
            this.requests.get(data.columned)?.(data);
            this.requests.delete(data.columned);
        } else if (data.covered !== undefined) {
            this.requests.get(data.covered)?.(data);
            this.requests.delete(data.covered);
        } else if (data.heatReady !== undefined) {
            if (this.heatJob?.id === data.heatReady) this.heatJob.ready(data);
        } else if (data.heatBatch !== undefined) {
            if (this.heatJob?.id === data.heatBatch) this.heatJob.next();
        } else if (data.heatValues !== undefined) {
            if (this.heatJob?.id === data.heatValues) this.heatJob.resolve({ ...this.heatJob.stats, values: data.values, computeMs: data.computeMs });
        } else if (data.coverageBatch !== undefined) {
            if (this.coverageJob?.id === data.coverageBatch) this.coverageJob.next();
        } else if (data.coverageValues !== undefined) {
            if (this.coverageJob?.id === data.coverageValues) this.coverageJob.resolve(data.values);
        } else if (data.error) {
            this.failWorker(data.error);
        }
    }

    /**
     * Stop the worker and forget the answers
     */
    dispose() {
        this.loadId++;
        this.requests.forEach((resolve) => resolve(null));
        this.requests.clear();
        this.coverageJob?.resolve(null);
        this.coverageJob = null;
        this.heatJob?.resolve(null);
        this.heatJob = null;
        this.regions = [];
        if (this.worker) this.worker.terminate();
        this.worker = null;
        this.answers.clear();
        this.pending.clear();
        this.state = "idle";
        this.heightmap = null;
        this.bounds = null;
    }

    /**
     * Position in the frame of the volume files (Unreal metres, X east, Y south) of a LatLng of the map: the
     * heightmap grid spans the bounds of meta.json from the map's min corner to its max corner
     * @param {{lat: number, lng: number}} latlng
     * @returns {{x: number, y: number}}
     */
    toWorld(latlng) {
        const { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY } = this.bounds;
        return {
            x: minX + (latlng.lng * (maxX - minX)) / this.map.pixelSize,
            y: minY + (-latlng.lat * (maxY - minY)) / this.map.pixelSize,
        };
    }

    /**
     * First point where polylines meet the landscape or an object
     * @param {Float64Array[]} paths - x, y, z per point, in the frame of toWorld
     * @returns {Promise<Array<{index: number, t: number, z: number}|null>|null>} - the worker's hits (volumeWorker.js);
     *   null when the layer cannot answer
     */
    trace(paths) {
        if (!this.worker) return Promise.resolve(null);
        const id = ++this.requestId;
        return new Promise((resolve) => {
            this.requests.set(id, resolve);
            this.worker.postMessage({ trace: id, paths });
        });
    }

    /**
     * The heights a target can have at a point of the map: the landscape, the floors, ceilings, roofs, windows and
     * doorways the vertical ray through the voxel column there crosses (targetHeights.js)
     * @param {{lat: number, lng: number}} latlng
     * @returns {Promise<{landscape: number, choices: Array<{kind: string, height: number, above: number}>}|null>} -
     *   `landscape` is the height of the landscape at the point (without the objects the heightmap fuses with it);
     *   `choices` have their `height` in the page's heights (the frame of SquadHeightmap.getHeight) and `above` the
     *   metres over the landscape, highest first. null when the layer cannot answer (off, loading, no landscape at
     *   the point, worker failed)
     */
    async heightsAt(latlng) {
        if (!this.ready || !this.worker) return null;
        const { x, y } = this.toWorld(latlng);
        const id = ++this.requestId;
        const answer = await new Promise((resolve) => {
            this.requests.set(id, resolve);
            this.worker.postMessage({ column: id, x, y });
        });
        if (!answer?.solids) return null;
        const ground = answer.solids[0][1];
        const choices = classifyColumn(answer.solids, answer.walled).map(({ kind, z }) => ({
            kind,
            height: z - this.zMin,
            above: z - ground,
        }));
        return { landscape: ground - this.zMin, choices };
    }


    /**
     * The damage zone of an explosion with the objects as cover (squadDamage.damageField with `objects`, run by the
     * worker): a soldier behind a wall is covered, one at an open doorway or window is not
     * @param {object} explosion - see squadDamage.impactDamage
     * @param {number} cell - grid step, meters
     * @param {{lat: number, lng: number}} center - where the round lands
     * @param {number} impactHeight - the height it lands at, in the page's heights (the ground, a roof, the floor the
     *   target is on)
     * @returns {Promise<{damage: Float32Array, exposed: Float32Array, size: number}|null>} - the field as damageField
     *   returns it; null when the layer cannot answer or the impact is off the landscape
     */
    async coverZone(explosion, cell, center, impactHeight) {
        if (!this.ready || !this.worker) return null;
        const start = this.toWorld(center);
        const east = this.toWorld(this.map.fromMeters(center, 1, 0));
        const north = this.toWorld(this.map.fromMeters(center, 0, 1));
        const id = ++this.requestId;
        const answer = await new Promise((resolve) => {
            this.requests.set(id, resolve);
            this.worker.postMessage({
                cover: {
                    id,
                    explosion,
                    cell,
                    impact: [start.x, start.y],
                    east: [east.x - start.x, east.y - start.y],
                    north: [north.x - start.x, north.y - start.y],
                    impactZ: impactHeight + this.zMin,
                },
            });
        });
        return answer?.size ? answer : null;
    }


    /**
     * The answer of a line-of-fire question, or undefined while it is being asked. The first call starts the
     * worker's trace; when it is back the targets are drawn again and the call returns the answer.
     * @param {string} key - everything that determines the path
     * @param {function(): {path: Float64Array, toObstacle: function(object|null): object|null}} build - the path
     *   and the conversion of the worker's hit into the answer; called only when the answer is not known
     * @returns {object|null|undefined} - the answer; undefined when it is not known yet
     */
    lookup(key, build) {
        if (this.answers.has(key)) return this.answers.get(key);
        if (this.pending.has(key)) return undefined;
        this.pending.add(key);
        const { path, toObstacle } = build();
        this.trace([path]).then((hits) => {
            if (!this.pending.delete(key) || !hits) return;
            if (this.answers.size >= MAX_CACHED_ANSWERS) this.answers.clear();
            this.answers.set(key, toObstacle(hits[0]));
            this.refresh();
        });
        return undefined;
    }

    /**
     * Draw the targets again, once for all the answers that came in the same frame
     */
    refresh() {
        if (this.refreshQueued) return;
        this.refreshQueued = true;
        requestAnimationFrame(() => {
            this.refreshQueued = false;
            this.map.updateTargets();
        });
    }

    /**
     * Reverse-position heatmap of a target (positionHeatmap.js): the worker traces the lines of fire from the ground
     * positions around it with the voxel walk and, where the target has a precision region (meta.json
     * `volume.regions`), the exact triangles around it
     * @param {object} params - the classifier's parameters (positionHeatmap.createPositionClassifier) without
     *   `heightAt` and `pathBlocked`; `targetZ` in the page's heights
     * @param {{lat: number, lng: number}} target - the target
     * @param {function(number, number): {lat: number, lng: number}} fromMeters - LatLng at (east, north) meters from `target`
     * @param {function(): boolean} isCurrent - false once a newer computation replaced this one
     * @param {function(number): void} [onProgress] - receives the share of the rays dealt, 0 to 1
     * @returns {Promise<{values: Uint8Array, exact: boolean, margin: number, loadMs: number, computeMs: number}|null>} -
     *   the HEAT value of every position of every ray, whether the exact triangles were used and how far from the
     *   target they reach (`margin`, metres; 0 without), the milliseconds the worker spent loading the region and
     *   tracing; null when the job was replaced or the worker failed
     */
    positionHeatmap(params, target, fromMeters, isCurrent, onProgress) {
        this.heatJob?.resolve(null);
        const start = this.toWorld(target);
        const east = this.toWorld(fromMeters(target, 1, 0));
        const north = this.toWorld(fromMeters(target, 0, 1));
        const region = pickRegion(this.regions, start.x, start.y);
        const id = ++this.heatJobs;
        const worker = this.worker;

        return new Promise((resolve) => {
            let nextRay = 0;
            const job = {
                id,
                stats: null,
                resolve: (result) => {
                    if (this.heatJob === job) this.heatJob = null;
                    resolve(result);
                },
                ready: ({ exact, loadMs }) => {
                    job.stats = { exact, margin: exact ? region.margin : 0, loadMs };
                    job.next();
                },
                next: () => {
                    if (!isCurrent()) {
                        job.resolve(null);
                        return;
                    }
                    if (nextRay >= params.rays) {
                        worker.postMessage({ heatFinish: id });
                        return;
                    }
                    const size = Math.min(HEAT_RAYS_PER_BATCH, params.rays - nextRay);
                    worker.postMessage({ heatRays: { job: id, first: nextRay, size } });
                    nextRay += size;
                    onProgress?.(nextRay / params.rays);
                },
            };
            this.heatJob = job;
            worker.postMessage({
                heatInit: {
                    job: id,
                    params: { ...params, targetZ: params.targetZ + this.zMin },
                    target: [start.x, start.y],
                    east: [east.x - start.x, east.y - start.y],
                    north: [north.x - start.x, north.y - start.y],
                    region: region?.entry ?? null,
                },
            });
        });
    }


    /**
     * Fire coverage of a weapon with the layer: the worker samples the landscape and the objects along the rays
     * and classifies them (squadCoverageRays.createRayClassifier with structures)
     * @param {object} params - the coverage parameters (squadCoverageRays.computeCoverageRays) without `heightAt`
     *   and `inside`; `ground` in the page's heights
     * @param {{lat: number, lng: number}} origin - the weapon
     * @param {function(number, number): {lat: number, lng: number}} fromMeters - LatLng at (east, north) meters from `origin`
     * @param {function(): boolean} isCurrent - false once a newer computation replaced this one
     * @returns {Promise<Uint8Array|null>} - the COVERAGE value of every cell of every ray; null when the job was
     *   replaced or the worker failed
     */
    coverage(params, origin, fromMeters, isCurrent) {
        this.coverageJob?.resolve(null);
        const start = this.toWorld(origin);
        const east = this.toWorld(fromMeters(origin, 1, 0));
        const north = this.toWorld(fromMeters(origin, 0, 1));
        const id = ++this.coverageJobs;
        const worker = this.worker;

        return new Promise((resolve) => {
            let nextRay = 0;
            const job = {
                id,
                resolve: (values) => {
                    if (this.coverageJob === job) this.coverageJob = null;
                    resolve(values);
                },
                next: () => {
                    if (!isCurrent()) {
                        job.resolve(null);
                        return;
                    }
                    if (nextRay >= params.rays) {
                        worker.postMessage({ coverageFinish: id });
                        return;
                    }
                    const size = Math.min(RAYS_PER_BATCH, params.rays - nextRay);
                    worker.postMessage({ coverageRays: { job: id, first: nextRay, size } });
                    nextRay += size;
                },
            };
            this.coverageJob = job;
            worker.postMessage({
                coverageInit: {
                    job: id,
                    params: { ...params, ground: params.ground + this.zMin, heightAt: undefined, inside: undefined },
                    origin: [start.x, start.y],
                    east: [east.x - start.x, east.y - start.y],
                    north: [north.x - start.x, north.y - start.y],
                },
            });
            job.next();
        });
    }
}
