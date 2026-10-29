/**
 * Squad Heightmap
 * Load an heightmap in memory and calculate heights for given LatLng Points.
 * The PNG is fetched and decoded in a worker (heightmapWorker.js) so a map switch does not freeze the page.
 * Events on `document` once the heights of the active map are known (never for a heightmap a map
 * switch replaced meanwhile):
 *   - `heightmapPNG:loaded` when they loaded;
 *   - `heightmap:loaded` after it, also when they failed to load (sessions and imports wait for it
 *     to place their markers).
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
        // Heightmap pixels per map unit (LatLng) along X (lng) and Y (lat)
        this.scalingX = 0;
        this.scalingY = 0;
        // Whether `jsonPng` holds the precise game heightmap (mm steps), not the 8-bit one (up to 2 m steps)
        this.precise = false;
        this.worker = null;
        this.loadHeightmapPNG(`${process.env.API_URL}${this.map.activeMap.mapURL}heightmap.png`);
    }


    /**
     * Load the heights in the worker.
     * Prefers the precise heightmap served by this deployment in /heightmaps/<map>/ (16-bit grayscale
     * heightmap.png and its meta.json; built from the game's landscape collision fused with SquadHeight's
     * buildings, tools/heightmaps in the deployment repository; same minimap bounds as the 8-bit one)
     * and falls back to `url`, SquadCalc's 8-bit-per-channel R/B images: height = (255 + r - b) * scale[2].
     * @param {string} url - URL of the 8-bit R/B PNG file
     * @returns {void} - `jsonPng` holds the heights once `heightmapPNG:loaded` fired; it stays empty on failure
     */
    loadHeightmapPNG(url) {
        const heightmapPNG = this.map.activeMap.SDK_data.heightmapPNG;
        if (!heightmapPNG) return;

        const mapName = this.map.activeMap.mapURL.split("/").filter(Boolean).pop();
        this.worker = new Worker(new URL("./heightmapWorker.js", import.meta.url));
        this.worker.onmessage = ({ data }) => this.receive(data);
        this.worker.onerror = (event) => this.receive({ error: event.message, url });
        this.worker.postMessage({
            preciseBase: new URL(`/heightmaps/${mapName}/`, window.location.origin).href,
            fallbackUrl: url,
            fallbackScale: heightmapPNG.scale[2],
        });
    }


    /**
     * Store the worker's result and announce it
     * @param {{levels: Uint16Array, width: number, height: number, step: number, precise: boolean, url: string}|{error: string, url: string}} data
     */
    receive(data) {
        this.dispose();
        if (this.map.heightmap !== this) return;

        if (data.error) {
            console.error("[HEIGHTMAP] Failed to load PNG heightmap:", data.url);
            console.error("[HEIGHTMAP]   -> ", data.error);
        } else {
            const { levels, width, height } = data;
            const rows = [];
            for (let y = 0; y < height; y++) rows.push(levels.subarray(y * width, (y + 1) * width));
            this.jsonPng = rows;
            this.step = data.step;
            if (data.precise) {
                // The precise heightmap samples whole metres from the minimap's corner0 to corner1 (both included):
                // width = size + 1, height = sizeY + 1, the same scales as the grid (gameToMapScale, gameToMapScaleY)
                this.scalingX = (width - 1) / this.map.pixelSize;
                this.scalingY = (height - 1) / this.map.pixelSize;
            } else {
                this.scalingX = width / this.map.pixelSize;
                this.scalingY = this.scalingX;
            }
            this.precise = data.precise;
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
     * Height at a LatLng Point, from the nearest heightmap pixel
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Altitude
     * @param {LatLng} latlng - LatLng Point
     * @returns {number} - height in meters, 0 outside the heightmap or before it loaded
     */
    getHeight(latlng) {
        if (!this.jsonPng.length || !this.scalingX) return 0;

        const row = Math.round(latlng.lat * -this.scalingY);
        const col = Math.round(latlng.lng * this.scalingX);

        if (this.jsonPng[row] && typeof this.jsonPng[row][col] !== "undefined") {
            return this.jsonPng[row][col] * this.step;
        }
        return 0;
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