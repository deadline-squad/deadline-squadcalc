/**
 * Test-only helpers: a median-split BVH exporter producing the engine's bvh.bin layout, and float64 CPU
 * versions of the traversal and of the heatmap cell, used to judge the GPU results. Not part of the product.
 */

const LEAF_SIZE = 4;
const END = 0xffffffff;

function subtreeNodes(n) {
    if (n <= LEAF_SIZE) return 1;
    const left = n >> 1;
    return 1 + subtreeNodes(left) + subtreeNodes(n - left);
}

/**
 * Builds a BVH over a triangle soup.
 * @param {Float32Array} tris - 9 floats per triangle
 * @returns {{buffer: ArrayBuffer, order: Uint32Array}} bvh.bin contents and, per leaf-order triangle, its index in `tris`
 */
export function buildBvh(tris) {
    const n = tris.length / 9;
    const centroid = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
            centroid[3 * i + a] = (tris[9 * i + a] + tris[9 * i + 3 + a] + tris[9 * i + 6 + a]) / 3;
        }
    }
    const order = new Uint32Array(n).map((_, i) => i);
    const nodeCount = subtreeNodes(n);
    const buffer = new ArrayBuffer(8 + nodeCount * 32 + n * 48);
    const header = new Uint32Array(buffer, 0, 2);
    header[0] = nodeCount;
    header[1] = n;
    const f32 = new Float32Array(buffer, 8, nodeCount * 8);
    const u32 = new Uint32Array(buffer, 8, nodeCount * 8);
    let next = 0;

    const select = (lo, hi, k, axis) => {
        let l = lo;
        let r = hi - 1;
        while (l < r) {
            const pivot = centroid[3 * order[(l + r) >> 1] + axis];
            let i = l;
            let j = r;
            while (i <= j) {
                while (centroid[3 * order[i] + axis] < pivot) i++;
                while (centroid[3 * order[j] + axis] > pivot) j--;
                if (i <= j) {
                    const t = order[i]; order[i] = order[j]; order[j] = t;
                    i++; j--;
                }
            }
            if (k <= j) r = j;
            else if (k >= i) l = i;
            else return;
        }
    };

    const build = (lo, hi, escape) => {
        const index = next++;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        const cmin = [Infinity, Infinity, Infinity];
        const cmax = [-Infinity, -Infinity, -Infinity];
        for (let i = lo; i < hi; i++) {
            const t = order[i];
            for (let v = 0; v < 3; v++) {
                for (let a = 0; a < 3; a++) {
                    const c = tris[9 * t + 3 * v + a];
                    if (c < min[a]) min[a] = c;
                    if (c > max[a]) max[a] = c;
                }
            }
            for (let a = 0; a < 3; a++) {
                const c = centroid[3 * t + a];
                if (c < cmin[a]) cmin[a] = c;
                if (c > cmax[a]) cmax[a] = c;
            }
        }
        const o = index * 8;
        f32.set(min, o);
        f32.set(max, o + 4);
        u32[o + 3] = escape;
        if (hi - lo <= LEAF_SIZE) {
            u32[o + 7] = (lo << 8) | (hi - lo);
            return;
        }
        u32[o + 7] = 0;
        let axis = 0;
        for (let a = 1; a < 3; a++) if (cmax[a] - cmin[a] > cmax[axis] - cmin[axis]) axis = a;
        const mid = lo + ((hi - lo) >> 1);
        select(lo, hi, mid, axis);
        const rightIndex = index + 1 + subtreeNodes(mid - lo);
        build(lo, mid, rightIndex);
        build(mid, hi, escape);
    };
    build(0, n, END);

    const out = new Float32Array(buffer, 8 + nodeCount * 32, n * 12);
    for (let i = 0; i < n; i++) {
        const t = order[i];
        for (let v = 0; v < 3; v++) out.set(tris.subarray(9 * t + 3 * v, 9 * t + 3 * v + 3), 12 * i + 4 * v);
    }
    return { buffer, order };
}

/** Float64 stackless traversal of bvh.bin contents; same semantics as trace_closest (box pad excluded). */
export function cpuTrace(bvh, o, d, tMin, tMax) {
    const { nodeCount, nodes, triangles } = bvh;
    const f = new Float32Array(nodes.buffer, nodes.byteOffset, nodeCount * 8);
    const u = new Uint32Array(nodes.buffer, nodes.byteOffset, nodeCount * 8);
    let bestT = tMax;
    let bestTri = END;
    let i = 0;
    while (i !== END) {
        const b = i * 8;
        let enter = tMin;
        let leave = bestT;
        for (let a = 0; a < 3; a++) {
            const lo = f[b + a];
            const hi = f[b + 4 + a];
            if (d[a] === 0) {
                if (o[a] < lo || o[a] > hi) { leave = -Infinity; break; }
                continue;
            }
            const t0 = (lo - o[a]) / d[a];
            const t1 = (hi - o[a]) / d[a];
            enter = Math.max(enter, Math.min(t0, t1));
            leave = Math.min(leave, Math.max(t0, t1));
        }
        if (enter > leave) { i = u[b + 3]; continue; }
        const leaf = u[b + 7];
        if (leaf === 0) { i += 1; continue; }
        const first = leaf >>> 8;
        for (let k = 0; k < (leaf & 255); k++) {
            const t = first + k;
            const hit = moller(triangles, 12 * t, o, d);
            if (hit && hit.t >= tMin && hit.t <= bestT) { bestT = hit.t; bestTri = t; }
        }
        i = u[b + 3];
    }
    return { t: bestT, tri: bestTri };
}

/** Float64 Moller-Trumbore on the triangle at `at` in a float array (xyz, pad per vertex); barycentrics included. */
export function moller(tri, at, o, d, stride = 4) {
    const a = [tri[at], tri[at + 1], tri[at + 2]];
    const e1 = [tri[at + stride] - a[0], tri[at + stride + 1] - a[1], tri[at + stride + 2] - a[2]];
    const e2 = [tri[at + 2 * stride] - a[0], tri[at + 2 * stride + 1] - a[1], tri[at + 2 * stride + 2] - a[2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) <= 1e-12) return null;
    const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    const ok = u >= 0 && v >= 0 && u + v <= 1 && t >= 0 && t <= 1;
    return { t, u, v, ok, margin: Math.min(u, v, 1 - u - v) };
}

function sampleHeightmap(h, x, y) {
    const texel = (px, py) => {
        const cx = Math.min(Math.max(px, 0), h.width - 1);
        const cy = Math.min(Math.max(py, 0), h.height - 1);
        return h.zMin + h.data[cy * h.width + cx] * ((h.zMax - h.zMin) / 65535);
    };
    const tx = (x - h.x) / h.texel;
    const ty = (y - h.y) / h.texel;
    const bx = Math.floor(tx);
    const by = Math.floor(ty);
    const fx = tx - bx;
    const fy = ty - by;
    const top = texel(bx, by) * (1 - fx) + texel(bx + 1, by) * fx;
    const bottom = texel(bx, by + 1) * (1 - fx) + texel(bx + 1, by + 1) * fx;
    return top * (1 - fy) + bottom * fy;
}

/** Float64 mirror of heatmap.wgsl for one candidate: returns [low arc, high arc] cells {state, clearance, weight, fraction}. */
export function cpuHeatCell(bvh, o, column, row) {
    const { target, muzzleHeight, grid, v0, gravity: g, heightmap } = o;
    const { distanceScale = 500, endTrim = 1, probe = 20, chords = 32 } = o;
    const x = grid.x + (column + 0.5) * grid.cell;
    const y = grid.y + (row + 0.5) * grid.cell;
    const muzzle = [x, y, sampleHeightmap(heightmap, x, y) + muzzleHeight];
    const dx = target[0] - x;
    const dy = target[1] - y;
    const range = Math.hypot(dx, dy);
    const unreachable = { state: 2, clearance: 0, weight: 0, fraction: 0 };
    if (range < 1e-3) return [unreachable, unreachable];
    const weight = distanceScale / (distanceScale + range);
    const v2 = v0 * v0;
    const rise = target[2] - muzzle[2];
    const disc = v2 * v2 - g * (g * range * range + 2 * rise * v2);
    if (disc < 0) return [unreachable, unreachable];
    const root = Math.sqrt(disc);
    return [(v2 - root) / (g * range), (v2 + root) / (g * range)].map((tan) => {
        const drop = g * (1 + tan * tan) / (2 * v2);
        let previous = muzzle;
        let clearance = probe;
        for (let k = 1; k <= chords; k++) {
            const s = range * k / chords;
            const point = [x + dx / range * s, y + dy / range * s, muzzle[2] + s * tan - drop * s * s];
            const d = [point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]];
            const len = Math.hypot(...d);
            const tMin = k === 1 ? endTrim / len : 0;
            const tMax = k === chords ? 1 - endTrim / len : 1;
            if (tMin < tMax) {
                const hit = cpuTrace(bvh, previous, d, tMin, tMax);
                if (hit.tri !== END) return { state: 1, clearance: 0, weight, fraction: (k - 1 + hit.t) / chords };
            }
            if (k < chords) {
                const below = cpuTrace(bvh, point, [0, 0, -probe], 0, 1);
                if (below.tri !== END) clearance = Math.min(clearance, below.t * probe);
            }
            previous = point;
        }
        return { state: 0, clearance, weight, fraction: 1 };
    });
}
