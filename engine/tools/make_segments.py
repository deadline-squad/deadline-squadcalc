"""Random segments over the collision triangles of a map and the first hit of each, from the exact reference
tracer of tools/volumetric/py/reference.py (float64 Moller-Trumbore on the triangles themselves).

    python3 -I make_segments.py <volumetric py dir> <tris.bin> <out prefix> [--count 100000] [--seed 1]

`tris.bin` is the output of npz_to_bin.py (all triangles block the Projectile channel there). The reference
indexes a whole map too slowly and with too much memory, so the map is cut into horizontal strips; the
triangles whose box overlaps a strip are indexed and the segments that lie entirely inside the strip are
traced on them, which is exact: every triangle a segment can meet overlaps the strip. Strips run on a pool of
processes.

Segments: 70 % start within 6 m of a random triangle (dense hits, grazing cases), 30 % anywhere in the strip;
lengths 70 % 3-60 m, 25 % 60-200 m, 5 % 200-500 m; half are pure random directions, half within 20 degrees of
the horizontal.

Writes `<prefix>.segments.f64` (count x 6 little-endian float64: p0 xyz, p1 xyz) and `<prefix>.expected.f64`
(count x 2: hit 0/1, t of the first hit or NaN), both in the same order.
"""
import argparse
import multiprocessing
import sys

import numpy as np

STRIPS = 16
PAD = 600.0
BIT = 2


def box_tiles(index, tile_m, p0, p1):
    """Every tile of the segment's bounding box, a superset of the tiles the segment crosses.

    The stock `TriangleIndex.tiles_on` samples the segment every tile_m / 4 and misses tiles it only clips at a
    corner (21 of 100 000 random segments on Fallujah lose or misplace their first hit); the Moller-Trumbore test
    still decides, so extra tiles cost time and nothing else.
    """
    origin = np.array([index.min_x, index.min_y])
    limit = np.array([index.nx - 1, index.ny - 1])
    low = np.clip(((np.minimum(p0[:2], p1[:2]) - origin) // tile_m).astype(np.int64), 0, limit)
    high = np.clip(((np.maximum(p0[:2], p1[:2]) - origin) // tile_m).astype(np.int64), 0, limit)
    xs, ys = np.meshgrid(np.arange(low[0], high[0] + 1), np.arange(low[1], high[1] + 1))
    return (ys * index.nx + xs).ravel()


def select_strip(path, y0, y1):
    """Triangles of the file whose box overlaps y0..y1 (chunked pass over a memmap)."""
    tris = np.memmap(path, dtype="<f4", mode="r").reshape(-1, 3, 3)
    parts = []
    for start in range(0, len(tris), 1 << 22):
        chunk = np.asarray(tris[start:start + (1 << 22)])
        ys = chunk[:, :, 1]
        keep = (ys.max(axis=1) >= y0) & (ys.min(axis=1) <= y1)
        parts.append(chunk[keep])
    return np.concatenate(parts)


def make_strip(args):
    py_dir, path, strip, y_lo, y_hi, x_lo, x_hi, count, seed = args
    sys.path.insert(0, py_dir)
    from reference import TILE_M, TriangleIndex

    y0 = y_lo + (y_hi - y_lo) * strip / STRIPS
    y1 = y_lo + (y_hi - y_lo) * (strip + 1) / STRIPS
    tris = select_strip(path, y0, y1)
    z_lo, z_hi = np.percentile(tris[:, :, 2], [1, 99])
    rng = np.random.default_rng(seed * 1000 + strip)
    mask = np.full(len(tris), BIT, np.uint8)
    index = TriangleIndex(tris, mask, x_lo, y_lo, x_hi - x_lo, y_hi - y_lo)
    index.tiles_on = lambda a, b: box_tiles(index, TILE_M, a, b)

    segments = np.empty((count, 6))
    expected = np.full((count, 2), np.nan)
    expected[:, 0] = 0
    made = 0
    while made < count:
        if rng.random() < 0.7:
            centre = tris[rng.integers(len(tris))].mean(axis=0)
            p0 = centre + rng.normal(0, 3.0, 3)
        else:
            p0 = np.array([rng.uniform(x_lo, x_hi), rng.uniform(y0, y1), rng.uniform(z_lo, z_hi)])
        length = rng.choice([rng.uniform(3, 60), rng.uniform(60, 200), rng.uniform(200, 500)], p=[0.7, 0.25, 0.05])
        if rng.random() < 0.5:
            direction = rng.normal(size=3)
        else:
            elevation = np.radians(rng.uniform(-20, 20))
            azimuth = rng.uniform(0, 2 * np.pi)
            direction = [np.cos(elevation) * np.sin(azimuth), np.cos(elevation) * np.cos(azimuth), np.sin(elevation)]
        direction = np.asarray(direction) / np.linalg.norm(direction)
        p1 = p0 + length * direction
        if not (y0 <= p0[1] <= y1 and y0 <= p1[1] <= y1 and x_lo <= p0[0] <= x_hi and x_lo <= p1[0] <= x_hi):
            continue
        t, ids, _ = index.hits(p0, p1, BIT)
        segments[made] = np.concatenate([p0, p1])
        if len(t):
            expected[made] = (1, t[0])
        made += 1
    return strip, segments, expected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("py_dir")
    parser.add_argument("tris")
    parser.add_argument("prefix")
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    tris = np.memmap(args.tris, dtype="<f4", mode="r").reshape(-1, 3, 3)
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for start in range(0, len(tris), 1 << 22):
        chunk = np.asarray(tris[start:start + (1 << 22)]).reshape(-1, 3)
        lo = np.minimum(lo, chunk.min(axis=0))
        hi = np.maximum(hi, chunk.max(axis=0))
    print("triangles", len(tris), "bounds", lo, hi, file=sys.stderr)
    # The world of a map is about 3 km square; far outliers (stray meshes) would stretch the strips
    x_lo, y_lo, x_hi, y_hi = float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1])

    per = [args.count // STRIPS + (1 if s < args.count % STRIPS else 0) for s in range(STRIPS)]
    jobs = [(args.py_dir, args.tris, s, y_lo, y_hi, x_lo, x_hi, per[s], args.seed) for s in range(STRIPS)]
    with multiprocessing.get_context("spawn").Pool(args.workers) as pool:
        results = sorted(pool.imap_unordered(make_strip, jobs), key=lambda r: r[0])
    segments = np.concatenate([r[1] for r in results])
    expected = np.concatenate([r[2] for r in results])
    segments.astype("<f8").tofile(args.prefix + ".segments.f64")
    expected.astype("<f8").tofile(args.prefix + ".expected.f64")
    print(f"{len(segments)} segments, {int(expected[:, 0].sum())} hit", file=sys.stderr)


if __name__ == "__main__":
    main()
