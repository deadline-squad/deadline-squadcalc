/**
 * Heights a target can have above the point clicked on the map, from the volume layer (squadVolume.js): a vertical
 * ray through the voxel column at that point (volumeWorker.js `column`) gives the solids it crosses, and this
 * module turns the free spaces between them into the choices of the target dialog. Pure functions (no map, no DOM).
 *
 * Kinds, from the geometry of the column alone (a heuristic, not the game's own building data):
 *  - `ground`, `landscape`: the heightmap's height (the default, it fuses buildings with the landscape) and the
 *    landscape under them; the dialog offers both itself, they are never produced here;
 *  - `floor`: the top of a solid with at least HEADROOM of free space above it, a soldier can stand there;
 *  - `ceiling`: the underside of a solid above a free space of at least HEADROOM;
 *  - `roof`: the top of the highest solid when nothing stands above it and it is at least HEADROOM over the landscape;
 *  - `window`, `doorway`: a free space between two solids that is part of a wall, i.e. solid on both sides of the
 *    ray along X or along Y within WALL_PROBE metres (the jambs); `doorway` when a soldier fits through
 *    (HEADROOM), else `window`. Open windows and doorways are holes of the geometry, closed windows are solid,
 *    a door is open or absent (owner decision of deadline-squad/deadline-squadcalc#22); no glass or door logic.
 */
import { PLAYER_HEIGHT } from "./squadDamage.js";

/** Smallest free space a soldier stands or walks in, metres */
export const HEADROOM = PLAYER_HEIGHT;

/** Free spaces thinner than this are cracks between voxels, not openings, metres */
export const MIN_OPENING = 0.3;

/** Distance from the ray at which the jambs of a window or doorway are looked for, metres (the worker probes it) */
export const WALL_PROBE = 0.75;

/** The aimed point is this far above a floor or roof (below a ceiling), so the end of the trajectory is in free space */
export const SURFACE_LIFT = 0.1;

/** A doorway is aimed at this height above its threshold (a standing soldier's torso), metres */
export const DOORWAY_AIM = 1.0;

/**
 * @typedef {object} HeightChoice
 * @property {string} kind - `floor`, `ceiling`, `roof`, `window` or `doorway`
 * @property {number} z - height of the aimed point in the frame of `solids`
 */

/**
 * The heights offered at a point
 * @param {Array<[number, number]>} solids - bottom and top of every solid on the ray, ascending and disjoint; the
 *   first is the landscape (its bottom is -Infinity), a voxel run on it starts at its top
 * @param {boolean[]} walled - for each solid, whether the free space above it is part of a wall (see module doc)
 * @returns {HeightChoice[]} - highest first; empty on open ground
 */
export function classifyColumn(solids, walled) {
    const choices = [];
    solids.forEach(([, top], i) => {
        const above = solids[i + 1];
        if (!above) {
            if (top - solids[0][1] >= HEADROOM) choices.push({ kind: "roof", z: top + SURFACE_LIFT });
            return;
        }
        const gap = above[0] - top;
        if (gap < MIN_OPENING) return;
        if (walled[i]) {
            if (gap >= HEADROOM) choices.push({ kind: "doorway", z: top + DOORWAY_AIM });
            else choices.push({ kind: "window", z: top + gap / 2 });
            return;
        }
        if (gap < HEADROOM) return;
        if (i > 0) choices.push({ kind: "floor", z: top + SURFACE_LIFT });
        choices.push({ kind: "ceiling", z: above[0] - SURFACE_LIFT });
    });
    return choices.sort((a, b) => b.z - a.z);
}
