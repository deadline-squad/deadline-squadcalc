// node --import ./tests/register.mjs tests/independent/terrain/run.mjs [map...]
// The page's sampled obstacle test (SquadFiringSolution.getObstacle, on the heights of the engine-backed SquadHeightmap)
// against the exact reference (exact.mjs on the reader of heightmap.mjs), on the seeded lines of lines.mjs, per map and
// weapon. Exits 0 when no bound of bounds.json is broken, 1 when one is, 2 when the data or the usage is wrong.
// SQUADCALC_HEIGHTMAPS names the directory with the site's /heightmaps/<map>/ files.
import fs from "node:fs";
import path from "node:path";
import { App } from "../../stubs/app.mjs";
import { loadWeapon } from "../../helpers.mjs";
import SquadFiringSolution from "../../../src/js/squadFiringSolution.js";
import SquadHeightmap from "../../../src/js/squadHeightmaps.js";
import { MUZZLE_CLEARANCE, TARGET_CLEARANCE } from "../../../src/js/squadCoverage.js";
import { flightPath, lowestClearance } from "./exact.mjs";
import { readHeightmap } from "./heightmap.mjs";
import { LINES_PER_WEAPON, lineSource } from "./lines.mjs";

// The weapons that fly parabolas, in the order of the shared stream of lines
const WEAPONS = ["DF_Tank_AP_M256_Rh120", "DF_ZiS_3", "Mk19"];

// A line with no fireable solution is drawn again; this many draws per counted line without success is a broken setup
const MAX_DRAWS_PER_LINE = 100;

// Map units across the page's map (squadMinimap pixelSize)
const PIXEL_SIZE = 256;

const bounds = JSON.parse(fs.readFileSync(new URL("./bounds.json", import.meta.url), "utf8"));

function fail(message, code) {
    console.error(message);
    process.exit(code);
}

// The page's pieces the heightmap touches: the jQuery events, the toasts, and the worker its constructor starts
// (the oracle hands the levels over itself, as the worker would)
globalThis.document = {};
globalThis.window = { location: { origin: "http://localhost" } };
globalThis.Worker = class { postMessage() {} terminate() {} };
globalThis.$ = () => ({ trigger: () => {} });
App.openToast = (...toast) => fail(`the page showed a toast: ${toast.join(" ")}`, 2);

/**
 * The page's SquadHeightmap on the same files, handed over as the worker would (receive), read by the real engine
 * @param {object} field - readHeightmap
 * @returns {Promise<SquadHeightmap>}
 */
async function pageHeightmap(field) {
    const { meta } = field;
    const map = { pixelSize: PIXEL_SIZE, activeMap: { mapURL: `/${meta.map}/` } };
    const heightmap = new SquadHeightmap(map);
    map.heightmap = heightmap;
    await heightmap.receive({
        levels: field.levels, width: meta.width, height: meta.height, step: meta.z_step_m,
        lattice: { originX: meta.origin_m[0], originY: meta.origin_m[1], resolution: meta.resolution_m, yawDeg: meta.yaw_deg ?? 0 },
        bounds: meta.bounds_m, detail: field.detailBytes, url: meta.map,
    });
    if (!heightmap.ready || heightmap.failed || heightmap.detailFailed) fail(`the page could not read the heightmap of ${meta.map}: ${heightmap.detailError}`, 2);
    return heightmap;
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))] : 0;
const roundUp = (value) => Math.ceil(value * 1e6) / 1e6;

/**
 * @returns {Promise<object>} - per weapon: lines counted, blocked by the exact test, found by the page, missed, false blocks and
 *   the depths of the missed lines
 */
async function measureMap(directory, map) {
    const field = readHeightmap(directory, map);
    const heightmap = await pageHeightmap(field);
    const box = field.meta.bounds_m;
    const east = (box.max_x - box.min_x) / PIXEL_SIZE;
    const north = (box.max_y - box.min_y) / PIXEL_SIZE;
    // LatLng of the page's map <-> world metres (squadMinimap.toMeters)
    const toLatLng = (x, y) => ({ lng: (x - box.min_x) / east, lat: -(y - box.min_y) / north });
    const pageMap = {
        heightmap, activeMap: { name: map }, volume: null,
        toMeters: (origin, point) => ({ east: (point.lng - origin.lng) * east, north: (point.lat - origin.lat) * north }),
    };
    const nextLine = lineSource(map, box, (x, y) => field.inside(x, y));

    const result = {};
    for (const name of WEAPONS) {
        const { weapon } = loadWeapon(name);
        App.activeWeapon = weapon;
        if (weapon.angleType !== "low" || !weapon.muzzle && !(weapon.heightOffset > 0)) throw new Error(`${name} is not fired from its own muzzle on the low arc`);
        const shot = weapon.getShot(App.gravity * weapon.gravityScale);

        const tally = { lines: 0, blocked: 0, found: 0, missed: 0, falseBlocks: 0, depths: [] };
        for (let draws = 0; tally.lines < LINES_PER_WEAPON; draws++) {
            if (draws > MAX_DRAWS_PER_LINE * LINES_PER_WEAPON) throw new Error(`${map} ${name}: too few lines have a solution`);
            const line = nextLine();
            const target = { x: line.ax + line.ux * line.distance, y: line.ay + line.uy * line.distance };
            const solution = new SquadFiringSolution(toLatLng(line.ax, line.ay), toLatLng(target.x, target.y), pageMap, line.padding);
            const elevation = solution.roots.low;
            // NaN: outside the weapon's elevation limits or lifespan, the page shows no obstacle
            if (!Number.isFinite(elevation) || !Number.isFinite(solution.elevation.low.rad) || !(solution.distance > 2 * MUZZLE_CLEARANCE)) continue;

            const [col, row] = field.toLattice(line.ax, line.ay);
            const weaponHeight = field.terrainAt(col, row) + line.padding;
            const path = flightPath(shot, elevation);
            const lowest = lowestClearance(field, line.ax, line.ay, line.ux, line.uy, MUZZLE_CLEARANCE, line.distance - TARGET_CLEARANCE, (s) => weaponHeight + path(s));
            const blocked = lowest < 0;
            const found = solution.obstacle.low !== null;
            tally.lines++;
            if (blocked) tally.blocked++;
            if (blocked && found) tally.found++;
            if (blocked && !found) {
                tally.missed++;
                tally.depths.push(-lowest);
            }
            if (!blocked && found) tally.falseBlocks++;
        }
        tally.depths.sort((a, b) => a - b);
        result[name] = tally;
    }
    heightmap.dispose();
    return result;
}

/** The bounds of a map and weapon broken by `tally`, and what a better run says to tighten */
function judge(map, name, tally) {
    const worst = roundUp(tally.depths.at(-1) ?? 0);
    const bound = bounds.maps[map]?.[name];
    const broken = [];
    const tighten = [];
    if (tally.falseBlocks > 0) broken.push(`${tally.falseBlocks} false blocks, the bound is 0`);
    if (!bound) {
        broken.push("no bound in bounds.json");
    } else {
        if (tally.missed > bound.missed) broken.push(`missed ${tally.missed}, the bound is ${bound.missed}`);
        if (worst > bound.worstDepth) broken.push(`worst depth ${worst} m, the bound is ${bound.worstDepth} m`);
        if (tally.blocked < bound.blocked) broken.push(`the reference blocks ${tally.blocked} lines, the floor is ${bound.blocked}: it got weaker`);
        if (!broken.length && (tally.missed < bound.missed || worst < bound.worstDepth || tally.blocked > bound.blocked)) {
            tighten.push(`blocked ${bound.blocked} -> ${tally.blocked}, missed ${bound.missed} -> ${tally.missed}, worst depth ${bound.worstDepth} -> ${worst} m`);
        }
    }
    return { broken, tighten, worst };
}

const directory = process.env.SQUADCALC_HEIGHTMAPS;
if (!directory) fail("SQUADCALC_HEIGHTMAPS is not set: point it at the directory holding <map>/{meta.json, heightmap.png, heightmap.detail.bin}", 2);
const maps = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(bounds.maps);

let exitCode = 0;
for (const map of maps) {
    if (!fs.existsSync(path.join(directory, map, "meta.json"))) fail(`no heightmap of ${map} in SQUADCALC_HEIGHTMAPS (${directory}): ${path.join(directory, map, "meta.json")} is missing`, 2);
    const result = await measureMap(directory, map);
    console.log(`${map}`);
    console.log("  weapon                  lines  blocked  found  missed  false  depth median / p90 / max (m)");
    for (const [name, tally] of Object.entries(result)) {
        const { broken, tighten, worst } = judge(map, name, tally);
        const depths = [percentile(tally.depths, 50), percentile(tally.depths, 90)].map((depth) => depth.toFixed(3)).concat(worst.toFixed(6));
        console.log(`  ${name.padEnd(22)} ${String(tally.lines).padStart(6)} ${String(tally.blocked).padStart(8)} ${String(tally.found).padStart(6)} ${String(tally.missed).padStart(7)} ${String(tally.falseBlocks).padStart(6)}  ${depths.join(" / ")}`);
        for (const reason of broken) console.log(`    BOUND BROKEN: ${reason}`);
        for (const reason of tighten) console.log(`    tighten bounds.json: ${reason}`);
        if (broken.length) exitCode = 1;
    }
}
process.exit(exitCode);
