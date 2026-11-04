/**
 * GPU-vs-CPU test run on a real WebGPU device (headless Chromium).
 *
 *   node engine/wgsl/test/run.mjs [dataDir]
 *
 * dataDir (default ~/work/wgsl-data) holds the output of make_fixture.py (tris.bin, segs.bin, ref_t.bin,
 * ref_tri.bin, meta.json). Env: PLAYWRIGHT_CORE (playwright-core dir), CHROME (chrome binary),
 * EXPORTED_BVH (optional bvh.bin from the Rust exporter, traced against the same segments).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildBvh, cpuHeatCell, cpuTrace, moller } from './bvh_tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wgslDir = path.resolve(here, '..');
const dataDir = process.argv[2] || path.join(os.homedir(), 'work/wgsl-data');
const playwrightDir = process.env.PLAYWRIGHT_CORE || '/home/seregatipich/cafe-pulse-sync/node_modules/playwright-core';
const chrome = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const CHROME_ARGS = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan,UseSkiaRenderer', '--use-gl=angle', '--use-angle=swiftshader'];
const NO_HIT = 0xffffffff;

const failures = [];
const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`); if (!ok) failures.push(message); };
const readF32 = (name) => { const b = fs.readFileSync(path.join(dataDir, name)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

const triangles = readF32('tris.bin');
const segments = readF32('segs.bin');
const refT = (() => { const b = fs.readFileSync(path.join(dataDir, 'ref_t.bin')); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); })();
const refTri = (() => { const b = fs.readFileSync(path.join(dataDir, 'ref_tri.bin')); return new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4); })();
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json')));
const segmentCount = segments.length / 6;
console.log(`fixture: ${meta.triangles} triangles, ${segmentCount} segments, window ${meta.window}, reference hits ${meta.hits}`);

let t0 = Date.now();
const { buffer: bvhBuffer, order } = buildBvh(triangles);
console.log(`JS exporter built the BVH in ${Date.now() - t0} ms (${new Uint32Array(bvhBuffer, 0, 2)[0]} nodes)`);
const bvhFile = new Uint8Array(bvhBuffer);

// Triangle halves for the multi-chunk test, split on the x median.
const xs = Array.from({ length: triangles.length / 9 }, (_, i) => (triangles[9 * i] + triangles[9 * i + 3] + triangles[9 * i + 6]) / 3);
const sortedX = Float64Array.from(xs).sort();
const median = sortedX[sortedX.length >> 1];
const halves = [[], []];
xs.forEach((x, i) => halves[x < median ? 0 : 1].push(i));
const chunkBuilds = halves.map((ids) => {
    const soup = new Float32Array(ids.length * 9);
    ids.forEach((id, k) => soup.set(triangles.subarray(9 * id, 9 * id + 9), 9 * k));
    const built = buildBvh(soup);
    return { buffer: built.buffer, original: Uint32Array.from(built.order, (k) => ids[k]) };
});

const files = new Map([
    ['/bvh.bin', bvhFile],
    ['/chunk0.bin', new Uint8Array(chunkBuilds[0].buffer)],
    ['/chunk1.bin', new Uint8Array(chunkBuilds[1].buffer)],
]);
if (process.env.EXPORTED_BVH) files.set('/exported.bin', fs.readFileSync(process.env.EXPORTED_BVH));
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
    return { vendor: adapterInfo.vendor, architecture: adapterInfo.architecture, description: adapterInfo.description,
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup };
});
console.log('WebGPU device:', JSON.stringify(device));
check(true, 'real WebGPU adapter acquired in headless Chromium (software Vulkan)');

/** Runs `body` in the page with a tracer built from the named bvh files. */
const inPage = (names, argument, body) => page.evaluate(async ({ names, argument, body }) => {
    const gpuModule = await import('/gpu.mjs');
    const sources = await gpuModule.fetchShaderSources(new URL('/gpu.mjs', location.href));
    const chunks = [];
    for (const n of names) chunks.push(gpuModule.parseBvh(await (await fetch(n)).arrayBuffer()));
    const engine = await gpuModule.BallisticsGpu.create(window.device, sources, chunks);
    const fn = new Function('engine', 'argument', `return (async () => { ${body} })();`);
    const result = await fn(engine, argument);
    engine.destroy();
    return result;
}, { names, argument, body });

// 1. shader compilation: zero messages (BallisticsGpu.create throws otherwise)
const compile = await inPage(['/bvh.bin'], null, 'return engine.compilerMessages.length;');
check(compile === 0, `tint (Chromium WebGPU) compiles trace.wgsl + heatmap.wgsl with ${compile} messages`);

// 2. trace_segments vs reference
const toArray = (a) => Array.from(a);
const gpuRun = await inPage(['/bvh.bin'], toArray(segments), `
    const segs = new Float32Array(argument);
    const r = await engine.traceSegments(segs);
    return { t: Array.from(r.t), tri: Array.from(r.tri), point: Array.from(r.point) };`);
const cpuBvh = (() => { const b = parseBvhNode(bvhBuffer); return b; })();
function parseBvhNode(buf) {
    const [nodeCount, triangleCount] = new Uint32Array(buf, 0, 2);
    return { nodeCount, triangleCount, nodes: new Uint8Array(buf, 8, nodeCount * 32), triangles: new Float32Array(buf, 8 + nodeCount * 32, triangleCount * 12) };
}

function compare(label, hitT, hitTri, mapId) {
    let agree = 0, bothHit = 0, noHitBoth = 0, maxDt = 0, idDiffSameT = 0, idDiffReal = 0;
    const disagreements = [];
    for (let i = 0; i < segmentCount; i++) {
        const refHit = Number.isFinite(refT[i]);
        const hit = hitTri[i] !== NO_HIT;
        if (refHit && hit) {
            bothHit++;
            const len = Math.hypot(segments[6 * i + 3] - segments[6 * i], segments[6 * i + 4] - segments[6 * i + 1], segments[6 * i + 5] - segments[6 * i + 2]);
            const dtM = Math.abs(hitT[i] - refT[i]) * len;
            maxDt = Math.max(maxDt, dtM);
            if (mapId(hitTri[i]) !== refTri[i]) { if (dtM < 1e-3) idDiffSameT++; else idDiffReal++; }
            agree++;
        } else if (!refHit && !hit) { noHitBoth++; agree++; } else disagreements.push({ i, refHit, hit });
    }
    console.log(`${label}: both hit ${bothHit}, both miss ${noHitBoth}, hit/no-hit disagreements ${disagreements.length}, ` +
        `max |dt| ${maxDt.toExponential(2)} m, triangle id differs at equal t (<1 mm) ${idDiffSameT}, at different t ${idDiffReal}`);
    return { disagreements, idDiffReal, maxDt };
}

const toOriginal = (leaf) => order[leaf];
const cpuT = new Float64Array(segmentCount), cpuTri = new Uint32Array(segmentCount);
t0 = Date.now();
for (let i = 0; i < segmentCount; i++) {
    const s = segments.subarray(6 * i, 6 * i + 6);
    const r = cpuTrace(cpuBvh, [s[0], s[1], s[2]], [s[3] - s[0], s[4] - s[1], s[5] - s[2]], 0, 1);
    cpuT[i] = r.t; cpuTri[i] = r.tri;
}
console.log(`float64 JS BVH traversal of ${segmentCount} segments: ${Date.now() - t0} ms`);
const cpuCmp = compare('JS f64 BVH vs python reference', cpuT, cpuTri, toOriginal);
check(cpuCmp.disagreements.length === 0 && cpuCmp.idDiffReal === 0, 'BVH + exporter layout: f64 traversal equals the exact reference');

const gpuCmp = compare('GPU f32 vs python reference', gpuRun.t, Uint32Array.from(gpuRun.tri), toOriginal);
const triOrig = (id) => order[id];
for (const d of gpuCmp.disagreements) {
    const i = d.i;
    const s = segments.subarray(6 * i, 6 * i + 6);
    const o = [s[0], s[1], s[2]], dir = [s[3] - s[0], s[4] - s[1], s[5] - s[2]];
    const len = Math.hypot(...dir);
    const id = d.refHit ? refTri[i] : triOrig(gpuRun.tri[i]);
    const hit = moller(triangles.subarray(9 * id, 9 * id + 9), 0, o, dir, 3);
    d.detail = { segment: i, direction: d.refHit ? 'reference hits, GPU misses' : 'GPU hits, reference misses', tri: id,
        baryMargin: hit.margin, inside: hit.ok, tMarginM: Math.min(hit.t, 1 - hit.t) * len };
}
gpuCmp.disagreements.forEach((d) => console.log('  disagreement', JSON.stringify(d.detail)));
const worst = gpuCmp.disagreements.reduce((m, d) => Math.max(m, Math.abs(d.detail.baryMargin)), 0);
check(gpuCmp.disagreements.length <= Math.ceil(segmentCount * 1e-3) && gpuCmp.idDiffReal === 0,
    `GPU vs reference: ${gpuCmp.disagreements.length} hit/no-hit disagreements of ${segmentCount} (worst barycentric margin ${worst.toExponential(2)}), ${gpuCmp.idDiffReal} wrong triangles`);

// 3. throughput
const timing = await inPage(['/bvh.bin'], toArray(segments), `
    const base = new Float32Array(argument);
    const big = new Float32Array(base.length * 10);
    for (let i = 0; i < 10; i++) big.set(base, i * base.length);
    await engine.traceSegments(big);
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push((await engine.traceSegments(big)).elapsedMs);
    return { segments: big.length / 6, runs };`);
const best = Math.min(...timing.runs);
console.log(`throughput (trace_segments, ${timing.segments} segments, kernel submit->done, runs ms ${timing.runs.map((r) => r.toFixed(0))}): ${(timing.segments / best * 1000).toFixed(0)} segments/s on ${device.architecture} (${device.vendor})`);

// 4. trajectories: parabolic chains, first occluded segment
const trajectories = (() => {
    const n = 1500, chords = 16, out = new Float32Array(n * chords * 6);
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const [x0, y0, size] = meta.window, [lo, hi] = meta.bbox;
    for (let j = 0; j < n; j++) {
        const o = [x0 + rnd() * size, y0 + rnd() * size, lo[2] + (hi[2] - lo[2]) * rnd()];
        const az = rnd() * 2 * Math.PI, el = 0.1 + rnd() * 1.2, v = 30 + rnd() * 40, range = 20 + rnd() * 80;
        let prev = o;
        for (let k = 1; k <= chords; k++) {
            const x = range * k / chords, drop = 9.8 * x * x / (2 * v * v * Math.cos(el) ** 2);
            const p = [o[0] + Math.cos(az) * x, o[1] + Math.sin(az) * x, o[2] + x * Math.tan(el) - drop];
            out.set([...prev, ...p].map(Math.fround), (j * chords + k - 1) * 6);
            prev = p;
        }
    }
    return { n, chords, data: out };
})();
const trajGpu = await inPage(['/bvh.bin'], { data: toArray(trajectories.data), chords: trajectories.chords }, `
    const r = await engine.traceTrajectories(new Float32Array(argument.data), argument.chords, 0.5);
    return { seg: Array.from(r.seg), t: Array.from(r.t), tri: Array.from(r.tri) };`);
let trajMismatch = 0, trajHits = 0;
const trajBad = [];
for (let j = 0; j < trajectories.n; j++) {
    let expected = NO_HIT;
    for (let k = 0; k < trajectories.chords; k++) {
        const s = trajectories.data.subarray((j * trajectories.chords + k) * 6, (j * trajectories.chords + k) * 6 + 6);
        const d = [s[3] - s[0], s[4] - s[1], s[5] - s[2]], len = Math.hypot(...d);
        const tMin = k === 0 ? 0.5 / len : 0, tMax = k === trajectories.chords - 1 ? 1 - 0.5 / len : 1;
        if (cpuTrace(cpuBvh, [s[0], s[1], s[2]], d, tMin, tMax).tri !== NO_HIT) { expected = k; break; }
    }
    if (expected !== NO_HIT) trajHits++;
    if (expected !== trajGpu.seg[j]) { trajMismatch++; trajBad.push({ j, expected, gpu: trajGpu.seg[j] }); }
}
console.log(`trajectories: ${trajectories.n} x ${trajectories.chords} chords, ${trajHits} occluded by the f64 CPU, ${trajMismatch} first-occluded-segment mismatches`, JSON.stringify(trajBad.slice(0, 5)));
check(trajMismatch <= 2 && trajHits > 50, `trace_trajectories matches the f64 first occluded segment (${trajMismatch} mismatches)`);

// 5. two chunks vs one BVH
const chunked = await inPage(['/chunk0.bin', '/chunk1.bin'], toArray(segments), `
    const r = await engine.traceSegments(new Float32Array(argument));
    return { t: Array.from(r.t), tri: Array.from(r.tri) };`);
const base0 = new Uint32Array(chunkBuilds[0].buffer, 0, 2)[1];
const chunkOriginal = (id) => (id < base0 ? chunkBuilds[0].original[id] : chunkBuilds[1].original[id - base0]);
const chunkCmp = compare('GPU 2-chunk (accumulate) vs python reference', chunked.t, Uint32Array.from(chunked.tri), chunkOriginal);
check(chunkCmp.disagreements.length <= gpuCmp.disagreements.length + 2 && chunkCmp.idDiffReal === 0, 'multi-chunk split over two BVHs gives the single-BVH result');

// 6. heatmap vs f64 CPU
const hm = (() => {
    const [x0, y0, size] = meta.window, [lo, hi] = meta.bbox, texel = 2, w = Math.ceil(size / texel) + 1;
    return { x: x0, y: y0, texel, width: w, height: w, zMin: lo[2] - 1, zMax: hi[2] + 1 };
})();
const heat = await inPage(['/bvh.bin'], { hm }, `
    const hm = argument.hm;
    const rays = new Float32Array(hm.width * hm.height * 6);
    for (let r = 0; r < hm.height; r++) for (let c = 0; c < hm.width; c++) {
        const x = hm.x + c * hm.texel, y = hm.y + r * hm.texel;
        rays.set([x, y, hm.zMax, x, y, hm.zMin], (r * hm.width + c) * 6);
    }
    const down = await engine.traceSegments(rays);
    const data = new Uint16Array(hm.width * hm.height);
    for (let i = 0; i < data.length; i++) {
        const z = down.tri[i] === 0xffffffff ? hm.zMin : down.point[3 * i + 2];
        data[i] = Math.round((z - hm.zMin) / (hm.zMax - hm.zMin) * 65535);
    }
    const cx = hm.x + hm.width * hm.texel / 2, cy = hm.y + hm.height * hm.texel / 2;
    const col = Math.floor(hm.width / 2), row = Math.floor(hm.height / 2);
    const tz = hm.zMin + data[row * hm.width + col] * ((hm.zMax - hm.zMin) / 65535) + 1;
    const options = { target: [cx, cy, tz], muzzleHeight: 1.5, grid: { x: hm.x, y: hm.y, cell: 5, width: 28, height: 28 },
        v0: 110, gravity: 9.8 * 1.0, distanceScale: 100, endTrim: 1, probe: 20, chords: 32,
        heightmap: { ...hm, data } };
    const r = await engine.heatmap(options);
    return { options: { ...options, heightmap: { ...hm, data: Array.from(data) } }, cells: Array.from(r.cells), elapsedMs: r.elapsedMs };`);
const hopt = { ...heat.options, heightmap: { ...heat.options.heightmap, data: Uint16Array.from(heat.options.heightmap.data) } };
const candidates = hopt.grid.width * hopt.grid.height;
const states = [0, 0, 0], stateMismatch = [], clearanceDiff = [];
for (let c = 0; c < candidates; c++) {
    const cpu = cpuHeatCell(cpuBvh, hopt, c % hopt.grid.width, Math.floor(c / hopt.grid.width));
    for (let arc = 0; arc < 2; arc++) {
        const g = heat.cells.slice(4 * (2 * c + arc), 4 * (2 * c + arc) + 4);
        states[g[0]]++;
        if (g[0] !== cpu[arc].state) stateMismatch.push({ c, arc, gpu: g[0], cpu: cpu[arc].state });
        else if (g[0] === 0) clearanceDiff.push(Math.abs(g[1] - cpu[arc].clearance));
        if (g[0] === cpu[arc].state && Math.abs(g[2] - cpu[arc].weight) > 1e-4) stateMismatch.push({ c, arc, weight: [g[2], cpu[arc].weight] });
    }
}
const maxClear = clearanceDiff.reduce((m, v) => Math.max(m, v), 0);
console.log(`heatmap: ${candidates} candidates x 2 arcs (clear ${states[0]}, blocked ${states[1]}, unreachable ${states[2]}), ${heat.elapsedMs.toFixed(0)} ms, ` +
    `state mismatches vs f64 CPU ${stateMismatch.length} ${JSON.stringify(stateMismatch.slice(0, 5))}, max clearance diff ${maxClear.toExponential(2)} m`);
check(states[0] > 0 && states[1] > 0 && stateMismatch.length <= Math.ceil(candidates * 2 * 0.01) && maxClear < 0.05,
    'heatmap cells match the f64 CPU mirror (state, clearance, weight)');

// 7. optional: the Rust exporter's file
if (process.env.EXPORTED_BVH) {
    const ex = await inPage(['/exported.bin'], toArray(segments), `
        const r = await engine.traceSegments(new Float32Array(argument));
        return { t: Array.from(r.t), tri: Array.from(r.tri) };`);
    let miss = 0;
    for (let i = 0; i < segmentCount; i++) if ((ex.tri[i] !== NO_HIT) !== Number.isFinite(refT[i])) miss++;
    console.log(`exported bvh.bin: hit/no-hit disagreements vs reference ${miss}`);
}

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
