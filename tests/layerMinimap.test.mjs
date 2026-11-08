/**
 * The place of a gameplay layer's own minimap on the map image (src/js/layerMinimap.js). A Seed or Skirmish layer
 * ships a 4096 px texture that the game stretches between the layer's MapTextureCorner0/1 (centimetres, read from the
 * layer data of the API); the image is drawn there above the image of the whole map. The Mutaha Seed v1 figures
 * are the corners of the game files (client build 26234431) and the place found by matching the texture's edges
 * against the whole-map texture (633.6 m east, 581.1 m south of the map image's north-west corner, 1300 m square).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAPS, initMapsProperties } from "../src/data/maps.js";
import { layerMinimapBounds } from "../src/js/layerMinimap.js";

initMapsProperties();

const PIXEL_SIZE = 256;
const scaleOf = (map) => [PIXEL_SIZE / map.size, PIXEL_SIZE / map.sizeY];
const mapNamed = (name) => MAPS.find((map) => map.name === name);
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const SEED_CORNERS = [
    { point: 0, location_x: -30138.701171875, location_y: 74150.875 },
    { point: 1, location_x: 99858.09375, location_y: -55846.078125 },
];

test("Mutaha Seed v1: the rectangle of the layer's corners, in map units", () => {
    const mutaha = mapNamed("Mutaha");
    const [scaleX, scaleY] = scaleOf(mutaha);
    const [[north, west], [south, east]] = layerMinimapBounds(mutaha.SDK_data.minimap, SEED_CORNERS, scaleX, scaleY);
    // x from -301.387 m to 998.581 m, y from -558.461 m to 741.509 m; the image starts at (-935, -1140) m, 2755 m wide
    near(west, (-301.38701 + 935) * PIXEL_SIZE / 2755, 1e-6);
    near(east, (998.5809375 + 935) * PIXEL_SIZE / 2755, 1e-6);
    near(north, -(-558.46078 + 1140) * PIXEL_SIZE / 2755, 1e-6);
    near(south, -(741.50875 + 1140) * PIXEL_SIZE / 2755, 1e-6);
    // 1300 m square
    near((east - west) / scaleX, 1299.97, 0.01);
    near((north - south) / scaleY, 1299.97, 0.01);
});

test("the place matches the one found by registering the texture on the whole map", () => {
    const mutaha = mapNamed("Mutaha");
    const [scaleX, scaleY] = scaleOf(mutaha);
    const [[north, west]] = layerMinimapBounds(mutaha.SDK_data.minimap, SEED_CORNERS, scaleX, scaleY);
    // the registration has the resolution of one pixel of the 4096 px whole-map texture: 0.67 m
    near(west / scaleX, 633.6, 0.7);
    near(-north / scaleY, 581.1, 0.7);
});

test("the order of the two corners does not matter", () => {
    const mutaha = mapNamed("Mutaha");
    const [scaleX, scaleY] = scaleOf(mutaha);
    const swapped = [SEED_CORNERS[1], SEED_CORNERS[0]];
    assert.deepEqual(
        layerMinimapBounds(mutaha.SDK_data.minimap, swapped, scaleX, scaleY),
        layerMinimapBounds(mutaha.SDK_data.minimap, SEED_CORNERS, scaleX, scaleY),
    );
});

test("a layer whose corners are the map's own covers the whole image", () => {
    const basrah = mapNamed("AlBasrah");
    const corners = [{ location_x: -200000, location_y: -200000 }, { location_x: 200000, location_y: 200000 }];
    const [scaleX, scaleY] = scaleOf(basrah);
    const [[north, west], [south, east]] = layerMinimapBounds(basrah.SDK_data.minimap, corners, scaleX, scaleY);
    near(west, 0, 1e-9);
    near(north, 0, 1e-9);
    near(east, PIXEL_SIZE, 1e-9);
    near(south, -PIXEL_SIZE, 1e-9);
});
