import i18next from "i18next";
import { structureOutcome } from "./structureDamage.js";
import { MARKER_STRUCTURES } from "../data/structureLinks.js";

/** A target this close to a deployable marker is aimed at that structure, meters */
export const STRUCTURE_RADIUS = 5;

// Locale key (namespace common) of the name of each structure the markers stand for
const STRUCTURE_NAMES = {
    deployable_fob: "structureFob",
    deployable_hab: "structureHab",
    deployable_mortars: "structureMortar",
    deployable_HMG: "structureHmg",
    deployable_GMG: "structureGmg",
    deployable_AntiAirGun: "structureAntiAir",
    deployable_ammocrate: "structureAmmoCrate",
    deployable_repairstation: "structureRepair",
};

/**
 * The deployable marker nearest to a point, within STRUCTURE_RADIUS, that stands for a structure of the game data
 * @param {squadMinimap} map
 * @param {{lat: number, lng: number}} latlng
 * @returns {{icon: string, distance: number}|null} - the marker's icon (a key of MARKER_STRUCTURES) and the
 *   distance to it in meters; null when there is none
 */
export function findNearbyStructure(map, latlng) {
    let nearest = null;
    map.activeMarkers.eachLayer((marker) => {
        if (!(marker.icontype in MARKER_STRUCTURES)) return;
        const { east, north } = map.toMeters(latlng, marker.getLatLng());
        const distance = Math.hypot(east, north);
        if (distance <= STRUCTURE_RADIUS && (!nearest || distance < nearest.distance)) nearest = { icon: marker.icontype, distance };
    });
    return nearest;
}

/**
 * What the active weapon's shell does to a structure, as a line of text: the structure and the shells to destroy it
 * @param {string} icon - icon of the deployable marker (a key of MARKER_STRUCTURES)
 * @param {{name: string, shellName: string, explosion: {outer: number}}} weapon - the active weapon
 * @param {number} [distance=0] - meters from the burst to the structure
 * @returns {string|null} - e.g. "FOB radio: 2"; "FOB radio: no structure damage" when the shell does none; null
 *   when the game data does not cover the weapon's shell
 */
export function describeStructure(icon, weapon, distance = 0) {
    const outcome = structureOutcome(MARKER_STRUCTURES[icon], weapon, distance);
    if (!outcome) return null;
    const name = i18next.t(`common:${STRUCTURE_NAMES[icon]}`);
    return `${name}: ${outcome.status === "shells" ? outcome.shells : i18next.t("common:structureNoDamage")}`;
}
