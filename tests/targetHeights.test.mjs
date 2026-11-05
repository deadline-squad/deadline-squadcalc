import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyColumn, keptHeightChoice, HEADROOM, MIN_OPENING, SURFACE_LIFT, DOORWAY_AIM } from "../src/js/targetHeights.js";

const ground = (top) => [-Infinity, top];

test("open ground offers nothing", () => {
    assert.deepEqual(classifyColumn([ground(10)], [false]), []);
});

test("a roof over open sky is offered a little above its top", () => {
    const choices = classifyColumn([ground(10), [10, 16]], [false, false]);
    assert.deepEqual(choices, [{ kind: "roof", z: 16 + SURFACE_LIFT }]);
});

test("a storey: its floor, its ceiling, and the roof, highest first", () => {
    // The ground floor's slab (10.0-10.5) starts at the landscape; a room 3 m high, a slab 13.5-14, a room, the roof 17-17.5
    const choices = classifyColumn([ground(10), [10, 10.5], [13.5, 14], [17, 17.5]], [false, false, false, false]);
    assert.deepEqual(choices.map(({ kind }) => kind), ["roof", "ceiling", "floor", "ceiling", "floor"]);
    assert.deepEqual(choices.map(({ z }) => +z.toFixed(2)), [17.6, 16.9, 14.1, 13.4, 10.6]);
});

test("the floor of the lowest storey is the landscape's: only its ceiling is new", () => {
    const choices = classifyColumn([ground(10), [13, 13.5]], [false, false]);
    assert.deepEqual(choices.map(({ kind }) => kind), ["roof", "ceiling"]);
});

test("something lower than a soldier on the ground is no roof", () => {
    assert.deepEqual(classifyColumn([ground(10), [10, 11]], [false, false]).map(({ kind }) => kind), []);
});

test("a free space a soldier cannot stand in is no floor or ceiling", () => {
    const crawlspace = HEADROOM - 0.1;
    const choices = classifyColumn([ground(0), [crawlspace, crawlspace + 1]], [false, false]);
    assert.deepEqual(choices.map(({ kind }) => kind), ["roof"]);
});

test("cracks thinner than MIN_OPENING are no openings, even in a wall", () => {
    const choices = classifyColumn([ground(0), [MIN_OPENING / 2, 3]], [true, false]);
    assert.deepEqual(choices.map(({ kind }) => kind), ["roof"]);
});

test("a free space in a wall is a window below HEADROOM and a doorway from it", () => {
    // Sill to 1.0, window 1.0-2.25, header 2.25-3: a window aimed at its middle
    const window = classifyColumn([ground(1), [2.25, 3]], [true, false]);
    assert.deepEqual(window.map(({ kind }) => kind), ["roof", "window"]);
    assert.ok(Math.abs(window[1].z - 1.625) < 1e-9);
    // Threshold to 2.5, lintel 2.5-3: a doorway aimed DOORWAY_AIM above the threshold
    const doorway = classifyColumn([ground(0), [2.5, 3]], [true, false]);
    assert.deepEqual(doorway.map(({ kind }) => kind), ["roof", "doorway"]);
    assert.ok(Math.abs(doorway[1].z - DOORWAY_AIM) < 1e-9);
});

test("a free space in a wall is not also a floor and a ceiling", () => {
    const choices = classifyColumn([ground(0), [3, 3.5]], [true, false]);
    assert.deepEqual(choices.map(({ kind }) => kind), ["roof", "doorway"]);
});

test("a height choice that is still offered is kept, one that is not offered any more goes back to the ground", () => {
    const window = { kind: "window", height: 14.5, above: 2 };
    assert.equal(keptHeightChoice(null, [window]), null, "the ground stays the ground");
    assert.equal(keptHeightChoice(window, [{ kind: "roof", height: 20.1 }, { ...window }]), window);
    assert.equal(keptHeightChoice(window, [{ kind: "roof", height: 20.1 }]), null, "no longer offered");
    assert.equal(keptHeightChoice(window, []), null, "nothing offered at this point");
    assert.equal(keptHeightChoice(window, [{ kind: "doorway", height: 14.5 }]), null, "same height, other kind");
    assert.equal(keptHeightChoice(window, [{ kind: "window", height: 14.6 }]), null, "same kind, other height");
});
