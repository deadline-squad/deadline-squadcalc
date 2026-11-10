// Stands for leaflet in the tests of the pure modules: the names squadCoverage.js imports, and the polygon
// protectionZone.js draws, which keeps what it was made with (its circles are groundShapes.js's, on the real Leaflet)
export class ImageOverlay {}
export class LatLngBounds {}
export class Polygon {
    constructor(latlngs, options) {
        Object.assign(this, { latlngs, options });
    }
}
