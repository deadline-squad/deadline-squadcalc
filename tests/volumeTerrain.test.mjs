import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { decodeTerrain, terrainHeight } from "../src/js/volumeTerrain.js";

/**
 * A TER2 file (tools/volumetric/py/terrain_raster.py `encode`) for the given levels (row-major, 0 = no landscape)
 * and hole vertex indices, written the way the python does: plane-prediction residuals, zigzag, low then high bytes.
 * With `ter1` the header is the 40-byte one of the files served before (float32 min corner, no yaw).
 */
function ter2(levels, width, height, holes = [], { originX = 100, originY = -50, cell = 2, yawDeg = 0, zMin = -10, step = 0.5, ter1 = false } = {}) {
    const count = width * height;
    let header;
    if (ter1) {
        header = Buffer.alloc(40);
        header.write("TER1", 0, "latin1");
        [originX, originY, cell, zMin, step].forEach((value, i) => header.writeFloatLE(value, 8 + 4 * i));
        [width, height, holes.length].forEach((value, i) => header.writeUInt32LE(value, 28 + 4 * i));
    } else {
        header = Buffer.alloc(56);
        header.write("TER2", 0, "latin1");
        [originX, originY, cell].forEach((value, i) => header.writeDoubleLE(value, 8 + 8 * i));
        [yawDeg, zMin, step].forEach((value, i) => header.writeFloatLE(value, 32 + 4 * i));
        [width, height, holes.length].forEach((value, i) => header.writeUInt32LE(value, 44 + 4 * i));
    }
    const low = Buffer.alloc(count);
    const high = Buffer.alloc(count);
    for (let i = 0; i < count; i++) {
        const left = i % width ? levels[i - 1] : 0;
        const above = i >= width ? levels[i - width] : 0;
        const aboveLeft = i >= width && i % width ? levels[i - width - 1] : 0;
        let residual = (levels[i] - (left + above - aboveLeft)) & 0xFFFF;
        if (residual >= 0x8000) residual -= 0x10000;
        const zigzag = ((residual << 1) ^ (residual >> 15)) & 0xFFFF;
        low[i] = zigzag & 0xFF;
        high[i] = zigzag >> 8;
    }
    const varints = [];
    let previous = 0;
    for (const hole of holes) {
        let value = hole - previous;
        previous = hole;
        while (value >= 0x80) {
            varints.push((value & 0x7F) | 0x80);
            value >>= 7;
        }
        varints.push(value);
    }
    return new Uint8Array(gunzipSync(gzipSync(Buffer.concat([header, low, high, Buffer.from(varints)]))));
}

// Levels 1.. are z = -10 + (level - 1) * 0.5; a 4 x 3 grid with the vertex (col, row) at x = 100 + 2 col, y = -50 + 2 row
const LEVELS = [
    21, 21, 21, 21,
    21, 25, 29, 21,
    21, 21, 21, 40,
];

test("a TER2 file is decoded to its levels, whatever the residual sign", () => {
    const terrain = decodeTerrain(ter2(LEVELS, 4, 3, [], { originX: -2032.569, originY: 1.25 }));
    assert.deepEqual(Array.from(terrain.levels), LEVELS);
    assert.deepEqual([terrain.originX, terrain.originY, terrain.cell, terrain.cos, terrain.sin, terrain.zMin, terrain.step, terrain.width, terrain.height],
        [-2032.569, 1.25, 2, 1, 0, -10, 0.5, 4, 3]);
});

test("a TER1 file of the heightmaps served before is read with its vertex (0, 0) at its min corner", () => {
    const terrain = decodeTerrain(ter2(LEVELS, 4, 3, [], { ter1: true }));
    assert.deepEqual(Array.from(terrain.levels), LEVELS);
    assert.deepEqual([terrain.originX, terrain.originY, terrain.cell, terrain.cos, terrain.sin], [100, -50, 2, 1, 0]);
    assert.equal(terrainHeight(terrain, 102, -48), 2);
});

test("a file with another magic or a missing plane is refused", () => {
    const raw = ter2(LEVELS, 4, 3);
    assert.throws(() => decodeTerrain(raw.subarray(0, 70)), /truncated/);
    assert.throws(() => decodeTerrain(raw.subarray(0, 50)), /not a TER2/);
    const wrong = raw.slice();
    wrong[0] = 0x58;
    assert.throws(() => decodeTerrain(wrong), /not a TER2/);
});

test("heights are the vertices' and follow the game's triangle rule between them", () => {
    const terrain = decodeTerrain(ter2(LEVELS, 4, 3));
    assert.equal(terrainHeight(terrain, 102, -48), 2);
    assert.equal(terrainHeight(terrain, 104, -48), 4);
    assert.equal(terrainHeight(terrain, 100, -50), 0);
    // quad (row 0, col 1) has the levels 21, 21 / 25, 29 and is split from (0, 1) to (1, 2)
    assert.equal(terrainHeight(terrain, 102.5, -48.5), 2, "lower-left triangle: 21 + 4 * 0.75 + 4 * 0.25");
    assert.equal(terrainHeight(terrain, 103.5, -49.5), 1, "upper-right triangle: 21 + 8 * 0.25");
});

test("outside the grid, over a vertex without landscape and in a landscape hole nothing stops a shell", () => {
    const levels = LEVELS.slice();
    levels[6] = 0;
    const terrain = decodeTerrain(ter2(levels, 4, 3, [4]));
    assert.ok(!Number.isNaN(terrainHeight(terrain, 99.5, -49.5)), "within half a cell of the edge is the edge");
    assert.ok(Number.isNaN(terrainHeight(terrain, 90, -48)), "outside");
    assert.ok(Number.isNaN(terrainHeight(terrain, 103, -47)), "a corner of the quad has no landscape");
    assert.ok(Number.isNaN(terrainHeight(terrain, 101, -47)), "the quad whose lower corner is the hole vertex");
    assert.ok(!Number.isNaN(terrainHeight(terrain, 101, -49)), "a quad without hole");
});

test("holes are decoded from several varint bytes", () => {
    const width = 200;
    const levels = new Array(width * 2).fill(30);
    const terrain = decodeTerrain(ter2(levels, width, 2, [3, 190]));
    assert.deepEqual([terrain.holes[3], terrain.holes[190], terrain.holes[4]], [1, 1, 0]);
});

test("a turned grid is read along its own axes: its vertices are where the landscape's are", () => {
    // Skorpo: 1.2 m vertices turned by -2.006195 degrees; vertex (col, row) at origin + col * 1.2 (cos, sin) + row * 1.2 (-sin, cos)
    const yawDeg = -2.006195;
    const yaw = Math.fround(yawDeg) * Math.PI / 180;
    const [cos, sin] = [Math.cos(yaw), Math.sin(yaw)];
    const terrain = decodeTerrain(ter2(LEVELS, 4, 3, [], { originX: -3851.481, originY: -3285.1115, cell: 1.2, yawDeg }));
    const at = (col, row) => [-3851.481 + 1.2 * (col * cos - row * sin), -3285.1115 + 1.2 * (col * sin + row * cos)];
    for (const [col, row] of [[1, 1], [2, 1], [3, 2], [0, 0]]) {
        const expected = -10 + (LEVELS[row * 4 + col] - 1) * 0.5;
        assert.ok(Math.abs(terrainHeight(terrain, ...at(col, row)) - expected) < 1e-9, `vertex (${col}, ${row})`);
    }
    // A point a quarter of a cell along the turned column axis from vertex (1, 1) toward (2, 1): 25 + 4 * 0.25 levels
    assert.ok(Math.abs(terrainHeight(terrain, ...at(1.25, 1)) - (-10 + 25 * 0.5)) < 1e-9);
    // Read as an unturned grid, vertex (3, 2) would be 0.13 m off: between the levels 21 and 40, a metre lower
    const unturned = decodeTerrain(ter2(LEVELS, 4, 3, [], { originX: -3851.481, originY: -3285.1115, cell: 1.2 }));
    assert.ok(terrainHeight(unturned, ...at(3, 2)) < -10 + 39 * 0.5 - 0.5);
});
