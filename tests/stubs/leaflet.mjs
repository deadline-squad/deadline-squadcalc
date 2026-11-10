// Stands for leaflet in the tests of the pure modules: the names squadCoverage.js imports, and the circle and polygon
// protectionZone.js draws, which keep what they were made with
export class ImageOverlay {}
export class LatLngBounds {}
export class Circle {
    constructor(latlng, options) {
        Object.assign(this, { latlng, options });
    }
}
export class Polygon {
    constructor(latlngs, options) {
        Object.assign(this, { latlngs, options });
    }
}
