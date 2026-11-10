/**
 * The bearing as the game's compass shows it (compass.js) against the native code of the HUD compass,
 * USQCompassMK2 of the Squad dedicated server build 26005357 (vtable slot 176, 0xa65ec50): the bearing is the turned
 * yaw if it is above 0, else the yaw plus 360, so it lies in (0, 360] and exactly north is 360; the plain text is that
 * bearing truncated toward zero (cvttss2si) with "00" before it below 10 and "0" below 100; the precise mode of the
 * deployable mortar's view prints it with "%.1f". A player who turns until the plain compass shows the three digits
 * must be within the degree of the bearing, so the digits are the truncated bearing, never the rounded one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compassReading, compassText, compassHTML } from "../src/js/compass.js";

test("the three digits are the bearing cut to a whole degree, as the plain compass shows it, not rounded", () => {
    assert.equal(compassText(45), "045.0");
    assert.equal(compassText(45.04), "045.0");
    assert.equal(compassText(45.7), "045.7");
    assert.equal(compassText(45.5), "045.5");
    assert.equal(compassText(46), "046.0");
    assert.equal(compassText(271.38), "271.4");
});

test("the tenth is rounded as the precise mode rounds it but stays within the compass's degree", () => {
    assert.equal(compassText(45.94), "045.9");
    // %.1f gives 46.0, but the plain compass shows 046 only from 46.0: the reading stays 045
    assert.equal(compassText(45.96), "045.9");
    assert.equal(compassText(45.999999), "045.9");
    assert.deepEqual(compassReading(45.96), { degrees: "045", tenth: "9" });
});

test("bearings under 100 and under 10 are padded to three digits", () => {
    assert.equal(compassText(9.37), "009.4");
    assert.equal(compassText(5), "005.0");
    assert.equal(compassText(99.94), "099.9");
    assert.equal(compassText(100.04), "100.0");
});

test("exactly north is 360, as the compass's (0, 360] gives it; just east of north is 000", () => {
    assert.equal(compassText(0), "360.0");
    assert.equal(compassText(360), "360.0");
    assert.equal(compassText(-0), "360.0");
    assert.equal(compassText(0.04), "000.0");
    assert.equal(compassText(0.06), "000.1");
    assert.equal(compassText(359.94), "359.9");
    assert.equal(compassText(359.96), "359.9");
});

test("a tiny negative bearing is just west of north, or north itself where it rounds to a whole turn", () => {
    // 360 - 1e-12 is a double below 360: the compass shows 359
    assert.equal(compassText(-1e-12), "359.9");
    // 360 - 1e-15 rounds to 360 in double precision: exactly north
    assert.equal(compassText(-1e-15), "360.0");
    assert.equal(compassText(-0.3), "359.7");
});

test("any turn is brought into one turn", () => {
    assert.equal(compassText(405.5), "045.5");
    assert.equal(compassText(-315), "045.0");
    assert.equal(compassText(720), "360.0");
});

test("the HTML has the three digits and the tenth after them in its own span", () => {
    assert.equal(compassHTML(45.7), "045<span class=\"compassTenth\">.7</span>");
    assert.equal(compassHTML(0), "360<span class=\"compassTenth\">.0</span>");
});
