/**
 * Inputs of the independent flight oracle (fly.c): every shot of weapons.js and the elevations the calculator's
 * solver gives it over a grid of targets, in the formats fly.c reads (README.md).
 *
 * The grid is the research's (native-core-2026-11-13): 16 fixed distances and 9 fractions of each weapon's range,
 * 10 target heights, both arcs; a distance with no root is dropped, and so is a root outside the limits the
 * calculator itself applies to a solution (the weapon's elevation range with its angle offset, its projectile's
 * lifespan; see SquadFiringSolution).
 */
import fs from "node:fs";
import path from "node:path";
import { App } from "../../stubs/app.mjs";
import { WEAPONS } from "../../../src/data/weapons.js";
import { pathAt, solveElevation } from "../../../src/js/squadBallistics.js";
import { loadWeapon } from "../../helpers.mjs";

const DISTANCES = [0.5, 2, 5, 15, 51, 150, 340, 450, 700, 1000, 1236, 1500, 2060, 2500, 5000, 8000];
const RANGE_FRACTIONS = [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999];
const HEIGHTS = [-300, -200, -100, -40, -10, 0, 10, 25, 100, 200];
const ARCS = ["low", "high"];

/** The shell classes the bounds are kept for, by how the shot flies */
export const CLASSES = ["capped", "fast_capped", "grenade", "howitzer", "plain_mortar", "axis_motor", "path_motor"];

/**
 * @param {import("../../../src/js/squadBallistics.js").Shot} shot
 * @param {string} type - `type` of the weapon
 * @returns {string|null} - one of CLASSES; null for a shot without gravity, which does not fly an arc
 */
function classify(shot, type) {
    if (shot.gravity === 0) return null;
    const boosted = shot.boostTime > 0 && shot.acceleration !== 0;
    if (boosted) return shot.rotationFollowsVelocity === false ? "axis_motor" : "path_motor";
    if (shot.maxSpeed) return shot.velocity >= 1000 ? "fast_capped" : "capped";
    if (type === "directFire") return "grenade";
    return shot.gravity >= 19 ? "howitzer" : "plain_mortar";
}

/**
 * Whether the calculator would show this elevation: inside the weapon's elevation range and reached before the
 * projectile's lifespan runs out
 * @param {import("../../../src/js/squadWeapons.js").Weapon} weapon
 * @param {number} theta - radians
 * @param {number} time - time of flight, s
 * @returns {boolean}
 */
function inLimits(weapon, theta, time) {
    const degrees = theta * 180 / Math.PI - (weapon.angleOffset || 0);
    const [lowest, highest] = weapon.minElevation;
    return degrees >= lowest && degrees <= highest && time <= weapon.projectileLifespan;
}

/**
 * Solves the grid with the calculator's solver and writes the oracle's inputs
 * @param {string} directory - existing directory; receives `specs.txt` and `cases.txt`
 * @returns {{name: string, cls: string, arc: string, distance: number, height: number, time: number}[]} - what the
 *   solver said, per case in the order of cases.txt, for the test to compare the flights with
 */
export function writeCases(directory) {
    const previous = App.activeWeapon;
    const specLines = [], cases = [], caseLines = [];
    try {
        for (const entry of WEAPONS) {
            entry.shells.forEach((shell, index) => {
                const { weapon } = loadWeapon(entry.name, index);
                App.activeWeapon = weapon;
                const shot = weapon.getShot(App.gravity * weapon.gravityScale);
                const cls = classify(shot, weapon.type);
                if (cls === null) return;
                const sid = specLines.length;
                const name = `${entry.name}/${shell.name}`;
                specLines.push([sid, shot.velocity, shot.gravity, shot.acceleration, shot.boostTime, shot.maxSpeed,
                    shot.rotationFollowsVelocity ? 1 : 0, shot.pivotHeight, shot.muzzleForward, shot.muzzleUp].join(" "));

                const range = weapon.getMaxDistance();
                const distances = new Set(DISTANCES);
                for (const fraction of RANGE_FRACTIONS) distances.add(+(range * fraction).toPrecision(12));
                for (const distance of distances) {
                    for (const height of HEIGHTS) {
                        const roots = solveElevation(shot, distance, height);
                        for (const arc of ARCS) {
                            const theta = roots[arc];
                            if (Number.isNaN(theta)) continue;
                            const { time } = pathAt(shot, theta, distance);
                            if (!inLimits(weapon, theta, time)) continue;
                            cases.push({ name, cls, arc, distance, height, time });
                            caseLines.push([sid, theta, distance, height].join(" "));
                        }
                    }
                }
            });
        }
    } finally {
        App.activeWeapon = previous;
    }
    fs.writeFileSync(path.join(directory, "specs.txt"), specLines.join("\n") + "\n");
    fs.writeFileSync(path.join(directory, "cases.txt"), caseLines.join("\n") + "\n");
    return cases;
}
