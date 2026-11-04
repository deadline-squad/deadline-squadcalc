import { test } from "node:test";
import assert from "node:assert/strict";
import { heightAt, solveElevation, maxRange, isParabola } from "../src/js/squadBallistics.js";
import { loadWeapon } from "./helpers.mjs";

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
