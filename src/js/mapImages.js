/**
 * Where the map pictures lie on the map. The map is a square of pixelSize units spanning the image corners
 * `corner0`/`corner1` of `SDK_data.minimap` (maps.js), the frame of every tile layer of this deployment (Detailed,
 * Standard HD, game colours, relief) and of the heightmaps. A picture of the game's minimap is drawn over the world
 * rectangle it shows, which is not always that frame: the game stretches a minimap texture between its own corners
 * (`minimap.game`, unrounded), and Skorpo's texture shows a rectangle of its own (`minimap.image`).
 */

/**
 * Manifest of the minimaps of gameplay layers that show a texture other than their map's (Seed and Skirmish layers:
 * the same 4096 px over a part of the map, several times finer than the image of the whole map). Served by this
 * deployment (tools/maptiles, step layer-minimaps), keyed by the layer's raw name:
 * `{generated, build, layers: {<layer>: {texture, folder, size, min, max}}}`, `min` and `max` the corners of the
 * world rectangle the game stretches the texture over, in metres. The game takes the texture and its corners from
 * the layer's data asset (`OveriddenMinimapTexture`, `MinimapCornersPosition`), else from the layer's level, so they
 * are not always the `mapTexture` and `mapTextureCorners` of the layer API. The picture is
 * `/maptiles/<folder>/0/0_0.webp`, a single tile of `size` px, which the long cache lifetime of the tile folders
 * covers.
 */
export const LAYER_MINIMAPS_MANIFEST = "/maptiles/layer-minimaps.json";

// Where the frame of the upstream HQ tiles and the rectangle their picture shows differ by less, the tiles are
// drawn on their grid unchanged (the game's corners are given to the centimetre)
const SAME_RECTANGLE_M = 0.005;

/**
 * The world rectangle the upstream map images (basemap.webp and its HQ tiles) show: the one measured on the
 * world where the game's texture lies off the game's corners (`minimap.image`, Skorpo), else the game's own
 * corners (`minimap.game`), else the image corners of a map without game data.
 * @param {{corner0: number[], corner1: number[], game?: {min: number[], max: number[]}, image?: {min: number[], max: number[]}}} minimap - SDK_data.minimap
 * @returns {{min: number[], max: number[]}} - metres
 */
export function upstreamImageRectangle(minimap) {
    if (minimap.image) return minimap.image;
    if (minimap.game) return minimap.game;
    return {
        min: [Math.min(minimap.corner0[0], minimap.corner1[0]), Math.min(minimap.corner0[1], minimap.corner1[1])],
        max: [Math.max(minimap.corner0[0], minimap.corner1[0]), Math.max(minimap.corner0[1], minimap.corner1[1])],
    };
}

/**
 * Leaflet bounds of a world rectangle on the map, measured from the frame's north-west corner per axis.
 * @param {{corner0: number[], corner1: number[]}} minimap - SDK_data.minimap of the active map (metres)
 * @param {{min: number[], max: number[]}} rectangle - world rectangle in metres
 * @param {number} scaleX - map units per metre along X (`gameToMapScale`)
 * @param {number} scaleY - map units per metre along Y (`gameToMapScaleY`)
 * @returns {number[][]} - [[north, west], [south, east]], latitude down from 0 as on the map image
 */
export function rectangleBounds(minimap, rectangle, scaleX, scaleY) {
    const west = Math.min(minimap.corner0[0], minimap.corner1[0]);
    const north = Math.min(minimap.corner0[1], minimap.corner1[1]);
    return [
        [-(rectangle.min[1] - north) * scaleY, (rectangle.min[0] - west) * scaleX],
        [-(rectangle.max[1] - north) * scaleY, (rectangle.max[0] - west) * scaleX],
    ];
}

/**
 * How the upstream HQ tiles are drawn so that their picture lies where it lies in the world. The tiles are cut on
 * the frame (`corner0`/`corner1`) while their picture shows `upstreamImageRectangle`, so the point at frame
 * position f (map units east or south of the frame's north-west corner) is drawn at `offset + scale * f`, per
 * axis. On a map whose image rectangle is the frame this is the identity.
 * @param {{corner0: number[], corner1: number[]}} minimap - SDK_data.minimap
 * @param {number} pixelSize - map units across the frame
 * @returns {{offset: number[], scale: number[]}|null} - map units and factors [east, south]; null for the identity
 */
export function upstreamTileTransform(minimap, pixelSize) {
    const rectangle = upstreamImageRectangle(minimap);
    const frameMin = [Math.min(minimap.corner0[0], minimap.corner1[0]), Math.min(minimap.corner0[1], minimap.corner1[1])];
    const frameMax = [Math.max(minimap.corner0[0], minimap.corner1[0]), Math.max(minimap.corner0[1], minimap.corner1[1])];
    const same = [0, 1].every((axis) => Math.abs(rectangle.min[axis] - frameMin[axis]) < SAME_RECTANGLE_M
        && Math.abs(rectangle.max[axis] - frameMax[axis]) < SAME_RECTANGLE_M);
    if (same) return null;
    const size = [frameMax[0] - frameMin[0], frameMax[1] - frameMin[1]];
    return {
        offset: [0, 1].map((axis) => (rectangle.min[axis] - frameMin[axis]) * pixelSize / size[axis]),
        scale: [0, 1].map((axis) => (rectangle.max[axis] - rectangle.min[axis]) / size[axis]),
    };
}
