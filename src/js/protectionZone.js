import { Polygon } from "leaflet";
import { GroundCircle } from "./groundShapes.js";

/** Points on each half-circle of a capsule's footprint: under 25 cm off the arc of the 200 m capsule of Kohat TC v1 */
const ARC_POINTS = 32;

/**
 * @typedef {object} ZoneShape - a shape as the map draws it
 * @property {"circle"|"box"|"stadium"} shape - a sphere, a box, or the footprint of a capsule
 * @property {object} object - the shape in the layer data; its `location_x` and `location_y` (cm) are the centre
 * @property {number} [radius] - circle and stadium, metres
 * @property {[number, number]} [halfSizes] - box: half its size along its own x and y, metres
 * @property {number} [halfLength] - stadium: half the distance between the centres of its two half-circles, metres
 * @property {number} [yaw] - box and stadium: degrees from world X towards world Y (the box's x axis, the stadium's
 *   long axis)
 */

/**
 * What the map draws for the protection zones of a layer.
 *
 * A protection zone of the game (Gameplay_TeamZone, class SQProtectionZone) is every sphere, box and capsule attached
 * to the root of its actor. The layer data gives each as an object with its centre, its size times the scale of its
 * actor and its rotation (`boxExtent.rotation_x`, `rotation_y`, `rotation_z`: roll, pitch and yaw, degrees). Each one
 * is drawn: a sphere as a circle, a box as a rectangle turned by its yaw, a capsule (radius `sphereRadius`, half-height
 * `boxExtent.extent_z` from its centre to the tip of a half-sphere, along its own Z axis) as its footprint on the map:
 * the segment between the centres of its half-spheres seen from above, grown by the radius. A size counts by its
 * absolute value: an actor with a negative scale gives a negative size (Goose Bay AAS v1, RAAS v1 and RAAS v2: a
 * sphere of 150 m scaled by -1.5759, radius -236.4 m), and the game takes the size of the scale
 * (USphereComponent::GetScaledSphereRadius). Not drawn: a zone of no team (`teamid` "0"), and a shape of size 0, which
 * is how the layer data gives a sphere left at the engine's 32 cm (the second shape of two zones of Lashkar Invasion v1).
 *
 * The area where no deployable can be placed is the BP_NoDeployZone actor that Gameplay_TeamZone's BeginPlay sizes:
 * a box around the zone actor's root, turned with it, whose half-size is the largest of the radius of each sphere and
 * the extent of each box attached to the root, before the actor's scale, and of the 32 cm box DummyPresetCollision,
 * plus the lock distance (`deployableLockDistance`); a capsule does not count. The layer data has neither that root
 * nor the unscaled sizes. For a zone of one sphere or one box the map draws that shape grown by the lock distance, the
 * game's area when the shape sits at the root, unscaled and not turned against it. For a capsule (Kohat TC v1) and for
 * a zone of several shapes (Fallujah Invasion v2) the game's area is a box around the actor's root, which the layer
 * data does not give, and none is drawn.
 * @param {Array<{teamid: string, deployableLockDistance: number, objects: Array<{isSphere: boolean, isBox: boolean,
 *   isCapsule: boolean, sphereRadius: number, location_x: number, location_y: number, boxExtent: {extent_x: number,
 *   extent_y: number, extent_z: number, rotation_x: number, rotation_y: number, rotation_z: number}}>}>} zones -
 *   `mapAssets.protectionZones` of the layer data, lengths in cm
 * @returns {Array<{zone: object, outlines: ZoneShape[], noDeploy: ZoneShape|null}>} - one entry per zone of a team: its
 *   shapes, and its no-deploy area where the map draws one
 */
export function protectionShapes(zones) {
    return zones.filter((zone) => zone.teamid !== "0").map((zone) => {
        const outlines = zone.objects.map(zoneShape).filter(Boolean);
        const lock = zone.deployableLockDistance / 100;
        const [single] = outlines;
        let noDeploy = null;
        if (outlines.length === 1 && single.shape === "circle") noDeploy = { ...single, radius: single.radius + lock };
        if (outlines.length === 1 && single.shape === "box") noDeploy = { ...single, halfSizes: single.halfSizes.map((halfSize) => halfSize + lock) };
        return { zone, outlines, noDeploy };
    });
}

/**
 * One object of a zone as the map draws it
 * @param {object} object - an entry of a zone's `objects`, lengths in cm
 * @returns {ZoneShape|null} - null for a shape of size 0 or of no kind the layer data names
 */
function zoneShape(object) {
    const { isSphere, isBox, isCapsule, sphereRadius, boxExtent } = object;
    if (isSphere) {
        const radius = Math.abs(sphereRadius) / 100;
        return radius > 0 ? { shape: "circle", object, radius } : null;
    }
    if (isBox) {
        const halfSizes = [Math.abs(boxExtent.extent_x) / 100, Math.abs(boxExtent.extent_y) / 100];
        return Math.max(...halfSizes) > 0 ? { shape: "box", object, halfSizes, yaw: boxExtent.rotation_z } : null;
    }
    if (isCapsule) {
        const radius = Math.abs(sphereRadius) / 100;
        if (radius === 0) return null;
        // The capsule's Z axis in the world: the third row of the engine's FRotationMatrix for its pitch, yaw and roll
        const [pitch, yaw, roll] = [boxExtent.rotation_y, boxExtent.rotation_z, boxExtent.rotation_x].map((angle) => angle * Math.PI / 180);
        const axisX = -(Math.cos(roll) * Math.sin(pitch) * Math.cos(yaw) + Math.sin(roll) * Math.sin(yaw));
        const axisY = Math.cos(yaw) * Math.sin(roll) - Math.cos(roll) * Math.sin(pitch) * Math.sin(yaw);
        const segmentHalfLength = Math.max(Math.abs(boxExtent.extent_z) / 100 - radius, 0);
        return { shape: "stadium", object, radius, halfLength: segmentHalfLength * Math.hypot(axisX, axisY), yaw: Math.atan2(axisY, axisX) * 180 / Math.PI };
    }
    return null;
}

/**
 * The outline of a box or a stadium on the ground
 * @param {ZoneShape} shape - a box or a stadium
 * @returns {Array<[number, number]>} - world X and Y in cm, around the shape
 */
function outlinePoints({ shape, object, radius, halfSizes, halfLength, yaw }) {
    const turn = yaw * Math.PI / 180;
    const world = ([along, across]) => [
        object.location_x + (along * Math.cos(turn) - across * Math.sin(turn)) * 100,
        object.location_y + (along * Math.sin(turn) + across * Math.cos(turn)) * 100,
    ];
    if (shape === "box") {
        const [x, y] = halfSizes;
        return [[x, y], [-x, y], [-x, -y], [x, -y]].map(world);
    }
    const points = [];
    for (const [end, from] of [[halfLength, -Math.PI / 2], [-halfLength, Math.PI / 2]]) {
        for (let step = 0; step <= ARC_POINTS; step++) {
            const angle = from + Math.PI * step / ARC_POINTS;
            points.push(world([end + radius * Math.cos(angle), radius * Math.sin(angle)]));
        }
    }
    return points;
}

/**
 * The map layers of the protection zones of a layer: every outline of `protectionShapes`, and the dashed no-deploy area
 * where it has one
 * @param {Array} zones - `mapAssets.protectionZones` of the layer data
 * @param {(x: number, y: number) => [number, number]} toLatLng - world X and Y in cm to map units (SquadLayer.convertToLatLng)
 * @param {string} color - outline colour
 * @returns {Array<GroundCircle|Polygon>} - not yet on a map, each zone's outlines before its no-deploy area; a circle's
 *     radius in metres
 */
export function protectionZoneLayers(zones, toLatLng, color) {
    const draw = (shape, style) => (shape.shape === "circle"
        ? new GroundCircle(toLatLng(shape.object.location_x, shape.object.location_y), { ...style, radius: shape.radius })
        : new Polygon(outlinePoints(shape).map(([x, y]) => toLatLng(x, y)), style));
    return protectionShapes(zones).flatMap(({ outlines, noDeploy }) => [
        ...outlines.map((shape) => draw(shape, { color, opacity: 1, weight: 2 })),
        ...(noDeploy ? [draw(noDeploy, { color, dashArray: "10,20", opacity: 1, weight: 1 })] : []),
    ]);
}
