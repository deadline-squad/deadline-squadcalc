import { layerGridOffset } from "../data/maps.js";

/**
 * Manifest of the map images of gameplay layers that ship a minimap of their own (Seed and Skirmish layers cover a
 * part of the map with the same 4096 px texture, so they are several times finer than the image of the whole map).
 * Served by this deployment (tools/maptiles, step layer-minimaps): the textures it lists have their image in
 * `/maptiles/<folder>/0/0_0.webp`, a single 4096 px tile, which the long cache lifetime of the tile folders covers.
 */
export const LAYER_MINIMAPS_MANIFEST = "/maptiles/layer-minimaps.json";

/**
 * Where a layer's own minimap lies on the map image: the game stretches the texture between the layer's two
 * MapTextureCorner actors, so the rectangle is the one spanned by `mapTextureCorners`, placed with the same offset
 * from the image's north-west corner as the layer's grid.
 * @param {{corner0: number[], corner1: number[]}} minimap - `SDK_data.minimap` of the active map (metres)
 * @param {{location_x: number, location_y: number}[]} mapTextureCorners - the layer's two corners (centimetres)
 * @param {number} scaleX - map units per metre along X (`gameToMapScale`)
 * @param {number} scaleY - map units per metre along Y (`gameToMapScaleY`)
 * @returns {number[][]} - Leaflet bounds [[north, west], [south, east]], latitude down from 0 as on the map image
 */
export function layerMinimapBounds(minimap, mapTextureCorners, scaleX, scaleY) {
    const [east, south] = layerGridOffset(minimap, mapTextureCorners);
    const [first, second] = mapTextureCorners;
    const width = Math.abs(first.location_x - second.location_x) / 100;
    const height = Math.abs(first.location_y - second.location_y) / 100;
    return [
        [-south * scaleY, east * scaleX],
        [-(south + height) * scaleY, (east + width) * scaleX],
    ];
}
