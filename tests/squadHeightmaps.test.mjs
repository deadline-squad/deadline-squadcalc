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

// The page's map of these tests: 256 map units across bounds of 256 m, so a LatLng is lng = x - min_x, lat = -(y - min_y)
const PIXEL_SIZE = 256;
const BOUNDS = { min_x: 0, max_x: 256, min_y: 0, max_y: 256 };

/**
 * A heightmap of the given rows of levels as the worker hands it over (receive), without the worker
 * @param {number[][]} rows
 * @param {{step?: number, lattice?: object, bounds?: object}} [options] - `lattice` as the worker's gridLattice: where
 *   sample (0, 0) lies, the metres between samples and the yaw of the sample axes; by default one sample per metre from (0, 0)
 * @returns {SquadHeightmap}
 */
function heightmapOf(rows, { step = 1, lattice = { originX: 0, originY: 0, resolution: 1, yawDeg: 0 }, bounds = BOUNDS } = {}) {
    const heightmap = Object.create(SquadHeightmap.prototype);
    Object.assign(heightmap, { map: { pixelSize: PIXEL_SIZE }, jsonPng: [], step: 0, toGrid: null, resolution: 0, ready: false, failed: false, worker: null });
    heightmap.map.heightmap = heightmap;
    if (rows.length) {
        heightmap.receive({ levels: Uint16Array.from(rows.flat()), width: rows[0].length, height: rows.length, step, lattice, bounds, url: "test" });
    }
    return heightmap;
}

/** The LatLng of world (x, y) metres on a map of `bounds` */
const world = (x, y, bounds = BOUNDS) => ({
    lng: (x - bounds.min_x) / (bounds.max_x - bounds.min_x) * PIXEL_SIZE,
    lat: -(y - bounds.min_y) / (bounds.max_y - bounds.min_y) * PIXEL_SIZE,
});
// With the default lattice, sample (row, col) is at world (col, row)
const at = (row, col) => world(col, row);

test("heights at the samples are the samples", () => {
    const heightmap = heightmapOf([[0, 10], [10, 20]], { step: 0.5 });
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

test("the samples lie where the lattice puts them, not at the minimap's corner", () => {
    // Goose Bay: the landscape's vertices are 0.431 m east and 0.252 m south of a whole metre; the grid's first sample is the
    // vertex west and north of the bounds' corner, so sample (row 1, col 1) is at world (0.569, 0.748)
    const lattice = { originX: -0.431, originY: -0.252, resolution: 1, yawDeg: 0 };
    const heightmap = heightmapOf([[0, 0, 0], [0, 100, 0], [0, 0, 0]], { lattice });
    assert.ok(Math.abs(heightmap.getHeight(world(0.569, 0.748)) - 100) < 1e-6);
    // Read from the bounds' corner instead, that point would be 0.43 m and 0.25 m into a quad, 57 % lower
    assert.ok(Math.abs(heightmap.getHeight(world(1, 1)) - 100 * (1 - 0.431)) < 1e-6);
});

test("samples 0.75 m apart (Anvil) are read at their own spacing", () => {
    const heightmap = heightmapOf([[0, 3, 6], [0, 3, 6]], { lattice: { originX: -1.5, originY: -0.75, resolution: 0.75, yawDeg: 0 } });
    assert.ok(Math.abs(heightmap.getHeight(world(-0.75, 0)) - 3) < 1e-9);
    assert.ok(Math.abs(heightmap.getHeight(world(0, 0)) - 6) < 1e-9);
    assert.ok(Math.abs(heightmap.getHeight(world(-1.125, -0.375)) - 1.5) < 1e-9);
});

test("a turned lattice (Skorpo) is read along its own axes", () => {
    // 1.2 m samples turned by -2.006195 degrees: sample (row, col) at origin + 1.2 col (cos, sin) + 1.2 row (-sin, cos)
    const lattice = { originX: -3851.481, originY: -3285.1115, resolution: 1.2, yawDeg: -2.006195 };
    const bounds = { min_x: -3700, max_x: 3700, min_y: -3700, max_y: 3700 };
    const yaw = lattice.yawDeg * Math.PI / 180;
    const sample = (row, col) => world(lattice.originX + 1.2 * (col * Math.cos(yaw) - row * Math.sin(yaw)),
        lattice.originY + 1.2 * (col * Math.sin(yaw) + row * Math.cos(yaw)), bounds);
    const rows = [[0, 10, 20, 30], [40, 50, 60, 70], [80, 90, 100, 110], [120, 130, 140, 150]];
    const heightmap = heightmapOf(rows, { lattice, bounds });
    for (const [row, col] of [[0, 0], [1, 2], [3, 3], [2, 1]]) {
        assert.ok(Math.abs(heightmap.getHeight(sample(row, col)) - rows[row][col]) < 1e-6, `sample (${row}, ${col})`);
    }
    // Within a quad the plane z = 40 row + 10 col is kept exactly, along the turned axes
    assert.ok(Math.abs(heightmap.getHeight(sample(1.25, 2.5)) - (40 * 1.25 + 10 * 2.5)) < 1e-6);
    // Read along world X and Y, sample (3, 3) would lie 0.13 m off: 4 levels lower
    const unturned = heightmapOf(rows, { lattice: { ...lattice, yawDeg: 0 }, bounds });
    assert.ok(Math.abs(unturned.getHeight(sample(3, 3)) - 150) > 3);
});

test("a loaded heightmap is ready and announced; a failed one shows its toast and every height is 0", () => {
    events.length = 0;
    const heightmap = heightmapOf([[1, 1], [1, 1]]);
    assert.equal(heightmap.ready, true);
    assert.deepEqual(events, ["heightmapPNG:loaded", "heightmap:loaded"]);

    events.length = 0;
    toasts.length = 0;
    const failed = heightmapOf([]);
    failed.receive({ error: "no heightmap at /heightmaps/test/", url: "/heightmaps/test/meta.json" });
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
