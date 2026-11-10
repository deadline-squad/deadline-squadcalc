/**
 * Shared setup of the tests: a weapon of weapons.js built the way SquadCalc.loadWeapons does, loaded with
 * one of its shells, and the firing solution to a target on flat ground.
 */
import { App } from "./stubs/app.mjs";
import { WEAPONS } from "../src/data/weapons.js";
import { Weapon } from "../src/js/squadWeapons.js";
import SquadFiringSolution from "../src/js/squadFiringSolution.js";

/** Heights of flat ground, for impactDamage and hitProbability */
export const flat = () => 0;

/**
 * @param {string} name - `name` of the entry in weapons.js
 * @param {number} [shellIndex=0]
 * @returns {{weapon: Weapon, shell: object}} - the weapon with the shell's velocity, spread and minimum distance
 */
export function loadWeapon(name, shellIndex = 0) {
    const entry = WEAPONS.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`no weapon ${name} in weapons.js`);
    const weapon = new Weapon(entry.name, entry.deceleration, entry.decelerationTime, entry.gravityScale, entry.minElevation, entry.unit, entry.logo, entry.marker, entry.type, entry.angleType, entry.elevationPrecision, entry.shells, entry.heightOffset, entry.angleOffset, entry.projectileLifespan, entry.mod, entry.elevationRate, entry.heatmap, entry.acceleration, entry.accelerationTime, entry.holdElevation, entry.ballistics, entry.image, entry.muzzle, entry.maxSpeed, entry.rotationFollowsVelocity, entry.legacyBallistics, entry.ballisticsViews);
    const shell = entry.shells[shellIndex];
    weapon.velocity = shell.velocity;
    weapon.moa = shell.moa;
    weapon.minDistance = shell.minDistance;
    weapon.decelerationDistance = 0;
    return { weapon, shell };
}

/**
 * Firing solution of a weapon to a target on flat ground, `distance` meters east of it (selects the weapon as
 * the active one)
 * @param {string} name - `name` of the entry in weapons.js
 * @param {number} distance - meters
 * @param {number} [shellIndex=0]
 * @returns {{weapon: Weapon, shell: object, solution: SquadFiringSolution}}
 */
export function solve(name, distance, shellIndex = 0) {
    const { weapon, shell } = loadWeapon(name, shellIndex);
    App.activeWeapon = weapon;
    const map = {
        mapToGameScale: 1,
        mapToGameScaleY: 1,
        toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
        heightmap: { jsonPng: [[0]], getHeight: () => 0 },
    };
    const solution = new SquadFiringSolution({ lat: 0, lng: 0 }, { lat: 0, lng: distance }, map, 0);
    return { weapon, shell, solution };
}
