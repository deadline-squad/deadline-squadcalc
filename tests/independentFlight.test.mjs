/**
 * The calculator's solver against an independent flight oracle: tests/independent/flight/fly.c flies the game's
 * discrete model (written apart from the calculator, from Squad Ballistics' docstring and the thesis formulas
 * F1 to F5) at every elevation the solver gives over a grid of targets, and the miss of each flight, grouped by
 * the class of the shell, must stay within the bounds measured on the tree (bounds.json). Needs a C compiler
 * (`cc`); without one the test fails, it does not skip.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSES, writeCases } from "./independent/flight/cases.mjs";

const FLIGHT_DIR = new URL("./independent/flight/", import.meta.url);
const bounds = JSON.parse(readFileSync(new URL("bounds.json", FLIGHT_DIR), "utf8"));

// The longest output of fly.c: one line per case
const MAX_OUTPUT = 1 << 26;

/** Compiles fly.c into `directory`; fails with the compiler's name when there is none */
function compile(directory) {
    const build = spawnSync("cc", ["-std=c99", "-O2", "-Wall", "-Wextra", "-o", join(directory, "fly"),
        fileURLToPath(new URL("fly.c", FLIGHT_DIR)), "-lm"], { encoding: "utf8" });
    if (build.error?.code === "ENOENT") {
        assert.fail("the C compiler `cc` is missing: the independent flight oracle needs one (install gcc or clang)");
    }
    assert.equal(build.status, 0, `cc failed on fly.c:\n${build.stderr}`);
}

/** Flies the cases written to `directory`; one flight per case, in order */
function fly(directory) {
    const run = spawnSync(join(directory, "fly"), [join(directory, "specs.txt"), join(directory, "cases.txt")],
        { encoding: "utf8", maxBuffer: MAX_OUTPUT });
    assert.equal(run.status, 0, `fly failed:\n${run.stderr}`);
    return run.stdout.trim().split("\n").map((line) => {
        const [ok, dy, time, slope] = line.split(" ").map(Number);
        return { ok: ok === 1, dy, time, slope };
    });
}

/** The case with the largest `value`, among those of `list` */
function worst(list, value) {
    let best = { value: 0, at: null };
    list.forEach((item, index) => {
        const v = value(item, index);
        if (v > best.value) best = { value: v, at: item };
    });
    return best;
}

const describeCase = (c) => `${c.name}, ${c.arc} arc, distance ${c.distance} m, height ${c.height} m`;

// Set up when the file loads, not in a `before` hook: a missing compiler then fails the file with its message at the top
// of the report, where a failed hook would only cancel every test
const directory = mkdtempSync(join(tmpdir(), "squadcalc-flight-"));
let cases;
let flights;
try {
    compile(directory);
    cases = writeCases(directory);
    flights = fly(directory);
} finally {
    rmSync(directory, { recursive: true, force: true });
}

describe("independent flight oracle", () => {
    test("every flight reaches its target distance", () => {
        assert.equal(flights.length, cases.length, "fly.c answered another number of cases");
        const lost = cases.filter((_, index) => !flights[index].ok);
        assert.equal(lost.length, 0, `${lost.length} flights do not reach the target, first: ${lost[0] && describeCase(lost[0])}`);
    });

    test("every flight reports finite numbers", () => {
        const bad = flights.findIndex(({ dy, time, slope }) => ![dy, time, slope].every(Number.isFinite));
        assert.equal(bad, -1, bad === -1 ? "" : `fly.c reported a number that is not finite for ${describeCase(cases[bad])}: ${JSON.stringify(flights[bad])}`);
    });

    test("the grid keeps its size", () => {
        assert.ok(cases.length >= bounds.inLimitsCases,
            `${cases.length} cases inside the weapon limits, bounds.json records ${bounds.inLimitsCases}: a smaller grid checks less`);
    });

    test("every shell class has a bound, and a bound has shells", () => {
        assert.deepEqual([...new Set(cases.map((c) => c.cls))].sort(), Object.keys(bounds.miss).sort());
        assert.deepEqual([...CLASSES].sort(), Object.keys(bounds.miss).sort());
    });

    for (const [cls, { bound, measured }] of Object.entries(bounds.miss)) {
        test(`the miss of the ${cls} shells stays within ${bound} m`, () => {
            const inClass = cases.map((c, index) => ({ ...c, index })).filter((c) => c.cls === cls);
            const { value, at } = worst(inClass, (c) => {
                const { dy, slope } = flights[c.index];
                return Math.abs(dy) / Math.sqrt(1 + slope * slope);
            });
            assert.ok(value <= bound,
                `${cls}: miss ${value} m is above the bound ${bound} m (measured ${measured} m on ${bounds.measuredOn.commit}) at ${at && describeCase(at)}`);
        });
    }

    test(`the time of flight differs from the solver's by at most ${bounds.time.bound} s`, () => {
        const { value, at } = worst(cases, (c, index) => Math.abs(flights[index].time - c.time));
        assert.ok(value <= bounds.time.bound,
            `time of flight differs by ${value} s, above the bound ${bounds.time.bound} s (measured ${bounds.time.measured} s on ${bounds.measuredOn.commit}) at ${at && describeCase(at)}`);
    });
});
