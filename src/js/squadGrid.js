/**
 *  OrigineFile: L.SimpleGraticule.js
 *  Desc: A graticule for Leaflet maps in the L.CRS.Simple coordinate system.
 *  Auth: Andrew Blakey (ablakey@gmail.com)
 * 
 *  Adapted to Squad by Robert "Endebert" Ende (https://github.com/Endebert/squadmc)
 *  slighty edited by Maxime "sharkman" Boussard for squadcalc
 */

import {
    LayerGroup, Util, Polyline, Marker, DivIcon, LatLngBounds
} from "leaflet";
import { KEYPAD } from "./keypad.js";


/**
 * This Layergroup displays the grid in the same way it is displayed in-game.
 * SquadGrid was originally based on SimpleGraticule, but underwent massive changes.
 * See https://github.com/ablakey/Leaflet.SimpleGraticule for more information.
 *
 * @type {LayerGroup} - squadGrid layer object
 */
export default LayerGroup.extend({
    // grid line arrays for each (sub-)keypad
    kpLines: [],
    s1Lines: [],
    s2Lines: [],

    // Polyline styles & options
    lineStyleKP: {
        stroke: true,
        color: "#000",
        opacity: 1,
        weight: 1,
        interactive: false,
        clickable: false,
        zIndex: 202,
    },

    lineStyleSUB1: {
        stroke: true,
        color: "#000",
        opacity: 0.5,
        weight: 2,
        interactive: false,
        clickable: false,
        zIndex: 201,
    },

    lineStyleSUB2: {
        stroke: true,
        color: "#fff",
        opacity: 0,
        weight: 0.8,
        interactive: false,
        clickable: false,
        zIndex: 200,
    },

    initialize(map, options) {
        LayerGroup.prototype.initialize.call(this);
        Util.setOptions(this, options);
        this.map = map;
        this.opacity = options?.opacity ?? 0.8;
    },

    clearLines() {
        this.eachLayer(this.removeLayer, this);
    },

    /**
   * Set bounds for grid, to limit it on the map
   * @param {LatLngBounds} bounds
   */
    setBounds(bounds) {
        this.bounds = new LatLngBounds(bounds[0], bounds[1]);
        if (this.map) {
            this.redraw();
            this.updateLineOpacity();
        }
    },

    /**
     * Put the grid where the game puts it: over the game's minimap of the loaded layer, whose north-west corner is
     * A1 and which is not always the map image (a layer with a smaller minimap such as a Skirmish, a fitted image
     * such as Skorpo's, or just a metre of rounding). Lines are drawn only over it (and the image), the letters
     * along its north edge and the numbers along its west edge; getKP and getPos count from the same corner.
     * @param {number[]} offset - [east, south] metres from the image's north-west corner to the game's corner
     * @param {number[]} size - [width, height] of the game's minimap in metres
     */
    setArea(offset, size) {
        this.originOffset = offset;
        this.areaSize = size;
        if (this.map && this.bounds) {
            this.redraw();
            this.updateLineOpacity();
        }
    },

    onAdd(map) {
        this.map = map;
        map.on("zoomend", this.updateLineOpacity, this);
        this.redraw();
        this.updateLineOpacity();
    },

    onRemove(map) {
        // remove listener for view change
        map.off("zoomend", this.updateLineOpacity, this);
        this.clearLines();
    },


    setOpacity(opacity) {
        this.opacity = opacity;
        this.updateLineOpacity();
    },


    /**
   * Sets opacity of subgrid lines based on zoom level.
   */
    updateLineOpacity() {

        if (!this.map) return;

        const currentZoom = Math.round(this.map.getZoom());
        const mapZoomPadding = this.map.activeMap.size / 4000;

        if (currentZoom >= 3.7 + mapZoomPadding) {
            this.setLinesWeight(this.kpLines, 3.5 * this.opacity);
            this.setLinesOpacity(this.s1Lines, 1 * this.opacity);
            this.setLinesWeight(this.s1Lines, 1.7 * this.opacity);
            this.setLinesOpacity(this.s2Lines, 1 * this.opacity);
            this.setLinesWeight(this.s2Lines, 1 * this.opacity);
        }
        else if (currentZoom >= 2 + mapZoomPadding) {
            this.setLinesWeight(this.kpLines, 2.5 * this.opacity);
            this.setLinesOpacity(this.kpLines, 1 * this.opacity);
            this.setLinesOpacity(this.s1Lines, 0.6 * this.opacity);
            this.setLinesOpacity(this.s2Lines, 0);
        } 
        else {
            this.setLinesWeight(this.kpLines, 1.5 * this.opacity);
            this.setLinesOpacity(this.kpLines, 1 * this.opacity);
            this.setLinesOpacity(this.s1Lines, 0);
            this.setLinesOpacity(this.s2Lines, 0);
        }
    },

    /**
    * Updates the opacity for all lines in the lines array to the desired opacity value.
    * @param {Array} lines - array of lines to update
    * @param {Number} opacity - desired opacity value
    */
    setLinesOpacity(lines, opacity = 0.5) {
        // we check only the first object as we are updating all at the same time
        if (lines.length === 0 || lines[0].options.opacity === opacity) return;

        lines.forEach((line) => {
            line.setStyle({ opacity });
        });
    },


    /**
    * Updates the weight for all lines in the lines array to the desired weight value.
    * @param {Array} lines - array of lines to update
    * @param {Number} weight - desired weight value
    */
    setLinesWeight(lines, weight = 1) {
        // we check only the first object as we are updating all at the same time
        if (lines.length === 0 || lines[0].options.weight === weight) return;

        lines.forEach((line) => {
            line.setStyle({ weight });
        });
    },

    /**
    * Redraws the grid inside the current view bounds.
    */
    redraw() {
        
        if (!this.bounds || !this.areaSize) return;
        
        // clear old grid lines
        this.clearLines();

        // Define and scale line's intervals
        // This handle rectangle map stretched into a rectangle
        const kpX = KEYPAD * this.map.gameToMapScale;
        const kpY = KEYPAD * this.map.gameToMapScaleY;

        // for complete grid drawing we take lowest interval, as we want to draw all lines
        // whether or not they will be seen is dependant on another function setting
        // opacity based on zoom level
        const intervalX = kpX / 9;
        const intervalY = kpY / 9;

        // clearing arrays
        this.kpLines = [];
        this.s1Lines = [];
        this.s2Lines = [];
        this.labels = [];
        
        // The game's grid covers its minimap (setArea), here the part of it on the map image; every 9th sub2 line is
        // a keypad line and every 3rd a sub1 line. Counting lines instead of testing multiples keeps float error from
        // drifting.
        const [originEast, originSouth] = this.originOffset;
        const width = this.areaSize[0] * this.map.gameToMapScale;
        const height = this.areaSize[1] * this.map.gameToMapScaleY;
        const startX = this.bounds.getWest() + originEast * this.map.gameToMapScale;
        const endX = Math.min(this.bounds.getEast(), startX + width);
        const startY = this.bounds.getNorth() - originSouth * this.map.gameToMapScaleY;
        const endY = Math.max(this.bounds.getSouth(), startY - height);
        const EPSILON = 1e-6;

        // vertical lines
        for (let n = 0; startX + n * intervalX <= endX + EPSILON; n++) {
            const x = startX + n * intervalX;
            const bot = {lat: endY, lng: x};
            const top = {lat: startY, lng: x};

            if (n % 9 === 0) {
                this.kpLines.push(new Polyline([bot, top], this.lineStyleKP));
            } else if (n % 3 === 0) {
                this.s1Lines.push(new Polyline([bot, top], this.lineStyleSUB1));
            } else {
                this.s2Lines.push(new Polyline([bot, top], this.lineStyleSUB2));
            }
        }

        // horizontal lines
        for (let n = 0; startY - n * intervalY >= endY - EPSILON; n++) {
            const y = startY - n * intervalY;
            const left = {lat: y, lng: startX};
            const right = {lat: y, lng: endX};

            if (n % 9 === 0) {
                this.kpLines.push(new Polyline([left, right], this.lineStyleKP));
            } else if (n % 3 === 0) {
                this.s1Lines.push(new Polyline([left, right], this.lineStyleSUB1));
            } else {
                this.s2Lines.push(new Polyline([left, right], this.lineStyleSUB2));
            }
        }

        // Letters A, B, ... above the columns and numbers 1, 2, ... left of the rows, each at the middle of its
        // column or row. The grid's far edge is rarely a keypad line: as in the game, the strip left after the last
        // whole keypad is labelled too, at its own middle (W_SQMapHorizontalBar/VerticalBar give it a slot that
        // narrow). On Mestia, a whole 8 x 8 keypads, the game's empty last slot spreads its other letters and numbers
        // up to 279 m away from their columns and rows; here they stay over them.
        for (let column = 0; column * kpX < width - EPSILON; column++) {
            const middle = startX + (column * kpX + Math.min((column + 1) * kpX, width)) / 2;
            this.labels.push(new Marker({lat: startY, lng: middle}, {
                interactive: false,
                icon: new DivIcon({
                    className: "gridText",
                    html: String.fromCharCode(65 + column),
                    iconSize: [20, 20],
                    iconAnchor: [10, 20]
                })
            }));
        }
        for (let row = 0; row * kpY < height - EPSILON; row++) {
            const middle = startY - (row * kpY + Math.min((row + 1) * kpY, height)) / 2;
            this.labels.push(new Marker({lat: middle, lng: startX}, {
                interactive: false,
                icon: new DivIcon({
                    className: "gridText",
                    html: row + 1,
                    iconSize: [20, 20],
                    iconAnchor: [20, 10]
                })
            }));
        }


        // Draw lines from smallest to largest so bigger lines are drawn over smaller ones
        this.s2Lines.forEach(this.addLayer, this);
        this.s1Lines.forEach(this.addLayer, this);
        this.kpLines.forEach(this.addLayer, this);
        this.labels.forEach(this.addLayer, this);

        // Make label unfocusable with tab to avoid users panning the map while alt-tabbing
        for (const element of document.querySelectorAll(".gridText")) element.setAttribute("tabindex", "-1");
    },
});
