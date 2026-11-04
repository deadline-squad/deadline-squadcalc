import { test } from "node:test";
import assert from "node:assert/strict";
import i18next from "i18next";
import { findNearbyStructure, describeStructure, STRUCTURE_RADIUS } from "../src/js/structureInfo.js";
import common from "../public/locales/en/common.json" with { type: "json" };

await i18next.init({ lng: "en", resources: { en: { common } }, interpolation: { escapeValue: false } });

const marker = (icontype, lng, lat = 0) => ({ icontype, getLatLng: () => ({ lat, lng }) });
const mapWith = (...markers) => ({
    activeMarkers: { eachLayer: (callback) => markers.forEach(callback) },
    toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
});
const mortar = { name: "Mortar", shellName: "default", explosion: { outer: 40 } };

test("a target next to a structure's marker finds it, the nearest one first", () => {
    const map = mapWith(marker("deployable_hab", 3), marker("deployable_fob", 1));
    assert.deepEqual(findNearbyStructure(map, { lat: 0, lng: 0 }), { icon: "deployable_fob", distance: 1 });
});

test("markers farther than STRUCTURE_RADIUS, or without a structure in the game data, are not found", () => {
    const map = mapWith(marker("deployable_fob", STRUCTURE_RADIUS + 1), marker("map_tank", 0), marker("deployable_helipad", 0));
    assert.equal(findNearbyStructure(map, { lat: 0, lng: 0 }), null);
});

test("the line names the structure and the shells to destroy it", () => {
    assert.equal(describeStructure("deployable_fob", mortar), "FOB radio: 2");
    assert.equal(describeStructure("deployable_hab", mortar), "HAB: 18");
});

test("the line says there is no structure damage for AP and machine-gun rounds", () => {
    const machineGun = { name: "DF_M2A1_50", shellName: "default", explosion: { outer: 0 } };
    assert.equal(describeStructure("deployable_fob", machineGun), "FOB radio: no structure damage");
});

test("no line for a weapon or a marker the game data does not cover", () => {
    assert.equal(describeStructure("deployable_fob", { name: "M109", shellName: "default", explosion: { outer: 75 } }), null);
    assert.equal(describeStructure("deployable_helipad", mortar), null);
});
