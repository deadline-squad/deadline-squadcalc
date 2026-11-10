/**
 * Half-size, in cm, under which a protection zone is not drawn: such a zone is a point of the level, not a base.
 * Sumari Invasion v1 and TC v1 have one that is at neither main base, a box of 0.44 m with a lock distance of 50 m.
 */
const SMALLEST_DRAWN_ZONE = 100;

/**
 * What the map draws for the protection zones of a layer: a round zone as a circle, a box as a rectangle, each with
 * the area around it where no deployable can be placed (the zone grown by its lock distance).
 *
 * The layer data gives a shape with the scale of its actor, and a zone whose actor has a negative scale in the level
 * comes with a negative size (the first main of Goose Bay AAS v1, RAAS v1 and RAAS v2: a sphere of 150 m scaled by
 * -1.5759, radius -236.4 m). The game takes the size of the scale (USphereComponent::GetScaledSphereRadius), so a
 * zone's size is the absolute value.
 *
 * Not drawn: a zone of no team (`teamid` "0"), a zone under 1 m and the lock distance around it
 * (SMALLEST_DRAWN_ZONE), a capsule (Kohat TC v1 has one), and the shapes of a zone after its first (Fallujah
 * Invasion v2 has a zone of three boxes).
 * @param {Array<{teamid: string, deployableLockDistance: number, objects: Array<{isSphere: boolean, isBox: boolean,
 *   sphereRadius: number, boxExtent: {extent_x: number, extent_y: number}}>}>} zones - `mapAssets.protectionZones`
 *   of the layer data, lengths in cm
 * @returns {Array<{zone: object, shape: "circle", protect: number, noDeploy: number}
 *   | {zone: object, shape: "box", protect: [number, number], noDeploy: [number, number]}>} - one entry per drawn
 *   zone with the zone of the layer data (its `objects[0]` has the centre and a box's rotation): the radius of a
 *   circle, the half-sizes of a box along x and y, in metres
 */
export function protectionShapes(zones) {
    const shapes = [];
    for (const zone of zones) {
        if (zone.teamid === "0") continue;
        const { isSphere, isBox, sphereRadius, boxExtent } = zone.objects[0];
        const lock = zone.deployableLockDistance / 100;

        if (isSphere) {
            const radius = Math.abs(sphereRadius);
            if (radius < SMALLEST_DRAWN_ZONE) continue;
            shapes.push({ zone, shape: "circle", protect: radius / 100, noDeploy: radius / 100 + lock });
        } else if (isBox) {
            const halfSizes = [Math.abs(boxExtent.extent_x), Math.abs(boxExtent.extent_y)];
            if (Math.max(...halfSizes) < SMALLEST_DRAWN_ZONE) continue;
            const protect = halfSizes.map((halfSize) => halfSize / 100);
            shapes.push({ zone, shape: "box", protect, noDeploy: protect.map((halfSize) => halfSize + lock) });
        }
    }
    return shapes;
}
