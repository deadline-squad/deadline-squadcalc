/**
 * The radii of a main base's round protection zone (src/js/protectionZone.js) from the layer data of the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { protectionRadii } from "../src/js/protectionZone.js";

test("a protection zone of 150 m with the game's default lock distance: no deployable within 300 m", () => {
    const zone = { deployableLockDistance: 15000, objects: [{ sphereRadius: 15000 }] };
    assert.deepEqual(protectionRadii(zone), { protect: 150, noDeploy: 300 });
});

test("Goose Bay's first main base: the zone's negative scale gives a negative radius, the game's is 236 m", () => {
    // mapAssets.protectionZones[0] of GooseBay_AAS_v1; in the game the sphere of 15000 cm has the scale -1.5759
    const zone = { deployableLockDistance: 15000, objects: [{ sphereRadius: -23637.880859375 }] };
    const { protect, noDeploy } = protectionRadii(zone);
    assert.ok(Math.abs(protect - 236.379) < 0.001, `protect ${protect}`);
    assert.ok(Math.abs(noDeploy - 386.379) < 0.001, `noDeploy ${noDeploy}`);
});
