import { decode } from "fast-png";

/**
 * Squad Heightmap
 * Load an heightmap in memory and calculate heights for given LatLng Points
 * @class squadHeightmap
 */
export default class SquadHeightmap {

    /**
     * Load the heightmap for the given map
     * @param {LeafletMap} [map]
     */
    constructor(map) {
        this.map = map;
        this.width = 500;
        this.heightmapScaling = this.width / this.map.pixelSize;
        let heightmapPath = `${process.env.API_URL}${this.map.activeMap.mapURL}heightmap.json`;
        let heightmapPathPNG = `${process.env.API_URL}${this.map.activeMap.mapURL}heightmap.png`;
        this.json = [];
        this.jsonPng = [];
        this.scalingPNG = 0;
        this.loadHeightmapJson(heightmapPath);
        this.loadHeightmapPNG(heightmapPathPNG);
    }


    /**
     * Load the heightmap from a JSON file
     * @param {string} [url] - URL to the JSON file
     * @returns {Promise<boolean>} - Whether the JSON heightmap loaded successfully
     */
    async loadHeightmapJson(url) {
        
        // If no heightmap is provided, don't look for a .json file
        if (!this.map.activeMap.SDK_data.heightmap) return;

        try {
            const response = await fetch(url); // Fetch the JSON file
            let data = await response.json();
            this.json = data;
        } catch (error) {
            console.error("[HEIGHTMAP] Failed to load heightmap:", url);
            console.error("[HEIGHTMAP]   -> ", error);
        }
        
        $(document).trigger("heightmap:loaded");
    }


    /**
     * Load the heightmap from a PNG file.
     * Prefers the precise heightmap served by this deployment (see fetchPreciseHeightmap) and
     * falls back to `url`, SquadCalc's 8-bit-per-channel R/B images: height = (255 + r - b) * scale[2].
     * Decodes raw bytes with fast-png (no canvas, no fingerprinting issues).
     * @param {string} [url] - URL to the 8-bit R/B PNG file
     * @returns {Promise<void>} - Resolves once `jsonPng` holds the heights (left empty on failure)
     */
    async loadHeightmapPNG(url) {

        if (!this.map.activeMap.SDK_data.heightmapPNG) return;

        const heightScale = this.map.activeMap.SDK_data.heightmapPNG.scale[2];

        try {
            const precise = await this.fetchPreciseHeightmap();

            if (precise) {
                this.storeHeights(precise.img, (data, idx) => data[idx] * precise.step);
                console.debug(`[HEIGHTMAP] Loaded ${precise.url} precision: ${(precise.step * 100).toFixed(1)}cm`);
            } else {
                const response = await fetch(url);
                const img = decode(new Uint8Array(await response.arrayBuffer()));
                this.storeHeights(img, (data, idx) => (255 + data[idx] - data[idx + 2]) * heightScale);
                console.debug(`[HEIGHTMAP] Loaded ${url} precision: ${Math.round(heightScale * 100)}cm`);
            }

            $(document).trigger("heightmapPNG:loaded");
        } catch (error) {
            console.error("[HEIGHTMAP] Failed to load PNG heightmap:", url);
            console.error("[HEIGHTMAP]   -> ", error);
        }
    }


    /**
     * Fetch the precise heightmap of the active map from this deployment's /heightmaps/<map>/:
     * a 16-bit grayscale heightmap.png (height = value * z_step_m) and its meta.json. Built from the
     * game's landscape collision fused with SquadHeight's buildings (tools/heightmaps
     * in the deployment repository); it covers the same minimap bounds as the 8-bit one.
     * @returns {Promise<{img: Object, step: number, url: string}|null>} - The decoded PNG and its
     * metres per value, or null when this deployment has no precise heightmap for the map
     */
    async fetchPreciseHeightmap() {
        const mapName = this.map.activeMap.mapURL.split("/").filter(Boolean).pop();
        const base = `/heightmaps/${mapName}/`;

        try {
            const metaResponse = await fetch(`${base}meta.json`);
            if (!metaResponse.ok) return null;
            const meta = await metaResponse.json();

            const response = await fetch(`${base}heightmap.png`);
            if (!response.ok) return null;
            const img = decode(new Uint8Array(await response.arrayBuffer()));

            if (img.depth !== 16 || img.channels !== 1 || !(meta.z_step_m > 0)) return null;

            return { img, step: meta.z_step_m, url: `${base}heightmap.png` };
        } catch {
            // Not served here (dev server answers with index.html, or no file): use SquadCalc's
            return null;
        }
    }


    /**
     * Convert a decoded PNG into `jsonPng`: one Float32Array row of heights in metres per image row
     * (views into a single buffer, half the memory of plain arrays for the largest maps).
     * @param {Object} img - fast-png decode() result
     * @param {function(ArrayLike<number>, number): number} heightOf - height of the pixel whose
     * first channel is at the given index of `img.data`
     * @returns {void}
     */
    storeHeights(img, heightOf) {
        const { width, height, data, channels } = img;
        const heights = new Float32Array(width * height);
        const rows = [];

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                heights[y * width + x] = heightOf(data, (y * width + x) * channels);
            }
            rows.push(heights.subarray(y * width, (y + 1) * width));
        }

        this.scalingPNG = width / this.map.pixelSize;
        this.jsonPng = rows;
    }


    /**
     * Calculate heights for a given LatLng Point
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Altitude
     * @param {LatLng} [latlng] - LatLng Point
     * @returns {integer} - height in meters
     */
    getHeightOLD(latlng){

        // Fallback in case heightmap isn't supplied or didn't load
        if (!this.json || !Array.isArray(this.json)) return 0;

        const row = Math.round(latlng.lat * -this.heightmapScaling);
        const col = Math.round(latlng.lng * this.heightmapScaling);
        let height = 0; // Todo: Implement a better way to handle this, like returning infinity

        if (this.json[row] && typeof this.json[row][col] !== "undefined") {
            height = this.json[row][col];
        }
        
        return height;
    }

    
    getHeight(latlng) {
        if (!this.jsonPng.length || !this.scalingPNG) return 0;

        const row = Math.round(latlng.lat * -this.scalingPNG);
        const col = Math.round(latlng.lng * this.scalingPNG);

        if (this.jsonPng[row] && typeof this.jsonPng[row][col] !== "undefined") {
            return this.jsonPng[row][col];
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