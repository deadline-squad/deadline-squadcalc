/**
 * Hit probability of direct-fire weapons against a simulation of the game's cone (deadline-squad/deadline-squadcalc#19,
 * #6). The oracle does not use SquadCalc's spread formulas: it throws shots from the game's cone
 * (FMath::VRandCone, Squad build 26005357: the miss radius is uniform, the angle too) on the exact parabola from the
 * muzzle, which moves with the elevation, and scores them with impactDamage. The weapon is the vehicle MK19
 * (PARS III RWS, 2.66 m above the ground): its shot grazes the ground at 300 m, so the landing spots along the
 * line of fire are skewed and the symmetric ellipse of a shot from the ground does not hold.
 * Same oracle as tools/direct_fire/hit_probability_check.mjs of the deployment repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { impactDamage, hitProbability, roundsNeeded, KILL_DAMAGE, WOUND_DAMAGE } from "../src/js/squadDamage.js";
import { flat, solve } from "./helpers.mjs";

const SHOTS = 200000;
const TOLERANCE = 0.01;

/** mulberry32: small seeded generator, so the oracle gives the same numbers on every run */
function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Kill and wound probability of shots thrown from the game's cone on a plain parabola from the muzzle */
function gameProbabilities(weapon, shell, elevation, distance, seed) {
    const shot = weapon.getShot();
    const random = seeded(seed);
    const explosion = { damage: shell.explosionDamage, inner: shell.explosionRadius[0], outer: shell.explosionRadius[1], falloff: shell.damageFallOff, distanceFromImpact: shell.explosionDistanceFromImpact };
    const halfAngle = (shell.moa / 60) * 0.5 * Math.PI / 180;
    const sinE = Math.sin(elevation);
    const cosE = Math.cos(elevation);
    const x0 = shot.muzzleForward * cosE - shot.muzzleUp * sinE;
    const z0 = shot.pivotHeight + shot.muzzleForward * sinE + shot.muzzleUp * cosE;
    const soldier = { east: 0, north: 0 };
    let kills = 0;
    let wounds = 0;
    for (let i = 0; i < SHOTS; i++) {
        const phi = Math.acos(2 * random() - 1) % halfAngle;
        const theta = 2 * Math.PI * random();
        const sideways = Math.sin(phi) * Math.cos(theta);
        const upwards = Math.sin(phi) * Math.sin(theta);
        const forward = Math.cos(phi) * cosE - upwards * sinE;
        const up = Math.cos(phi) * sinE + upwards * cosE;
        const vz = shot.velocity * up;
        const flight = (vz + Math.sqrt(vz * vz + 2 * shot.gravity * z0)) / shot.gravity;
        const impact = { east: x0 + shot.velocity * forward * flight - distance, north: shot.velocity * sideways * flight };
        const { damage } = impactDamage(flat, explosion, impact, soldier);
        if (damage >= KILL_DAMAGE) kills++;
        if (damage >= WOUND_DAMAGE) wounds++;
    }
    return { kill: kills / SHOTS, wound: wounds / SHOTS, explosion };
}

const CASES = [
    // [weapon, distance, the game's kill and wound recorded from the simulation, or null]
    ["DF_MK19_PARS_III_RWS", 300, [0.114, 0.419]],
    ["DF_MK19_PARS_III_RWS", 800, null],
    ["DF_MK19_PARS_III_RWS", 1500, null],
    ["DF_MK19_emplacement_C16_L134A1", 300, null],
    ["DF_MK19_emplacement_C16_L134A1", 800, null],
];
for (const [name, distance, recorded] of CASES) {
    test(`${name} at ${distance} m: kill, wound and rounds for 90 % agree with the game's cone`, () => {
        const { weapon, shell, solution } = solve(name, distance);
        const elevation = solution.elevation.low.rad;
        const game = gameProbabilities(weapon, shell, elevation, distance, distance + name.length);
        const { lateral, along } = solution.getHitSpread("low");
        const squadcalc = hitProbability(flat, game.explosion, lateral, along, 90);

        if (recorded) {
            assert.ok(Math.abs(game.kill - recorded[0]) <= TOLERANCE, `oracle kill ${game.kill} vs recorded ${recorded[0]}`);
            assert.ok(Math.abs(game.wound - recorded[1]) <= TOLERANCE, `oracle wound ${game.wound} vs recorded ${recorded[1]}`);
        }
        assert.ok(Math.abs(squadcalc.kill - game.kill) <= TOLERANCE, `kill ${squadcalc.kill.toFixed(3)} vs game ${game.kill.toFixed(3)}`);
        assert.ok(Math.abs(squadcalc.wound - game.wound) <= TOLERANCE, `wound ${squadcalc.wound.toFixed(3)} vs game ${game.wound.toFixed(3)}`);
        for (const key of ["kill", "wound"]) {
            const rounds = roundsNeeded(squadcalc[key]);
            const gameRounds = roundsNeeded(game[key]);
            assert.ok(Math.abs(rounds - gameRounds) <= 1, `rounds to ${key}: ${rounds} vs game ${gameRounds}`);
        }
    });
}
