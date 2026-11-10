/**
 * The map list (src/data/maps.js): the 25 maps whose heights are derived from the Squad dedicated server package,
 * each named once and labelled in every language. A map is picked by its name (the `?map=` URL parameter), never by
 * its position, so the list may change without breaking a saved link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAPS, initMapsProperties } from "../src/data/maps.js";

const LANGUAGES = ["de", "en", "fr", "ru", "uk", "zh"];
const locale = (language, namespace) => JSON.parse(readFileSync(new URL(`../public/locales/${language}/${namespace}.json`, import.meta.url), "utf8"));

initMapsProperties();

test("25 maps, each named once and with a name in every language", () => {
    assert.equal(MAPS.length, 25);
    assert.equal(new Set(MAPS.map((map) => map.name)).size, MAPS.length);
    for (const language of LANGUAGES) {
        const names = locale(language, "maps");
        for (const map of MAPS) assert.ok(names[map.name], `${language}: no name for ${map.name}`);
    }
});


// The landscape of each map in the game (Squad dedicated server build 26005357): the north-west corner of its
// collision components in metres, its size in vertices and the scale of its actor in metres per vertex and per
// height unit. Fallujah is the union of its six streaming proxies. Skorpo's landscape is turned by 2.006 degrees
// about its actor, so its origin is the actor's location.
const GAME_LANDSCAPES = [
    ["AlBasrah", [-2040.01, -2040.0], [4081, 4081], [1.0, 1.0, 1.0]],
    ["Anvil", [-2040.0, -2040.0], [4081, 4081], [0.75, 0.75, 0.45]],
    ["BlackCoast", [-2040.01, -2142.5], [4065, 4065], [1.0039, 1.0039, 0.8]],
    ["Chora", [-2464.0, -1902.0], [8129, 4827], [0.5, 0.5, 4.0]],
    ["Fallujah", [-2040.0, -2040.0], [4081, 4081], [1.0, 1.0, 1.0]],
    ["FoolsRoad", [-1598.1, -1866.3], [2806, 2806], [1.0, 1.0, 3.2]],
    ["GooseBay", [-2032.57, -2032.75], [4065, 4065], [1.0, 1.0, 0.4]],
    ["Gorodok", [-2031.99, -2032.0], [4065, 4065], [1.0, 1.0, 10.0]],
    ["Harju", [-2015.99, -2016.01], [4033, 4033], [1.0, 1.0, 1.0]],
    ["Jensen", [-2040.51, -2040.14], [4081, 4081], [1.0, 1.0, 1.0]],
    ["Kamdesh", [-2016.0, -2016.0], [4033, 4033], [1.0, 1.0, 1.35]],
    ["Kohat", [-2016.02, -2016.0], [4065, 4065], [1.0, 1.0, 0.75]],
    ["Kokan", [-1333.0, -1714.0], [6097, 7367], [0.5, 0.5, 1.0]],
    ["Lashkar", [-2167.0, -2167.0], [4336, 4336], [1.0, 1.0, 1.5]],
    ["Logar", [-1386.04, -1260.06], [2773, 1891], [0.9999, 0.9999, 0.4999]],
    ["Manicouagan", [-2032.22, -2032.1], [4065, 4065], [1.0, 1.0, 3.0]],
    ["Mestia", [-1545.0, -1161.95], [3061, 2551], [1.0, 1.0, 1.2]],
    ["Mutaha", [-1785.02, -1785.0], [4081, 4081], [1.0, 1.0, 0.3]],
    ["Narva", [-2032.0, -2032.0], [4065, 4065], [1.0, 1.0, 1.0]],
    ["Pacific", [-2016.0, -2016.0], [4033, 4033], [1.0, 1.0, 0.28]],
    ["Sanxian", [-2040.0, -2040.0], [4081, 4081], [1.0, 1.0, 1.0]],
    ["Skorpo", [-4811.27, -3947.92], [7113, 5081], [1.2, 1.2, 3.5]],
    ["Sumari", [-682.01, -371.99], [1427, 1055], [1.0, 1.0, 0.75]],
    ["Tallil", [-2285.91, -2285.77], [4573, 4573], [1.0, 1.0, 1.25]],
    ["Yehorivka", [-3301.97, -3302.0], [6351, 6351], [1.0, 1.0, 4.0]],
];

test("the landscape origin, size and scale of every map are the game's (origin in whole metres)", () => {
    assert.equal(GAME_LANDSCAPES.length, MAPS.length);
    for (const [name, origin, size, scale] of GAME_LANDSCAPES) {
        const heightmap = MAPS.find((map) => map.name === name).SDK_data.heightmap;
        for (const axis of [0, 1]) {
            assert.ok(Math.abs(heightmap.origin[axis] - origin[axis]) < 1, `${name}: origin ${heightmap.origin}, the game's ${origin}`);
        }
        assert.deepEqual(heightmap.size, size, `${name}: size`);
        for (const axis of [0, 1, 2]) {
            assert.ok(Math.abs(heightmap.scale[axis] - scale[axis]) < 1e-3, `${name}: scale ${heightmap.scale}, the game's ${scale}`);
        }
    }
});
