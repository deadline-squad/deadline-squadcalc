import { ImageOverlay, LatLngBounds } from "leaflet";
import { App } from "../app.js";
import { createRaySampler, computeCoveragePeaks, computeCoverageRays, rasterizeCoverage, SHOULDER_HEIGHT } from "./squadCoverageRays.js";

// The pure computation lives in squadCoverageRays.js (also run by coverageWorker.js); re-exported here
export { COVERAGE, SHOULDER_HEIGHT, MUZZLE_CLEARANCE, TARGET_CLEARANCE, computeCoveragePeaks, computeCoverageRays, createRaySampler, createRayClassifier, rasterizeCoverage } from "./squadCoverageRays.js";

// Cells per range radius, and limits of the cell size in meters
const CELLS_PER_RANGE = 320;
const MIN_CELL = 5;

// Coverage is drawn up to this distance at most (beyond the largest map side)
const MAX_COVERAGE_RANGE = 4000;

// Milliseconds of main-thread work per chunk of the computation: the page stays responsive during it
// (a frame is 16.7 ms at 60 Hz, input is handled between chunks)
const TIME_BUDGET_MS = 8;

// Workers that classify the rays: two leave cores to the page, the game and the rest of the machine
const MAX_WORKERS = 2;

// Rays the page sends to a worker in one message
const RAYS_PER_BATCH = 16;

// Stacking of the image in the overlay pane: above the map image (an image overlay of z-index 1 that a
// layer change adds after this one), below the damage zones of the targets and the markers' SVG
const COVERAGE_Z_INDEX = 2;


/**
 * Coverage layer of a squadMinimap: computes in the background (in chunks of a few milliseconds) and draws an image over the map.
 * `update()` can be called on every change; it only recomputes when the weapon, its position,
 * height padding or the map changed.
 */
export default class SquadCoverage {

    /**
     * @param {squadMinimap} map
     */
    constructor(map) {
        this.map = map;
        this.enabled = false;
        this.overlay = null;
        this.overlayUrl = null;
        this.workers = [];
        this.signature = null;
        // Incremented to abandon a computation in progress
        this.generation = 0;
        $(document).on("heightmapPNG:loaded", () => this.update(true));
    }

    /**
     * Show or hide the coverage
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        this.update(true);
    }

    /**
     * Recompute the coverage if its inputs changed
     * @param {boolean} [force=false] - recompute even if nothing changed
     */
    update(force = false) {
        const weaponMarker = this.map.activeWeaponsMarkers.getLayers()[0];
        const heightmap = this.map.heightmap;
        const weapon = App.activeWeapon;

        if (!this.enabled || !weaponMarker || !weapon || !heightmap?.jsonPng.length) {
            this.clear();
            return;
        }

        const latlng = weaponMarker.getLatLng();
        const signature = [
            this.map.activeMap.name, weapon.name, weapon.velocity, latlng.lat, latlng.lng, weaponMarker.heightPadding,
        ].join("|");
        if (!force && signature === this.signature) return;
        this.signature = signature;

        this.compute(weaponMarker, weapon);
    }

    /**
     * Remove the drawing and stop a computation in progress
     */
    clear() {
        this.generation++;
        this.stopWorkers();
        this.signature = null;
        this.removeOverlay();
        $("#coverageLegend").hide();
    }

    /**
     * Compute the coverage of `weapon` from `weaponMarker`, then draw it. The page samples the terrain
     * along the rays (it owns the heightmap) in chunks of TIME_BUDGET_MS and sends each ray to a worker,
     * which classifies the cells and draws the image off the main thread; without a worker everything runs
     * on the page in the same chunks. Each chunk is a task of its own that a MessageChannel message
     * starts: input and rendering are handled between them, which a chain of setTimeout(0) would delay by
     * its 4 ms minimum.
     * @param {squadWeaponMarker} weaponMarker
     * @param {Weapon} weapon
     */
    compute(weaponMarker, weapon) {
        const generation = ++this.generation;
        this.stopWorkers();
        const map = this.map;
        const origin = weaponMarker.getLatLng();

        const heightAt = (east, north) => map.heightmap.getHeight(map.fromMeters(origin, east, north));
        // The map spans lat [-pixelSize, 0] and lng [0, pixelSize]
        const inside = (east, north) => {
            const { lat, lng } = map.fromMeters(origin, east, north);
            return lat <= 0 && lat >= -map.pixelSize && lng >= 0 && lng <= map.pixelSize;
        };

        const range = Math.min(weapon.getMaxDistance(), MAX_COVERAGE_RANGE);
        const cell = Math.max(MIN_CELL, range / CELLS_PER_RANGE);
        // Neighbour rays are about two cells apart at the edge of the range
        const rays = Math.max(360, Math.min(1440, Math.ceil((2 * Math.PI * range) / (2 * cell))));
        const gravity = App.gravity * weapon.gravityScale;

        const params = {
            heightAt,
            ground: heightAt(0, 0) + Number(weaponMarker.heightPadding || 0),
            shot: weapon.muzzle || weapon.heightOffset > 0 ? weapon.getShot(gravity) : weapon.getShot(gravity, SHOULDER_HEIGHT),
            range,
            cell,
            rays,
            elevationLimits: weapon.minElevation,
            holdElevation: weapon.holdElevation,
            angleOffset: weapon.angleOffset || 0,
            lifespan: weapon.projectileLifespan,
            lowOnly: weapon.type === "directFire",
            inside,
        };

        const done = (pixels, size) => this.draw(origin, pixels, size, cell, generation);
        if (!this.computeInWorker(params, generation, done)) this.computeInPage(params, generation, done);
    }

    /**
     * Run `step` as tasks of its own until it returns false, stopping when the computation was replaced
     * @param {number} generation - the computation, see `generation`
     * @param {function(number): boolean} step - does work until the deadline (`performance.now()`) it is given;
     *   returns whether there is more
     */
    runInChunks(generation, step) {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            if (generation === this.generation && step(performance.now() + TIME_BUDGET_MS)) {
                channel.port2.postMessage(null);
                return;
            }
            channel.port1.close();
        };
        channel.port2.postMessage(null);
    }

    /**
     * Compute the coverage with workers (coverageWorker.js): the page samples the rays and deals them to
     * the workers in batches, then draws the image from the cells they return
     * @param {object} params - see computeCoverageRays
     * @param {number} generation - the computation, see `generation`
     * @param {function(Uint8ClampedArray, number): void} done - receives the image
     * @returns {boolean} - false when the browser cannot start a worker; a worker that fails later
     *   restarts the computation on the page
     */
    computeInWorker(params, generation, done) {
        const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
        const workers = [];
        try {
            for (let i = 0; i < count; i++) workers.push(new Worker(new URL("./coverageWorker.js", import.meta.url)));
        } catch {
            workers.forEach((worker) => worker.terminate());
            return false;
        }
        this.workers = workers;

        const { rays } = params;
        const sampler = createRaySampler(params);
        const { samples, stride } = sampler;
        const values = new Uint8Array(rays * stride);
        let pending = count;

        // The batches of rays each worker got: [first ray, number of rays]
        const batches = workers.map(() => []);
        // Buffers of a batch, sent to a worker and sent back by it when classified: the page does not allocate
        // (and the garbage collector does not scan) a pair of arrays per ray
        const idle = [];

        workers.forEach((worker, index) => {
            worker.onerror = (event) => {
                console.warn("[COVERAGE] A worker failed, computing on the page:", event.message);
                if (generation !== this.generation || !this.workers.length) return;
                this.stopWorkers();
                this.computeInPage(params, generation, done);
            };
            worker.onmessage = ({ data }) => {
                if (generation !== this.generation) return;
                if (data.recycled) {
                    idle.push(data.recycled);
                    return;
                }
                for (const [first, size] of batches[index]) {
                    values.set(data.values.subarray(first * stride, (first + size) * stride), first * stride);
                }
                if (--pending > 0) return;
                this.stopWorkers();
                this.rasterizeInChunks(values, params, generation, done);
            };
            // The heightmap functions stay on the page
            worker.postMessage({ init: { ...params, heightAt: undefined, inside: undefined } });
        });

        let nextRay = 0;
        let nextBatch = 0;
        this.runInChunks(generation, (deadline) => {
            do {
                const batch = idle.pop() ?? { profiles: new Float64Array(RAYS_PER_BATCH * samples), targetHeights: new Float64Array(RAYS_PER_BATCH * stride) };
                const first = nextRay;
                while (nextRay - first < RAYS_PER_BATCH && nextRay < rays) {
                    const k = nextRay - first;
                    sampler.sample(nextRay, batch.profiles.subarray(k * samples, (k + 1) * samples), batch.targetHeights.subarray(k * stride, (k + 1) * stride));
                    nextRay++;
                }
                const index = nextBatch++ % count;
                batches[index].push([first, nextRay - first]);
                workers[index].postMessage({ first, size: nextRay - first, ...batch }, [batch.profiles.buffer, batch.targetHeights.buffer]);
            } while (nextRay < rays && performance.now() < deadline);
            if (nextRay < rays) return true;
            workers.forEach((worker) => worker.postMessage({ finish: true }));
            return false;
        });
        return true;
    }

    /**
     * Draw the image of the cells in chunks of TIME_BUDGET_MS
     * @param {Uint8Array} values - the COVERAGE value of every cell, see computeCoverageRays
     * @param {object} params - see computeCoverageRays
     * @param {number} generation - the computation, see `generation`
     * @param {function(Uint8ClampedArray, number): void} done - receives the image
     */
    rasterizeInChunks(values, params, generation, done) {
        const { rays, range, cell } = params;
        let image = { nextRow: 0 };
        this.runInChunks(generation, (deadline) => {
            image = rasterizeCoverage(values, rays, Math.floor(range / cell), cell, range, { ...image, firstRow: image.nextRow, deadline });
            if (image.nextRow < image.size) return true;
            done(image.pixels, image.size);
            return false;
        });
    }

    /**
     * Compute the coverage on the page, in chunks of TIME_BUDGET_MS: the highest trajectories, the
     * rays, the image
     * @param {object} params - see computeCoverageRays
     * @param {number} generation - the computation, see `generation`
     * @param {function(Uint8ClampedArray, number): void} done - receives the image
     */
    computeInPage(params, generation, done) {
        const { rays, range, cell } = params;
        const targets = Math.floor(range / cell);
        const values = new Uint8Array(rays * (targets + 1));
        const peaks = new Float64Array(targets + 1);
        const rayParams = { ...params, peaks, out: values };

        let nextPeak = 1;
        let nextRay = 0;
        this.runInChunks(generation, (deadline) => {
            if (nextPeak <= targets) {
                nextPeak = computeCoveragePeaks(params, peaks, nextPeak, deadline).next;
                return true;
            }
            nextRay = computeCoverageRays({ ...rayParams, firstRay: nextRay, deadline }).nextRay;
            if (nextRay < rays) return true;
            this.rasterizeInChunks(values, params, generation, done);
            return false;
        });
    }

    /**
     * Stop the workers of a computation in progress
     */
    stopWorkers() {
        this.workers.forEach((worker) => worker.terminate());
        this.workers = [];
    }

    /**
     * Put the image of the coverage on the map. The PNG is encoded off the main thread (`toBlob`) and
     * shown from an object URL; an image that a newer computation replaced meanwhile is dropped.
     * @param {LatLng} origin - the weapon
     * @param {Uint8ClampedArray} pixels - RGBA, from rasterizeCoverage
     * @param {number} size - side of the image in pixels
     * @param {number} cell - meters per pixel
     * @param {number} generation - the computation that made the image
     */
    draw(origin, pixels, size, cell, generation) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").putImageData(new ImageData(pixels, size, size), 0, 0);

        const half = (size * cell) / 2;
        const bounds = new LatLngBounds(this.map.fromMeters(origin, -half, -half), this.map.fromMeters(origin, half, half));

        canvas.toBlob((blob) => {
            if (generation !== this.generation) return;
            this.removeOverlay();
            this.overlayUrl = blob ? URL.createObjectURL(blob) : canvas.toDataURL();
            this.overlay = new ImageOverlay(this.overlayUrl, bounds, { className: "coverageOverlay", interactive: false, zIndex: COVERAGE_Z_INDEX }).addTo(this.map);
            $("#coverageLegend").show();
        });
    }

    /**
     * Take the image off the map and release its object URL
     */
    removeOverlay() {
        if (this.overlay) this.overlay.remove();
        if (this.overlayUrl?.startsWith("blob:")) URL.revokeObjectURL(this.overlayUrl);
        this.overlay = null;
        this.overlayUrl = null;
    }
}
