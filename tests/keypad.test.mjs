/**
 * Keypad text and keypad entry (src/js/keypad.js, behind squadMinimap.getKP and SquadCalc.getPos) against the game's
 * own text at known world points of eight layers (fixtures/gameKeypads.json): the layers with a minimap of their own
 * (Chora_Skirmish_v1 1007 m and 1222 m from the map image's corner, Mutaha_Skirmish_v1, Goose Bay Seed v1 whose
 * layer runs past the image), Skorpo (9.5 m), Black Coast (1 m) and three maps whose grid starts at the image's corner.
 * The game counts from the loaded layer's own north-west corner, prints the row without padding and joins the parts
 * with " - " (C3 - 3 - 7); the calculator prints C03-3-7 and must read both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAPS, initMapsProperties, gridOffset, gridSize, layerGridOffset, layerGridSize } from "../src/data/maps.js";
import { formatKeyPad, keypadPosition, keypadText } from "../src/js/keypad.js";

initMapsProperties();

const { layers } = JSON.parse(readFileSync(new URL("./fixtures/gameKeypads.json", import.meta.url), "utf8"));
const layerNamed = (name) => layers.find((layer) => layer.layer === name);

/** The map image's north-west corner in world metres */
function imageCorner(mapName) {
    const { corner0, corner1 } = MAPS.find((map) => map.name === mapName).SDK_data.minimap;
    return [Math.min(corner0[0], corner1[0]), Math.min(corner0[1], corner1[1])];
}

/** The grid of a loaded layer as squadLayer.js sets it, from the layer API's corners */
function layerGrid(layer) {
    const minimap = MAPS.find((map) => map.name === layer.map).SDK_data.minimap;
    return { origin: layerGridOffset(minimap, layer.mapTextureCorners), size: layerGridSize(layer.mapTextureCorners) };
}

/** The calculator's form of a game text: no spaces, the row with two digits */
const padded = (text) => text.replace(/\s/g, "").replace(/^([A-Z])(\d+)/, (_, letter, row) => `${letter}${row.padStart(2, "0")}`);

/** keypadText at a world point, as getKP gives it at zoom 4 (two sub-keypads, as many as the game prints) */
function textAt(layer, grid, [x, y]) {
    const [west, north] = imageCorner(layer.map);
    return keypadText(x - west, y - north, grid.origin, grid.size, 4);
}

/** keypadPosition of a text in world metres, as getPos gives it from the image's corner */
function worldOf(layer, grid, text) {
    const [west, north] = imageCorner(layer.map);
    const { east, south } = keypadPosition(text, grid.origin);
    return [west + east, north + south];
}

test("the layer API's corners are the game's, within 1 mm", () => {
    for (const layer of layers) {
        const [first, second] = layer.mapTextureCorners;
        const min = [Math.min(first.location_x, second.location_x) / 100, Math.min(first.location_y, second.location_y) / 100];
        const max = [Math.max(first.location_x, second.location_x) / 100, Math.max(first.location_y, second.location_y) / 100];
        for (const i of [0, 1]) {
            assert.ok(Math.abs(min[i] - layer.game.min[i]) < 1e-3 && Math.abs(max[i] - layer.game.max[i]) < 1e-3, `${layer.layer}: ${min}, ${max}`);
        }
    }
});

test("the keypad text at the corners and the middle of each layer is the game's", () => {
    for (const layer of layers) {
        const grid = layerGrid(layer);
        for (const point of layer.points) {
            assert.equal(textAt(layer, grid, point.at), padded(point.text), `${layer.layer} at ${point.at}`);
        }
    }
});

test("without a layer the map's grid gives the game's text too (Skorpo, 9.5 m east of its image)", () => {
    const skorpo = layerNamed("Skorpo_Invasion_v1");
    const map = MAPS.find((entry) => entry.name === "Skorpo");
    const grid = { origin: gridOffset(map.SDK_data.minimap), size: gridSize(map.SDK_data.minimap) };
    for (const point of skorpo.points) assert.equal(textAt(skorpo, grid, point.at), padded(point.text), `at ${point.at}`);
    // 295 m east and 110 m south of the grid's corner: keypad A1, the image's corner would make it B1
    assert.equal(textAt(skorpo, grid, [-3601.5 + 295, -3293 + 110]), "A01-6-9");
});

test("Chora Skirmish v1: the middle of the layer is C3 - 3 - 7, not the map image's G07-1-7", () => {
    const chora = layerNamed("Chora_Skirmish_v1");
    assert.equal(textAt(chora, layerGrid(chora), [-646.34, -631.51]), "C03-3-7");
});

test("outside the layer the game gives no keypad, and neither does the calculator", () => {
    const chora = layerNamed("Chora_Skirmish_v1");
    const grid = layerGrid(chora);
    for (const at of [[-1460, -600], [170, -600], [-600, -1450], [-600, 180], [-2000, -2000]]) {
        assert.equal(textAt(chora, grid, at), "", `at ${at}`);
    }
    assert.equal(textAt(chora, grid, [chora.game.min[0] + 0.01, chora.game.min[1] + 0.01]), "A01-7-7");
});

test("the game's text, typed as it prints it, lands in the sub-keypad the game names", () => {
    for (const layer of layers) {
        const grid = layerGrid(layer);
        const [west, north] = imageCorner(layer.map).map((corner, i) => corner + grid.origin[i]);
        // the 33.3 m square of the grid a world point is in; at a layer's far edge it can reach past the layer
        const square = ([x, y]) => [Math.floor((x - west) / (300 / 9)), Math.floor((y - north) / (300 / 9))];
        for (const point of layer.points) {
            for (const typed of [point.text, point.text.replace(/\s/g, ""), padded(point.text)]) {
                const landed = worldOf(layer, grid, typed);
                assert.deepEqual(square(landed), square(point.at), `${layer.layer}: "${typed}" lands at ${landed}, the game's point is ${point.at}`);
            }
        }
    }
});

test("Chora Skirmish v1: C03-3-7 and the game's C3-3-7 land within 1 m of the game's C3-3-7 centre", () => {
    const chora = layerNamed("Chora_Skirmish_v1");
    for (const typed of ["C03-3-7", "C3-3-7", "c3 - 3 - 7"]) {
        const [x, y] = worldOf(chora, layerGrid(chora), typed);
        assert.ok(Math.hypot(x - -640.2, y - -625.3) < 1, `"${typed}" at ${x}, ${y}`);
    }
});

test("formatKeyPad keeps the game's unpadded row while it is typed and the calculator's three-character form", () => {
    const cases = [
        ["c3-3-7", "C3-3-7"], ["C3 - 3 - 7", "C3-3-7"], ["C3-37", "C3-3-7"], ["C3--3", "C3-3"],
        ["", ""], ["c", "C"], ["c3", "C3"], ["c3-", "C3-"], ["c3-3", "C3-3"], ["c3-3-", "C3-3-"],
        ["c03", "C03"], ["c03-", "C03-"], ["c033", "C03-3"], ["c0337", "C03-3-7"], ["C03-3-7-5-2", "C03-3-7-5-2"], ["A02352", "A02-3-5-2"],
    ];
    for (const [typed, expected] of cases) {
        assert.equal(formatKeyPad(typed), expected, `"${typed}"`);
        assert.equal(formatKeyPad(expected), expected, `"${expected}" again`);
    }
});

test("keypadPosition: the centre of the deepest sub-keypad from the grid's corner, NaN for a text that is not a keypad", () => {
    assert.deepEqual(keypadPosition("A1", [0, 0]), { east: 150, south: 150 });
    assert.deepEqual(keypadPosition("B02-7", [10, 20]), { east: 10 + 300 + 50, south: 20 + 300 + 50 });
    assert.deepEqual(keypadPosition("A01-3", [0, 0]), { east: 250, south: 250 });
    assert.deepEqual(keypadPosition("C3-", [0, 0]), keypadPosition("C03", [0, 0]));
    for (const text of ["", "3", "A", "A0", "A00-5", "A1-0", "A1-5-X", "AB-5", "-37"]) {
        const position = keypadPosition(text, [0, 0]);
        assert.ok(Number.isNaN(position.east) && Number.isNaN(position.south), `"${text}"`);
    }
});

test("keypadText: zoom sets the depth, from the keypad alone to four sub-keypads", () => {
    const grid = { origin: [0, 0], size: [3000, 3000] };
    const text = (precision) => keypadText(401, 1, grid.origin, grid.size, precision);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 8].map(text), ["B01", "B01", "B01-8", "B01-8-7", "B01-8-7-7", "B01-8-7-7-7", "B01-8-7-7-7"]);
    assert.equal(keypadText(2999, 2999, grid.origin, grid.size, 4), "J10-3-3");
});
