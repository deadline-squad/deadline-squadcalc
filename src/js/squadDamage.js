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

// Impacts sampled over the spread ellipse for the hit probability
const SPREAD_SAMPLES = 400;

// Golden angle: successive samples of a Vogel spiral cover a disk uniformly
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
 * Damage around an impact on a square grid centred on it
 * @param {function(number, number): number} heightAt - height at (east, north) meters from the impact
 * @param {object} explosion - see impactDamage
 * @param {number} cell - grid step in meters
 * @returns {{damage: Float32Array, exposed: Float32Array, size: number, cell: number}} - damage
 *   with and without cover, row-major, row 0 is the northernmost; the impact is in the middle cell
 */
export function damageField(heightAt, explosion, cell) {
    const radius = Math.ceil(explosion.outer / cell);
    const size = 2 * radius + 1;
    const damage = new Float32Array(size * size);
    const exposed = new Float32Array(size * size);
    const impact = { east: 0, north: 0 };

    for (let row = 0; row < size; row++) {
        const north = (radius - row) * cell;
        for (let col = 0; col < size; col++) {
            const east = (col - radius) * cell;
            if (Math.hypot(east, north) > explosion.outer) continue;
            const result = impactDamage(heightAt, explosion, impact, { east, north });
            damage[row * size + col] = result.damage;
            exposed[row * size + col] = result.exposed;
        }
    }
    return { damage, exposed, size, cell };
}


/**
 * Probability that one round kills, or at least wounds, a soldier standing at the aim point.
 * Rounds land uniformly inside the spread ellipse SquadCalc draws (SquadFiringSolution.getSpreadParameter:
 * a cone of the weapon's MOA, uniform like Unreal's VRandCone, cut by the ground).
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
        const r = Math.sqrt((i + 0.5) / samples);
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
