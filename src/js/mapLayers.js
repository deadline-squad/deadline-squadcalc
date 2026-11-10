/**
 * The map layers of the layer menu: their order, the one shown by default and the tile folders of this deployment.
 *
 * "standard-hd" is the top-down render of the game client's own meshes, materials and landscape layers
 * (tools/maprender in the deployment repository); its tiles are in `/maptiles/<map>-hd/` for every map.
 */

/** Layer shown when the URL names none (the map's address then has no `type` parameter) */
export const DEFAULT_LAYER = "standard-hd";

/** Layers in the order the toggle shortcut cycles through them */
export const LAYER_ORDER = ["standard-hd", "detailed", "detailed-colour", "relief", "basemap"];

/** Tile folder suffix of the layers served from `/maptiles/<map><suffix>/` with a meta.json */
export const TILE_FOLDER_SUFFIX = { "standard-hd": "-hd", "detailed": "", "detailed-colour": "-colour" };

/**
 * The value of the URL's `type` parameter for a layer
 * @param {string} layer - value of a layer button
 * @returns {string|null} - the layer, null for the default one so that plain links stay plain
 */
export function urlTypeOf(layer) {
    return layer === DEFAULT_LAYER ? null : layer;
}
