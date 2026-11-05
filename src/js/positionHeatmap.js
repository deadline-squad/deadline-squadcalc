import { solveElevation, trajectory } from "./squadBallistics.js";
import { computeCoveragePeaks, isNumeric, MUZZLE_CLEARANCE, TARGET_CLEARANCE } from "./squadCoverageRays.js";

/**
 * Reverse-position heatmap (deadline-squad/deadline-squadcalc#22 C5): for a chosen target (at the height chosen for
 * it) which ground positions around it, up to the weapon's range, have a clear line of fire to it, and how good a
 * position each is. The fire coverage asks the opposite question (what a weapon at one place can hit).
 *
 * Direct-fire weapons only (those with a sight and a MOA): the shot is the low trajectory from the muzzle of a
 * shooter standing at the position to the target, the same exact one as SquadFiringSolution (squadBallistics.js:
 * gravity scale, rocket boost, elevation limits, projectile lifespan). The landscape is tested along it like the
 * fire coverage does; the objects (buildings, walls, trees; volume layer, volumeWorker.js) by `pathBlocked`, an
 * exact voxel-column walk of the engine and, where a precision region of the target exists, the exact triangles
 * around it. An open window or doorway is a hole and passes, a closed one is solid, no penetration is computed
 * (owner decisions of 2026-11-04).
 *
 * The positions lie on rays from the target, every `cell` meters, like the fire coverage's cells, so the landscape
 * profile of a ray is sampled once for all its positions. Pure functions (no map, no DOM, no engine): the landscape
 * and the objects come in as `heightAt` and `pathBlocked`.
 *
 * Score of a clear position, 0 to 1 (`positionScore`):
 *  - distance: 1 at the target down to DISTANCE_FLOOR at the farthest position; linear, so a closer position is
 *    better and a long shot stays visible and viable;
 *  - obstacle clearance: the line of fire is also traced displaced up, down and to either side by the margin (the
 *    weapon's spread radius at the target, at least MIN_MARGIN and at most MAX_MARGIN metres, growing linearly from
 *    the muzzle), the rounds that scatter that far; each displaced line that is clear raises the weight from
 *    CLEARANCE_FLOOR towards 1. A line that grazes a doorframe or a roof edge scores lower than one in the open.
 */
export const HEAT = {
    OUT: 0,       // no landscape, no shot (range, elevation limits, lifespan) or the shooter's body would be inside an object
    BLOCKED: 1,   // an object or the landscape is on the line of fire
    CLEAR_MIN: 2, // the lowest value of a clear position; the highest is 255
};

/** The farthest position is worth this much of a position at the target, as far as distance goes */
export const DISTANCE_FLOOR = 0.4;

/** Weight of a clear position none of whose displaced lines is clear */
export const CLEARANCE_FLOOR = 0.5;

/** Displacement of the traced lines at the target, metres: the spread radius, between these */
export const MIN_MARGIN = 0.5;
export const MAX_MARGIN = 2;

/** Positions are drawn at most this far from the target, metres (the weapons' ballistic ranges reach tens of km) */
export const MAX_RANGE = 2000;

/** Positions per range radius, and the finest cell, metres */
export const CELLS_PER_RANGE = 160;
export const MIN_CELL = 2;

/** A precision region is used for a target at least this far inside its square, metres: the exact triangles then cover that far around the target */
export const MIN_REGION_MARGIN = 50;

/** Longest straight piece of the traced polyline, metres: the sagitta of the slowest direct-fire shell stays under 7 cm */
const LONGEST_PIECE = 25;

/** The line of fire of a target in free space (a floor, a window) is traced up to this far from it, metres */
const ELEVATED_TARGET_END = 0.5;

/** The shooter's body is probed this far below his muzzle, metres */
const BODY_PROBE = 0.3;

/** Highest point count of a polyline: range / LONGEST_PIECE pieces plus the ends */
const pointsFor = (range) => Math.ceil(range / LONGEST_PIECE) + 3;


/**
 * Everything the heatmap of a target depends on, as one string: the heatmap is computed again when it changes
 * @param {string} mapName
 * @param {{name: string, velocity: number, moa: number, gravityScale: number, minElevation: number[], getMaxDistance: function(): number}} weapon
 *   the active weapon with its selected shell
 * @param {number} gravity - the world's gravity, m/s^2
 * @param {{lat: number, lng: number}} latlng - the target
 * @param {number|null} targetHeight - the height chosen for the target (squadTargetMarker.getTargetHeight)
 * @returns {string}
 */
export function heatmapSignature(mapName, weapon, gravity, latlng, targetHeight) {
    return [
        mapName, weapon.name, weapon.velocity, weapon.moa, weapon.gravityScale, gravity, weapon.getMaxDistance(),
        weapon.minElevation.join(","), latlng.lat, latlng.lng, targetHeight,
    ].join("|");
}


/**
 * The precision region to trace a target's lines of fire with: of the regions of the map's `volume.regions`
 * (engine/README.md, "Precision pass") the one whose square holds the target farthest from its edge
 * @param {Array<{centre: number[], radius: number}>} regions - meta.json entries: the centre (x, y, the frame of the
 *   volume file) and the half side of the square, metres
 * @param {number} x - the target, in the frame of the volume file
 * @param {number} y
 * @returns {{entry: object, margin: number}|null} - `margin`: metres from the target to the nearest side of the
 *   square, at least MIN_REGION_MARGIN; null when no region holds the target that well
 */
export function pickRegion(regions, x, y) {
    let best = null;
    for (const entry of regions) {
        const margin = entry.radius - Math.max(Math.abs(x - entry.centre[0]), Math.abs(y - entry.centre[1]));
        if (margin >= MIN_REGION_MARGIN && (!best || margin > best.margin)) best = { entry, margin };
    }
    return best;
}


/**
 * Cell size and number of rays for a range
 * @param {number} range - metres
 * @returns {{cell: number, rays: number}} - neighbouring rays are about two cells apart at the edge of the range
 */
export function heatmapGrid(range) {
    const cell = Math.max(MIN_CELL, range / CELLS_PER_RANGE);
    return { cell, rays: Math.max(360, Math.min(1440, Math.ceil((2 * Math.PI * range) / (2 * cell)))) };
}


/**
 * The weight of a clear position
 * @param {number} distance - from the target, metres
 * @param {number} range - the farthest position, metres
 * @param {number} clearLines - how many of the four displaced lines of fire are clear, 0 to 4
 * @returns {number} - 0 to 1; DISTANCE_FLOOR * CLEARANCE_FLOOR at the least
 */
export function positionScore(distance, range, clearLines) {
    const proximity = 1 - (1 - DISTANCE_FLOOR) * Math.min(1, distance / range);
    return proximity * (CLEARANCE_FLOOR + (1 - CLEARANCE_FLOOR) * (clearLines / 4));
}


/**
 * Value of a clear position in the byte of a ray's cell
 * @param {number} score - from positionScore
 * @returns {number} - HEAT.CLEAR_MIN to 255
 */
export function scoreToValue(score) {
    return HEAT.CLEAR_MIN + Math.round(score * (255 - HEAT.CLEAR_MIN));
}


/**
 * Classifier of the rays of a heatmap
 * @param {object} params
 * @param {function(number, number): number} params.heightAt - landscape height at (east, north) metres from the
 *   target; NaN where there is none (outside the map, a landscape hole)
 * @param {number} params.targetZ - height of the aimed point, same reference as `heightAt`
 * @param {boolean} params.elevated - the target has a height of its own (a floor, a window, a roof): its line of
 *   fire is traced up to it instead of stopping TARGET_CLEARANCE short
 * @param {function(Float64Array, number): boolean} params.pathBlocked - whether a polyline meets an object:
 *   `(points, count)` with x (east), y (north), z per point in metres from the target, shooter first
 * @param {import("./squadBallistics.js").Shot} params.shot - how the weapon fires, from the muzzle of the shooter
 * @param {number} params.range - farthest position, metres
 * @param {number} params.cell - metres between two positions along a ray
 * @param {number} params.rays - number of rays, counter-clockwise from east
 * @param {number[]} params.elevationLimits - [min, max] barrel elevation in degrees
 * @param {number} params.angleOffset - degrees subtracted from the physical angle (weapon scale)
 * @param {number} params.lifespan - projectile lifespan, seconds
 * @param {number} params.moa - the weapon's spread, minutes of angle
 * @returns {{stride: number, classifyRay: function(number, Uint8Array): void}} - `classifyRay(ray, values)`
 *   writes the HEAT value of every position of the ray to values[ray * stride + j], j = 1 .. stride - 1 at
 *   j * cell metres from the target
 */
export function createPositionClassifier(params) {
    const {
        heightAt, targetZ, elevated, pathBlocked, shot, range, cell, rays,
        elevationLimits, angleOffset, lifespan, moa,
    } = params;
    const stride = Math.floor(range / cell) + 1;
    const step = Math.max(1, Math.min(3, cell / 4));
    const samples = Math.ceil(range / step) + 1;
    const toRad = Math.PI / 180;
    const [minElevation, maxElevation] = elevationLimits;
    const numeric = isNumeric(shot);
    const peaks = computeCoveragePeaks({ shot, cell, range }).peaks;
    const profile = new Float64Array(samples);
    const points = new Float64Array(3 * pointsFor(range));
    const halfSpread = Math.tan((moa / 120) * toRad);
    const eye = shot.pivotHeight > 0 ? shot.pivotHeight : 1.5;
    const terrainStart = elevated ? 1 : Math.ceil(TARGET_CLEARANCE / step);
    const pathEnd = elevated ? ELEVATED_TARGET_END : TARGET_CLEARANCE;

    // A shooter inside an object cannot stand there: his body, from just under the muzzle to the muzzle
    const bodyBlocked = (east, north, ground) => {
        points.set([east, north, ground + eye - BODY_PROBE, east, north, ground + eye]);
        return pathBlocked(points, 2);
    };

    /**
     * Whether the line of fire from the muzzle (distance `d` from the target at the heading (cos, sin)) to the
     * target, displaced by `up` metres and `side` metres to the left of the shooter at the target (growing linearly
     * from the muzzle), meets the landscape or an object
     */
    const blockedWith = (path, ground, d, cos, sin, up, side) => {
        const lift = up / d;
        for (let i = terrainStart; ; i++) {
            const s = i * step;
            const x = d - s;
            if (x < MUZZLE_CLEARANCE) break;
            if (ground + path.height(x) + lift * x < profile[i]) return true;
        }

        const first = Math.min(MUZZLE_CLEARANCE, d);
        const last = Math.max(first, d - pathEnd);
        const pieces = Math.max(1, Math.ceil((last - first) / LONGEST_PIECE));
        let count = 0;
        const add = (x) => {
            const s = d - x;
            const shift = (side * x) / d;
            points[3 * count] = s * cos - shift * sin;
            points[3 * count + 1] = s * sin + shift * cos;
            points[3 * count + 2] = ground + path.height(x) + lift * x;
            count++;
        };
        for (let k = 0; k <= pieces; k++) add(first + ((last - first) * k) / pieces);
        if (elevated) {
            points[3 * count] = side * -sin;
            points[3 * count + 1] = side * cos;
            points[3 * count + 2] = targetZ + up;
            count++;
        }
        return pathBlocked(points, count);
    };

    return {
        stride,
        classifyRay(ray, values) {
            const heading = (2 * Math.PI * ray) / rays;
            const cos = Math.cos(heading);
            const sin = Math.sin(heading);
            for (let i = 0; i < samples; i++) {
                const ground = heightAt(cos * i * step, sin * i * step);
                profile[i] = Number.isNaN(ground) ? -Infinity : ground;
            }

            const base = ray * stride;
            let roots = {};
            for (let j = 1; j < stride; j++) {
                const d = j * cell;
                const east = cos * d;
                const north = sin * d;
                const ground = heightAt(east, north);
                values[base + j] = HEAT.OUT;
                if (Number.isNaN(ground)) {
                    roots = {};
                    continue;
                }

                let low;
                if (shot.gravity === 0) {
                    low = Math.atan2(targetZ - ground - shot.pivotHeight, d);
                } else {
                    roots = solveElevation(shot, d, targetZ - ground, numeric ? peaks[j] : undefined, numeric ? { low: true, high: false } : undefined, roots);
                    low = roots.low;
                }
                if (!Number.isFinite(low)) continue;
                const degrees = low / toRad - angleOffset;
                if (degrees < minElevation || degrees > maxElevation) continue;
                const path = trajectory(shot, low);
                if (path.time(d) > lifespan) continue;
                if (bodyBlocked(east, north, ground)) continue;

                if (blockedWith(path, ground, d, cos, sin, 0, 0)) {
                    values[base + j] = HEAT.BLOCKED;
                    continue;
                }
                const margin = Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, d * halfSpread));
                let clearLines = 0;
                for (const [up, side] of [[margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
                    if (!blockedWith(path, ground, d, cos, sin, up, side)) clearLines++;
                }
                values[base + j] = scoreToValue(positionScore(d, range, clearLines));
            }
        },
    };
}


// RGBA of the drawn positions: a blocked one is faint red, a clear one runs from amber (a far, tight position) to green
// (a close, open one), the colours of the fire coverage
const BLOCKED_COLOR = [231, 76, 60, 45];
const POOR_COLOR = [241, 196, 15];
const GOOD_COLOR = [46, 204, 113];
const CLEAR_ALPHA = 140;

/**
 * Colour of a value of the heatmap
 * @param {number} value - HEAT value
 * @returns {number[]|null} - RGBA, null where nothing is drawn
 */
export function heatColor(value) {
    if (value === HEAT.BLOCKED) return BLOCKED_COLOR;
    if (value < HEAT.CLEAR_MIN) return null;
    // The lowest clear score is DISTANCE_FLOOR * CLEARANCE_FLOOR
    const low = DISTANCE_FLOOR * CLEARANCE_FLOOR;
    const score = (value - HEAT.CLEAR_MIN) / (255 - HEAT.CLEAR_MIN);
    const t = Math.min(1, Math.max(0, (score - low) / (1 - low)));
    return [...POOR_COLOR.map((from, k) => Math.round(from + (GOOD_COLOR[k] - from) * t)), CLEAR_ALPHA];
}


/**
 * Turn the ray values into a square RGBA image centred on the target, one pixel per cell. Row 0 is the north edge,
 * column 0 the west edge.
 * @param {Uint8Array} values - the HEAT value of every position of every ray (createPositionClassifier)
 * @param {number} rays - number of rays
 * @param {number} cell - metres per pixel
 * @param {number} range - drawn radius, metres
 * @returns {{pixels: Uint8ClampedArray, size: number}}
 */
export function rasterizeHeatmap(values, rays, cell, range) {
    const radius = Math.ceil(range / cell);
    const size = 2 * radius + 1;
    const stride = Math.floor(range / cell) + 1;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let row = 0; row < size; row++) {
        const north = (radius - row) * cell;
        for (let col = 0; col < size; col++) {
            const east = (col - radius) * cell;
            const distance = Math.hypot(east, north);
            const j = Math.round(distance / cell);
            if (j < 1 || j >= stride || distance > range) continue;

            let heading = Math.atan2(north, east);
            if (heading < 0) heading += 2 * Math.PI;
            const color = heatColor(values[(Math.round((heading / (2 * Math.PI)) * rays) % rays) * stride + j]);
            if (color) pixels.set(color, (row * size + col) * 4);
        }
    }
    return { pixels, size };
}
