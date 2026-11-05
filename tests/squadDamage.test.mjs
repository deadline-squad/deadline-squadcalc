import { test } from "node:test";
import assert from "node:assert/strict";
import { damageAtDistance, damageField, impactDamage, isCovered, hitProbability, roundsNeeded, KILL_DAMAGE, WOUND_DAMAGE } from "../src/js/squadDamage.js";
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


test("damageField with objects: the volume layer's blocked() covers a soldier the landscape does not, between the clearances", () => {
    const calls = [];
    const wall = (east0, north0, z0, east1, north1) => {
        calls.push([east0, north0, z0, east1, north1]);
        return Math.min(east0, east1) <= 4 && Math.max(east0, east1) >= 4;
    };
    const field = damageField(flat, explosion, 1, {}, { impactZ: 0, blocked: wall });
    const at = (east, north) => {
        const middle = (field.size - 1) / 2;
        return [field.damage[(middle - north) * field.size + middle + east], field.exposed[(middle - north) * field.size + middle + east]];
    };

    assert.ok(at(3, 0)[0] > 0, "before the wall");
    const [behind, exposed] = at(8, 0);
    assert.equal(behind, 0, "behind the wall");
    assert.ok(exposed > 0, "the damage without cover is still reported");
    assert.equal(at(-8, 0)[0] > 0, true, "the other side");

    // The asked stretch of the line is the heightmap trace's: from 1 m off the explosion to 0.5 m short of the soldier
    const [east0, north0, z0, east1] = calls.find(([, , , to]) => Math.abs(to - 7.5) < 1e-9);
    assert.deepEqual([east0, north0], [1, 0]);
    assert.ok(Math.abs(z0 - (0.08 + (0.9 - 0.08) / 8)) < 1e-9, `height at the first end ${z0}`);
    assert.equal(east1, 7.5);
});

test("damageField with objects: the landscape still covers, and the impact height moves the explosion", () => {
    const hill = (east) => (east > 3 && east < 5 ? 10 : 0);
    const never = { impactZ: 0, blocked: () => false };
    const hidden = damageField(hill, explosion, 1, {}, never);
    const size = hidden.size;
    const middle = (size - 1) / 2;
    assert.equal(hidden.damage[middle * size + middle + 8], 0, "behind the hill");

    // An explosion 6 m up is farther from a soldier on the ground than one on it
    const low = damageField(flat, explosion, 1, {}, never);
    const high = damageField(flat, explosion, 1, {}, { impactZ: 6, blocked: () => false });
    assert.ok(high.exposed[middle * size + middle + 8] < low.exposed[middle * size + middle + 8]);
});
