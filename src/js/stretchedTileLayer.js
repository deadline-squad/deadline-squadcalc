import { TileLayer, Point } from "leaflet";

/**
 * A tile layer whose tiles are cut on one grid and drawn over another rectangle: the point at map position f of the
 * tile grid (map units east and south of the grid's origin, the map's north-west corner) is drawn at
 * `offset + scale * f`, per axis (mapImages.js `upstreamTileTransform`). Leaflet places every tile of a zoom level in
 * one container moved by a CSS transform (GridLayer._setZoomTransform); this layer adds the per-axis offset and
 * scale to that transform, so the tiles keep their seams and Leaflet's loading, pruning and zoom animation are
 * unchanged. The tiles a view needs are still chosen on the grid: on a map that is moved or scaled by a fraction
 * of a tile the `edgeBufferTiles` around the view cover the difference.
 * @param {string} url - tile URL template
 * @param {object} options - TileLayer options and `transform: {offset: number[], scale: number[]}`
 */
export class StretchedTileLayer extends TileLayer {

    /**
     * Same as GridLayer._setZoomTransform with the layer's transform: a tile at pixel q of its level (zoom z, so
     * q = f * 2^z) lies at `offset * 2^z + scale * q`, which at the map's zoom is moved by the level's scale
     * and the map's pixel origin.
     * @param {{el: HTMLElement, origin: Point, zoom: number}} level - Leaflet's tile level
     * @param {LatLng} center - centre of the view
     * @param {number} zoom - zoom of the view
     */
    _setZoomTransform(level, center, zoom) {
        const { offset, scale } = this.options.transform;
        const zoomScale = this._map.getZoomScale(zoom, level.zoom);
        const levelPixels = this._map.getZoomScale(level.zoom, 0);
        const translate = new Point(
            zoomScale * (offset[0] * levelPixels + scale[0] * level.origin.x),
            zoomScale * (offset[1] * levelPixels + scale[1] * level.origin.y),
        ).subtract(this._map._getNewPixelOrigin(center, zoom)).round();
        level.el.style.transform = `translate3d(${translate.x}px,${translate.y}px,0) scale(${zoomScale * scale[0]},${zoomScale * scale[1]})`;
    }
}
