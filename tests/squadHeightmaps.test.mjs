import { test } from "node:test";
import assert from "node:assert/strict";
import SquadHeightmap from "../src/js/squadHeightmaps.js";
import { App } from "./stubs/app.mjs";
import { loadCore } from "./stubs/engine.mjs";

// The heightmap reads its heights with the engine's Rust core (public/engine, built by `npm run build:engine`): these
// tests run the real WebAssembly module, only the worker that fetches the images is replaced by `receive`.

// The jQuery events the heightmap announces on `document`, and the toasts it shows
const events = [];
globalThis.document = {};
globalThis.$ = () => ({ trigger: (name) => events.push(name) });
const toasts = [];
App.openToast = (...toast) => toasts.push(toast);

// The page's map of these tests: 256 map units across bounds of 256 m, so a LatLng is lng = x - min_x, lat = -(y - min_y)
const PIXEL_SIZE = 256;
const BOUNDS = { min_x: 0, max_x: 256, min_y: 0, max_y: 256 };
const LATTICE = { originX: 0, originY: 0, resolution: 1, yawDeg: 0 };

/**
 * A heightmap of the given rows of levels as the worker hands it over (receive), without the worker
 * @param {number[][]} rows
 * @param {{step?: number, lattice?: object, bounds?: object, detail?: Uint8Array, detailError?: string}} [options] -
 *   `lattice` as the worker's gridLattice: where sample (0, 0) lies in Unreal's frame, the metres between samples and the
 *   yaw of the sample axes; by default one sample per metre from (0, 0); `detail` the bytes of a heightmap.detail.bin
 *   without its gzip layer (detailBytes); `detailError` the worker's reason for having none
 * @returns {Promise<SquadHeightmap>} - once the engine read it
 */
async function heightmapOf(rows, { step = 1, lattice = LATTICE, bounds = BOUNDS, detail = null, detailError } = {}) {
    const heightmap = Object.create(SquadHeightmap.prototype);
    Object.assign(heightmap, {
        map: { pixelSize: PIXEL_SIZE }, core: null, toEngine: null, resolution: 0, ready: false, failed: false,
        detailFailed: false, detailError: "", worker: null,
    });
    heightmap.map.heightmap = heightmap;
    if (rows.length) {
        const levels = Uint16Array.from(rows.flat());
        await heightmap.receive({ levels, width: rows[0].length, height: rows.length, step, lattice, bounds, detail, detailError, url: "test" });
    }
    return heightmap;
}

/**
 * The bytes of a heightmap.detail.bin without its gzip layer, as tools/heightmaps/py/heightmap_detail.py writes them
 * @param {{factor?: number, unit?: number, quadColumns: number, quadRows: number, quads: Map<number, number[]>}} detail -
 *   `quads` maps a quad (row * quadColumns + col) to the stored values of its sub-grid nodes without the corners, row-major:
 *   each node's level is the triangle rule's read of the quad's corners there, rounded half up, plus value * unit
 * @returns {Uint8Array}
 */
function detailBytes({ factor = 2, unit = 1, quadColumns, quadRows, quads }) {
    const indices = [...quads.keys()].sort((a, b) => a - b);
    const bitBytes = Math.ceil(quadColumns * quadRows / 8);
    const varints = [];
    for (const quad of indices) {
        for (const value of quads.get(quad)) {
            let zigzag = value >= 0 ? 2 * value : -2 * value - 1;
            for (; zigzag >= 0x80; zigzag = Math.floor(zigzag / 128)) varints.push((zigzag % 128) | 0x80);
            varints.push(zigzag);
        }
    }
    const bytes = new Uint8Array(24 + bitBytes + varints.length);
    bytes.set([..."HMD1"].map((char) => char.charCodeAt(0)));
    const view = new DataView(bytes.buffer);
    [factor, unit, quadColumns, quadRows, indices.length].forEach((value, i) => view.setUint32(4 + 4 * i, value, true));
    for (const quad of indices) bytes[24 + (quad >> 3)] |= 1 << (quad & 7);
    bytes.set(varints, 24 + bitBytes);
    return bytes;
}

/** The LatLng of world (x, y) metres on a map of `bounds` */
const world = (x, y, bounds = BOUNDS) => ({
    lng: (x - bounds.min_x) / (bounds.max_x - bounds.min_x) * PIXEL_SIZE,
    lat: -(y - bounds.min_y) / (bounds.max_y - bounds.min_y) * PIXEL_SIZE,
});
// With the default lattice, sample (row, col) is at world (col, row)
const at = (row, col) => world(col, row);

test("heights at the samples are the samples", async () => {
    const heightmap = await heightmapOf([[0, 10], [10, 20]], { step: 0.5 });
    assert.equal(heightmap.getHeight(at(0, 0)), 0);
    assert.equal(heightmap.getHeight(at(0, 1)), 5);
    assert.equal(heightmap.getHeight(at(1, 0)), 5);
    assert.equal(heightmap.getHeight(at(1, 1)), 10);
});

test("triangle rule: a quad is split along the diagonal from (row, col) to (row + 1, col + 1)", async () => {
    // A twisted quad: the diagonal corners are 0, the others 10. Bilinear interpolation would give 5 at the
    // centre; the game's two triangles give the diagonal's own height there
    const heightmap = await heightmapOf([[0, 10], [10, 0]]);
    assert.equal(heightmap.getHeight(at(0.5, 0.5)), 0);
    // On each triangle the height is linear: the upper-right one (col >= row) from the corners (0,0), (0,1), (1,1)
    assert.ok(Math.abs(heightmap.getHeight(at(0.25, 0.75)) - 5) < 1e-9);
    // and the lower-left one from (0,0), (1,0), (1,1)
    assert.ok(Math.abs(heightmap.getHeight(at(0.75, 0.25)) - 5) < 1e-9);
});

test("a flat quad and a plane are interpolated exactly", async () => {
    assert.equal((await heightmapOf([[7, 7], [7, 7]])).getHeight(at(0.3, 0.6)), 7);
    const plane = await heightmapOf([[0, 4, 8], [2, 6, 10], [4, 8, 12]]);
    assert.ok(Math.abs(plane.getHeight(at(1.3, 0.6)) - (2 * 1.3 + 4 * 0.6)) < 1e-9);
});

test("the edge sample holds within half a sample; beyond it, and for a coordinate that is not a number, there is no height", async () => {
    const heightmap = await heightmapOf([[5, 5], [5, 5]]);
    assert.equal(heightmap.getHeight(at(0, -0.4)), 5);
    assert.equal(heightmap.getHeight(at(1.4, 1)), 5);
    for (const latlng of [at(0, -0.6), at(2, 0), at(-0.6, 0), at(0, 50), { lat: NaN, lng: NaN }, { lat: NaN, lng: 0 }, { lat: 0, lng: undefined }, { lat: Infinity, lng: 0 }]) {
        assert.ok(Number.isNaN(heightmap.getHeight(latlng)), JSON.stringify(latlng));
    }
    // The caller says what a point without height reads as
    assert.equal(heightmap.getHeight(at(2, 0), 0), 0);
    assert.equal(heightmap.getHeight({ lat: NaN, lng: 0 }, -1), -1);
    assert.equal(heightmap.getHeight(at(0, 0), -1), 5);
});

test("a point 47 m outside the lattice has no height, where the lattice's own corner has", async () => {
    // Jensen: the corner of the lattice reads 15.907 m, 3 map units (47 m) beyond it nothing
    const lattice = { originX: -10, originY: -10, resolution: 1, yawDeg: 0 };
    const heightmap = await heightmapOf([[15, 15], [15, 15]], { lattice });
    assert.equal(heightmap.getHeight(world(-10, -10)), 15);
    assert.ok(Number.isNaN(heightmap.getHeight(world(-57, -10))));
});

test("the samples lie where the lattice puts them, not at the minimap's corner", async () => {
    // Goose Bay: the landscape's vertices are 0.431 m east and 0.252 m south of a whole metre; the grid's first sample is the
    // vertex west and north of the bounds' corner, so sample (row 1, col 1) is at world (0.569, 0.748)
    const lattice = { originX: -0.431, originY: -0.252, resolution: 1, yawDeg: 0 };
    const heightmap = await heightmapOf([[0, 0, 0], [0, 100, 0], [0, 0, 0]], { lattice });
    assert.ok(Math.abs(heightmap.getHeight(world(0.569, 0.748)) - 100) < 1e-6);
    // Read from the bounds' corner instead, that point would be 0.43 m and 0.25 m into a quad, 57 % lower
    assert.ok(Math.abs(heightmap.getHeight(world(1, 1)) - 100 * (1 - 0.431)) < 1e-6);
});

test("samples 0.75 m apart (Anvil) are read at their own spacing", async () => {
    const heightmap = await heightmapOf([[0, 3, 6], [0, 3, 6]], { lattice: { originX: -1.5, originY: -0.75, resolution: 0.75, yawDeg: 0 } });
    assert.ok(Math.abs(heightmap.getHeight(world(-0.75, 0)) - 3) < 1e-9);
    assert.ok(Math.abs(heightmap.getHeight(world(0, 0)) - 6) < 1e-9);
    assert.ok(Math.abs(heightmap.getHeight(world(-1.125, -0.375)) - 1.5) < 1e-9);
});

test("a turned lattice (Skorpo) is read along its own axes", async () => {
    // 1.2 m samples turned by -2.006195 degrees: sample (row, col) at origin + 1.2 col (cos, sin) + 1.2 row (-sin, cos)
    const lattice = { originX: -3851.481, originY: -3285.1115, resolution: 1.2, yawDeg: -2.006195 };
    const bounds = { min_x: -3700, max_x: 3700, min_y: -3700, max_y: 3700 };
    const yaw = lattice.yawDeg * Math.PI / 180;
    const sample = (row, col) => world(lattice.originX + 1.2 * (col * Math.cos(yaw) - row * Math.sin(yaw)),
        lattice.originY + 1.2 * (col * Math.sin(yaw) + row * Math.cos(yaw)), bounds);
    const rows = [[0, 10, 20, 30], [40, 50, 60, 70], [80, 90, 100, 110], [120, 130, 140, 150]];
    const heightmap = await heightmapOf(rows, { lattice, bounds });
    for (const [row, col] of [[0, 0], [1, 2], [3, 3], [2, 1]]) {
        assert.ok(Math.abs(heightmap.getHeight(sample(row, col)) - rows[row][col]) < 1e-6, `sample (${row}, ${col})`);
    }
    // Within a quad the plane z = 40 row + 10 col is kept exactly, along the turned axes
    assert.ok(Math.abs(heightmap.getHeight(sample(1.25, 2.5)) - (40 * 1.25 + 10 * 2.5)) < 1e-6);
    // Read along world X and Y, sample (3, 3) would lie 0.13 m off: 4 levels lower
    const unturned = await heightmapOf(rows, { lattice: { ...lattice, yawDeg: 0 }, bounds });
    assert.ok(Math.abs(unturned.getHeight(sample(3, 3)) - 150) > 3);
});

test("a quad with detail is read on its sub-grid, with the triangle rule on each of its quads", async () => {
    // One flat quad at level 0 whose detail raises its five inner nodes: the middles of its top, left, right and bottom
    // edges and its centre (a 1 m chimney in a 2 m quad, at step 0.01)
    const detail = detailBytes({ quadColumns: 1, quadRows: 1, quads: new Map([[0, [10, 20, 100, 30, 40]]]) });
    const heightmap = await heightmapOf([[0, 0], [0, 0]], { step: 0.01, detail });
    const height = (row, col) => Math.round(heightmap.getHeight(at(row, col)) / 0.01 * 1e9) / 1e9;
    assert.deepEqual([height(0, 0.5), height(0.5, 0), height(0.5, 0.5), height(0.5, 1), height(1, 0.5)], [10, 20, 100, 30, 40]);
    assert.deepEqual([height(0, 0), height(0, 1), height(1, 0), height(1, 1)], [0, 0, 0, 0]);
    // Inside the sub-quads: on the diagonal of the upper-left one from its corner (0) to the centre (100), with the
    // edge's middles 10 and 20 beside it; the upper-right one from 10 to the right edge's middle (30)
    assert.equal(height(0.25, 0.25), 50);
    assert.equal(height(0.25, 0.75), 20);
    assert.equal(heightmap.detailFailed, false);
    // Without its detail the quad is flat
    assert.equal((await heightmapOf([[0, 0], [0, 0]], { step: 0.01 })).getHeight(at(0.5, 0.5)), 0);
});

test("the detail's nodes count from the triangle rule's read of the corners, rounded half up, in units", async () => {
    // Corners 0, 1, 1, 2: the read is 0.5 at the middle of the top edge, which counts as 1; the centre reads 1
    const plane = await heightmapOf([[0, 1], [1, 2]], { detail: detailBytes({ quadColumns: 1, quadRows: 1, quads: new Map([[0, [0, 0, 0, 0, 0]]]) }) });
    assert.equal(plane.getHeight(at(0, 0.5)), 1);
    assert.equal(plane.getHeight(at(0.5, 0.5)), 1);
    // A unit of 5 levels: the centre's 3 units lift it from the read 10 to 25, a negative value lowers a node
    const units = await heightmapOf([[0, 10], [10, 20]], { detail: detailBytes({ unit: 5, quadColumns: 1, quadRows: 1, quads: new Map([[0, [0, -1, 3, 0, 0]]]) }) });
    assert.equal(units.getHeight(at(0.5, 0.5)), 25);
    assert.equal(units.getHeight(at(0.5, 0)), 0);
    assert.equal(units.getHeight(at(0, 0.5)), 5);
});

test("a quad without detail beside one that has it reads its corners where the detail does not reach", async () => {
    // Quads 0 and 2 of a row of three: only quad 1 has detail; with a factor of 4, 21 nodes per quad
    const detail = detailBytes({ factor: 4, quadColumns: 3, quadRows: 1, quads: new Map([[1, new Array(21).fill(8)]]) });
    const heightmap = await heightmapOf([[0, 4, 8, 12], [0, 4, 8, 12]], { detail });
    // The middle of quad 0 and quad 2: not on a shared edge, the plane of the corners (the edge's nodes only reach the
    // sub-quads along the edge)
    assert.equal(heightmap.getHeight(at(0.5, 0.25)), 1);
    assert.equal(heightmap.getHeight(at(0.5, 2.75)), 11);
    // Quad 1 reads 6 at its centre and 8 more there
    assert.equal(heightmap.getHeight(at(0.5, 1.5)), 14);
});

test("the surface has no jump on the edge between a quad with detail and one without (#46)", async () => {
    // A chimney in the middle quad of a row of three, a flat ground of level 0 around it: the middle's top and bottom
    // edges lift to 10 and 40 in their middles. Before, the neighbours read the corners (0) and the surface jumped by 10 and 40 on the edge
    const quads = new Map([[1, [10, 20, 100, 30, 40]]]);
    const heightmap = await heightmapOf([[0, 0, 0, 0], [0, 0, 0, 0]], { detail: detailBytes({ quadColumns: 3, quadRows: 1, quads }) });
    const eps = 1e-9;
    // The middle's left edge (x = 1) and right edge (x = 2), from the quad on each side: its middle node is 20 and 30
    for (const [edge, node] of [[1, 20], [2, 30]]) {
        const inside = heightmap.getHeight(at(0.5, edge + (edge === 1 ? eps : -eps)));
        const outside = heightmap.getHeight(at(0.5, edge + (edge === 1 ? -eps : eps)));
        assert.ok(Math.abs(inside - node) < 1e-6, `inside, edge ${edge}: ${inside}`);
        assert.ok(Math.abs(outside - inside) < 1e-6, `edge ${edge}: ${inside} against ${outside}`);
    }
    // The neighbour's own ground away from the shared edge stays the corners'
    assert.equal(heightmap.getHeight(at(0.5, 0.25)), 0);
    assert.equal(heightmap.getHeight(at(0.5, 3)), 0);
});

test("a damaged detail leaves the coarse surface, with a warning toast and `detailFailed`", async () => {
    toasts.length = 0;
    const damaged = detailBytes({ quadColumns: 1, quadRows: 1, quads: new Map([[0, [1, 2, 3, 4, 5]]]) });
    damaged[3] = 0x32;
    const heightmap = await heightmapOf([[0, 0], [0, 0]], { detail: damaged });
    assert.deepEqual([heightmap.ready, heightmap.failed, heightmap.detailFailed], [true, false, true]);
    assert.match(heightmap.detailError, /not an HMD1 detail/);
    assert.deepEqual(toasts, [["warning", "heightmapDetailFailed", "heightmapDetailFailedDesc"]]);
    assert.equal(heightmap.getHeight(at(0.5, 0.5)), 0);

    // A detail of another heightmap
    toasts.length = 0;
    const other = await heightmapOf([[0, 0, 0], [0, 0, 0]], { detail: detailBytes({ quadColumns: 1, quadRows: 1, quads: new Map() }) });
    assert.match(other.detailError, /another heightmap/);
    assert.equal(other.detailFailed, true);
});

test("a detail the worker could not fetch is a visible failure too, and the heights stay on the coarse surface", async () => {
    toasts.length = 0;
    const heightmap = await heightmapOf([[1, 1], [1, 1]], { detailError: "Error: no heightmap.detail.bin at /heightmaps/test/" });
    assert.deepEqual([heightmap.ready, heightmap.failed, heightmap.detailFailed], [true, false, true]);
    assert.equal(heightmap.detailError, "Error: no heightmap.detail.bin at /heightmaps/test/");
    assert.deepEqual(toasts, [["warning", "heightmapDetailFailed", "heightmapDetailFailedDesc"]]);
    assert.equal(heightmap.getHeight(at(0.5, 0.5)), 1);
});

test("a loaded heightmap is ready and announced; a failed one shows its toast and has no height", async () => {
    events.length = 0;
    const heightmap = await heightmapOf([[1, 1], [1, 1]]);
    assert.equal(heightmap.ready, true);
    assert.equal(heightmap.detailFailed, false);
    assert.deepEqual(events, ["heightmapPNG:loaded", "heightmap:loaded"]);

    events.length = 0;
    toasts.length = 0;
    const failed = await heightmapOf([]);
    await failed.receive({ error: "no heightmap at /heightmaps/test/", url: "/heightmaps/test/meta.json" });
    assert.deepEqual([failed.ready, failed.failed], [false, true]);
    assert.ok(Number.isNaN(failed.getHeight(at(0, 0))));
    assert.equal(failed.getHeight(at(0, 0), 0), 0);
    assert.deepEqual(events, ["heightmap:loaded"]);
    assert.deepEqual(toasts, [["error", "heightmapFailed", "heightmapFailedDesc"]]);
});

test("a heightmap the engine refuses fails like one that did not load", async () => {
    toasts.length = 0;
    const heightmap = await heightmapOf([]);
    const levels = new Uint16Array(3);
    await heightmap.receive({ levels, width: 2, height: 2, step: 1, lattice: LATTICE, bounds: BOUNDS, url: "test" });
    assert.deepEqual([heightmap.ready, heightmap.failed], [false, true]);
    assert.deepEqual(toasts, [["error", "heightmapFailed", "heightmapFailedDesc"]]);
});

test("before a heightmap loaded there is no height", async () => {
    const heightmap = await heightmapOf([]);
    assert.ok(Number.isNaN(heightmap.getHeight(at(0, 0))));
    assert.equal(heightmap.getHeight(at(0, 0), 0), 0);
    assert.deepEqual([...heightmap.getHeights(Float64Array.of(0, 0, 1, 1), 0)], [0, 0]);
});

test("a heightmap that a map switch replaced is not announced and is freed", async () => {
    events.length = 0;
    const heightmap = await heightmapOf([]);
    heightmap.map.heightmap = {};
    await heightmap.receive({ levels: Uint16Array.of(1, 1, 1, 1), width: 2, height: 2, step: 1, lattice: LATTICE, bounds: BOUNDS, url: "test" });
    assert.deepEqual([heightmap.ready, events], [false, []]);

    const loaded = await heightmapOf([[1, 1], [1, 1]]);
    loaded.dispose();
    assert.deepEqual([loaded.ready, Number.isNaN(loaded.getHeight(at(0, 0)))], [false, true]);
});

test("the levels reach the engine in slices, between which the page works, and the heights are the same", async (t) => {
    // 6.3 million levels, three slices of the engine's copy; a clock that moves 10 ms per reading spends the budget at each
    let tick = 0;
    t.mock.method(performance, "now", () => (tick += 10));
    const RealChannel = globalThis.MessageChannel;
    let tasks = 0;
    t.mock.method(globalThis, "MessageChannel", class extends RealChannel {
        constructor() {
            super();
            tasks++;
        }
    }, { getter: false });
    const width = 3072;
    const rows = Array.from({ length: 2048 }, (_, row) => Array.from({ length: width }, (_, col) => (row * 7 + col * 3) % 5000));
    const heightmap = await heightmapOf(rows);
    assert.deepEqual([heightmap.ready, tasks], [true, 3]);
    // A sample of each slice
    for (const [row, col] of [[3, 5], [1000, 1234], [2047, 3071]]) assert.equal(heightmap.getHeight(at(row, col)), rows[row][col]);
});

/**
 * Make a map switch replace `heightmap` at its `n`th pause of the build in slices (the pause that follows then stops it)
 * @param {SquadHeightmap} heightmap
 * @param {number} n
 */
function replaceAtPause(heightmap, n) {
    const slicePause = heightmap.slicePause.bind(heightmap);
    heightmap.slicePause = () => {
        const pause = slicePause();
        let calls = 0;
        return async () => {
            if (++calls === n) heightmap.map.heightmap = {};
            await pause();
        };
    };
}

test("a map switch while the levels are being copied stops it, and nothing is announced", async (t) => {
    let tick = 0;
    t.mock.method(performance, "now", () => (tick += 10));
    events.length = 0;
    toasts.length = 0;
    const heightmap = await heightmapOf([]);
    replaceAtPause(heightmap, 2);
    const levels = new Uint16Array(3072 * 2048);
    await heightmap.receive({ levels, width: 3072, height: 2048, step: 1, lattice: LATTICE, bounds: BOUNDS, url: "test" });
    assert.deepEqual([heightmap.ready, heightmap.core, heightmap.failed, events, toasts], [false, null, false, [], []]);
});

test("a map switch while the detail is being decoded stops it, frees the engine's copy and announces nothing", async (t) => {
    let tick = 0;
    t.mock.method(performance, "now", () => (tick += 10));
    const { Heightmap } = await loadCore();
    const fromSlices = Heightmap.fromSlices.bind(Heightmap);
    let built = null;
    t.mock.method(Heightmap, "fromSlices", async (...args) => {
        built = await fromSlices(...args);
        t.mock.method(built, "free");
        return built;
    });
    events.length = 0;
    toasts.length = 0;
    const heightmap = await heightmapOf([]);
    // 70 quads with detail are two slices of the decoding; the switch comes after the levels' only slice and the first of them
    replaceAtPause(heightmap, 2);
    const quads = new Map(Array.from({ length: 70 }, (_, quad) => [quad, [0, 0, 0, 0, 0]]));
    const detail = detailBytes({ quadColumns: 99, quadRows: 2, quads });
    await heightmap.receive({ levels: new Uint16Array(300), width: 100, height: 3, step: 1, lattice: LATTICE, bounds: BOUNDS, detail, url: "test" });
    assert.deepEqual([heightmap.ready, heightmap.core, heightmap.failed, heightmap.detailFailed, events, toasts], [false, null, false, false, [], []]);
    assert.equal(built.free.mock.callCount(), 1);
});

test("the batch reads what single reads give, in order, and gives the caller's value where there is no height", async () => {
    const rows = [[0, 2, 4, 6], [3, 5, 7, 9], [6, 8, 10, 12]];
    const heightmap = await heightmapOf(rows, { step: 0.5 });
    const points = [at(0.3, 0.6), at(1.7, 2.2), at(0, 0), { lat: 40, lng: 40 }, at(1, 3), { lat: NaN, lng: 1 }];
    const latLngs = Float64Array.from(points.flatMap(({ lat, lng }) => [lat, lng]));
    const batch = heightmap.getHeights(latLngs);
    assert.ok(batch instanceof Float64Array);
    points.forEach((point, i) => {
        const single = heightmap.getHeight(point);
        assert.ok(Object.is(batch[i], single), `point ${i}: ${batch[i]} against ${single}`);
    });
    assert.deepEqual([...heightmap.getHeights(latLngs, -1)].map((height) => height === -1), [false, false, false, true, false, true]);
    assert.equal(heightmap.getHeights(new Float64Array(0)).length, 0);
});

test("the height path runs from the weapon to the target, with the margins around them", async () => {
    const heightmap = await heightmapOf([[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20], [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]]);
    const { path, weaponIndex, targetIndex } = heightmap.getHeightPath(at(0, 1), at(0, 9), 8, 0, 0);
    assert.equal(path.length, 8);
    assert.equal(weaponIndex, 0);
    assert.equal(targetIndex, 7);
    assert.equal(path[0], 2);
    for (let i = 1; i < path.length; i++) assert.ok(path[i] > path[i - 1]);
});

test("the margins of the height path that reach off the map are 0", async () => {
    const heightmap = await heightmapOf([[4, 4, 4, 4], [4, 4, 4, 4]]);
    const { path } = heightmap.getHeightPath(at(0, 0.5), at(0, 2.5), 10, 1, 1);
    assert.equal(path.length, 30);
    assert.ok(path.every((height) => height === 0 || height === 4));
    assert.ok(path.includes(0) && path.includes(4));
});
