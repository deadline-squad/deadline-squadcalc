import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { decodeTerrain, terrainHeight } from "../src/js/volumeTerrain.js";

/**
 * A TER1 file (tools/volumetric/py/terrain_raster.py `encode`) for the given levels (row-major, 0 = no landscape)
 * and hole vertex indices, written the way the python does: plane-prediction residuals, zigzag, low then high bytes
 */
function ter1(levels, width, height, holes = [], { minX = 100, minY = -50, cell = 2, zMin = -10, step = 0.5 } = {}) {
    const count = width * height;
    const header = Buffer.alloc(40);
    header.write("TER1", 0, "latin1");
    [minX, minY, cell, zMin, step].forEach((value, i) => header.writeFloatLE(value, 8 + 4 * i));
    [width, height, holes.length].forEach((value, i) => header.writeUInt32LE(value, 28 + 4 * i));
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

test("a TER1 file is decoded to its levels, whatever the residual sign", () => {
    const terrain = decodeTerrain(ter1(LEVELS, 4, 3));
    assert.deepEqual(Array.from(terrain.levels), LEVELS);
    assert.deepEqual([terrain.minX, terrain.minY, terrain.cell, terrain.zMin, terrain.step, terrain.width, terrain.height], [100, -50, 2, -10, 0.5, 4, 3]);
});

test("a file with another magic or a missing plane is refused", () => {
    const raw = ter1(LEVELS, 4, 3);
    assert.throws(() => decodeTerrain(raw.subarray(0, 50)), /truncated/);
    const wrong = raw.slice();
    wrong[0] = 0x58;
    assert.throws(() => decodeTerrain(wrong), /not a TER1/);
});

test("heights are the vertices' and follow the game's triangle rule between them", () => {
    const terrain = decodeTerrain(ter1(LEVELS, 4, 3));
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
    const terrain = decodeTerrain(ter1(levels, 4, 3, [4]));
    assert.ok(!Number.isNaN(terrainHeight(terrain, 99.5, -49.5)), "within half a cell of the edge is the edge");
    assert.ok(Number.isNaN(terrainHeight(terrain, 90, -48)), "outside");
    assert.ok(Number.isNaN(terrainHeight(terrain, 103, -47)), "a corner of the quad has no landscape");
    assert.ok(Number.isNaN(terrainHeight(terrain, 101, -47)), "the quad whose lower corner is the hole vertex");
    assert.ok(!Number.isNaN(terrainHeight(terrain, 101, -49)), "a quad without hole");
});

test("holes are decoded from several varint bytes", () => {
    const width = 200;
    const levels = new Array(width * 2).fill(30);
    const terrain = decodeTerrain(ter1(levels, width, 2, [3, 190]));
    assert.deepEqual([terrain.holes[3], terrain.holes[190], terrain.holes[4]], [1, 1, 0]);
});
