import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WEAPONS, WEAPONSTYPE } from "../src/data/weapons.js";
import { heightAt, maxRange } from "../src/js/squadBallistics.js";
import { loadWeapon } from "./helpers.mjs";

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

test("a Squad Ballistics name (current, of another view, from before a rename) belongs to one weapon only", () => {
    const owners = new Map();
    for (const weapon of WEAPONS) {
        const views = weapon.ballisticsViews ?? [];
        const legacy = weapon.legacyBallistics ?? [];
        const renamedViews = Object.keys(weapon.legacyBallisticsViews ?? {});
        if (views.length || legacy.length) assert.ok(weapon.ballistics, `${weapon.name}: views or old names without a ballistics name`);
        for (const name of [weapon.ballistics, ...views, ...legacy, ...renamedViews]) {
            if (name === undefined) continue;
            assert.ok(typeof name === "string" && name.length > 0, `${weapon.name}: name ${name}`);
            assert.ok(!owners.has(name), `${name}: named by ${owners.get(name)} and by ${weapon.name}`);
            owners.set(name, weapon.name);
        }
    }
});

test("the old name of a view stands for a view of the same weapon", () => {
    for (const weapon of WEAPONS) {
        for (const [old, view] of Object.entries(weapon.legacyBallisticsViews ?? {})) {
            assert.ok(weapon.ballisticsViews?.includes(view), `${weapon.name}: ${old} stands for ${view}, which is not one of its views`);
        }
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


// Pitch range of the mount of each artillery weapon and what the game adds to it for the angle the gunner reads
// (Squad build 26005357, the cooked Blueprints, skeletons and sight widgets of the dedicated server):
//   - Mortar: PitchInterval of BP_GenericDeployableMortarVehicle; UMG_MortarControl turns the elevation wheel by
//     the tube pitch + 45.
//   - UB-32: PitchInterval of BP_GenericDeployableTripodVehicle, which BP_EmplacedUB32_Tripod keeps; the display
//     (Emplaced_UB-32_GunnerAngleDisplay) shows the mount's pitch.
//   - HellCannon: PitchInterval of BP_Emplaced_HellCannon_Base; UMG_HellCannon_HUD shows the mount's pitch + 40.
//   - Tech.Mortar: PitchInterval of BP_Technical_MortarTurret; UMG_MortarHUD_Technical shows the mount's pitch + 40.
//   - Tech.UB-32: PitchInterval of BP_Technical_Turret_UB32; UB-32_GunnerAngleDisplay shows the mount's pitch.
//   - BM-21Grad: PitchInterval of PitchMovement in BP_BM21Grad_Turret_INS; the rail rests 14.2 degrees up (socket
//     Attach_Muzzle on the bone pitch_swivel of SKEL_BM21_Launcher) and BM21_GunnerReticle shows the socket's pitch.
//   - M1064M121: PitchInterval of BP_M1064A3_MortarTurret on a tube that rests at 50 degrees.
//   - BTR4-AGS: PitchInterval of BP_BMP1TS_Turret (the parent of BP_BTR4_Turret); BTR4_GunnerReticle shows the
//     pitch of the sight camera on the hull, and the camera (FirstPersonCamera) sits 0.1 degree above the turret.
const GAME_MOUNTS = [
    ["Mortar", [0, 43.8], 45],
    ["UB-32", [-25, 35], 0],
    ["HellCannon", [-30, 50], 40],
    ["Tech.Mortar", [0, 43.8], 40],
    ["Tech.UB-32", [0, 50], 0],
    ["BM-21Grad", [0, 40.8], 14.2],
    ["M1064M121", [0, 35], 50],
    ["BTR4-AGS", [-5, 45], 0.1],
];

test("the elevation range of an artillery weapon is the pitch range of its mount in the game plus the sight's offset", () => {
    for (const [name, [lowest, highest], offset] of GAME_MOUNTS) {
        const [low, high] = WEAPONS.find((weapon) => weapon.name === name).minElevation;
        assert.ok(Math.abs(low - (lowest + offset)) < 1e-9, `${name}: lowest elevation ${low}, the game's ${lowest + offset}`);
        assert.ok(Math.abs(high - (highest + offset)) < 1e-9, `${name}: highest elevation ${high}, the game's ${highest + offset}`);
    }
});

/**
 * Where a shot fired at `degrees` comes down on level ground
 * @param {import("../src/js/squadBallistics.js").Shot} shot
 * @param {number} degrees - elevation of the barrel
 * @returns {number} - meters from the weapon
 */
function levelRange(shot, degrees) {
    const angle = degrees * Math.PI / 180;
    let near = 0;
    let far = maxRange(shot) * 1.001;
    for (let i = 0; i < 60; i++) {
        const middle = (near + far) / 2;
        if (heightAt(shot, angle, middle) > 0) near = middle;
        else far = middle;
    }
    return near;
}

// Weapons that cannot be laid on every angle of their arc: a mortar's tube stops below the vertical, a rocket
// launcher's rail above the horizontal. Nearer than the shot at that stop, level ground cannot be hit.
const LIMITED_BY_MOUNT = ["Mortar", "Tech.Mortar", "M1064M121", "BM-21Grad", "Tech.UB-32"];

test("the minimum distance of a weapon stopped by its mount is the range on level ground at that stop", () => {
    for (const name of LIMITED_BY_MOUNT) {
        const entry = WEAPONS.find((weapon) => weapon.name === name);
        const stop = (entry.angleType === "high" ? entry.minElevation[1] : entry.minElevation[0]) + (entry.angleOffset || 0);
        for (let i = 0; i < entry.shells.length; i++) {
            const { weapon, shell } = loadWeapon(name, i);
            const range = levelRange(weapon.getShot(9.8 * entry.gravityScale), stop);
            assert.ok(Math.abs(shell.minDistance - range) <= 0.05, `${name}/${shell.name}: minDistance ${shell.minDistance}, ${range.toFixed(2)} m at ${stop} degrees`);
        }
    }
});

test("the range circle of a mortar or hell cannon marker is the longest shot of that weapon on level ground", () => {
    const source = readFileSync(new URL("../src/js/squadMinimap.js", import.meta.url), "utf8");
    for (const [icon, name] of [["deployable_mortars", "Mortar"], ["deployable_hellcannon", "HellCannon"]]) {
        const range = Number(source.match(new RegExp(`icon === "${icon}"\\) range = (\\d+);`))[1]);
        const { weapon } = loadWeapon(name);
        assert.equal(range, Math.round(maxRange(weapon.getShot(9.8))), `${icon}: ${range} m`);
    }
});
