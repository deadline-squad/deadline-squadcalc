import { ImageOverlay, LatLngBounds } from "leaflet";
import i18next from "i18next";
import { App } from "../app.js";
import { SHOULDER_HEIGHT } from "./squadCoverageRays.js";
import { heatmapGrid, MAX_RANGE, rasterizeHeatmap } from "./positionHeatmap.js";

// Stacking of the image in the overlay pane, as the fire coverage's (below the damage zones and the markers' SVG)
const HEATMAP_Z_INDEX = 2;

/**
 * Reverse-position heatmap of a squadMinimap (deadline-squad/deadline-squadcalc#22 C5, computation in
 * positionHeatmap.js): the ground positions around one target from where a direct-fire weapon has a clear line of
 * fire to it, at the height chosen for the target, scored by distance and obstacle clearance. The volume layer
 * computes it in its worker (squadVolume.positionHeatmap) with the voxels and, where the target has a precision
 * region, the exact triangles; this class holds the target it is shown for, draws the image and the legend and
 * keeps it current. Loaded on demand by the target dialog's button (the module is a chunk of its own); off by default.
 */
export default class SquadPositionHeatmap {

    /**
     * @param {squadMinimap} map
     */
    constructor(map) {
        this.map = map;
        this.target = null;
        this.overlay = null;
        this.overlayUrl = null;
        this.signature = null;
        // Incremented to abandon a computation in progress
        this.generation = 0;
        // What the last computation did, for the legend and the browser checks
        this.result = null;
    }

    /**
     * Show the heatmap of a target, or hide it when it is the one shown
     * @param {squadTargetMarker} target
     * @returns {boolean} - whether the heatmap is shown for the target now
     */
    toggle(target) {
        if (this.target === target) {
            this.hide();
            return false;
        }
        this.target = target;
        this.update(true);
        return true;
    }

    /**
     * Whether the heatmap is shown for a target
     * @param {squadTargetMarker} target
     * @returns {boolean}
     */
    isShownFor(target) {
        return this.target === target;
    }

    /**
     * Remove the heatmap and forget the target
     */
    hide() {
        this.target = null;
        this.clear();
        $(document).trigger("positionHeatmap:changed");
    }

    /**
     * Remove the drawing and stop a computation in progress; the target stays
     */
    clear() {
        this.generation++;
        this.signature = null;
        this.result = null;
        this.removeOverlay();
        $("#positionHeatLegend").hide();
    }

    /**
     * Whether the weapon and the layer can answer the question: a direct-fire weapon (it has a sight and a spread)
     * and the volume layer of the map
     * @returns {boolean}
     */
    canCompute() {
        return App.activeWeapon?.type === "directFire" && this.map.volume.ready;
    }

    /**
     * Recompute the heatmap when its inputs changed (the target moved or got another height, another weapon, another
     * map); hide it when the target is gone or the question cannot be answered any more
     * @param {boolean} [force=false] - recompute even if nothing changed
     */
    update(force = false) {
        const target = this.target;
        if (!target) return;
        if (!this.map.activeTargetsMarkers.hasLayer(target) || target.isDragging || !this.canCompute()) {
            this.hide();
            return;
        }

        const weapon = App.activeWeapon;
        const latlng = target.getLatLng();
        const signature = [
            this.map.activeMap.name, weapon.name, weapon.velocity, weapon.moa, latlng.lat, latlng.lng, target.getTargetHeight(),
        ].join("|");
        if (!force && signature === this.signature) return;
        this.signature = signature;
        this.compute(target, weapon);
    }

    /**
     * Compute the heatmap of `target` for `weapon` in the volume layer's worker, then draw it
     * @param {squadTargetMarker} target
     * @param {Weapon} weapon
     */
    compute(target, weapon) {
        const generation = ++this.generation;
        this.removeOverlay();
        this.result = null;
        const latlng = target.getLatLng();
        const aimedHeight = target.getTargetHeight();
        const gravity = App.gravity * weapon.gravityScale;
        const range = Math.min(weapon.getMaxDistance(), MAX_RANGE);
        const { cell, rays } = heatmapGrid(range);
        const params = {
            targetZ: aimedHeight ?? this.map.heightmap.getHeight(latlng),
            elevated: aimedHeight !== null,
            shot: weapon.muzzle || weapon.heightOffset > 0 ? weapon.getShot(gravity) : weapon.getShot(gravity, SHOULDER_HEIGHT),
            range,
            cell,
            rays,
            elevationLimits: weapon.minElevation,
            angleOffset: weapon.angleOffset || 0,
            lifespan: weapon.projectileLifespan,
            moa: weapon.moa,
        };

        this.showStatus(i18next.t("common:heatComputing", { percent: 0 }));
        const started = performance.now();
        this.map.volume.positionHeatmap(
            params,
            latlng,
            (from, east, north) => this.map.fromMeters(from, east, north),
            () => generation === this.generation,
            (share) => this.showStatus(i18next.t("common:heatComputing", { percent: Math.round(share * 100) })),
        ).then((answer) => {
            if (generation !== this.generation) return;
            if (!answer) {
                this.hide();
                return;
            }
            const { pixels, size } = rasterizeHeatmap(answer.values, rays, cell, range);
            this.result = { ...answer, range, cell, rays, wallMs: performance.now() - started };
            this.draw(latlng, pixels, size, cell, generation);
        });
    }

    /**
     * Put the image on the map and the legend under it. The PNG is encoded off the main thread (`toBlob`) and shown
     * from an object URL; an image that a newer computation replaced meanwhile is dropped.
     * @param {LatLng} center - the target
     * @param {Uint8ClampedArray} pixels - RGBA, from rasterizeHeatmap
     * @param {number} size - side of the image in pixels
     * @param {number} cell - meters per pixel
     * @param {number} generation - the computation that made the image
     */
    draw(center, pixels, size, cell, generation) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        canvas.getContext("2d").putImageData(new ImageData(pixels, size, size), 0, 0);

        const half = (size * cell) / 2;
        const bounds = new LatLngBounds(this.map.fromMeters(center, -half, -half), this.map.fromMeters(center, half, half));

        canvas.toBlob((blob) => {
            if (generation !== this.generation) return;
            this.removeOverlay();
            this.overlayUrl = blob ? URL.createObjectURL(blob) : canvas.toDataURL();
            this.overlay = new ImageOverlay(this.overlayUrl, bounds, { className: "positionHeatOverlay", interactive: false, zIndex: HEATMAP_Z_INDEX }).addTo(this.map);
            const { exact, margin } = this.result;
            this.showStatus(exact ? i18next.t("common:heatExact", { metres: Math.floor(margin) }) : i18next.t("common:heatVoxelsOnly"));
            $(document).trigger("positionHeatmap:changed");
        });
    }

    /**
     * Show the legend with a line under the swatches
     * @param {string} text
     */
    showStatus(text) {
        $("#positionHeatStatus").text(text);
        $("#positionHeatLegend").show();
    }

    /**
     * Take the image off the map and release its object URL
     */
    removeOverlay() {
        if (this.overlay) this.overlay.remove();
        if (this.overlayUrl?.startsWith("blob:")) URL.revokeObjectURL(this.overlayUrl);
        this.overlay = null;
        this.overlayUrl = null;
    }
}
