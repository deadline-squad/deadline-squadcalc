import { App } from "../app.js";
import { Polyline, LayerGroup } from "leaflet";

export default class TargetGrid {
    
    static get ANGLE_DEV() { return 12; }
    static get ANGLE_STEP() { return 2; }
    static get lineOptions() { return { color: "Lime", weight: 2, opacity: 0.7 }; }

    constructor(map, firingSolution, weaponMarker) {
        this.map = map;
        this.firingSolution = firingSolution;
        this.weaponMarker = weaponMarker;
        this.elevation = weaponMarker.angleType === "high" ? firingSolution.elevation.high.mil : firingSolution.elevation.low.mil;
        this.linesGroup = new LayerGroup();

        // Weapon in degree have 6*1 deg elevation lines, others hav 5*10 miliradians
        if (this.firingSolution.activeWeapon.unit === "deg") {
            this.ELEVATION_DEVIATION = this.firingSolution.degToMil(1) * 6;
            this.ELEVATION_STEP = this.firingSolution.degToMil(1);
        } else {
            this.ELEVATION_DEVIATION = 60;
            this.ELEVATION_STEP = 10;
        }

        if (App.userSettings.targetGrid) {
            this.build();
            this.show();
        }
    }


    /**
     * Builds the arc and segment grid around the mortar based on current elevation.
     * 
     * This function corrects for the known imprecision in range inversion (used for grid spacing),
     * especially when elevation or height differences skew the result. It does so by:
     * 
     * 1. Computing the actual distance using full quadratic projectile motion (with heightDiff).
     * 2. Comparing it with the distance returned from a simpler inverse method.
     * 3. Averaging the difference and applying it to all arc radii to maintain consistency.
     * 
     * @return {number|undefined} Minimum ground distance, or nothing if computation failed.
     */
    build() {

        // Fix the reverse distance methode by finding an average delta value to apply
        const REVERSEDIST = this.firingSolution.getProjectileDistance(this.firingSolution.milToDeg(this.elevation));
        const QUADRATICDIST = this.firingSolution.distance;
        const AVGDELTA = QUADRATICDIST - REVERSEDIST;
        const BEARING = this.firingSolution.bearing;
        const weaponLatLng = this.weaponMarker.getLatLng();

        // Radii in meters
        const startRadius = this.firingSolution.getProjectileDistance(this.firingSolution.milToDeg(this.elevation - this.ELEVATION_DEVIATION/2)) + AVGDELTA;
        const endRadius = this.firingSolution.getProjectileDistance(this.firingSolution.milToDeg(this.elevation + this.ELEVATION_DEVIATION/2)) + AVGDELTA;
        if (isNaN(startRadius) || isNaN(endRadius)) return;

        // Start drawing the horizontal arcs
        for (let i = this.elevation - this.ELEVATION_DEVIATION/2; i <= this.elevation + this.ELEVATION_DEVIATION/2 + 1; i = i+ this.ELEVATION_STEP) {
            let aproxDist = this.firingSolution.getProjectileDistance(this.firingSolution.milToDeg(i));
            let finalDist = aproxDist + AVGDELTA;
            this.linesGroup.addLayer(this.drawArc(weaponLatLng, BEARING, -TargetGrid.ANGLE_DEV/2, TargetGrid.ANGLE_DEV/2, finalDist));
        }

        // Start drawing vertical segment
        for (let i= -TargetGrid.ANGLE_DEV/2; i <= TargetGrid.ANGLE_DEV/2; i= i + TargetGrid.ANGLE_STEP) {
            this.linesGroup.addLayer(this.drawSegmentAtAngle(weaponLatLng, BEARING + i, startRadius, endRadius));
        }
    }

    /**
     * Point at a distance and bearing from another, each map axis with its own scale (fromMeters)
     * @param {LatLng} origin
     * @param {number} distance - meters
     * @param {number} bearingDeg - degrees clockwise from north
     * @returns {{lat: number, lng: number}}
     */
    pointAt(origin, distance, bearingDeg) {
        const rad = bearingDeg * Math.PI / 180;
        return this.map.fromMeters(origin, distance * Math.sin(rad), distance * Math.cos(rad));
    }

    drawArc(centerLatLng, bearingDeg, startOffset, endOffset, radius, segments = 64) {
        const points = [];
        const step = (endOffset - startOffset) / segments;

        for (let offset = startOffset; offset <= endOffset; offset += step) {
            points.push(this.pointAt(centerLatLng, radius, bearingDeg + offset));
        }

        return new Polyline(points, TargetGrid.lineOptions);
    }

    drawSegmentAtAngle(originLatLng, bearingDeg, innerRadius, outerRadius) {
        return new Polyline([this.pointAt(originLatLng, innerRadius, bearingDeg), this.pointAt(originLatLng, outerRadius, bearingDeg)], TargetGrid.lineOptions);
    }

    show(){
        this.linesGroup.addTo(this.map.targetGrids);
    }

    hide(){
        this.linesGroup.removeFrom(this.map.targetGrids);
    }

    clear(){
        this.linesGroup.clearLayers();
    }

}