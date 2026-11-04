/**
 * A target with a height of its own (floor, window, doorway, ceiling, roof of the volume layer) in the firing solution
 * and the line-of-fire check (SquadFiringSolution `targetHeight`, deadline-squad/deadline-squadcalc#22 C3, C4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "./stubs/app.mjs";
import { loadWeapon } from "./helpers.mjs";
import SquadFiringSolution from "../src/js/squadFiringSolution.js";

/** A map of flat ground at height 0 where one map unit is one meter, with a volume layer that records its questions */
function mapWithVolume(questions) {
    return {
        activeMap: { name: "test" },
        toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
        heightmap: { jsonPng: [[0]], getHeight: () => 0, resolution: 1 },
        volume: {
            ready: true,
            zMin: 0,
            toWorld: (latlng) => ({ x: latlng.lng, y: -latlng.lat }),
            lookup: (key, build) => {
                questions.push({ key, ...build() });
                return undefined;
            },
        },
    };
}

function solution(map, targetHeight, distance = 200) {
    const { weapon } = loadWeapon("Mortar");
    App.activeWeapon = weapon;
    return new SquadFiringSolution({ lat: 0, lng: 0 }, { lat: 0, lng: distance }, map, 0, undefined, targetHeight);
}

test("without a height of its own the target is on the ground", () => {
    const flat = solution(mapWithVolume([]), null);
    assert.equal(flat.elevatedTarget, false);
    assert.equal(flat.targetHeight, 0);
});

test("a target at 12 m is aimed at that height: the height difference and the elevation follow", () => {
    const map = mapWithVolume([]);
    const ground = solution(map, null);
    const floor = solution(map, 12);
    assert.equal(floor.elevatedTarget, true);
    assert.equal(floor.targetHeight, 12);
    assert.ok(Math.abs(floor.heightDiff - (12 - floor.weaponHeight)) < 1e-9);
    assert.ok(Number.isFinite(floor.elevation.high.deg));
    assert.ok(Math.abs(floor.elevation.high.deg - ground.elevation.high.deg) > 0.01, `${floor.elevation.high.deg} vs ${ground.elevation.high.deg}`);
});

test("the line of fire to a ground target stops 3 m short of it, to an elevated one ends at the target itself", () => {
    const groundQuestions = [];
    solution(mapWithVolume(groundQuestions), null);
    const elevatedQuestions = [];
    solution(mapWithVolume(elevatedQuestions), 12);

    const lastDistance = (question) => question.path[question.path.length - 3];
    assert.ok(groundQuestions.length > 0 && elevatedQuestions.length > 0);
    // lng is the distance east: the last sampled point
    assert.equal(lastDistance(groundQuestions[0]), 197);
    assert.equal(lastDistance(elevatedQuestions[0]), 200);
    // The path ends at the target's height (the trajectory is solved to land there)
    const lastHeight = (question) => question.path[question.path.length - 1];
    assert.ok(Math.abs(lastHeight(elevatedQuestions[0]) - 12) < 0.05, `ends at ${lastHeight(elevatedQuestions[0])}`);
});

test("the answer cache keys differ by target height", () => {
    const questions = [];
    solution(mapWithVolume(questions), null);
    solution(mapWithVolume(questions), 12);
    assert.ok(questions.some(({ key }) => key.endsWith("|12")));
    assert.ok(questions.some(({ key }) => key.endsWith("|0")));
});
