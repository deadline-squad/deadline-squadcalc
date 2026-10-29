import { ImageOverlay, LatLngBounds } from "leaflet";
import { App } from "../app.js";
import { isParabola, peakAngle, solveElevation, trajectory } from "./squadBallistics.js";

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

// Cells per range radius, and limits of the cell size in meters
const CELLS_PER_RANGE = 320;
const MIN_CELL = 5;

// Coverage is drawn up to this distance at most (beyond the largest map side)
const MAX_COVERAGE_RANGE = 4000;

// Rays computed per tick: the page stays responsive during the computation
const RAYS_PER_TICK = 24;

// Stacking of the image in the overlay pane: above the map image (an image overlay of z-index 1 that a
// layer change adds after this one), below the damage zones of the targets and the markers' SVG
const COVERAGE_Z_INDEX = 2;


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
 * @param {Uint8Array} [params.out] - results, rays × (targets + 1), filled in place
 * @returns {{values: Uint8Array, targets: number}} - values[ray * (targets + 1) + j] for the target at j·cell
 */
export function computeCoverageRays(params) {
    const {
        heightAt, ground, shot, range, cell, rays,
        elevationLimits, holdElevation, angleOffset, lifespan, lowOnly = false, inside = () => true,
    } = params;
    const gravity = shot.gravity;
    const firstRay = params.firstRay ?? 0;
    const lastRay = params.lastRay ?? rays;
    const targets = Math.floor(range / cell);
    const stride = targets + 1;
    const values = params.out ?? new Uint8Array(rays * stride);

    // Terrain profile along the ray, sampled finer than the targets: thin buildings are not skipped
    const step = Math.max(1, Math.min(3, cell / 4));
    const samples = Math.ceil(range / step) + 1;
    const profile = new Float64Array(samples);
    const targetHeights = new Float64Array(stride);

    const toRad = Math.PI / 180;
    const [minElevation, maxElevation] = elevationLimits;

    // The highest trajectory at a distance does not depend on the target's height: one search per
    // distance for all the rays (squadBallistics.solveElevation)
    const peaks = new Float64Array(stride);
    if (gravity > 0 && !isParabola(shot)) {
        for (let j = 1; j < stride; j++) peaks[j] = peakAngle(shot, j * cell);
    }

    /**
     * Whether the trajectory at `angle` (radians) stays above the profile up to `distance`.
     * The last cell before the target is not checked: the target point is on the terrain itself.
     */
    const clears = (angle, distance) => {
        const end = Math.floor((distance - Math.max(cell, TARGET_CLEARANCE)) / step);
        const path = trajectory(shot, angle);
        const first = Math.ceil(MUZZLE_CLEARANCE / step);
        if (path.parabola) {
            // Inlined: this loop runs for every cell of the coverage
            const { x0, y0, tan, drop } = path.parabola;
            for (let i = first; i <= end; i++) {
                const ahead = i * step - x0;
                if (ground + y0 + ahead * (tan - drop * ahead) < profile[i]) return false;
            }
            return true;
        }
        for (let i = first; i <= end; i++) {
            if (ground + path.height(i * step) < profile[i]) return false;
        }
        return true;
    };

    /**
     * Whether a trajectory at `angle` can be fired: elevation limits, hold range for the high one,
     * and the projectile must not expire before it lands.
     */
    const fireable = (angle, distance, high) => {
        if (!Number.isFinite(angle) || (high && lowOnly)) return false;
        const degrees = angle / toRad - angleOffset;
        if (degrees < minElevation || degrees > maxElevation) return false;
        if (high && holdElevation && (degrees < holdElevation[0] || degrees > holdElevation[1])) return false;
        return trajectory(shot, angle).time(distance) <= lifespan;
    };

    for (let ray = firstRay; ray < lastRay; ray++) {
        const heading = (2 * Math.PI * ray) / rays;
        const east = Math.cos(heading);
        const north = Math.sin(heading);

        for (let i = 0; i < samples; i++) profile[i] = heightAt(east * i * step, north * i * step);
        for (let j = 1; j < stride; j++) targetHeights[j] = heightAt(east * j * cell, north * j * cell);

        const base = ray * stride;

        for (let j = 1; j < stride; j++) {
            const distance = j * cell;
            if (!inside(east * distance, north * distance)) {
                values[base + j] = COVERAGE.OUT;
                continue;
            }
            const height = targetHeights[j] - ground;
            let low;
            let high;

            if (gravity === 0) {
                low = Math.atan2(height - shot.pivotHeight, distance);
                high = NaN;
            } else {
                ({ low, high } = solveElevation(shot, distance, height, peaks[j] || undefined));
                if (isNaN(low)) {
                    values[base + j] = COVERAGE.OUT;
                    continue;
                }
            }

            const lowFireable = fireable(low, distance, false);
            const highFireable = fireable(high, distance, true);

            if (lowFireable && clears(low, distance)) values[base + j] = COVERAGE.LOW;
            else if (highFireable && clears(high, distance)) values[base + j] = COVERAGE.HIGH;
            else if (lowFireable || highFireable) values[base + j] = COVERAGE.BLOCKED;
            else values[base + j] = COVERAGE.OUT;
        }
    }

    return { values, targets };
}


/**
 * Turn the ray results into a square RGBA image centered on the weapon, one pixel per cell.
 * Row 0 is the north edge, column 0 the west edge.
 * @param {Uint8Array} values - from computeCoverageRays
 * @param {number} rays - number of rays
 * @param {number} targets - targets per ray
 * @param {number} cell - cell size in meters
 * @param {number} range - drawn radius in meters
 * @returns {{pixels: Uint8ClampedArray, size: number}}
 */
export function rasterizeCoverage(values, rays, targets, cell, range) {
    const radius = Math.ceil(range / cell);
    const size = 2 * radius + 1;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const stride = targets + 1;

    for (let row = 0; row < size; row++) {
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

    return { pixels, size };
}


/**
 * Coverage layer of a squadMinimap: computes in the background and draws an image over the map.
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
        this.signature = null;
        if (this.overlay) this.overlay.remove();
        this.overlay = null;
        $("#coverageLegend").hide();
    }

    /**
     * Compute the coverage of `weapon` from `weaponMarker` in ticks of RAYS_PER_TICK rays, then draw it
     * @param {squadWeaponMarker} weaponMarker
     * @param {Weapon} weapon
     */
    compute(weaponMarker, weapon) {
        const generation = ++this.generation;
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
        const targets = Math.floor(range / cell);
        const values = new Uint8Array(rays * (targets + 1));
        const gravity = App.gravity * weapon.gravityScale;

        const params = {
            heightAt,
            ground: heightAt(0, 0) + Number(weaponMarker.heightPadding || 0),
            shot: weapon.heightOffset > 0 ? weapon.getShot(gravity) : weapon.getShot(gravity, SHOULDER_HEIGHT),
            range,
            cell,
            rays,
            elevationLimits: weapon.minElevation,
            holdElevation: weapon.holdElevation,
            angleOffset: weapon.angleOffset || 0,
            lifespan: weapon.projectileLifespan,
            lowOnly: weapon.type === "directFire",
            inside,
            out: values,
        };

        const tick = (firstRay) => {
            if (generation !== this.generation) return;
            const lastRay = Math.min(rays, firstRay + RAYS_PER_TICK);
            computeCoverageRays({ ...params, firstRay, lastRay });
            if (lastRay < rays) {
                setTimeout(() => tick(lastRay), 0);
                return;
            }
            this.draw(origin, values, rays, targets, cell, range);
        };
        setTimeout(() => tick(0), 0);
    }

    /**
     * Put the image of the coverage on the map
     */
    draw(origin, values, rays, targets, cell, range) {
        const { pixels, size } = rasterizeCoverage(values, rays, targets, cell, range);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").putImageData(new ImageData(pixels, size, size), 0, 0);

        const half = (size * cell) / 2;
        const bounds = new LatLngBounds(this.map.fromMeters(origin, -half, -half), this.map.fromMeters(origin, half, half));

        if (this.overlay) this.overlay.remove();
        this.overlay = new ImageOverlay(canvas.toDataURL(), bounds, { className: "coverageOverlay", interactive: false, zIndex: COVERAGE_Z_INDEX }).addTo(this.map);
        $("#coverageLegend").show();
    }
}
