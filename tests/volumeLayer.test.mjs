/**
 * The volume layer end to end in Node: volumeWorker.js is run with the messages squadVolume.js sends, on a
 * synthetic scene (flat ground, a 2.5 m high wall with a doorway), through the real WebAssembly engine.
 * Needs the engine: `npm run build:engine`; without it these tests are skipped (CI builds it in engine.yml).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { COVERAGE, clearsStructures, computeCoveragePeaks, createRayClassifier } from "../src/js/squadCoverageRays.js";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const engineBuilt = existsSync(here("../engine/js/pkg/squad_engine_bg.wasm"));

const varints = (values) => {
    const out = [];
    for (let value of values) {
        while (value >= 0x80) {
            out.push((value & 0x7F) | 0x80);
            value >>= 7;
        }
        out.push(value);
    }
    return out;
};

/** gzip VCOL1 bytes (tools/volumetric/py/codec.py) for columns {id: [[first z index, length], ...]} */
function vcol(columns, { minX, minY, cell, dz, zMin, width, height }) {
    const header = Buffer.alloc(40);
    header.write("VCOL1", 0, "latin1");
    [minX, minY, cell, dz, zMin].forEach((value, i) => header.writeFloatLE(value, 8 + 4 * i));
    const ids = Object.keys(columns).map(Number).sort((a, b) => a - b);
    [width, height, ids.length].forEach((value, i) => header.writeUInt32LE(value, 28 + 4 * i));
    const body = [];
    let last = 0;
    for (const id of ids) {
        body.push(...varints([id - last, columns[id].length]));
        let end = 0;
        for (const [first, length] of columns[id]) {
            body.push(...varints([first - end, length - 1]));
            end = first + length;
        }
        last = id;
    }
    return gzipSync(Buffer.concat([header, Buffer.from(body)]));
}

/** gzip TER1 bytes (tools/volumetric/py/terrain_raster.py) of flat ground at level `level` */
function flatTerrain(width, height, level, { minX, minY, cell, zMin, step }) {
    const count = width * height;
    const header = Buffer.alloc(40);
    header.write("TER1", 0, "latin1");
    [minX, minY, cell, zMin, step].forEach((value, i) => header.writeFloatLE(value, 8 + 4 * i));
    [width, height, 0].forEach((value, i) => header.writeUInt32LE(value, 28 + 4 * i));
    const low = Buffer.alloc(count);
    const high = Buffer.alloc(count);
    for (let i = 0; i < count; i++) {
        const left = i % width ? level : 0;
        const above = i >= width ? level : 0;
        const aboveLeft = i >= width && i % width ? level : 0;
        let residual = level - (left + above - aboveLeft);
        if (residual < 0) residual += 0x10000;
        if (residual >= 0x8000) residual -= 0x10000;
        const zigzag = ((residual << 1) ^ (residual >> 15)) & 0xFFFF;
        low[i] = zigzag & 0xFF;
        high[i] = zigzag >> 8;
    }
    return gzipSync(Buffer.concat([header, low, high]));
}

// 40 x 40 columns of 0.5 m from (100, -50), dz 0.25 from z -10: a wall in row 20 (y -40 to -39.5), z 0 to 2.5 m
// (indices 40 to 49), over the columns 0 to 39 except the doorway of columns 18 to 21 (x 109 to 111), which has
// a lintel from 2 m (indices 48 and 49) and is open from the ground to 2 m
const GRID = { minX: 100, minY: -50, cell: 0.5, dz: 0.25, zMin: -10, width: 40, height: 40 };
const TERRAIN = { minX: 100, minY: -50, cell: 1, zMin: -10, step: 0.5 };
const wall = {};
for (let column = 0; column < 40; column++) {
    wall[20 * 40 + column] = column >= 18 && column <= 21 ? [[48, 2]] : [[40, 10]];
}
const VOLUME_FILE = vcol(wall, GRID);
const TERRAIN_FILE = flatTerrain(40, 40, 21, TERRAIN);
const entry = (bytes) => ({ file: "x", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const META = {
    volume: { ...entry(VOLUME_FILE), file: "volume.vcol", dz: GRID.dz, z_min_m: GRID.zMin, terrain: { ...entry(TERRAIN_FILE), file: "terrain.bin" } },
    generated: "2026-11-04T00:00:00Z",
};

const messages = [];
let imported = false;

/** Starts volumeWorker.js (once) with a fetch that serves the synthetic files, loads them, and returns `send` */
async function startWorker() {
    globalThis.postMessage = (message) => messages.push(message);
    globalThis.fetch = async (url) => {
        const path = String(url).split("?")[0];
        if (path.endsWith("volume.vcol")) return new Response(VOLUME_FILE);
        if (path.endsWith("terrain.bin")) return new Response(TERRAIN_FILE);
        return new Response(readFileSync(fileURLToPath(path)), { headers: { "content-type": "application/wasm" } });
    };
    if (!imported) {
        globalThis.onmessage = null;
        await import("../src/js/volumeWorker.js");
        imported = true;
    }
    const send = async (data) => {
        messages.length = 0;
        globalThis.onmessage({ data });
        // The worker handles messages one at a time through a promise chain
        for (let i = 0; i < 200 && !messages.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
        return messages.slice();
    };
    const loaded = await send({ load: {
        base: "http://localhost/heightmaps/test/",
        volume: META.volume,
        generated: META.generated,
        engineUrl: new URL("../engine/js/index.mjs", import.meta.url).href,
        wasmUrl: new URL("../engine/js/pkg/squad_engine_bg.wasm", import.meta.url).href,
    } });
    assert.deepEqual(loaded, [{ loaded: true }]);
    return send;
}

test("trace: a wall stops the path, a doorway lets it through, the ground stops it from above", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const path = (x, z) => Float64Array.from([x, -34, z, x, -45, z]);
    const [{ traced, hits }] = await send({ trace: 1, paths: [path(105, 1), path(110, 1), path(105, 4), path(110, 2.2), path(110, -1), Float64Array.from([105, -34, 1])] });
    assert.equal(traced, 1);
    assert.equal(hits[0].index, 1, "through the wall");
    // The path runs from y -34 to y -45 and enters the wall's voxels at y -39.5
    assert.ok(Math.abs(hits[0].t - 5.5 / 11) < 1e-9, `entry ${hits[0].t}`);
    assert.equal(hits[1], null, "through the doorway");
    assert.equal(hits[2], null, "over the wall");
    assert.equal(hits[3].index, 1, "at 2.2 m the lintel (2 to 2.5 m) stops it");
    assert.deepEqual(hits[4], { index: 0, t: 1, z: 0 }, "under the ground");
    assert.equal(hits[5], null, "a single point above the ground");
});

test("coverage: the rays through the wall are blocked beyond it, those through the doorway are not", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const shot = { velocity: 800, gravity: 0, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: true, pivotHeight: 1.5, muzzleForward: 0, muzzleUp: 0 };
    const params = { ground: 0, shot, range: 20, cell: 2, rays: 4, elevationLimits: [-90, 90], holdElevation: null, angleOffset: 0, lifespan: 100, lowOnly: true };
    // Rays: 0 east, 1 north (y decreasing), 2 west, 3 south. A weapon at (105, -34) has the wall 6 m north of it,
    // one at (110, -34) has the doorway
    const run = async (origin) => {
        const base = { job: 1, params, origin, east: [1, 0], north: [0, -1] };
        globalThis.onmessage({ data: { coverageInit: base } });
        await send({ coverageRays: { job: 1, first: 0, size: 4 } });
        const [{ values }] = await send({ coverageFinish: 1 });
        const stride = Math.floor(params.range / params.cell) + 1;
        return (ray) => Array.from(values.subarray(ray * stride + 1, (ray + 1) * stride));
    };
    const throughWall = (await run([105, -34]))(1);
    const throughDoor = (await run([110, -34]))(1);
    // Targets at 2, 4, ..., 20 m; the wall is 5.5 to 6 m ahead and a target's last 3 m are not checked (its own spot);
    // the ground ends 16 m north of the weapon, the targets beyond are out
    assert.deepEqual(throughWall, [1, 1, 1, 1, 3, 3, 3, 3, 0, 0], `wall: ${throughWall}`);
    assert.deepEqual(throughDoor, [1, 1, 1, 1, 1, 1, 1, 1, 0, 0], `doorway: ${throughDoor}`);
});

test("clearsStructures: tests only the samples with a structure, and only where the path is under its top", () => {
    const calls = [];
    const structures = {
        top: Float64Array.from([0, 0, 0, 5, 5, 0, 0, 0]),
        indices: Int32Array.from([3, 4, 5]),
        blocked: (i, before, at) => {
            calls.push([i, before, at]);
            return false;
        },
    };
    const level = (height) => ({ height: () => height });
    assert.equal(clearsStructures(structures, level(10), 1, 7, 1, 0), true);
    assert.deepEqual(calls, [], "above every top: no voxel test");
    assert.equal(clearsStructures(structures, level(2), 1, 7, 1, 0), true);
    assert.deepEqual(calls.map(([i]) => i), [3, 4, 5]);
    assert.equal(clearsStructures(structures, level(2), 6, 7, 1, 0), true);
    assert.equal(calls.length, 3, "samples outside [first, last] are not tested");
    structures.blocked = () => true;
    assert.equal(clearsStructures(structures, level(2), 1, 7, 1, 0), false);
});

test("the classifier uses the structures of a ray: blocked beyond them, clear without them or above them", () => {
    const shot = { velocity: 800, gravity: 0, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: true, pivotHeight: 1.5, muzzleForward: 0, muzzleUp: 0 };
    const params = { ground: 0, shot, range: 40, cell: 4, rays: 1, elevationLimits: [-90, 90], holdElevation: null, angleOffset: 0, lifespan: 100, lowOnly: true };
    const classifier = createRayClassifier({ ...params, peaks: computeCoveragePeaks(params).peaks });
    const profile = new Float64Array(classifier.samples);
    const targetHeights = new Float64Array(classifier.stride);
    const values = new Uint8Array(classifier.stride);
    const wallAt = 10;
    const structure = (top, blocks) => {
        const topProfile = new Float64Array(classifier.samples);
        topProfile[wallAt] = top;
        return { top: topProfile, indices: Int32Array.from([wallAt, wallAt + 1]), blocked: () => blocks };
    };

    classifier.classify(0, profile, targetHeights, values);
    assert.ok(values.slice(1).every((value) => value === COVERAGE.LOW), "flat ground");
    classifier.classify(0, profile, targetHeights, values, structure(5, true));
    assert.equal(values[1], COVERAGE.LOW, "the target 4 m ahead is before the wall");
    assert.equal(values[5], COVERAGE.BLOCKED, "the target 20 m ahead is behind it");
    classifier.classify(0, profile, targetHeights, values, structure(5, false));
    assert.ok(values.slice(1).every((value) => value === COVERAGE.LOW), "the voxels let it through");
    classifier.classify(0, profile, targetHeights, values, structure(0.1, true));
    assert.ok(values.slice(1).every((value) => value === COVERAGE.LOW), "the muzzle is above the top");
});
