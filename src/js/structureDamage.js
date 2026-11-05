/**
 * Damage of shells to the structures players build (FOB radio, HAB, HESCO, sandbags, bunkers, emplacements...).
 *
 * The numbers are the game's (src/data/structureDamage.js, Squad build 26005357): every deployable has a
 * health (MaxHealth) and a table of the damage types that hurt it (AllowableDamageTypes), each with a
 * `modifier`; every projectile has the damage type it applies, a direct-hit damage and an explosion
 * (mortars, the Hell Cannon and the BM-21 also a secondary explosion with a damage type of its own).
 *
 * The way the game combines them is read from the server binary (ASQDeployable::TakeDamage and the engine's
 * radial damage, tools/volumetric/docs/native-rules.md, labels VERIFIED / INFERRED):
 *
 *   VERIFIED  the damage type is matched by its exact class (a parent class does not count); a type the
 *             structure does not list does nothing
 *   VERIFIED  radial part, a damage event with a burst: loss = Lerp(minimum, damage * modifier * m, scale(d)),
 *             m = `direct` on a direct hit, `indirect` otherwise (0 on a near miss when the type is `onlyDirect`),
 *             scale = the engine's falloff law (squadDamage.js damageAtDistance). `minimum`
 *             (ExplosiveMinimumDamage) is a floor that the modifier does not scale. Nothing is lost beyond the
 *             outer radius. DirectHitRadialDamageMultiplier is not read for deployables (vehicles only)
 *   VERIFIED  point damage (a hit with no burst): loss = amount * modifier, no hit multiplier
 *   VERIFIED  health is clamped to 0..MaxHealth, so shells to destroy = ceil(MaxHealth / loss)
 *   VERIFIED  d is measured from the burst origin, the impact point moved `distanceFromImpact` along the
 *             impact normal, to the structure's surface. A direct hit: the origin is that far off the struck
 *             surface, d = distanceFromImpact. A near miss on level ground: the normal is vertical, so
 *             d = hypot(distance on the ground, distanceFromImpact), taking the structure at ground level
 *   INFERRED  the direct hit's impact damage (ImpactDamageToApply) is point damage of the projectile's damage
 *             type, and the mortar-family secondary explosion is one more radial event with the modifier of its
 *             own damage type: both are Blueprint bytecode that the binary does not show
 *
 * Not modelled: repair, build state, the structure's mesh (the distance is to the structure's centre as
 * given), cover between the burst and the structure.
 *
 * Pure functions (no map, no DOM).
 */
import { damageAtDistance } from "./squadDamage.js";
import { STRUCTURES, AMMO } from "../data/structureDamage.js";
import { SHELL_AMMO } from "../data/structureLinks.js";

/** A shell that bursts within this many meters of a structure counts as a direct hit on it, meters */
export const DIRECT_HIT_RADIUS = 1;

/**
 * The structure entry that has a deployable class
 * @param {string} className - Blueprint class name, e.g. "BP_Hesco_USA_Desert" or "US_Hab_Desert"
 * @returns {{classes: string[], maxHealth: number, damageTypes: Object}|undefined} - the entry, or undefined
 */
export function findStructure(className) {
    return Object.values(STRUCTURES).find((structure) => structure.classes.includes(className));
}

/**
 * Health one explosion takes from a structure through one damage type (ASQDeployable::TakeDamage with a radial
 * event, then the engine's InternalTakeRadialDamage)
 * @param {{modifier: number, direct: number, indirect: number, onlyDirect: (boolean|undefined)}} type - the structure's entry for the damage type
 * @param {{damage: number, minimum: number, inner: number, outer: number, falloff: number, distanceFromImpact: number}} explosion - the explosion
 * @param {boolean} directHit - the explosion's projectile struck this structure
 * @param {number} distance - meters on the ground from the burst to the structure
 * @returns {number} - health lost
 */
function radialLoss(type, explosion, directHit, distance) {
    if (!directHit && type.onlyDirect) return 0;
    const reach = directHit ? explosion.distanceFromImpact : Math.hypot(distance, explosion.distanceFromImpact);
    // Known deviation (tools/volumetric/docs/structure-damage.md section 4): the engine returns Lerp(Min, Damage, 0) = Min at or
    // beyond the outer radius for a structure that is in the burst, which the game decides on the box distance while
    // `reach` is the distance to the ground point; the model counts nothing there
    if (reach >= explosion.outer) return 0;
    const scale = damageAtDistance({ ...explosion, damage: 1 }, reach);
    const modified = explosion.damage * type.modifier * (directHit ? type.direct : type.indirect);
    return explosion.minimum + (modified - explosion.minimum) * scale;
}

/**
 * Damage one shell does to a structure
 * @param {{maxHealth: number, damageTypes: Object}} structure - an entry of STRUCTURES
 * @param {{damageType: string, impactDamage: number, explosion: (Object|null), secondary: (Object|null)}} ammo - an entry of AMMO
 * @param {{directHit: boolean, distance: number, secondary: boolean}} [options] - `directHit`: the shell
 *   hits this structure (default false); `distance`: meters on the ground from the burst to the structure for a near miss
 *   (default 0; unused on a direct hit); `secondary`: count the secondary explosion of the shell (default true)
 * @returns {{damage: number, impact: number, explosion: number, secondary: number}} - health taken, by part;
 *   a part is zero when the structure does not list its damage type
 */
export function damageToStructure(structure, ammo, { directHit = false, distance = 0, secondary = true } = {}) {
    const type = structure.damageTypes[ammo.damageType];
    const impact = type && directHit ? ammo.impactDamage * type.modifier : 0;
    const explosion = type && ammo.explosion ? radialLoss(type, ammo.explosion, directHit, distance) : 0;
    const secondaryType = ammo.secondary && secondary ? structure.damageTypes[ammo.secondary.damageType] : undefined;
    const secondaryDamage = secondaryType ? radialLoss(secondaryType, ammo.secondary, directHit, distance) : 0;
    return { damage: impact + explosion + secondaryDamage, impact, explosion, secondary: secondaryDamage };
}

/**
 * Shells needed to destroy a structure from full health
 * @param {{maxHealth: number, damageTypes: Object}} structure - an entry of STRUCTURES
 * @param {Object} ammo - an entry of AMMO
 * @param {{directHit: boolean, distance: number, secondary: boolean}} [options] - as damageToStructure
 * @returns {number} - whole shells, Infinity when one shell does no damage
 */
export function shellsToDestroy(structure, ammo, options) {
    const { damage } = damageToStructure(structure, ammo, options);
    return damage > 0 ? Math.ceil(structure.maxHealth / damage - 1e-9) : Infinity;
}

/**
 * What the selected weapon and shell do to a structure, for the target dialog and the marker popups: shells to
 * destroy it from full health with the model above (the radial part is read from the game's code, the impact and secondary parts are inferred: see the header). One shell per count, each
 * landing where aimed: the spread is not part of it.
 * @param {string} className - Blueprint class of the structure (a value of MARKER_STRUCTURES)
 * @param {{name: string, shellName: string, explosion: {outer: number}}} weapon - the active weapon (weapons.js
 *   `name`, the selected shell's `name`) with the raw explosion of that shell (squadWeapons.changeShell)
 * @param {number} [distance=0] - meters from the burst to the structure; a direct hit up to DIRECT_HIT_RADIUS
 * @returns {{status: "shells", shells: number, structure: object, ammo: object}|{status: "none", structure: object}|null}
 *   `shells` is the count; `none` when the shell does no damage to the structure (it does not explode: AP and
 *   machine-gun rounds, or its damage type is not one the structure takes); null when the structure or the shell is
 *   not in the game data (SHELL_AMMO)
 */
export function structureOutcome(className, weapon, distance = 0) {
    const structure = findStructure(className);
    if (!structure) return null;
    if (!(weapon.explosion?.outer > 0)) return { status: "none", structure };
    const ammo = AMMO[SHELL_AMMO[`${weapon.name}/${weapon.shellName}`]];
    if (!ammo) return null;
    const shells = shellsToDestroy(structure, ammo, { directHit: distance <= DIRECT_HIT_RADIUS, distance });
    return Number.isFinite(shells) ? { status: "shells", shells, structure, ammo } : { status: "none", structure };
}

export { STRUCTURES, AMMO };
