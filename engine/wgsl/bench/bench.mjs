/**
 * Self-contained GPU benchmark of the four ballistics kernels (trace_segments, trace_trajectories, heatmap,
 * voxel_segments) with a sampled correctness check against the float64 CPU mirrors of ../test/bvh_tools.mjs.
 *
 * Browser only, no build step: bench.html imports `runBenchmark`. Fixtures are fetched from ./fixture/ (see README.md).
 */
import {
    BallisticsGpu, NO_HIT, VoxelGpu, fetchShaderSources, fetchVoxelShader, parseBvh, parseVcol, requestDevice,
} from '../gpu.mjs';
import { cpuHeatCell, cpuTrace } from '../test/bvh_tools.mjs';

const SEGMENTS_PER_TRAJECTORY = 16;
const SEGMENT_BYTES = 32;
const HIT_BYTES = 32;
const TRACE_SAMPLE = 2000;
const TRAJECTORY_SAMPLE = 1000;
const HEATMAP_SAMPLE = 150;
const VOXEL_SAMPLE = 5000;
/** Largest tolerated share of sampled items that differ from the f64 mirror (grazing hits, see last-run.txt). */
const TOLERANCE = 0.005;
const Z_COUNT = 4096;

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Deterministic generator (mulberry32) so every machine times the same batches. */
const random = (seed) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Bounding box of a parsed BVH: the root node's box. */
function bounds(bvh) {
    const box = new Float32Array(bvh.nodes.buffer, bvh.nodes.byteOffset, 8);
    return { lo: [box[0], box[1], box[2]], hi: [box[4], box[5], box[6]] };
}

function describeAdapter(adapter) {
    const info = {};
    for (const key of ['vendor', 'architecture', 'device', 'description', 'subgroupMinSize', 'subgroupMaxSize', 'isFallbackAdapter']) {
        if (adapter.info[key] !== undefined) info[key] = adapter.info[key];
    }
    if (info.isFallbackAdapter === undefined && adapter.isFallbackAdapter !== undefined) info.isFallbackAdapter = adapter.isFallbackAdapter;
    const limits = {};
    for (const key in adapter.limits) limits[key] = adapter.limits[key];
    return { info, limits, features: [...adapter.features].sort() };
}

// ---------------------------------------------------------------- batches

function traceBatch(count, box) {
    const next = random(1000 + count);
    const out = new Float32Array(count * 6);
    const span = [0, 1, 2].map((a) => box.hi[a] - box.lo[a]);
    for (let i = 0; i < count; i++) {
        const p0 = [0, 1, 2].map((a) => box.lo[a] - 0.1 * span[a] + next() * 1.2 * span[a]);
        const z = next() * 2 - 1;
        const phi = next() * 2 * Math.PI;
        const r = Math.sqrt(1 - z * z);
        const length = 1 + next() * Math.max(span[0], span[1]);
        out.set([...p0, p0[0] + r * Math.cos(phi) * length, p0[1] + r * Math.sin(phi) * length, p0[2] + z * length], 6 * i);
    }
    return out;
}

/** Parabolic chains of SEGMENTS_PER_TRAJECTORY chords, as the heatmap and the shot preview produce. */
function trajectoryBatch(trajectories, box) {
    const next = random(2000 + trajectories);
    const out = new Float32Array(trajectories * SEGMENTS_PER_TRAJECTORY * 6);
    const span = Math.max(box.hi[0] - box.lo[0], box.hi[1] - box.lo[1]);
    for (let j = 0; j < trajectories; j++) {
        const o = [box.lo[0] + next() * (box.hi[0] - box.lo[0]), box.lo[1] + next() * (box.hi[1] - box.lo[1]), box.lo[2] + next() * (box.hi[2] - box.lo[2])];
        const azimuth = next() * 2 * Math.PI;
        const elevation = 0.1 + next() * 1.2;
        const speed = 30 + next() * 40;
        const range = 0.3 * span + next() * 2 * span;
        let previous = o;
        for (let k = 1; k <= SEGMENTS_PER_TRAJECTORY; k++) {
            const x = range * k / SEGMENTS_PER_TRAJECTORY;
            const drop = 9.8 * x * x / (2 * speed * speed * Math.cos(elevation) ** 2);
            const p = [o[0] + Math.cos(azimuth) * x, o[1] + Math.sin(azimuth) * x, o[2] + x * Math.tan(elevation) - drop];
            out.set([...previous, ...p].map(Math.fround), (j * SEGMENTS_PER_TRAJECTORY + k - 1) * 6);
            previous = p;
        }
    }
    return out;
}

/**
 * Heatmap input: a square grid of about `candidates` positions over three times the BVH's footprint, a ground
 * heightmap sampled from the BVH with vertical rays (`down`: engine.traceSegments), the target in the middle.
 */
async function heatmapOptions(candidates, box, engine) {
    const side = Math.ceil(Math.sqrt(candidates));
    const width = box.hi[0] - box.lo[0];
    const depth = box.hi[1] - box.lo[1];
    const span = 3 * Math.max(width, depth);
    const centre = [(box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2];
    const heightmap = {
        x: centre[0] - span / 2, y: centre[1] - span / 2, texel: span / 128, width: 129, height: 129,
        zMin: box.lo[2] - 1, zMax: box.hi[2] + 1,
    };
    const rays = new Float32Array(heightmap.width * heightmap.height * 6);
    for (let row = 0; row < heightmap.height; row++) {
        for (let column = 0; column < heightmap.width; column++) {
            const x = heightmap.x + column * heightmap.texel;
            const y = heightmap.y + row * heightmap.texel;
            rays.set([x, y, heightmap.zMax, x, y, heightmap.zMin], (row * heightmap.width + column) * 6);
        }
    }
    const down = await engine.traceSegments(rays);
    heightmap.data = new Uint16Array(heightmap.width * heightmap.height);
    for (let i = 0; i < heightmap.data.length; i++) {
        const z = down.tri[i] === NO_HIT ? heightmap.zMin : down.point[3 * i + 2];
        heightmap.data[i] = Math.round((z - heightmap.zMin) / (heightmap.zMax - heightmap.zMin) * 65535);
    }
    const middle = Math.floor(heightmap.width / 2) * heightmap.width + Math.floor(heightmap.width / 2);
    const ground = heightmap.zMin + heightmap.data[middle] * ((heightmap.zMax - heightmap.zMin) / 65535);
    return {
        target: [centre[0], centre[1], ground + 1], muzzleHeight: 1.5,
        grid: { x: centre[0] - span / 2, y: centre[1] - span / 2, cell: span / side, width: side, height: side },
        v0: 110, gravity: 9.8, distanceScale: 100, endTrim: 1, probe: 20, chords: 32, heightmap,
    };
}

/**
 * Segments that start within 40 m sideways and 20 m up or down of an occupied voxel of the file and run 10-150 m
 * in a random direction, so a good share of them is clear (float64, file frame).
 */
function voxelBatch(count, columns) {
    const next = random(3000 + count);
    const { header, ids, first, runs } = columns;
    const out = new Float64Array(count * 6);
    for (let i = 0; i < count; i++) {
        const column = Math.floor(next() * ids.length);
        const run = first[column] + Math.floor(next() * (first[column + 1] - first[column]));
        const voxelZ = runs[2 * run] + next() * (runs[2 * run + 1] - runs[2 * run]);
        const p0 = [
            header.minX + ((ids[column] % header.width) + next()) * header.cell + (next() * 2 - 1) * 40,
            header.minY + (Math.floor(ids[column] / header.width) + next()) * header.cell + (next() * 2 - 1) * 40,
            header.zMin + voxelZ * header.dz + (next() * 2 - 1) * 20,
        ];
        const z = next() * 2 - 1;
        const phi = next() * 2 * Math.PI;
        const r = Math.sqrt(1 - z * z);
        const length = 10 + next() * 140;
        out.set([...p0, p0[0] + r * Math.cos(phi) * length, p0[1] + r * Math.sin(phi) * length, p0[2] + z * length], 6 * i);
    }
    return out;
}

// ---------------------------------------------------------------- float64 voxel mirror of voxel.wgsl

/** Float64 port of voxel.wgsl / VoxelColumns::first_block. Returns {t, column, row, z} or null when clear. */
function cpuVoxelFirstBlock(columns, p0, p1) {
    const { header, ids, first, runs } = columns;
    const unit = [header.cell, header.cell, header.dz];
    const low = [header.minX, header.minY, header.zMin];
    const extent = [header.width, header.height, Z_COUNT];
    const origin = [0, 1, 2].map((a) => (p0[a] - low[a]) / unit[a]);
    const delta = [0, 1, 2].map((a) => (p1[a] - p0[a]) / unit[a]);

    let tStart = 0;
    let tEnd = 1;
    for (let a = 0; a < 3; a++) {
        if (delta[a] === 0) {
            if (origin[a] < 0 || origin[a] >= extent[a]) return null;
            continue;
        }
        const near = -origin[a] / delta[a];
        const far = (extent[a] - origin[a]) / delta[a];
        tStart = Math.max(tStart, Math.min(near, far));
        tEnd = Math.min(tEnd, Math.max(near, far));
    }
    if (tStart > tEnd) return null;

    const cell = [0, 0];
    const step = [0, 0];
    const tNext = [Infinity, Infinity];
    const tStep = [Infinity, Infinity];
    for (let a = 0; a < 2; a++) {
        cell[a] = Math.min(Math.max(Math.floor(origin[a] + delta[a] * tStart), 0), extent[a] - 1);
        if (delta[a] === 0) continue;
        step[a] = delta[a] > 0 ? 1 : -1;
        tNext[a] = (cell[a] + (delta[a] > 0 ? 1 : 0) - origin[a]) / delta[a];
        tStep[a] = 1 / Math.abs(delta[a]);
    }

    const columnIndex = (id) => {
        let lo = 0;
        let hi = ids.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ids[mid] < id) lo = mid + 1; else hi = mid;
        }
        return lo < ids.length && ids[lo] === id ? lo : -1;
    };
    const firstInColumn = (column, tIn, tOut) => {
        const clampZ = (v) => Math.min(Math.max(Math.floor(v), 0), Z_COUNT - 1);
        const atIn = clampZ(origin[2] + delta[2] * tIn);
        const atOut = clampZ(origin[2] + delta[2] * tOut);
        const lowZ = Math.min(atIn, atOut);
        const highZ = Math.max(atIn, atOut);
        if (delta[2] >= 0) {
            for (let r = first[column]; r < first[column + 1]; r++) {
                const start = runs[2 * r];
                const stop = runs[2 * r + 1];
                if (stop > lowZ && start <= highZ) {
                    const z = Math.max(start, lowZ);
                    const t = delta[2] === 0 ? tIn : Math.min(Math.max((z - origin[2]) / delta[2], tIn), tOut);
                    return { z, t };
                }
            }
            return null;
        }
        for (let r = first[column + 1]; r > first[column]; r--) {
            const start = runs[2 * (r - 1)];
            const stop = runs[2 * (r - 1) + 1];
            if (stop > lowZ && start <= highZ) {
                const z = Math.min(stop - 1, highZ);
                return { z, t: Math.min(Math.max((z + 1 - origin[2]) / delta[2], tIn), tOut) };
            }
        }
        return null;
    };

    let tIn = tStart;
    for (let iteration = 0; iteration <= header.width + header.height + 2; iteration++) {
        const tOut = Math.min(tNext[0], tNext[1], tEnd);
        const column = columnIndex(cell[1] * header.width + cell[0]);
        if (column >= 0) {
            const found = firstInColumn(column, tIn, tOut);
            if (found) return { t: found.t, column: cell[0], row: cell[1], z: found.z };
        }
        if (tOut >= tEnd) return null;
        if (tNext[0] <= tOut) { cell[0] += step[0]; tNext[0] += tStep[0]; }
        if (tNext[1] <= tOut) { cell[1] += step[1]; tNext[1] += tStep[1]; }
        if (cell[0] < 0 || cell[1] < 0 || cell[0] >= header.width || cell[1] >= header.height) return null;
        tIn = tOut;
    }
    return null;
}

// ---------------------------------------------------------------- correctness against the f64 mirrors

const verdict = (differing, sample, text) => ({
    sample, differing, passed: differing <= Math.max(2, Math.ceil(TOLERANCE * sample)), detail: text,
});

function checkTrace(bvh, segments, result) {
    const sample = Math.min(TRACE_SAMPLE, segments.length / 6);
    let bothHit = 0, bothMiss = 0, hitMismatch = 0, tieOtherTriangle = 0, otherTriangleAtOtherT = 0, maxDt = 0;
    for (let i = 0; i < sample; i++) {
        const s = segments.subarray(6 * i, 6 * i + 6);
        const d = [s[3] - s[0], s[4] - s[1], s[5] - s[2]];
        const cpu = cpuTrace(bvh, [s[0], s[1], s[2]], d, 0, 1);
        const cpuHit = cpu.tri !== NO_HIT;
        const gpuHit = result.tri[i] !== NO_HIT;
        if (cpuHit !== gpuHit) { hitMismatch++; continue; }
        if (!cpuHit) { bothMiss++; continue; }
        bothHit++;
        const metres = Math.abs(result.t[i] - cpu.t) * Math.hypot(...d);
        maxDt = Math.max(maxDt, metres);
        if (result.tri[i] !== cpu.tri) { if (metres < 1e-3) tieOtherTriangle++; else otherTriangleAtOtherT++; }
    }
    return verdict(hitMismatch + otherTriangleAtOtherT, sample,
        `both hit ${bothHit}, both miss ${bothMiss}, hit/miss disagreements ${hitMismatch}, other triangle at equal t (<1 mm) ${tieOtherTriangle}, ` +
        `other triangle at other t ${otherTriangleAtOtherT}, max |dt| ${maxDt.toExponential(2)} m`);
}

function checkTrajectories(bvh, segments, result, trajectories) {
    const sample = Math.min(TRAJECTORY_SAMPLE, trajectories);
    let occluded = 0, mismatches = 0;
    for (let j = 0; j < sample; j++) {
        let expected = NO_HIT;
        for (let k = 0; k < SEGMENTS_PER_TRAJECTORY; k++) {
            const s = segments.subarray((j * SEGMENTS_PER_TRAJECTORY + k) * 6, (j * SEGMENTS_PER_TRAJECTORY + k) * 6 + 6);
            const d = [s[3] - s[0], s[4] - s[1], s[5] - s[2]];
            const length = Math.hypot(...d);
            const tMin = k === 0 ? 0.5 / length : 0;
            const tMax = k === SEGMENTS_PER_TRAJECTORY - 1 ? 1 - 0.5 / length : 1;
            if (cpuTrace(bvh, [s[0], s[1], s[2]], d, tMin, tMax).tri !== NO_HIT) { expected = k; break; }
        }
        if (expected !== NO_HIT) occluded++;
        if (expected !== result.seg[j]) mismatches++;
    }
    return verdict(mismatches, sample, `${sample} trajectories, ${occluded} occluded by the f64 CPU, first-occluded-segment mismatches ${mismatches}`);
}

function checkHeatmap(bvh, options, result) {
    const candidates = options.grid.width * options.grid.height;
    const next = random(4000 + candidates);
    const sample = Math.min(HEATMAP_SAMPLE, candidates);
    const states = [0, 0, 0];
    let mismatches = 0, maxClearance = 0;
    for (let n = 0; n < sample; n++) {
        const c = Math.floor(next() * candidates);
        const cpu = cpuHeatCell(bvh, options, c % options.grid.width, Math.floor(c / options.grid.width));
        for (let arc = 0; arc < 2; arc++) {
            const g = result.cells.subarray(4 * (2 * c + arc), 4 * (2 * c + arc) + 4);
            states[g[0]]++;
            if (g[0] !== cpu[arc].state) mismatches++;
            else if (g[0] === 0) maxClearance = Math.max(maxClearance, Math.abs(g[1] - cpu[arc].clearance));
        }
    }
    const outcome = verdict(mismatches, 2 * sample, `${sample} candidates x 2 arcs (clear ${states[0]}, blocked ${states[1]}, unreachable ${states[2]}), ` +
        `state mismatches ${mismatches}, max clearance difference ${maxClearance.toExponential(2)} m`);
    outcome.passed = outcome.passed && maxClearance < 0.05;
    return outcome;
}

function checkVoxel(columns, segments, result) {
    const sample = Math.min(VOXEL_SAMPLE, segments.length / 6);
    const { header } = columns;
    const origin = [header.minX, header.minY, header.zMin];
    const asSeenByGpu = (s) => Array.from(s, (v, k) => Math.fround(v - origin[k % 3]) + origin[k % 3]);
    let bothClear = 0, bothBlocked = 0, otherVoxel = 0, flips = 0, explained = 0, maxDt = 0;
    for (let i = 0; i < sample; i++) {
        const s = Array.from(segments.subarray(6 * i, 6 * i + 6));
        const cpu = cpuVoxelFirstBlock(columns, s.slice(0, 3), s.slice(3));
        const gpuBlocked = result.column[i] !== NO_HIT;
        const same = (c) => (c === null ? !gpuBlocked : gpuBlocked && c.column === result.column[i] && c.row === result.row[i] && c.z === result.z[i]);
        if (same(cpu)) {
            if (cpu === null) bothClear++; else {
                bothBlocked++;
                maxDt = Math.max(maxDt, Math.abs(cpu.t - result.t[i]) * Math.hypot(s[3] - s[0], s[4] - s[1], s[5] - s[2]));
            }
            continue;
        }
        if ((cpu !== null) !== gpuBlocked) flips++; else otherVoxel++;
        // f32 rounding of the segment alone explains the difference when the mirror on the rounded segment agrees
        const rounded = asSeenByGpu(s);
        if (same(cpuVoxelFirstBlock(columns, rounded.slice(0, 3), rounded.slice(3)))) explained++;
    }
    const differing = flips + otherVoxel;
    const outcome = verdict(differing - explained, sample,
        `both clear ${bothClear}, both blocked in the same voxel ${bothBlocked} (max entry difference ${maxDt.toExponential(2)} m), ` +
        `blocked/clear flips ${flips}, other first voxel ${otherVoxel}, of those explained by f32 rounding of the segment ${explained}`);
    return outcome;
}

// ---------------------------------------------------------------- measuring

/**
 * One kernel at one size: a warm-up run (also the one that is checked), then up to `runs` timed runs while the
 * time budget lasts.
 * @returns {Promise<Object>} a result row
 */
async function measure({ kernel, unit, size, extra, call, check, runs, budgetMs, log }) {
    const warm = await call();
    const warmMs = warm.elapsedMs;
    const correctness = check(warm);
    const wall = [];
    const gpu = [];
    const affordable = Math.max(0, Math.min(runs, Math.floor(budgetMs / Math.max(warmMs, 1e-3)) - 1));
    for (let i = 0; i < affordable; i++) {
        await pause();
        const r = await call();
        wall.push(r.elapsedMs);
        if (r.gpuMs !== null) gpu.push(r.gpuMs);
    }
    const usable = gpu.length === wall.length && gpu.length > 0 && median(gpu) > 0;
    const samples = wall.length ? (usable ? gpu : wall) : [warmMs];
    const primary = median(samples);
    const row = {
        kernel, unit, size, ...extra,
        timer: usable ? 'timestamp-query' : 'performance.now (submit to onSubmittedWorkDone)',
        timedRuns: wall.length, warmUpWallMs: warmMs,
        medianMs: primary, minMs: Math.min(...samples), maxMs: Math.max(...samples),
        medianWallMs: wall.length ? median(wall) : warmMs,
        medianGpuMs: usable ? median(gpu) : null,
        itemsPerSecond: size / (primary / 1000),
        correctness,
    };
    if (!wall.length) row.note = `no timed run fitted the budget: the warm-up run alone took ${warmMs.toFixed(0)} ms and its time is reported`;
    log(`${kernel} ${size} ${unit}: median ${primary.toFixed(2)} ms over ${wall.length} runs [${row.timer}], ${Math.round(row.itemsPerSecond).toLocaleString('en-US')} ${unit}/s, ` +
        `check ${correctness.passed ? 'PASS' : 'FAIL'} (${correctness.detail})`);
    return row;
}

/**
 * Runs one kernel over increasing sizes; a size whose projected single run exceeds the budget is skipped, as is
 * one that does not fit the device's buffer limits.
 */
async function sweep({ kernel, unit, sizes, bytesPerItem, limits, make, runs, budgetMs, log, rows, skipped }) {
    let last = null;
    for (const size of [...sizes].sort((a, b) => a - b)) {
        const need = size * bytesPerItem;
        if (need > limits.maxStorageBufferBindingSize || need > limits.maxBufferSize) {
            skipped.push({ kernel, size, reason: `needs ${need} bytes in one buffer, device limit ${Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize)}` });
            log(`${kernel} ${size}: skipped, does not fit the device's buffer limits`);
            continue;
        }
        if (last && last.wallMs * size / last.size > budgetMs) {
            const projected = last.wallMs * size / last.size;
            skipped.push({ kernel, size, reason: `projected ${(projected / 1000).toFixed(0)} s per run, over the ${budgetMs / 1000} s budget` });
            log(`${kernel} ${size}: skipped, projected ${(projected / 1000).toFixed(0)} s per run exceeds the ${budgetMs / 1000} s budget`);
            continue;
        }
        await pause();
        const row = await measure({ kernel, unit, size, runs, budgetMs, log, ...(await make(size)) });
        rows.push(row);
        last = { size, wallMs: row.warmUpWallMs };
    }
}

const fixtureBytes = async (name) => {
    const response = await fetch(new URL(`./fixture/${name}`, import.meta.url));
    if (!response.ok) throw new Error(`cannot fetch fixture/${name} (${response.status}): serve engine/wgsl over http, see bench/README.md`);
    return response.arrayBuffer();
};

const table = (rows) => {
    const header = '| kernel | size | unit | timed runs | median ms | min-max ms | per second | timer | f64 check |\n|---|---:|---|---:|---:|---|---:|---|---|';
    const lines = rows.map((r) => `| ${r.kernel} | ${r.size.toLocaleString('en-US')} | ${r.unit} | ${r.timedRuns} | ${r.medianMs.toFixed(2)} | ` +
        `${r.minMs.toFixed(2)}-${r.maxMs.toFixed(2)} | ${Math.round(r.itemsPerSecond).toLocaleString('en-US')} | ` +
        `${r.timer === 'timestamp-query' ? 'GPU timestamps' : 'wall clock'} | ${r.correctness.passed ? 'PASS' : 'FAIL'} ` +
        `(${r.correctness.differing}/${r.correctness.sample}) |`);
    return [header, ...lines].join('\n');
};

/**
 * Runs the whole benchmark.
 * @param {Object} options
 * @param {number[]} options.sizes - segments per batch for trace_segments, trace_trajectories (total chords, 16 per
 *   trajectory) and voxel_segments
 * @param {number[]} options.heatmapSizes - candidate firing positions per heatmap batch (each is 2 arcs x 32 chords)
 * @param {number} options.runs - timed runs per size after one warm-up; the median is reported
 * @param {number} options.budgetSeconds - largest tolerated time for all runs of one size; larger sizes are skipped
 * @param {boolean} options.highPerformance - ask for the high-performance adapter (the discrete GPU of a laptop)
 * @param {(line: string) => void} log
 * @returns {Promise<{report: Object, markdown: string}>}
 * @throws {Error} if WebGPU is unavailable or a shader does not compile
 */
export async function runBenchmark(options, log) {
    const { sizes, heatmapSizes, runs, budgetSeconds, highPerformance } = options;
    const budgetMs = budgetSeconds * 1000;
    if (!navigator.gpu) throw new Error('navigator.gpu is missing: use Chrome or Edge 113+ over http://localhost or https');
    const started = new Date();
    const { device, adapter } = await requestDevice(navigator.gpu, highPerformance ? { powerPreference: 'high-performance' } : {});
    const adapterReport = describeAdapter(adapter);
    const timestamps = device.features.has('timestamp-query');
    const limits = device.limits;
    log(`Adapter: ${JSON.stringify(adapterReport.info)}`);
    log(`maxStorageBufferBindingSize ${limits.maxStorageBufferBindingSize}, maxComputeWorkgroupStorageSize ${limits.maxComputeWorkgroupStorageSize}, ` +
        `maxBufferSize ${limits.maxBufferSize}, maxComputeInvocationsPerWorkgroup ${limits.maxComputeInvocationsPerWorkgroup}`);
    log(`Timer: ${timestamps ? 'GPU timestamp queries (timestamp-query); the wall clock is reported next to it' : 'timestamp-query not available, falling back to performance.now around queue.onSubmittedWorkDone'}`);
    if (adapterReport.info.isFallbackAdapter || adapterReport.info.architecture === 'swiftshader') log('WARNING: this is a software (CPU) adapter, not a GPU. The numbers measure a CPU.');

    const bvhFile = await fixtureBytes('bvh.bin');
    const bvh = parseBvh(bvhFile);
    const box = bounds(bvh);
    const columns = await parseVcol(await fixtureBytes('jensen.vcol'));
    log(`Fixtures: BVH ${bvh.triangleCount} triangles, ${bvh.nodeCount} nodes, ${bvhFile.byteLength} bytes; Jensen voxels ${columns.ids.length} columns, ${columns.runs.length / 2} runs`);

    const engine = await BallisticsGpu.create(device, await fetchShaderSources(new URL('../gpu.mjs', import.meta.url)), [bvh]);
    const voxels = await VoxelGpu.create(device, await fetchVoxelShader(new URL('../gpu.mjs', import.meta.url)), columns);
    log('Shaders compiled with 0 messages');

    const rows = [];
    const skipped = [];
    const shared = { limits, runs, budgetMs, log, rows, skipped };

    await sweep({ ...shared, kernel: 'trace_segments', unit: 'segments', sizes, bytesPerItem: SEGMENT_BYTES, make: async (size) => {
        const segments = traceBatch(size, box);
        return { call: () => engine.traceSegments(segments), check: (r) => checkTrace(bvh, segments, r) };
    } });

    await sweep({ ...shared, kernel: 'trace_trajectories', unit: 'segments', sizes, bytesPerItem: SEGMENT_BYTES, make: async (size) => {
        const trajectories = Math.floor(size / SEGMENTS_PER_TRAJECTORY);
        const segments = trajectoryBatch(trajectories, box);
        return {
            extra: { trajectories, segmentsPerTrajectory: SEGMENTS_PER_TRAJECTORY },
            call: () => engine.traceTrajectories(segments, SEGMENTS_PER_TRAJECTORY, 0.5),
            check: (r) => checkTrajectories(bvh, segments, r, trajectories),
        };
    } });

    await sweep({ ...shared, kernel: 'heatmap', unit: 'candidates', sizes: heatmapSizes, bytesPerItem: 32, make: async (size) => {
        const heat = await heatmapOptions(size, box, engine);
        return {
            extra: { grid: `${heat.grid.width}x${heat.grid.height}`, chords: heat.chords },
            call: () => engine.heatmap(heat),
            check: (r) => checkHeatmap(bvh, heat, r),
        };
    } });

    await sweep({ ...shared, kernel: 'voxel_segments', unit: 'segments', sizes, bytesPerItem: SEGMENT_BYTES, make: async (size) => {
        const segments = voxelBatch(size, columns);
        return { call: () => voxels.traceSegments(segments), check: (r) => checkVoxel(columns, segments, r) };
    } });

    engine.destroy();
    voxels.destroy();
    const report = {
        benchmark: 'squadcalc engine/wgsl/bench v1',
        started: started.toISOString(),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        adapter: adapterReport,
        timer: timestamps ? 'timestamp-query' : 'performance.now (submit to onSubmittedWorkDone)',
        settings: { sizes, heatmapSizes, runs, budgetSeconds, highPerformance },
        fixtures: { triangles: bvh.triangleCount, bvhNodes: bvh.nodeCount, voxelColumns: columns.ids.length, voxelRuns: columns.runs.length / 2 },
        results: rows,
        skipped,
        allChecksPassed: rows.every((r) => r.correctness.passed),
    };
    const markdown = `${table(rows)}\n\nAdapter: ${adapterReport.info.vendor} / ${adapterReport.info.architecture} / ${adapterReport.info.device || adapterReport.info.description || 'n/a'}; ` +
        `timer: ${report.timer}; maxStorageBufferBindingSize ${limits.maxStorageBufferBindingSize}; maxComputeWorkgroupStorageSize ${limits.maxComputeWorkgroupStorageSize}` +
        (skipped.length ? `\n\nSkipped: ${skipped.map((s) => `${s.kernel} ${s.size} (${s.reason})`).join('; ')}` : '');
    log(`Done in ${((Date.now() - started) / 1000).toFixed(0)} s, all checks ${report.allChecksPassed ? 'passed' : 'NOT passed'}.`);
    return { report, markdown };
}
