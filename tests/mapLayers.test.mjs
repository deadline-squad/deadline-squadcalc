/**
 * The map layers (src/js/mapLayers.js) against what actually offers them: the buttons of the layer menu, the tooltips
 * of every language and the tile folders the layers read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_LAYER, LAYER_ORDER, TILE_FOLDER_SUFFIX, urlTypeOf } from "../src/js/mapLayers.js";

const MENU = readFileSync(new URL("../src/components/map/map.html", import.meta.url), "utf8");
const LOCALES = new URL("../public/locales/", import.meta.url);
const buttonOf = (layer) => new RegExp(`<button[^>]*class="[^"]*\\bbtn-${layer}\\b[^"]*"[^>]*value="${layer}"[^>]*>`).exec(MENU)?.[0];

test("every layer of the cycle has a button with its value", () => {
    for (const layer of LAYER_ORDER) assert.ok(buttonOf(layer), `no button for ${layer}`);
});

test("every layer button of the menu is in the cycle", () => {
    const values = [...MENU.matchAll(/<button[^>]*\blayers\b[^>]*value="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual([...values].sort(), [...LAYER_ORDER].sort());
});

test("the default layer is visible without knowing the map and is the new map", () => {
    assert.equal(DEFAULT_LAYER, "standard-hd");
    assert.ok(!buttonOf(DEFAULT_LAYER).includes("display: none"), "the default layer's button starts hidden");
    assert.equal(TILE_FOLDER_SUFFIX[DEFAULT_LAYER], "-hd");
});

test("the default layer leaves the URL plain, any other layer is named in it", () => {
    assert.equal(urlTypeOf(DEFAULT_LAYER), null);
    assert.equal(urlTypeOf("basemap"), "basemap");
    assert.equal(urlTypeOf("detailed"), "detailed");
});

test("the plain detailed layer keeps its own folder and the others have folders of their own", () => {
    assert.equal(TILE_FOLDER_SUFFIX.detailed, "");
    const suffixes = Object.values(TILE_FOLDER_SUFFIX);
    assert.equal(new Set(suffixes).size, suffixes.length);
});

test("the new layer has a tooltip in every language", () => {
    for (const language of readdirSync(LOCALES)) {
        const tooltips = JSON.parse(readFileSync(new URL(`${language}/tooltips.json`, LOCALES), "utf8"));
        const text = tooltips.standardhdmode ?? tooltips.tooltips?.standardhdmode;
        assert.ok(text, `${language} has no tooltip`);
    }
});
