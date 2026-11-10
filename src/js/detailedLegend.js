/**
 * Legend of the Detailed layer.
 *
 * The tiles' meta.json carries the symbols they are drawn with (`legend`, written by tools/maptiles/py/render.py in the
 * deployment repository: key, kind and colour of every symbol), so the legend always shows the colours of the tiles on
 * screen. This module holds the keys the page has a label for (`common:legend_<key>` in every language) and turns the
 * meta's list into rows.
 */

/** Symbols the page can name, in the order render.py writes them */
export const LEGEND_KEYS = [
    "building_low", "building_tall", "wall", "deck", "road_asphalt", "road_dirt", "railway", "trench",
    "water_shallow", "water_deep", "contour", "summit", "conifer", "deciduous", "bush", "rock",
    "crop_low", "crop_tall", "grass", "dirt", "sand", "rock_ground", "snow", "asphalt_ground", "outside",
];

const KINDS = ["area", "line", "point"];

const isColour = (value) => Array.isArray(value) && value.length === 3 && value.every((c) => Number.isInteger(c) && c >= 0 && c <= 255);

/**
 * Rows of the legend from a meta.json's `legend`
 * @param {Array<{key: string, kind: string, rgb: number[], outline?: number[]}>} [legend] - symbols of the tiles
 * @returns {Array<{key: string, kind: string, colour: string, outline: string|null}>} - the symbols the page has a
 *     label for, in the tiles' order; empty for tiles without a legend (tiles made before it existed, other layers)
 */
export function legendRows(legend) {
    if (!Array.isArray(legend)) return [];
    return legend
        .filter((symbol) => symbol && LEGEND_KEYS.includes(symbol.key) && KINDS.includes(symbol.kind) && isColour(symbol.rgb))
        .map((symbol) => ({
            key: symbol.key,
            kind: symbol.kind,
            colour: `rgb(${symbol.rgb.join(", ")})`,
            outline: isColour(symbol.outline) ? `rgb(${symbol.outline.join(", ")})` : null,
        }));
}
