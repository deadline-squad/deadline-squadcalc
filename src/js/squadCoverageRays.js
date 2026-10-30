import { heightAt as projectileHeight, isParabola, peakAngle, RangeMax, solveElevation, trajectory } from "./squadBallistics.js";

/**
 * Fire coverage: where the active weapon can hit from the first weapon marker.
 *
 * The heightmap includes the buildings (about 1 m per pixel), so a cell behind a building or a ridge
 * is only reachable by a trajectory that clears them. Each cell gets one of the COVERAGE values.
 * The trajectory is the same exact one as SquadFiringSolution (squadBallistics.js: rocket boost, gravity
 * scale, elevation limits, AGS-17 hold range, projectile lifespan), launched from the weapon's ground
 * (marker height padding included) at the muzzle height.
 */
export const COVERAGE = {
    OUT: 0,       // out of range or outside the elevation limits
    LOW: 1,       // the low trajectory (direct fire) clears the terrain
    HIGH: 2,      // only the high trajectory (lob) clears it
    BLOCKED: 3,   // in range, but every trajectory hits the terrain or a building first
};

// RGBA of each value on the map
const COLORS = {
    [COVERAGE.LOW]: [46, 204, 113, 105],
    [COVERAGE.HIGH]: [241, 196, 15, 105],
    [COVERAGE.BLOCKED]: [231, 76, 60, 85],
};

// Muzzle height of handheld weapons (shoulder), for weapons without heightOffset
export const SHOULDER_HEIGHT = 1.5;

// The terrain this close to the muzzle is the weapon's own spot (heightmap noise, the wall it leans on)
export const MUZZLE_CLEARANCE = 3;

// The terrain this close to the target is the target's own spot: the target point is on it
export const TARGET_CLEARANCE = 3;

/**
 * Whether the elevations of a shot are searched numerically (squadBallistics.solveElevation): a parabola
 * whose shell comes down faster than its cap is searched too
 * @param {import("./squadBallistics.js").Shot} shot
 * @returns {boolean}
 */
function isNumeric(shot) {
    return shot.gravity > 0 && (!isParabola(shot) || Boolean(shot.maxSpeed));
}


/**
 * The highest trajectory at each target distance of a ray (squadBallistics.peakAngle). It depends on the
 * distance only, not on the ray or the terrain: one search per distance for all the rays. Zero for the
 * shots without a numeric search (a plain parabola).
 * @param {object} params - those of computeCoverageRays (`shot`, `cell`, `range` are used)
 * @param {Float64Array} [peaks] - results, indexed by target (j · cell); allocated when missing
 * @param {number} [first=1] - first target to compute
 * @param {number} [deadline] - `performance.now()` after which to stop, when the targets are not all done
 * @returns {{peaks: Float64Array, next: number}} - `next` is the first target not computed yet, targets + 1
 *   when all are
 */
export function computeCoveragePeaks(params, peaks = new Float64Array(Math.floor(params.range / params.cell) + 1), first = 1, deadline = Infinity) {
    const { shot, cell } = params;
    if (!isNumeric(shot)) return { peaks, next: peaks.length };

    let j = first;
    for (; j < peaks.length; j++) {
        peaks[j] = peakAngle(shot, j * cell);
        if (performance.now() >= deadline) return { peaks, next: j + 1 };
    }
    return { peaks, next: j };
}


/**
 * Sampler of the terrain along the rays of a coverage, on the thread that has the heightmap.
 * @param {object} params - those of computeCoverageRays (`heightAt`, `inside`, `range`, `cell`, `rays`)
 * @returns {{step: number, samples: number, stride: number, sample: function(number, Float64Array, Float64Array): void}} -
 *   `sample(ray, profile, targetHeights)` fills `profile` (`samples` heights, one every `step` meters, the
 *   terrain profile of the ray: sampled finer than the targets so that thin buildings are not skipped) and
 *   `targetHeights` (`stride` heights, one per target at j·cell; NaN for a target outside the map)
 */
export function createRaySampler(params) {
    const { heightAt, range, cell, rays, inside = () => true } = params;
    const stride = Math.floor(range / cell) + 1;
    const step = Math.max(1, Math.min(3, cell / 4));
    const samples = Math.ceil(range / step) + 1;

    return {
        step,
        samples,
        stride,
        sample(ray, profile, targetHeights) {
            const heading = (2 * Math.PI * ray) / rays;
            const east = Math.cos(heading);
            const north = Math.sin(heading);
            for (let i = 0; i < samples; i++) profile[i] = heightAt(east * i * step, north * i * step);
            for (let j = 1; j < stride; j++) {
                const distance = j * cell;
                targetHeights[j] = inside(east * distance, north * distance) ? heightAt(east * distance, north * distance) : NaN;
            }
        },
    };
}


/**
 * Classifier of the rays of a coverage: needs the sampled terrain only, so it runs in a worker.
 * @param {object} params - those of computeCoverageRays except `heightAt`, `inside` and the ray range
 *   (`peaks` from computeCoveragePeaks is required)
 * @returns {{samples: number, stride: number, classify: function(number, Float64Array, Float64Array, Uint8Array): void}} -
 *   `classify(ray, profile, targetHeights, values)` writes the COVERAGE value of each target of the ray to
 *   values[ray * stride + j]; the arrays are those `createRaySampler().sample` filled
 */
export function createRayClassifier(params) {
    const {
        ground, shot, range, cell, peaks,
        elevationLimits, holdElevation, angleOffset, lifespan, lowOnly = false,
    } = params;
    const gravity = shot.gravity;
    const stride = Math.floor(range / cell) + 1;
    const step = Math.max(1, Math.min(3, cell / 4));
    const samples = Math.ceil(range / step) + 1;

    const toRad = Math.PI / 180;
    const [minElevation, maxElevation] = elevationLimits;
    const numeric = isNumeric(shot);
    const rangeMax = new RangeMax(samples);
    let profile = null;

    /**
     * Whether the arc on the `side` of the peak (-1 low, +1 high) lands at an elevation the weapon can
     * be laid at, `limit` being its lowest (low arc) or highest (high arc) elevation in degrees
     */
    const reachesFrom = (limit, distance, height, peak, side) => {
        const angle = (limit + angleOffset) * toRad;
        if (side * (peak - angle) > 0) return false;
        return projectileHeight(shot, angle, distance) <= height;
    };

    /**
     * Whether the trajectory stays above the profile (of the current ray) up to `distance`.
     * The last cell before the target is not checked: the target point is on the terrain itself.
     */
    const clears = (path, distance) => {
        const end = Math.floor((distance - Math.max(cell, TARGET_CLEARANCE)) / step);
        const first = Math.ceil(MUZZLE_CLEARANCE / step);
        return path.above(profile, first, end, step, ground, rangeMax);
    };

    /**
     * The trajectory at `angle` (radians) if it can be fired, else null: elevation limits, hold range
     * for the high one, and the projectile must not expire before it lands.
     */
    const firedPath = (angle, distance, high) => {
        if (!Number.isFinite(angle) || (high && lowOnly)) return null;
        const degrees = angle / toRad - angleOffset;
        if (degrees < minElevation || degrees > maxElevation) return null;
        if (high && holdElevation && (degrees < holdElevation[0] || degrees > holdElevation[1])) return null;
        const path = trajectory(shot, angle);
        return path.time(distance) <= lifespan ? path : null;
    };

    return {
        samples,
        stride,
        classify(ray, rayProfile, targetHeights, values) {
            profile = rayProfile;
            rangeMax.build(profile);

            const base = ray * stride;
            // The elevations of the previous cell of this ray start the search of the next one
            let roots = {};

            for (let j = 1; j < stride; j++) {
                if (Number.isNaN(targetHeights[j])) {
                    values[base + j] = COVERAGE.OUT;
                    roots = {};
                    continue;
                }
                const distance = j * cell;
                const height = targetHeights[j] - ground;
                let low;
                let high;

                if (gravity === 0) {
                    low = Math.atan2(height - shot.pivotHeight, distance);
                    high = NaN;
                } else {
                    // The height at the target rises with the elevation up to the peak, then falls: the low
                    // arc is past the lowest elevation the weapon has only if the height there is under the
                    // target, the high one before the highest only if the height there is too. Skips the
                    // search of an arc the weapon cannot be laid at (the mortar's low arc, a lob in direct fire)
                    const wanted = numeric ? {
                        low: reachesFrom(minElevation, distance, height, peaks[j], -1),
                        high: !lowOnly && reachesFrom(maxElevation, distance, height, peaks[j], 1),
                    } : undefined;
                    roots = solveElevation(shot, distance, height, numeric ? peaks[j] : undefined, wanted, roots);
                    ({ low, high } = roots);
                    if (isNaN(low) && isNaN(high)) {
                        values[base + j] = COVERAGE.OUT;
                        continue;
                    }
                }

                const lowPath = firedPath(low, distance, false);
                if (lowPath && clears(lowPath, distance)) {
                    values[base + j] = COVERAGE.LOW;
                    continue;
                }
                const highPath = firedPath(high, distance, true);
                if (highPath && clears(highPath, distance)) values[base + j] = COVERAGE.HIGH;
                else if (lowPath || highPath) values[base + j] = COVERAGE.BLOCKED;
                else values[base + j] = COVERAGE.OUT;
            }
        },
    };
}


/**
 * Classify the cells around a weapon along rays.
 *
 * Pure function (no map, no DOM): `heightAt(east, north)` gives the terrain height in meters at an
 * offset in meters from the weapon. Rays start east and turn counter-clockwise (towards north).
 * @param {object} params
 * @param {function(number, number): number} params.heightAt - terrain height at (east, north) meters
 * @param {number} params.ground - weapon's ground in meters (height padding included), same reference as heightAt
 * @param {import("./squadBallistics.js").Shot} params.shot - how the weapon fires (gravity 0: straight flight)
 * @param {number} params.range - largest distance to classify in meters
 * @param {number} params.cell - distance between two targets along a ray, in meters
 * @param {number} params.rays - number of rays
 * @param {number[]} params.elevationLimits - [min, max] barrel elevation in degrees
 * @param {number[]|null} params.holdElevation - [min, max] of the high trajectory (AGS-17), or null
 * @param {function(number, number): boolean} [params.inside] - whether (east, north) is on the map;
 *   cells outside are OUT (the heightmap has no data there)
 * @param {boolean} [params.lowOnly=false] - only the low trajectory (direct-fire weapons: their
 *   high one is a near-vertical lob nobody fires)
 * @param {number} params.angleOffset - degrees subtracted from the physical angle (weapon scale)
 * @param {number} params.lifespan - projectile lifespan in seconds
 * @param {number} [params.firstRay=0] - first ray to compute
 * @param {number} [params.lastRay=rays] - ray after the last one to compute
 * @param {Float64Array} [params.peaks] - computeCoveragePeaks, when the caller has them for all the rays
 * @param {number} [params.deadline] - `performance.now()` after which no new ray is started (the ray in
 *   progress ends): the caller continues from `nextRay`
 * @param {Uint8Array} [params.out] - results, rays × (targets + 1), filled in place
 * @returns {{values: Uint8Array, targets: number, nextRay: number}} - values[ray * (targets + 1) + j] for the
 *   target at j·cell; nextRay is the first ray not computed (lastRay, unless the deadline came first)
 */
export function computeCoverageRays(params) {
    const { range, cell, rays } = params;
    const firstRay = params.firstRay ?? 0;
    const lastRay = params.lastRay ?? rays;
    const deadline = params.deadline ?? Infinity;
    const targets = Math.floor(range / cell);
    const values = params.out ?? new Uint8Array(rays * (targets + 1));

    // The highest trajectory at a distance does not depend on the target's height: one search per
    // distance for all the rays (computeCoveragePeaks)
    const peaks = params.peaks ?? computeCoveragePeaks(params).peaks;
    const sampler = createRaySampler(params);
    const classifier = createRayClassifier({ ...params, peaks });
    const profile = new Float64Array(sampler.samples);
    const targetHeights = new Float64Array(sampler.stride);

    let nextRay = firstRay;
    while (nextRay < lastRay && !(performance.now() >= deadline)) {
        const ray = nextRay++;
        sampler.sample(ray, profile, targetHeights);
        classifier.classify(ray, profile, targetHeights, values);
    }

    return { values, targets, nextRay };
}


/**
 * Turn the ray results into a square RGBA image centered on the weapon, one pixel per cell.
 * Row 0 is the north edge, column 0 the west edge.
 * @param {Uint8Array} values - from computeCoverageRays
 * @param {number} rays - number of rays
 * @param {number} targets - targets per ray
 * @param {number} cell - cell size in meters
 * @param {number} range - drawn radius in meters
 * @param {object} [progress] - to draw in several calls
 * @param {Uint8ClampedArray} [progress.pixels] - the image of the previous call; allocated when missing
 * @param {number} [progress.firstRow=0] - first row to draw
 * @param {number} [progress.deadline] - `performance.now()` after which no new row is started
 * @returns {{pixels: Uint8ClampedArray, size: number, nextRow: number}} - nextRow is the first row not
 *   drawn yet, `size` when the image is complete
 */
export function rasterizeCoverage(values, rays, targets, cell, range, progress = {}) {
    const radius = Math.ceil(range / cell);
    const size = 2 * radius + 1;
    const pixels = progress.pixels ?? new Uint8ClampedArray(size * size * 4);
    const deadline = progress.deadline ?? Infinity;
    const stride = targets + 1;

    let row = progress.firstRow ?? 0;
    for (; row < size && !(performance.now() >= deadline); row++) {
        const north = (radius - row) * cell;
        for (let col = 0; col < size; col++) {
            const east = (col - radius) * cell;
            const distance = Math.hypot(east, north);
            const j = Math.round(distance / cell);
            if (j < 1 || j > targets || distance > range) continue;

            let heading = Math.atan2(north, east);
            if (heading < 0) heading += 2 * Math.PI;
            const ray = Math.round((heading / (2 * Math.PI)) * rays) % rays;

            const color = COLORS[values[ray * stride + j]];
            if (!color) continue;
            pixels.set(color, (row * size + col) * 4);
        }
    }

    return { pixels, size, nextRow: row };
}


