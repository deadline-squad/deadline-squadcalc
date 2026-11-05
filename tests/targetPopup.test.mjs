/**
 * The content of the calculation popup of a target (targetPopup.js): the line of the height chosen in the target dialog,
 * and the lines that follow the weapon, the ammunition and the settings. The browser check (targets_check.mjs) covers
 * that a choice in the dialog reaches the open popup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import i18next from "i18next";
import { App } from "./stubs/app.mjs";
import { loadWeapon } from "./helpers.mjs";
import SquadFiringSolution from "../src/js/squadFiringSolution.js";
import { popupContent, formatHeightChoice } from "../src/js/targetPopup.js";
import common from "../public/locales/en/common.json" with { type: "json" };

await i18next.init({ lng: "en", resources: { en: { common } }, interpolation: { escapeValue: false } });

const flatMap = {
    activeMap: { name: "test" },
    toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
    heightmap: { jsonPng: [[0]], getHeight: () => 0, resolution: 1 },
};

/** The elevation line of the popup, without markup */
const elevationOf = (html) => html.split("<br>")[1].replace(/<[^>]*>/g, "");

function contentFor(weaponName, shellIndex, targetHeight, targetLines = "") {
    const { weapon } = loadWeapon(weaponName, shellIndex);
    App.activeWeapon = weapon;
    App.userSettings = { lowAndHigh: false, showBearing: true, showTimeOfFlight: false, showDistance: false, showHeight: false };
    const firingSolution = new SquadFiringSolution({ lat: 0, lng: 0 }, { lat: 0, lng: 400 }, flatMap, 0, undefined, targetHeight);
    return popupContent(firingSolution, "high", { formatRounds: () => "", targetLines })[0];
}

test("a floor chosen in the dialog adds its line to the popup, an unchosen height adds none", () => {
    const floor = { kind: "floor", height: 3.3, above: 3.3 };
    assert.match(contentFor("Mortar", 0, 3.3, formatHeightChoice(floor)), /<span class="calcTargetHeight">⌖ Floor \+3\.3<span data-i18n="common:m">m<\/span><\/span>/);
    assert.doesNotMatch(contentFor("Mortar", 0, null, formatHeightChoice(null)), /calcTargetHeight/);
});

test("the height line names the kind of the choice and signs the height above the ground", () => {
    assert.match(formatHeightChoice({ kind: "roof", above: 6.34 }), /⌖ Roof \+6\.3</);
    assert.match(formatHeightChoice({ kind: "window", above: -1.25 }), /⌖ Window -1\.3</);
    assert.equal(formatHeightChoice(null), "");
});

test("the elevation of the popup follows the height of the target", () => {
    
    assert.notEqual(elevationOf(contentFor("Mortar", 0, null)), elevationOf(contentFor("Mortar", 0, 40)));
});

test("the elevation of the popup follows the ammunition and the weapon", () => {
    
    const byShell = [0, 1, 2].map((index) => elevationOf(contentFor("MO120RTF1", index, null)));
    assert.equal(new Set(byShell).size, 3, `the three shells of the 120 mm mortar give ${byShell}`);
    assert.notEqual(elevationOf(contentFor("Mortar", 0, null)), elevationOf(contentFor("M109", 0, null)));
});

test("the lines of the target come after the rounds and before the settings' lines", () => {
    const html = contentFor("Mortar", 0, 3.3, "<br><span class=\"calcCorrection\">x</span>");
    assert.ok(html.indexOf("calcCorrection") < html.indexOf("bearingUiCalc"));
});
