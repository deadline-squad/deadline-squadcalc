import { test } from "node:test";
import assert from "node:assert/strict";
import { damageToStructure, shellsToDestroy, findStructure, STRUCTURES, AMMO } from "../src/js/structureDamage.js";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} vs ${expected}`);

// A made-up structure and shell, to check the arithmetic alone
const wall = { maxHealth: 100, damageTypes: { Frag: { modifier: 0.5, direct: 1, indirect: 0.2, directRadial: 0 } } };
const shell = { damageType: "Frag", impactDamage: 40, explosion: { damage: 100, inner: 1, outer: 11, falloff: 1 }, secondary: null };
const secondaryShell = { ...shell, secondary: { damage: 60, inner: 1, outer: 6, falloff: 1, damageType: "Frag" } };

test("direct hit: impact damage times the modifier, and the radial damage times directRadial", () => {
    const hit = damageToStructure(wall, shell, { directHit: true });
    near(hit.impact, 20);
    near(hit.explosion, 0);
    near(hit.damage, 20);
    const radialToo = damageToStructure({ ...wall, damageTypes: { Frag: { ...wall.damageTypes.Frag, directRadial: 1 } } }, shell, { directHit: true });
    near(radialToo.explosion, 50);
});

test("near miss: only the explosion, scaled by the modifier and the indirect multiplier, falling off with distance", () => {
    near(damageToStructure(wall, shell, { distance: 1 }).damage, 100 * 0.5 * 0.2);
    near(damageToStructure(wall, shell, { distance: 6 }).damage, 50 * 0.5 * 0.2);
    near(damageToStructure(wall, shell, { distance: 11 }).damage, 0);
});

test("a damage type the structure does not list does no damage and needs infinitely many shells", () => {
    const other = { ...shell, damageType: "Kinetic" };
    assert.equal(damageToStructure(wall, other, { directHit: true }).damage, 0);
    assert.equal(shellsToDestroy(wall, other, { directHit: true }), Infinity);
});

test("the secondary explosion adds its own damage unless it is switched off", () => {
    near(damageToStructure(wall, secondaryShell, { distance: 1 }).secondary, 60 * 0.5 * 0.2);
    assert.equal(damageToStructure(wall, secondaryShell, { distance: 1, secondary: false }).secondary, 0);
});

test("the secondary explosion uses the modifier of its own damage type", () => {
    const explosive = { ...secondaryShell, secondary: { ...secondaryShell.secondary, damageType: "Explosives" } };
    const both = { maxHealth: 100, damageTypes: { Frag: wall.damageTypes.Frag, Explosives: { modifier: 1, direct: 1, indirect: 1, directRadial: 1 } } };
    near(damageToStructure(both, explosive, { distance: 1 }).secondary, 60);
    assert.equal(damageToStructure(wall, explosive, { distance: 1 }).secondary, 0);
});

test("shells to destroy rounds up", () => {
    assert.equal(shellsToDestroy(wall, shell, { directHit: true }), 5);
    assert.equal(shellsToDestroy({ ...wall, maxHealth: 101 }, shell, { directHit: true }), 6);
});

test("game data: the mortar round (M252 / 2B14 / L16 / Type 63) against the FOB radio and a HAB (build 26005357)", () => {
    const mortar = AMMO.BP_Mortarround4;
    const radio = findStructure("BP_FOBRadio_Woodland");
    const hab = findStructure("US_Hab_Desert");
    assert.equal(radio.maxHealth, 300);
    assert.equal(hab.maxHealth, 500);
    // Fragmentation: 0.1 on the radio, 0.01 on the HAB, for 10 impact + 350 explosion at 0 m;
    // the secondary 250 is BP_Explosives_Damagetype: 0.5 on the radio, 0.1 on the HAB
    near(damageToStructure(radio, mortar, { directHit: true }).damage, (10 + 350) * 0.1 + 250 * 0.5);
    near(damageToStructure(hab, mortar, { directHit: true }).damage, (10 + 350) * 0.01 + 250 * 0.1);
    assert.equal(shellsToDestroy(radio, mortar, { directHit: true }), 2);
    assert.equal(shellsToDestroy(hab, mortar, { directHit: true }), 18);
});

test("game data: a HEAT round hurts a HAB through its direct-hit damage", () => {
    const heat = AMMO.BP_Projectile_125mm_HEAT;
    const hit = damageToStructure(findStructure("US_Hab_Desert"), heat, { directHit: true });
    near(hit.impact, 1900 * 0.031579);
    assert.equal(shellsToDestroy(findStructure("US_Hab_Desert"), heat, { directHit: true }), 8);
});

test("data invariants: positive health, known classes, every ammunition damage type is one of the structures'", () => {
    const structureTypes = new Set(Object.values(STRUCTURES).flatMap((s) => Object.keys(s.damageTypes)));
    for (const [id, structure] of Object.entries(STRUCTURES)) {
        assert.ok(structure.maxHealth > 0, id);
        assert.ok(structure.classes.includes(id), id);
        assert.equal(findStructure(id), structure);
    }
    for (const [id, ammo] of Object.entries(AMMO)) {
        assert.ok(ammo.weapons.length > 0, id);
        assert.ok(ammo.damageType === null || structureTypes.has(ammo.damageType), `${id}: ${ammo.damageType}`);
    }
    assert.equal(findStructure("NoSuchClass"), undefined);
});

test("game data: armour-piercing and machine-gun rounds have no explosion and do no structure damage here", () => {
    for (const id of ["BP_Projectile_120mm_AP", "BP_Projectile_30mm_AP", "BP_Projectile_50cal"]) {
        assert.equal(AMMO[id].explosion, null, id);
        assert.equal(damageToStructure(findStructure("US_Hab_Desert"), AMMO[id], { directHit: true }).damage, 0, id);
    }
});
