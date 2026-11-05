/**
 * The reverse-position heatmap (positionHeatmap.js): the scoring, the classification of the positions on flat ground
 * and behind a ridge, the objects as a callback, and the choice of a precision region. The engine end to end (voxels,
 * the precision pass and the exact tracer) is in volumeLayer.test.mjs and the browser check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CLEARANCE_FLOOR, DISTANCE_FLOOR, HEAT, MIN_REGION_MARGIN, createPositionClassifier, heatColor, heatmapGrid, pickRegion,
    heatmapSignature, positionScore, rasterizeHeatmap, scoreToValue,
} from "../src/js/positionHeatmap.js";

// A rifle round: flies straight, shouldered at 1.5 m
const STRAIGHT = { velocity: 800, gravity: 0, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: true, pivotHeight: 1.5, muzzleForward: 0, muzzleUp: 0 };
// The same with the game's gravity
const FALLING = { ...STRAIGHT, gravity: 9.8 };

const base = {
    heightAt: () => 0,
    targetZ: 0,
    elevated: false,
    pathBlocked: () => false,
    shot: STRAIGHT,
    range: 100,
    cell: 10,
    rays: 4,
    elevationLimits: [-90, 90],
    angleOffset: 0,
    lifespan: 100,
    moa: 2,
};

/** Values of one ray of a classifier, positions 1 .. */
function ray(params, index = 0) {
    const classifier = createPositionClassifier({ ...base, ...params });
    const all = new Uint8Array((params.rays ?? base.rays) * classifier.stride);
    classifier.classifyRay(index, all);
    return Array.from(all.subarray(index * classifier.stride + 1, (index + 1) * classifier.stride));
}

test("score: closer is better, the farthest clear position keeps 40 % of the distance weight, clearance counts", () => {
    assert.equal(positionScore(0, 100, 4), 1);
    assert.ok(positionScore(10, 100, 4) > positionScore(50, 100, 4));
    assert.ok(Math.abs(positionScore(100, 100, 4) - DISTANCE_FLOOR) < 1e-12, "long range stays viable");
    assert.ok(Math.abs(positionScore(0, 100, 0) - CLEARANCE_FLOOR) < 1e-12);
    assert.ok(positionScore(30, 100, 4) > positionScore(30, 100, 2) && positionScore(30, 100, 2) > positionScore(30, 100, 0));
    assert.ok(positionScore(100, 100, 0) > 0, "never zero, so a clear position never reads as blocked");
    assert.equal(scoreToValue(1), 255);
    assert.ok(scoreToValue(DISTANCE_FLOOR * CLEARANCE_FLOOR) >= HEAT.CLEAR_MIN);
});

test("grid: a cell of at least 2 m, about 160 per range, rays two cells apart at the edge", () => {
    assert.deepEqual(heatmapGrid(200), { cell: 2, rays: 360 });
    const wide = heatmapGrid(2000);
    assert.equal(wide.cell, 12.5);
    assert.equal(wide.rays, 503);
});

test("flat ground without objects: every position is clear and the nearer the better", () => {
    const values = ray({});
    assert.equal(values.length, 10);
    assert.ok(values.every((value) => value >= HEAT.CLEAR_MIN), String(values));
    assert.deepEqual([...values].sort((a, b) => b - a), values, "descending with the distance");
    assert.equal(values[0] > values[9], true);
});

test("a ridge across the ray blocks the positions behind it, not the ones in front", () => {
    const heightAt = (east) => (east > 24 && east < 28 ? 30 : 0);
    const values = ray({ heightAt });
    assert.deepEqual(values.map((value) => value >= HEAT.CLEAR_MIN), [true, true, false, false, false, false, false, false, false, false]);
    assert.deepEqual(values.slice(2), new Array(8).fill(HEAT.BLOCKED));
});

test("positions without landscape are out, so are the ones the weapon cannot lay at", () => {
    const edge = ray({ heightAt: (east) => (east > 45 ? NaN : 0) });
    assert.deepEqual(edge.slice(4), new Array(6).fill(HEAT.OUT));
    assert.ok(edge[3] >= HEAT.CLEAR_MIN);

    // Gravity: the farthest positions are beyond the range of a 100 m/s shell at a 10 degree limit
    const slow = ray({ shot: { ...FALLING, velocity: 100 }, elevationLimits: [-90, 2], range: 1000, cell: 100 });
    assert.ok(slow[0] >= HEAT.CLEAR_MIN);
    assert.equal(slow[9], HEAT.OUT);

    const expired = ray({ lifespan: 0.2, shot: { ...FALLING, velocity: 100 }, range: 1000, cell: 100 });
    assert.equal(expired[9], HEAT.OUT, "the projectile expires before it lands");
});

test("the shooter's body inside an object makes the position out", () => {
    const pathBlocked = (points, count) => count === 2 && points[0] === points[3] && Math.abs(points[0] - 30) < 1e-9;
    const values = ray({ pathBlocked });
    assert.equal(values[2], HEAT.OUT);
    assert.ok(values[1] >= HEAT.CLEAR_MIN && values[3] >= HEAT.CLEAR_MIN);
});

test("objects: the polyline starts at the shooter, skips the clearances, and ends at the target when it is elevated", () => {
    const seen = [];
    const pathBlocked = (points, count) => {
        if (!(points[0] === points[3] && points[1] === points[4])) seen.push(Array.from(points.subarray(0, 3 * count)));
        return false;
    };
    ray({ pathBlocked, range: 40, cell: 20 });
    const [first] = seen;
    // The position 20 m east of the target: the polyline starts 3 m from the muzzle, ends 3 m from the target
    assert.ok(Math.abs(first[0] - 17) < 1e-9 && Math.abs(first[1]) < 1e-9, `starts at ${first.slice(0, 2)}`);
    assert.ok(Math.abs(first[first.length - 3] - 3) < 1e-9, "ends 3 m short of the target");

    seen.length = 0;
    ray({ pathBlocked, range: 40, cell: 20, elevated: true, targetZ: 5 });
    const elevated = seen[0];
    assert.ok(Math.abs(elevated[elevated.length - 3]) < 1e-9 && elevated[elevated.length - 1] === 5, "ends at the target point");
    assert.ok(Math.abs(elevated[elevated.length - 6] - 0.5) < 1e-9, "the samples stop 0.5 m short of it");
});

test("clearance: a post beside the line lowers the score of the positions whose spread line it touches", () => {
    // A post beside the ray (north of it), 38 to 62 m east: the line displaced 0.5 m towards it meets it near the shooter
    const post = (points, count) => {
        for (let i = 0; i < count; i++) {
            const east = points[3 * i];
            const north = points[3 * i + 1];
            if (east > 38 && east < 62 && north > 0.05 && north < 3 && points[3 * i + 2] < 3) return true;
        }
        return false;
    };
    const open = ray({});
    const beside = ray({ pathBlocked: post, moa: 8 });
    assert.ok(beside[5] >= HEAT.CLEAR_MIN, "the line itself is clear");
    assert.ok(beside[5] < open[5], `${beside[5]} < ${open[5]}`);
    assert.equal(beside[1], open[1], "the nearer positions do not see the post");
});

test("a target above the ground: the aim height is the target's, the shot falls onto it", () => {
    const high = ray({ shot: FALLING, targetZ: 8, elevated: true, range: 300, cell: 30 });
    assert.ok(high.every((value) => value >= HEAT.CLEAR_MIN), String(high));
});

test("heatColor and the image: blocked is faint red, clear runs amber to green, out is empty", () => {
    assert.equal(heatColor(HEAT.OUT), null);
    assert.deepEqual(heatColor(HEAT.BLOCKED).slice(0, 3), [231, 76, 60]);
    const poor = heatColor(scoreToValue(DISTANCE_FLOOR * CLEARANCE_FLOOR));
    const good = heatColor(255);
    assert.deepEqual(poor.slice(0, 3), [241, 196, 15]);
    assert.deepEqual(good.slice(0, 3), [46, 204, 113]);

    // 2 rays x 3 positions, cell 1: the east ray clear, the west ray blocked
    const values = Uint8Array.from([0, 255, 255, 255, 0, 1, 1, 1]);
    const { pixels, size } = rasterizeHeatmap(values, 2, 1, 3);
    assert.equal(size, 7);
    const at = (east, north) => Array.from(pixels.subarray(((3 - north) * size + 3 + east) * 4, ((3 - north) * size + 3 + east) * 4 + 4));
    assert.deepEqual(at(2, 0), [...good]);
    assert.deepEqual(at(-2, 0), [...heatColor(HEAT.BLOCKED)]);
    assert.deepEqual(at(0, 0), [0, 0, 0, 0], "the target's own cell is empty");
});

test("pickRegion: the square that holds the target farthest from its edge, none when it is too close to the edge", () => {
    const regions = [
        { file: "a", centre: [0, 0], radius: 150 },
        { file: "b", centre: [250, 0], radius: 150 },
    ];
    assert.equal(pickRegion(regions, 10, 5).entry.file, "a");
    assert.equal(pickRegion(regions, 10, 5).margin, 140);
    assert.equal(pickRegion(regions, 200, 0).entry.file, "b", "the second square holds it better");
    assert.equal(pickRegion(regions, 125, 0), null, `closer than ${MIN_REGION_MARGIN} m to both edges`);
    assert.equal(pickRegion(regions, 500, 0), null);
    assert.equal(pickRegion([], 0, 0), null);
});

test("the heatmap is computed again when the weapon's range, elevation limits or gravity scale change", () => {
    const weapon = { name: "M2A1", velocity: 800, moa: 2, gravityScale: 1, minElevation: [-10, 30], getMaxDistance: () => 1500 };
    const latlng = { lat: -20, lng: 30 };
    const signature = (changes = {}, gravity = 9.8, height = null) => heatmapSignature("Jensen", { ...weapon, ...changes }, gravity, latlng, height);
    const reference = signature();
    assert.equal(signature(), reference, "same inputs, same signature");
    assert.notEqual(signature({ getMaxDistance: () => 1800 }), reference, "range");
    assert.notEqual(signature({ minElevation: [-10, 45] }), reference, "upper elevation limit");
    assert.notEqual(signature({ minElevation: [-20, 30] }), reference, "lower elevation limit");
    assert.notEqual(signature({ gravityScale: 0.5 }), reference, "gravity scale");
    assert.notEqual(signature({}, 4.9), reference, "gravity");
    assert.notEqual(signature({ velocity: 700 }), reference, "velocity");
    assert.notEqual(signature({}, 9.8, 12), reference, "target height");
});
