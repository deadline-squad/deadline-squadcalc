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
