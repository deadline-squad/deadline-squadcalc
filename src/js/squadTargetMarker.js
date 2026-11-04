
import { App } from "../app.js";
import { CircleMarker, Polyline, Polygon, Popup, Icon, ImageOverlay, LatLngBounds } from "leaflet";
import SquadSimulation from "./squadSimulation.js";
import SquadFiringSolution from "./squadFiringSolution.js";
import TargetGrid from "./squadTargetGrid.js";
import { sendTargetData } from "./squadCalcAPI.js";
import { Ellipse } from "./libs/leaflet-ellipse.js";
import { squadMarker } from "./squadMarker.js";
import { damageField, hitProbability, roundsNeeded, KILL_DAMAGE, WOUND_DAMAGE } from "./squadDamage.js";
import { notifyBridgeChange } from "./smcConnector.js";
import i18next from "i18next";

const CARPET_MAX_TARGETS = 10;
const GRID_MAX_SIDE = 5;

// Damage zone with cover: RGBA of the cells where a round on the target kills, wounds, or would
// wound a soldier hidden by the terrain or a building
const COVER_COLORS = {
    kill: [231, 76, 60, 120],
    wound: [243, 156, 18, 80],
    covered: [52, 152, 219, 140],
};

// Grid step of the damage zone, in meters: finer for small explosions, coarser above COARSE_RADIUS
const COVER_CELL = 0.5;
const COVER_CELL_COARSE = 1;
const COARSE_RADIUS = 30;

// Stacking of the damage zone image in the overlay pane: above the map image and the fire coverage
// (SquadCoverage), which are image overlays too, below the SVG of the markers' circles (z-index 200)
const COVER_ZONE_Z_INDEX = 3;

// Confidence the rounds-to-kill count is computed for
const ROUNDS_CONFIDENCE = 0.9;

// Milliseconds of main-thread work per task when the damage zones are computed
const COVER_ZONE_BUDGET_MS = 8;

// Damage zone images and hit probabilities kept by (map, position, shell, spread): a target that goes
// back to a place it has been (undo, a weapon or shell switched back and forth) does not compute again
const COVER_CACHE_SIZE = 64;
const coverZoneImages = new Map();
const hitProbabilities = new Map();

// Damage zones waiting to be computed, one task of COVER_ZONE_BUDGET_MS at a time (a MessageChannel
// message starts each, so input and rendering run between them): redrawing every target when the weapon
// or shell changes no longer freezes the page
const coverQueue = [];
let coverChannel = null;
let coverScheduled = false;

/**
 * Remember a value in a bounded cache, the least recently used entry going first
 * @param {Map} cache
 * @param {string} key
 * @param {*} value
 */
function remember(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > COVER_CACHE_SIZE) cache.delete(cache.keys().next().value);
}

/**
 * Ask for the next task of the damage zone queue
 */
function scheduleCoverQueue() {
    if (coverScheduled || !coverQueue.length) return;
    if (!coverChannel) {
        coverChannel = new MessageChannel();
        coverChannel.port1.onmessage = () => {
            coverScheduled = false;
            processCoverQueue();
        };
    }
    coverScheduled = true;
    coverChannel.port2.postMessage(null);
}

/**
 * Compute the queued damage zones for COVER_ZONE_BUDGET_MS, then give the page back. A zone whose target
 * moved on or was deleted meanwhile (its `coverPending` is no longer the job's signature) is dropped.
 */
function processCoverQueue() {
    const deadline = performance.now() + COVER_ZONE_BUDGET_MS;
    while (coverQueue.length && performance.now() < deadline) {
        const job = coverQueue[0];
        if (job.target.coverPending !== job.signature) {
            coverQueue.shift();
            continue;
        }
        job.field = damageField(job.heightAt, job.explosion, job.cell, { ...job.field, firstRow: job.field?.nextRow ?? 0, deadline });
        if (job.field.nextRow < job.field.size) break;
        coverQueue.shift();
        job.target.finishCoverZone(job);
    }
    scheduleCoverQueue();
}

export const squadTargetMarker = squadMarker.extend({

    options: {
        keyboard: true,
    },

    getAccessibleName: function() {
        return i18next.t("tooltips:targetMarker");
    },

    initialize: function (latlng, options, map) {

        squadMarker.prototype.initialize.call(this, latlng, options, map);

        if (options.uid) this.fromSession = true;

        // Bursts marked to correct the fire of the first weapon (addImpact), and the damage zone image
        this.impacts = [];
        this.coverOverlay = null;
        this.coverSignature = null;
        // Signature of the damage zone in the queue, null when none waits; hidden while other targets are hovered
        this.coverPending = null;
        this.coverHidden = false;
        // Pending frame of the popups and spread when the target is dragged
        this.calcFrame = null;
        
        let popUpOptions_weapon1 = {
            autoPan: false,
            autoClose: false,
            closeButton: false,
            closeOnEscapeKey: false,
            bubblingMouseEvents: false,
            interactive: false,
            minWidth: 100,
            className: "calcPopup",
        };

        let popUpOptions_weapon2 = {
            ...popUpOptions_weapon1,
            className: "calcPopup2"
        };

        this.posPopUpOptions = {
            ...popUpOptions_weapon1,
            className: "posPopUpTarget"
        };

        this.spreadOptionsOn = {
            opacity: 1,
            fillOpacity: 0.2,
            color: this.fromSession ? "#008abd" : App.mainColor,
            weight: 1.3,
        };

        this.spreadOptionsOff = {
            opacity: 0,
            fillOpacity: 0,
        };

        this.hundredDamageCircleOn = {
            radius: 0,
            opacity: 1,
            fillOpacity: 0,
            dashArray: "5,3",
            color: this.fromSession ? "#008abd" : App.mainColor,
            weight: 1.3,
        };

        this.twentyFiveDamageCircleOn = {
            radius: 0,
            opacity: 1,
            fillOpacity: 0,
            dashArray: "5,6",
            color: this.fromSession ? "#008abd" : App.mainColor,
            weight: 1.3,
        };

        this.miniCircleOptions = {
            radius: 4,
            opacity: 0,
            color: this.fromSession ? "#008abd" : App.mainColor,
            fillOpacity: 0,
            weight: 1,
            autoPan: false,
        };

        this.isDragging = false;

        // Create marker
        this.addTo(this.map.activeTargetsMarkers);
        this.miniCircle = new CircleMarker(latlng, this.miniCircleOptions).addTo(this.map.markersGroup);
        this.firingSolution1 = new SquadFiringSolution(this.map.activeWeaponsMarkers.getLayers()[0].getLatLng(), this.getAimLatLng(), this.map, this.map.activeWeaponsMarkers.getLayers()[0].heightPadding, this.getLatLng());

        // Report target to squadcalc API
        if (!options.uid && !options.skipApiReport && App.activeWeapon.heatmap) {
            sendTargetData({
                lat: latlng.lat,
                lng: latlng.lng,
                weapon: App.activeWeapon.name,
                map: App.minimap.activeMap.name,
            });
        }

        // Calc PopUps
        this.calcMarker1 = new Popup(popUpOptions_weapon1).setLatLng(latlng).addTo(this.map.markersGroup);
        this.calcMarker2 = new Popup(popUpOptions_weapon2).setLatLng(latlng).addTo(this.map.markersGroup);
        
        // posPopUp
        this.posPopUp = new Popup(this.posPopUpOptions).setLatLng(latlng).addTo(this.map.markersGroup).close();
        this.updateCalcPopUps();

        const [html1, clipboard1] = this.getContent(this.firingSolution1, this.map.activeWeaponsMarkers.getLayers()[0].angleType);
        this.calcMarker1.setContent(html1).openOn(this.map);
        if (App.userSettings.copyTarget && !options.uid && !options.skipApiReport) navigator.clipboard.writeText(clipboard1);
        

        // If two weapons already on the map
        if (this.map.activeWeaponsMarkers.getLayers().length === 2) {
            this.firingSolution2 = new SquadFiringSolution(this.map.activeWeaponsMarkers.getLayers()[1].getLatLng(), this.getLatLng(), this.map, this.map.activeWeaponsMarkers.getLayers()[1].heightPadding);
            this.calcMarker1.setContent(`1. ${html1}`);
            const [html2, clipboard2] = this.getContent(this.firingSolution2, this.map.activeWeaponsMarkers.getLayers()[1].angleType);
            this.calcMarker2.setContent(`2. ${html2}`).openOn(this.map);
            if (App.userSettings.copyTarget && !options.uid && !options.skipApiReport) navigator.clipboard.writeText(`${clipboard1} / ${clipboard2}`);
        }

        // Initialise the target Grid
        this.grid = new TargetGrid(this.map, ...this.getFirstAvailableWeapon());
        this.linesBetweenTargets = [];
        this.drawLineToTarget();

        // Initiate Spread Ellipse
        this.spreadMarker1 = new Ellipse(latlng, [0, 0], 0, this.spreadOptionsOff).addTo(this.map.markersGroup);
        this.spreadMarker11 = new Ellipse(latlng, [0, 0], 0, this.spreadOptionsOff).addTo(this.map.markersGroup);
        this.spreadMarker2 = new Ellipse(latlng, [0, 0], 0, this.spreadOptionsOff).addTo(this.map.markersGroup);
        
        this.updateSpread();

        // Initiate Damage Ellipse
        this.hundredDamageRadius = new Ellipse(latlng, [0, 0], 0, this.hundredDamageCircleOn).addTo(this.map.markersGroup);
        this.twentyFiveDamageRadius = new Ellipse(latlng, [0, 0], 0, this.twentyFiveDamageCircleOn).addTo(this.map.markersGroup);
        this.updateDamageRadius();

        this.updateIcon(true);

        // Custom events handlers
        this.on("click", this._handleClick, this);
        this.on("drag", this._handleDrag, this);
        this.on("contextmenu", this._handleContextMenu, this);
        this.on("pointerdown", this._handlePointerDown, this);

        if (App.hasMouse) {
            this.on("pointerover", this._handleMouseOver, this);
            this.on("pointerout", this._handleMouseOut, this);
        }

    },

    
    /**
     * Update the Calculation PopUps position
     * according to marker type selected in user settings (Large/Minimal)
     */
    updateCalcPopUps: function(){
        if (!App.userSettings.targetAnimation) {
            this.calcMarker1.options.offset = [-60, 15];
            this.calcMarker2.options.offset = [63, 15];
        }
        else {
            this.calcMarker1.options.offset = [-65, 0];
            this.calcMarker2.options.offset = [68, 0];
        }
        this.calcMarker1.update();
        this.calcMarker2.update();
    },


    /**
     * Remove the target marker and every object tied
     */
    delete: function(broadcast = true){

        if (broadcast && App.session.ws && App.session.ws.readyState === WebSocket.OPEN) {
            App.session.ws.send(JSON.stringify({ type: "DELETE_TARGET", uid: this.uid}));
            console.debug(`[SESSION] Sent delete request for target with UID: ${this.uid}`);
        }

        // Unbind all custom event handlers
        this.off();
        cancelAnimationFrame(this.calcFrame);
        this.calcFrame = null;

        // Remove the marker from targets array history
        this.map.history = this.map.history.filter(object => object !== this);

        // Remove everything attached from the map
        this.spreadMarker1.removeFrom(this.map.markersGroup).remove();
        this.spreadMarker11.removeFrom(this.map.markersGroup).remove();
        this.spreadMarker2.removeFrom(this.map.markersGroup).remove();
        this.calcMarker1.removeFrom(this.map.markersGroup).remove();
        this.calcMarker2.removeFrom(this.map.markersGroup).remove();
        this.miniCircle.removeFrom(this.map.markersGroup).remove();
        this.hundredDamageRadius.removeFrom(this.map.markersGroup).remove();
        this.twentyFiveDamageRadius.removeFrom(this.map.markersGroup).remove();
        this.posPopUp.removeFrom(this.map.markersGroup).remove();
        this.impacts.forEach((impact) => this.removeImpactLayers(impact));
        this.removeCoverZone();

        this.grid.clear();
        this.removeLineToTarget();
        
        // Remove the marker itself
        this.removeFrom(this.map.markersGroup).removeFrom(this.map.activeTargetsMarkers).remove();
    
        // If that was the last Marker on the map, hide "delete/undo" buttons
        if (!this.map.hasMarkers()) $(".btn-delete, .btn-undo").hide();
        notifyBridgeChange();
    },


    /**
     * Returns the HTML content for the calculation popups
     * @param {SquadFiringSolution} firingSolution 
     * @param {String} angleType 
     * @returns {String[]} - [HTML content, summary text]
     */
    getContent: function (firingSolution, angleType) {
        const DIST = firingSolution.distance;
        const BEARING = firingSolution.bearing;
        let heightDiff = Number.isFinite(firingSolution.heightDiff) ? firingSolution.heightDiff.toFixed(0) : "---";

        // Avoid "-0"
        if (heightDiff !== "---" && (heightDiff == -0 || Math.sign(heightDiff) === 1)) {
            heightDiff = `+${Math.abs(heightDiff)}`;
        }

        /**
         * Formats elevation and time of flight values
         * @param {Object} elevationData 
         * @param {Number} timeOfFlight 
         * @returns {[string, string]} - [elevation, timeOfFlight]
         */
        const formatElevationData = (elevationData, timeOfFlight, arc) => {
            if (isNaN(elevationData?.rad)) return ["---", "---"];

            let convertedElevation;

            // Direct fire flies for fractions of a second: tenths matter to lead a moving target
            const timeDigits = App.activeWeapon.type === "directFire" ? 1 : 0;
            const formattedTime = `${timeOfFlight.toFixed(timeDigits)}<span data-i18n="common:s">${i18next.t("common:s")}</span>`;

            switch (App.activeWeapon.unit) {
            case "sec":
                convertedElevation = `${App.activeWeapon.getHoldTime(elevationData.deg).toFixed(App.activeWeapon.elevationPrecision)}${i18next.t("common:s")}`;
                break;
            case "mil":
                convertedElevation = elevationData.mil.toFixed(App.activeWeapon.elevationPrecision);
                break;
            case "degMin": {
                // Convert degrees to degrees + minutes
                let degrees = Math.floor(elevationData.deg);
                let minutes = Math.round((elevationData.deg - degrees) * 60);
                if (minutes === 60) {
                    degrees += 1;
                    minutes = 0;
                }
                convertedElevation = `${degrees}°${minutes.toString().padStart(2, "0")}'`;
                break;
            }
            default:
                // Direct fire is aimed relative to the target, not to the horizon
                convertedElevation = (App.activeWeapon.type === "directFire" ? firingSolution.getSightAngle(elevationData.rad) : elevationData.deg).toFixed(App.activeWeapon.elevationPrecision);
            }

            // A trajectory that hits the terrain or a building first is shown struck through
            if (firingSolution.obstacle?.[arc]) convertedElevation = `<span class="calcBlocked">${convertedElevation}</span>`;

            return [convertedElevation, formattedTime];
        };

        /**
         * Where the shown trajectories hit an obstacle first: distance and height above the weapon
         * @param {string[]} arcs - "low" / "high", in the order they are shown
         * @returns {string} - HTML line, empty if every shown trajectory is clear
         */
        const formatObstacles = (arcs) => {
            if (!arcs.some((arc) => firingSolution.obstacle?.[arc])) return "";
            const meters = `<span data-i18n="common:m">${i18next.t("common:m")}</span>`;
            const parts = arcs.map((arc) => {
                const obstacle = firingSolution.obstacle?.[arc];
                if (!obstacle) return "---";
                const height = Math.round(obstacle.height);
                return `${obstacle.distance.toFixed(0)}${meters} (${height >= 0 ? "+" : ""}${height}${meters})`;
            });
            return `<br><span class="calcObstacle">⛔ ${parts.join(" / ")}</span>`;
        };

        let elevation, timeOfFlight, shownArcs;

        if (App.activeWeapon.elevationRate) {
            // Weapons laid by holding a key (AGS-17): hold time of the lob, then the angle to aim at in direct fire
            const [holdTime, timeHigh] = formatElevationData(firingSolution.elevation.high, firingSolution.timeOfFlight.high, "high");
            let directAngle = isNaN(firingSolution.elevation.low.rad) ? "---" : `${firingSolution.getSightAngle(firingSolution.elevation.low.rad).toFixed(1)}°`;
            if (firingSolution.obstacle?.low) directAngle = `<span class="calcBlocked">${directAngle}</span>`;
            elevation = `${holdTime} / ${directAngle}`;
            timeOfFlight = timeHigh;
            shownArcs = ["high", "low"];
        } else if (App.userSettings.lowAndHigh && !["Mortar", "UB-32", "M1064M121", "Mk19"].includes(App.activeWeapon.name)) {
            const [elevationLow, timeLow] = formatElevationData(firingSolution.elevation.low, firingSolution.timeOfFlight.low, "low");
            const [elevationHigh, timeHigh] = formatElevationData(firingSolution.elevation.high, firingSolution.timeOfFlight.high, "high");
            elevation = `${elevationLow} / ${elevationHigh}`;
            timeOfFlight = `${timeLow} / ${timeHigh}`;
            shownArcs = ["low", "high"];
        } else {
            const arc = angleType === "high" ? "high" : "low";
            [elevation, timeOfFlight] = formatElevationData(firingSolution.elevation[arc], firingSolution.timeOfFlight[arc], arc);
            shownArcs = [arc];
        }

        let content;
        
        // Checks if last three elevation digits option is enabled and if selected weapon is "Mortar"
        // TODO move this in the previous if statement when other weapons are supported
        // Text of the elevation without the markup of blocked trajectories (last digits, clipboard)
        const elevationText = elevation.toString().replace(/<[^>]*>/g, "");

        if (App.userSettings.lastDigits && ["Mortar"].includes(App.activeWeapon.name)){
            const lastDigits = elevationText.slice(-3);
            const shown = firingSolution.obstacle?.[shownArcs[0]] ? `<span class="calcBlocked">${lastDigits}</span>` : lastDigits;
            content = `<span class=calcNumber></span></br><span>${shown}</span>`;
        } else {
            content = `<span class="calcNumber"></span><br><span>${elevation}</span>`;
        }

        content += formatObstacles(shownArcs);
        if (!firingSolution.hasHeightData) {
            content += `<br><span class="calcNoHeight">⚠ <span data-i18n="common:noHeightData">${i18next.t("common:noHeightData")}</span></span>`;
        }
        content += this.formatRounds(firingSolution, shownArcs);
        if (firingSolution === this.firingSolution1) content += this.formatCorrection();

        if (App.userSettings.showBearing) content += `<br><span class=bearingUiCalc>${BEARING.toFixed(1)}<span data-i18n="common:°">${i18next.t("common:°")}</span></span>`;
        if (App.userSettings.showTimeOfFlight) content += `<br><span class=bearingUiCalc>${timeOfFlight}</span>`;
        if (App.userSettings.showDistance) content += `<br><span class=bearingUiCalc>${DIST.toFixed(0)}<span data-i18n="common:m">${i18next.t("common:m")}</span></span>`;
        if (App.userSettings.showHeight) content += `<br><span class=bearingUiCalc>${heightDiff}<span data-i18n="common:m">${i18next.t("common:m")}</span></span>`;
        const elevationLabel = i18next.t(App.activeWeapon.elevationRate ? "common:holdTime" : "common:elevation");
        return [content, `${elevationLabel}: ${elevationText} - ${i18next.t("common:bearing")}: ${BEARING.toFixed(1)}°`];
    },



    /*
    * Update target spread ellipses according to it's firing solutions
    */
    updateSpread: function(){
        let spreadParameters;
        const weapons = this.map.activeWeaponsMarkers.getLayers();
        const gameToMapScale = this.map.gameToMapScale;
    
        // No spread wanted, return
        if (!App.userSettings.spreadRadius) {
            this.disableSpreadRadii();
            return;
        }
    
        const setSpreadMarker = (marker, firingSolution, layerIndex, reverse = false) => {
            const angleType = weapons[layerIndex].angleType;
            let elevation;
            if (reverse) {
                elevation = angleType === "high" ? firingSolution.elevation.low.rad : firingSolution.elevation.high.rad;
            } else {
                elevation = angleType === "high" ? firingSolution.elevation.high.rad : firingSolution.elevation.low.rad;
            }
            
            if (!isNaN(elevation)) {
                if (reverse) {
                    spreadParameters = angleType === "high" ? firingSolution.spreadParameters.low : firingSolution.spreadParameters.high;
                } else {
                    spreadParameters = angleType === "high" ? firingSolution.spreadParameters.high : firingSolution.spreadParameters.low;
                }
                marker.setRadius([(spreadParameters.semiMajorAxis * gameToMapScale) / 2, (spreadParameters.semiMinorAxis * gameToMapScale) / 2]);
                marker.setTilt(firingSolution.bearing);
                marker.setStyle(this.spreadOptionsOn);
            } else {
                marker.setStyle(this.spreadOptionsOff);
            }
        };
    
        // Spread for Weapon1
        setSpreadMarker(this.spreadMarker1, this.firingSolution1, 0);
    
        if (App.userSettings.lowAndHigh &&
            App.activeWeapon.name != "Mortar" &&
             App.activeWeapon.name != "UB-32" &&
              App.activeWeapon.name != "M1064M121" &&
               App.activeWeapon.name != "Mk19" &&
                !App.activeWeapon.elevationRate &&
                 App.activeWeapon.name != "BTR4-30mm") {  
            setSpreadMarker(this.spreadMarker11, this.firingSolution1, 0, true);
        } else {
            this.spreadMarker11.setStyle(this.spreadOptionsOff);
        }

        // Spread for Weapon2
        if (weapons.length === 2) {
            setSpreadMarker(this.spreadMarker2, this.firingSolution2, 1);
        } else {
            this.spreadMarker2.setStyle(this.spreadOptionsOff);
        }
    },


    disableDamageRadii: function() {
        this.hundredDamageRadius.setStyle(this.spreadOptionsOff);
        this.twentyFiveDamageRadius.setStyle(this.spreadOptionsOff);
        this.hideCoverZone();
    },


    disableSpreadRadii: function() {
        this.spreadMarker1.setStyle(this.spreadOptionsOff);
        this.spreadMarker11.setStyle(this.spreadOptionsOff);
        this.spreadMarker2.setStyle(this.spreadOptionsOff);
    },


    /*
    * Update target damage radius ellipses according to it's firing solutions
    */
    updateDamageRadius: function() {
        
        // If damage radius is disabled, turn off the circles and exit
        if (!App.userSettings.damageRadius) {
            this.disableDamageRadii();
            return;
        }
    
        // Calculate damage radii based on map scale
        const RADIUS100 = App.activeWeapon.hundredDamageRadius * this.map.gameToMapScale;
        const RADIUS25 = App.activeWeapon.twentyFiveDamageRadius * this.map.gameToMapScale;
    
        // Check if first firing solution is valid
        const hasFiringSolution1 = !isNaN(this.firingSolution1.elevation.high.rad) || !isNaN(this.firingSolution1.elevation.low.rad);
    
        // Default to first marker and bearing
        let baseRadiiX = this.spreadMarker1.getRadius().x;
        let baseRadiiY = this.spreadMarker1.getRadius().y;
        let baseBearing = this.firingSolution1.bearing;

        // If two markers exist, do some additional checks
        if (this.map.activeWeaponsMarkers.getLayers().length == 2) {
            const hasFiringSolution2 = !isNaN(this.firingSolution2.elevation.high.rad) || !isNaN(this.firingSolution2.elevation.low.rad);
            
            // If no valid solutions, turn off circles
            if (!hasFiringSolution1 && !hasFiringSolution2) {
                this.disableDamageRadii();
                return;
            }
    
            // Adjust radii and bearing based on which solutions are valid
            if (!hasFiringSolution1) {
                baseRadiiX = this.spreadMarker2.getRadius().x;
                baseRadiiY = this.spreadMarker2.getRadius().y;
                baseBearing = this.firingSolution2.bearing;
            } else if (!hasFiringSolution2) {
                baseRadiiX = this.spreadMarker1.getRadius().x;
                baseRadiiY = this.spreadMarker1.getRadius().y;
                baseBearing = this.firingSolution1.bearing;
            } else {
                // If there are two firing solutions, draw a circle with the biggest radius found in the spreads
                baseRadiiX = Math.max(
                    this.spreadMarker1.getRadius().x, 
                    this.spreadMarker2.getRadius().x, 
                    this.spreadMarker1.getRadius().y,
                    this.spreadMarker2.getRadius().y
                );
                baseRadiiY = baseRadiiX;
            }
        } else if (!hasFiringSolution1) {
            // If only one marker but no valid solution, turn off circles
            this.disableDamageRadii();
            return;
        } else if (App.userSettings.lowAndHigh &&
            App.activeWeapon.name != "Mortar" &&
             App.activeWeapon.name != "UB-32" &&
              App.activeWeapon.name != "M1064M121" &&
               App.activeWeapon.name != "Mk19" &&
                !App.activeWeapon.elevationRate) {
            baseRadiiX = Math.max(this.spreadMarker1.getRadius().x, this.spreadMarker11.getRadius().x);  
            baseRadiiY = Math.max(this.spreadMarker1.getRadius().y, this.spreadMarker11.getRadius().y);
        }
    
        // Determine radii based on spread radius setting
        const hundredRadii = App.userSettings.spreadRadius ? [baseRadiiX + RADIUS100, baseRadiiY + RADIUS100] : [RADIUS100, RADIUS100];
        const twentyFiveRadii = App.userSettings.spreadRadius ? [baseRadiiX + RADIUS25, baseRadiiY + RADIUS25] : [RADIUS25, RADIUS25];
    
        // Set radii, styles, and tilt
        this.hundredDamageRadius.setRadius(hundredRadii);
        this.twentyFiveDamageRadius.setRadius(twentyFiveRadii);
        this.hundredDamageRadius.setStyle(this.hundredDamageCircleOn);
        this.twentyFiveDamageRadius.setStyle(this.twentyFiveDamageCircleOn);
        this.hundredDamageRadius.setTilt(baseBearing);
        this.twentyFiveDamageRadius.setTilt(baseBearing);
        this.updateCoverZone();
    },


    /**
     * Heights around a point, for squadDamage.js: `(east, north)` meters from `center` -> meters.
     * Flat ground without the precise game heightmap: the 8-bit one (steps up to 2 m) would make cover up.
     * @param {LatLng} center
     * @returns {function(number, number): number}
     */
    heightAround: function(center) {
        const heightmap = this.map.heightmap;
        if (!heightmap?.precise) return () => 0;
        return (east, north) => heightmap.getHeight(this.map.fromMeters(center, east, north));
    },


    /**
     * Whether the active weapon's explosion is shown on targets (damage zone, rounds to kill): it has one
     * (direct-fire weapons that only hit with the projectile, AP rounds and machine guns, have none)
     * @returns {boolean}
     */
    showsExplosion: function() {
        const explosion = App.activeWeapon.explosion;
        return Boolean(App.userSettings.damageRadius && explosion && explosion.outer > 0);
    },


    /**
     * Draw where a round on the target kills, wounds, or is stopped by cover (squadDamage.damageField),
     * inside the damage circles. Needs the precise heightmap; recomputed only when the target, the
     * shell or the map changed, and hidden while the target is dragged. A zone seen before is drawn from
     * the cache at once; a new one is queued and drawn when its turn comes (processCoverQueue).
     */
    updateCoverZone: function() {
        if (!this.showsExplosion() || this.isDragging || !this.map.heightmap?.precise) {
            this.removeCoverZone();
            return;
        }

        const explosion = App.activeWeapon.explosion;
        const center = this.getLatLng();
        const signature = [this.map.activeMap.name, center.lat, center.lng, JSON.stringify(explosion)].join("|");
        this.coverHidden = false;
        if (this.coverOverlay && signature === this.coverSignature) {
            this.coverOverlay.setOpacity(1);
            return;
        }
        if (this.coverPending === signature) return;
        this.removeCoverZone();
        this.coverSignature = signature;

        const cell = explosion.outer > COARSE_RADIUS ? COVER_CELL_COARSE : COVER_CELL;
        const cached = coverZoneImages.get(signature);
        if (cached) {
            remember(coverZoneImages, signature, cached);
            this.showCoverZone(cached, center);
            return;
        }

        this.coverPending = signature;
        coverQueue.push({ target: this, signature, center, explosion, cell, heightAt: this.heightAround(center), field: null });
        scheduleCoverQueue();
    },


    /**
     * The queue computed this target's damage zone: draw it and keep it in the cache
     * @param {object} job - the queue entry: `signature`, `center`, `cell` and the finished `field`
     */
    finishCoverZone: function(job) {
        const { field } = job;
        const pixels = new Uint8ClampedArray(field.size * field.size * 4);
        for (let i = 0; i < field.damage.length; i++) {
            let color = null;
            if (field.damage[i] >= KILL_DAMAGE) color = COVER_COLORS.kill;
            else if (field.damage[i] >= WOUND_DAMAGE) color = COVER_COLORS.wound;
            else if (field.exposed[i] >= WOUND_DAMAGE) color = COVER_COLORS.covered;
            if (color) pixels.set(color, i * 4);
        }

        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = field.size;
        canvas.getContext("2d").putImageData(new ImageData(pixels, field.size, field.size), 0, 0);
        const image = { url: canvas.toDataURL(), size: field.size, cell: job.cell };
        remember(coverZoneImages, job.signature, image);
        this.coverPending = null;
        this.showCoverZone(image, job.center);
    },


    /**
     * Put a damage zone image on the map, centred on the target
     * @param {{url: string, size: number, cell: number}} image
     * @param {LatLng} center
     */
    showCoverZone: function(image, center) {
        const half = (image.size * image.cell) / 2;
        const bounds = new LatLngBounds(this.map.fromMeters(center, -half, -half), this.map.fromMeters(center, half, half));
        this.coverOverlay = new ImageOverlay(image.url, bounds, { className: "coverZoneOverlay", interactive: false, zIndex: COVER_ZONE_Z_INDEX, opacity: this.coverHidden ? 0 : 1 })
            .addTo(this.map.markersGroup);
    },


    /**
     * Hide the damage zone but keep it for updateCoverZone: hovering a target or dragging a weapon
     * hides the other targets' zones, and recomputing them all on hover-out froze the page
     */
    hideCoverZone: function() {
        this.coverHidden = true;
        if (this.coverOverlay) this.coverOverlay.setOpacity(0);
    },


    removeCoverZone: function() {
        if (this.coverOverlay) this.map.markersGroup.removeLayer(this.coverOverlay);
        this.coverOverlay = null;
        this.coverSignature = null;
        this.coverPending = null;
    },


    /**
     * Popup line with the rounds to fire so that one kills (☠), or at least wounds (🩸), a soldier
     * standing on the target with ROUNDS_CONFIDENCE, given the spread and the cover around it. Not computed
     * while the target is dragged (400 cover traces per move): the line comes back when it is dropped.
     * @param {SquadFiringSolution} firingSolution
     * @param {string[]} arcs - "low" / "high" in the order they are shown; the first one that reaches counts
     * @returns {string} - HTML line, empty when the weapon's explosion is not shown, or when a direct-fire
     *   shot is stopped by an obstacle before the target (it explodes there, not around the target)
     */
    formatRounds: function(firingSolution, arcs) {
        if (!this.showsExplosion() || this.isDragging) return "";
        const arc = arcs.find((angle) => !isNaN(firingSolution.elevation[angle]?.rad));
        if (!arc) return "";
        if (App.activeWeapon.type === "directFire" && firingSolution.obstacle?.[arc]) return "";

        // Half the axes of the drawn spread ellipse (updateSpread), exact for rockets and capped shells
        const { lateral, along } = firingSolution.getHitSpread(arc);
        const explosion = App.activeWeapon.explosion;
        const center = this.getLatLng();
        const key = [this.map.activeMap.name, center.lat, center.lng, JSON.stringify(explosion), lateral, along, firingSolution.bearing, this.map.heightmap?.precise].join("|");
        let probabilities = hitProbabilities.get(key);
        if (!probabilities) probabilities = hitProbability(this.heightAround(center), explosion, lateral, along, firingSolution.bearing);
        remember(hitProbabilities, key, probabilities);
        const { kill, wound } = probabilities;
        const rounds = (probability) => {
            const count = roundsNeeded(probability, ROUNDS_CONFIDENCE);
            return Number.isFinite(count) ? count : "—";
        };
        return `<br><span class="calcRounds">☠ ${rounds(kill)} · 🩸 ${rounds(wound)}</span>`;
    },


    /**
     * Popup line of the fire correction: bursts marked and how far the aim moved off the target
     * @returns {string} - HTML line, empty without marked bursts
     */
    formatCorrection: function() {
        if (!this.impacts.length) return "";
        const { range, bearing } = this.getCorrection();
        const signed = (value, digits) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
        const meters = `<span data-i18n="common:m">${i18next.t("common:m")}</span>`;
        return `<br><span class="calcCorrection">↻${this.impacts.length} ${signed(-range, 0)}${meters} ${signed(-bearing, 1)}°</span>`;
    },


    /**
     * Distance in meters and bearing in degrees (clockwise from north) from one point to another
     * @param {LatLng} origin
     * @param {LatLng} latlng
     * @returns {{distance: number, bearing: number}}
     */
    polarFrom: function(origin, latlng) {
        const { east, north } = this.map.toMeters(origin, latlng);
        let bearing = Math.atan2(east, north) * 180 / Math.PI;
        if (bearing < 0) bearing += 360;
        return { distance: Math.hypot(east, north), bearing };
    },


    /**
     * Point at a distance and bearing from another
     * @param {LatLng} origin
     * @param {number} distance - meters
     * @param {number} bearing - degrees clockwise from north
     * @returns {{lat: number, lng: number}}
     */
    latLngAt: function(origin, distance, bearing) {
        const rad = bearing * Math.PI / 180;
        return this.map.fromMeters(origin, distance * Math.sin(rad), distance * Math.cos(rad));
    },


    /**
     * Mean error of the marked bursts in range and bearing from the first weapon: where its rounds
     * land relative to where it aims. Averaging the bursts cancels most of the spread.
     * @returns {{range: number, bearing: number}} - meters (+ = long), degrees (+ = clockwise)
     */
    getCorrection: function() {
        const count = this.impacts.length;
        return {
            range: this.impacts.reduce((sum, impact) => sum + impact.range, 0) / count,
            bearing: this.impacts.reduce((sum, impact) => sum + impact.bearing, 0) / count,
        };
    },


    /**
     * Point the first weapon aims at: the target moved against the mean error of the marked bursts,
     * in range and bearing from the weapon, so the correction still holds when the target moves
     * @returns {LatLng|{lat: number, lng: number}}
     */
    getAimLatLng: function() {
        const weapon = this.map.activeWeaponsMarkers.getLayers()[0];
        if (!this.impacts.length || !weapon) return this.getLatLng();
        const { range, bearing } = this.getCorrection();
        const target = this.polarFrom(weapon.getLatLng(), this.getLatLng());
        return this.latLngAt(weapon.getLatLng(), target.distance - range, target.bearing - bearing);
    },


    /**
     * Mark where a round of the first weapon burst (Ctrl + double-click on the map, squadMinimap):
     * its error from the point aimed at is added to the correction and the solution is recomputed.
     * Right-click on the burst removes it.
     * @param {LatLng} latlng - where the round burst
     */
    addImpact: function(latlng) {
        const weapon = this.map.activeWeaponsMarkers.getLayers()[0];
        if (!weapon) return;

        const aim = this.polarFrom(weapon.getLatLng(), this.getAimLatLng());
        const burst = this.polarFrom(weapon.getLatLng(), latlng);
        const impact = {
            latlng,
            setup: this.getFiringSetup(),
            range: burst.distance - aim.distance,
            bearing: ((burst.bearing - aim.bearing + 540) % 360) - 180,
        };
        impact.marker = new CircleMarker(latlng, {
            radius: 5, color: "#f39c12", weight: 2, fillOpacity: 0.6, bubblingPointerEvents: false,
        }).addTo(this.map.markersGroup);
        impact.line = new Polyline([latlng, this.getLatLng()], {
            color: "#f39c12", weight: 1.5, opacity: 0.8, dashArray: "4 4", interactive: false, showMeasurements: false,
        }).addTo(this.map.markersGroup);
        impact.marker.on("contextmenu", (event) => {
            event.originalEvent.preventDefault();
            this.removeImpact(impact);
        });

        this.impacts.push(impact);
        this.updateCalc(true);
        this.updateIcon();
    },


    /**
     * Remove a marked burst and recompute the correction without it
     * @param {object} impact - an entry of `impacts`
     */
    removeImpact: function(impact) {
        this.removeImpactLayers(impact);
        this.impacts = this.impacts.filter((other) => other !== impact);
        this.updateCalc(true);
        this.updateIcon();
    },


    /**
     * What a burst was fired with: the first weapon marker, the weapon and its shell. Bursts only
     * correct the fire of the setup they were marked with (dropStaleImpacts).
     * @returns {string}
     */
    getFiringSetup: function() {
        const weaponMarker = this.map.activeWeaponsMarkers.getLayers()[0];
        return [weaponMarker?.uid, App.activeWeapon.name, App.activeWeapon.velocity, App.activeWeapon.moa].join("|");
    },


    /**
     * Remove the bursts marked with another weapon, shell or first weapon marker: their error says
     * nothing about the current fire
     */
    dropStaleImpacts: function() {
        const setup = this.getFiringSetup();
        const stale = this.impacts.filter((impact) => impact.setup !== setup);
        if (!stale.length) return;
        stale.forEach((impact) => this.removeImpactLayers(impact));
        this.impacts = this.impacts.filter((impact) => impact.setup === setup);
    },


    removeImpactLayers: function(impact) {
        this.map.markersGroup.removeLayer(impact.marker);
        this.map.markersGroup.removeLayer(impact.line);
    },


    /*
    * Update target calculationPopups according to it's firing solutions
    */
    updateCalc: function(copy = false){
        let clipboard;
        this.dropStaleImpacts();
        this.firingSolution1 = new SquadFiringSolution(this.map.activeWeaponsMarkers.getLayers()[0].getLatLng(), this.getAimLatLng(), this.map, this.map.activeWeaponsMarkers.getLayers()[0].heightPadding, this.getLatLng());
        const [html1, clipboard1] = this.getContent(this.firingSolution1, this.map.activeWeaponsMarkers.getLayers()[0].angleType);
        this.calcMarker1.setContent(html1);
        clipboard = clipboard1;

        if (this.map.activeWeaponsMarkers.getLayers().length === 2) {
            this.firingSolution2 = new SquadFiringSolution(this.map.activeWeaponsMarkers.getLayers()[1].getLatLng(), this.getLatLng(), this.map, this.map.activeWeaponsMarkers.getLayers()[1].heightPadding);
            const [html2, clipboard2] = this.getContent(this.firingSolution2, this.map.activeWeaponsMarkers.getLayers()[1].angleType);
            this.calcMarker1.setContent(`1. ${html1}`);
            this.calcMarker2.setContent(`2. ${html2}`).openOn(this.map);
            clipboard = `1. ${clipboard} / 2. ${clipboard2}`;
        } else {
            this.calcMarker2.close();
        }

        // Refresh targetGrids
        this.grid.clear();
        this.grid = new TargetGrid(this.map, ...this.getFirstAvailableWeapon());

        this.removeLineToTarget();
        this.drawLineToTarget();

        this.updateSpread();
        this.updateDamageRadius();
        if (copy && App.userSettings.copyTarget) navigator.clipboard.writeText(clipboard);
        notifyBridgeChange();
    },


    /**
     * Set/Update the target icon according to it's firing solutions and user settings
     * @param {Boolean} animated - If the icon should be animated when set
     */
    updateIcon: function (animated = false) {
        const weapons = this.map.activeWeaponsMarkers.getLayers();
        const angleType = weapons[0].angleType;
        const elevationKey = angleType === "high" ? "high" : "low";
    
        // Weapons laid by holding a key (AGS-17) also reach targets in direct fire (low trajectory)
        const reaches = (firingSolution) => !isNaN(firingSolution.elevation[elevationKey]?.rad) ||
            (Boolean(App.activeWeapon.elevationRate) && !isNaN(firingSolution.elevation.low.rad));

        const isSingleWeapon = weapons.length === 1;
        const isDisabled = isSingleWeapon ? !reaches(this.firingSolution1) : !reaches(this.firingSolution1) && !reaches(this.firingSolution2);

        let iconURL;
        let iconClassName;


        if (isDisabled) {
            if (App.userSettings.targetAnimation) iconURL = "../img/markers/targets/marker_target_disabled.webp";
            else  iconURL = "../img/markers/targets/marker_target_disabled_mini.webp";
        }
        else {
            if (App.userSettings.targetAnimation) {
                if (this.fromSession) iconURL = "../img/markers/targets/marker_target_session_enabled.webp";
                else iconURL = "../img/markers/targets/marker_target_enabled.webp";
                if (animated) iconClassName = "animatedTargetMarker";

            } else {
                if (this.fromSession) iconURL = "../img/markers/targets/marker_target_session_mini.webp";
                else iconURL = "../img/markers/targets/marker_target_mini.webp";
            }
        }

        let iconOptions = {};

        if (App.userSettings.targetAnimation) {
            // Create the scaling full target marker
            const ICON_SETTING_SIZE = (App.userSettings.markerSize - 1) * 5;
            const ICON_SIZE_X = 18 + ICON_SETTING_SIZE;
            const ICON_SIZE_Y = 24 + ICON_SETTING_SIZE;
            iconOptions = {
                iconSize:     [ICON_SIZE_X, ICON_SIZE_Y],
                shadowSize:   [ICON_SIZE_Y, ICON_SIZE_Y],
                iconAnchor:   [ICON_SIZE_X/2, ICON_SIZE_Y],
                shadowAnchor: [ICON_SIZE_X/4, ICON_SIZE_Y]
            };
        } else {
            // Non scaling minimal target markers
            iconOptions = {
                shadowSize: [0, 0], // hack to avoid 404
                iconSize:   [30, 30],
                iconAnchor: [15, 15]
            };
        }

        // hack leaflet to avoid unwanted click event
        // https://github.com/Leaflet/Leaflet/issues/5067
        setTimeout((function (this2) {
            return function () {
                //this2.setIcon(icon);
                this2.setIcon(
                    new Icon({
                        iconUrl: iconURL,
                        shadowUrl: "/img/markers/weapons/marker_shadow.webp",
                        ...iconOptions,
                        className: iconClassName
                    })
                );
            };
        })(this));

    },

    _handleClick: function() {
        const DIALOG = document.getElementById("calcInformation");
        let simulation2;
        let weaponPos2;

        $("#sim1").addClass("active");
        $("#sim2").removeClass("active");

        // Weapons aimed by holding the elevation key (AGS-17) show a hold time where others show an angle
        const elevationLabelKey = App.activeWeapon.elevationRate ? "common:holdTime" : "common:elevation";
        $("#calcInformation td[data-i18n='common:elevation'], #calcInformation td[data-i18n='common:holdTime']")
            .attr("data-i18n", elevationLabelKey).text(i18next.t(elevationLabelKey));
        $("#canvasControls > .active").first().removeClass("active");
        $("#canvasControls > button").first().addClass("active");

        const weaponPos1 = this.map.activeWeaponsMarkers.getLayers()[0].getLatLng();
        const { path: heightPath1, weaponIndex: weaponIndex1, targetIndex: targetIndex1 } = this._map.heightmap.getHeightPath(weaponPos1, this.getLatLng());
        const simulation1 = new SquadSimulation("#sim1", this.firingSolution1, heightPath1, this.map.activeWeaponsMarkers.getLayers()[0].angleType, App.activeWeapon.unit, 0, weaponIndex1, targetIndex1);
        $("#canvasControls").css("display", "none");

        if (this.map.activeWeaponsMarkers.getLayers().length === 2){
            $("#canvasControls").css("display", "block");
            weaponPos2 = this.map.activeWeaponsMarkers.getLayers()[1].getLatLng();
            const { path: heightPath2, weaponIndex: weaponIndex2, targetIndex: targetIndex2 } = this._map.heightmap.getHeightPath(weaponPos2, this.getLatLng());
            simulation2 = new SquadSimulation("#sim2", this.firingSolution2, heightPath2, this.map.activeWeaponsMarkers.getLayers()[1].angleType, App.activeWeapon.unit, 0, weaponIndex2, targetIndex2);
        }

        // If the user close the modal, stop the animation
        // ...or it does crazy stuff if he reopen it before the animation runs out
        DIALOG.addEventListener("close", function(){
            cancelAnimationFrame(simulation1.animationFrame);
            if (simulation2){ cancelAnimationFrame(simulation2.animationFrame);}
        });

        DIALOG.showModal();
    },

    // Keep the marker on map & update calc while dragging
    _handleDrag: function (event) {

        // When dragging marker out of bounds, block it at the edge
        event = this.keepOnMap(event);

        // Update Positions
        this.setLatLng(event.latlng);
        this.calcMarker1.setLatLng(event.latlng);
        this.spreadMarker1.setLatLng(event.latlng);
        this.spreadMarker11.setLatLng(event.latlng);
        this.calcMarker2.setLatLng(event.latlng);
        this.spreadMarker2.setLatLng(event.latlng);
        this.miniCircle.setLatLng(event.latlng);
        this.hundredDamageRadius.setLatLng(event.latlng);
        this.twentyFiveDamageRadius.setLatLng(event.latlng);
        this.impacts.forEach((impact) => impact.line.setLatLngs([impact.latlng, event.latlng]));
        this.grid.clear();

        // Update Position PopUp Content
        if (App.userSettings.targetDrag) {
            this.posPopUp.setLatLng(event.latlng).setContent(this.map.getKP(-event.latlng.lat, event.latlng.lng, 4));
        }

        // On mobile save performance
        if (!App.hasMouse) return;

        // Update bearing/elevation/spread marker: once per animation frame, however many drag events came
        if (this.calcFrame === null) this.calcFrame = requestAnimationFrame(() => {
            this.calcFrame = null;
            if (this.isDragging) this.updateCalc();
        });
    },

    
    _handleDragStart: function () {
        this.isDragging = true;
        this.map.mouseLocationPopup.close();
        this.map.off("pointermove", this.map._handleMouseMove);

        if (!App.hasMouse) {
            this.calcMarker1.setContent("  ");
            this.calcMarker2.setContent("  ");
            this.disableSpreadRadii();
            this.disableDamageRadii();
            this.removeLineToTarget();
        }

        if (App.userSettings.targetDrag) {
            // Set a different offset when several weapons are on the map
            let offset = this.map.activeWeaponsMarkers.getLayers()[1] ? [0, -20] : [0, -10];
            this.posPopUp.options.offset = offset;
            this.posPopUp.openOn(this.map); 
        }
        
        this.miniCircle.setStyle({opacity: 1});
    },

    // Hide stuff, do a final update and send data to API
    _handleDragEnd: function (event) {

        // Send the MOVING_WEAPON event to the server
        if (App.session.ws && App.session.ws.readyState === WebSocket.OPEN) {
            App.session.ws.send(
                JSON.stringify({
                    type: "MOVING_TARGET",
                    lat: this.getLatLng().lat,
                    lng: this.getLatLng().lng,
                    uid: this.uid,
                })
            );
        }

        if (App.userSettings.keypadUnderCursor) this.map.on("pointermove", this.map._handleMouseMove);

        // The calculation of the last drag event is made below, with the drop position
        cancelAnimationFrame(this.calcFrame);
        this.calcFrame = null;

        // Hide PositionPopUp & MiniCircle
        this.isDragging = false;
        this.posPopUp.close();
        this.miniCircle.setStyle({opacity: 0});
        
        // update one last time when drag end
        this.updateCalc(true);
        this.updateIcon();

        // Report target to squadcalc API (only weapons it collects data for)
        if (App.activeWeapon.heatmap) sendTargetData({
            lat: event.target.getLatLng().lat,
            lng: event.target.getLatLng().lng,
            weapon: App.activeWeapon.name,
            map: App.minimap.activeMap.name,
        });
    },

    // Delete targetMarker on right clic
    _handleContextMenu: function(e){

        // Avoid other target keeping fading
        clearTimeout(this.mouseOverTimeout);

        // If it's too late, Fade every other targets back in
        this.map.activeTargetsMarkers.eachLayer((target) => {
            target.on("pointerover", target._handleMouseOver, target);
            target.on("pointerout", target._handleMouseOut, target);
            target.setOpacity(1);
            target.calcMarker1.openOn(this.map);
            if (this.map.activeWeaponsMarkers.getLayers()[1]) target.calcMarker2.openOn(this.map);
            target.updateSpread();
            target.updateDamageRadius();
            target.drawLineToTarget();
            target.grid.show();
        });

        // Prevent right click to happen on elements behind
        e.originalEvent.preventDefault();
        e.originalEvent.stopPropagation();

        // We can now safely start deleting
        this.delete();
    },

    // On Hovering for more than 500ms hide other targets
    _handleMouseOver: function() {
        this.mouseOverTimeout = setTimeout(() => {
            if (!this.isDragging) this.map.fadeOtherTargets(this); // Hide other targets
        }, 500);
    },

    _handleMouseOut: function() {

        // Cancel the timeout if the user moves the mouse out before 1 second
        clearTimeout(this.mouseOverTimeout);

        this.calcMarker1.getElement().style.zIndex  = "";
        this.calcMarker2.getElement().style.zIndex  = "";

        if (!this.isDragging) {
            this.map.activeTargetsMarkers.eachLayer((target) => {
                target.on("pointerover", target._handleMouseOver, target);
                target.on("pointerout", target._handleMouseOut, target);
                target.setOpacity(1);
                target.calcMarker1.openOn(this.map);
                if (this.map.activeWeaponsMarkers.getLayers()[1]) target.calcMarker2.openOn(this.map);
                target.updateSpread();
                target.updateDamageRadius();
                target.drawLineToTarget();
                target.grid.show();
            });
        }
    },

    getFirstAvailableWeapon: function () {
        if (
            this.map.activeWeaponsMarkers.getLayers().length === 2 &&
            isNaN(this.firingSolution1.elevation.high.rad) && isNaN(this.firingSolution1.elevation.low.rad) &&
            (!isNaN(this.firingSolution2.elevation.high.rad) || !isNaN(this.firingSolution2.elevation.low.rad))
        ) {
            return [this.firingSolution2, this.map.activeWeaponsMarkers.getLayers()[1]];
        }

        return [this.firingSolution1, this.map.activeWeaponsMarkers.getLayers()[0]];
    },

    drawLineToTarget: function () {
        
        if (!App.userSettings.lineToTarget) return;

        // Remove existing lines
        this.removeLineToTarget();
        
        let lines = [];

        if (!isNaN(this.firingSolution1.elevation.high.rad) || !isNaN(this.firingSolution1.elevation.low.rad)) {
            lines.push([this.firingSolution1.weaponLatLng, this.getLatLng()]);
        }
        if (this.map.activeWeaponsMarkers.getLayers().length === 2 && (!isNaN(this.firingSolution2.elevation.high.rad) || !isNaN(this.firingSolution2.elevation.low.rad))) {
            lines.push([this.firingSolution2.weaponLatLng, this.getLatLng()]);
        }

        for (const line of lines) {
            this.linesBetweenTargets.push(new Polyline(line, {
                color: "white",
                opacity: 0.65,
                weight: 2,
                showMeasurements: false,
            }).addTo(this.map.markersGroup));
        }
    },

    removeLineToTarget: function () {
        if (this.linesBetweenTargets.length > 0) {
            for (const linesBetweenTarget of this.linesBetweenTargets) {
                linesBetweenTarget.removeFrom(this.map.markersGroup).remove();
            }
        }
    },

    _handlePointerDown: function (e) {
        if (e.originalEvent.altKey) return this._startCarpetDrag(e);
        if (e.originalEvent.shiftKey) return this._startRectangleDrag(e);
    },

    _startCarpetDrag: function (e) {
        e.originalEvent.preventDefault();
        this.dragging.disable();
        this.map.dragging.disable();

        // Release implicit pointer capture so pointermove reaches document
        const el = this.getElement();
        if (el && e.originalEvent.pointerId != null) {
            try { el.releasePointerCapture(e.originalEvent.pointerId); } catch { /* ignore */ }
        }

        const start = this.getLatLng();

        const previewLine = new Polyline([start, start], {
            color: App.mainColor,
            opacity: 0.65,
            weight: 2,
            dashArray: "6 6",
            showMeasurements: false,
        }).addTo(this.map.markersGroup);

        const toLatLng = (domEvent) => {
            const rect = this.map.getContainer().getBoundingClientRect();
            return this.map.containerPointToLatLng([
                domEvent.clientX - rect.left,
                domEvent.clientY - rect.top,
            ]);
        };

        let previewDots = [];

        const onPointerMove = (domEvent) => {
            const end = toLatLng(domEvent);
            const positions = this._getCarpetPositions(start, end);
            const lineEnd = positions.length >= CARPET_MAX_TARGETS ? positions[positions.length - 1] : end;
            previewLine.setLatLngs([start, lineEnd]);

            previewDots.forEach(d => d.removeFrom(this.map.markersGroup).remove());
            previewDots = positions.map(latlng =>
                new CircleMarker(latlng, {
                    radius: 6,
                    color: App.mainColor,
                    fillColor: App.mainColor,
                    fillOpacity: 0.5,
                    interactive: false,
                }).addTo(this.map.markersGroup)
            );
        };

        const onPointerUp = (domEvent) => {
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
            previewLine.removeFrom(this.map.markersGroup).remove();
            previewDots.forEach(d => d.removeFrom(this.map.markersGroup).remove());
            previewDots = [];
            this.dragging.enable();
            this.map.dragging.enable();

            const end = toLatLng(domEvent);
            this._getCarpetPositions(start, end)
                .forEach(latlng => this.map.createTarget(latlng, null, false, true));
        };

        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);
    },

    _getCarpetPositions: function (start, end) {
        const dlat = end.lat - start.lat;
        const dlng = end.lng - start.lng;
        const totalDist = Math.hypot(dlat, dlng);
        if (totalDist === 0) return [];
        const { east, north } = this.map.toMeters(start, end);
        let dragBearing = Math.atan2(east, north) * 180 / Math.PI;
        if (dragBearing < 0) dragBearing += 360;
        const step = this._getStepAtBearing(dragBearing);
        if (step <= 0 || totalDist < step) return [];
        const count = Math.min(Math.floor(totalDist / step), CARPET_MAX_TARGETS);
        const positions = [];
        for (let i = 1; i <= count; i++) {
            const t = (i * step) / totalDist;
            positions.push({ lat: start.lat + dlat * t, lng: start.lng + dlng * t });
        }
        return positions;
    },

    // Spacing between targets, based on the spread ellipse radius in a given
    // compass direction (e.g. the direction the player is dragging)
    _getStepAtBearing: function (bearingDeg) {
        const [fs, weaponMarker] = this.getFirstAvailableWeapon();
        const radius = fs.getSpreadRadiusAtBearing(bearingDeg, weaponMarker.angleType);
        return radius * this.map.gameToMapScale;
    },

    _startRectangleDrag: function (e) {
        e.originalEvent.preventDefault();
        this.dragging.disable();
        this.map.dragging.disable();

        // Release implicit pointer capture so pointermove reaches document
        const el = this.getElement();
        if (el && e.originalEvent.pointerId != null) {
            try { el.releasePointerCapture(e.originalEvent.pointerId); } catch { /* ignore */ }
        }

        const start = this.getLatLng();
        // lat axis runs north/south (bearing 0), lng axis runs east/west (bearing 90)
        this._gridStepLat = this._getStepAtBearing(0);
        this._gridStepLng = this._getStepAtBearing(90);

        const previewRect = new Polygon([start, start, start, start], {
            color: App.mainColor,
            opacity: 0.65,
            weight: 2,
            dashArray: "6 6",
            fill: false,
            showMeasurements: false,
        }).addTo(this.map.markersGroup);

        const toLatLng = (domEvent) => {
            const rect = this.map.getContainer().getBoundingClientRect();
            return this.map.containerPointToLatLng([
                domEvent.clientX - rect.left,
                domEvent.clientY - rect.top,
            ]);
        };

        let previewDots = [];

        const onPointerMove = (domEvent) => {
            const end = toLatLng(domEvent);
            const rectEnd = this._clampGridEnd(start, end);
            previewRect.setLatLngs([
                start,
                { lat: start.lat, lng: rectEnd.lng },
                rectEnd,
                { lat: rectEnd.lat, lng: start.lng },
            ]);

            previewDots.forEach(d => d.removeFrom(this.map.markersGroup).remove());
            previewDots = this._getGridPositions(start, end).map(latlng =>
                new CircleMarker(latlng, {
                    radius: 6,
                    color: App.mainColor,
                    fillColor: App.mainColor,
                    fillOpacity: 0.5,
                    interactive: false,
                }).addTo(this.map.markersGroup)
            );
        };

        const onPointerUp = (domEvent) => {
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);
            previewRect.removeFrom(this.map.markersGroup).remove();
            previewDots.forEach(d => d.removeFrom(this.map.markersGroup).remove());
            previewDots = [];
            this.dragging.enable();
            this.map.dragging.enable();

            const end = toLatLng(domEvent);
            this._getGridPositions(start, end)
                .forEach(latlng => this.map.createTarget(latlng, null, false, true));
        };

        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);
    },

    // Clamps the drag endpoint so the resulting rectangle never exceeds
    // GRID_MAX_SIDE targets per axis
    _clampGridEnd: function (start, end) {
        const dlat = end.lat - start.lat;
        const dlng = end.lng - start.lng;
        const maxOffsetLat = (GRID_MAX_SIDE - 1) * this._gridStepLat;
        const maxOffsetLng = (GRID_MAX_SIDE - 1) * this._gridStepLng;
        return {
            lat: start.lat + Math.sign(dlat) * Math.min(Math.abs(dlat), maxOffsetLat),
            lng: start.lng + Math.sign(dlng) * Math.min(Math.abs(dlng), maxOffsetLng),
        };
    },

    // Fills the rectangle whose diagonal goes from start to end with a grid of
    // targets spaced by _gridStepLat/_gridStepLng on each axis, skipping `start`
    // itself (already a target), capped to a GRID_MAX_SIDE x GRID_MAX_SIDE square
    _getGridPositions: function (start, end) {
        const dlat = end.lat - start.lat;
        const dlng = end.lng - start.lng;
        const countLat = Math.min(Math.floor(Math.abs(dlat) / this._gridStepLat), GRID_MAX_SIDE - 1);
        const countLng = Math.min(Math.floor(Math.abs(dlng) / this._gridStepLng), GRID_MAX_SIDE - 1);
        const stepLat = Math.sign(dlat) * this._gridStepLat;
        const stepLng = Math.sign(dlng) * this._gridStepLng;

        const positions = [];
        for (let i = 0; i <= countLat; i++) {
            for (let j = 0; j <= countLng; j++) {
                if (i === 0 && j === 0) continue;
                positions.push({ lat: start.lat + i * stepLat, lng: start.lng + j * stepLng });
            }
        }
        return positions;
    },
});
