import { test } from "node:test";
import assert from "node:assert/strict";
import { damageToStructure, shellsToDestroy, findStructure, structureOutcome, DIRECT_HIT_RADIUS, STRUCTURES, AMMO } from "../src/js/structureDamage.js";
import { SHELL_AMMO, MARKER_STRUCTURES } from "../src/data/structureLinks.js";
import { WEAPONS } from "../src/data/weapons.js";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ""} ${actual} vs ${expected}`);

// A made-up structure and shell, to check the arithmetic alone. Each case is a rule read from the server binary
// (tools/volumetric/docs/native-rules.md, ASQDeployable::TakeDamage and the engine's radial damage)
const wall = { maxHealth: 100, damageTypes: { Frag: { modifier: 0.5, direct: 1, indirect: 0.2 } } };
const shell = { damageType: "Frag", impactDamage: 40, explosion: { damage: 100, minimum: 0, inner: 1, outer: 11, falloff: 1, distanceFromImpact: 0 }, secondary: null };
const secondaryShell = { ...shell, secondary: { damage: 60, minimum: 0, inner: 1, outer: 6, falloff: 1, distanceFromImpact: 0, damageType: "Frag" } };
const withExplosion = (explosion) => ({ ...shell, explosion: { ...shell.explosion, ...explosion } });

test("direct hit: the impact is amount times modifier with no hit multiplier, the radial part uses the direct multiplier, not the direct-radial one", () => {
    const hit = damageToStructure(wall, shell, { directHit: true });
    near(hit.impact, 20);
    near(hit.explosion, 100 * 0.5 * 1);
    near(hit.damage, 70);
    const doubled = { ...wall, damageTypes: { Frag: { ...wall.damageTypes.Frag, direct: 2, directRadial: 0 } } };
    near(damageToStructure(doubled, shell, { directHit: true }).impact, 20);
    near(damageToStructure(doubled, shell, { directHit: true }).explosion, 100);
});

test("direct hit: a type whose directRadial multiplier is 0 (the ammunition crate) still takes the full radial damage", () => {
    const crate = findStructure("BP_Ammocrate");
    assert.equal(crate.damageTypes.BP_BasicHeatDamageType.directRadial, undefined);
    const heat = AMMO.BP_Projectile_125mm_HEAT;
    near(damageToStructure(crate, heat, { directHit: true }).explosion, 200 * 1 * 1);
});

test("near miss: only the explosion, scaled by the modifier and the indirect multiplier, falling off with distance", () => {
    near(damageToStructure(wall, shell, { distance: 1 }).damage, 100 * 0.5 * 0.2);
    near(damageToStructure(wall, shell, { distance: 6 }).damage, 50 * 0.5 * 0.2);
    near(damageToStructure(wall, shell, { distance: 11 }).damage, 0);
});

test("near miss: a type that passes damage only on a direct hit does nothing to a near miss, and the impact is not counted", () => {
    const strict = { maxHealth: 100, damageTypes: { Frag: { ...wall.damageTypes.Frag, onlyDirect: true } } };
    assert.equal(damageToStructure(strict, shell, { distance: 1 }).damage, 0);
    assert.equal(shellsToDestroy(strict, shell, { distance: 1 }), Infinity);
    near(damageToStructure(strict, shell, { directHit: true }).damage, 20 + 50);
});

test("minimum damage is a floor the modifier does not scale: it applies inside the outer radius, even where the modified damage is smaller", () => {
    const heat = withExplosion({ damage: 200, minimum: 35, inner: 3.5, outer: 16, falloff: 2 });
    const hesco = { maxHealth: 200, damageTypes: { Frag: { modifier: 0.01, direct: 1, indirect: 1 } } };
    near(damageToStructure(hesco, heat, { directHit: true }).explosion, 2);
    near(damageToStructure(hesco, heat, { distance: 10 }).explosion, 35 + (2 - 35) * Math.pow(1 - 6.5 / 12.5, 2));
    near(damageToStructure(hesco, heat, { distance: 15.9 }).explosion, 35 + (2 - 35) * Math.pow(1 - 12.4 / 12.5, 2));
    assert.equal(damageToStructure(hesco, heat, { distance: 16 }).explosion, 0, "beyond the outer radius the structure is not in the burst at all");
});

test("the burst origin is distanceFromImpact off the surface: a direct hit is that far from the structure, a near miss is measured from it", () => {
    const high = withExplosion({ inner: 0, outer: 11, falloff: 1, distanceFromImpact: 1 });
    near(damageToStructure(wall, high, { directHit: true }).explosion, 100 * 0.5 * (1 - 1 / 11));
    near(damageToStructure(wall, high, { distance: 3 }).explosion, 100 * 0.5 * 0.2 * (1 - Math.hypot(3, 1) / 11));
    assert.equal(damageToStructure(wall, high, { distance: 10.97 }).explosion, 0, "hypot(10.97, 1) is beyond the outer radius");
});

test("a damage type the structure does not list does no damage and needs infinitely many shells", () => {
    const other = { ...shell, damageType: "Kinetic" };
    assert.equal(damageToStructure(wall, other, { directHit: true }).damage, 0);
    assert.equal(shellsToDestroy(wall, other, { directHit: true }), Infinity);
});

test("damage types match by exact class: a name that only extends a listed one is not listed", () => {
    for (const name of ["Frag_C", "BP_Frag", "frag", "Fra"]) {
        assert.equal(damageToStructure(wall, { ...shell, damageType: name }, { directHit: true }).damage, 0, name);
    }
});

test("the secondary explosion adds its own damage unless it is switched off", () => {
    near(damageToStructure(wall, secondaryShell, { distance: 1 }).secondary, 60 * 0.5 * 0.2);
    assert.equal(damageToStructure(wall, secondaryShell, { distance: 1, secondary: false }).secondary, 0);
});

test("the secondary explosion uses the modifier of its own damage type, its own minimum and the only-direct rule", () => {
    const explosive = { ...secondaryShell, secondary: { ...secondaryShell.secondary, damageType: "Explosives" } };
    const both = { maxHealth: 100, damageTypes: { Frag: wall.damageTypes.Frag, Explosives: { modifier: 1, direct: 1, indirect: 1 } } };
    near(damageToStructure(both, explosive, { distance: 1 }).secondary, 60);
    assert.equal(damageToStructure(wall, explosive, { distance: 1 }).secondary, 0);
    const floored = { ...secondaryShell, secondary: { ...secondaryShell.secondary, minimum: 5 } };
    near(damageToStructure(wall, floored, { distance: 5.5 }).secondary, 5 + (60 * 0.5 * 0.2 - 5) * 0.1);
    const strict = { maxHealth: 100, damageTypes: { Frag: { ...wall.damageTypes.Frag, onlyDirect: true } } };
    assert.equal(damageToStructure(strict, secondaryShell, { distance: 1 }).secondary, 0);
});

test("shells to destroy rounds up", () => {
    assert.equal(shellsToDestroy(wall, shell, { directHit: true }), 2);
    assert.equal(shellsToDestroy(wall, { ...shell, explosion: null }, { directHit: true }), 5);
    assert.equal(shellsToDestroy({ ...wall, maxHealth: 101 }, { ...shell, explosion: null }, { directHit: true }), 6);
});

test("game data: the mortar round (M252 / 2B14 / L16 / Type 63) against the FOB radio and a HAB (build 26005357)", () => {
    const mortar = AMMO.BP_Mortarround4;
    const radio = findStructure("BP_FOBRadio_Woodland");
    const hab = findStructure("US_Hab_Desert");
    assert.equal(radio.maxHealth, 300);
    assert.equal(hab.maxHealth, 500);
    // Fragmentation: 0.1 on the radio, 0.01 on the HAB; the secondary 250 is BP_Explosives_Damagetype: 0.5 on the
    // radio, 0.1 on the HAB. The impact is 10 * modifier; the bursts are 1 m (primary) and 0.5 m (secondary, inside its 1 m inner radius) off the surface
    const primary = (1 - 1 / 40) ** 7;
    near(damageToStructure(radio, mortar, { directHit: true }).damage, 10 * 0.1 + 350 * 0.1 * primary + 250 * 0.5 );
    near(damageToStructure(hab, mortar, { directHit: true }).damage, 10 * 0.01 + 350 * 0.01 * primary + 250 * 0.1 );
    assert.equal(shellsToDestroy(radio, mortar, { directHit: true }), 2);
    assert.equal(shellsToDestroy(hab, mortar, { directHit: true }), 18);
});

test("game data: a 125 mm HEAT round hurts a HAB through its direct-hit damage; near a HESCO barrier its minimum damage dominates", () => {
    const heat = AMMO.BP_Projectile_125mm_HEAT;
    const hab = findStructure("US_Hab_Desert");
    near(damageToStructure(hab, heat, { directHit: true }).impact, 1900 * 0.031579);
    assert.equal(shellsToDestroy(hab, heat, { directHit: true }), 8);
    const hesco = findStructure("BP_Hesco_USA_Desert");
    near(damageToStructure(hesco, heat, { directHit: true }).explosion, 2);
    // docs/native-rules.md 1.2: about 27 at 10 m
    assert.equal(damageToStructure(hesco, heat, { distance: 10 }).explosion.toFixed(1), "27.4");
});

test("data invariants: positive health, known classes, every ammunition damage type is one of the structures', no direct-radial field", () => {
    const structureTypes = new Set(Object.values(STRUCTURES).flatMap((s) => Object.keys(s.damageTypes)));
    for (const [id, structure] of Object.entries(STRUCTURES)) {
        assert.ok(structure.maxHealth > 0, id);
        assert.ok(structure.classes.includes(id), id);
        assert.equal(findStructure(id), structure);
        for (const type of Object.values(structure.damageTypes)) assert.equal("directRadial" in type, false, id);
    }
    for (const [id, ammo] of Object.entries(AMMO)) {
        assert.ok(ammo.weapons.length > 0, id);
        assert.ok(ammo.damageType === null || structureTypes.has(ammo.damageType), `${id}: ${ammo.damageType}`);
        for (const explosion of [ammo.explosion, ammo.secondary]) assert.ok(!explosion || explosion.minimum >= 0, id);
    }
    assert.equal(findStructure("NoSuchClass"), undefined);
});

test("game data: ExplosiveMinimumDamage is set for the ten projectiles of docs/native-rules.md section 5", () => {
    const withMinimum = Object.entries(AMMO).filter(([, ammo]) => ammo.explosion?.minimum > 0).map(([id, ammo]) => `${id}=${ammo.explosion.minimum}`).sort();
    assert.equal(withMinimum.length, 10);
    assert.ok(withMinimum.includes("BP_Projectile_125mm_HEAT=35"));
    assert.ok(withMinimum.includes("BP_Projectile_Hell_Cannon=1"));
});

test("game data: armour-piercing and machine-gun rounds have no explosion and do no structure damage here", () => {
    for (const id of ["BP_Projectile_120mm_AP", "BP_Projectile_30mm_AP", "BP_Projectile_50cal"]) {
        assert.equal(AMMO[id].explosion, null, id);
        assert.equal(damageToStructure(findStructure("US_Hab_Desert"), AMMO[id], { directHit: true }).damage, 0, id);
    }
});

const near2 = (actual, expected) => Math.abs(actual - expected) < 1e-9;
const activeWeapon = (name, shellName) => {
    const shell = WEAPONS.find((weapon) => weapon.name === name).shells.find((candidate) => candidate.name === shellName);
    return { name, shellName, explosion: { outer: shell.explosionRadius[1] } };
};

test("structureOutcome: the mortar round needs 2 shells for the FOB radio and 18 for a HAB (the C7 table)", () => {
    const mortar = activeWeapon("Mortar", "default");
    const radio = structureOutcome(MARKER_STRUCTURES.deployable_fob, mortar);
    assert.equal(radio.status, "shells");
    assert.equal(radio.shells, 2);
    assert.equal(radio.structure.maxHealth, 300);
    assert.equal(structureOutcome(MARKER_STRUCTURES.deployable_hab, mortar).shells, 18);
});

test("structureOutcome: a burst farther than DIRECT_HIT_RADIUS is a near miss and needs more shells", () => {
    const mortar = activeWeapon("Mortar", "default");
    const direct = structureOutcome(MARKER_STRUCTURES.deployable_hab, mortar, DIRECT_HIT_RADIUS);
    const near = structureOutcome(MARKER_STRUCTURES.deployable_hab, mortar, DIRECT_HIT_RADIUS + 2);
    assert.ok(near.shells > direct.shells, `${near.shells} vs ${direct.shells}`);
});

test("structureOutcome: shells that do not explode (AP, machine guns) do no structure damage", () => {
    const tank = activeWeapon("DF_Tank_AP_M256_Rh120", "default");
    const gun = activeWeapon("DF_M2A1_50", "default");
    for (const weapon of [tank, gun]) {
        assert.deepEqual(Object.keys(structureOutcome(MARKER_STRUCTURES.deployable_fob, weapon)), ["status", "structure"]);
        assert.equal(structureOutcome(MARKER_STRUCTURES.deployable_fob, weapon).status, "none");
    }
});

test("structureOutcome: a weapon or a structure the game data does not cover gives nothing", () => {
    assert.equal(structureOutcome(MARKER_STRUCTURES.deployable_fob, { name: "M109", shellName: "default", explosion: { outer: 75 } }), null);
    assert.equal(structureOutcome("BP_Not_A_Deployable", activeWeapon("Mortar", "default")), null);
});

test("every projectile that does not explode does no damage to any structure, hit or near miss (no penetration is modelled)", () => {
    for (const [name, ammo] of Object.entries(AMMO)) {
        if (ammo.explosion) continue;
        for (const structure of Object.values(STRUCTURES)) {
            assert.equal(damageToStructure(structure, ammo, { directHit: true }).damage, 0, `${name} on ${structure.classes[0]}`);
        }
    }
});

test("SHELL_AMMO: every entry is a shell of weapons.js whose explosion is the projectile's", () => {
    for (const [key, projectile] of Object.entries(SHELL_AMMO)) {
        const [weaponName, shellName] = key.split("/");
        const shell = WEAPONS.find((weapon) => weapon.name === weaponName)?.shells.find((candidate) => candidate.name === shellName);
        assert.ok(shell, `${key} is not in weapons.js`);
        const { explosion } = AMMO[projectile] ?? {};
        assert.ok(explosion, `${key}: ${projectile} has no explosion in the game data`);
        assert.ok(near2(explosion.damage, shell.explosionDamage) && near2(explosion.inner, shell.explosionRadius[0]) && near2(explosion.outer, shell.explosionRadius[1]) && near2(explosion.falloff, shell.damageFallOff), `${key} against ${projectile}`);
    }
});

test("SHELL_AMMO: every shell of weapons.js that explodes and is not listed is one the game data cannot tell from another projectile", () => {
    const listed = new Set(Object.keys(SHELL_AMMO));
    const unlisted = WEAPONS.flatMap((weapon) => weapon.shells.map((shell) => ({ key: `${weapon.name}/${shell.name}`, shell }))).filter(({ key, shell }) => shell.explosionRadius[1] > 0 && !listed.has(key));
    // Howitzers, rocket artillery and modded weapons are not in the game data; the rest are listed here so that a
    // new weapon is noticed
    assert.deepEqual(unlisted.map(({ key }) => key).sort(), [
        "BM-21Grad/default", "DF_C90_CR/default", "DF_DZJ_08/default", "DF_M203_M320_GP_25_HK79_SL40/default", "DF_RPG_28/default",
        "DF_Tank_HEAT_HE_Leopard_2A6_Rh120/default", "DF_Tank_HEAT_HE_M1128_MGS_M68A2/default", "DF_Tank_HEAT_HE_M1A1_M1A2_M256/default",
        "HIMARS/default", "M109/default", "M1064M121/nearSurface", "M777/default", "MO120RTF1/MO-LONG", "MO120RTF1/MO-MEDIUM", "MO120RTF1/MO-SHORT",
        "MTLB_FAB500/default", "PZL07/Air-Burst", "PZL07/High-Explosive", "T62.DUMP.TRUCK/default", "TOS-1A/default", "Ural-HellCannon/default", "type_63/default",
    ].sort());
});

test("MARKER_STRUCTURES: every marker icon names a structure of the game data", () => {
    for (const [icon, className] of Object.entries(MARKER_STRUCTURES)) {
        assert.ok(findStructure(className), `${icon}: ${className}`);
    }
});
