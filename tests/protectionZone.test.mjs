/**
 * What the map draws for the protection zones of the main bases (src/js/protectionZone.js, the shapes
 * SquadLayer.createProtectionZones puts on the map), on the layer data of the API (tests/fixtures/protectionZones.json)
 * against the zones of the game: the Gameplay_TeamZone actors of the layer's level in the Squad dedicated server build
 * 26005357, a sphere's radius times the smallest absolute axis of its scale, a box's extent times its scale, and the
 * actor's DeployableLockDistance (150 m unless the actor sets it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { protectionShapes } from "../src/js/protectionZone.js";

const LAYERS = JSON.parse(readFileSync(new URL("./fixtures/protectionZones.json", import.meta.url), "utf8")).layers;

/** The drawn zones of a layer of the fixture: team, shape and sizes in metres */
const drawn = (layer) => protectionShapes(LAYERS[layer]).map(({ zone, shape, protect, noDeploy }) => ({ team: zone.teamid, shape, protect, noDeploy }));

/** Sizes equal within a millimetre (the API holds the sizes as 32-bit floats) */
function assertSizes(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: ${JSON.stringify(actual)}`);
    expected.forEach((zone, index) => {
        const { team, shape, protect, noDeploy } = actual[index];
        assert.deepEqual({ team, shape }, { team: zone.team, shape: zone.shape }, `${label}, zone ${index}`);
        [protect, noDeploy].flat().forEach((size, at) => {
            const wanted = [zone.protect, zone.noDeploy].flat()[at];
            assert.ok(Math.abs(size - wanted) < 0.001, `${label}, zone ${index}: ${JSON.stringify(actual[index])}, the game's ${JSON.stringify(zone)}`);
        });
    });
}

// The first main's zone is a sphere of 15000 cm whose actor is scaled 31149.57, 31149.57 and the negative figure
// below; the second main's has no scale
const GOOSE_BAY_SCALE = { GooseBay_AAS_v1: -1.57585874954336, GooseBay_RAAS_v1: -1.5758595958269999, GooseBay_RAAS_v2: -1.57585874954336 };

for (const [layer, scale] of Object.entries(GOOSE_BAY_SCALE)) {
    test(`${layer}: the zone of the first main, negative in the layer data, is drawn with the game's 236 m and 386 m`, () => {
        assert.ok(LAYERS[layer][0].objects[0].sphereRadius < 0, "the layer data gives a negative radius");
        const radius = 150 * Math.abs(scale);
        assertSizes(drawn(layer), [
            { team: "1", shape: "circle", protect: radius, noDeploy: radius + 150 },
            { team: "2", shape: "circle", protect: 150, noDeploy: 300 },
        ], layer);
        assert.equal(radius.toFixed(1), "236.4");
    });
}

// Team 2's second zone is a box of 50 cm scaled by 0.888996: 0.44 m, with a lock distance of 50 m
const SUMARI_ZONES = {
    Sumari_Invasion_v1: [
        { team: "1", shape: "box", protect: [70, 70], noDeploy: [170, 170] },
        { team: "2", shape: "box", protect: [50 * 0.888996, 50 * 0.888996], noDeploy: [50 * 0.888996 + 150, 50 * 0.888996 + 150] },
    ],
    Sumari_TC_v1: [
        { team: "1", shape: "box", protect: [50, 70], noDeploy: [150, 170] },
        { team: "2", shape: "box", protect: [50 * 0.888996, 50 * 0.888996], noDeploy: [50 * 0.888996 + 150, 50 * 0.888996 + 150] },
    ],
};

for (const [layer, zones] of Object.entries(SUMARI_ZONES)) {
    test(`${layer}: both main bases are drawn, the zone of 0.44 m is not`, () => {
        assert.equal(LAYERS[layer].length, 3);
        assert.ok(Math.abs(LAYERS[layer][2].objects[0].boxExtent.extent_x - 50 * 0.888996) < 0.001, "the third zone is the box of 0.44 m");
        assertSizes(drawn(layer), zones, layer);
    });
}

/** A zone as the layer data gives it, lengths in cm */
const zone = (shape, teamid = "1") => ({ teamid, deployableLockDistance: 15000, objects: [{ isSphere: false, isBox: false, sphereRadius: 0, boxExtent: { extent_x: 0, extent_y: 0 }, ...shape }] });

test("a box turned over by a negative scale is the same rectangle", () => {
    const box = (x, y) => protectionShapes([zone({ isBox: true, boxExtent: { extent_x: x, extent_y: y } })]).map(({ protect, noDeploy }) => ({ protect, noDeploy }));
    assert.deepEqual(box(-25000, -17000), [{ protect: [250, 170], noDeploy: [400, 320] }]);
    assert.deepEqual(box(-25000, -17000), box(25000, 17000));
});

test("a zone is too small to draw under 1 m in every direction, whatever the sign of its size", () => {
    const shapes = (shape) => protectionShapes([zone(shape)]).length;
    assert.equal(shapes({ isSphere: true, sphereRadius: 99 }), 0);
    assert.equal(shapes({ isSphere: true, sphereRadius: -99 }), 0);
    assert.equal(shapes({ isSphere: true, sphereRadius: -100 }), 1);
    assert.equal(shapes({ isBox: true, boxExtent: { extent_x: 99, extent_y: -99 } }), 0);
    // Fallujah Invasion v2 has a zone 3 m by 35 m
    assert.equal(shapes({ isBox: true, boxExtent: { extent_x: 99, extent_y: 3500 } }), 1);
});

test("a zone of no team is not drawn", () => {
    assert.deepEqual(protectionShapes([zone({ isSphere: true, sphereRadius: 15000 }, "0")]), []);
});
