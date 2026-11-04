"""Builds the GPU-vs-CPU test fixture from the Fallujah collision triangles (run with `python3 -I`).

Usage: make_fixture.py <fallujah_tris.npz> <reference.py dir> <out dir> [segments] [window_m] [mask_bit]

Cuts the densest window_m x window_m square out of the triangle soup, writes it as raw float32, draws random
segments around its geometry and traces them with the exact float64 reference (reference.py). Outputs:
  tris.bin    float32 [n, 9]            window triangles (original order)
  segs.bin    float32 [m, 6]            p0.xyz p1.xyz
  ref.bin     float64 [m, 2] + int32 [m, 2]  per segment: first-hit t (NaN if none), then hit flag + triangle id
  meta.json
"""
import json
import sys

import numpy as np

npz, ref_dir, out, n_seg, window, bit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 20000, float(sys.argv[5]) if len(sys.argv) > 5 else 300.0, int(sys.argv[6]) if len(sys.argv) > 6 else 1
sys.path.insert(0, ref_dir)
from reference import TriangleIndex  # noqa: E402

z = np.load(npz)
tris, mask = z["tris"], z["mask"]
print("mask bits present:", {int(v): int((mask == v).sum()) for v in np.unique(mask)[:16]})
sel = (mask & bit) != 0
cent = tris[:, :, :2].mean(axis=1)
# densest window: histogram of centroids on a window-sized grid, take the best cell
cell = window
gx = ((cent[:, 0] + 2100) // cell).astype(np.int64)
gy = ((cent[:, 1] + 2100) // cell).astype(np.int64)
nx = int(gx.max()) + 1
counts = np.bincount((gy * nx + gx)[sel], minlength=nx * (int(gy.max()) + 1))
best = int(counts.argmax())
x0, y0 = (best % nx) * cell - 2100, (best // nx) * cell - 2100
inside = sel & (cent[:, 0] >= x0) & (cent[:, 0] < x0 + window) & (cent[:, 1] >= y0) & (cent[:, 1] < y0 + window)
t = np.ascontiguousarray(tris[inside])
print("window", x0, y0, window, "triangles", len(t))
t.astype(np.float32).tofile(f"{out}/tris.bin")

rng = np.random.default_rng(12345)
ids = rng.integers(0, len(t), n_seg)
c = t[ids].mean(axis=1).astype(np.float64)
p0 = c + rng.uniform(-6, 6, (n_seg, 3))
aim = rng.random(n_seg) < 0.5
other = t[rng.integers(0, len(t), n_seg)].mean(axis=1).astype(np.float64)
rand_dir = rng.normal(size=(n_seg, 3))
rand_dir /= np.linalg.norm(rand_dir, axis=1)[:, None]
length = rng.uniform(5, window * 0.6, n_seg)
p1 = np.where(aim[:, None], other, p0 + rand_dir * length[:, None])
p0 = p0.astype(np.float32).astype(np.float64)
p1 = p1.astype(np.float32).astype(np.float64)
np.concatenate([p0, p1], axis=1).astype(np.float32).tofile(f"{out}/segs.bin")

lo, hi = t.min(axis=(0, 1)), t.max(axis=(0, 1))
index = TriangleIndex(t, np.ones(len(t), np.uint8), lo[0], lo[1], hi[0] - lo[0], hi[1] - lo[1])
ref_t = np.full(n_seg, np.nan)
ref_tri = np.full(n_seg, -1, np.int32)
for i in range(n_seg):
    if i % 2000 == 0:
        print("ref", i, flush=True)
    tt, tid, _ = index.hits(p0[i], p1[i], 1)
    if len(tt):
        ref_t[i], ref_tri[i] = tt[0], tid[0]
ref_t.tofile(f"{out}/ref_t.bin")
ref_tri.tofile(f"{out}/ref_tri.bin")
json.dump({"window": [x0, y0, window], "triangles": int(len(t)), "segments": n_seg, "mask_bit": bit,
           "hits": int(np.isfinite(ref_t).sum()), "bbox": [lo.tolist(), hi.tolist()]}, open(f"{out}/meta.json", "w"))
print("reference hits", int(np.isfinite(ref_t).sum()), "of", n_seg)
