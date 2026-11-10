/**
 * Flight of a Squad projectile: where it is, and the elevation that lands it on a target.
 * Pure functions without imports, shared by the firing solution, the fire coverage and the range ring,
 * and the same model as Squad Ballistics (ballistics.py), function for function.
 *
 * Model: the game's own (Squad build 26005357; addresses in the Linux server binary, evidence in
 * deadline-squad/squad-ballistics#4). No drag; gravity g = world gravity × ProjectileGravityScale.
 * The barrel pivots at `pivotHeight` h above the weapon's ground; the projectile starts at the muzzle,
 * `muzzleForward` f along the barrel and `muzzleUp` u above its axis, so the launch point moves with the
 * elevation θ (c = cos θ, s = sin θ):
 *     x0 = f·c − u·s                  y0 = h + f·s + u·c
 * It leaves at `velocity` v0 (WeaponConfig.MuzzleVelocity) along the barrel. The game moves it in
 * substeps of the frame time (UProjectileMovementComponent::TickComponent 0x7cef0c0); the dedicated
 * server, whose projectile deals the damage, ticks at 50 Hz: SUBSTEP = 0.02 s. Per substep, with v the
 * velocity and R the projectile's rotation:
 *     move   p += v·dt + (V(R_before) − v)·dt / 2      (Velocity Verlet)
 *     then   R = direction of v, when `rotationFollowsVelocity`
 *     then   v = V(R),  V(R) = (v + (A(R) + g)·dt) clamped to `maxSpeed`
 * A(R) is the rocket motor: `acceleration` a along R during the first `boostTime` T seconds
 * (ConstantAcceleration for ConstantAccelerationTimeout; a < 0: the UB-32's S-5 slows down). Every
 * projectile turns with its velocity (bRotationFollowsVelocity), so the motor pushes along the path, one
 * substep late in the move; the S-5 keeps the barrel's axis (`rotationFollowsVelocity` false). MaxSpeed
 * caps the speed at every substep, the first one too: a shell fired faster than its cap is slowed to it
 * at once, a motor holds a rocket at it, and a shell coming down faster than it is held there.
 *
 * The phases with a closed form are computed exactly: a motor along the barrel (constant acceleration,
 * L(t) = v0·t + a·t²/2 along the axis), the parabola of a coasting shell, and a shell coasting at its cap
 * V (speed constant, the path angle γ turns as dγ/dt = −g·cos γ / V, so with R = V²/g:
 *     x = xc + R·(γc − γ)      y = yc + R·ln(cos γ / cos γc)      t = tc + (V/g)·(atanh sin γc − atanh sin γ);
 * continuous, which the 20 ms substeps follow to 1e-5 of the turn). A motor along the path, and a motor
 * along the barrel that the cap could clamp, have none: those boosts are flown with the game's substeps
 * (flyBoost) and tabulated over the elevation (BoostTable, nodes every BOOST_NODE_SPACING, four-point
 * Lagrange interpolation) so that the searches below stay fast. A shell fired above its cap without a
 * motor (tank HE) flies its first substep exactly, then coasts. Between two substeps the game's path is a
 * straight segment, and so is the model's.
 *
 * Elevation for a target D meters away horizontally from the pivot and H meters above the weapon's
 * ground: the roots θ of F(θ) = y(θ, D) − H, y(θ, D) being the height when the projectile is D meters
 * away (heightAt). y(θ, D) rises from −∞ at θ = −90° to a single peak and falls back to −∞ at +90°:
 *   1. θ* = argmax y(θ, D) on [−LIMIT, LIMIT], LIMIT = π/2 − 1e-6 rad: golden-section search, stopped
 *      when the bracket is narrower than ANGLE_TOLERANCE = 1e-10 rad (52 steps), at most MAX_ITERATIONS;
 *   2. y(θ*, D) < H: out of range, both elevations NaN;
 *   3. each root is bracketed from θ*: the low one in [θ* − δ, θ*], the high one in [θ*, θ* + δ], δ =
 *      BRACKET_STEP = 0.02 rad doubled until F < 0 at the far end (or the end reaches ∓LIMIT);
 *   4. the bracket [a, b] is narrowed by the Illinois method (regula falsi): c = (a·F(b) − b·F(a)) /
 *      (F(b) − F(a)) replaces the end whose F has the sign of F(c), and when the same end is replaced
 *      twice in a row the F kept at the other end is halved; stopped when |F(c)| ≤ HEIGHT_TOLERANCE =
 *      1e-9 m or the bracket is narrower than ANGLE_TOLERANCE, at most MAX_ITERATIONS; the root is c
 *      (about 5 expansions and 8 narrowing steps per root).
 * A caller that solves a row of neighbouring targets (the fire coverage, along a ray) passes the previous
 * root as a guess: step 3 then brackets the root around the guess, from WARM_STEP radians, instead of from
 * θ*. The root is the same to the tolerances of step 4; it takes about half the evaluations.
 * A plain parabola from the pivot (no boost, no muzzle offset, not fired above its cap, not coming down
 * faster than its cap before the target) has the closed-form roots used instead (same result to 1e-10 rad).
 */

// Elevations are searched in [-ELEVATION_LIMIT, ELEVATION_LIMIT] radians: the barrel is never vertical
export const ELEVATION_LIMIT = Math.PI / 2 - 1e-6;

// Width of the last bracket of the searches, radians (1e-10 rad = 0.2 mm at 2 km)
export const ANGLE_TOLERANCE = 1e-10;

// Height error at the target that ends the root search, meters
export const HEIGHT_TOLERANCE = 1e-9;

// First half-width of the root brackets around the highest elevation, radians (doubled until they hold the root)
export const BRACKET_STEP = 0.02;

// First half-width of the bracket around the guess of a warm-started root search, radians (doubled until
// it holds the root): about the change of the root between two cells of the fire coverage
export const WARM_STEP = 2e-4;

// Iteration cap of each search; the tolerances are reached long before (52 golden-section steps, ~10 Illinois steps)
export const MAX_ITERATIONS = 200;

// The game's projectile substep on the dedicated server, seconds: one per frame of its 50 Hz tick
// (NetServerMaxTickRate of the RedpointEOSNetDriver; MaxSimulationTimeStep 0.05 s is never reached)
export const SUBSTEP = 0.02;

// Barrel elevations between the nodes of a boost table, radians: the interpolation reproduces the stepped
// boost to 1e-6 m (to 4e-4 m near the substep where the M3 MAAWS reaches its cap)
export const BOOST_NODE_SPACING = Math.PI / 180;

// Samples of a stretch of the profile under which `trajectory().above` checks them one by one
const COAST_LEAF = 8;

const GOLDEN = (Math.sqrt(5) - 1) / 2;


/**
 * @typedef {object} Shot - how a weapon fires, in meters, seconds and radians
 * @property {number} velocity - launch speed v0 along the barrel, m/s
 * @property {number} gravity - g, m/s² (world gravity × the projectile's gravity scale)
 * @property {number} acceleration - a of the motor during boostTime, m/s² (negative: slows down)
 * @property {number} boostTime - T, s; 0 without boost
 * @property {number} [maxSpeed] - the projectile's speed cap, m/s; 0 or missing: none
 * @property {boolean} [rotationFollowsVelocity] - the motor pushes along the path (default, the game's
 *   bRotationFollowsVelocity); false: along the barrel's axis at launch (UB-32)
 * @property {number} pivotHeight - h, barrel pivot above the weapon's ground, m
 * @property {number} muzzleForward - f, muzzle along the barrel from the pivot, m
 * @property {number} muzzleUp - u, muzzle above the barrel axis, m
 */


/**
 * Whether the shot has a motor phase
 * @param {Shot} shot
 * @returns {boolean}
 */
function hasBoost(shot) {
    return shot.boostTime > 0 && shot.acceleration !== 0;
}


/**
 * Game substeps the motor acts in: those that start before boostTime
 * @param {Shot} shot
 * @returns {number} - 0 without boost
 */
export function boostSteps(shot) {
    return hasBoost(shot) ? Math.ceil(shot.boostTime / SUBSTEP - 1e-9) : 0;
}


/**
 * Whether the cap could clamp a motor along the barrel's axis: that flight's speed is largest at launch or
 * at the end of the boost (the length of an affine function of time), and at the end at most |v0 + a·T| + g·T
 * @param {Shot} shot
 * @returns {boolean}
 */
function capBindsOnAxis(shot) {
    if (!shot.maxSpeed) return false;
    const end = Math.abs(shot.velocity + shot.acceleration * shot.boostTime);
    return shot.velocity > shot.maxSpeed || end + shot.gravity * shot.boostTime > shot.maxSpeed;
}


/**
 * Whether the boost has no closed form and is flown with the game's substeps (BoostTable): a motor along
 * the path, or one along the barrel that the cap could clamp. A flight without gravity is straight either way.
 * @param {Shot} shot
 * @returns {boolean}
 */
export function fliesBoostInSteps(shot) {
    if (!hasBoost(shot) || shot.gravity === 0) return false;
    return shot.rotationFollowsVelocity !== false || capBindsOnAxis(shot);
}


/**
 * Whether the shot is fired faster than its cap without a motor: the first substep slows it (tank HE)
 * @param {Shot} shot
 * @returns {boolean}
 */
function launchClamped(shot) {
    return Boolean(shot.maxSpeed) && shot.velocity > shot.maxSpeed && !hasBoost(shot);
}


/**
 * Seconds the closed-form motor along the barrel speeds the projectile up: boostTime, ended earlier by the
 * cap in a straight flight (no gravity: the NLAW reaches its 250 m/s in 0.6 s and is held there)
 * @param {Shot} shot
 * @returns {number} - 0 without boost
 */
function axisBoostTime(shot) {
    if (!hasBoost(shot)) return 0;
    if (shot.gravity === 0 && shot.maxSpeed && shot.acceleration > 0) {
        return Math.min(shot.boostTime, Math.max(0, (shot.maxSpeed - shot.velocity) / shot.acceleration));
    }
    return shot.boostTime;
}


/**
 * Whether the trajectory is the textbook parabola from the pivot (no boost, no muzzle offset, not fired
 * above its cap), as long as it does not come down faster than its cap (clampsBefore)
 * @param {Shot} shot
 * @returns {boolean}
 */
export function isParabola(shot) {
    return !hasBoost(shot) && !shot.muzzleForward && !shot.muzzleUp && !launchClamped(shot);
}


/**
 * Whether a plain parabola from the pivot comes down faster than its cap before it reaches a target `height`
 * meters above the weapon's ground: its speed there is √(v0² + 2·g·drop), and the lowest point on the way
 * is the pivot or the target
 * @param {Shot} shot
 * @param {number} height - meters above the weapon's ground
 * @returns {boolean}
 */
export function clampsBefore(shot, height) {
    if (!shot.maxSpeed) return false;
    const drop = shot.pivotHeight - height;
    return shot.velocity ** 2 + 2 * shot.gravity * drop > shot.maxSpeed ** 2;
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
 * The boost of a shot fired at `angle`, flown with the game's substeps (see the top) from the muzzle
 * @param {Shot} shot
 * @param {number} angle - barrel elevation, radians
 * @returns {{xs: Float64Array, ys: Float64Array, vx: number, vy: number}} - the points at the start of every
 *   substep and at the end, and the end velocity, meters and m/s relative to the muzzle
 */
export function flyBoost(shot, angle) {
    const dt = SUBSTEP;
    const g = shot.gravity;
    const a = shot.acceleration;
    const cap = shot.maxSpeed || 0;
    const capSquared = cap * cap;
    const follows = shot.rotationFollowsVelocity !== false;
    const steps = boostSteps(shot);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let vx = shot.velocity * cos;
    let vy = shot.velocity * sin;
    // The projectile's rotation: the barrel's at spawn
    let ax = a * cos;
    let ay = a * sin;
    let x = 0;
    let y = 0;
    const xs = new Float64Array(steps + 1);
    const ys = new Float64Array(steps + 1);

    for (let k = 0; k < steps; k++) {
        // Move: the velocity this substep would end with, under the rotation of the substep before
        let mx = vx + ax * dt;
        let my = vy + (ay - g) * dt;
        if (cap) {
            const speedSquared = mx * mx + my * my;
            if (speedSquared > capSquared) {
                const scale = cap / Math.sqrt(speedSquared);
                mx *= scale;
                my *= scale;
            }
        }
        x += 0.5 * (vx + mx) * dt;
        y += 0.5 * (vy + my) * dt;

        if (follows) {
            const speed = Math.hypot(vx, vy);
            ax = a * vx / speed;
            ay = a * vy / speed;
        }

        vx = vx + ax * dt;
        vy = vy + (ay - g) * dt;
        if (cap) {
            const speedSquared = vx * vx + vy * vy;
            if (speedSquared > capSquared) {
                const scale = cap / Math.sqrt(speedSquared);
                vx *= scale;
                vy *= scale;
            }
        }

        xs[k + 1] = x;
        ys[k + 1] = y;
    }

    return { xs, ys, vx, vy };
}


/**
 * A stepped boost tabulated over the barrel elevation: nodes every BOOST_NODE_SPACING from −90° to +90°,
 * each flown by flyBoost the first time it is needed, and four-point Lagrange interpolation between them.
 * The searches evaluate the flight thousands of times per solution; a node costs a whole boost, an
 * interpolated point a few multiplications.
 */
class BoostTable {
    /**
     * @param {Shot} shot
     */
    constructor(shot) {
        this.shot = shot;
        this.steps = boostSteps(shot);
        this.count = Math.round(Math.PI / BOOST_NODE_SPACING) + 1;
        this.nodes = new Array(this.count).fill(null);
        // Stencil and point buffers the searches (heightAt, firstPhaseAbove) fill and read within one call
        this.scratch = { w: [0, 0, 0, 0], n: [null, null, null, null] };
        this.scratchXs = new Float64Array(this.steps + 1);
        this.scratchYs = new Float64Array(this.steps + 1);
    }

    /**
     * Node `index`, at elevation −90° + index × spacing
     * @param {number} index
     * @returns {{xs: Float64Array, ys: Float64Array, vx: number, vy: number}}
     */
    node(index) {
        let node = this.nodes[index];
        if (node === null) {
            node = this.nodes[index] = flyBoost(this.shot, -Math.PI / 2 + index * BOOST_NODE_SPACING);
        }
        return node;
    }

    /**
     * The four nodes that interpolate `angle` (two on each side, shifted inwards at the ends) and their weights
     * @param {number} angle - radians
     * @returns {{w: number[], n: Object[]}}
     */
    stencil(angle) {
        return this.stencilInto(angle, { w: [0, 0, 0, 0], n: [null, null, null, null] });
    }

    /**
     * `stencil` written into a buffer, without allocating (the search loops evaluate it thousands of times)
     * @param {number} angle - radians
     * @param {{w: number[], n: Object[]}} stencil - buffer of four weights and four nodes
     * @returns {{w: number[], n: Object[]}} the buffer
     */
    stencilInto(angle, stencil) {
        const at = (angle + Math.PI / 2) / BOOST_NODE_SPACING;
        const first = Math.min(Math.max(Math.trunc(at) - 1, 0), this.count - 4);
        const u = at - first;
        const { w, n } = stencil;
        w[0] = -(u - 1) * (u - 2) * (u - 3) / 6;
        w[1] = u * (u - 2) * (u - 3) / 2;
        w[2] = -u * (u - 1) * (u - 3) / 2;
        w[3] = u * (u - 1) * (u - 2) / 6;
        n[0] = this.node(first);
        n[1] = this.node(first + 1);
        n[2] = this.node(first + 2);
        n[3] = this.node(first + 3);
        return stencil;
    }

    /**
     * Interpolated substep point k
     * @param {{w: number[], n: Object[]}} stencil
     * @param {number} k
     * @returns {{x: number, y: number}}
     */
    point({ w, n }, k) {
        return {
            x: w[0] * n[0].xs[k] + w[1] * n[1].xs[k] + w[2] * n[2].xs[k] + w[3] * n[3].xs[k],
            y: w[0] * n[0].ys[k] + w[1] * n[1].ys[k] + w[2] * n[2].ys[k] + w[3] * n[3].ys[k],
        };
    }

    /**
     * State at the end of the boost
     * @param {{w: number[], n: Object[]}} stencil
     * @returns {{x: number, y: number, vx: number, vy: number}}
     */
    end(stencil) {
        const { w, n } = stencil;
        const { x, y } = this.point(stencil, this.steps);
        return {
            x,
            y,
            vx: w[0] * n[0].vx + w[1] * n[1].vx + w[2] * n[2].vx + w[3] * n[3].vx,
            vy: w[0] * n[0].vy + w[1] * n[1].vy + w[2] * n[2].vy + w[3] * n[3].vy,
        };
    }

    /**
     * The substep whose straight segment holds the distance `ahead` from the muzzle (the first one for a
     * distance behind the muzzle): binary search on the interpolated x of the substep points
     * @param {{w: number[], n: Object[]}} stencil
     * @param {number} ahead - meters from the muzzle
     * @returns {{k: number, start: {x: number, y: number}, end: {x: number, y: number}}}
     */
    segment(stencil, ahead) {
        const { w, n } = stencil;
        let low = 0;
        let high = this.steps;
        while (high - low > 1) {
            const mid = (low + high) >> 1;
            const x = w[0] * n[0].xs[mid] + w[1] * n[1].xs[mid] + w[2] * n[2].xs[mid] + w[3] * n[3].xs[mid];
            if (x <= ahead) low = mid;
            else high = mid;
        }
        return { k: low, start: this.point(stencil, low), end: this.point(stencil, low + 1) };
    }
}


// Boost tables by flight parameters, shared by every shot that flies alike
const BOOST_TABLES = new Map();

// The table of each Shot object: the searches look it up for every height, faster than by its key
const SHOT_TABLES = new WeakMap();


/**
 * The BoostTable of a stepped shot
 * @param {Shot} shot
 * @returns {BoostTable}
 */
function boostTable(shot) {
    let table = SHOT_TABLES.get(shot);
    if (table) return table;

    const key = [shot.velocity, shot.gravity, shot.acceleration, shot.boostTime, shot.maxSpeed || 0,
        shot.rotationFollowsVelocity !== false].join("|");
    table = BOOST_TABLES.get(key);
    if (!table) {
        table = new BoostTable(shot);
        BOOST_TABLES.set(key, table);
    }
    SHOT_TABLES.set(shot, table);
    return table;
}


/**
 * State after the first substep of a shell fired above its cap, relative to the muzzle: ComputeVelocity
 * clamps v0 + g·dt to maxSpeed, and the move is the average of the two velocities
 * @param {Shot} shot
 * @param {number} cos - cos θ
 * @param {number} sin - sin θ
 * @returns {{x: number, y: number, vx: number, vy: number}}
 */
function clampedLaunch(shot, cos, sin) {
    const v0 = shot.velocity;
    let vx = v0 * cos;
    let vy = v0 * sin - shot.gravity * SUBSTEP;
    const scale = shot.maxSpeed / Math.hypot(vx, vy);
    vx *= scale;
    vy *= scale;
    return { x: 0.5 * (v0 * cos + vx) * SUBSTEP, y: 0.5 * (v0 * sin + vy) * SUBSTEP, vx, vy };
}


/**
 * Height at `ahead` meters of a projectile coasting from (x, y) at (vx, vy), all relative to the muzzle:
 * the parabola, and once it comes down faster than its cap the capped coast (see the top). Far past where
 * the capped coast turns straight down (it never gets there) the height is a very large negative number.
 * @param {Shot} shot
 * @returns {number} - meters relative to the muzzle
 */
function coastHeight(shot, x, y, vx, vy, ahead) {
    const g = shot.gravity;
    const tau = (ahead - x) / vx;
    const cap = shot.maxSpeed || 0;

    if (cap && g) {
        const onset = Math.max(0, (vy + Math.sqrt(Math.max(0, cap * cap - vx * vx))) / g);
        if (tau > onset) {
            const yc = y + onset * (vy - 0.5 * g * onset);
            const radius = cap * cap / g;
            const cosOnset = Math.min(1, vx / cap);
            const turn = Math.acos(cosOnset) + (ahead - x - vx * onset) / radius;
            return yc + radius * Math.log(Math.max(Math.cos(turn), 1e-300) / cosOnset);
        }
    }

    return y + tau * (vy - 0.5 * g * tau);
}


/**
 * The constants of a coast (coastHeight) for loops over many distances (trajectory's `above`): where the
 * capped coast starts (`onset` seconds after (x, y), at height `yc`, `reachOnset` meters further), its turn
 * radius V²/g and the path angle there (cos and acos); onset ∞ without a cap
 * @param {Shot} shot
 * @returns {Object}
 */
function coast(shot, x, y, vx, vy) {
    const g = shot.gravity;
    const cap = shot.maxSpeed || 0;
    const capped = Boolean(cap && g);
    const onset = capped ? Math.max(0, (vy + Math.sqrt(Math.max(0, cap * cap - vx * vx))) / g) : Infinity;
    const cosOnset = capped ? Math.min(1, vx / cap) : 1;
    return {
        x, y, vx, vy, g, onset, cosOnset,
        yc: capped ? y + onset * (vy - 0.5 * g * onset) : 0,
        radius: capped ? cap * cap / g : 0,
        acosOnset: Math.acos(cosOnset),
        reachOnset: capped ? vx * onset : 0,
    };
}


/**
 * Height, time and path angle at `ahead` meters of the coast `coastHeight` flies, started at time `t`
 * @param {Shot} shot
 * @returns {{height: number, time: number, angle: number}} - meters relative to the muzzle, seconds,
 *   radians above the horizontal; a point the capped coast never reaches is (−∞, ∞, −π/2)
 */
function coastAt(shot, x, y, vx, vy, t, ahead) {
    const g = shot.gravity;
    const tau = (ahead - x) / vx;
    const cap = shot.maxSpeed || 0;

    if (cap && g) {
        const onset = Math.max(0, (vy + Math.sqrt(Math.max(0, cap * cap - vx * vx))) / g);
        if (tau > onset) {
            const yc = y + onset * (vy - 0.5 * g * onset);
            const radius = cap * cap / g;
            const cosOnset = Math.min(1, vx / cap);
            const turn = Math.acos(cosOnset) + (ahead - x - vx * onset) / radius;
            if (turn >= Math.PI / 2) return { height: -Infinity, time: Infinity, angle: -Math.PI / 2 };
            // t = (cap / g)·(atanh sin γ_onset − atanh sin γ)
            const since = (cap / g) * (Math.atanh(Math.sin(turn)) - Math.atanh(Math.sqrt(Math.max(0, 1 - cosOnset * cosOnset))));
            return { height: yc + radius * Math.log(Math.cos(turn) / cosOnset), time: t + onset + since, angle: -turn };
        }
    }

    return { height: y + tau * (vy - 0.5 * g * tau), time: t + tau, angle: Math.atan2(vy - g * tau, vx) };
}


/**
 * Height of the projectile when it is `distance` meters away horizontally from the pivot (the searches
 * evaluate it thousands of times; `trajectory` also gives the time)
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
    const startX = shot.muzzleForward * cos - shot.muzzleUp * sin;
    const startY = shot.pivotHeight + shot.muzzleForward * sin + shot.muzzleUp * cos;
    const ahead = distance - startX;

    if (fliesBoostInSteps(shot)) {
        if (Number.isNaN(angle)) return NaN;
        const table = boostTable(shot);
        const { w, n } = table.stencilInto(angle, table.scratch);
        const steps = table.steps;
        const endX = w[0] * n[0].xs[steps] + w[1] * n[1].xs[steps] + w[2] * n[2].xs[steps] + w[3] * n[3].xs[steps];
        if (ahead < endX) {
            // The substep whose segment holds `ahead`, as BoostTable.segment, then the height on it
            let low = 0;
            let high = steps;
            while (high - low > 1) {
                const mid = (low + high) >> 1;
                const x = w[0] * n[0].xs[mid] + w[1] * n[1].xs[mid] + w[2] * n[2].xs[mid] + w[3] * n[3].xs[mid];
                if (x <= ahead) low = mid;
                else high = mid;
            }
            const next = low + 1;
            const startPointX = w[0] * n[0].xs[low] + w[1] * n[1].xs[low] + w[2] * n[2].xs[low] + w[3] * n[3].xs[low];
            const startPointY = w[0] * n[0].ys[low] + w[1] * n[1].ys[low] + w[2] * n[2].ys[low] + w[3] * n[3].ys[low];
            const nextX = w[0] * n[0].xs[next] + w[1] * n[1].xs[next] + w[2] * n[2].xs[next] + w[3] * n[3].xs[next];
            const nextY = w[0] * n[0].ys[next] + w[1] * n[1].ys[next] + w[2] * n[2].ys[next] + w[3] * n[3].ys[next];
            return startY + startPointY + (nextY - startPointY) * (ahead - startPointX) / (nextX - startPointX);
        }
        const endY = w[0] * n[0].ys[steps] + w[1] * n[1].ys[steps] + w[2] * n[2].ys[steps] + w[3] * n[3].ys[steps];
        const endVx = w[0] * n[0].vx + w[1] * n[1].vx + w[2] * n[2].vx + w[3] * n[3].vx;
        const endVy = w[0] * n[0].vy + w[1] * n[1].vy + w[2] * n[2].vy + w[3] * n[3].vy;
        return startY + coastHeight(shot, endX, endY, endVx, endVy, ahead);
    }

    if (hasBoost(shot)) {
        const a = shot.acceleration;
        const boost = axisBoostTime(shot);
        const length = v0 * boost + 0.5 * a * boost * boost;
        if (ahead <= cos * length) {
            const along = ahead / cos;
            const t = 2 * along / (v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * along)));
            return startY + sin * along - 0.5 * g * t * t;
        }
        const endSpeed = v0 + a * boost;
        return startY + coastHeight(shot, cos * length, sin * length - 0.5 * g * boost * boost,
            cos * endSpeed, sin * endSpeed - g * boost, ahead);
    }

    if (launchClamped(shot)) {
        const first = clampedLaunch(shot, cos, sin);
        if (ahead < first.x) return startY + first.y * ahead / first.x;
        return startY + coastHeight(shot, first.x, first.y, first.vx, first.vy, ahead);
    }

    return startY + coastHeight(shot, 0, 0, v0 * cos, v0 * sin, ahead);
}


/**
 * Sparse table of the maximum of a terrain profile over any range of samples: `max(first, last)` in O(1)
 * after a build in O(n log n). `trajectory().above` uses it to clear a whole stretch of the profile with
 * one comparison.
 */
export class RangeMax {
    /**
     * @param {number} length - largest number of samples a profile will have
     */
    constructor(length) {
        this.levels = [];
        for (let span = 1; span <= Math.max(length, 1); span *= 2) this.levels.push(new Float64Array(length));
    }

    /**
     * Index the maxima of a profile
     * @param {Float64Array} profile - heights, at most the `length` of the constructor
     * @returns {RangeMax} this
     */
    build(profile) {
        const size = profile.length;
        this.levels[0].set(profile);
        for (let level = 1, span = 1; level < this.levels.length && span * 2 <= size; level++, span *= 2) {
            const previous = this.levels[level - 1];
            const next = this.levels[level];
            for (let i = 0; i + span * 2 <= size; i++) next[i] = Math.max(previous[i], previous[i + span]);
        }
        return this;
    }

    /**
     * Largest height of the samples from `first` to `last`
     * @param {number} first - index
     * @param {number} last - index, ≥ first
     * @returns {number}
     */
    max(first, last) {
        const level = 31 - Math.clz32(last - first + 1);
        return Math.max(this.levels[level][first], this.levels[level][last - (1 << level) + 1]);
    }
}


/**
 * The trajectory at one elevation, with its constants computed once: height and time of the projectile
 * when it is a horizontal distance away from the pivot (see the top; a distance behind the muzzle
 * extrapolates the first phase backwards)
 * @param {Shot} shot
 * @param {number} angle - barrel elevation θ, radians, in (−π/2, π/2)
 * @returns {{height: function(number): number, time: function(number): number, at: function(number): Object, above: function(Float64Array, number, number, number, number): boolean}} -
 *   for a distance in meters: meters above the weapon's ground (the numbers of heightAt), seconds since
 *   launch (0 behind the muzzle), and `at` = {height, time, angle} (path angle above the horizontal,
 *   radians; a point the capped coast never reaches is (−∞, ∞, −π/2)); `above(profile, first, last, step,
 *   ground, rangeMax)`: whether ground + height(i·step) ≥ profile[i] for every i from first to last (fire
 *   coverage); `rangeMax`, a RangeMax built on the profile, makes it clear the coast with a few comparisons
 *   instead of one per sample
 */
export function trajectory(shot, angle) {
    // An elevation out of range (NaN) gives NaN everywhere, as the closed forms do
    if (Number.isNaN(angle)) {
        return { height: () => NaN, time: () => NaN, at: () => ({ height: NaN, time: NaN, angle: NaN }), above: () => false };
    }

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const start = launchPoint(shot, angle);
    const v0 = shot.velocity;
    const g = shot.gravity;

    // Each phase as height(ahead) and at(ahead), ahead = meters past the muzzle, relative to the muzzle:
    // the first phase (boost or first substep) up to `firstPhase` meters, then the coast `after`
    let height;
    let at;
    let firstPhase;
    let after;
    // Checks the first phase for `above` from sample i on: the next sample, -1 when under the profile
    let firstPhaseAbove = (profile, i, last, step, base) => {
        for (; i <= last && i * step - start.x < firstPhase; i++) {
            if (base + height(i * step - start.x) < profile[i]) return -1;
        }
        return i;
    };
    if (fliesBoostInSteps(shot)) {
        const table = boostTable(shot);
        const stencil = table.stencil(angle);
        const end = table.end(stencil);
        const boostEnd = table.steps * SUBSTEP;
        firstPhase = end.x;
        after = coast(shot, end.x, end.y, end.vx, end.vy);
        // The substep points at this elevation, interpolated the first time a height is asked
        let xs = null;
        let ys = null;
        const interpolate = () => {
            const { w, n } = stencil;
            xs = new Float64Array(table.steps + 1);
            ys = new Float64Array(table.steps + 1);
            for (let k = 0; k <= table.steps; k++) {
                xs[k] = w[0] * n[0].xs[k] + w[1] * n[1].xs[k] + w[2] * n[2].xs[k] + w[3] * n[3].xs[k];
                ys[k] = w[0] * n[0].ys[k] + w[1] * n[1].ys[k] + w[2] * n[2].ys[k] + w[3] * n[3].ys[k];
            }
        };
        firstPhaseAbove = (profile, i, last, step, base) => {
            // The substep points are interpolated into the table's buffers as the scan reaches them
            const { w, n } = stencil;
            const scanXs = table.scratchXs;
            const scanYs = table.scratchYs;
            let filled = -1;
            const fill = (k) => {
                while (filled < k) {
                    filled++;
                    scanXs[filled] = w[0] * n[0].xs[filled] + w[1] * n[1].xs[filled] + w[2] * n[2].xs[filled] + w[3] * n[3].xs[filled];
                    scanYs[filled] = w[0] * n[0].ys[filled] + w[1] * n[1].ys[filled] + w[2] * n[2].ys[filled] + w[3] * n[3].ys[filled];
                }
            };
            let k = 0;
            for (; i <= last; i++) {
                const ahead = i * step - start.x;
                if (ahead >= end.x) break;
                while (k < table.steps - 1 && (fill(k + 1), scanXs[k + 1] <= ahead)) k++;
                fill(k + 1);
                if (base + scanYs[k] + (scanYs[k + 1] - scanYs[k]) * (ahead - scanXs[k]) / (scanXs[k + 1] - scanXs[k]) < profile[i]) return -1;
            }
            return i;
        };
        height = (ahead) => {
            if (ahead < end.x) {
                if (!xs) interpolate();
                let low = 0;
                let high = table.steps;
                while (high - low > 1) {
                    const mid = (low + high) >> 1;
                    if (xs[mid] <= ahead) low = mid;
                    else high = mid;
                }
                return ys[low] + (ys[low + 1] - ys[low]) * (ahead - xs[low]) / (xs[low + 1] - xs[low]);
            }
            return coastHeight(shot, after.x, after.y, after.vx, after.vy, ahead);
        };
        at = (ahead) => {
            if (ahead < end.x) {
                const { k, start: a, end: b } = table.segment(stencil, ahead);
                const part = (ahead - a.x) / (b.x - a.x);
                return { height: a.y + (b.y - a.y) * part, time: Math.max(0, (k + part) * SUBSTEP), angle: Math.atan2(b.y - a.y, b.x - a.x) };
            }
            return coastAt(shot, end.x, end.y, end.vx, end.vy, boostEnd, ahead);
        };
    } else if (hasBoost(shot)) {
        const a = shot.acceleration;
        const boost = axisBoostTime(shot);
        const length = v0 * boost + 0.5 * a * boost * boost;
        const endSpeed = v0 + a * boost;
        const endX = cos * length;
        const endY = sin * length - 0.5 * g * boost * boost;
        const endVx = cos * endSpeed;
        const endVy = sin * endSpeed - g * boost;
        firstPhase = endX;
        after = coast(shot, endX, endY, endVx, endVy);
        height = (ahead) => {
            if (ahead <= cos * length) {
                const along = ahead / cos;
                const t = 2 * along / (v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * along)));
                return sin * along - 0.5 * g * t * t;
            }
            return coastHeight(shot, after.x, after.y, after.vx, after.vy, ahead);
        };
        at = (ahead) => {
            if (ahead <= cos * length) {
                const along = ahead / cos;
                const t = 2 * along / (v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * along)));
                const speed = v0 + a * t;
                return { height: sin * along - 0.5 * g * t * t, time: Math.max(0, t), angle: Math.atan2(sin * speed - g * t, cos * speed) };
            }
            return coastAt(shot, endX, endY, endVx, endVy, boost, ahead);
        };
    } else if (launchClamped(shot)) {
        const first = clampedLaunch(shot, cos, sin);
        firstPhase = first.x;
        after = coast(shot, first.x, first.y, first.vx, first.vy);
        height = (ahead) => {
            if (ahead < first.x) return first.y * ahead / first.x;
            return coastHeight(shot, after.x, after.y, after.vx, after.vy, ahead);
        };
        at = (ahead) => {
            if (ahead < first.x) {
                return { height: first.y * ahead / first.x, time: Math.max(0, SUBSTEP * ahead / first.x), angle: Math.atan2(first.y, first.x) };
            }
            return coastAt(shot, first.x, first.y, first.vx, first.vy, SUBSTEP, ahead);
        };
    } else {
        const vx = v0 * cos;
        const vy = v0 * sin;
        firstPhase = -Infinity;
        after = coast(shot, 0, 0, vx, vy);
        height = (ahead) => coastHeight(shot, 0, 0, vx, vy, ahead);
        at = (ahead) => {
            const point = coastAt(shot, 0, 0, vx, vy, 0, ahead);
            point.time = Math.max(0, point.time);
            return point;
        };
    }

    const atDistance = (distance) => {
        const point = at(distance - start.x);
        point.height += start.y;
        return point;
    };

    /**
     * `above` on a concave stretch of the path (the coast: a parabola, or the capped coast that turns at a
     * constant speed; also the whole flight when no stepped boost is involved, see `concave`): the heights
     * `heightAtSample(i)` rise to an apex and fall, so the stretch splits at the apex (a binary search on
     * the sign of the slope) into two monotone ones. On a monotone stretch the heights of the trajectory
     * lie between its two ends, so it clears the whole stretch when the highest terrain sample is at or
     * under the lower end, and none of it when the highest sample is over the higher end (that sample is
     * over the trajectory); otherwise the stretch is halved. The answer is the one of the
     * sample-by-sample scan, in O(log n) comparisons when the trajectory is not grazing the terrain.
     */
    const concaveAbove = (profile, first, last, rangeMax, heightAtSample) => {
        const clearsStretch = (from, to, heightFrom, heightTo) => {
            if (to - from < COAST_LEAF) {
                for (let i = from + 1; i < to; i++) if (heightAtSample(i) < profile[i]) return false;
                return !(heightFrom < profile[from] || heightTo < profile[to]);
            }
            const highest = rangeMax.max(from, to);
            if (highest <= Math.min(heightFrom, heightTo)) return true;
            if (highest > Math.max(heightFrom, heightTo)) return false;
            const middle = (from + to) >> 1;
            const heightMiddle = heightAtSample(middle);
            const heightNext = heightAtSample(middle + 1);
            return clearsStretch(from, middle, heightFrom, heightMiddle) && clearsStretch(middle + 1, to, heightNext, heightTo);
        };

        // The last sample of the rising stretch: the first one the next sample falls below
        let low = first;
        let high = last;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (heightAtSample(middle + 1) < heightAtSample(middle)) high = middle;
            else low = middle + 1;
        }
        const rising = low;
        if (!clearsStretch(first, rising, heightAtSample(first), heightAtSample(rising))) return false;
        return rising === last || clearsStretch(rising + 1, last, heightAtSample(rising + 1), heightAtSample(last));
    };

    /**
     * The height above the profile's reference of the coast (see `coast`) at sample i, as `above` computes it
     */
    const coastSample = (i, step, base) => {
        const c = after;
        const tau = (i * step - start.x - c.x) / c.vx;
        if (tau <= c.onset) return base + c.y + tau * (c.vy - 0.5 * c.g * tau);
        const cosTurn = Math.cos(c.acosOnset + (i * step - start.x - c.x - c.reachOnset) / c.radius);
        return cosTurn > 0 ? base + c.yc - c.radius * Math.log(c.cosOnset) + c.radius * Math.log(cosTurn) : -Infinity;
    };

    /**
     * Whether the trajectory stays at or above a terrain profile sampled every `step` meters, from sample
     * `first` to `last`, the weapon's ground being `ground` in the profile's reference. The fire coverage
     * runs it for every cell, on hundreds of samples: the first phase is evaluated sample by sample (the
     * stepped boost walking its substeps), the parabola inline, and the capped coast by turning its path angle by step / R per sample (a rotation)
     * and adding up ln(cos γ) (ln(1 + z) by its series while |z| < 1e-3, exact to 1e-16), the same heights
     * as coastHeight to ~1e-9 m without a cos and a log per sample.
     * With a `rangeMax` of the profile the samples are checked by `concaveAbove` instead.
     */
    const above = (profile, first, last, step, ground, rangeMax) => {
        const base = ground + start.y;
        // Without a stepped boost the whole flight is concave: a closed-form boost along the axis has
        // a concave height over the distance (its slope falls with time), and so do the coast and the
        // first substep of a shell slowed to its cap, which join with a falling slope
        if (rangeMax && !fliesBoostInSteps(shot)) {
            return first > last || concaveAbove(profile, first, last, rangeMax, (i) => base + height(i * step - start.x));
        }
        let i = firstPhaseAbove(profile, first, last, step, base);
        if (i < 0) return false;
        if (rangeMax) return i > last || concaveAbove(profile, i, last, rangeMax, (k) => coastSample(k, step, base));

        const c = after;
        for (; i <= last; i++) {
            const tau = (i * step - start.x - c.x) / c.vx;
            if (tau > c.onset) break;
            if (base + c.y + tau * (c.vy - 0.5 * c.g * tau) < profile[i]) return false;
        }
        if (i > last) return true;

        const turnStep = step / c.radius;
        const cosStep = Math.cos(turnStep);
        const sinStep = Math.sin(turnStep);
        const turn = c.acosOnset + (i * step - start.x - c.x - c.reachOnset) / c.radius;
        let cosTurn = Math.cos(turn);
        let sinTurn = Math.sin(turn);
        let logCos = Math.log(cosTurn);
        const level = base + c.yc - c.radius * Math.log(c.cosOnset);
        for (; i <= last; i++) {
            // Turned past straight down: the capped coast never gets there
            if (!(cosTurn > 0)) return false;
            if (level + c.radius * logCos < profile[i]) return false;
            const nextCos = cosTurn * cosStep - sinTurn * sinStep;
            sinTurn = sinTurn * cosStep + cosTurn * sinStep;
            const z = nextCos / cosTurn - 1;
            logCos += Math.abs(z) < 1e-3 ? z * (1 - z * (0.5 - z * (1 / 3 - z * 0.25))) : Math.log(nextCos / cosTurn);
            cosTurn = nextCos;
        }
        return true;
    };

    return {
        height: (distance) => start.y + height(distance - start.x),
        time: (distance) => atDistance(distance).time,
        at: atDistance,
        above,
    };
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
    const { height, time } = trajectory(shot, angle).at(distance);
    return { height, time };
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
 * Root of `error` beyond `top`, where error(top) ≥ 0, towards `direction` (-1: lower elevations, +1: higher):
 * bracket expansion then the Illinois method (steps 3 and 4 at the top)
 * @param {function(number): number} error - F(θ), meters
 * @param {number} top - θ*, radians
 * @param {number} topError - F(θ*), meters, ≥ 0: evaluated once by the caller
 * @param {number} direction - -1 or +1
 * @param {number} [guess] - a root found for a neighbouring target, radians: the bracket is built around
 *   it when it lies beyond `top` in `direction`; NaN or missing: from `top`
 * @returns {number} - radians
 */
function findRoot(error, top, topError, direction, guess = NaN) {
    // Bracket [a, b]: F(a) ≥ 0 at the top side, F(b) < 0 at the far side
    let a = top;
    let errorA = topError;
    let b = top;
    let errorB = topError;

    if (direction * (guess - top) > 0 && Math.abs(guess) <= ELEVATION_LIMIT) {
        const guessError = error(guess);
        a = b = guess;
        errorA = errorB = guessError;
        if (guessError >= 0) {
            for (let step = WARM_STEP; errorB >= 0; step *= 2) {
                b = Math.min(Math.max(guess + direction * step, -ELEVATION_LIMIT), ELEVATION_LIMIT);
                errorB = error(b);
                if (Math.abs(b) === ELEVATION_LIMIT) break;
            }
        } else {
            for (let step = WARM_STEP; errorA < 0; step *= 2) {
                a = guess - direction * step;
                if (direction * (a - top) <= 0) {
                    a = top;
                    errorA = topError;
                    break;
                }
                errorA = error(a);
            }
        }
    } else {
        for (let step = BRACKET_STEP; errorB >= 0; step *= 2) {
            b = Math.min(Math.max(top + direction * step, -ELEVATION_LIMIT), ELEVATION_LIMIT);
            errorB = error(b);
            if (Math.abs(b) === ELEVATION_LIMIT) break;
        }
    }

    let kept = 0;
    let root = b;
    for (let i = 0; i < MAX_ITERATIONS && Math.abs(b - a) > ANGLE_TOLERANCE; i++) {
        root = (a * errorB - b * errorA) / (errorB - errorA);
        const errorRoot = error(root);
        if (Math.abs(errorRoot) <= HEIGHT_TOLERANCE) break;
        if (errorRoot < 0) {
            b = root;
            errorB = errorRoot;
            if (kept === -1) errorA /= 2;
            kept = -1;
        } else {
            a = root;
            errorA = errorRoot;
            if (kept === 1) errorB /= 2;
            kept = 1;
        }
    }
    return root;
}


/**
 * Barrel elevations that land the projectile on a target
 * @param {Shot} shot
 * @param {number} distance - horizontal distance from the pivot to the target, meters, > 0
 * @param {number} height - target height above the weapon's ground, meters
 * @param {number} [peak] - peakAngle(shot, distance) when the caller already has it (coverage)
 * @param {{low: boolean, high: boolean}} [wanted] - which arcs to search for (the fire coverage skips
 *   the arcs the weapon cannot fire); an arc not wanted is NaN
 * @param {{low: number, high: number}} [guess] - the roots of a neighbouring target (coverage, along a ray),
 *   radians, NaN for an arc without one: the root search starts around them (see the top)
 * @returns {{low: number, high: number}} - radians, physical barrel angles; NaN out of range, for a target the
 *   muzzle is not short of at that angle, and for a distance that is not positive or a height that is not finite
 *   (no target to aim at)
 */
export function solveElevation(shot, distance, height, peak, wanted = { low: true, high: true }, guess = {}) {
    if (!(distance > 0) || !Number.isFinite(height)) return { low: NaN, high: NaN };

    const g = shot.gravity;
    const v = shot.velocity;

    if (isParabola(shot) && g > 0 && !clampsBefore(shot, height)) {
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
    const topError = heightAt(shot, top, distance) - height;
    if (topError < 0) return { low: NaN, high: NaN };

    const error = (angle) => heightAt(shot, angle, distance) - height;
    // The projectile starts at the muzzle. heightAt extends the first phase behind it, so a root can be the barrel's
    // own line through a target the muzzle has already passed: that is not a shot
    const pastMuzzle = (root) => (launchPoint(shot, root).x < distance ? root : NaN);
    return {
        low: wanted.low ? pastMuzzle(findRoot(error, top, topError, -1, guess.low)) : NaN,
        high: wanted.high ? pastMuzzle(findRoot(error, top, topError, 1, guess.high)) : NaN,
    };
}


/**
 * Farthest target on flat ground (at the height of the weapon's ground): the largest distance whose
 * peak height reaches 0 (doubling, then bisection on the distance to 1 mm)
 * @param {Shot} shot - with gravity > 0
 * @returns {number} - meters
 */
export function maxRange(shot) {
    if (isParabola(shot) && !shot.pivotHeight) return shot.velocity ** 2 / shot.gravity;

    const reachable = (distance) => heightAt(shot, peakAngle(shot, distance), distance) >= 0;
    // Speed along the barrel after the boost of a straight flight, held at the cap
    let cruise = shot.velocity + shot.acceleration * axisBoostTime(shot);
    if (shot.maxSpeed) cruise = Math.min(cruise, shot.maxSpeed);
    let low = 0;
    let high = Math.max(shot.velocity, cruise) ** 2 / shot.gravity;
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
