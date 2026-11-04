/**
 * Relief layer: shaded relief of a map (multi-directional hillshade with an anisotropic sky-view factor,
 * tools/maptiles/py/relief.py in the deployment repository) served as one PMTiles v3 archive of 256 px WebP tiles
 * (https://docs.protomaps.com/pmtiles/), /maptiles/relief/<map>.pmtiles, read with HTTP range requests.
 *
 * The `pmtiles` package is imported only when a relief layer is created, so its code, like the archive, is
 * downloaded when the layer is first selected and never for a user who does not use it.
 */
import { TileLayer } from "leaflet";


/**
 * Tile layer whose tiles come from a PMTiles archive instead of one URL per tile
 * @extends {TileLayer}
 */
class PMTilesLayer extends TileLayer {

    /**
     * @param {import("pmtiles").PMTiles} archive - opened archive
     * @param {object} options - Leaflet TileLayer options
     */
    constructor(archive, options) {
        super("", options);
        this.archive = archive;
    }

    /**
     * Fetch a tile from the archive and show it in an <img>; a tile the archive does not hold stays empty
     * @param {{x: number, y: number}} coords - tile coordinates
     * @param {Function} done - Leaflet callback (error, tile)
     * @returns {HTMLImageElement}
     */
    createTile(coords, done) {
        const tile = document.createElement("img");
        tile.alt = "";
        tile.decoding = "async";
        this.archive.getZxy(this._getZoomForUrl(), coords.x, coords.y).then((response) => {
            if (!response) {
                done(null, tile);
                return;
            }
            const url = URL.createObjectURL(new Blob([response.data], { type: "image/webp" }));
            tile.onload = () => {
                URL.revokeObjectURL(url);
                done(null, tile);
            };
            tile.onerror = (error) => {
                URL.revokeObjectURL(url);
                done(error, tile);
            };
            tile.src = url;
        }).catch((error) => done(error, tile));
        return tile;
    }
}


/**
 * Open a relief archive and build its tile layer
 * @param {string} url - URL of the .pmtiles file
 * @param {import("leaflet").LatLngBounds} bounds - the map image's bounds
 * @returns {Promise<TileLayer>} - the layer, with `options.maxNativeZoom` from the archive's header
 * @throws {Error} - the archive cannot be read (missing file, a server without range requests, not PMTiles)
 */
export async function createReliefLayer(url, bounds) {
    const { PMTiles } = await import("pmtiles");
    const archive = new PMTiles(url);
    const header = await archive.getHeader();
    return new PMTilesLayer(archive, {
        bounds,
        minNativeZoom: header.minZoom,
        maxNativeZoom: header.maxZoom,
        edgeBufferTiles: 1,
        tileSize: 256,
    });
}
