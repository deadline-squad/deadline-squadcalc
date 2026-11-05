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
const { Engine, buildBvh } = await import("../index.mjs");

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
