import { test } from "node:test";
import assert from "node:assert/strict";
import { heightAt, pathAt, launchPoint, solveElevation, maxRange, isParabola, boostSteps, burnTime, axisBoostTime, flyBoost, fliesBoostInSteps, FRAME_TIME, BOOST_NODE_SPACING } from "../src/js/squadBallistics.js";
import { WEAPONS } from "../src/data/weapons.js";
import SquadFiringSolution from "../src/js/squadFiringSolution.js";
import { App } from "./stubs/app.mjs";
import { loadWeapon, solve } from "./helpers.mjs";

const GRAVITY = 9.8;
const parabola = { velocity: 100, gravity: GRAVITY, acceleration: 0, boostTime: 0, maxSpeed: 0, rotationFollowsVelocity: true, pivotHeight: 0, muzzleForward: 0, muzzleUp: 0 };

test("plain parabola: the low and high elevations are the textbook roots", () => {
    const distance = 500;
    const { low, high } = solveElevation(parabola, distance, 0);
    const lowExpected = 0.5 * Math.asin(GRAVITY * distance / parabola.velocity ** 2);
    assert.ok(isParabola(parabola));
    assert.ok(Math.abs(low - lowExpected) < 1e-9, `${low} vs ${lowExpected}`);
    assert.ok(Math.abs(high - (Math.PI / 2 - lowExpected)) < 1e-9);
});

test("plain parabola: a target beyond the maximum range has no elevation", () => {
    const { low, high } = solveElevation(parabola, maxRange(parabola) + 1, 0);
    assert.ok(Number.isNaN(low) && Number.isNaN(high));
});

test("plain parabola: the maximum range is v² / g, at 45 degrees", () => {
    assert.ok(Math.abs(maxRange(parabola) - parabola.velocity ** 2 / GRAVITY) < 0.01);
});

test("a higher target needs a higher elevation, a lower one a lower elevation", () => {
    const flatRoot = solveElevation(parabola, 400, 0).low;
    assert.ok(solveElevation(parabola, 400, 30).low > flatRoot);
    assert.ok(solveElevation(parabola, 400, -30).low < flatRoot);
});

// Every kind of shot of weapons.js: the root the solver returns puts the flight on the target
const SHOTS = [
    ["a mortar", "Mortar", 0],
    ["a grenade launcher", "DF_M203_M320_GP_25_HK79_SL40", 0],
    ["a launch point that moves with the elevation (PARS III MK19)", "DF_MK19_PARS_III_RWS", 0],
    ["a boosted rocket (RPG-7)", "DF_RPG_7_PG_7V_HEAT_OG_7V", 0],
    ["a shell fired above its speed cap (tank HE)", "DF_Tank_HEAT_HE_M256_Rh120_2A46_ZPT98_2A20_M68A2", 1],
];
for (const [label, name, shellIndex] of SHOTS) {
    test(`the solved elevation lands the shot on the target: ${label}`, () => {
        const { weapon } = loadWeapon(name, shellIndex);
        const shot = weapon.getShot();
        for (const [distance, height] of [[150, 0], [300, 5], [400, -8]]) {
            const { low } = solveElevation(shot, distance, height);
            assert.ok(!Number.isNaN(low), `${name} has an elevation at ${distance} m`);
            assert.ok(Math.abs(heightAt(shot, low, distance) - height) < 1e-6, `${name} at ${distance} m`);
        }
    });
}

// The game destroys a projectile InitialLifeSpan seconds after launch: a shot that takes longer has no solution
test("a target the projectile cannot reach before its lifespan ends has no elevation (RPG-7, 4 s)", () => {
    const near = solve("DF_RPG_7_PG_7V_HEAT_OG_7V", 500).solution;
    const far = solve("DF_RPG_7_PG_7V_HEAT_OG_7V", 1500).solution;
    assert.ok(near.timeOfFlight.low < 4 && !Number.isNaN(near.elevation.low.deg), "500 m is reached within 4 s");
    assert.ok(far.timeOfFlight.low > 4, `1500 m takes ${far.timeOfFlight.low} s`);
    assert.ok(Number.isNaN(far.elevation.low.deg), "1500 m is past the lifespan");
});

// The projectile starts at the muzzle, which stands up to 5 m ahead of the pivot (a tank gun): a target the muzzle is
// not short of cannot be hit, though the barrel's line can be laid through it
const MUZZLE_AHEAD = WEAPONS.filter((entry) => entry.muzzle?.forward > 0);
test("no elevation for a target that is not past the muzzle, on every weapon whose muzzle is ahead of its pivot", () => {
    assert.ok(MUZZLE_AHEAD.length >= 80, `${MUZZLE_AHEAD.length} weapons with the muzzle ahead`);
    for (const entry of MUZZLE_AHEAD) {
        const shot = loadWeapon(entry.name).weapon.getShot();
        for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            for (const above of [-1, 0, 0.5, 1, 2]) {
                const distance = fraction * entry.muzzle.forward;
                const roots = solveElevation(shot, distance, shot.pivotHeight + above);
                for (const arc of ["low", "high"]) {
                    const root = roots[arc];
                    assert.ok(Number.isNaN(root) || launchPoint(shot, root).x < distance,
                        `${entry.name}: ${arc} ${root} rad for a target ${distance} m ahead, ${above} m above the pivot`);
                }
            }
        }
    }
});

test("a target just past the muzzle keeps its elevation", () => {
    for (const entry of MUZZLE_AHEAD) {
        const shot = loadWeapon(entry.name).weapon.getShot();
        const level = launchPoint(shot, 0);
        const distance = level.x + 1;
        const { low } = solveElevation(shot, distance, level.y);
        assert.ok(!Number.isNaN(low), `${entry.name} has an elevation 1 m past its muzzle`);
        assert.ok(launchPoint(shot, low).x < distance && Math.abs(heightAt(shot, low, distance) - level.y) < 1e-6, `${entry.name}: ${low} rad`);
    }
});

test("the firing solution of a target inside the barrel's length has no low arc (T-62 and mortar, issue #31)", () => {
    const map = {
        mapToGameScale: 1,
        mapToGameScaleY: 1,
        toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
        heightmap: { jsonPng: [[0]], getHeight: (latlng) => latlng.h },
    };
    for (const [name, distance, height] of [["DF_Tank_AP_T_62_2A20", 3, 2], ["Mortar", 0.3885, 1]]) {
        const { weapon } = loadWeapon(name);
        App.activeWeapon = weapon;
        const solution = new SquadFiringSolution({ lat: 0, lng: 0, h: 0 }, { lat: 0, lng: distance, h: height }, map, 0);
        assert.ok(launchPoint(solution.shot, 0).x > distance, `${name}: the muzzle is more than ${distance} m ahead of the pivot`);
        assert.ok(Number.isNaN(solution.elevation.low.deg), `${name}: low ${solution.elevation.low.deg} deg, flight ${solution.timeOfFlight.low} s`);
    }
});

// A flight written from the server's rule (issue #49), not from squadBallistics.js: one Velocity Verlet step per
// server frame, the frame being 1 / 49.87 s (the median of the `Server Tick Rate` log lines), the motor acting on
// the first ceil(T / frame) - 1 steps (thrust while k · frame < T at the k-th movement tick), the cap on every step.
// The heights are from the pivot's ground; the answer is the height and the time at the target's distance, on the
// straight segment of the step that crosses it
const SERVER_FRAME = 1 / 49.87;
function flyServerRule(shot, angle, distance) {
    const motorSteps = shot.boostTime > 0 && shot.acceleration !== 0 ? Math.ceil(shot.boostTime / SERVER_FRAME - 1e-9) - 1 : 0;
    const cap = shot.maxSpeed || Infinity;
    const clamp = (vx, vy) => {
        const speed = Math.hypot(vx, vy);
        return speed > cap ? [vx * cap / speed, vy * cap / speed] : [vx, vy];
    };
    const { x: startX, y: startY } = launchPoint(shot, angle);
    let [x, y] = [startX, startY];
    let [vx, vy] = [shot.velocity * Math.cos(angle), shot.velocity * Math.sin(angle)];
    let [ax, ay] = [shot.acceleration * Math.cos(angle), shot.acceleration * Math.sin(angle)];
    for (let step = 0; step < 1e6; step++) {
        const push = step < motorSteps ? 1 : 0;
        const [mx, my] = clamp(vx + push * ax * SERVER_FRAME, vy + (push * ay - shot.gravity) * SERVER_FRAME);
        const nextX = x + 0.5 * (vx + mx) * SERVER_FRAME;
        const nextY = y + 0.5 * (vy + my) * SERVER_FRAME;
        if (shot.rotationFollowsVelocity !== false) {
            const speed = Math.hypot(vx, vy);
            [ax, ay] = [shot.acceleration * vx / speed, shot.acceleration * vy / speed];
        }
        [vx, vy] = clamp(vx + push * ax * SERVER_FRAME, vy + (push * ay - shot.gravity) * SERVER_FRAME);
        if (nextX >= distance) {
            const part = (distance - x) / (nextX - x);
            return { height: y + (nextY - y) * part, time: (step + part) * SERVER_FRAME };
        }
        [x, y] = [nextX, nextY];
    }
    throw new Error(`the flight never reaches the target (${distance} m at ${angle} rad)`);
}

// Impact miss of the solver's elevations against the reference flight, metres
function missesOf(shot, distance, height) {
    const roots = solveElevation(shot, distance, height);
    return ["low", "high"].filter((arc) => !Number.isNaN(roots[arc])).map((arc) => flyServerRule(shot, roots[arc], distance).height - height);
}

test("the frame is 1 / 49.87 s and the motor acts on ceil(T / frame) - 1 steps (issue #49)", () => {
    assert.equal(FRAME_TIME, SERVER_FRAME);
    const motor = { ...parabola, acceleration: 100, boostTime: 0.8 };
    assert.equal(boostSteps(motor), 39, "0.8 s is 39.9 frames: the motor acts on 39 of the 40 steps that start before it ends");
    assert.equal(boostSteps({ ...motor, boostTime: 2 * FRAME_TIME }), 1, "a motor of two frames acts on one (strict)");
    assert.equal(boostSteps({ ...motor, boostTime: FRAME_TIME }), 0, "a motor of one frame never acts");
    assert.equal(boostSteps({ ...motor, acceleration: 0 }), 0);
    assert.ok(!fliesBoostInSteps({ ...motor, boostTime: FRAME_TIME }), "a motor that never acts is no motor");
});

// A T that is a whole number of frames up to rounding (the 1e-9 of boostSteps and hasBoost) does not gain a step; one
// beyond that does
test("a motor of a whole number of frames up to 1e-9 of a frame acts on one step fewer than the frames, a hair more gains one (issue #49)", () => {
    const motor = { ...parabola, acceleration: 100, gravity: 0, maxSpeed: 1000 };
    const frames = (count) => ({ ...motor, boostTime: count * FRAME_TIME });
    assert.equal(boostSteps(frames(40 + 1e-10)), 39, "a rounding above 40 frames");
    assert.equal(boostSteps(frames(40 - 1e-10)), 39, "a rounding below 40 frames");
    assert.equal(boostSteps(frames(40 + 2e-9)), 40, "2e-9 of a frame past 40 frames");
    assert.equal(burnTime(frames(40 + 1e-10)), 39 * FRAME_TIME);
    assert.equal(axisBoostTime(frames(40 + 1e-10)), 39 * FRAME_TIME);
    // hasBoost (inside fliesBoostInSteps and axisBoostTime) follows the same rule at the smallest motor
    const gravity = { gravity: GRAVITY };
    assert.ok(!fliesBoostInSteps({ ...frames(1 + 1e-10), ...gravity }), "a motor of one frame and a rounding never acts");
    assert.ok(fliesBoostInSteps({ ...frames(1 + 2e-9), ...gravity }), "a motor of one frame and 2e-9 acts on one step");
    assert.equal(axisBoostTime(frames(1 + 1e-10)), 0);
    assert.equal(axisBoostTime(frames(1 + 2e-9)), FRAME_TIME);
});

// The closed-form motor along the axis ends with its steps, or earlier when the cap is reached in a flight without gravity
test("the axis motor ends at the cap when it is reached before the burn ends, and burns for its steps otherwise (NLAW, issue #49)", () => {
    const nlaw = { ...parabola, velocity: 40, gravity: 0, acceleration: 350, boostTime: 0.65, maxSpeed: 250 };
    assert.equal(boostSteps(nlaw), 32);
    assert.ok(burnTime(nlaw) > 0.64, "the burn is 0.6417 s");
    assert.ok(Math.abs(axisBoostTime(nlaw) - 0.6) < 1e-12, `${axisBoostTime(nlaw)} s to the cap, not the burn`);
    assert.equal(axisBoostTime({ ...nlaw, maxSpeed: 1000 }), burnTime(nlaw), "a cap that is not reached");
    assert.equal(axisBoostTime({ ...nlaw, maxSpeed: 0 }), burnTime(nlaw), "no cap");
    assert.equal(axisBoostTime({ ...nlaw, velocity: 260 }), 0, "fired above the cap: the motor adds nothing");
    assert.equal(axisBoostTime({ ...nlaw, gravity: GRAVITY, rotationFollowsVelocity: false }), burnTime(nlaw), "with gravity the cap is not the end of the motor");
    assert.equal(axisBoostTime({ ...nlaw, acceleration: -50 }), burnTime({ ...nlaw, acceleration: -50 }), "a motor that slows down is not ended by the cap");
});

// Whether the cap could clamp a motor along the axis is asked with the steps the motor acts on, not with its T
test("the cap of an axis motor binds on the speed after its steps, not after its T: the closed form is kept when it does not (issue #49)", () => {
    // 100 m/s and 100 m/s² for 49 steps (0.98254 s): 198.254 m/s, 208.08 with gravity; the T of 1 s would reach 210
    const motor = { ...parabola, velocity: 100, gravity: 10, acceleration: 100, boostTime: 1, rotationFollowsVelocity: false };
    assert.equal(boostSteps(motor), 49);
    assert.ok(!fliesBoostInSteps({ ...motor, maxSpeed: 209 }), "the steps do not reach the cap");
    assert.ok(!fliesBoostInSteps({ ...motor, maxSpeed: 208.2 }), "the gravity term is that of the steps (208.08), not of the T (208.25)");
    assert.ok(fliesBoostInSteps({ ...motor, maxSpeed: 208 }), "the steps do reach the cap");
    const atEnd = Math.abs(motor.velocity + motor.acceleration * burnTime(motor)) + motor.gravity * burnTime(motor);
    assert.ok(!fliesBoostInSteps({ ...motor, maxSpeed: atEnd }), "a speed at the cap is not clamped");
    assert.ok(fliesBoostInSteps({ ...motor, maxSpeed: 90, acceleration: 1 }), "fired above the cap");
    assert.ok(fliesBoostInSteps({ ...motor, velocity: 300, acceleration: -100, maxSpeed: 250 }), "fired above the cap and slowed under it by the motor");
    assert.ok(!fliesBoostInSteps({ ...motor, maxSpeed: 0 }), "no cap");
    // A motor that slows the projectile past zero: the speed at the end is the magnitude of v0 + a T
    const reversing = { ...motor, velocity: 10, acceleration: -200, boostTime: 1 };
    assert.ok(fliesBoostInSteps({ ...reversing, maxSpeed: 150 }), "the end speed is 186 m/s backwards");
    assert.ok(!fliesBoostInSteps({ ...reversing, maxSpeed: 250 }));
});

test("a shot with a motor lands on the target in a flight of the server's frames: UB-32 at 2183 m (issue #49)", () => {
    const shot = loadWeapon("Tech.UB-32").weapon.getShot();
    for (const height of [-100, -10]) {
        const misses = missesOf(shot, 2183.06736034, height);
        assert.equal(misses.length, 2);
        for (const miss of misses) assert.ok(Math.abs(miss) < 0.05, `UB-32 misses by ${miss} m`);
    }
});

test("a motor along the path lands on the target in a flight of the server's frames: RPG-7 TBG-7V, PG-7VR, PF98 (issue #49)", () => {
    for (const [name, distance] of [["DF_RPG_7_TBG_7V_Thermobaric", 450], ["DF_RPG_7_PG_7VR_Tandem", 340], ["DF_PF98_HE_I", 700]]) {
        const shot = loadWeapon(name).weapon.getShot();
        for (const height of [-20, 0, 20]) {
            const misses = missesOf(shot, distance, height);
            assert.ok(misses.length > 0, `${name} reaches ${distance} m`);
            for (const miss of misses) assert.ok(Math.abs(miss) < 0.05, `${name} misses by ${miss} m at ${distance} m, ${height} m`);
        }
    }
});

test("every weapon with a motor lands on the target in a flight of the server's frames (issue #49)", () => {
    const motors = WEAPONS.filter((entry) => entry.acceleration && entry.accelerationTime && entry.gravityScale !== 0);
    assert.ok(motors.length >= 35, `${motors.length} weapons with a motor`);
    for (const entry of motors) {
        const shot = loadWeapon(entry.name).weapon.getShot();
        for (const distance of [100, 250, 450, 700, 1000, 1500, 2000]) {
            for (const miss of missesOf(shot, distance, 10)) assert.ok(Math.abs(miss) < 0.05, `${entry.name} misses by ${miss} m at ${distance} m`);
        }
    }
});

// The time of flight is the number of the server's frames (fractions of the last one): the motor along the path, inside
// the boost (distances up to 140 m) and past it, the closed-form motor along the barrel, and the first step of a shell
// fired above its cap (the tank gun's muzzle is 5 m ahead of its pivot, its first step 22 m long). The bounds are the
// measured differences between the closed forms and the stepped flight (1.2e-5 s, 2.7e-3 m at the worst) and sit
// well under what a frame of 0.02 s instead of 1 / 49.87 s changes: 2.5e-3 of the time of flight
test("the time of flight and the height follow the server's frames: a stepped motor, an axis motor, a shell above its cap", () => {
    const cases = [
        ["DF_RPG_7V1_HEAT", [20, 60, 140, 300, 600]],
        ["Tech.UB-32", [450, 1000, 2000]],
        ["DF_Tank_HEAT_HE_T_62_2A20", [10, 15, 100, 1000]],
        ["DF_KPVT_14_5mm", [10, 100, 1500]],
    ];
    let compared = 0;
    for (const [name, distances] of cases) {
        const shot = loadWeapon(name).weapon.getShot();
        for (const distance of distances) {
            const roots = solveElevation(shot, distance, 0);
            for (const arc of ["low", "high"].filter((key) => !Number.isNaN(roots[key]))) {
                const reference = flyServerRule(shot, roots[arc], distance);
                const flown = pathAt(shot, roots[arc], distance);
                assert.ok(Math.abs(flown.time - reference.time) < 2.5e-5, `${name} ${arc} at ${distance} m: ${flown.time} s, the server's frames ${reference.time} s`);
                assert.ok(Math.abs(flown.height - reference.height) < 3e-3, `${name} ${arc} at ${distance} m: ${flown.height} m, the server's frames ${reference.height} m`);
                compared++;
            }
        }
    }
    assert.ok(compared >= 20, `${compared} flights compared`);
});

// The closed form of a motor along the barrel's axis burns for whole steps: a T that is not a multiple of the frame
// is cut at the last step the motor acts on (issue #44, item 3, with the rule of #49)
test("the axis motor of a T that is not a whole number of frames burns for its steps (UB-32 with T = 2.005 s, 2 km)", () => {
    const shot = { ...loadWeapon("Tech.UB-32").weapon.getShot(), boostTime: 2.005 };
    assert.ok(!fliesBoostInSteps(shot));
    const misses = missesOf(shot, 2000, 0);
    assert.equal(misses.length, 2);
    for (const miss of misses) assert.ok(Math.abs(miss) < 0.005, `the axis motor misses by ${miss} m`);
});

// Issue #44, item 1: a target so close that the barrel's pivot and muzzle leave no root inside the elevation limits
test("no low arc when there is no root: SPG-9 FRAG at 8 and 10 cm, 0.786 m below the pivot (issue #44)", () => {
    const shot = loadWeapon("DF_SPG_9_FRAG").weapon.getShot();
    for (const distance of [0.08050000000000006, 0.1]) {
        const { low } = solveElevation(shot, distance, -0.786);
        assert.ok(Number.isNaN(low), `low ${low} rad at ${distance} m`);
    }
});

test("every root of every weapon is a barrel angle (inside ±90 degrees), for targets from 1 cm to 5 m (issue #44)", () => {
    for (const entry of WEAPONS) {
        const shot = loadWeapon(entry.name).weapon.getShot();
        if (shot.gravity === 0) continue;
        for (const distance of [0.01, 0.0326, 0.0805, 0.1, 0.17, 0.5, 1, 2, 5]) {
            for (const height of [-5, -0.786, 0, 1, 5]) {
                const roots = solveElevation(shot, distance, height);
                for (const arc of ["low", "high"]) {
                    assert.ok(Number.isNaN(roots[arc]) || Math.abs(roots[arc]) < Math.PI / 2,
                        `${entry.name}: ${arc} ${roots[arc]} rad for a target ${distance} m ahead, ${height} m up`);
                }
            }
        }
    }
});

// Issue #44, item 2: the bearing is in [0, 360), north is 0
test("the bearing of a target a hair west of north is 0, not 360 (issue #44)", () => {
    const map = {
        mapToGameScale: 1,
        mapToGameScaleY: 1,
        toMeters: (origin, latlng) => ({ east: latlng.lng - origin.lng, north: latlng.lat - origin.lat }),
        heightmap: { jsonPng: [[0]], getHeight: () => 0 },
    };
    const { weapon } = loadWeapon("Mortar");
    App.activeWeapon = weapon;
    const bearingOf = (north, east) => new SquadFiringSolution({ lat: 0, lng: 0 }, { lat: north, lng: east }, map, 0).bearing;
    assert.equal(bearingOf(100, -1e-15), 0);
    assert.equal(bearingOf(100, 0), 0);
    assert.equal(bearingOf(0, 100), 90);
    assert.equal(bearingOf(-100, 0), 180);
    assert.equal(bearingOf(0, -100), 270);
    assert.ok(Math.abs(bearingOf(100, -1e-6) - (360 - 1e-6 / 100 * 180 / Math.PI)) < 1e-9);
});

// Issue #44, item 4: the low arc of a plain parabola against exact arithmetic. tan = (v² ∓ √D) / (g·d) with
// D = v⁴ − g·(g·d² + 2·rise·v²), in BigInt fixed point (every input is a double, so scaled by 2^120 it is an integer)
const EXACT = 2n ** 120n;
function integerSqrt(n) {
    let x = 1n << BigInt((n.toString(2).length >> 1) + 1);
    for (let next = (x + n / x) >> 1n; next < x; next = (x + n / x) >> 1n) x = next;
    return x;
}
function exactTangents(v, g, distance, rise) {
    const [V, G, D, R] = [v, g, distance, rise].map((value) => BigInt(value * 2 ** 120));
    const root = integerSqrt(V ** 4n - G * (G * D * D + 2n * R * V * V));
    const ratio = (numerator) => Number(numerator * EXACT / (G * D)) / Number(EXACT);
    return { low: ratio(V * V - root), high: ratio(V * V + root) };
}

test("the low and high arcs of a plain parabola are exact to 1e-13 rad, for a close target of a fast shell too (issue #44)", () => {
    let compared = 0;
    for (const velocity of [110, 300, 1000, 1400, 1800]) {
        for (const gravity of [1.96, 9.8, 19.6]) {
            for (const distance of [0.5, 1, 2, 3.5, 6, 25, 100, 1000]) {
                for (const rise of [-4, -1, -0.25, 0, 0.25, 1, 4]) {
                    const shot = { ...parabola, velocity, gravity };
                    if (velocity ** 4 < gravity * (gravity * distance ** 2 + 2 * rise * velocity ** 2)) continue;
                    const exact = exactTangents(velocity, gravity, distance, rise);
                    const { low, high } = solveElevation(shot, distance, rise);
                    assert.ok(Math.abs(low - Math.atan(exact.low)) < 1e-13, `v ${velocity} g ${gravity} d ${distance} rise ${rise}: low ${low} vs ${Math.atan(exact.low)}`);
                    assert.ok(Math.abs(high - Math.atan(exact.high)) < 1e-13, `v ${velocity} g ${gravity} d ${distance} rise ${rise}: high ${high}`);
                    compared++;
                }
            }
        }
    }
    assert.ok(compared > 400, `${compared} cases compared`);
});

// Issue #44, item 5: the accuracy of the boost table (four-point interpolation of the stepped boost over the elevation,
// nodes every BOOST_NODE_SPACING) is the bound written in the comment of BOOST_NODE_SPACING. Measured against the
// stepped flight at elevations a quarter, a half and three quarters of the way between two nodes, inside the boost
// and 5 m past its end (where the interpolated end velocity of the M3 MAAWS, which reaches its cap in the boost, counts)
test("the boost table reproduces the stepped boost of every shell to the accuracy its comment states (issue #44)", () => {
    const worst = { inside: 0, pastEnd: 0 };
    let shells = 0;
    for (const entry of WEAPONS) {
        for (let shellIndex = 0; shellIndex < entry.shells.length; shellIndex++) {
            const shot = loadWeapon(entry.name, shellIndex).weapon.getShot();
            if (!fliesBoostInSteps(shot)) continue;
            shells++;
            for (let node = -30; node < 70; node++) {
                for (const between of [0.25, 0.5, 0.75]) {
                    const angle = (node + between) * BOOST_NODE_SPACING;
                    const { xs } = flyBoost(shot, angle);
                    const { x: startX } = launchPoint(shot, angle);
                    const end = xs[xs.length - 1];
                    for (const [phase, distance] of [["inside", startX + end / 2], ["inside", startX + end * 0.999], ["pastEnd", startX + end + 5]]) {
                        worst[phase] = Math.max(worst[phase], Math.abs(heightAt(shot, angle, distance) - flyServerRule(shot, angle, distance).height));
                    }
                }
            }
        }
    }
    assert.ok(shells >= 35, `${shells} shells with a stepped boost`);
    assert.ok(worst.inside < 2e-5, `${worst.inside} m inside the boost`);
    assert.ok(worst.pastEnd < 6e-4, `${worst.pastEnd} m just past the end of the boost`);
});
