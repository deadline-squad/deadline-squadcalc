/**
 * The in-game-style grid (src/js/squadGrid.js) and the constants it is built from (src/data/maps.js).
 * The game starts its grid (A1) at the north-west corner of the minimap, MapTextureCorner0/1 of the layer's
 * SQWorldSettings (Squad dedicated server build 26005357, read by the deployment repository's tools/heightmaps
 * extractor); keypads are 300 m squares split in 3 x 3 sub-keypads, three levels in
 * UI/Widgets/Map/Grids/W_SQMapGridLines (ScaleFactor 1, 3, 9). The image extent of a map (`corner0`/`corner1`) can
 * differ from the game's corners, so the grid takes its origin from `SDK_data.minimap.game` or from the layer.
 * The grid covers the game's minimap only (a Seed or Skirmish layer's is a part of the map), and its letter and number
 * bars (W_SQMapHorizontalBar/VerticalBar) label the strip left after the last whole keypad too; the game's labels and
 * line counts of eight layers are in fixtures/gameKeypads.json (see keypad.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAPS, initMapsProperties, gridOffset, gridSize, layerGridOffset, layerGridSize } from "../src/data/maps.js";
import SquadGrid from "../src/js/squadGrid.js";

initMapsProperties();
globalThis.document = { querySelectorAll: () => [] };

const SCALE = 0.5;
const map = { gameToMapScale: SCALE, gameToMapScaleY: SCALE, activeMap: { size: 4000 }, getZoom: () => 3 };

/** A grid over a 4000 m square image (2000 map units) from `offset` metres in from its north-west corner, `size` metres across (to the image's far edges by default). */
function drawnGrid(offset = [0, 0], size = [4000 - offset[0], 4000 - offset[1]]) {
    const grid = new SquadGrid(map, {});
    grid.map = map;
    grid.bounds = { getWest: () => 0, getEast: () => 4000 * SCALE, getNorth: () => 0, getSouth: () => -4000 * SCALE };
    grid.setArea(offset, size);
    return grid;
}

const keypadLongitudes = (grid) => grid.kpLines.map((line) => line.getLatLngs()[0].lng).filter((lng, i, all) => all.indexOf(lng) === i);
const letters = (grid) => grid.labels.filter((label) => /^[A-Z]$/.test(label.options.icon.options.html)).map((label) => label.options.icon.options.html);

test("without an origin the keypad lines are 300 m apart from the corner and column letters start at A", () => {
    const grid = drawnGrid();
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

const { layers } = JSON.parse(readFileSync(new URL("./fixtures/gameKeypads.json", import.meta.url), "utf8"));
const PIXELS = 256;

/** A layer's grid as squadMinimap.js and squadLayer.js draw it, over a 256-unit map image, with its lines and labels in world metres */
function layerGrid(layer) {
    const entry = MAPS.find((candidate) => candidate.name === layer.map);
    const { corner0, corner1 } = entry.SDK_data.minimap;
    const [west, north] = [Math.min(corner0[0], corner1[0]), Math.min(corner0[1], corner1[1])];
    const scaled = { gameToMapScale: PIXELS / entry.size, gameToMapScaleY: PIXELS / entry.sizeY, activeMap: entry, getZoom: () => 3 };
    const grid = new SquadGrid(scaled, {});
    grid.map = scaled;
    grid.bounds = { getWest: () => 0, getEast: () => PIXELS, getNorth: () => 0, getSouth: () => -PIXELS };
    grid.setArea(layerGridOffset(entry.SDK_data.minimap, layer.mapTextureCorners), layerGridSize(layer.mapTextureCorners));
    const x = (lng) => west + lng / scaled.gameToMapScale;
    const y = (lat) => north - lat / scaled.gameToMapScaleY;
    const lines = (list) => list.map((line) => line.getLatLngs().map((point) => [x(point.lng), y(point.lat)]));
    const along = (list, axis) => lines(list).filter(([a, b]) => a[axis] === b[axis]);
    const image = { min: [west, north], max: [west + entry.size, north + entry.sizeY] };
    return {
        image,
        columns: grid.labels.filter((label) => typeof label.options.icon.options.html === "string").map((label) => ({ text: label.options.icon.options.html, at: x(label.getLatLng().lng), edge: y(label.getLatLng().lat) })),
        rows: grid.labels.filter((label) => typeof label.options.icon.options.html === "number").map((label) => ({ text: String(label.options.icon.options.html), at: y(label.getLatLng().lat), edge: x(label.getLatLng().lng) })),
        x: [grid.kpLines, grid.s1Lines, grid.s2Lines].map((list) => along(list, 0)),
        y: [grid.kpLines, grid.s1Lines, grid.s2Lines].map((list) => along(list, 1)),
    };
}

test("the last column and row are labelled over the strip left after the last whole keypad (Al Basrah N and 14, Fallujah K and 11 over 5 m)", () => {
    for (const [name, column, row, middle] of [["AlBasrah_AAS_v1", "N", "14", [1950, 1950]], ["Fallujah_AAS_v1", "K", "11", [1687.5, 1457.5]]]) {
        const drawn = layerGrid(layers.find((layer) => layer.layer === name));
        assert.deepEqual([drawn.columns.at(-1).text, drawn.rows.at(-1).text], [column, row], name);
        assert.ok(Math.abs(drawn.columns.at(-1).at - middle[0]) < 0.01 && Math.abs(drawn.rows.at(-1).at - middle[1]) < 0.01, `${name}: ${drawn.columns.at(-1).at}, ${drawn.rows.at(-1).at}`);
    }
});

test("the letters and numbers are the game's on every layer, at the game's places", () => {
    for (const layer of layers.filter((entry) => entry.map !== "Mestia")) {
        const drawn = layerGrid(layer);
        for (const kind of ["columns", "rows"]) {
            assert.deepEqual(drawn[kind].map((label) => label.text), layer.labels[kind].map((label) => label.text), `${layer.layer} ${kind}`);
            drawn[kind].forEach((label, i) => assert.ok(Math.abs(label.at - layer.labels[kind][i].at) < 0.01, `${layer.layer} ${label.text} at ${label.at}, the game's at ${layer.labels[kind][i].at}`));
        }
    }
});

test("Mestia, a whole 8 x 8 keypads: H and 8 stay over their columns, where the game's empty last slot moves A-G up to 279 m", () => {
    const layer = layers.find((entry) => entry.map === "Mestia");
    const drawn = layerGrid(layer);
    for (const kind of ["columns", "rows"]) {
        assert.deepEqual(drawn[kind].map((label) => label.text), layer.labels[kind].map((label) => label.text));
        drawn[kind].forEach((label, i) => assert.ok(Math.abs(label.at - (layer.game.min[kind === "columns" ? 0 : 1] + 150 + 300 * i)) < 0.01, `${label.text} at ${label.at}`));
    }
    const drift = Math.max(...drawn.columns.map((label, i) => Math.abs(label.at - layer.labels.columns[i].at)).slice(0, 7));
    assert.ok(Math.abs(drift - 278.57) < 0.01, `${drift}`);
});

test("the grid covers the layer only: its lines end at the layer's edges and the labels sit along its north and west edges", () => {
    const chora = layerGrid(layers.find((layer) => layer.layer === "Chora_Skirmish_v1"));
    const [min, max] = [[-1456.8422, -1442.0139], [163.15789, 177.98627]];
    for (const line of [...chora.x, ...chora.y].flat()) {
        for (const [px, py] of line) assert.ok(px >= min[0] - 1e-3 && px <= max[0] + 1e-3 && py >= min[1] - 1e-3 && py <= max[1] + 1e-3, `a line point at ${px}, ${py}`);
    }
    assert.ok(chora.columns.every((label) => Math.abs(label.edge - min[1]) < 1e-3) && chora.rows.every((label) => Math.abs(label.edge - min[0]) < 1e-3));
    assert.deepEqual(chora.columns.map((label) => label.text), ["A", "B", "C", "D", "E", "F"]);
    assert.deepEqual(chora.rows.map((label) => label.text), ["1", "2", "3", "4", "5", "6"]);
});

test("each level has as many lines as the game's over every layer inside the map image", () => {
    let compared = 0;
    for (const layer of layers) {
        const drawn = layerGrid(layer);
        if ([0, 1].some((i) => layer.game.min[i] < drawn.image.min[i] - 1e-3 || layer.game.max[i] > drawn.image.max[i] + 1e-3)) continue;
        assert.deepEqual(drawn.x.map((list) => list.length), layer.lines.x, `${layer.layer} north-south lines`);
        assert.deepEqual(drawn.y.map((list) => list.length), layer.lines.y, `${layer.layer} east-west lines`);
        compared++;
    }
    assert.ok(compared >= 5, `${compared} layers inside their image`);
});

test("without a layer the grid covers the game's minimap of the map (Skorpo: 6850 m by 6869 m from 9.5 m east of its image)", () => {
    const skorpo = MAPS.find((entry) => entry.name === "Skorpo");
    const [width, height] = gridSize(skorpo.SDK_data.minimap);
    assert.ok(Math.abs(width - 6850) < 1e-6 && Math.abs(height - 6869.08) < 1e-6, `${width}, ${height}`);
    assert.deepEqual(gridSize({ corner0: [-10, 40], corner1: [30, -20] }), [40, 60]);
    assert.deepEqual(layerGridSize([{ location_x: 1000, location_y: -500 }, { location_x: -1000, location_y: 1500 }]), [20, 20]);
});
