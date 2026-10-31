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
