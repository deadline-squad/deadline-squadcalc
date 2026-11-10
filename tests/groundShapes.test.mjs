/**
 * Shapes sized in metres (src/js/groundShapes.js), projected as Leaflet projects them on the calculator's map: CRS.Simple
 * over a map image of 256 units (src/app.js `mapSize`) spanning the minimap corners, east and north each with its own
 * scale (squadMinimap.draw, fromMeters). A circle of R metres must be R metres east to west and north to south on every
 * map, also where the corners are not square (Skorpo 6849 m by 6869 m, Black Coast 4598 m by 4599 m), and an ellipse
 * turned in metres must be that ellipse once drawn. The map drew its circles as Leaflet circles of R x gameToMapScale
 * before 45.49.0: R x 6869 / 6849 metres north to south on Skorpo, 6.38 m too long at the UB-32's 2184.3 m.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CRS, LatLng, Circle } from "leaflet";
import { MAPS, initMapsProperties } from "../src/data/maps.js";
import { GroundCircle, GroundEllipse, drawnEllipse } from "../src/js/groundShapes.js";

initMapsProperties();

const MAP_SIZE = 256;
const ZOOM = 5;
// The mortar's longest shot on level ground, the UB-32's (Weapon.getMaxDistance) and the 400 m FOB exclusion radius
const RADII = [400, 1236.9, 2184.3];

/**
 * The calculator's map of a map of maps.js at a zoom: Leaflet's projection of CRS.Simple and squadMinimap's fromMeters;
 * `pixelsEast` and `pixelsNorth` are the pixels per metre the map's size gives, for measuring what is drawn
 */
function mapOf(name, zoom = ZOOM) {
    const { size, sizeY } = MAPS.find((map) => map.name === name);
    const scaleX = MAP_SIZE / size;
    const scaleY = MAP_SIZE / sizeY;
    const project = (latlng) => CRS.Simple.latLngToPoint(new LatLng(latlng), zoom);
    return {
        name,
        options: { crs: CRS.Simple },
        gameToMapScale: scaleX,
        project,
        latLngToLayerPoint: (latlng) => project(latlng).round(),
        layerPointToLatLng: (point) => CRS.Simple.pointToLatLng(point, zoom),
        fromMeters: (origin, east, north) => ({ lat: origin.lat + north * scaleY, lng: origin.lng + east * scaleX }),
        pixelsEast: 2 ** zoom * scaleX,
        pixelsNorth: 2 ** zoom * scaleY,
        metresNorth: sizeY / MAP_SIZE,
    };
}

/** A shape projected on a map as Leaflet projects it once it is on the map (its renderer only gives the click tolerance) */
function projected(shape, map) {
    Object.assign(shape, { _map: map, _renderer: { options: {} } });
    shape._project();
    return shape;
}

// leaflet-ellipse.js keeps its centre as given and reads its lat and lng: a LatLng
const CENTRE = new LatLng(-120.5, 133.25);

test("a circle of R metres is R metres east to west and north to south on every map", () => {
    for (const { name } of MAPS) {
        const map = mapOf(name);
        for (const radius of RADII) {
            const circle = projected(new GroundCircle(CENTRE, { radius }), map);
            assert.ok(Math.abs(circle._radius / map.pixelsEast - radius) < 0.01, `${name} ${radius} m: ${circle._radius / map.pixelsEast} m east to west`);
            assert.ok(Math.abs(circle._radiusY / map.pixelsNorth - radius) < 0.01, `${name} ${radius} m: ${circle._radiusY / map.pixelsNorth} m north to south`);
            const bounds = circle.getBounds();
            const northSouth = (bounds.getNorth() - bounds.getSouth()) / 2 * map.metresNorth;
            assert.ok(Math.abs(northSouth - radius) < 0.01, `${name} ${radius} m: its bounds reach ${northSouth} m north and south`);
        }
    }
});

test("on Skorpo the UB-32's 2184.3 m ring is 2184.3 m north to south within 1 cm, where a Leaflet circle of R x gameToMapScale is 6.38 m longer", () => {
    const map = mapOf("Skorpo");
    const ring = projected(new GroundCircle(CENTRE, { radius: 2184.3 }), map);
    assert.ok(Math.abs(ring._radiusY / map.pixelsNorth - 2184.3) < 0.01, `${ring._radiusY / map.pixelsNorth} m`);
    // Leaflet's circle measures its radius between two layer points rounded to whole pixels: measured at zoom 12
    const fine = mapOf("Skorpo", 12);
    const before = projected(new Circle(CENTRE, { radius: 2184.3 * fine.gameToMapScale }), fine);
    assert.equal(before._radiusY, undefined, "one radius for both directions");
    const beforeNorth = before._radius / fine.pixelsNorth;
    assert.ok(Math.abs(beforeNorth - 2184.3 * 6869 / 6849) < 0.01, `${beforeNorth} m`);
    assert.ok(Math.abs(beforeNorth - 2184.3 - 6.38) < 0.01, `${beforeNorth - 2184.3} m too long`);
});

test("a circle's radius stays in metres (getRadius), and a negative radius is drawn as its size, as Leaflet draws it", () => {
    const map = mapOf("BlackCoast");
    const circle = projected(new GroundCircle(CENTRE, { radius: 150 }), map);
    assert.equal(circle.getRadius(), 150);
    circle._mRadius = -150;
    circle._project();
    assert.ok(Math.abs(circle._radiusY / map.pixelsNorth - 150) < 0.01);
});

/** Points of a projected ellipse as drawn (leaflet-ellipse.js: its radii along _tilt on the screen), back in metres east and south of its centre */
function drawnPointsInMetres(ellipse, map, count = 72) {
    const points = [];
    for (let i = 0; i < count; i++) {
        const t = 2 * Math.PI * i / count;
        const x = ellipse._radiusX * Math.cos(t);
        const y = ellipse._radiusY * Math.sin(t);
        const east = x * Math.cos(ellipse._tilt) - y * Math.sin(ellipse._tilt);
        const south = x * Math.sin(ellipse._tilt) + y * Math.cos(ellipse._tilt);
        points.push([east / map.pixelsEast, south / map.pixelsNorth]);
    }
    return points;
}

test("an ellipse turned in metres is that ellipse once drawn, on Skorpo, Black Coast and a square map", () => {
    for (const name of ["Skorpo", "BlackCoast", "AlBasrah"]) {
        const map = mapOf(name);
        for (const [radii, tilt] of [[[30, 12], 37], [[12, 30], 120.5], [[2184.3, 2184.3], 0], [[5, 80], -63]]) {
            const ellipse = projected(new GroundEllipse(CENTRE, radii, tilt), map);
            const turn = tilt * Math.PI / 180;
            for (const [east, south] of drawnPointsInMetres(ellipse, map)) {
                const along = east * Math.cos(turn) + south * Math.sin(turn);
                const across = -east * Math.sin(turn) + south * Math.cos(turn);
                const onEllipse = (along / radii[0]) ** 2 + (across / radii[1]) ** 2;
                assert.ok(Math.abs(onEllipse - 1) < 1e-9, `${name} ${radii} at ${tilt} degrees: a drawn point at ${onEllipse}`);
            }
        }
    }
});

test("a round ellipse of 2184.3 m (a damage radius without spread) is 2184.3 m north to south on Skorpo", () => {
    const map = mapOf("Skorpo");
    const ellipse = projected(new GroundEllipse(CENTRE, [2184.3, 2184.3], 211), map);
    const southMost = Math.max(...drawnPointsInMetres(ellipse, map, 3600).map(([, south]) => south));
    assert.ok(Math.abs(southMost - 2184.3) < 0.01, `${southMost} m`);
});

test("an ellipse keeps its tilt and radii in metres when projected again and after setTilt", () => {
    const map = mapOf("Skorpo");
    const ellipse = projected(new GroundEllipse(CENTRE, [30, 12], 37), map);
    const first = [ellipse._radiusX, ellipse._radiusY, ellipse._tiltDeg];
    ellipse._project();
    assert.deepEqual([ellipse._radiusX, ellipse._radiusY, ellipse._tiltDeg], first);
    assert.deepEqual([ellipse.getRadius().x, ellipse.getRadius().y], [30, 12]);
    ellipse._groundTilt = 0;
    ellipse._project();
    assert.ok(Math.abs(ellipse._tiltDeg) < 1e-12, "a radius along east stays along east");
    assert.ok(Math.abs(ellipse._radiusX / map.pixelsEast - 30) < 1e-9 && Math.abs(ellipse._radiusY / map.pixelsNorth - 12) < 1e-9);
});

test("drawnEllipse: on a square map the drawn ellipse is the one in metres scaled, an empty one stays empty", () => {
    const drawn = drawnEllipse(30, 12, 37, 4, 4);
    assert.ok(Math.abs(drawn.radiusX - 120) < 1e-9 && Math.abs(drawn.radiusY - 48) < 1e-9 && Math.abs(drawn.tilt - 37) < 1e-9);
    assert.deepEqual(drawnEllipse(0, 0, 37, 4, 4), { radiusX: 0, radiusY: 0, tilt: 0 });
});
