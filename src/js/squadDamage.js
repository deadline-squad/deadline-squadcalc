/**
 * Explosion damage on the terrain: who an impact hurts once cover is counted, and how likely one
 * round is to kill or wound a soldier standing at the aim point given the weapon's spread.
 *
 * Damage is Unreal's radial damage with falloff (UGameplayStatics::ApplyRadialDamageWithFalloff,
 * FRadialDamageParams::GetDamageScale), which the game's projectile fields feed: full damage up to the
 * inner radius, then `damage * (1 - (d - inner) / (outer - inner)) ^ falloff`, none past the outer one.
 * The distance is SquadCalc's (Weapon.calculateDistanceForDamage, the damage circles): from the
 * explosion, `distanceFromImpact` above the impact, to PLAYER_HEIGHT above the soldier's feet.
 *
 * Cover: Unreal only damages a component the explosion can see (ComponentIsDamageableFrom traces from
 * the explosion to the centre of the component's bounds), so a soldier is covered when the line from
 * the explosion to BODY_CENTER above his feet passes under the heightmap, which holds the terrain and
 * the top of the buildings. The heightmap has one height per meter: a soldier under a roof stands on
 * the roof for it, and walls closer than EXPLOSION_CLEARANCE to the impact are not seen.
 *
 * With the volume layer (squadVolume.js, deadline-squad/deadline-squadcalc#22 C6) `damageField` takes `objects`: the
 * heightmap is then the landscape alone and the buildings, walls and trees are voxels, so a soldier is covered
 * also when the line from the explosion to him meets a voxel (`objects.blocked`, an exact voxel-column walk of the
 * engine), the landscape being tested as before. A wall stops it, an open doorway or window does not; no
 * penetration is computed (owner decision of 2026-11-04).
 *
 * Pure functions (no map, no DOM): `heightAt(east, north)` gives the height in meters at an offset in
 * meters from the point the function is centred on.
 */

// Height of the point the damage distance is measured to, as in Weapon.calculateDistanceForDamage
export const PLAYER_HEIGHT = 1.8;

// Centre of a standing soldier's bounds: what the explosion has to see
export const BODY_CENTER = 0.9;

// Damage that kills a soldier (full health) and the one SquadCalc's outer circle shows
export const KILL_DAMAGE = 100;
export const WOUND_DAMAGE = 25;

// The heightmap this close to the impact is the impact's own spot (slope, crater, the wall it hit)
export const EXPLOSION_CLEARANCE = 1;

// The heightmap this close to the soldier is the ground he stands on
const SOLDIER_CLEARANCE = 0.5;

// Step of the cover trace, and how far the heightmap must rise above the line to block it, in meters
const TRACE_STEP = 0.5;
const COVER_TOLERANCE = 0.2;

// Impacts sampled over the spread ellipse for the hit probability: 400 radii a 400th of the ellipse apart
// match 400,000 random shots of the game's cone within 0.01
const SPREAD_SAMPLES = 400;

// Golden angle: the direction of successive samples, whose radii grow steadily, never lines up
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));


/**
 * Damage of an explosion at a distance
 * @param {{damage: number, inner: number, outer: number, falloff: number}} explosion - base damage,
 *   inner and outer radius in meters, falloff exponent
 * @param {number} distance - meters from the explosion
 * @returns {number} - damage dealt
 */
export function damageAtDistance(explosion, distance) {
    const { damage, inner, outer, falloff } = explosion;
    if (distance <= inner) return damage;
    if (distance >= outer) return 0;
    return damage * Math.pow(1 - (distance - inner) / (outer - inner), falloff);
}


/**
 * Whether the line between two points passes under the heightmap
 * @param {function(number, number): number} heightAt - height at (east, north) meters
 * @param {{east: number, north: number, z: number}} from - the explosion
 * @param {{east: number, north: number, z: number}} to - the soldier's body centre
 * @returns {boolean} - true if the terrain or a building is in between
 */
export function isCovered(heightAt, from, to) {
    const length = Math.hypot(to.east - from.east, to.north - from.north);
    for (let s = EXPLOSION_CLEARANCE; s < length - SOLDIER_CLEARANCE; s += TRACE_STEP) {
        const t = s / length;
        const lineZ = from.z + (to.z - from.z) * t;
        if (heightAt(from.east + (to.east - from.east) * t, from.north + (to.north - from.north) * t) > lineZ + COVER_TOLERANCE) {
            return true;
        }
    }
    return false;
}


/**
 * Damage an impact deals to a soldier standing somewhere, cover included
 * @param {function(number, number): number} heightAt - height at (east, north) meters
 * @param {{damage: number, inner: number, outer: number, falloff: number, distanceFromImpact: number}} explosion
 * @param {{east: number, north: number}} impact - where the round lands
 * @param {{east: number, north: number}} soldier - where the soldier stands
 * @returns {{damage: number, covered: boolean, exposed: number}} - damage dealt (0 when covered),
 *   whether cover stopped it, and the damage without cover
 */
export function impactDamage(heightAt, explosion, impact, soldier) {
    const explosionZ = heightAt(impact.east, impact.north) + explosion.distanceFromImpact;
    const feet = heightAt(soldier.east, soldier.north);
    const horizontal = Math.hypot(soldier.east - impact.east, soldier.north - impact.north);
    const damage = damageAtDistance(explosion, Math.hypot(horizontal, explosionZ - (feet + PLAYER_HEIGHT)));
    if (damage <= 0) return { damage: 0, covered: false, exposed: 0 };

    const covered = isCovered(heightAt, { ...impact, z: explosionZ }, { ...soldier, z: feet + BODY_CENTER });
    return { damage: covered ? 0 : damage, covered, exposed: damage };
}


/**
 * The horizon of the explosion in every direction: the largest slope, seen from the explosion, of the
 * terrain that can hide a soldier farther away. Along each of `rays` rays from the impact the heightmap is
 * sampled at the cover trace's own distances (EXPLOSION_CLEARANCE, then every TRACE_STEP) and `horizon[k]`
 * is the largest of (height - COVER_TOLERANCE - explosionZ) / distance over the samples up to the k-th.
 * A line from the explosion to a body centre `top` above a point at `length` meters passes under the
 * heightmap at distance d when (height(d) - tolerance - explosionZ) / d > (top - explosionZ) / length, so
 * one prefix maximum per ray answers the cover question of every soldier along the ray, where `isCovered`
 * walks the whole line for each soldier.
 * @param {function(number, number): number} heightAt - height at (east, north) meters from the impact
 * @param {number} explosionZ - height of the explosion
 * @param {number} radius - farthest soldier, meters
 * @param {number} rays - number of directions, counter-clockwise from east
 * @returns {{horizon: Float64Array, samples: number}} - horizon[ray * samples + k]
 */
function sweepHorizon(heightAt, explosionZ, radius, rays) {
    const samples = Math.max(0, Math.ceil((radius - SOLDIER_CLEARANCE - EXPLOSION_CLEARANCE) / TRACE_STEP));
    const horizon = new Float64Array(rays * samples);
    for (let ray = 0; ray < rays; ray++) {
        const east = Math.cos((2 * Math.PI * ray) / rays);
        const north = Math.sin((2 * Math.PI * ray) / rays);
        let largest = -Infinity;
        for (let k = 0; k < samples; k++) {
            const distance = EXPLOSION_CLEARANCE + k * TRACE_STEP;
            largest = Math.max(largest, (heightAt(east * distance, north * distance) - COVER_TOLERANCE - explosionZ) / distance);
            horizon[ray * samples + k] = largest;
        }
    }
    return { horizon, samples };
}


/**
 * Whether an object of the volume layer is between the explosion (the origin) and a soldier's body centre, on the
 * same stretch of the line as the heightmap trace (`isCovered`): from EXPLOSION_CLEARANCE to SOLDIER_CLEARANCE
 * short of him
 * @param {{blocked: function(number, number, number, number, number, number): boolean}} objects - see damageField
 * @param {number} explosionZ - height of the explosion
 * @param {{east: number, north: number, z: number}} to - the soldier's body centre
 * @param {number} length - horizontal distance to him, meters
 * @returns {boolean}
 */
function objectsBlock(objects, explosionZ, to, length) {
    const from = EXPLOSION_CLEARANCE / length;
    const until = (length - SOLDIER_CLEARANCE) / length;
    if (until <= from) return false;
    const along = (t) => [to.east * t, to.north * t, explosionZ + (to.z - explosionZ) * t];
    return objects.blocked(...along(from), ...along(until));
}


/**
 * Damage around an impact on a square grid centred on it. Cover is read from a horizon sweep of the
 * impact (sweepHorizon) in the direction nearest to each soldier, at most half a trace step to the side of
 * his own line; the heightmap's resolution is one meter. A caller that must not block the page computes
 * the rows in several calls, each one given the result of the previous (`firstRow` = its `nextRow`) and a
 * `deadline`.
 * @param {function(number, number): number} heightAt - height at (east, north) meters from the impact
 * @param {object} explosion - see impactDamage
 * @param {number} cell - grid step in meters
 * @param {object} [progress] - the result of the previous call, to continue it
 * @param {number} [progress.firstRow=0] - first row to compute
 * @param {number} [progress.deadline] - `performance.now()` after which no new row is started
 * @param {{impactZ: number, blocked: function(number, number, number, number, number, number): boolean}} [objects] -
 *   the objects of the volume layer on top of `heightAt` (the landscape): `impactZ` is the height the round lands
 *   at, in the heights of `heightAt` (the landscape, a roof or the floor the target is on), and
 *   `blocked(east0, north0, z0, east1, north1, z1)` whether the segment meets an object; it is asked, between the
 *   same clearances as the heightmap trace, for the soldiers the landscape does not cover
 * @returns {{damage: Float32Array, exposed: Float32Array, size: number, cell: number, nextRow: number, sweep: object}} -
 *   damage with and without cover, row-major, row 0 is the northernmost; the impact is in the middle cell;
 *   nextRow is the first row not computed yet, `size` when the field is complete
 */
export function damageField(heightAt, explosion, cell, progress = {}, objects = null) {
    const radius = Math.ceil(explosion.outer / cell);
    const size = 2 * radius + 1;
    const damage = progress.damage ?? new Float32Array(size * size);
    const exposed = progress.exposed ?? new Float32Array(size * size);
    const deadline = progress.deadline ?? Infinity;
    const explosionZ = (objects?.impactZ ?? heightAt(0, 0)) + explosion.distanceFromImpact;

    // Directions a trace step apart at the outer radius
    const rays = Math.max(8, Math.ceil((2 * Math.PI * explosion.outer) / TRACE_STEP));
    const sweep = progress.sweep ?? sweepHorizon(heightAt, explosionZ, explosion.outer, rays);

    let row = progress.firstRow ?? 0;
    for (; row < size && !(performance.now() >= deadline); row++) {
        const north = (radius - row) * cell;
        for (let col = 0; col < size; col++) {
            const east = (col - radius) * cell;
            const length = Math.hypot(east, north);
            if (length > explosion.outer) continue;

            const feet = heightAt(east, north);
            const value = damageAtDistance(explosion, Math.hypot(length, explosionZ - (feet + PLAYER_HEIGHT)));
            exposed[row * size + col] = value;
            if (value <= 0) continue;

            // The trace samples are those closer than length - SOLDIER_CLEARANCE
            const lastSample = Math.ceil((length - SOLDIER_CLEARANCE - EXPLOSION_CLEARANCE) / TRACE_STEP) - 1;
            let covered = false;
            if (lastSample >= 0) {
                let heading = Math.atan2(north, east);
                if (heading < 0) heading += 2 * Math.PI;
                const ray = Math.round((heading / (2 * Math.PI)) * rays) % rays;
                covered = sweep.horizon[ray * sweep.samples + Math.min(lastSample, sweep.samples - 1)] > (feet + BODY_CENTER - explosionZ) / length;
                if (!covered && objects) covered = objectsBlock(objects, explosionZ, { east, north, z: feet + BODY_CENTER }, length);
            }
            damage[row * size + col] = covered ? 0 : value;
        }
    }
    return { damage, exposed, size, cell, nextRow: row, sweep };
}


/**
 * Probability that one round kills, or at least wounds, a soldier standing at the aim point.
 * Rounds land inside the spread ellipse SquadCalc draws (SquadFiringSolution.getSpreadParameter: a cone of
 * the weapon's MOA cut by the ground), with the game's distribution: the miss radius is uniform on
 * [0, R] and the direction uniform, so the density is 1/r and rounds crowd at the centre, not spread
 * evenly over the area. The game's FMath::VRandCone takes Phi = fmodf(acosf(2v - 1), h) (h the cone's
 * half-angle, MOA / 120 degrees; Squad build 26005357, SquadGameServer 0x4a13010): acos(2v - 1) is spread over
 * [0, pi] and its remainder by the tiny h is flat, so the angle off the barrel's axis is uniform, and so
 * is the radius on the ground (deadline-squad/deadline-squadcalc#6). On flat ground a circular spread
 * of radius R kills with probability (kill radius / R).
 * @param {function(number, number): number} heightAt - height at (east, north) meters from the aim point
 * @param {object} explosion - see impactDamage
 * @param {number} lateral - semi-axis of the spread across the line of fire, meters
 * @param {number} along - semi-axis of the spread along the line of fire, meters
 * @param {number} bearing - direction of fire, degrees clockwise from north
 * @returns {{kill: number, wound: number}} - probabilities per round, 0 to 1
 */
export function hitProbability(heightAt, explosion, lateral, along, bearing) {
    const soldier = { east: 0, north: 0 };
    const rad = bearing * Math.PI / 180;
    const forward = { east: Math.sin(rad), north: Math.cos(rad) };
    const across = { east: Math.cos(rad), north: -Math.sin(rad) };
    const samples = lateral > 0 || along > 0 ? SPREAD_SAMPLES : 1;
    let kills = 0;
    let wounds = 0;

    for (let i = 0; i < samples; i++) {
        const r = (i + 0.5) / samples;
        const x = r * Math.cos(i * GOLDEN_ANGLE) * lateral;
        const y = r * Math.sin(i * GOLDEN_ANGLE) * along;
        const impact = samples === 1 ? soldier : {
            east: across.east * x + forward.east * y,
            north: across.north * x + forward.north * y,
        };
        const { damage } = impactDamage(heightAt, explosion, impact, soldier);
        if (damage >= KILL_DAMAGE) kills++;
        if (damage >= WOUND_DAMAGE) wounds++;
    }
    return { kill: kills / samples, wound: wounds / samples };
}


/**
 * Rounds to fire so that at least one hits with the given confidence: 1 - (1 - p)^n >= confidence
 * @param {number} probability - per round, 0 to 1
 * @param {number} [confidence=0.9]
 * @returns {number} - rounds, Infinity when a round never hits
 */
export function roundsNeeded(probability, confidence = 0.9) {
    if (probability <= 0) return Infinity;
    if (probability >= 1) return 1;
    return Math.max(1, Math.ceil(Math.log(1 - confidence) / Math.log(1 - probability)));
}
