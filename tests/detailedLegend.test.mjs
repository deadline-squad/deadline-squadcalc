/**
 * The Detailed layer's legend (src/js/detailedLegend.js): rows from the tiles' meta.json, and a label for every symbol in
 * every language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { LEGEND_KEYS, legendRows } from "../src/js/detailedLegend.js";

const LOCALES = new URL("../public/locales/", import.meta.url);

test("rows carry the tiles' colours in the tiles' order", () => {
    const rows = legendRows([
        { key: "water_deep", kind: "area", rgb: [92, 142, 192], outline: [62, 112, 168] },
        { key: "contour", kind: "line", rgb: [150, 92, 40] },
    ]);
    assert.deepEqual(rows, [
        { key: "water_deep", kind: "area", colour: "rgb(92, 142, 192)", outline: "rgb(62, 112, 168)" },
        { key: "contour", kind: "line", colour: "rgb(150, 92, 40)", outline: null },
    ]);
});

test("tiles without a legend, and symbols the page cannot name or draw, give no row", () => {
    assert.deepEqual(legendRows(undefined), []);
    assert.deepEqual(legendRows({ key: "contour" }), []);
    assert.deepEqual(legendRows([
        null,
        { key: "unknown_symbol", kind: "area", rgb: [1, 2, 3] },
        { key: "contour", kind: "polygon", rgb: [1, 2, 3] },
        { key: "contour", kind: "line", rgb: [1, 2] },
        { key: "contour", kind: "line", rgb: [1, 2, 300] },
        { key: "contour", kind: "line", rgb: "red" },
    ]), []);
});

test("a malformed outline is dropped, the row stays", () => {
    assert.equal(legendRows([{ key: "deck", kind: "area", rgb: [224, 222, 216], outline: "black" }])[0].outline, null);
});

test("every symbol and the title have a label in every language", () => {
    for (const language of readdirSync(LOCALES)) {
        const labels = JSON.parse(readFileSync(new URL(`${language}/common.json`, LOCALES), "utf8"));
        for (const key of ["legendTitle", ...LEGEND_KEYS.map((name) => `legend_${name}`)]) {
            assert.ok(typeof labels[key] === "string" && labels[key].length > 0, `${language}: common:${key}`);
        }
    }
});

test("the symbol keys are unique", () => {
    assert.equal(new Set(LEGEND_KEYS).size, LEGEND_KEYS.length);
});
