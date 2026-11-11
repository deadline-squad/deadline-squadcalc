import { App } from "../app.js";


/**
 * Squad Heightmap
 * Load the heightmap of a map in memory and give the height of the game's collision at LatLng points.
 * The heightmap of this deployment (/heightmaps/<map>/: 16-bit levels and meta.json, built from the game's landscape
 * collision fused with its static meshes and SquadHeight's buildings, tools/heightmaps in the deployment repository) is
 * fetched and decoded in a worker (heightmapWorker.js) so a map switch does not freeze the page.
 * Events on `document` once the heights of the active map are known (never for a heightmap a map
 * switch replaced meanwhile):
 *   - `heightmapPNG:loaded` when they loaded;
 *   - `heightmap:loaded` after it, also when they failed to load (sessions and imports wait for it
 *     to place their markers).
 * A failed load shows an error toast and sets `failed`: heights are then 0 everywhere, and the firing
 * solutions say they have no height data (SquadFiringSolution.hasHeightData).
 * @class squadHeightmap
 */
export default class SquadHeightmap {

    /**
     * Load the heightmap for the given map
     * @param {LeafletMap} [map]
     */
    constructor(map) {
        this.map = map;
        // One Uint16Array of integer levels per image row (views into one buffer); height = level * step
        this.jsonPng = [];
        this.step = 0;
        // Heightmap pixels per map unit along each axis (see receive)
        this.colsPerUnit = 0;
        this.rowsPerUnit = 0;
        // Meters between two samples (1 on most maps, 0.5 on Chora and Kokan); 0 until a heightmap loaded
        this.resolution = 0;
        // Whether the heights loaded (`heightmapPNG:loaded`), or failed to load: every height is then 0
        this.ready = false;
        this.failed = false;
        this.worker = null;
        this.load();
    }


    /**
     * Load the heights of the active map in the worker, from /heightmaps/<map>/ of this deployment
     * @returns {void} - `jsonPng` holds the heights once `heightmapPNG:loaded` fired; it stays empty on failure
     */
    load() {
        const mapName = this.map.activeMap.mapURL.split("/").filter(Boolean).pop();
        const base = new URL(`/heightmaps/${mapName}/`, window.location.origin).href;
        this.worker = new Worker(new URL("./heightmapWorker.js", import.meta.url));
        this.worker.onmessage = ({ data }) => this.receive(data);
        this.worker.onerror = (event) => this.receive({ error: event.message, url: base });
        this.worker.postMessage({ base });
    }


    /**
     * Store the worker's result and announce it
     * @param {{levels: Uint16Array, width: number, height: number, step: number, resolution: number, url: string}|{error: string, url: string}} data
     */
    receive(data) {
        this.dispose();
        if (this.map.heightmap !== this) return;

        if (data.error) {
            console.error("[HEIGHTMAP] Failed to load the heightmap:", data.url);
            console.error("[HEIGHTMAP]   -> ", data.error);
            this.failed = true;
            App.openToast("error", "heightmapFailed", "heightmapFailedDesc");
        } else {
            const { levels, width, height } = data;
            const rows = [];
            for (let y = 0; y < height; y++) rows.push(levels.subarray(y * width, (y + 1) * width));
            this.jsonPng = rows;
            this.step = data.step;
            // The grid has one sample per `resolution` meters (meta.json resolution_m, 1 unless the map is built
            // finer) from the minimap's min corner to its max corner included (width = map size X / resolution
            // + 1, height = size Y / resolution + 1, tools/heightmaps meta.json), so its last sample sits on the
            // map's edge, pixelSize units away; the unit counts below follow from the grid, whatever its resolution
            this.resolution = data.resolution > 0 ? data.resolution : 1;
            this.colsPerUnit = (width - 1) / this.map.pixelSize;
            this.rowsPerUnit = (height - 1) / this.map.pixelSize;
            this.ready = true;
            console.debug(`[HEIGHTMAP] Loaded ${data.url} precision: ${(data.step * 100).toFixed(1)}cm`);
            $(document).trigger("heightmapPNG:loaded");
        }
        $(document).trigger("heightmap:loaded");
    }


    /**
     * Stop a load in progress (the map switched to another one)
     */
    dispose() {
        if (this.worker) this.worker.terminate();
        this.worker = null;
    }


    /**
     * Height at a LatLng Point on the game's collision surface: every quad of four heightmap samples
     * is two triangles split along the diagonal from its (row, col) corner to its (row + 1, col + 1)
     * corner, the split of the game's landscape collision (found with positions the game server logged:
     * tools/heightmaps/py/audit_ground_truth.py in the deployment repository), and the height is
     * interpolated on the triangle the point is in (row = -lat, col = lng, each scaled to the grid of
     * its axis). Bilinear interpolation differs from it by the quad's twist times fy * (1 - fx), up to
     * a quarter of the twist at the quad's centre (1.1 m on the steepest Al Basrah quad).
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Altitude
     * @param {LatLng} latlng - LatLng Point
     * @returns {number} - height in meters; 0 more than half a sample outside the heightmap or before
     *   it loaded (the edge sample within half a sample, like the nearest sample did)
     */
    getHeight(latlng) {
        const rows = this.jsonPng.length;
        if (!rows || !this.colsPerUnit) return 0;
        const cols = this.jsonPng[0].length;

        let row = latlng.lat * -this.rowsPerUnit;
        let col = latlng.lng * this.colsPerUnit;
        if (!(row >= -0.5 && row <= rows - 0.5 && col >= -0.5 && col <= cols - 0.5)) return 0;
        row = Math.min(Math.max(row, 0), rows - 1);
        col = Math.min(Math.max(col, 0), cols - 1);

        const row0 = Math.min(Math.floor(row), rows - 2);
        const col0 = Math.min(Math.floor(col), cols - 2);
        const rowWeight = row - row0;
        const colWeight = col - col0;
        const top = this.jsonPng[row0];
        const bottom = this.jsonPng[row0 + 1];
        const corner = top[col0];
        const level = colWeight >= rowWeight
            ? corner + (top[col0 + 1] - corner) * colWeight + (bottom[col0 + 1] - top[col0 + 1]) * rowWeight
            : corner + (bottom[col0] - corner) * rowWeight + (bottom[col0 + 1] - bottom[col0]) * colWeight;
        return level * this.step;
    }


    /**
     * Calculate a path of heights between two points, with optional terrain margins
     * @param {LatLng} mortarLatlng
     * @param {LatLng} targetLatlng
     * @param {number} STEP - samples between weapon and target
     * @param {number} extraBefore - fraction of path to extend before weapon
     * @param {number} extraAfter  - fraction of path to extend after target
     * @returns {{ path: number[], weaponIndex: number, targetIndex: number }}
     */
    getHeightPath(mortarLatlng, targetLatlng, STEP = 100, extraBefore = 0.15, extraAfter = 0.15) {
        const latDiff = targetLatlng.lat - mortarLatlng.lat;
        const lngDiff = targetLatlng.lng - mortarLatlng.lng;

        const extraBeforeSteps = Math.round(STEP * extraBefore);
        const extraAfterSteps  = Math.round(STEP * extraAfter);
        const totalSteps = STEP + extraBeforeSteps + extraAfterSteps;

        const START = {
            lat: mortarLatlng.lat - latDiff * extraBefore,
            lng: mortarLatlng.lng - lngDiff * extraBefore,
        };
        const totalLatDiff = latDiff * (1 + extraBefore + extraAfter);
        const totalLngDiff = lngDiff * (1 + extraBefore + extraAfter);

        const path = [];
        for (let i = 0; i < totalSteps; i++) {
            path.push(this.getHeight(START));
            START.lat += totalLatDiff / totalSteps;
            START.lng += totalLngDiff / totalSteps;
        }

        return {
            path,
            weaponIndex: extraBeforeSteps,
            targetIndex: extraBeforeSteps + STEP - 1,
        };
    }

}