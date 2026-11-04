// Validates the reverse-position heatmap (src/js/positionHeatmap.js) of a target against the exact triangle tracer.
// (deadline-squad/deadline-squadcalc#22 C5)
//
//   node --import ./engine/tools/js/hooks.mjs engine/tools/js/heatmap_validate.mjs \
//       --served <heightmaps dir of the map> --tris <window triangles .bin> --window x0,y0,size \
//       --target x,y --weapon <weapons.js name> [--region <.rtri>] [--height <kind>[:index]] [--range 200] [--out dir]
//
// The same classifier (positionHeatmap.createPositionClassifier) runs three times on the same target and weapon:
//   voxel      the volume worker (volumeWorker.js, the real engine in wasm), voxel-column walk only;
//   precision  the same worker with the target's precision region (`--region`);
//   exact      in this process, every line of fire traced against the BVH of the exact collision triangles of the window
//              (`--tris`: nine float32 per triangle, from tools/make_voxel_segments.py; the engine's BVH is checked against
//              the python reference tracer by tests/parity.rs).
// The landscape is the same file in all three, so the cells differ only by what the objects do. Only positions inside the
// window are compared (the triangles exist there only); a line between two points of the window stays inside it.
// Prints the confusion of voxel and precision against exact (false clear: the run says clear, exact says blocked; false
// blocked: the other way; "out": the shooter's body is inside a voxel / a triangle's volume, counted apart) overall and per
// distance band, and writes the images and a JSON summary to `--out`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync, gunzipSync } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: options } = parseArgs({
    options: {
        served: { type: "string" }, tris: { type: "string" }, window: { type: "string" }, target: { type: "string" },
        weapon: { type: "string" }, region: { type: "string" }, height: { type: "string", default: "ground" },
        range: { type: "string", default: "200" }, out: { type: "string", default: "." }, "min-cell": { type: "string" },
    },
});
for (const name of ["served", "tris", "window", "target", "weapon"]) {
    if (!options[name]) throw new Error(`--${name} is required`);
}
const [windowX, windowY, windowSize] = options.window.split(",").map(Number);
const [targetX, targetY] = options.target.split(",").map(Number);

const { App } = await import("./stub-app.mjs");
const { WEAPONS } = await import(join(root, "src/data/weapons.js"));
const { Weapon } = await import(join(root, "src/js/squadWeapons.js"));
const { createPositionClassifier, heatmapGrid, HEAT, rasterizeHeatmap } = await import(join(root, "src/js/positionHeatmap.js"));
const { SHOULDER_HEIGHT } = await import(join(root, "src/js/squadCoverageRays.js"));
const { classifyColumn } = await import(join(root, "src/js/targetHeights.js"));
const { decodeTerrain, terrainHeight } = await import(join(root, "src/js/volumeTerrain.js"));
const { loadEngine, buildBvh } = await import(join(root, "engine/js/index.mjs"));
const wasmPath = join(root, "engine/js/pkg/squad_engine_bg.wasm");

const meta = JSON.parse(readFileSync(join(options.served, "meta.json")));
const files = {
    "volume.vcol": readFileSync(join(options.served, meta.volume.file)),
    "terrain.bin": readFileSync(join(options.served, meta.volume.terrain.file)),
};
const regionBytes = options.region ? readFileSync(options.region) : null;
const regionEntry = regionBytes && {
    file: basename(options.region), bytes: regionBytes.length, sha256: createHash("sha256").update(regionBytes).digest("hex"),
};

// --- The worker, as squadVolume.js drives it ------------------------------------------------------------------------
const messages = [];
globalThis.postMessage = (message) => messages.push(message);
globalThis.fetch = async (url) => {
    const name = basename(String(url).split("?")[0]);
    if (name === basename(wasmPath)) return new Response(readFileSync(wasmPath), { headers: { "content-type": "application/wasm" } });
    if (files[name]) return new Response(files[name]);
    if (regionEntry && name === regionEntry.file) return new Response(regionBytes);
    return new Response("not found", { status: 404 });
};
globalThis.onmessage = null;
await import(join(root, "src/js/volumeWorker.js"));

const send = (data) => new Promise((resolve) => {
    const before = messages.length;
    globalThis.onmessage({ data });
    const timer = setInterval(() => {
        if (messages.length > before) {
            clearInterval(timer);
            resolve(messages[messages.length - 1]);
        }
    }, 5);
});
const loaded = await send({ load: {
    base: "http://localhost/heightmaps/map/", volume: meta.volume, generated: meta.generated,
    engineUrl: pathToUrl(join(root, "engine/js/index.mjs")), wasmUrl: pathToUrl(wasmPath),
} });
if (!loaded.loaded) throw new Error(JSON.stringify(loaded));

function pathToUrl(path) {
    return new URL(`file://${path}`).href;
}

// --- The weapon and the target --------------------------------------------------------------------------------------
const entry = WEAPONS.find((candidate) => candidate.name === options.weapon);
if (!entry) throw new Error(`no weapon ${options.weapon}`);
const weapon = new Weapon(entry.name, entry.deceleration, entry.decelerationTime, entry.gravityScale, entry.minElevation, entry.unit, entry.logo, entry.marker, entry.type, entry.angleType, entry.elevationPrecision, entry.shells, entry.heightOffset, entry.angleOffset, entry.projectileLifespan, entry.mod, entry.elevationRate, entry.heatmap, entry.acceleration, entry.accelerationTime, entry.holdElevation, entry.ballistics, entry.image, entry.muzzle, entry.maxSpeed, entry.rotationFollowsVelocity, entry.legacyBallistics);
weapon.velocity = entry.shells[0].velocity;
weapon.moa = entry.shells[0].moa;
App.activeWeapon = weapon;
const gravity = App.gravity * weapon.gravityScale;

const column = await send({ column: 1, x: targetX, y: targetY });
if (!column.solids) throw new Error("no landscape at the target");
const choices = classifyColumn(column.solids, column.walled);
const ground = column.solids[0][1];
console.log(`target (${targetX}, ${targetY}), landscape ${ground.toFixed(2)} m; heights offered: ${choices.map(({ kind, z }) => `${kind} +${(z - ground).toFixed(2)}`).join(", ") || "none"}`);

// The exact tracer: the BVH of the window's triangles, built once
const terrain = decodeTerrain(gunzipSync(files["terrain.bin"]));
const engine = await loadEngine(readFileSync(wasmPath));
const triangles = readFileSync(options.tris);
console.log(`BVH of ${triangles.length / 36} triangles ...`);
const buildStarted = performance.now();
engine.loadBvh("exact", [buildBvh(new Uint8Array(triangles.buffer, triangles.byteOffset, triangles.length))]);
console.log(`built in ${((performance.now() - buildStarted) / 1000).toFixed(1)} s`);

const east = [1, 0];
const north = [0, -1];
const worldX = (e, n) => targetX + e * east[0] + n * north[0];
const worldY = (e, n) => targetY + e * east[1] + n * north[1];
const insideWindow = (e, n) => {
    const x = worldX(e, n);
    const y = worldY(e, n);
    return x >= windowX && x <= windowX + windowSize && y >= windowY && y <= windowY + windowSize;
};
const kindOf = (value) => (value === HEAT.OUT ? "out" : value === HEAT.BLOCKED ? "blocked" : "clear");
mkdirSync(options.out, { recursive: true });
const summaries = [];
let job = 0;

for (const heightSpec of options.height.split(",")) {
    const [kind, index = "0"] = heightSpec.split(":");
    const chosen = kind === "ground" ? null : choices.filter((choice) => choice.kind === kind)[Number(index)];
    if (kind !== "ground" && !chosen) throw new Error(`no ${heightSpec} at the target`);
    const targetZ = chosen ? chosen.z : ground;
    console.log(`\n== aimed at ${chosen ? `${heightSpec} (+${(targetZ - ground).toFixed(2)} m)` : "the landscape"}, weapon ${weapon.name} (${weapon.moa} MOA)`);

    const range = Math.min(Number(options.range), weapon.getMaxDistance());
    const grid = heatmapGrid(range);
    const params = {
        targetZ,
        elevated: Boolean(chosen),
        shot: weapon.muzzle || weapon.heightOffset > 0 ? weapon.getShot(gravity) : weapon.getShot(gravity, SHOULDER_HEIGHT),
        range,
        cell: grid.cell,
        rays: grid.rays,
        elevationLimits: weapon.minElevation,
        angleOffset: weapon.angleOffset || 0,
        lifespan: weapon.projectileLifespan,
        moa: weapon.moa,
    };
    const stride = Math.floor(range / grid.cell) + 1;

    /** One run of the worker; `region` is a meta.json entry or null */
    const runWorker = async (region) => {
        const id = ++job;
        const ready = await send({ heatInit: { job: id, params, target: [targetX, targetY], east, north, region } });
        if (ready.error) throw new Error(ready.error);
        for (let first = 0; first < grid.rays; first += 8) await send({ heatRays: { job: id, first, size: Math.min(8, grid.rays - first) } });
        const done = await send({ heatFinish: id });
        return { values: done.values, exact: ready.exact, loadMs: ready.loadMs, computeMs: done.computeMs };
    };
    const voxel = await runWorker(null);
    const precision = regionEntry ? await runWorker(regionEntry) : null;
    console.log(`voxel walk: ${voxel.computeMs.toFixed(0)} ms for ${grid.rays * (stride - 1)} positions`);
    if (precision) console.log(`precision pass: region ${(regionBytes.length / 1e6).toFixed(2)} MB loaded in ${precision.loadMs.toFixed(0)} ms (exact ${precision.exact}), ${precision.computeMs.toFixed(0)} ms`);

    const exactClassifier = createPositionClassifier({
        ...params,
        heightAt: (e, n) => terrainHeight(terrain, worldX(e, n), worldY(e, n)),
        pathBlocked: (points, count) => {
            for (let i = 1; i < count; i++) {
                const a = 3 * (i - 1);
                const b = 3 * i;
                const hit = engine.firstHit("exact", [worldX(points[a], points[a + 1]), worldY(points[a], points[a + 1]), points[a + 2], worldX(points[b], points[b + 1]), worldY(points[b], points[b + 1]), points[b + 2]]);
                if (hit) return true;
            }
            return false;
        },
    });
    const exact = new Uint8Array(grid.rays * stride);
    const exactStarted = performance.now();
    for (let ray = 0; ray < grid.rays; ray++) exactClassifier.classifyRay(ray, exact);
    console.log(`exact tracer: ${(performance.now() - exactStarted).toFixed(0)} ms`);

    /** Confusion of a run against the exact one over the positions inside the window */
    const compare = (run) => {
        const bands = [[0, 50], [50, 100], [100, 150], [150, Infinity]].map(([from, to]) => ({ from, to, cells: 0, falseClear: 0, falseBlocked: 0, outMismatch: 0 }));
        const total = { cells: 0, exactClear: 0, exactBlocked: 0, exactOut: 0, falseClear: 0, falseBlocked: 0, outMismatch: 0, lostClear: 0, agree: 0 };
        for (let ray = 0; ray < grid.rays; ray++) {
            const heading = (2 * Math.PI * ray) / grid.rays;
            for (let j = 1; j < stride; j++) {
                const d = j * grid.cell;
                if (!insideWindow(Math.cos(heading) * d, Math.sin(heading) * d)) continue;
                const mine = kindOf(run[ray * stride + j]);
                const truth = kindOf(exact[ray * stride + j]);
                const band = bands.find(({ from, to }) => d >= from && d < to);
                total.cells++;
                band.cells++;
                total[`exact${truth[0].toUpperCase()}${truth.slice(1)}`]++;
                if (mine === truth) {
                    total.agree++;
                } else if (mine === "out" || truth === "out") {
                    total.outMismatch++;
                    band.outMismatch++;
                    if (mine === "out" && truth === "clear") total.lostClear++;
                } else if (mine === "clear") {
                    total.falseClear++;
                    band.falseClear++;
                } else {
                    total.falseBlocked++;
                    band.falseBlocked++;
                }
            }
        }
        return { ...total, bands };
    };
    const summary = {
        height: heightSpec, target: { x: targetX, y: targetY, z: targetZ, landscape: ground },
        weapon: weapon.name, moa: weapon.moa, range, cell: grid.cell, rays: grid.rays, positions: grid.rays * (stride - 1),
        voxel: { ...compare(voxel.values), computeMs: voxel.computeMs },
        precision: precision && { ...compare(precision.values), computeMs: precision.computeMs, loadMs: precision.loadMs, regionBytes: regionBytes.length },
    };
    for (const name of ["voxel", "precision"]) {
        const result = summary[name];
        if (!result) continue;
        console.log(`${name}: ${result.cells} cells in the window, exact clear ${result.exactClear} / blocked ${result.exactBlocked} / out ${result.exactOut}; false CLEAR ${result.falseClear}, false BLOCKED ${result.falseBlocked}, out mismatches ${result.outMismatch} (of them exact clear, run out ${result.lostClear}), agree ${result.agree}`);
        for (const band of result.bands) console.log(`  ${band.from}-${band.to === Infinity ? "end" : band.to} m: ${band.cells} cells, false clear ${band.falseClear}, false blocked ${band.falseBlocked}, out mismatches ${band.outMismatch}`);
    }
    summaries.push(summary);

// --- Images ---------------------------------------------------------------------------------------------------------
const prefix = join(options.out, `heatmap-${basename(options.served)}-${targetX}_${targetY}-${heightSpec.replace(":", "")}`);

/** Minimal PNG writer (RGBA, 8 bit) */
function png(pixels, size) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buffer) => {
        let c = 0xFFFFFFFF;
        for (const byte of buffer) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(crc(body), body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let row = 0; row < size; row++) raw.set(pixels.subarray(row * size * 4, (row + 1) * size * 4), row * (size * 4 + 1) + 1);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const scale = Math.max(1, Math.floor(600 / (2 * Math.ceil(range / grid.cell) + 1)));
const upscale = ({ pixels, size }) => {
    const big = new Uint8ClampedArray(size * scale * size * scale * 4);
    for (let y = 0; y < size * scale; y++) for (let x = 0; x < size * scale; x++) big.set(pixels.subarray(((Math.floor(y / scale)) * size + Math.floor(x / scale)) * 4, ((Math.floor(y / scale)) * size + Math.floor(x / scale)) * 4 + 4), (y * size * scale + x) * 4);
    return { pixels: big, size: size * scale };
};
const draw = (name, values) => {
    const image = upscale(rasterizeHeatmap(values, grid.rays, grid.cell, range));
    writeFileSync(`${prefix}-${name}.png`, png(image.pixels, image.size));
};
draw("voxel", voxel.values);
if (precision) draw("precision", precision.values);
draw("exact", exact);
// The raw values (rays x stride bytes, HEAT), for the browser check to compare the page's own run with
writeFileSync(`${prefix}-voxel.bin`, voxel.values);
if (precision) writeFileSync(`${prefix}-precision.bin`, precision.values);
writeFileSync(`${prefix}-exact.bin`, exact);
summary.params = { ...params, shot: undefined };
console.log(`written ${prefix}-*.png`);
}

writeFileSync(join(options.out, `heatmap-${basename(options.served)}-${targetX}_${targetY}.json`), JSON.stringify(summaries, null, 2));
process.exit(0);
