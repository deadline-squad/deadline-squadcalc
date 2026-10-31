import { test } from "node:test";
import assert from "node:assert/strict";
import { damageAtDistance, impactDamage, isCovered, hitProbability, roundsNeeded, KILL_DAMAGE, WOUND_DAMAGE } from "../src/js/squadDamage.js";
import { Weapon } from "../src/js/squadWeapons.js";
import { flat } from "./helpers.mjs";

// The AGS-17's VOG-17 grenade
const explosion = { damage: 115, inner: 1.5, outer: 18, falloff: 1, distanceFromImpact: 0.08 };

test("damage: full inside the inner radius, none beyond the outer one, falling off in between", () => {
    assert.equal(damageAtDistance(explosion, 0), 115);
    assert.equal(damageAtDistance(explosion, explosion.inner), 115);
    assert.equal(damageAtDistance(explosion, explosion.outer), 0);
    assert.equal(damageAtDistance(explosion, 100), 0);
    const middle = damageAtDistance(explosion, (explosion.inner + explosion.outer) / 2);
    assert.ok(Math.abs(middle - 57.5) < 1e-9, String(middle));
});

test("damage: the falloff exponent bends the curve", () => {
    const distance = 10;
    assert.ok(damageAtDistance({ ...explosion, falloff: 2 }, distance) < damageAtDistance(explosion, distance));
});

test("impact on the soldier kills, far away does nothing", () => {
    const soldier = { east: 0, north: 0 };
    assert.ok(impactDamage(flat, explosion, { east: 0, north: 0 }, soldier).damage >= KILL_DAMAGE);
    assert.equal(impactDamage(flat, explosion, { east: 50, north: 0 }, soldier).damage, 0);
});

test("cover: flat ground covers nobody, a wall between the impact and the soldier does", () => {
    const wall = (east) => (Math.abs(east - 5) < 1 ? 10 : 0);
    assert.equal(isCovered(flat, { east: 0, north: 0, z: 1 }, { east: 10, north: 0, z: 1 }), false);
    assert.equal(isCovered(wall, { east: 0, north: 0, z: 1 }, { east: 10, north: 0, z: 1 }), true);
});

test("hit probability on flat ground: a circular spread kills with kill radius / R, not its square", () => {
    const killRadius = Weapon.prototype.calculateDistanceForDamage(explosion.damage, explosion.inner, explosion.outer, explosion.falloff, explosion.distanceFromImpact, KILL_DAMAGE);
    for (const spread of [30, 50]) {
        const { kill } = hitProbability(flat, explosion, spread, spread, 37);
        assert.ok(Math.abs(kill - killRadius / spread) < 0.01, `${kill} vs ${killRadius / spread}`);
    }
});

test("hit probability: wound is never below kill, a zero spread is a sure hit, the bearing does not change a circle", () => {
    const circle = hitProbability(flat, explosion, 15, 15, 0);
    assert.ok(circle.wound >= circle.kill && circle.kill > 0 && circle.kill < 1);
    assert.deepEqual(hitProbability(flat, explosion, 0, 0, 37), { kill: 1, wound: 1 });
    const turned = hitProbability(flat, explosion, 15, 15, 123);
    assert.ok(Math.abs(turned.kill - circle.kill) < 0.01);
});

test("rounds needed: 1 - (1 - p)^n reaches the confidence", () => {
    assert.equal(roundsNeeded(0), Infinity);
    assert.equal(roundsNeeded(1), 1);
    assert.equal(roundsNeeded(0.5), 4);
    assert.equal(roundsNeeded(0.1), 22);
    assert.equal(roundsNeeded(0.1, 0.5), 7);
    assert.ok(WOUND_DAMAGE < KILL_DAMAGE);
});
