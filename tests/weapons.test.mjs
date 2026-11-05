import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WEAPONS, WEAPONSTYPE } from "../src/data/weapons.js";

test("weapons are named once and have a known type", () => {
    const names = WEAPONS.map((weapon) => weapon.name);
    assert.equal(new Set(names).size, names.length, "duplicate weapon names");
    for (const weapon of WEAPONS) assert.ok([...WEAPONSTYPE, "modded"].includes(weapon.type), `${weapon.name}: type ${weapon.type}`);
});

test("every property of a weapon entry is passed on by SquadCalc.loadWeapons (else the Weapon drops it)", () => {
    const source = readFileSync(new URL("../src/js/squadCalc.js", import.meta.url), "utf8");
    const loader = source.slice(source.indexOf("loadWeapons()"));
    const passed = new Set([...loader.slice(0, loader.indexOf("// Initiate Weapons")).matchAll(/weapon\.(\w+)/g)].map((match) => match[1]));
    for (const weapon of WEAPONS) {
        for (const key of Object.keys(weapon)) assert.ok(passed.has(key), `${weapon.name}: ${key} is not passed to new Weapon`);
    }
});

test("every weapon has shells with a velocity, a spread and an explosion that make sense", () => {
    for (const weapon of WEAPONS) {
        assert.ok(weapon.shells.length > 0, `${weapon.name}: no shells`);
        for (const shell of weapon.shells) {
            const label = `${weapon.name}/${shell.name}`;
            assert.ok(shell.velocity > 0, `${label}: velocity`);
            assert.ok(shell.moa >= 0, `${label}: moa`);
            assert.ok(shell.minDistance >= 0, `${label}: minDistance`);
            const [inner, outer] = shell.explosionRadius;
            assert.ok(inner >= 0 && inner <= outer, `${label}: explosionRadius ${shell.explosionRadius}`);
            assert.ok(shell.explosionDamage > 0 && shell.damageFallOff >= 0, `${label}: explosion`);
        }
    }
});

test("the elevation range of every weapon is [lowest, highest]", () => {
    for (const weapon of WEAPONS) {
        const [lowest, highest] = weapon.minElevation;
        assert.ok(lowest < highest, `${weapon.name}: minElevation ${weapon.minElevation}`);
    }
});

test("direct-fire weapons are low-arc, and a launch point comes with the launch height of the ground checks", () => {
    for (const weapon of WEAPONS.filter((candidate) => candidate.type === "directFire")) {
        assert.equal(weapon.angleType, "low", `${weapon.name}: angleType`);
        if (!weapon.muzzle) continue;
        const { pivotHeight, forward, up } = weapon.muzzle;
        for (const value of [pivotHeight, forward, up]) assert.ok(Number.isFinite(value), `${weapon.name}: muzzle`);
        assert.equal(weapon.heightOffset, pivotHeight, `${weapon.name}: heightOffset is the pivot height`);
    }
});

// InitialLifeSpan of the projectile, seconds after launch the game destroys it (Squad build 26005357,
// tools/game_ballistics/provenance.py compares every weapon with the game files; these are spot values)
const GAME_LIFESPAN = [
    ["DF_RPG_7_PG_7V_HEAT_OG_7V", 4],
    ["DF_M3_MAAWS_HEAT_Smoke", 4],
    ["DF_SPG_9_HEAT", 8],
    ["DF_NLAW", 12],
    ["DF_M203_M320_GP_25_HK79_SL40", 20],
    ["DF_Tank_AP_M256_Rh120", 8],
    ["DF_Tank_HEAT_HE_M1A1_M1A2_M256", 20],
    ["DF_M242_Bushmaster_25mm_AP", 5],
    ["DF_M2A1_50", 8],
    ["AGS-17", 40],
    ["UB-32", 20],
];

test("a direct-fire weapon carries the lifespan of its projectile, not the default 100 s", () => {
    for (const weapon of WEAPONS.filter((candidate) => candidate.type === "directFire")) {
        assert.ok(weapon.projectileLifespan > 0 && weapon.projectileLifespan <= 40, `${weapon.name}: projectileLifespan ${weapon.projectileLifespan}`);
    }
    for (const [name, seconds] of GAME_LIFESPAN) {
        assert.equal(WEAPONS.find((weapon) => weapon.name === name).projectileLifespan, seconds, name);
    }
});
