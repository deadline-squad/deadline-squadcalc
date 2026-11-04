/**
 * Leaflet 2 event regressions that need no browser. Leaflet 2.0.0-alpha.1 fires pointerover, pointerout and
 * pointermove, never mouseover, mouseout or mousemove, and a marker stops pointer events from bubbling
 * (`bubblingPointerEvents`, not Leaflet 1's `bubblingMouseEvents`); a handler bound to a Leaflet 1 name
 * never runs (the strat marker's range circle did not appear on hover for months, #1).
 * The behaviour on a real page (hover, drag, clean console) is checked by tools/browser_check/browser_check.mjs
 * of the deployment repository, which needs a served build and Chromium.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Map as LeafletMap, Marker, Circle } from "leaflet";

const sources = new URL("../src/js/", import.meta.url);
const LEGACY_EVENTS = ["mouseover", "mouseout", "mousemove", "mousedown", "mouseup", "dragStart", "dragEnd"];

test("SquadCalc binds no Leaflet 1 event name", () => {
    const pattern = new RegExp(`["'](${LEGACY_EVENTS.join("|")})["']`);
    for (const file of readdirSync(sources).filter((name) => name.endsWith(".js"))) {
        const lines = readFileSync(new URL(file, sources), "utf8").split("\n");
        lines.forEach((line, index) => assert.doesNotMatch(line, pattern, `${file}:${index + 1}: ${line.trim()}`));
    }
});

test("Leaflet 2 lists pointer events, not mouse events, as the ones layers fire from the DOM", () => {
    assert.ok(LeafletMap._pointerEvents.includes("pointerover"));
    assert.ok(LeafletMap._pointerEvents.includes("pointerout"));
    assert.ok(!LeafletMap._pointerEvents.some((type) => type.startsWith("mouse")));
});

test("the option that keeps a marker's events from bubbling to the map is bubblingPointerEvents", () => {
    assert.equal(Marker.prototype.options.bubblingPointerEvents, false);
    assert.equal(Circle.prototype.options.bubblingPointerEvents, true);
    assert.equal("bubblingMouseEvents" in Marker.prototype.options, false);
});
