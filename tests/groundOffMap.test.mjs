/**
 * The callers of `getHeight` that sample the ground around a point, which may lie off the map or before the
 * heightmap has a height there, pass `none = 0`: the lowest level, which neither the shell nor the explosion meets.
 * The default NaN would read as "no height data" and break the maximum range polygon, the damage field and the
 * coverage. Each test gives them a heightmap that has no height anywhere and expects the ground to be flat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "./stubs/app.mjs";
import { loadWeapon } from "./helpers.mjs";
import { squadWeaponMarker } from "../src/js/squadMarker.js";
import { squadTargetMarker } from "../src/js/squadTargetMarker.js";
import SquadCoverage from "../src/js/squadCoverage.js";

/**
 * What SquadHeightmap.getHeight gives where there is no height: its `none`. A caller that leaves `none` to its default
 * NaN throws here: NaN heights are never a hit, so the maximum range polygon would reach the farthest distance.
 */
const noHeightAnywhere = {
    ready: true,
    getHeight(latlng, none = NaN) {
        if (Number.isNaN(none)) throw new Error("the ground off the map must be given as a number");
        return none;
    },
};
const flatGround = { ready: true, getHeight: () => 0 };

/** The map of the tests: 1 degree is 1 meter, so a LatLng and a displacement in meters are the same numbers */
const mapWith = (heightmap, extra = {}) => ({
    heightmap,
    pixelSize: 1e6,
    fromMeters: (origin, east, north) => ({ lat: origin.lat + north, lng: origin.lng + east }),
    ...extra,
});

/** The vertices of the maximum range polygon `updateWeaponMaxRange` draws for a mortar on `heightmap` */
function maxRangePolygon(heightmap, heightPadding) {
    const { weapon } = loadWeapon("Mortar");
    App.activeWeapon = weapon;
    const markersGroup = { addLayer() {} };
    const marker = {
        map: mapWith(heightmap, { markersGroup }),
        heightPadding,
        maxDistCircleOn: {},
        getLatLng: () => ({ lat: -5e5, lng: 5e5 }),
    };
    squadWeaponMarker.prototype.updateWeaponMaxRange.call(marker, { turnDirectionAngle: 90 });
    return marker.precisionRangeMarker.getLatLngs()[0].map(({ lat, lng }) => [lat, lng]);
}

test("the maximum range polygon sees flat ground where the heightmap has no height", () => {
    assert.deepEqual(maxRangePolygon(noHeightAnywhere, 0), maxRangePolygon(flatGround, 0));
});

test("the maximum range search ends when a height is NaN", () => {
    // A runaway search never returns, so the test cannot time it out from inside: the heightmap throws past a count of
    // reads that the bounded search (4 bearings of at most 32 steps) does not reach
    const readsLimit = 1000;
    let reads = 0;
    const nanEverywhere = {
        ready: true,
        getHeight() {
            if (++reads > readsLimit) throw new Error("the maximum range search does not end");
            return NaN;
        },
    };
    const polygon = maxRangePolygon(nanEverywhere, 0);
    assert.equal(polygon.length, 4);
    assert.ok(polygon.flat().every(Number.isFinite));
});

test("the maximum range polygon counts the height padding from flat ground where the weapon has no height", () => {
    assert.deepEqual(maxRangePolygon(noHeightAnywhere, 20), maxRangePolygon(flatGround, 20));
    assert.notDeepEqual(maxRangePolygon(flatGround, 20), maxRangePolygon(flatGround, 0));
});

test("the heights around a target are flat ground where the heightmap has no height", () => {
    const target = { map: mapWith(noHeightAnywhere) };
    const heights = squadTargetMarker.prototype.heightAround.call(target, { lat: 1, lng: 2 });
    assert.equal(heights(10, -20), 0);
});

test("the coverage samples flat ground where the heightmap has no height", () => {
    const { weapon } = loadWeapon("Mortar");
    App.activeWeapon = weapon;
    let params = null;
    const map = mapWith(noHeightAnywhere, {
        activeWeaponsMarkers: { getLayers: () => [marker] },
        volume: { ready: true, coverage: (computed) => { params = computed; return new Promise(() => {}); } },
    });
    const marker = { getLatLng: () => ({ lat: 0, lng: 0 }), heightPadding: 3 };
    const coverage = Object.assign(Object.create(SquadCoverage.prototype), { map, enabled: true, generation: 0, workers: [] });
    coverage.compute(marker, weapon);
    assert.equal(params.heightAt(30, 40), 0);
    assert.equal(params.ground, 3);
});
