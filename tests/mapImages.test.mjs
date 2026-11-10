/**
 * Where the map pictures lie on the map (src/js/mapImages.js, src/js/stretchedTileLayer.js). The map is a square of 256
 * units over the image corners corner0/1 of maps.js; a picture of the game's minimap is drawn over the world rectangle it
 * shows: a layer's own minimap over the corners of the layer-minimaps manifest (the layer's data asset over its level,
 * Squad client build 26234431), the upstream basemap over the game's unrounded corners, on Skorpo over the rectangle
 * its texture was measured to show on the level data (the texture's edges on the objects, crowns and roads of the level
 * in 33 windows, confirmed by its own shading against the ground in 34). The Mutaha Seed v1 place was found by
 * matching the texture's edges against the whole-map texture (633.6 m east, 581.1 m south of the image corner).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Point, TileLayer } from "leaflet";
import { MAPS, initMapsProperties } from "../src/data/maps.js";
import { rectangleBounds, upstreamImageRectangle, upstreamTileTransform } from "../src/js/mapImages.js";
import { StretchedTileLayer } from "../src/js/stretchedTileLayer.js";

initMapsProperties();

const PIXEL_SIZE = 256;
const scaleOf = (map) => [PIXEL_SIZE / map.size, PIXEL_SIZE / map.sizeY];
const mapNamed = (name) => MAPS.find((map) => map.name === name);
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
/** World X, Y (metres) of a point of the map in map units east and south of its north-west corner */
const worldOf = (map, east, south) => {
    const { corner0, corner1 } = map.SDK_data.minimap;
    return [Math.min(corner0[0], corner1[0]) + east * map.size / PIXEL_SIZE, Math.min(corner0[1], corner1[1]) + south * map.sizeY / PIXEL_SIZE];
};

// Entries of the layer-minimaps manifest (tools/maptiles layer_minimaps.py over client build 26234431)
const MUTAHA_SEED = { texture: "Mutaha_Minimap_Seed_v1", min: [-301.38701, -558.4608], max: [998.5809, 741.50875] };
const BLACKCOAST_SEED = { texture: "T_BlackCoast_Seed_v1", min: [-950.0, -1200.0], max: [50.0, -200.0] };
// Skorpo_Minimap_RAAS_v3_fix (the upstream basemap) on the world
const SKORPO_IMAGE = { min: [-3611.1, -3291.8], max: [3257.7, 3575.8] };

test("Mutaha Seed v1: the rectangle of the manifest, in map units", () => {
    const mutaha = mapNamed("Mutaha");
    const [scaleX, scaleY] = scaleOf(mutaha);
    const [[north, west], [south, east]] = rectangleBounds(mutaha.SDK_data.minimap, MUTAHA_SEED, scaleX, scaleY);
    // the image starts at (-935, -1140) m and is 2755 m wide
    near(west, (-301.38701 + 935) * PIXEL_SIZE / 2755, 1e-6);
    near(east, (998.5809 + 935) * PIXEL_SIZE / 2755, 1e-6);
    near(north, -(-558.4608 + 1140) * PIXEL_SIZE / 2755, 1e-6);
    near(south, -(741.50875 + 1140) * PIXEL_SIZE / 2755, 1e-6);
    near((east - west) / scaleX, 1299.97, 0.01);
    near((north - south) / scaleY, 1299.97, 0.01);
    // the registration has the resolution of one pixel of the 4096 px whole-map texture: 0.67 m
    near(west / scaleX, 633.6, 0.7);
    near(-north / scaleY, 581.1, 0.7);
});

test("Black Coast Seed v1: the game's texture of the layer is drawn over the layer data's corners", () => {
    const blackCoast = mapNamed("BlackCoast");
    const [scaleX, scaleY] = scaleOf(blackCoast);
    const [[north, west], [south, east]] = rectangleBounds(blackCoast.SDK_data.minimap, BLACKCOAST_SEED, scaleX, scaleY);
    // the image starts at (-2299, -2127) m: the layer's 1000 m square lies 1349 m east and 927 m south of it
    near(west / scaleX, 1349, 1e-9);
    near(-north / scaleY, 927, 1e-9);
    near((east - west) / scaleX, 1000, 1e-9);
    near((north - south) / scaleY, 1000, 1e-9);
});

test("a rectangle equal to the image corners covers the whole map", () => {
    const basrah = mapNamed("AlBasrah");
    const [scaleX, scaleY] = scaleOf(basrah);
    const [[north, west], [south, east]] = rectangleBounds(basrah.SDK_data.minimap, { min: [-2000, -2000], max: [2000, 2000] }, scaleX, scaleY);
    near(west, 0, 1e-9);
    near(north, 0, 1e-9);
    near(east, PIXEL_SIZE, 1e-9);
    near(south, -PIXEL_SIZE, 1e-9);
});

test("the upstream basemap is drawn over the game's corners, not over the rounded image corners", () => {
    const blackCoast = mapNamed("BlackCoast");
    assert.deepEqual(upstreamImageRectangle(blackCoast.SDK_data.minimap), { min: [-2300.0, -2127.47], max: [2299.98, 2472.51] });
    const [scaleX, scaleY] = scaleOf(blackCoast);
    const [[north, west], [south, east]] = rectangleBounds(blackCoast.SDK_data.minimap, upstreamImageRectangle(blackCoast.SDK_data.minimap), scaleX, scaleY);
    // 1 m west and 0.47 m north of the corner the frame was rounded to, 0.98 m east and 0.51 m south of the other
    near(west / scaleX, -1.0, 1e-9);
    near(-north / scaleY, -0.47, 1e-9);
    near(east / scaleX - blackCoast.size, 0.98, 1e-9);
    near(-south / scaleY - blackCoast.sizeY, 0.51, 1e-9);
});

test("Skorpo's basemap is drawn over the rectangle its texture shows on the world, 6868.8 m wide", () => {
    const skorpo = mapNamed("Skorpo");
    assert.deepEqual(upstreamImageRectangle(skorpo.SDK_data.minimap), SKORPO_IMAGE);
    const [scaleX, scaleY] = scaleOf(skorpo);
    const [[north, west], [south, east]] = rectangleBounds(skorpo.SDK_data.minimap, SKORPO_IMAGE, scaleX, scaleY);
    near(west / scaleX, -0.1, 1e-9);
    near(-north / scaleY, 1.2, 1e-9);
    // its east edge lies 19.7 m east of the image corner 3238 m, past the game's minimap (3248.5 m)
    near(east / scaleX - skorpo.size, 19.7, 1e-9);
    near((east - west) / scaleX, 6868.8, 1e-9);
    near(-south / scaleY - skorpo.sizeY, -0.2, 1e-9);
});

test("a map without the game's corners shows its images over the image corners", () => {
    assert.deepEqual(upstreamImageRectangle({ corner0: [3048, 3048], corner1: [-3302, -3302] }), { min: [-3302, -3302], max: [3048, 3048] });
});

test("the HQ tiles of a map whose image corners are the game's are drawn on their grid", () => {
    for (const name of ["AlBasrah", "Anvil", "Fallujah", "Harju", "Jensen", "Kamdesh", "Kohat", "Lashkar", "Mestia", "Mutaha", "Pacific", "Sanxian", "Tallil"]) {
        assert.equal(upstreamTileTransform(mapNamed(name).SDK_data.minimap, PIXEL_SIZE), null, name);
    }
});

test("on every map the HQ tiles' grid is stretched onto the rectangle their picture shows", () => {
    for (const map of MAPS) {
        const minimap = map.SDK_data.minimap;
        const transform = upstreamTileTransform(minimap, PIXEL_SIZE) ?? { offset: [0, 0], scale: [1, 1] };
        const rectangle = upstreamImageRectangle(minimap);
        // the grid's corners (0 and 256 units) are drawn at the rectangle's corners
        for (const [grid, corner] of [[0, rectangle.min], [PIXEL_SIZE, rectangle.max]]) {
            const [x, y] = worldOf(map, transform.offset[0] + transform.scale[0] * grid, transform.offset[1] + transform.scale[1] * grid);
            near(x, corner[0], 0.005);
            near(y, corner[1], 0.005);
        }
    }
});

test("Skorpo: a feature in the middle of the HQ tiles is drawn where it lies on the world", () => {
    const skorpo = mapNamed("Skorpo");
    const { offset, scale } = upstreamTileTransform(skorpo.SDK_data.minimap, PIXEL_SIZE);
    // the tiles' centre is the texture's centre, which shows the world point at the middle of its rectangle
    const [x, y] = worldOf(skorpo, offset[0] + scale[0] * 128, offset[1] + scale[1] * 128);
    near(x, (SKORPO_IMAGE.min[0] + SKORPO_IMAGE.max[0]) / 2, 1e-9);
    near(y, (SKORPO_IMAGE.min[1] + SKORPO_IMAGE.max[1]) / 2, 1e-9);
    near(scale[0], 6868.8 / 6849, 1e-12);
});

/** A tile level and the map around it, as GridLayer._setZoomTransform reads them */
const levelAt = (zoom, origin) => ({ el: { style: {} }, origin: new Point(...origin), zoom });
const fakeMap = (pixelOrigin) => ({
    getZoomScale: (to, from) => 2 ** (to - from),
    _getNewPixelOrigin: () => new Point(...pixelOrigin),
});
const transformOf = (level) => {
    const match = /translate3d\((-?[\d.]+)px,(-?[\d.]+)px,0\) scale\(([\d.e-]+),([\d.e-]+)\)/.exec(level.el.style.transform);
    return match.slice(1).map(Number);
};

test("the stretched tile layer puts a tile's pixel where the transform draws its map point", () => {
    const transform = { offset: [0.0037, 0.0373], scale: [1.0028325, 0.9999] };
    const layer = new StretchedTileLayer("{z}/{x}_{y}.webp", { transform });
    layer._map = fakeMap([5000, 7000]);
    const level = levelAt(5, [4800, 6900]);
    // the map at zoom 6, one zoom past the level's tiles
    layer._setZoomTransform(level, null, 6);
    const [tx, ty, sx, sy] = transformOf(level);
    // the pixel (100, 50) of the level is the map point (4900, 6950) / 2^5; at zoom 6 it must lie at
    // (offset + scale * point) * 2^6 minus the pixel origin
    const point = [(4800 + 100) / 32, (6900 + 50) / 32];
    near(tx + sx * 100, (transform.offset[0] + transform.scale[0] * point[0]) * 64 - 5000, 0.5);
    near(ty + sy * 50, (transform.offset[1] + transform.scale[1] * point[1]) * 64 - 7000, 0.5);
    near(sx, 2 * transform.scale[0], 1e-12);
    near(sy, 2 * transform.scale[1], 1e-12);
});

test("with the identity transform the stretched tile layer moves a level as Leaflet does", () => {
    const stretched = new StretchedTileLayer("{z}/{x}_{y}.webp", { transform: { offset: [0, 0], scale: [1, 1] } });
    const plain = new TileLayer("{z}/{x}_{y}.webp");
    stretched._map = plain._map = fakeMap([5000, 7000]);
    const ours = levelAt(5, [4800, 6900]);
    const leaflets = levelAt(5, [4800, 6900]);
    stretched._setZoomTransform(ours, null, 5.5);
    plain._setZoomTransform(leaflets, null, 5.5);
    const [tx, ty, sx, sy] = transformOf(ours);
    const expected = /translate3d\((-?[\d.]+)px, ?(-?[\d.]+)px, ?0(?:px)?\) scale\(([\d.]+)\)/.exec(leaflets.el.style.transform).slice(1).map(Number);
    assert.deepEqual([tx, ty, sx, sy], [expected[0], expected[1], expected[2], expected[2]]);
});
