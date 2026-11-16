// Loads the wasm modules in Node and checks them: `node --test js/test/` after `js/build.sh`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const plain = await import("../pkg/squad_engine.js");
const simd = await import("../pkg-simd/squad_engine.js");
plain.initSync({ module: readFileSync(here("../pkg/squad_engine_bg.wasm")) });
// Two instances of the generated glue share nothing, so the SIMD build gets its own module
simd.initSync({ module: readFileSync(here("../pkg-simd/squad_engine_bg.wasm")) });
const { Engine, Heightmap, buildBvh } = await import("../index.mjs");

const request = (extra = {}) => ({
    weapon_specs: { v0: 110, mass: 4.1, drag_coef: 0.47 },
    pos_gun: [0, 0],
    pos_target: [0, 600, 0],
    ...extra,
});

test("solves a plain request with the closed-form parabola", () => {
    const response = new Engine().solve(request());
    const g = 9.8;
    const expected = Math.atan((110 ** 2 - Math.sqrt(110 ** 4 - (g * 600) ** 2)) / (g * 600)) * 1000;
    assert.ok(Math.abs(response.firing_solution.elevation_mrad - expected) < 1e-9);
    assert.equal(response.firing_solution.azimuth_deg, 0);
    assert.equal(response.occlusion_status, "unchecked");
    assert.equal(response.collision_details.material, "unknown");
});

test("drag_coef is ignored", () => {
    const engine = new Engine();
    const a = engine.solve(request());
    const b = engine.solve(request({ weapon_specs: { v0: 110 } }));
    assert.deepEqual(a, b);
});

test("a BVH built in wasm occludes the line of fire", () => {
    const wall = new Float32Array([-50, 300, -10, 50, 300, -10, 50, 300, 400, -50, 300, -10, 50, 300, 400, -50, 300, 400]);
    const bvh = buildBvh(new Uint8Array(wall.buffer));
    const header = new DataView(bvh.buffer, bvh.byteOffset);
    assert.equal(bvh.length, 8 + 32 * header.getUint32(0, true) + 48 * header.getUint32(4, true));
    const engine = new Engine();
    engine.loadBvh("wall", [bvh]);
    const response = engine.solve(request({ environment: { z_scale: 1, bvh_buffer_ref: "wall" } }));
    assert.equal(response.occlusion_status, "occluded");
    assert.ok(Math.abs(response.collision_details.point[1] - 300) < 1e-9);
    const hit = engine.firstHit("wall", [0, 0, 10, 0, 600, 10]);
    assert.ok(Math.abs(hit.t - 0.5) < 1e-12);
    assert.equal(engine.firstHit("wall", [0, 0, 500, 0, 600, 500]), null);
});

test("unknown refs are reported as errors", () => {
    assert.throws(() => new Engine().solve(request({ environment: { bvh_buffer_ref: "nope" } })), /nope/);
});

test("voxel columns from a VCOL1 file answer segment queries and requests", () => {
    // tests/data/tiny.vcol: 0.5 m columns from (100, -50), dz 0.25 from z = -10; voxel (10, 5, 8) is x 105..105.5,
    // y -47.5..-47, z -8..-7.75
    const file = readFileSync(here("../../tests/data/tiny.vcol"));
    const engine = new Engine();
    engine.loadVcol("tiny", file);
    const hit = engine.voxelFirstBlock("tiny", [103, -47.25, -7.9, 107, -47.25, -7.9]);
    assert.deepEqual([hit.column, hit.row, hit.z], [10, 5, 8]);
    assert.ok(Math.abs(hit.t - 0.5) < 1e-12);
    assert.equal(engine.voxelFirstBlock("tiny", [103, -47.25, -6, 107, -47.25, -6]), null);
    assert.throws(() => engine.voxelFirstBlock("nope", [0, 0, 0, 1, 1, 1]), /unknown vcol/);
    assert.throws(() => engine.loadVcol("bad", new Uint8Array([1, 2, 3])), /not a VCOL1 file/);
    // A shot that stays clear of the 20 m x 20 m grid is clear, not unchecked
    assert.equal(engine.solve(request({ environment: { vcol_ref: "tiny" } })).occlusion_status, "clear");
    assert.throws(() => engine.solve(request({ environment: { vcol_ref: "nope" } })), /nope/);
});

test("a precision region replaces the voxel wall by the exact triangle in front of it", () => {
    // A VCOL1 wall (decompressed form): row 600 of a 200 x 1400 grid of 0.5 m columns from (-50, 0), heights 0..400
    const bytes = [];
    const varint = (value) => {
        while (value >= 0x80) {
            bytes.push((value & 0x7f) | 0x80);
            value >>>= 7;
        }
        bytes.push(value);
    };
    const header = new DataView(new ArrayBuffer(40));
    [...Buffer.from("VCOL1\0\0\0")].forEach((byte, i) => header.setUint8(i, byte));
    [-50, 0, 0.5, 1, 0].forEach((value, i) => header.setFloat32(8 + 4 * i, value, true));
    [200, 1400, 200].forEach((value, i) => header.setUint32(28 + 4 * i, value, true));
    for (let column = 0; column < 200; column++) [column === 0 ? 600 * 200 : 1, 1, 0, 399].forEach(varint);
    const wall = Uint8Array.from([...new Uint8Array(header.buffer), ...bytes]);
    // tests/data/wall.rtri: square x -20..20, y 250..350, margin 0.6, one triangle across the path at y = 299.8
    const region = readFileSync(here("../../tests/data/wall.rtri"));

    const engine = new Engine();
    engine.loadVcol("wall", wall);
    engine.loadRegion("near", "wall", region);
    const environment = { vcol_ref: "wall", region_ref: "near" };
    const shot = (extra) => request({ pos_target: [0, 600, 0], options: { arc: "low" }, ...extra });
    const voxelOnly = engine.solve(shot({ environment: { vcol_ref: "wall" } }));
    assert.ok(Math.abs(voxelOnly.collision_details.point[1] - 300) < 1e-9);
    const precise = engine.solve(shot({ environment }));
    assert.equal(precise.occlusion_status, "occluded");
    assert.ok(Math.abs(precise.collision_details.point[1] - 299.8) < 1e-4);

    const hit = engine.precisionFirstBlock("near", "wall", [0, 0, 10, 0, 600, 10]);
    assert.ok(Math.abs(hit.t - 299.8 / 600) < 1e-6);
    assert.equal(typeof hit.triangle, "number");
    // Beside the triangle's 20 m width the voxel row is walked in the region: it is near, no triangle: clear
    assert.equal(engine.precisionFirstBlock("near", "wall", [15, 270, 10, 15, 330, 10]), null);
    // Outside the square the voxels decide
    const outside = engine.precisionFirstBlock("near", "wall", [30, 0, 10, 30, 600, 10]);
    assert.deepEqual(outside.voxel, { column: 160, row: 600, z: 10 });
    assert.throws(() => engine.loadRegion("x", "missing", region), /missing/);
    assert.throws(() => engine.loadRegion("x", "wall", new Uint8Array([1, 2, 3])), /not an RTRI1 file/);
    assert.throws(() => engine.precisionFirstBlock("nope", "wall", [0, 0, 0, 1, 1, 1]), /unknown region/);
    assert.throws(() => engine.solve(shot({ environment: { vcol_ref: "wall", region_ref: "nope" } })), /nope/);
});

test("the SIMD128 triangle test equals the scalar one bit for bit", () => {
    assert.equal(plain.has_simd(), false);
    assert.equal(simd.has_simd(), true);
    let seed = 12345;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
    let hits = 0;
    for (let i = 0; i < 20000; i++) {
        const triangle = Float32Array.from({ length: 9 }, () => random() * 10);
        const origin = Float32Array.from({ length: 3 }, () => random() * 10);
        const direction = Float32Array.from({ length: 3 }, () => (random() - 0.5) * 20);
        const a = plain.segment_triangle(origin, direction, triangle);
        const b = simd.segment_triangle(origin, direction, triangle);
        assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)), `${a} vs ${b}`);
        if (!Number.isNaN(a)) hits++;
    }
    assert.ok(hits > 500, `only ${hits} hits, the comparison is too weak`);
});

test("a heightmap is read in the engine's frame, with a detail, in batch, and has no height outside its lattice", () => {
    // 3 x 3 levels of the plane 10 * row + col on a lattice turned by 90 degrees: columns run north, rows run east
    const levels = Uint16Array.from([0, 1, 2, 10, 11, 12, 20, 21, 22]);
    const heightmap = new Heightmap(levels, { width: 3, height: 3, zMin: -5, zStep: 0.5, origin: [100, 200], spacing: 2, yawDeg: 90 });
    // Sample (row 1, col 2) is at origin + 2 * 2 * (0, 1) + 1 * 2 * (1, 0)
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
    near(heightmap.heightAt(102, 204), -5 + 0.5 * 12);
    near(heightmap.heightAt(100, 200), -5);
    assert.ok(Number.isNaN(heightmap.heightAt(0, 0)));
    assert.ok(Number.isNaN(heightmap.heightAt(NaN, 200)));
    const heights = heightmap.heights([102, 204, 0, 0, 100, 200]);
    assert.ok(heights instanceof Float64Array);
    assert.equal(heights.length, 3);
    near(heights[0], 1);
    assert.ok(Number.isNaN(heights[1]));
    near(heights[2], -5);
    assert.throws(() => heightmap.heights([1, 2, 3]), /pairs/);
    assert.throws(() => heightmap.loadDetail(new Uint8Array(30)), /detail/);
    heightmap.free();
    assert.throws(() => new Heightmap(levels, { width: 4, height: 3, zStep: 1, origin: [0, 0], spacing: 1 }), /expected 12/);
});

test("a heightmap built in slices is the heightmap built at once, and pauses between its slices", async () => {
    // 4.2 million levels: 3 slices of levels; a detail of the first 70 quads (factor 2, unit 1): 2 slices of quads
    const width = 1500;
    const height = 2800;
    const levels = Uint16Array.from({ length: width * height }, (_, i) => (i * 7) % 1000);
    const frame = { width, height, zStep: 0.5, origin: [0, 0], spacing: 1 };
    const quads = 70;
    const bits = new Uint8Array(Math.ceil(((width - 1) * (height - 1)) / 8));
    for (let quad = 0; quad < quads; quad++) bits[quad >> 3] |= 1 << (quad & 7);
    const header = new Uint8Array(new Uint32Array([0x31444d48, 2, 1, width - 1, height - 1, quads]).buffer);
    const nodes = Array.from({ length: 5 * quads }, (_, i) => (i * 5) % 40);
    const detail = Uint8Array.from([...header, ...bits, ...nodes]);
    const atOnce = new Heightmap(levels, frame);
    atOnce.loadDetail(detail);

    let pauses = 0;
    const sliced = await Heightmap.fromSlices(levels, frame, () => { pauses++; });
    assert.equal(pauses, 3);
    await sliced.loadDetailInSlices(detail, () => { pauses++; });
    assert.equal(pauses, 4);
    const points = [];
    for (let x = 0; x < 70; x += 0.37) points.push(x, -((x * 3) % 1));
    assert.deepEqual(sliced.heights(points), atOnce.heights(points));
    const plain = new Heightmap(levels, frame);
    assert.notDeepEqual(sliced.heights(points), plain.heights(points));

    const damaged = await Heightmap.fromSlices(levels, frame, () => {});
    await assert.rejects(() => damaged.loadDetailInSlices(Uint8Array.from(detail).fill(0, 0, 4), () => {}), /detail/);
    await assert.rejects(() => Heightmap.fromSlices(levels, frame, () => { throw new Error("stop"); }), /stop/);
    await assert.rejects(() => Heightmap.fromSlices(levels.subarray(1), frame, () => {}), /expected 4200000/);
    for (const heightmap of [atOnce, sliced, damaged, plain]) heightmap.free();
});
