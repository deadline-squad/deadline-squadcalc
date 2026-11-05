"""Recompute `expected` for chosen segments by testing every triangle whose box meets the segment's box.

    python3 -I recheck_expected.py <tris.bin> <prefix> <indices.txt>

Fixes a `<prefix>.expected.f64` made before make_segments.py used box_tiles (stock reference.py tile sampling
missed 21 of the 100 000 Fallujah segments): the formulas are those of reference.TriangleIndex.hits, only the
candidate set is exhaustive. Rewrites the expected file in place and prints old and new values.
"""
import sys

import numpy as np

tris_path, prefix, indices_path = sys.argv[1:4]
segments = np.fromfile(prefix + ".segments.f64").reshape(-1, 6)
expected = np.fromfile(prefix + ".expected.f64").reshape(-1, 2)
tris = np.memmap(tris_path, dtype="<f4", mode="r").reshape(-1, 3, 3)
for i in (int(x) for x in open(indices_path).read().split()):
    p0, p1 = segments[i, :3], segments[i, 3:]
    low, high = np.minimum(p0, p1) - 1e-3, np.maximum(p0, p1) + 1e-3
    near = []
    for start in range(0, len(tris), 1 << 22):
        chunk = np.asarray(tris[start:start + (1 << 22)])
        near.append(chunk[(chunk.max(1) >= low).all(1) & (chunk.min(1) <= high).all(1)])
    t = np.concatenate(near).astype(np.float64)
    a, e1, e2 = t[:, 0], t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]
    d = p1 - p0
    h = np.cross(d[None, :], e2)
    det = np.einsum("ij,ij->i", e1, h)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = p0[None, :] - a
    u = inv * np.einsum("ij,ij->i", s, h)
    q = np.cross(s, e1)
    v = inv * (q @ d)
    tt = inv * np.einsum("ij,ij->i", e2, q)
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (tt >= 0) & (tt <= 1)
    new = (1.0, tt[hit].min()) if hit.any() else (0.0, np.nan)
    print(f"segment {i}: expected {expected[i].tolist()} -> {list(new)}", flush=True)
    expected[i] = new
expected.tofile(prefix + ".expected.f64")
