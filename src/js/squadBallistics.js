/**
 * Exact flight of a Squad projectile: where it is, and the elevation that lands it on a target.
 * Pure functions without imports, shared by the firing solution, the fire coverage and the range ring,
 * and written to be ported line for line to Squad Ballistics (ballistics.py).
 *
 * Model (Squad build 26005357 game files: WeaponConfig.MuzzleVelocity, the projectile's
 * ProjectileGravityScale and ConstantAcceleration for ConstantAccelerationTimeout, the muzzle socket
 * of the weapon's skeleton; no drag). The barrel pivots at `pivotHeight` h above the weapon's ground;
 * the projectile starts at the muzzle, `muzzleForward` f along the barrel and `muzzleUp` u above its
 * axis, so the launch point moves with the elevation θ (c = cos θ, s = sin θ):
 *     x0 = f·c − u·s                  y0 = h + f·s + u·c
 * It leaves the muzzle at `velocity` v0 along the barrel. For the first `boostTime` T seconds a constant
 * `acceleration` a acts along that launch axis (a < 0: the UB-32's S-5 rockets slow down); gravity g
 * acts for the whole flight. Position t seconds after launch, L(t) = v0·t + a·t²/2 along the axis:
 *     t ≤ T:  x = x0 + c·L(t)                y = y0 + s·L(t) − g·t²/2
 *     t > T:  vT = v0 + a·T, τ = t − T
 *             x = x0 + c·(L(T) + vT·τ)       y = y0 + s·L(T) − g·T²/2 + (s·vT − g·T)·τ − g·τ²/2
 * These are the exact solution of the motion (the acceleration is constant on each phase), so the
 * trajectory needs no integration step. Assumes vT > 0 (the rocket never stops; UB-32: 200 m/s).
 *
 * Elevation for a target D meters away horizontally from the pivot and H meters above the weapon's
 * ground: the roots θ of F(θ) = y(θ, D) − H, y(θ, D) being the height when the projectile is D meters
 * away (heightAt). y(θ, D) rises from −∞ at θ = −90° to a single peak and falls back to −∞ at +90°:
 *   1. θ* = argmax y(θ, D) on [−LIMIT, LIMIT], LIMIT = π/2 − 1e-6 rad: golden-section search, stopped
 *      when the bracket is narrower than ANGLE_TOLERANCE = 1e-10 rad (52 steps), at most MAX_ITERATIONS;
 *   2. y(θ*, D) < H: out of range, both elevations NaN;
 *   3. low = bisection of F on [−LIMIT, θ*], high = bisection on [θ*, LIMIT], each stopped when the
 *      bracket is narrower than ANGLE_TOLERANCE (35 steps), at most MAX_ITERATIONS; the root is the
 *      middle of the last bracket.
 * Without boost and muzzle offset y is the textbook parabola from height h, whose roots have the closed
 * form used instead (same result to 1e-10 rad).
 */

// Elevations are searched in [-ELEVATION_LIMIT, ELEVATION_LIMIT] radians: the barrel is never vertical
export const ELEVATION_LIMIT = Math.PI / 2 - 1e-6;

// Width of the last bracket of the searches, radians (1e-10 rad = 0.2 mm at 2 km)
export const ANGLE_TOLERANCE = 1e-10;

// Iteration cap of each search; the tolerance is reached long before (52 / 35 steps)
export const MAX_ITERATIONS = 200;

const GOLDEN = (Math.sqrt(5) - 1) / 2;


/**
 * @typedef {object} Shot - how a weapon fires, in meters, seconds and radians
 * @property {number} velocity - launch speed v0 along the barrel, m/s
 * @property {number} gravity - g, m/s² (world gravity × the projectile's gravity scale)
 * @property {number} acceleration - a along the launch axis during boostTime, m/s² (negative: slows down)
 * @property {number} boostTime - T, s; 0 without boost
 * @property {number} pivotHeight - h, barrel pivot above the weapon's ground, m
 * @property {number} muzzleForward - f, muzzle along the barrel from the pivot, m
 * @property {number} muzzleUp - u, muzzle above the barrel axis, m
 */


/**
 * Whether the trajectory is the textbook parabola from the pivot (no boost, no muzzle offset)
 * @param {Shot} shot
 * @returns {boolean}
 */
export function isParabola(shot) {
    return !(shot.boostTime > 0 && shot.acceleration !== 0) && !shot.muzzleForward && !shot.muzzleUp;
}


/**
 * Where the projectile starts for an elevation
 * @param {Shot} shot
 * @param {number} angle - barrel elevation θ, radians
 * @returns {{x: number, y: number}} - meters ahead of the pivot and above the weapon's ground
 */
export function launchPoint(shot, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
        x: shot.muzzleForward * cos - shot.muzzleUp * sin,
        y: shot.pivotHeight + shot.muzzleForward * sin + shot.muzzleUp * cos,
    };
}


/**
 * The trajectory at one elevation, with its constants computed once: height and time of the projectile
 * when it is a horizontal distance away from the pivot (closed form above; a distance behind the
 * muzzle extrapolates the same equations backwards)
 * @param {Shot} shot
 * @param {number} angle - barrel elevation θ, radians, in (−π/2, π/2)
 * @returns {{height: function(number): number, time: function(number): number, parabola: ?Object}} -
 *   for a distance in meters: meters above the weapon's ground, seconds since launch; without boost
 *   also `parabola` = {x0, y0, tan, drop}: height = y0 + d·(tan − drop·d), d = distance − x0
 */
export function trajectory(shot, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const start = launchPoint(shot, angle);
    const v0 = shot.velocity;
    const g = shot.gravity;
    const a = shot.boostTime > 0 ? shot.acceleration : 0;
    const boostTime = a !== 0 ? shot.boostTime : 0;
    // Boost phase: axis length L(T), its horizontal reach, height and vertical speed at its end
    const boostLength = v0 * boostTime + 0.5 * a * boostTime * boostTime;
    const boostReach = start.x + cos * boostLength;
    const boostEnd = v0 + a * boostTime;
    const boostHeight = start.y + sin * boostLength - 0.5 * g * boostTime * boostTime;
    const boostClimb = sin * boostEnd - g * boostTime;

    if (boostTime === 0) {
        // No boost: the parabola y = y0 + tan θ·d − g·d² / (2·v0²·c²), d = x − x0, and t = d / (v0·c)
        const tan = sin / cos;
        const drop = g / (2 * v0 * v0 * cos * cos);
        return {
            height: (distance) => {
                const ahead = distance - start.x;
                return start.y + ahead * (tan - drop * ahead);
            },
            time: (distance) => (distance - start.x) / (v0 * cos),
            // The coefficients, for loops that evaluate thousands of points (fire coverage)
            parabola: { x0: start.x, y0: start.y, tan, drop },
        };
    }

    // Seconds since launch at a horizontal distance: L = (x − x0) / c and a·t²/2 + v0·t = L while
    // boosting (t = 2L / (v0 + √(v0² + 2aL)), also right for a = 0), then τ = (x − x_T) / (c·vT)
    const time = (distance) => {
        if (distance <= boostReach) {
            const along = (distance - start.x) / cos;
            return 2 * along / (v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * along)));
        }
        return boostTime + (distance - boostReach) / (cos * boostEnd);
    };

    const height = (distance) => {
        if (distance <= boostReach) {
            const along = (distance - start.x) / cos;
            const t = 2 * along / (v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * along)));
            return start.y + sin * along - 0.5 * g * t * t;
        }
        const after = (distance - boostReach) / (cos * boostEnd);
        return boostHeight + boostClimb * after - 0.5 * g * after * after;
    };

    return { height, time, parabola: null };
}


/**
 * Height and time of the projectile when it is `distance` meters away horizontally from the pivot
 * (one point of `trajectory`)
 * @param {Shot} shot
 * @param {number} angle - barrel elevation θ, radians, in (−π/2, π/2)
 * @param {number} distance - horizontal distance from the pivot, meters
 * @returns {{height: number, time: number}} - meters above the weapon's ground, seconds since launch
 */
export function pathAt(shot, angle, distance) {
    const path = trajectory(shot, angle);
    return { height: path.height(distance), time: path.time(distance) };
}


/**
 * Height of the projectile when it is `distance` meters away horizontally from the pivot: the same
 * closed form as `trajectory`, without building it (the searches below evaluate it thousands of times)
 * @param {Shot} shot
 * @param {number} angle - barrel elevation θ, radians, in (−π/2, π/2)
 * @param {number} distance - horizontal distance from the pivot, meters
 * @returns {number} - meters above the weapon's ground
 */
export function heightAt(shot, angle, distance) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const v0 = shot.velocity;
    const g = shot.gravity;
    const a = shot.boostTime > 0 ? shot.acceleration : 0;
    const boostTime = a !== 0 ? shot.boostTime : 0;
    const startX = shot.muzzleForward * cos - shot.muzzleUp * sin;
    const startY = shot.pivotHeight + shot.muzzleForward * sin + shot.muzzleUp * cos;
    const boostLength = v0 * boostTime + 0.5 * a * boostTime * boostTime;
    const ahead = distance - startX;

    if (ahead <= cos * boostLength || boostTime === 0) {
        const along = ahead / cos;
        const t = 2 * along / (v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * along)));
        return startY + sin * along - 0.5 * g * t * t;
    }

    const boostEnd = v0 + a * boostTime;
    const after = (ahead - cos * boostLength) / (cos * boostEnd);
    return startY + sin * boostLength - 0.5 * g * boostTime * boostTime
        + (sin * boostEnd - g * boostTime) * after - 0.5 * g * after * after;
}


/**
 * Elevation that sends the projectile highest at a distance (golden-section search, see the top)
 * @param {Shot} shot
 * @param {number} distance - horizontal distance from the pivot, meters
 * @returns {number} - θ*, radians
 */
export function peakAngle(shot, distance) {
    let low = -ELEVATION_LIMIT;
    let high = ELEVATION_LIMIT;
    let left = high - GOLDEN * (high - low);
    let right = low + GOLDEN * (high - low);
    let leftHeight = heightAt(shot, left, distance);
    let rightHeight = heightAt(shot, right, distance);

    for (let i = 0; i < MAX_ITERATIONS && high - low > ANGLE_TOLERANCE; i++) {
        if (leftHeight < rightHeight) {
            low = left;
            left = right;
            leftHeight = rightHeight;
            right = low + GOLDEN * (high - low);
            rightHeight = heightAt(shot, right, distance);
        } else {
            high = right;
            right = left;
            rightHeight = leftHeight;
            left = high - GOLDEN * (high - low);
            leftHeight = heightAt(shot, left, distance);
        }
    }
    return (low + high) / 2;
}


/**
 * Root of `error` between two elevations where it has opposite signs (bisection, see the top)
 * @param {function(number): number} error
 * @param {number} from - radians
 * @param {number} to - radians
 * @returns {number} - radians
 */
function bisect(error, from, to) {
    let low = from;
    let high = to;
    const lowSign = Math.sign(error(low));
    for (let i = 0; i < MAX_ITERATIONS && high - low > ANGLE_TOLERANCE; i++) {
        const middle = (low + high) / 2;
        if (Math.sign(error(middle)) === lowSign) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}


/**
 * Barrel elevations that land the projectile on a target
 * @param {Shot} shot
 * @param {number} distance - horizontal distance from the pivot to the target, meters, > 0
 * @param {number} height - target height above the weapon's ground, meters
 * @param {number} [peak] - peakAngle(shot, distance) when the caller already has it (coverage)
 * @returns {{low: number, high: number}} - radians, physical barrel angles; NaN out of range
 */
export function solveElevation(shot, distance, height, peak) {
    const g = shot.gravity;
    const v = shot.velocity;

    if (isParabola(shot) && g > 0) {
        const rise = height - shot.pivotHeight;
        const discriminant = v ** 4 - g * (g * distance ** 2 + 2 * rise * v ** 2);
        if (discriminant < 0) return { low: NaN, high: NaN };
        const root = Math.sqrt(discriminant);
        return {
            low: Math.atan((v ** 2 - root) / (g * distance)),
            high: Math.atan((v ** 2 + root) / (g * distance)),
        };
    }

    const top = peak ?? peakAngle(shot, distance);
    if (heightAt(shot, top, distance) < height) return { low: NaN, high: NaN };

    const error = (angle) => heightAt(shot, angle, distance) - height;
    return {
        low: bisect(error, -ELEVATION_LIMIT, top),
        high: bisect(error, top, ELEVATION_LIMIT),
    };
}


/**
 * Farthest target on flat ground (at the height of the weapon's ground): the largest distance whose
 * peak height reaches 0 (doubling, then bisection on the distance to 1 mm)
 * @param {Shot} shot - with gravity > 0
 * @returns {number} - meters
 */
export function maxRange(shot) {
    const reachable = (distance) => heightAt(shot, peakAngle(shot, distance), distance) >= 0;
    let low = 0;
    let high = Math.max(shot.velocity, shot.velocity + shot.acceleration * shot.boostTime) ** 2 / shot.gravity;
    while (reachable(high)) {
        low = high;
        high *= 2;
    }
    for (let i = 0; i < MAX_ITERATIONS && high - low > 1e-3; i++) {
        const middle = (low + high) / 2;
        if (reachable(middle)) low = middle;
        else high = middle;
    }
    return low;
}
