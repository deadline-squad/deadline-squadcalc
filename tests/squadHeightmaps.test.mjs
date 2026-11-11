import { test } from "node:test";
import assert from "node:assert/strict";
import SquadHeightmap from "../src/js/squadHeightmaps.js";
import { App } from "./stubs/app.mjs";

// The jQuery events the heightmap announces on `document`, and the toasts it shows
const events = [];
globalThis.document = {};
globalThis.$ = () => ({ trigger: (name) => events.push(name) });
const toasts = [];
App.openToast = (...toast) => toasts.push(toast);

/** A heightmap with the given rows of levels, one sample per map unit, without the worker that loads it */
function heightmapOf(rows, step = 1) {
    const heightmap = Object.create(SquadHeightmap.prototype);
    heightmap.jsonPng = rows.map((row) => Uint16Array.from(row));
    heightmap.step = step;
    heightmap.colsPerUnit = 1;
    heightmap.rowsPerUnit = 1;
    return heightmap;
}

// row = -lat, col = lng
const at = (row, col) => ({ lat: -row, lng: col });

test("heights at the samples are the samples", () => {
    const heightmap = heightmapOf([[0, 10], [10, 20]], 0.5);
    assert.equal(heightmap.getHeight(at(0, 0)), 0);
    assert.equal(heightmap.getHeight(at(0, 1)), 5);
    assert.equal(heightmap.getHeight(at(1, 0)), 5);
    assert.equal(heightmap.getHeight(at(1, 1)), 10);
});

test("triangle rule: a quad is split along the diagonal from (row, col) to (row + 1, col + 1)", () => {
    // A twisted quad: the diagonal corners are 0, the others 10. Bilinear interpolation would give 5 at the
    // centre; the game's two triangles give the diagonal's own height there
    const heightmap = heightmapOf([[0, 10], [10, 0]]);
    assert.equal(heightmap.getHeight(at(0.5, 0.5)), 0);
    // On each triangle the height is linear: the upper-right one (col >= row) from the corners (0,0), (0,1), (1,1)
    assert.ok(Math.abs(heightmap.getHeight(at(0.25, 0.75)) - 5) < 1e-9);
    // and the lower-left one from (0,0), (1,0), (1,1)
    assert.ok(Math.abs(heightmap.getHeight(at(0.75, 0.25)) - 5) < 1e-9);
});

test("a flat quad and a plane are interpolated exactly", () => {
    assert.equal(heightmapOf([[7, 7], [7, 7]]).getHeight(at(0.3, 0.6)), 7);
    const plane = heightmapOf([[0, 4, 8], [2, 6, 10], [4, 8, 12]]);
    assert.ok(Math.abs(plane.getHeight(at(1.3, 0.6)) - (2 * 1.3 + 4 * 0.6)) < 1e-9);
});

test("outside the heightmap by more than half a sample the height is 0, within it the edge sample", () => {
    const heightmap = heightmapOf([[5, 5], [5, 5]]);
    assert.equal(heightmap.getHeight(at(0, -0.4)), 5);
    assert.equal(heightmap.getHeight(at(1.4, 1)), 5);
    assert.equal(heightmap.getHeight(at(0, -0.6)), 0);
    assert.equal(heightmap.getHeight(at(2, 0)), 0);
});

test("a loaded heightmap is ready and announced; a failed one shows its toast and every height is 0", () => {
    // As the worker hands them over (receive): 256 map units across, so one sample per map unit with 257 samples
    const received = (data) => {
        const heightmap = Object.create(SquadHeightmap.prototype);
        Object.assign(heightmap, { map: { pixelSize: 256 }, jsonPng: [], step: 0, ready: false, failed: false, worker: null });
        heightmap.map.heightmap = heightmap;
        heightmap.receive(data);
        return heightmap;
    };
    events.length = 0;
    const loaded = received({ levels: new Uint16Array(257 * 257).fill(1), width: 257, height: 257, step: 1, resolution: 1, url: "test" });
    assert.equal(loaded.ready, true);
    assert.equal(loaded.getHeight(at(3, 4)), 1);
    assert.deepEqual(events, ["heightmapPNG:loaded", "heightmap:loaded"]);

    events.length = 0;
    const failed = received({ error: "no heightmap at /heightmaps/test/", url: "/heightmaps/test/meta.json" });
    assert.deepEqual([failed.ready, failed.failed, failed.getHeight(at(0, 0))], [false, true, 0]);
    assert.deepEqual(events, ["heightmap:loaded"]);
    assert.deepEqual(toasts, [["error", "heightmapFailed", "heightmapFailedDesc"]]);
});

test("before a heightmap loaded every height is 0", () => {
    assert.equal(heightmapOf([]).getHeight(at(0, 0)), 0);
});

test("the height path runs from the weapon to the target, with the margins around them", () => {
    const heightmap = heightmapOf([[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20], [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]]);
    const { path, weaponIndex, targetIndex } = heightmap.getHeightPath(at(0, 1), at(0, 9), 8, 0, 0);
    assert.equal(path.length, 8);
    assert.equal(weaponIndex, 0);
    assert.equal(targetIndex, 7);
    assert.equal(path[0], 2);
    for (let i = 1; i < path.length; i++) assert.ok(path[i] > path[i - 1]);
});
