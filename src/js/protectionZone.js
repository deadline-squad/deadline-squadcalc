/**
 * Radii of the round protection zone of a main base: the zone itself, and the zone grown by the distance within
 * which no deployable can be placed. The layer data gives the zone's sphere with the scale of its actor, and a zone
 * with a negative scale in the level (Goose Bay AAS v1 and RAAS v1: -1.58) comes with a negative radius; the game
 * takes the size of the scale (USphereComponent::GetScaledSphereRadius), 236 m there.
 * @param {{deployableLockDistance: number, objects: Array<{sphereRadius: number}>}} zone - a protection zone of the
 *   layer (`mapAssets.protectionZones`), lengths in cm
 * @returns {{protect: number, noDeploy: number}} - metres
 */
export function protectionRadii(zone) {
    const protect = Math.abs(zone.objects[0].sphereRadius) / 100;
    return { protect, noDeploy: protect + zone.deployableLockDistance / 100 };
}
