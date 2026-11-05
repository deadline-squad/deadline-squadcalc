/**
 * The in-game-style grid (src/js/squadGrid.js) and the constants it is built from (src/data/maps.js).
 * The game starts its grid (A1) at the north-west corner of the minimap, MapTextureCorner0/1 of the layer's
 * SQWorldSettings (Squad dedicated server build 26005357, read by the deployment repository's tools/heightmaps
 * extractor); keypads are 300 m squares split in 3 x 3 sub-keypads, three levels in
 * UI/Widgets/Map/Grids/W_SQMapGridLines (ScaleFactor 1, 3, 9). The image extent of a map (`corner0`/`corner1`) can
 * differ from the game's corners, so the grid takes its origin from `SDK_data.minimap.game` or from the layer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAPS, initMapsProperties, gridOffset, layerGridOffset } from "../src/data/maps.js";
import SquadGrid from "../src/js/squadGrid.js";

initMapsProperties();
globalThis.document = { querySelectorAll: () => [] };

const SCALE = 0.5;
const map = { gameToMapScale: SCALE, gameToMapScaleY: SCALE, activeMap: { size: 4000 }, getZoom: () => 3 };

/** A grid over a 4000 m square image (2000 map units) with the origin `offset` metres in from its north-west corner. */
function drawnGrid(offset) {
    const grid = new SquadGrid(map, {});
    grid.map = map;
    grid.bounds = { getWest: () => 0, getEast: () => 4000 * SCALE, getNorth: () => 0, getSouth: () => -4000 * SCALE };
    grid.originOffset = offset;
    grid.redraw();
    return grid;
}

const keypadLongitudes = (grid) => grid.kpLines.map((line) => line.getLatLngs()[0].lng).filter((lng, i, all) => all.indexOf(lng) === i);
const letters = (grid) => grid.labels.filter((label) => /^[A-Z]$/.test(label.options.icon.options.html)).map((label) => label.options.icon.options.html);

test("without an origin the keypad lines are 300 m apart from the corner and column letters start at A", () => {
    const grid = drawnGrid(undefined);
    assert.deepEqual(keypadLongitudes(grid).slice(0, 3), [0, 150, 300]);
    assert.deepEqual(letters(grid).slice(0, 3), ["A", "B", "C"]);
    assert.equal(grid.s1Lines.length > 0 && grid.s2Lines.length > 0, true);
});

test("the grid starts at the game's corner: 9.5 m east of the image corner shifts every line and drops what is west of it", () => {
    const grid = drawnGrid([9.5, 0]);
    const lines = keypadLongitudes(grid);
    assert.ok(Math.abs(lines[0] - 9.5 * SCALE) < 1e-9, `first line at ${lines[0]}`);
    assert.ok(Math.abs(lines[1] - (9.5 + 300) * SCALE) < 1e-9);
    assert.deepEqual(letters(grid).slice(0, 2), ["A", "B"]);
    const vertical = grid.s2Lines.filter((line) => line.getLatLngs()[0].lng === line.getLatLngs()[1].lng);
    assert.ok(vertical.length > 0 && vertical.every((line) => line.getLatLngs()[0].lng >= 9.5 * SCALE - 1e-9));
});

test("rows start at the game's corner too and are numbered from 1", () => {
    const grid = drawnGrid([0, 40]);
    const rows = grid.kpLines.map((line) => line.getLatLngs()[0].lat).filter((lat, i, all) => all.indexOf(lat) === i && lat !== undefined);
    assert.ok(rows.some((lat) => Math.abs(lat - -40 * SCALE) < 1e-9), "a keypad row line 40 m south of the image corner");
    assert.ok(!rows.some((lat) => Math.abs(lat) < 1e-9), "no line at the image corner");
    const numbers = grid.labels.map((label) => label.options.icon.options.html).filter((html) => typeof html === "number");
    assert.deepEqual(numbers.slice(0, 3), [1, 2, 3]);
});

test("every map's game corners are within 1 m of its image corners, except Skorpo's fitted image (10.5 m)", () => {
    for (const map of MAPS) {
        const { corner0, corner1, game } = map.SDK_data.minimap;
        assert.ok(game, `${map.name}: no game corners`);
        const imageMin = [Math.min(corner0[0], corner1[0]), Math.min(corner0[1], corner1[1])];
        const imageMax = [Math.max(corner0[0], corner1[0]), Math.max(corner0[1], corner1[1])];
        const worst = Math.max(...[0, 1].flatMap((i) => [Math.abs(game.min[i] - imageMin[i]), Math.abs(game.max[i] - imageMax[i])]));
        assert.ok(worst <= (map.name === "Skorpo" ? 10.5 : 1.0), `${map.name}: ${worst} m`);
    }
});

test("grid offsets: Skorpo's grid starts 9.5 m east of its image, a Chora Skirmish layer 1007 m east and 1222 m south", () => {
    const skorpo = MAPS.find((map) => map.name === "Skorpo");
    assert.deepEqual(skorpo.gridOffset, [9.5, 0]);
    const chora = MAPS.find((map) => map.name === "Chora");
    const skirmish = [
        { location_x: -145684.21875, location_y: -144201.390625 },
        { location_x: 16315.7890625, location_y: 17798.626953125 },
    ];
    const [east, south] = layerGridOffset(chora.SDK_data.minimap, skirmish);
    assert.ok(Math.abs(east - 1007.16) < 0.01 && Math.abs(south - 1221.99) < 0.01, `${east}, ${south}`);
    assert.deepEqual(gridOffset({ corner0: [-10, -20], corner1: [30, 40] }), [0, 0]);
});
