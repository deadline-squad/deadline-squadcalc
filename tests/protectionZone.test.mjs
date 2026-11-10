/**
 * What the map draws for the protection zones of a layer (src/js/protectionZone.js: `protectionShapes`, and
 * `protectionZoneLayers`, the circles and polygons SquadLayer.createProtectionZones puts on the map: GroundCircle of
 * groundShapes.js, the polygon of tests/stubs/leaflet.mjs), on the layer data of the API (tests/fixtures/protectionZones.json), against the
 * zones of the game: the Gameplay_TeamZone actors of the layer's level in the Squad dedicated server build 26005357,
 * their sphere, box and capsule components (a size times the smallest absolute axis of its scale, a box's extent times
 * its scale) and the actor's DeployableLockDistance (150 m unless the actor sets it).
 *
 * Of the 206 layers the API offers for the 25 maps, these four draw other zones than before 45.45.0, the others the
 * same (sizes in metres, half-sizes for boxes):
 *
 * | Layer | Zone | Before | Now | Game |
 * |---|---|---|---|---|
 * | Kohat TC v1 | team 2, first | nothing | footprint of the capsule: radius 200, 399.5 from the centre to each half-circle's centre, along 8.44 degrees (1199 by 400 in all); no no-deploy area | capsule radius 200, half-height 600, pitch -87.18282, yaw -171.56177, roll -180; lock distance 400 |
 * | Fallujah Invasion v2 | team 1, second | box 3 by 35 turned by -24.9 degrees, no-deploy box 153 by 185 | boxes 3 by 35, 25 by 20 and 15 by 15 turned by -24.9, -33.85 and -28.72 degrees; no no-deploy area | the same three boxes; lock distance 150 |
 * | Sumari Invasion v1, Sumari TC v1 | team 2, third | nothing | box 0.444, no-deploy box 50.444 | box of 0.5 scaled by 0.888996; lock distance 50 |
 *
 * The game's no-deploy area of a zone is the box its BeginPlay sizes (protectionZone.js): for the capsule zone of Kohat
 * TC v1 400.32 around the actor's root, 40.5 from the capsule's centre (the 32 cm DummyPresetCollision plus 400; the
 * capsule does not count); for the boxes of Fallujah Invasion v2 175 by 170 around the root, not turned (the box Box1,
 * 25 by 20, plus 150); for the point of Sumari 50.5 around the root, 0.57 from the box (0.5 plus 50).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { protectionShapes, protectionZoneLayers } from "../src/js/protectionZone.js";
import { GroundCircle } from "../src/js/groundShapes.js";
import { Polygon } from "./stubs/leaflet.mjs";

const LAYERS = JSON.parse(readFileSync(new URL("./fixtures/protectionZones.json", import.meta.url), "utf8")).layers;

/** The size of a drawn shape in metres: a circle's radius, a box's half-sizes, a stadium's radius and half-length */
const size = (shape) => ({ circle: () => [shape.radius], box: () => shape.halfSizes, stadium: () => [shape.radius, shape.halfLength] })[shape.shape]();

/** The drawn zones of a layer of the fixture: team, the shape and size of each outline, and of the no-deploy area */
const drawn = (layer) => protectionShapes(LAYERS[layer]).map(({ zone, outlines, noDeploy }) => ({
    team: zone.teamid,
    outlines: outlines.map((shape) => [shape.shape, ...size(shape)]),
    noDeploy: noDeploy && [noDeploy.shape, ...size(noDeploy)],
}));

/** Lengths equal within a millimetre (the API holds them as 32-bit floats), angles within a thousandth of a degree */
function assertNear(actual, expected, label, within = 0.001) {
    assert.equal(typeof actual, typeof expected, `${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    if (typeof expected === "number") {
        assert.ok(Math.abs(actual - expected) < within, `${label}: ${actual}, expected ${expected}`);
        return;
    }
    if (expected === null || typeof expected === "string") {
        assert.equal(actual, expected, label);
        return;
    }
    assert.equal(actual.length ?? Object.keys(actual).length, expected.length ?? Object.keys(expected).length, `${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    for (const key of Object.keys(expected)) assertNear(actual[key], expected[key], `${label}.${key}`, within);
}

/** Smallest angle between two directions of a line, in degrees */
const lineAngle = (a, b) => Math.abs(((a - b) % 180 + 270) % 180 - 90);

// The first main's zone is a sphere of 15000 cm whose actor is scaled 31149.57, 31149.57 and the negative figure
// below; the second main's has no scale
const GOOSE_BAY_SCALE = { GooseBay_AAS_v1: -1.57585874954336, GooseBay_RAAS_v1: -1.5758595958269999, GooseBay_RAAS_v2: -1.57585874954336 };

for (const [layer, scale] of Object.entries(GOOSE_BAY_SCALE)) {
    test(`${layer}: the zone of the first main, negative in the layer data, is drawn with the game's 236 m, its no-deploy circle 150 m further`, () => {
        assert.ok(LAYERS[layer][0].objects[0].sphereRadius < 0, "the layer data gives a negative radius");
        const radius = 150 * Math.abs(scale);
        assertNear(drawn(layer), [
            { team: "1", outlines: [["circle", radius]], noDeploy: ["circle", radius + 150] },
            { team: "2", outlines: [["circle", 150]], noDeploy: ["circle", 300] },
        ], layer);
        assert.equal(radius.toFixed(1), "236.4");
    });
}

// Team 2's third zone is a box of 50 cm whose actor is scaled by 0.888996, with a lock distance of 50 m: Gameplay_TeamZone
// makes a no-deploy area of 50.5 m around it like around any zone (protectionZone.js)
const POINT = 0.5 * 0.888996;
const SUMARI_ZONES = {
    Sumari_Invasion_v1: [
        { team: "1", outlines: [["box", 70, 70]], noDeploy: ["box", 170, 170] },
        { team: "2", outlines: [["box", 50 * 0.888996, 50 * 0.888996]], noDeploy: ["box", 50 * 0.888996 + 150, 50 * 0.888996 + 150] },
        { team: "2", outlines: [["box", POINT, POINT]], noDeploy: ["box", POINT + 50, POINT + 50] },
    ],
    Sumari_TC_v1: [
        { team: "1", outlines: [["box", 50, 70]], noDeploy: ["box", 150, 170] },
        { team: "2", outlines: [["box", 50 * 0.888996, 50 * 0.888996]], noDeploy: ["box", 50 * 0.888996 + 150, 50 * 0.888996 + 150] },
        { team: "2", outlines: [["box", POINT, POINT]], noDeploy: ["box", POINT + 50, POINT + 50] },
    ],
};

for (const [layer, zones] of Object.entries(SUMARI_ZONES)) {
    test(`${layer}: both main bases are drawn, and the point of 0.44 m with its no-deploy area of 50 m`, () => {
        assertNear(drawn(layer), zones, layer);
    });
}

// The capsule of team 2's first zone (CapsuleComponent "Capsule" of Team2ProtectionZone1): radius 20000 cm,
// half-height 60000 cm, pitch -87.18282, yaw -171.56177, roll -180 (-179.99995). Rolled over, its Z axis lies in the
// vertical plane of its yaw, tilted from the vertical by the pitch: the segment between the centres of its
// half-spheres, 2 x (600 - 200) m long, is seen from above |sin(pitch)| as long, along the yaw turned by 180 degrees
const KOHAT_CAPSULE = { radius: 200, halfLength: (600 - 200) * Math.abs(Math.sin(-87.18282 * Math.PI / 180)), direction: -171.56177 + 180 };

test("Kohat TC v1: the capsule zone is drawn as its footprint, a stadium of the game's size and direction, without a no-deploy area", () => {
    assertNear(drawn("Kohat_TC_v1"), [
        { team: "1", outlines: [["circle", 250]], noDeploy: ["circle", 650] },
        { team: "1", outlines: [["circle", 19.245537]], noDeploy: ["circle", 319.245537] },
        { team: "2", outlines: [["stadium", KOHAT_CAPSULE.radius, KOHAT_CAPSULE.halfLength]], noDeploy: null },
        { team: "2", outlines: [["circle", 16.200289]], noDeploy: ["circle", 316.200289] },
    ], "Kohat_TC_v1");
    const [stadium] = protectionShapes(LAYERS.Kohat_TC_v1)[2].outlines;
    assert.ok(lineAngle(stadium.yaw, KOHAT_CAPSULE.direction) < 0.001, `direction ${stadium.yaw}, the game's ${KOHAT_CAPSULE.direction}`);
    assert.equal(KOHAT_CAPSULE.halfLength.toFixed(1), "399.5");
});

// Team 1's second zone has three boxes (Box, Box1 and Box2 of Team1ProtectionZone2): extents 300 x 3500, 2500 x 2000
// and 1500 x 1500 cm, at 0, (-1816, -2732) and (1459, 2929) cm from the actor's root at (-109939.67, 600.3696), which
// is not turned, with the yaws below
const FALLUJAH_BOXES = [
    { halfSizes: [3, 35], centre: [-109939.67, 600.3696], yaw: -24.905027 },
    { halfSizes: [25, 20], centre: [-109939.67 - 1816, 600.3696 - 2732], yaw: -33.847927 },
    { halfSizes: [15, 15], centre: [-109939.67 + 1459, 600.3696 + 2929], yaw: -28.723526 },
];

test("Fallujah Invasion v2: every box of the zone of three is drawn where the game has it, without a no-deploy area", () => {
    const [first, boxes, second] = protectionShapes(LAYERS.Fallujah_Invasion_v2);
    assertNear(boxes.outlines.map(({ shape, halfSizes, object, yaw }) => ({ shape, halfSizes, centre: [object.location_x / 100, object.location_y / 100], yaw })),
        FALLUJAH_BOXES.map(({ halfSizes, centre, yaw }) => ({ shape: "box", halfSizes, centre: centre.map((cm) => cm / 100), yaw })), "Fallujah_Invasion_v2, zone 2");
    assert.equal(boxes.noDeploy, null);
    assertNear(drawn("Fallujah_Invasion_v2").filter((zone, index) => index !== 1), [
        { team: "1", outlines: [["circle", 120]], noDeploy: ["circle", 250] },
        { team: "2", outlines: [["circle", 160]], noDeploy: ["circle", 210] },
    ], "Fallujah_Invasion_v2, zones 1 and 3");
    assert.deepEqual([first.zone.teamid, second.zone.teamid], ["1", "2"]);
});

test("Lashkar Invasion v1: a sphere the layer data gives as 0 (the engine's 32 cm) is not drawn, its box and no-deploy area are", () => {
    for (const index of [2, 3]) assert.equal(LAYERS.Lashkar_Invasion_v1[index].objects[1].sphereRadius, 0, `zone ${index + 1}: a sphere of 0`);
    assertNear(drawn("Lashkar_Invasion_v1"), [
        { team: "1", outlines: [["circle", 150]], noDeploy: ["circle", 300] },
        { team: "2", outlines: [["circle", 150]], noDeploy: ["circle", 300] },
        { team: "2", outlines: [["box", 60, 65]], noDeploy: ["box", 210, 215] },
        { team: "2", outlines: [["box", 78, 73]], noDeploy: ["box", 228, 223] },
    ], "Lashkar_Invasion_v1");
});

test("Al Basrah Seed v1: the zone of no team, four boxes, is not drawn", () => {
    assert.equal(LAYERS.AlBasrah_Seed_v1[1].teamid, "0");
    assert.equal(LAYERS.AlBasrah_Seed_v1[1].objects.length, 4);
    assertNear(drawn("AlBasrah_Seed_v1"), [
        { team: "1", outlines: [["box", 60, 60]], noDeploy: ["box", 110, 110] },
        { team: "2", outlines: [["box", 101.68457, 86.659453]], noDeploy: ["box", 151.68457, 136.659453] },
    ], "AlBasrah_Seed_v1");
});

/**
 * The map layers of a layer of the fixture on a map with `scaleX` and `scaleY` map units per metre east and south,
 * with the world origin at the map's origin (SquadLayer.convertToLatLng without the layer's offsets)
 */
const layersOf = (layer, scaleX = 1, scaleY = 1) => protectionZoneLayers(LAYERS[layer], (x, y) => [y / 100 * -scaleY, x / 100 * scaleX], "#fff");

/** What a map layer is, and its outline: [circle or polygon, solid or the dash pattern] */
const kinds = (layers) => layers.map((layer) => [layer instanceof GroundCircle ? "circle" : layer instanceof Polygon ? "polygon" : "other", layer.options.dashArray ?? "solid"]);

/** The points of a polygon of the map back in world metres, east and south */
const metres = (polygon, scaleX = 1, scaleY = 1) => polygon.latlngs.map(([lat, lng]) => [lng / scaleX, -lat / scaleY]);

/** How far a polygon reaches from `centre` along the direction `degrees` and across it, in metres */
function reach(points, centre, degrees) {
    const turn = degrees * Math.PI / 180;
    const along = points.map(([x, y]) => (x - centre[0]) * Math.cos(turn) + (y - centre[1]) * Math.sin(turn));
    const across = points.map(([x, y]) => -(x - centre[0]) * Math.sin(turn) + (y - centre[1]) * Math.cos(turn));
    return [Math.max(...along), -Math.min(...along), Math.max(...across), -Math.min(...across)];
}

test("the map gets the stadium of the capsule of Kohat TC v1, 1199 m by 400 m around its centre, and no dashed outline for it", () => {
    const layers = layersOf("Kohat_TC_v1");
    assert.deepEqual(kinds(layers), [
        ["circle", "solid"], ["circle", "10,20"], ["circle", "solid"], ["circle", "10,20"], ["polygon", "solid"], ["circle", "solid"], ["circle", "10,20"],
    ]);
    const capsule = LAYERS.Kohat_TC_v1[2].objects[0];
    const centre = [capsule.location_x / 100, capsule.location_y / 100];
    const end = KOHAT_CAPSULE.halfLength + KOHAT_CAPSULE.radius;
    assertNear(reach(metres(layers[4]), centre, KOHAT_CAPSULE.direction), [end, end, KOHAT_CAPSULE.radius, KOHAT_CAPSULE.radius], "reach along and across", 0.01);
    for (const [x, y] of metres(layers[4])) {
        const turn = KOHAT_CAPSULE.direction * Math.PI / 180;
        const along = Math.abs((x - centre[0]) * Math.cos(turn) + (y - centre[1]) * Math.sin(turn));
        const across = (x - centre[0]) * -Math.sin(turn) + (y - centre[1]) * Math.cos(turn);
        const fromSegment = Math.hypot(Math.max(along - KOHAT_CAPSULE.halfLength, 0), across);
        assert.ok(Math.abs(fromSegment - KOHAT_CAPSULE.radius) < 0.01, `a point ${fromSegment} m from the segment`);
    }
});

test("the map gets every box of Fallujah Invasion v2's zone of three, as rectangles of the game's size and turn, and no dashed outline for them", () => {
    const layers = layersOf("Fallujah_Invasion_v2");
    assert.deepEqual(kinds(layers), [
        ["circle", "solid"], ["circle", "10,20"], ["polygon", "solid"], ["polygon", "solid"], ["polygon", "solid"], ["circle", "solid"], ["circle", "10,20"],
    ]);
    FALLUJAH_BOXES.forEach(({ halfSizes: [x, y], centre, yaw }, index) => {
        const corners = metres(layers[2 + index]);
        assert.equal(corners.length, 4);
        assertNear(reach(corners, centre.map((cm) => cm / 100), yaw), [x, x, y, y], `box ${index + 1}`);
    });
});

test("a turned box is a rectangle of its size in the game's metres also on a map scaled apart north and east (Skorpo, 6849 m by 6869 m)", () => {
    const [scaleX, scaleY] = [256 / 6849, 256 / 6869];
    const zone = LAYERS.Skorpo_Skirmish_v1[0];
    const { extent_x, extent_y, rotation_z } = zone.objects[0].boxExtent;
    const lock = zone.deployableLockDistance / 100;
    const [box, noDeploy] = layersOf("Skorpo_Skirmish_v1", scaleX, scaleY);
    const centre = [zone.objects[0].location_x / 100, zone.objects[0].location_y / 100];
    assert.ok(Math.abs(rotation_z) > 45, "a box turned by more than 45 degrees");
    assertNear(reach(metres(box, scaleX, scaleY), centre, rotation_z), [extent_x / 100, extent_x / 100, extent_y / 100, extent_y / 100], "box");
    assertNear(reach(metres(noDeploy, scaleX, scaleY), centre, rotation_z), [extent_x / 100 + lock, extent_x / 100 + lock, extent_y / 100 + lock, extent_y / 100 + lock], "no-deploy box");
});

test("the map gets circles of the radius in metres, drawn with the map's scales (groundShapes.js), at the zone's centre (Goose Bay AAS v1), and the dashed box of the point of Sumari", () => {
    const scale = 256 / 4065;
    const [protect, noDeploy] = layersOf("GooseBay_AAS_v1", scale, scale);
    const sphere = LAYERS.GooseBay_AAS_v1[0].objects[0];
    assert.ok(protect instanceof GroundCircle && noDeploy instanceof GroundCircle);
    assertNear([protect.getRadius(), noDeploy.getRadius()], [Math.abs(sphere.sphereRadius) / 100, Math.abs(sphere.sphereRadius) / 100 + 150], "radii");
    const centre = protect.getLatLng();
    assertNear([centre.lat, centre.lng], [sphere.location_y / 100 * -scale, sphere.location_x / 100 * scale], "centre");
    const point = layersOf("Sumari_Invasion_v1").slice(-2);
    assert.ok(point.every((layer) => layer instanceof Polygon));
    assert.equal(point[1].options.dashArray, "10,20");
    const { location_x, location_y, boxExtent } = LAYERS.Sumari_Invasion_v1[2].objects[0];
    assertNear(reach(metres(point[1]), [location_x / 100, location_y / 100], boxExtent.rotation_z), Array(4).fill(POINT + 50), "no-deploy box of the point");
});

/** A zone as the layer data gives it, lengths in cm */
const zone = (shape, teamid = "1") => ({ teamid, deployableLockDistance: 15000, objects: [{ isSphere: false, isBox: false, isCapsule: false, sphereRadius: 0, location_x: 0, location_y: 0, boxExtent: { extent_x: 0, extent_y: 0, extent_z: 0, rotation_x: 0, rotation_y: 0, rotation_z: 0 }, ...shape }] });

test("a box turned over by a negative scale is the same rectangle", () => {
    const box = (x, y) => protectionShapes([zone({ isBox: true, boxExtent: { extent_x: x, extent_y: y, extent_z: 0, rotation_x: 0, rotation_y: 0, rotation_z: 0 } })]).map(({ outlines, noDeploy }) => [outlines[0].halfSizes, noDeploy.halfSizes]);
    assert.deepEqual(box(-25000, -17000), [[[250, 170], [400, 320]]]);
    assert.deepEqual(box(-25000, -17000), box(25000, 17000));
});

test("an upright capsule is seen from above as a circle of its radius", () => {
    const [{ outlines }] = protectionShapes([zone({ isCapsule: true, sphereRadius: 5000, boxExtent: { extent_x: 5000, extent_y: 5000, extent_z: 20000, rotation_x: 0, rotation_y: 0, rotation_z: 30 } })]);
    assertNear(outlines.map((shape) => [shape.shape, ...size(shape)]), [["stadium", 50, 0]], "upright capsule");
});

test("a zone of no team is not drawn", () => {
    assert.deepEqual(protectionShapes([zone({ isSphere: true, sphereRadius: 15000 }, "0")]), []);
});
