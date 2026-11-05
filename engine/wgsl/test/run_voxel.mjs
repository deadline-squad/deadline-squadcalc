/**
 * voxel.wgsl on a real WebGPU device (headless Chromium, SwiftShader) against the Rust DDA and the exact triangles.
 *
 *   node engine/wgsl/test/run_voxel.mjs <dataDir> <map>[,<map>...]
 *
 * dataDir is the directory of engine/tests/voxel_parity.rs after that test ran: for every map `<m>.vcol`,
 * `<m>.segments.f64`, `<m>.rust.f64` (t, column, row, z of the native DDA), `<m>.exact.f64` and `<m>.grazing.u8`.
 * The wasm build (`sh engine/js/build.sh`) is run on the same segments and must equal the native DDA bit for bit.
 * Env: PLAYWRIGHT_CORE (playwright-core dir), CHROME (chrome binary).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wgslDir = path.resolve(here, '..');
const [dataDir, mapList] = [process.argv[2], process.argv[3]];
if (!dataDir || !mapList) throw new Error('usage: run_voxel.mjs <dataDir> <map>[,<map>...]');
const playwrightDir = process.env.PLAYWRIGHT_CORE || '/home/seregatipich/cafe-pulse-sync/node_modules/playwright-core';
const chrome = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const CHROME_ARGS = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan,UseSkiaRenderer', '--use-gl=angle', '--use-angle=swiftshader'];
const NO_HIT = 0xffffffff;
/** Metres by which a segment is moved to find out whether f32 rounding alone explains a different answer. */
const NUDGE_M = 1e-3;

const failures = [];
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`); if (!ok) failures.push(message); };
const readFile = (name) => fs.readFileSync(path.join(dataDir, name));
const doubles = (name) => { const b = readFile(name); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };

const files = new Map();
for (const map of mapList.split(',')) {
    files.set(`/${map}.vcol`, readFile(`${map}.vcol`));
    files.set(`/${map}.segments.f64`, readFile(`${map}.segments.f64`));
}
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (files.has(url)) { res.setHeader('content-type', 'application/octet-stream'); res.end(files.get(url)); return; }
    const file = path.join(wgslDir, url);
    if (url !== '/' && file.startsWith(wgslDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.setHeader('content-type', file.endsWith('.mjs') ? 'text/javascript' : 'text/plain');
        res.end(fs.readFileSync(file));
        return;
    }
    res.setHeader('content-type', 'text/html'); res.end('<html></html>');
}).listen(0);

const { chromium } = createRequire(playwrightDir + '/')(playwrightDir);
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: CHROME_ARGS });
const page = await browser.newPage();
page.on('console', (m) => console.log('  [browser]', m.text()));
await page.goto(`http://localhost:${server.address().port}/`);
const device = await page.evaluate(async () => {
    const { requestDevice } = await import('/gpu.mjs');
    const { device, adapterInfo } = await requestDevice(navigator.gpu);
    window.device = device;
    return { vendor: adapterInfo.vendor, architecture: adapterInfo.architecture, description: adapterInfo.description };
});
console.log('WebGPU device:', JSON.stringify(device));

const wasmDir = path.resolve(wgslDir, '../js');
const pkg = await import(path.join(wasmDir, 'pkg/squad_engine.js'));
pkg.initSync({ module: fs.readFileSync(path.join(wasmDir, 'pkg/squad_engine_bg.wasm')) });

for (const map of mapList.split(',')) {
    console.log(`\n== ${map}`);
    const segments = doubles(`${map}.segments.f64`);
    const count = segments.length / 6;
    const rust = doubles(`${map}.rust.f64`);
    const exact = doubles(`${map}.exact.f64`);
    const grazing = readFile(`${map}.grazing.u8`);

    const gpu = await page.evaluate(async ({ map }) => {
        const gpuModule = await import('/gpu.mjs');
        const columns = await gpuModule.parseVcol(await (await fetch(`/${map}.vcol`)).arrayBuffer());
        const source = await gpuModule.fetchVoxelShader(new URL('/gpu.mjs', location.href));
        const voxels = await gpuModule.VoxelGpu.create(window.device, source, columns);
        const segments = new Float64Array(await (await fetch(`/${map}.segments.f64`)).arrayBuffer());
        const r = await voxels.traceSegments(segments);
        const out = { messages: voxels.compilerMessages.length, columns: columns.ids.length, elapsedMs: r.elapsedMs,
            t: Array.from(r.t), column: Array.from(r.column), row: Array.from(r.row), z: Array.from(r.z) };
        voxels.destroy();
        return out;
    }, { map });
    check(gpu.messages === 0, `tint compiles voxel.wgsl with ${gpu.messages} messages`);
    console.log(`GPU kernel: ${count} segments in ${gpu.elapsedMs.toFixed(0)} ms (${Math.round(count / gpu.elapsedMs * 1000)} segments/s on SwiftShader, a CPU)`);

    // The wasm build on the same file and segments
    const engine = new pkg.Engine();
    engine.load_vcol(map, new Uint8Array(files.get(`/${map}.vcol`)));
    const wasmHit = (s) => engine.voxel_first_block(map, Float64Array.from(s));
    let wasmDifferent = 0;
    for (let i = 0; i < count; i++) {
        const hit = wasmHit(segments.subarray(6 * i, 6 * i + 6));
        const expected = rust[4 * i] < 0 ? [] : [rust[4 * i + 1], rust[4 * i + 2], rust[4 * i + 3], rust[4 * i]];
        if (hit.length !== expected.length || hit.some((v, k) => v !== expected[k])) wasmDifferent++;
    }
    check(wasmDifferent === 0, `wasm DDA equals the native DDA on all ${count} segments (${wasmDifferent} differ)`);

    // GPU against the native DDA; a different answer must vanish under a 1 mm move of the segment
    let bothBlocked = 0, bothClear = 0, otherVoxel = 0, otherVoxelNudged = 0, flips = 0, flipsExplained = 0, worstDt = 0;
    const unexplained = [];
    const length = (i) => Math.hypot(segments[6 * i + 3] - segments[6 * i], segments[6 * i + 4] - segments[6 * i + 1], segments[6 * i + 5] - segments[6 * i + 2]);
    const sameVoxel = (i, hit) => hit.length && gpu.column[i] === hit[0] && gpu.row[i] === hit[1] && gpu.z[i] === hit[2];
    // The GPU reads the segment as f32 metres from the grid corner (up to 2.4e-4 m of rounding at 2 km)
    const raw = gunzipSync(files.get(`/${map}.vcol`));
    const origin = [raw.readFloatLE(8), raw.readFloatLE(12), raw.readFloatLE(24)];
    const asSeenByGpu = (i) => Array.from(segments.subarray(6 * i, 6 * i + 6), (v, k) => Math.fround(v - origin[k % 3]) + origin[k % 3]);
    const sameAnswer = (i, hit) => (gpu.column[i] === NO_HIT ? hit.length === 0 : sameVoxel(i, hit));
    const nudged = (i) => {
        if (sameAnswer(i, wasmHit(asSeenByGpu(i)))) return true;
        const s = Array.from(segments.subarray(6 * i, 6 * i + 6));
        for (let axis = 0; axis < 3; axis++) {
            for (const sign of [-1, 1]) {
                const moved = s.slice();
                moved[axis] += sign * NUDGE_M; moved[axis + 3] += sign * NUDGE_M;
                const hit = wasmHit(moved);
                if (sameAnswer(i, hit)) return true;
            }
        }
        return false;
    };
    for (let i = 0; i < count; i++) {
        const nativeBlocked = rust[4 * i] >= 0;
        const gpuBlocked = gpu.column[i] !== NO_HIT;
        if (!nativeBlocked && !gpuBlocked) { bothClear++; continue; }
        const native = nativeBlocked ? [rust[4 * i + 1], rust[4 * i + 2], rust[4 * i + 3]] : [];
        if (nativeBlocked !== gpuBlocked) {
            flips++;
            if (nudged(i)) flipsExplained++; else unexplained.push(i);
            continue;
        }
        bothBlocked++;
        if (gpu.column[i] === native[0] && gpu.row[i] === native[1] && gpu.z[i] === native[2]) {
            worstDt = Math.max(worstDt, Math.abs(gpu.t[i] - rust[4 * i]) * length(i));
        } else {
            otherVoxel++;
            if (nudged(i)) otherVoxelNudged++; else unexplained.push(i);
        }
    }
    console.log(`GPU f32 vs native f64 DDA: both clear ${bothClear}, both blocked ${bothBlocked} (same voxel: largest entry difference ${worstDt.toExponential(2)} m); ` +
        `blocked/clear flips ${flips} (${flipsExplained} are the native answer for the f32-rounded segment or vanish under a ${NUDGE_M * 1000} mm move), different first voxel ${otherVoxel} (${otherVoxelNudged} likewise)`);
    for (const i of unexplained) {
        console.log(`  unexplained segment ${i}: [${Array.from(segments.subarray(6 * i, 6 * i + 6))}] length ${length(i).toFixed(2)} m, ` +
            `native ${JSON.stringify(Array.from(rust.subarray(4 * i, 4 * i + 4)))}, GPU ${JSON.stringify([gpu.t[i], gpu.column[i], gpu.row[i], gpu.z[i]])}`);
    }
    check(unexplained.length === 0, `every GPU/native difference is f32 rounding at a voxel face (unexplained: ${JSON.stringify(unexplained.slice(0, 10))})`);

    // GPU against the exact triangles, same classes as the Rust table
    let trueBlocked = 0, trueClear = 0, falseClear = 0, falseClearGrazing = 0, falseBlocked = 0, falseBlockedGrazing = 0, exactBlocked = 0;
    for (let i = 0; i < count; i++) {
        const truth = exact[i] >= 0;
        const got = gpu.column[i] !== NO_HIT;
        exactBlocked += truth;
        if (got === truth) { if (truth) trueBlocked++; else trueClear++; continue; }
        if (got) { falseBlocked++; falseBlockedGrazing += grazing[i]; } else { falseClear++; falseClearGrazing += grazing[i]; }
    }
    const wrong = falseClear + falseBlocked;
    const wrongFree = wrong - falseClearGrazing - falseBlockedGrazing;
    console.log(`GPU vs exact triangles (${exactBlocked} blocked, ${count - exactBlocked} clear): both blocked ${trueBlocked}, both clear ${trueClear}\n` +
        `  false CLEAR   ${falseClear} (${falseClearGrazing} grazing, ${falseClear - falseClearGrazing} not grazing)\n` +
        `  false BLOCKED ${falseBlocked} (${falseBlockedGrazing} grazing, ${falseBlocked - falseBlockedGrazing} not grazing)\n` +
        `  wrong ${wrong} = ${(100 * wrong / count).toFixed(2)} %, without grazing ${wrongFree} = ${(100 * wrongFree / count).toFixed(2)} %`);
}

await browser.close();
server.close();
if (failures.length) { console.log(`\n${failures.length} check(s) FAILED`); process.exit(1); }
console.log('\nall checks passed');
