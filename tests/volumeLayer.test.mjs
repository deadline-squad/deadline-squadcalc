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
import { KILL_DAMAGE } from "../src/js/squadDamage.js";
import { HEAT } from "../src/js/positionHeatmap.js";
import { classifyColumn } from "../src/js/targetHeights.js";
import { App } from "./stubs/app.mjs";
import { loadWeapon } from "./helpers.mjs";
import SquadFiringSolution from "../src/js/squadFiringSolution.js";
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

/** gzip TER2 bytes (tools/volumetric/py/terrain_raster.py) of flat ground at level `level` */
function flatTerrain(width, height, level, { originX, originY, cell, zMin, step }) {
    const count = width * height;
    const header = Buffer.alloc(56);
    header.write("TER2", 0, "latin1");
    [originX, originY, cell].forEach((value, i) => header.writeDoubleLE(value, 8 + 8 * i));
    [0, zMin, step].forEach((value, i) => header.writeFloatLE(value, 32 + 4 * i));
    [width, height, 0].forEach((value, i) => header.writeUInt32LE(value, 44 + 4 * i));
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
const TERRAIN = { originX: 100, originY: -50, cell: 1, zMin: -10, step: 0.5 };
const wall = {};
for (let column = 0; column < 40; column++) {
    wall[20 * 40 + column] = column >= 18 && column <= 21 ? [[48, 2]] : [[40, 10]];
}
// A house in row 5 (y -47.5 to -47): the column 26 is a storey (slabs at 0 to 0.5, 3 to 3.5, 6 to 6.5 m); the columns 28 to 34 are a
// wall 3 m high with a window in column 30 (sill to 1 m, header from 2.25 m); the columns 35, 37 and 38 are a wall with a
// doorway in column 36 (open to 2.5 m, lintel to 3 m)
wall[5 * 40 + 26] = [[40, 2], [52, 2], [64, 2]];
for (let column = 28; column <= 34; column++) wall[5 * 40 + column] = column === 30 ? [[40, 4], [49, 3]] : [[40, 12]];
for (const column of [35, 37, 38]) wall[5 * 40 + column] = [[40, 12]];
wall[5 * 40 + 36] = [[50, 2]];
// A voxel buried under the ground (z -5 to -2.5 m) in the columns x 101.5 to 102, y -35 to -34.5; and a 100 m tower in the
// columns x 100 to 102, y -43 to -41
wall[30 * 40 + 3] = [[20, 10]];
for (let row = 14; row <= 17; row++) for (let column = 0; column < 4; column++) wall[row * 40 + column] = [[40, 400]];
const VOLUME_FILE = vcol(wall, GRID);
// Flat ground at 0 m over x 0 to 1200, y -1200 to 0: room for the trajectories of the weapons of weapons.js
const BIG_TERRAIN_FILE = flatTerrain(1200, 1200, 21, { originX: 0, originY: -1200, cell: 1, zMin: -10, step: 0.5 });
const TERRAIN_FILE = flatTerrain(40, 40, 21, TERRAIN);
const entry = (bytes) => ({ file: "x", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const META = {
    volume: { ...entry(VOLUME_FILE), file: "volume.vcol", dz: GRID.dz, z_min_m: GRID.zMin, terrain: { ...entry(TERRAIN_FILE), file: "terrain.bin" } },
    generated: "2026-11-04T00:00:00Z",
};

// A bullet that flies straight, shouldered at 1.5 m
const STRAIGHT_SHOT = { velocity: 800, gravity: 0, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: true, pivotHeight: 1.5, muzzleForward: 0, muzzleUp: 0 };

const messages = [];
let imported = false;
let terrainFile = TERRAIN_FILE;

/** Starts volumeWorker.js (once) with a fetch that serves the synthetic files, loads them, and returns `send` */
async function startWorker(terrainBytes = TERRAIN_FILE, { changeEntry = (volume) => volume, servedVolume = VOLUME_FILE } = {}) {
    terrainFile = terrainBytes;
    globalThis.postMessage = (message) => messages.push(message);
    globalThis.fetch = async (url) => {
        const path = String(url).split("?")[0];
        if (path.endsWith("volume.vcol")) return new Response(servedVolume);
        if (path.endsWith("terrain.bin")) return new Response(terrainFile);
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
    const volume = changeEntry({ ...META.volume, terrain: { ...entry(terrainBytes), file: "terrain.bin" } });
    const loaded = await send({ load: {
        base: "http://localhost/heightmaps/test/",
        volume,
        generated: META.generated,
        engineUrl: new URL("../engine/js/index.mjs", import.meta.url).href,
        wasmUrl: new URL("../engine/js/pkg/squad_engine_bg.wasm", import.meta.url).href,
    } });
    send.loadAnswer = loaded;
    return send;
}

test("trace: a wall stops the path, a doorway lets it through, the ground stops it from above", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    assert.deepEqual(send.loadAnswer, [{ loaded: true }]);
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

/** Runs `body` on a page without SubtleCrypto (a plain-HTTP origin) */
async function withoutSubtleCrypto(body) {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
        await body();
    } finally {
        Object.defineProperty(globalThis, "crypto", saved);
    }
}

const tampered = Buffer.from(VOLUME_FILE);
tampered[tampered.length - 1] ^= 0xFF;
const wrongHash = (volume) => ({ ...volume, sha256: "0".repeat(64) });
const upperCase = (volume) => ({ ...volume, sha256: volume.sha256.toUpperCase(), terrain: { ...volume.terrain, sha256: volume.terrain.sha256.toUpperCase() } });

test("load: a file that does not match the sha256 of meta.json is refused", { skip: !engineBuilt }, async () => {
    const wrongTerrainHash = (volume) => ({ ...volume, terrain: { ...volume.terrain, sha256: "f".repeat(64) } });
    for (const [name, options] of [
        ["a wrong hash of the voxel file", { changeEntry: wrongHash }],
        ["a wrong hash of the landscape file", { changeEntry: wrongTerrainHash }],
        ["a voxel file of the right size with a changed byte", { servedVolume: tampered }],
    ]) {
        const send = await startWorker(TERRAIN_FILE, options);
        assert.match(send.loadAnswer[0].error ?? "", /checksum mismatch/, name);
    }
});

test("load: the hash of meta.json is compared in either case", { skip: !engineBuilt }, async () => {
    const send = await startWorker(TERRAIN_FILE, { changeEntry: upperCase });
    assert.deepEqual(send.loadAnswer, [{ loaded: true }]);
});

test("load: without SubtleCrypto the check is still made, in plain JavaScript", { skip: !engineBuilt }, async () => {
    await withoutSubtleCrypto(async () => {
        const good = await startWorker(TERRAIN_FILE, { changeEntry: upperCase });
        assert.deepEqual(good.loadAnswer, [{ loaded: true }]);
        const bad = await startWorker(TERRAIN_FILE, { servedVolume: tampered });
        assert.match(bad.loadAnswer[0].error ?? "", /checksum mismatch/);
    });
});

test("trace: a point a hair under the landscape (the target of a shell solved to land on it) is not a hit, one that is really under it is", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const [{ hits }] = await send({ trace: 10, paths: [
        Float64Array.from([105, -34, 1, 105, -33, 0]),
        Float64Array.from([105, -34, 1, 105, -33, -1e-6]),
        Float64Array.from([105, -34, 1, 105, -33, -1e-3]),
    ] });
    assert.equal(hits[0], null, "on the ground");
    assert.equal(hits[1], null, "1e-6 m under it");
    assert.deepEqual(hits[2], { index: 1, t: 1, z: 0 }, "1 mm under it is a hit");
});

// A target on the landscape itself ('landscape' height of the target dialog): the solver lands the shell on it to
// 1e-9 m, so the last point of the line of fire is on either side of the ground; none of them is an obstacle
for (const name of ["Mortar", "M1064M121", "HellCannon"]) {
    test(`line of fire: ${name} against a target on flat ground at the landscape height is never blocked by the ground under the target`, { skip: !engineBuilt }, async () => {
        const send = await startWorker(BIG_TERRAIN_FILE);
        const questions = [];
        const map = {
            activeMap: { name: "test" },
            toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
            heightmap: { getHeight: () => 10, resolution: 1 },
            volume: {
                ready: true,
                zMin: -10,
                toWorld: (latlng) => ({ x: 10 + latlng.lng, y: -600 - latlng.lat }),
                lookup: (key, build) => {
                    questions.push(build());
                    return undefined;
                },
            },
        };
        const { weapon } = loadWeapon(name);
        App.activeWeapon = weapon;
        for (let distance = 30; distance <= 1100; distance += 13.7) {
            // 'landscape': the page's height of the ground (the heightmap's 10 is the file's 0)
            new SquadFiringSolution({ lat: 0, lng: 0 }, { lat: 0, lng: distance }, map, 0, undefined, 10);
        }
        assert.ok(questions.length >= 20, `${questions.length} lines of fire`);
        const [{ hits }] = await send({ trace: 11, paths: questions.map((question) => question.path) });
        hits.forEach((hit, i) => assert.equal(questions[i].toObstacle(hit), null, `question ${i}: ${JSON.stringify(hit)}`));
    });
}

test("trace: a voxel buried under the ground does not hide the ground, which the path meets first", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    // Straight down through the columns of the buried voxel (z -5 to -2.5): the ground (0) is at a third of the segment
    // from 5 to -10, the voxel's top at half of it
    const [{ hits }] = await send({ trace: 12, paths: [
        Float64Array.from([101.75, -34.75, 5, 101.75, -34.75, -10]),
        Float64Array.from([101.75, -34.75, 0.1, 101.75, -34.75, -1e-6 - 20]),
    ] });
    assert.equal(hits[0].index, 1);
    assert.ok(Math.abs(hits[0].t - 5 / 15) < 1e-9, `t ${hits[0].t}`);
    assert.ok(Math.abs(hits[0].z) < 1e-9, `z ${hits[0].z}`);
    assert.ok(hits[1].t < 0.01, "and from just above the ground");
});

test("column: the heights a vertical ray crosses, and whether the free space is part of a wall", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const column = async (x, y) => (await send({ column: 7, x, y }))[0];
    const y = -47.25;

    const open = await column(105.25, -30.25);
    assert.deepEqual(open.solids, [[-Infinity, 0]], "open ground: only the landscape");
    assert.deepEqual(open.walled, [false]);

    const storey = await column(113.25, y);
    assert.equal(storey.columned, 7);
    assert.deepEqual(storey.solids, [[-Infinity, 0], [0, 0.5], [3, 3.5], [6, 6.5]]);
    assert.deepEqual(storey.walled, [false, false, false, false], "a room is not a wall");

    const window = await column(115.25, y);
    assert.deepEqual(window.solids, [[-Infinity, 0], [0, 1], [2.25, 3]]);
    assert.deepEqual(window.walled, [false, true, false], "the window has jambs on both sides");

    const doorway = await column(118.25, y);
    assert.deepEqual(doorway.solids, [[-Infinity, 0], [2.5, 3]]);
    assert.deepEqual(doorway.walled, [true, false], "the doorway has jambs on both sides");

    const kinds = (answer) => classifyColumn(answer.solids, answer.walled).map(({ kind, z }) => `${kind} ${z.toFixed(2)}`);
    assert.deepEqual(kinds(storey), ["roof 6.60", "ceiling 5.90", "floor 3.60", "ceiling 2.90", "floor 0.60"]);
    assert.deepEqual(kinds(window), ["roof 3.10", "window 1.63"]);
    assert.deepEqual(kinds(doorway), ["roof 3.10", "doorway 1.00"]);

    const outside = await column(500, 500);
    assert.equal(outside.solids, null, "no landscape there");
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

test("cover: a soldier behind the wall is covered, one in line with the doorway is not (the damage zone with the voxels as cover)", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const explosion = { damage: 115, inner: 1.5, outer: 18, falloff: 1, distanceFromImpact: 0.08 };
    // The round lands at (110, -36), 4 m south of the wall (y -40 to -39.5) and in line with the doorway (x 109 to 111, open to 2 m)
    const request = { id: 3, explosion, cell: 1, impact: [110, -36], east: [1, 0], north: [0, -1], impactZ: 0 };
    const [answer] = await send({ cover: request });
    assert.equal(answer.covered, 3);
    assert.equal(answer.size, 37);
    const at = (field, east, north) => field[(18 - north) * 37 + 18 + east];

    assert.ok(at(answer.exposed, -5, 7) > KILL_DAMAGE / 2, "the soldier behind the wall is in range of the blast");
    assert.equal(at(answer.damage, -5, 7), 0, "behind the wall: covered");
    assert.equal(at(answer.damage, 3, 7), 0, "behind the wall, beside the doorway: covered");
    assert.ok(at(answer.damage, 0, 7) > 0, "in line with the doorway: the blast reaches him");
    assert.equal(at(answer.damage, 0, 7), at(answer.exposed, 0, 7), "and the doorway costs nothing");
    assert.ok(at(answer.damage, -5, -3) > 0, "on the explosion's side of the wall nothing is covered");

    // A round that lands above the wall's top sees over it
    const [over] = await send({ cover: { ...request, id: 4, impactZ: 6 } });
    assert.ok(at(over.damage, -5, 7) > 0, "an explosion 6 m up sees the soldier behind a 2.5 m wall");

    const [outside] = await send({ cover: { ...request, id: 5, impact: [500, 500] } });
    assert.deepEqual(outside, { covered: 5, size: 0 }, "off the landscape");
});

test("heatmap: the positions behind the wall are blocked, those in line with the doorway are clear (voxel walk through the worker)", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const params = { targetZ: 0, elevated: false, shot: STRAIGHT_SHOT, range: 20, cell: 2, rays: 4, elevationLimits: [-90, 90], angleOffset: 0, lifespan: 100, moa: 2 };
    // Rays: 0 east, 1 north (y decreasing), 2 west, 3 south. A target at (x, -44) is north of the wall (y -40 to -39.5):
    // the south ray runs from it through the wall; at x 110 through the doorway (109 to 111, open to 2 m), at x 105 into the wall
    const run = async (x, region = null) => {
        const [ready] = await send({ heatInit: { job: 1, params, target: [x, -44], east: [1, 0], north: [0, -1], region } });
        assert.equal(ready.heatReady, 1);
        assert.equal(ready.exact, false);
        await send({ heatRays: { job: 1, first: 0, size: 4 } });
        const [{ values, computeMs }] = await send({ heatFinish: 1 });
        assert.ok(computeMs >= 0);
        const stride = Math.floor(params.range / params.cell) + 1;
        return (ray) => Array.from(values.subarray(ray * stride + 1, (ray + 1) * stride));
    };
    const clear = (value) => value >= HEAT.CLEAR_MIN;

    // South ray, positions at 2, 4, ..., 20 m: the wall is 4 to 4.5 m from the target; 2 m is north of it (clear) and 4 m
    // stands in the doorway (clear) or in the wall (out: the shooter's body is inside it)
    const throughDoor = (await run(110))(3);
    assert.ok(throughDoor.slice(0, 8).every(clear), `in line with the doorway: ${throughDoor}`);
    const throughWall = (await run(105))(3);
    assert.ok(clear(throughWall[0]), `north of the wall: ${throughWall}`);
    assert.equal(throughWall[1], HEAT.OUT, "a shooter inside the wall does not count");
    // The shooter at 6 m has the wall 1.5 m ahead, inside the 3 m the line of fire is not checked from the muzzle
    assert.deepEqual(throughWall.slice(3, 8), new Array(5).fill(HEAT.BLOCKED), `south of the wall: ${throughWall}`);
    assert.ok(throughDoor[3] > throughDoor[7], "closer is better");

    // Along the wall, a ray east of the target stays on its side of the wall: clear
    assert.ok((await run(110))(0).slice(0, 5).every(clear));
});

test("coverage: a lob of 90 m at the most does not clear a 100 m tower (the top of a structure is found from the tallest column down)", { skip: !engineBuilt }, async () => {
    const send = await startWorker();
    const shot = { velocity: 42, gravity: 9.8, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: false, pivotHeight: 1.5, muzzleForward: 0, muzzleUp: 0 };
    const params = { ground: 0, shot, range: 20, cell: 2, rays: 4, elevationLimits: [-90, 90], holdElevation: null, angleOffset: 0, lifespan: 100, lowOnly: false };
    const northRay = async (x) => {
        globalThis.onmessage({ data: { coverageInit: { job: 1, params, origin: [x, -30], east: [1, 0], north: [0, -1] } } });
        await send({ coverageRays: { job: 1, first: 0, size: 4 } });
        const [{ values }] = await send({ coverageFinish: 1 });
        const stride = Math.floor(params.range / params.cell) + 1;
        return Array.from(values.subarray(stride + 1, 2 * stride));
    };
    // Ray 1 is north (y decreasing). The tower stands 11 to 13 m north of a weapon at x 100.75, none beside it at x 110.75; targets at 2, 4, ..., 20 m
    assert.deepEqual((await northRay(110.75)), new Array(10).fill(COVERAGE.LOW), "no tower: the straight shot clears every target");
    const behindTower = await northRay(100.75);
    assert.ok(behindTower.slice(7).every((value) => value === COVERAGE.BLOCKED), `behind the tower, 16 m and more: ${behindTower}`);
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
