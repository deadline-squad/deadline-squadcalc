import { test } from "node:test";
import assert from "node:assert/strict";
import { heightAt, launchPoint, solveElevation, maxRange, isParabola } from "../src/js/squadBallistics.js";
import { WEAPONS } from "../src/data/weapons.js";
import SquadFiringSolution from "../src/js/squadFiringSolution.js";
import { App } from "./stubs/app.mjs";
import { loadWeapon, solve } from "./helpers.mjs";

const GRAVITY = 9.8;
const parabola = { velocity: 100, gravity: GRAVITY, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: true, pivotHeight: 0, muzzleForward: 0, muzzleUp: 0 };

test("plain parabola: the low and high elevations are the textbook roots", () => {
    const distance = 500;
    const { low, high } = solveElevation(parabola, distance, 0);
    const lowExpected = 0.5 * Math.asin(GRAVITY * distance / parabola.velocity ** 2);
    assert.ok(isParabola(parabola));
    assert.ok(Math.abs(low - lowExpected) < 1e-9, `${low} vs ${lowExpected}`);
    assert.ok(Math.abs(high - (Math.PI / 2 - lowExpected)) < 1e-9);
});

test("plain parabola: a target beyond the maximum range has no elevation", () => {
    const { low, high } = solveElevation(parabola, maxRange(parabola) + 1, 0);
    assert.ok(Number.isNaN(low) && Number.isNaN(high));
});

test("plain parabola: the maximum range is v² / g, at 45 degrees", () => {
    assert.ok(Math.abs(maxRange(parabola) - parabola.velocity ** 2 / GRAVITY) < 0.01);
});

test("a higher target needs a higher elevation, a lower one a lower elevation", () => {
    const flatRoot = solveElevation(parabola, 400, 0).low;
    assert.ok(solveElevation(parabola, 400, 30).low > flatRoot);
    assert.ok(solveElevation(parabola, 400, -30).low < flatRoot);
});

// Every kind of shot of weapons.js: the root the solver returns puts the flight on the target
const SHOTS = [
    ["a mortar", "Mortar", 0],
    ["a grenade launcher", "DF_M203_M320_GP_25_HK79_SL40", 0],
    ["a launch point that moves with the elevation (PARS III MK19)", "DF_MK19_PARS_III_RWS", 0],
    ["a boosted rocket (RPG-7)", "DF_RPG_7_PG_7V_HEAT_OG_7V", 0],
    ["a shell fired above its speed cap (tank HE)", "DF_Tank_HEAT_HE_M256_Rh120_2A46_ZPT98_2A20_M68A2", 1],
];
for (const [label, name, shellIndex] of SHOTS) {
    test(`the solved elevation lands the shot on the target: ${label}`, () => {
        const { weapon } = loadWeapon(name, shellIndex);
        const shot = weapon.getShot();
        for (const [distance, height] of [[150, 0], [300, 5], [400, -8]]) {
            const { low } = solveElevation(shot, distance, height);
            assert.ok(!Number.isNaN(low), `${name} has an elevation at ${distance} m`);
            assert.ok(Math.abs(heightAt(shot, low, distance) - height) < 1e-6, `${name} at ${distance} m`);
        }
    });
}

// The game destroys a projectile InitialLifeSpan seconds after launch: a shot that takes longer has no solution
test("a target the projectile cannot reach before its lifespan ends has no elevation (RPG-7, 4 s)", () => {
    const near = solve("DF_RPG_7_PG_7V_HEAT_OG_7V", 500).solution;
    const far = solve("DF_RPG_7_PG_7V_HEAT_OG_7V", 1500).solution;
    assert.ok(near.timeOfFlight.low < 4 && !Number.isNaN(near.elevation.low.deg), "500 m is reached within 4 s");
    assert.ok(far.timeOfFlight.low > 4, `1500 m takes ${far.timeOfFlight.low} s`);
    assert.ok(Number.isNaN(far.elevation.low.deg), "1500 m is past the lifespan");
});

// The projectile starts at the muzzle, which stands up to 5 m ahead of the pivot (a tank gun): a target the muzzle is
// not short of cannot be hit, though the barrel's line can be laid through it
const MUZZLE_AHEAD = WEAPONS.filter((entry) => entry.muzzle?.forward > 0);
test("no elevation for a target that is not past the muzzle, on every weapon whose muzzle is ahead of its pivot", () => {
    assert.ok(MUZZLE_AHEAD.length >= 80, `${MUZZLE_AHEAD.length} weapons with the muzzle ahead`);
    for (const entry of MUZZLE_AHEAD) {
        const shot = loadWeapon(entry.name).weapon.getShot();
        for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            for (const above of [-1, 0, 0.5, 1, 2]) {
                const distance = fraction * entry.muzzle.forward;
                const roots = solveElevation(shot, distance, shot.pivotHeight + above);
                for (const arc of ["low", "high"]) {
                    const root = roots[arc];
                    assert.ok(Number.isNaN(root) || launchPoint(shot, root).x < distance,
                        `${entry.name}: ${arc} ${root} rad for a target ${distance} m ahead, ${above} m above the pivot`);
                }
            }
        }
    }
});

test("a target just past the muzzle keeps its elevation", () => {
    for (const entry of MUZZLE_AHEAD) {
        const shot = loadWeapon(entry.name).weapon.getShot();
        const level = launchPoint(shot, 0);
        const distance = level.x + 1;
        const { low } = solveElevation(shot, distance, level.y);
        assert.ok(!Number.isNaN(low), `${entry.name} has an elevation 1 m past its muzzle`);
        assert.ok(launchPoint(shot, low).x < distance && Math.abs(heightAt(shot, low, distance) - level.y) < 1e-6, `${entry.name}: ${low} rad`);
    }
});

test("the firing solution of a target inside the barrel's length has no low arc (T-62 and mortar, issue #31)", () => {
    const map = {
        mapToGameScale: 1,
        mapToGameScaleY: 1,
        toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
        heightmap: { jsonPng: [[0]], getHeight: (latlng) => latlng.h },
    };
    for (const [name, distance, height] of [["DF_Tank_AP_T_62_2A20", 3, 2], ["Mortar", 0.3885, 1]]) {
        const { weapon } = loadWeapon(name);
        App.activeWeapon = weapon;
        const solution = new SquadFiringSolution({ lat: 0, lng: 0, h: 0 }, { lat: 0, lng: distance, h: height }, map, 0);
        assert.ok(launchPoint(solution.shot, 0).x > distance, `${name}: the muzzle is more than ${distance} m ahead of the pivot`);
        assert.ok(Number.isNaN(solution.elevation.low.deg), `${name}: low ${solution.elevation.low.deg} deg, flight ${solution.timeOfFlight.low} s`);
    }
});
