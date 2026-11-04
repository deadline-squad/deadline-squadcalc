/**
 * Damage of shells to the structures players build (FOB radio, HAB, HESCO, sandbags, bunkers, emplacements...).
 *
 * The numbers are the game's (src/data/structureDamage.js, Squad build 26005357): every deployable has a
 * health (MaxHealth) and a table of the damage types that hurt it (AllowableDamageTypes), each with a
 * `modifier`; every projectile has the damage type it applies, a direct-hit damage and an explosion
 * (mortars, the Hell Cannon and the BM-21 also a secondary explosion with a damage type of its own). The way the game combines them is native code, not in the game files,
 * so the model below is inferred from the field names and documented in
 * tools/volumetric/docs/structure-damage.md (labels INFERRED / UNVERIFIED):
 *
 *   direct hit  : impactDamage * modifier * direct  +  explosion(distance) * modifier * directRadial
 *   near miss   :                                      explosion(distance) * modifier * indirect
 *
 * The secondary explosion is one more radial term with the modifier of its own damage type (the mortar
 * rounds' is BP_Explosives_Damagetype, whose modifier on a HESCO is 25 times the fragmentation one).
 *
 * with the same radial falloff as the soldiers' damage (squadDamage.js damageAtDistance). A damage type
 * the structure does not list does no damage. Not modelled: repair, build state, the structure's mesh
 * (the distance is to wherever the game measures it), armour or cover.
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
 * Damage one shell does to a structure
 * @param {{maxHealth: number, damageTypes: Object}} structure - an entry of STRUCTURES
 * @param {{damageType: string, impactDamage: number, explosion: (Object|null), secondary: (Object|null)}} ammo - an entry of AMMO
 * @param {{directHit: boolean, distance: number, secondary: boolean}} [options] - `directHit`: the shell
 *   hits this structure (default false); `distance`: meters from the explosion to the structure for the
 *   radial damage (default 0); `secondary`: count the secondary explosion of the shell (default true)
 * @returns {{damage: number, impact: number, explosion: number, secondary: number}} - health taken, by part;
 *   a part is zero when the structure does not list its damage type
 */
export function damageToStructure(structure, ammo, { directHit = false, distance = 0, secondary = true } = {}) {
    const radial = (type) => (directHit ? type.directRadial : type.indirect);
    const type = structure.damageTypes[ammo.damageType];
    const impact = type && directHit ? ammo.impactDamage * type.modifier * type.direct : 0;
    const explosion = type && ammo.explosion ? damageAtDistance(ammo.explosion, distance) * type.modifier * radial(type) : 0;
    const secondaryType = ammo.secondary && secondary ? structure.damageTypes[ammo.secondary.damageType] : undefined;
    const secondaryDamage = secondaryType ? damageAtDistance(ammo.secondary, distance) * secondaryType.modifier * radial(secondaryType) : 0;
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
 * destroy it from full health with the model above (INFERRED combination, see the header). One shell per count, each
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
