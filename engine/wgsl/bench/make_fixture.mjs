/**
 * Cuts the benchmark's BVH out of a triangle soup.
 *
 *   node make_fixture.mjs <tris.bin> <out bvh.bin> [triangles=60000]
 *
 * tris.bin is float32 [n, 9] (the output of ../test/make_fixture.py). The `triangles` triangles whose centroids
 * are nearest (Chebyshev distance in x, y) to the middle of the soup's bounding box are kept, so the result is
 * one square window of real geometry, and indexed with the test-only exporter ../test/bvh_tools.mjs into the
 * engine's bvh.bin layout. 60 000 triangles give about 4.5 MB; pass a larger number for a bigger run.
 */
import fs from 'node:fs';
import { buildBvh } from '../test/bvh_tools.mjs';

const [source, target, count = '60000'] = process.argv.slice(2);
if (!source || !target) throw new Error('usage: make_fixture.mjs <tris.bin> <out bvh.bin> [triangles]');
const file = fs.readFileSync(source);
const soup = new Float32Array(file.buffer, file.byteOffset, file.byteLength / 4);
const total = soup.length / 9;
const wanted = Math.min(Number(count), total);

const centroid = (i, axis) => (soup[9 * i + axis] + soup[9 * i + 3 + axis] + soup[9 * i + 6 + axis]) / 3;
const middle = [0, 1].map((axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < total; i++) { lo = Math.min(lo, centroid(i, axis)); hi = Math.max(hi, centroid(i, axis)); }
    return (lo + hi) / 2;
});
const distance = new Float64Array(total).map((_, i) => Math.max(Math.abs(centroid(i, 0) - middle[0]), Math.abs(centroid(i, 1) - middle[1])));
const nearest = Uint32Array.from({ length: total }, (_, i) => i).sort((a, b) => distance[a] - distance[b]).subarray(0, wanted);

const kept = new Float32Array(wanted * 9);
nearest.forEach((id, k) => kept.set(soup.subarray(9 * id, 9 * id + 9), 9 * k));
const { buffer } = buildBvh(kept);
fs.writeFileSync(target, new Uint8Array(buffer));
console.log(`${wanted} of ${total} triangles, half-width ${distance[nearest[wanted - 1]].toFixed(1)} m, ${buffer.byteLength} bytes -> ${target}`);
