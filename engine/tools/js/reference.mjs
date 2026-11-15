// Runs SquadCalc's real Weapon + SquadFiringSolution on the grid of tools/direct_fire/compare.py and prints, as JSON,
// the weapon parameters of every shell and the JS solution of every case, for the Rust parity test (tests/parity.rs).
// Besides the grid of compare.py it solves targets from 10 cm to 5 m (the muzzle is already past some of them,
// the barrel's own line runs through others) and checks paths against terrain profiles (`above`).
//
//   node --import ./hooks.mjs reference.mjs <SquadCalc checkout>
//
// Output: { specs: [{ weapon, shell, params }], rows: [{ spec, distance, height, nearMax, low, sight, high, tofLow, tofHigh, hold, max }],
//           aboveRows: [{ spec, angle, step, profile, above }] }
// NaN (unreachable) is written as null.
import { App } from "./stub-app.mjs";

const root = process.argv[2];
const { WEAPONS } = await import(`${root}/src/data/weapons.js`);
const { Weapon } = await import(`${root}/src/js/squadWeapons.js`);
const { default: SquadFiringSolution } = await import(`${root}/src/js/squadFiringSolution.js`);
const { RangeMax, trajectory } = await import(`${root}/src/js/squadBallistics.js`);

// The grid of compare.py (DISTANCES x HEIGHTS)
const DISTANCES = [0.5, 1, 2, 3, 4, 5, 15, 51, 150, 340, 450, 700, 1000, 1236, 1500, 2060, 2500, 5000, 8000];
// Targets within a few metres, at heights a barrel's own line reaches (a mortar's muzzle is 1.6 m ahead of its pivot, 1.4 m up)
const CLOSE_DISTANCES = [0.1, 0.25, 0.5, 1, 2, 3, 4, 5];
const CLOSE_HEIGHTS = [-2, -1, 0.5, 1, 2, 3, 5];
const HEIGHTS = [-300, -100, -40, -10, 0, 10, 25, 100, 200];
const NEAR_MAX = [0.5, 0.9, 0.99, 0.999, 1.001, 1.01];
const NEAR_MAX_HEIGHTS = [-40, 0, 25];

// The paths checked against terrain: two barrel angles, three profiles under, over and around the path
const ABOVE_ANGLES = [0.05, 0.9];
const ABOVE_STEP = 7;
const ABOVE_SAMPLES = 80;

/** The profiles of one path: terrain 0.3 m under it, with one sample 0.3 m over it, and a noisy terrain around it */
function aboveProfiles(shot, angle) {
    const path = trajectory(shot, angle);
    const heights = Array.from({ length: ABOVE_SAMPLES }, (_, i) => {
        const height = path.height(i * ABOVE_STEP);
        return Number.isFinite(height) ? height : -1e9;
    });
    let state = 12345;
    const noise = () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return state / 2 ** 32;
    };
    return [
        heights.map((h) => h - 0.3),
        heights.map((h, i) => (i === 50 ? h + 0.3 : h - 0.3)),
        heights.map((h) => h - 0.2 + 0.4 * noise()),
    ];
}

const specs = [];
const rows = [];
const aboveRows = [];
for (const w of WEAPONS) {
    if (!w.ballistics) continue;
    const weapon = new Weapon(w.name, w.deceleration, w.decelerationTime, w.gravityScale, w.minElevation, w.unit, w.logo, w.marker, w.type, w.angleType, w.elevationPrecision, w.shells, w.heightOffset, w.angleOffset, w.projectileLifespan, w.mod, w.elevationRate, w.heatmap, w.acceleration, w.accelerationTime, w.holdElevation, w.ballistics, w.image, w.muzzle, w.maxSpeed, w.rotationFollowsVelocity);
    const map = {
        mapToGameScale: 1,
        mapToGameScaleY: 1,
        toMeters: (origin, ll) => ({ east: ll.lng - origin.lng, north: ll.lat - origin.lat }),
        heightmap: { jsonPng: [[0]], getHeight: (ll) => ll.h },
    };
    for (const shell of w.shells) {
        weapon.velocity = shell.velocity;
        weapon.moa = shell.moa;
        weapon.minDistance = shell.minDistance;
        weapon.decelerationDistance = weapon.velocity * weapon.decelerationTime - 0.5 * weapon.deceleration * weapon.decelerationTime ** 2;
        App.activeWeapon = weapon;
        const max = weapon.getMaxDistance();
        const spec = specs.length;
        specs.push({
            weapon: w.name,
            shell: shell.name,
            params: {
                velocity: weapon.velocity,
                gravity_scale: weapon.gravityScale,
                acceleration: weapon.acceleration,
                acceleration_time: weapon.accelerationTime,
                max_speed: weapon.maxSpeed || 0,
                rotation_follows_velocity: weapon.rotationFollowsVelocity !== false,
                height_offset: weapon.heightOffset,
                angle_offset_deg: weapon.angleOffset,
                min_elevation_deg: weapon.minElevation[0],
                max_elevation_deg: weapon.minElevation[1],
                projectile_lifespan: weapon.projectileLifespan,
                elevation_rate: weapon.elevationRate || 0,
                hold_elevation: weapon.holdElevation,
                muzzle: weapon.muzzle ? { pivot_height: weapon.muzzle.pivotHeight, forward: weapon.muzzle.forward, up: weapon.muzzle.up } : null,
            },
        });
        const cases = [];
        for (const d of DISTANCES) for (const h of HEIGHTS) cases.push([d, h, false]);
        for (const d of CLOSE_DISTANCES) for (const h of CLOSE_HEIGHTS) cases.push([d, h, false]);
        if (w.gravityScale !== 0) {
            for (const f of NEAR_MAX) for (const h of NEAR_MAX_HEIGHTS) cases.push([max * f, h, true]);
        }
        for (const [distance, height, nearMax] of cases) {
            const fs = new SquadFiringSolution({ lat: 0, lng: 0, h: 0 }, { lat: 0, lng: distance, h: height }, map, 0);
            rows.push({
                spec, distance, height, nearMax,
                low: fs.elevation.low.deg, sight: fs.getSightAngle(fs.elevation.low.rad), high: fs.elevation.high.deg,
                tofLow: fs.timeOfFlight.low, tofHigh: fs.timeOfFlight.high, hold: fs.holdTime.high, max,
            });
        }
        if (w.gravityScale === 0) continue;
        const shot = weapon.getShot(App.gravity * w.gravityScale);
        for (const angle of ABOVE_ANGLES) {
            for (const profile of aboveProfiles(shot, angle)) {
                const heights = Float64Array.from(profile);
                const rangeMax = new RangeMax(heights.length).build(heights);
                const above = trajectory(shot, angle).above(heights, 0, heights.length - 1, ABOVE_STEP, 0, rangeMax);
                aboveRows.push({ spec, angle, step: ABOVE_STEP, profile, above });
            }
        }
    }
}
process.stdout.write(JSON.stringify({ specs, rows, aboveRows }));
