/**
 * Round shapes sized in the game's metres. The map image is a square of map units over the minimap corners, which are
 * not square on every map (Skorpo 6849 m by 6869 m, Black Coast 4598 m by 4599 m), so a metre east and a metre north
 * are not the same number of map units (squadMinimap.draw: gameToMapScale, gameToMapScaleY). A Leaflet circle has one
 * radius in map units: drawn as R metres times the east scale, it is R metres east to west but R x sizeY / size
 * metres north to south, 6.4 m too long at 2184 m on Skorpo. These shapes take their radii in metres and are drawn
 * through squadMinimap.fromMeters, each direction with its own scale; on a map with square corners they are the shapes
 * they extend. They need the squadMinimap they are on (fromMeters) and are drawn by its SVG renderer, which the
 * browser hit-tests on the drawn path, so a pointer over the shape is over what is drawn.
 */
import { Circle } from "leaflet";
import { Ellipse } from "./libs/leaflet-ellipse.js";

/**
 * Pixels per metre east and north at the map's zoom (not rounded to whole pixels as layer points are)
 * @param {squadMinimap} map
 * @param {LatLng} latlng - a point of the map (the map's units are linear: any point gives the same)
 * @returns {{east: number, north: number}}
 */
function pixelsPerMetre(map, latlng) {
    const point = map.project(latlng);
    return {
        east: map.project(map.fromMeters(latlng, 1, 0)).x - point.x,
        north: point.y - map.project(map.fromMeters(latlng, 0, 1)).y,
    };
}

/**
 * The ellipse drawn for an ellipse of the game's metres: its radii and tilt on the screen
 *
 * The ellipse in metres is R(tilt) diag(radiusX, radiusY) applied to the unit circle, in the (east, south) frame of
 * the screen (y down, a positive tilt turns clockwise, as leaflet-ellipse.js turns). On the screen it is
 * P = diag(east, north) R(tilt) diag(radiusX, radiusY) applied to the unit circle: an ellipse whose radii are the
 * square roots of the eigenvalues of P Pᵀ and whose first radius lies along the first eigenvector.
 * @param {number} radiusX - metres, along the tilt
 * @param {number} radiusY - metres, across it
 * @param {number} tilt - degrees clockwise from east
 * @param {number} east - pixels per metre east
 * @param {number} north - pixels per metre north (and south)
 * @returns {{radiusX: number, radiusY: number, tilt: number}} - pixels, pixels, degrees clockwise from east
 */
export function drawnEllipse(radiusX, radiusY, tilt, east, north) {
    const turn = tilt * Math.PI / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const a2 = radiusX * radiusX;
    const b2 = radiusY * radiusY;
    // P Pᵀ, symmetric
    const xx = east * east * (a2 * cos * cos + b2 * sin * sin);
    const yy = north * north * (a2 * sin * sin + b2 * cos * cos);
    const xy = east * north * (a2 - b2) * cos * sin;
    const halfDiff = (xx - yy) / 2;
    const drawnX = Math.sqrt((xx + yy) / 2 + Math.hypot(halfDiff, xy));
    // The product of the radii is |det P|
    const drawnY = drawnX ? east * north * Math.abs(radiusX * radiusY) / drawnX : 0;
    return { radiusX: drawnX, radiusY: drawnY, tilt: Math.atan2(xy, halfDiff) * 90 / Math.PI };
}

/**
 * A circle of a radius in metres (option `radius`, setRadius, getRadius), drawn as the ellipse it is on the map's
 * units: Leaflet's circle with a radius east (`_radius`) and one north (`_radiusY`), which its SVG renderer draws as
 * two arcs of those radii (SVG._updateCircle). A negative radius is drawn as its size, as Leaflet's circle draws it.
 */
export const GroundCircle = Circle.extend({
    _project() {
        const { east, north } = pixelsPerMetre(this._map, this._latlng);
        this._point = this._map.latLngToLayerPoint(this._latlng);
        this._radius = Math.abs(this._mRadius) * east;
        this._radiusY = Math.abs(this._mRadius) * north;
        this._updateBounds();
    },
});

/**
 * An ellipse of radii in metres (leaflet-ellipse.js: `radii`, setRadius, getRadius) and a tilt in the game's metres
 * (degrees clockwise from east, setTilt), drawn with the radii and tilt it has on the screen (drawnEllipse)
 */
export const GroundEllipse = Ellipse.extend({
    initialize(latlng, radii, tilt, options) {
        Ellipse.prototype.initialize.call(this, latlng, radii, tilt, options);
        this._groundTilt = this._tiltDeg;
    },

    setTilt(tilt) {
        this._groundTilt = tilt;
        return this.redraw();
    },

    _project() {
        const { east, north } = pixelsPerMetre(this._map, this._latlng);
        const drawn = drawnEllipse(this._mRadiusX, this._mRadiusY, this._groundTilt, east, north);
        this._point = this._map.latLngToLayerPoint(this._latlng);
        this._radiusX = Math.max(drawn.radiusX, 1);
        this._radiusY = Math.max(drawn.radiusY, 1);
        // leaflet-ellipse.js draws with _tiltDeg (the SVG arc) and _tilt (its bounds and hit test)
        this._tiltDeg = drawn.tilt;
        this._tilt = drawn.tilt * Math.PI / 180;
        this._endPointParams = this._centerPointToEndPoint();
        this._updateBounds();
    },
});
