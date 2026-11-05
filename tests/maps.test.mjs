/**
 * The map list (src/data/maps.js): Belaya Pass, the one map whose heights are community data and not the server
 * package's, is listed, sized from its bounds, flagged, and labelled in every language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAPS, initMapsProperties } from "../src/data/maps.js";

const LANGUAGES = ["de", "en", "fr", "ru", "uk", "zh"];
const locale = (language, namespace) => JSON.parse(readFileSync(new URL(`../public/locales/${language}/${namespace}.json`, import.meta.url), "utf8"));

initMapsProperties();

test("26 maps, each named once and with a name in every language", () => {
    assert.equal(MAPS.length, 26);
    assert.equal(new Set(MAPS.map((map) => map.name)).size, MAPS.length);
    for (const language of LANGUAGES) {
        const names = locale(language, "maps");
        for (const map of MAPS) assert.ok(names[map.name], `${language}: no name for ${map.name}`);
    }
});

test("Belaya is sized from SquadHeight's bounds, which are its heightmap's grid (3905 x 3906 samples of 1 m)", () => {
    const belaya = MAPS.find((map) => map.name === "Belaya");
    assert.deepEqual([belaya.size, belaya.sizeY], [3904, 3905]);
    assert.deepEqual(belaya.SDK_data.heightmap.size, [belaya.size + 1, belaya.sizeY + 1]);
    assert.ok(belaya.SDK_data.heightmapPNG.scale[2] > 0, "the 8-bit fallback needs its metres per level");
});

test("only Belaya is flagged as community terrain, and the notice is worded in every language", () => {
    assert.deepEqual(MAPS.filter((map) => map.communityTerrain).map((map) => map.name), ["Belaya"]);
    for (const language of LANGUAGES) {
        const tooltips = locale(language, "tooltips");
        for (const key of ["communityTerrain", "communityTerrainShort", "communityTerrainDesc"]) assert.ok(tooltips[key], `${language}: ${key}`);
    }
});
