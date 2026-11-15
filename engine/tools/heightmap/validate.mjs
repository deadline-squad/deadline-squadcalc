// Checks the page's height read (SquadHeightmap on the engine's wasm core, public/engine) against the independent
// reference of reference.py on served heightmaps: the largest difference per kind of point, the points where only one
// side has a height, and the batch read against the single reads. Run from the repository root:
//
//   node --import ./tests/register.mjs engine/tools/heightmap/validate.mjs <heightmaps_dir> <levels_dir> <points_dir> <map>...
//
// `<points_dir>` holds <map>.pts.f64, <map>.kind.u8 and <map>.ref.f64 (reference.py points, or expect for given points;
// without a .kind.u8 every point counts as kind 0). Exit status 1 when a difference exceeds 1e-8 m.
import fs from "node:fs";
import zlib from "node:zlib";
import SquadHeightmap from "../../../src/js/squadHeightmaps.js";
import { App } from "../../../tests/stubs/app.mjs";

const [heightmapsDir, levelsDir, pointsDir, ...maps] = process.argv.slice(2);
const TOLERANCE_M = 1e-8;
const KINDS = ["uniform", "detail quad", "border", "plain beside detail"];
globalThis.document = {};
globalThis.$ = () => ({ trigger: () => {} });
App.openToast = () => {};
console.debug = () => {};

const floats = (path) => {
    const bytes = fs.readFileSync(path);
    return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / 8);
};

let failed = false;
for (const map of maps) {
    const meta = JSON.parse(fs.readFileSync(`${heightmapsDir}/${map}/meta.json`));
    const raw = fs.readFileSync(`${levelsDir}/${map}.u16`);
    const levels = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
    const detail = meta.detail ? new Uint8Array(zlib.gunzipSync(fs.readFileSync(`${heightmapsDir}/${map}/${meta.detail.file}`))) : null;
    const heightmap = Object.create(SquadHeightmap.prototype);
    Object.assign(heightmap, { map: { pixelSize: 256 }, core: null, toEngine: null, resolution: 0, ready: false, failed: false, detailFailed: false, detailError: "", worker: null });
    heightmap.map.heightmap = heightmap;
    await heightmap.receive({
        levels, width: meta.width, height: meta.height, step: meta.webp.z_step_m, bounds: meta.bounds_m, detail, url: map,
        lattice: { originX: meta.origin_m[0], originY: meta.origin_m[1], resolution: meta.resolution_m, yawDeg: meta.yaw_deg ?? 0 },
    });
    if (!heightmap.ready || heightmap.detailFailed) throw new Error(`${map}: ${heightmap.detailError || "not loaded"}`);

    const points = floats(`${pointsDir}/${map}.pts.f64`);
    const expected = floats(`${pointsDir}/${map}.ref.f64`);
    const kinds = fs.existsSync(`${pointsDir}/${map}.kind.u8`) ? fs.readFileSync(`${pointsDir}/${map}.kind.u8`) : new Uint8Array(expected.length);
    const batch = heightmap.getHeights(points);
    const worst = KINDS.map(() => ({ n: 0, max: 0, nanMismatch: 0 }));
    let batchMismatch = 0;
    for (let i = 0; i < expected.length; i++) {
        const single = heightmap.getHeight({ lat: points[2 * i], lng: points[2 * i + 1] });
        if (!Object.is(single, batch[i])) batchMismatch++;
        const stat = worst[kinds[i]];
        stat.n++;
        if (Number.isNaN(expected[i]) || Number.isNaN(single)) {
            if (!(Number.isNaN(expected[i]) && Number.isNaN(single))) stat.nanMismatch++;
        } else {
            stat.max = Math.max(stat.max, Math.abs(single - expected[i]));
        }
    }
    const overall = Math.max(...worst.map((stat) => stat.max));
    const bad = overall > TOLERANCE_M || worst.some((stat) => stat.nanMismatch) || batchMismatch;
    failed ||= Boolean(bad);
    console.log(JSON.stringify({
        map, points: expected.length, max_diff_m: overall, batch_vs_single_mismatches: batchMismatch,
        by_kind: Object.fromEntries(worst.map((stat, k) => [KINDS[k], stat]).filter(([, stat]) => stat.n)),
    }));
    heightmap.dispose();
}
process.exit(failed ? 1 : 0);
