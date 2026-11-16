// The seeded lines of fire: nothing is stored, the seed is. The stream of a map depends on its name only, and is shared by
// the weapons in the order they are run.

/** Lines counted per map and weapon (those with a fireable solution) */
export const LINES_PER_WEAPON = 3000;

// Distance and height padding ranges of a line, metres
const MIN_DISTANCE = 150;
const MAX_DISTANCE = 1500;
const MAX_PADDING = 3;

// mulberry32
function seeded(seed) {
    let a = seed;
    return () => {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * @param {string} map - the map's name, which seeds the stream: 1234567 + the sum of its character codes
 * @param {{min_x: number, max_x: number, min_y: number, max_y: number}} bounds - the map's rectangle in world metres
 * @param {function(number, number): boolean} inside - whether a world point lies on the heightmap's lattice
 * @returns {function(): {ax: number, ay: number, ux: number, uy: number, distance: number, padding: number}} - the next line:
 *   start uniform over the inner 90 % of the map, bearing uniform, distance 150 to 1500 m, weapon height padding 0 to 3 m
 *   in steps of 0.5 m; a line whose start or end is off the lattice or the map is not given
 */
export function lineSource(map, bounds, inside) {
    const random = seeded(1234567 + [...map].reduce((sum, char) => sum + char.charCodeAt(0), 0));
    return () => {
        for (;;) {
            const bearing = random() * 2 * Math.PI;
            const distance = MIN_DISTANCE + random() * (MAX_DISTANCE - MIN_DISTANCE);
            const ax = bounds.min_x + (0.05 + 0.9 * random()) * (bounds.max_x - bounds.min_x);
            const ay = bounds.min_y + (0.05 + 0.9 * random()) * (bounds.max_y - bounds.min_y);
            const ux = Math.cos(bearing);
            const uy = Math.sin(bearing);
            const tx = ax + ux * distance;
            const ty = ay + uy * distance;
            if (!inside(ax, ay) || !inside(tx, ty)) continue;
            if (tx < bounds.min_x || tx > bounds.max_x || ty < bounds.min_y || ty > bounds.max_y) continue;
            return { ax, ay, ux, uy, distance, padding: Math.round(random() * 2 * MAX_PADDING) / 2 };
        }
    };
}
