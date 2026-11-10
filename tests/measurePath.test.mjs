/**
 * The lengths written on the path between flags (libs/leaflet-measure-path.js, segmentMetres): a segment of the map in
 * the game's metres, each direction with the map's own scale (squadMinimap.mapToGameScale, mapToGameScaleY). Before
 * 45.49.0 both directions took the east scale: a north-south segment on Skorpo (6849 m by 6869 m) read 0.29 % short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAPS, initMapsProperties } from "../src/data/maps.js";
import { segmentMetres } from "../src/js/libs/leaflet-measure-path.js";

initMapsProperties();

const MAP_SIZE = 256;

/** Metres per map unit east and north of a map of maps.js, as squadMinimap.draw sets them */
function scalesOf(name) {
    const { size, sizeY } = MAPS.find((map) => map.name === name);
    return { east: size / MAP_SIZE, north: sizeY / MAP_SIZE };
}

test("a segment along each axis of Skorpo reads its length in metres", () => {
    const { east, north } = scalesOf("Skorpo");
    assert.ok(Math.abs(segmentMetres(1000 / east, 0, east, north) - 1000) < 1e-9);
    assert.ok(Math.abs(segmentMetres(0, 1000 / north, east, north) - 1000) < 1e-9);
});

test("a diagonal segment of Skorpo reads the hypotenuse in metres", () => {
    const { east, north } = scalesOf("Skorpo");
    assert.ok(Math.abs(segmentMetres(300 / east, -400 / north, east, north) - 500) < 1e-9);
});

test("one scale for both directions would read a north-south kilometre of Skorpo 2.9 m short", () => {
    const { east, north } = scalesOf("Skorpo");
    const oneScale = segmentMetres(0, 1000 / north, east, east);
    assert.ok(1000 - oneScale > 2.8 && 1000 - oneScale < 3.0, `${oneScale}`);
});
