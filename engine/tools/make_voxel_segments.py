"""Random segments over a window of a map, the answer of the python voxel model (models.py) for each, and the
collision triangles of the window, for the voxel-DDA parity test (`engine/tests/voxel_parity.rs`).

    python3 make_voxel_segments.py <slug> <map.vcol> <out prefix> <tris.npz> [<tris.npz> ...] [--count 100000]
        [--window 1000] [--seed 1]

Needs the volumetric tools on PYTHONPATH (tools/volumetric/py, tools/heightmaps/py) and the landscape levels under
/data/squad-extract/landscapes (see tools/volumetric/README.md). Each `tris.npz` is a `world_tris.py` shard; only
triangles that block the Visibility channel (the channel `build_columns.py` voxelises) are used.

The window is the densest `--window` metre square of occupied columns. Triangles whose box meets the window are
written, so every segment that stays inside the window meets exactly the triangles in the file. Segments:
70 % start within 3 m of a random occupied voxel, 30 % anywhere in the window up to 12 m over the ground; lengths
70 % 3-60 m, 25 % 60-200 m, 5 % 200-500 m; half random directions, half within 20 degrees of the horizontal.
A segment is kept when it lies inside the window and stays at least 0.25 m above the landscape (bilinear 1 m
grid, every 0.25 m): the voxel layer holds what stands above the landscape, so the comparison is about objects.

Writes next to the prefix:
    .segments.f64  count x 6 little-endian float64 (p0 xyz, p1 xyz), Unreal frame of the file
    .python.f64    count float64: distance along the segment to the first blocked sample of models.VoxelModel
                   (step min(cell, dz) / 3, landscape never blocks), -1 when clear
    .ground.f32    count float32: smallest height above the landscape along the segment
    .tris.bin      nine float32 per triangle
    .json          window, counts, and the check that the triangles rebuild the file's voxels
"""
import argparse
import json
import multiprocessing

import numpy as np

import build_columns
import codec
import collision
import columns
import eval_los
import maps
import models
import terrain

CLEARANCE_M = 0.25
SAMPLE_STEP_M = 0.25
LANDSCAPE_ROOT = "/data/squad-extract/landscapes"


def landscape_window(slug, x0, y0, size):
    """models.Landscape of the window on a 1 m grid whose [0, 0] is at (x0, y0); NaN (no landscape) becomes -1e6."""
    actors = build_columns.load_terrain([f"{LANDSCAPE_ROOT}/{level}" for level in maps.MAPS[slug][1]])
    n = int(size) + 2
    xs, ys = x0 + np.arange(n), y0 + np.arange(n)
    z = np.empty((n, n))
    hole = np.zeros((n, n), bool)
    for row in range(0, n, 100):
        gx, gy = np.meshgrid(xs, ys[row:row + 100])
        z[row:row + 100], hole[row:row + 100] = terrain.sample(actors, gx, gy)
    return models.Landscape(np.nan_to_num(z, nan=-1e6), hole, x0, y0), actors


def window_triangles(paths, x0, y0, size):
    """Yield, shard by shard, float32 [n, 3, 3] visibility-blocking triangles whose box meets the window.

    One shard at a time is held, so a window of tens of millions of triangles (Fallujah: 37.9 M, 1.4 GB) streams."""
    for path in paths:
        data = np.load(path)
        tris, mask = data["tris"], data["mask"]
        low, high = tris.min(axis=1), tris.max(axis=1)
        near = (mask & collision.VISIBILITY != 0) & (high[:, 0] >= x0) & (low[:, 0] <= x0 + size) & (high[:, 1] >= y0) & (low[:, 1] <= y0 + size)
        yield tris[near]
        del data, tris, mask, low, high


def check_rebuild(chunks, grid, occupied, actors, x0, y0, size):
    """How well the window's triangles (an iterable of arrays) rebuild the file's voxels inside the window (same builder as the file)."""
    cols = occupied >> columns.Z_BITS
    col_x, col_y = cols % grid.width, cols // grid.width
    lo_x, lo_y = int((x0 - grid.min_x) / grid.cell), int((y0 - grid.min_y) / grid.cell)
    span = int(size / grid.cell)

    def inside(keys):
        c = keys >> columns.Z_BITS
        cx, cy = c % grid.width, c // grid.width
        return (cx >= lo_x) & (cx < lo_x + span) & (cy >= lo_y) & (cy < lo_y + span)

    rebuilt, _, _ = columns.build_keys(chunks, grid)
    rebuilt = rebuilt[inside(rebuilt)]
    stored = occupied[inside(occupied)]
    missing = rebuilt[~np.isin(rebuilt, stored)]
    x, y, z = grid.voxel_center(missing)
    ground, hole = terrain.sample(actors, x, y)
    above = np.isnan(ground) | hole | (z + grid.dz / 2 > ground + build_columns.LAND_MARGIN_M)
    return dict(window_voxels_in_file=int(len(stored)), rebuilt_from_triangles=int(len(rebuilt)),
                rebuilt_not_in_file=int(len(missing)), rebuilt_not_in_file_above_ground=int(above.sum()),
                in_file_not_rebuilt=int((~np.isin(stored, rebuilt)).sum()))


def make_segments(rng, count, centres, land, x0, y0, size):
    """(segments [count, 6], clearance [count]) inside the window and over the landscape."""
    out, clear = [], []
    have = 0
    while have < count:
        n = 40000
        near = rng.random(n) < 0.7
        pick = centres[rng.integers(len(centres), size=n)] + rng.normal(0, 3.0, (n, 3))
        free = np.stack([x0 + rng.uniform(0, size, n), y0 + rng.uniform(0, size, n), np.zeros(n)], 1)
        free[:, 2] = land.height(free[:, 0], free[:, 1]) + rng.uniform(0.3, 12.0, n)
        p0 = np.where(near[:, None], pick, free)
        bucket = rng.random(n)
        length = np.where(bucket < 0.7, rng.uniform(3, 60, n), np.where(bucket < 0.95, rng.uniform(60, 200, n), rng.uniform(200, 500, n)))
        heading = rng.uniform(0, 2 * np.pi, n)
        pitch = np.where(rng.random(n) < 0.5, np.arcsin(rng.uniform(-1, 1, n)), rng.uniform(-np.radians(20), np.radians(20), n))
        direction = np.stack([np.cos(pitch) * np.cos(heading), np.cos(pitch) * np.sin(heading), np.sin(pitch)], 1)
        p1 = p0 + direction * length[:, None]
        ok = np.ones(n, bool)
        for p in (p0, p1):
            ok &= (p[:, 0] > x0 + 1) & (p[:, 0] < x0 + size - 1) & (p[:, 1] > y0 + 1) & (p[:, 1] < y0 + size - 1)
            ok &= p[:, 2] - land.height(np.clip(p[:, 0], x0, x0 + size), np.clip(p[:, 1], y0, y0 + size)) >= CLEARANCE_M
        for i in np.nonzero(ok)[0]:
            x, y, z = models.march(p0[i], p1[i], SAMPLE_STEP_M)
            gap = float((z - land.height(x, y)).min())
            if gap < CLEARANCE_M:
                continue
            out.append(np.concatenate([p0[i], p1[i]]))
            clear.append(gap)
            have += 1
            if have == count:
                break
    return np.array(out), np.array(clear, np.float32)


MODEL = None


def python_answer(segment):
    distance = MODEL.first_block_m(segment[:3], segment[3:])
    return -1.0 if distance is None else distance


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("slug")
    parser.add_argument("vcol")
    parser.add_argument("prefix")
    parser.add_argument("tris", nargs="+")
    parser.add_argument("--count", type=int, default=100000)
    parser.add_argument("--window", type=float, default=1000.0)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    occupied, header = codec.decode(open(args.vcol, "rb").read())
    grid = columns.Grid(header["min_x"], header["min_y"], header["width"] * header["cell"], header["height"] * header["cell"],
                        header["cell"], header["dz"], header["z_min"])
    x0, y0 = eval_los.densest_window(occupied, grid, args.window)
    print("window", x0, y0, args.window, "voxels", len(occupied), flush=True)
    land, actors = landscape_window(args.slug, x0, y0, args.window)
    in_window_triangles = 0

    def stream_to_file(chunks, out):
        nonlocal in_window_triangles
        for chunk in chunks:
            chunk.astype("<f4").tofile(out)
            in_window_triangles += len(chunk)
            yield chunk

    with open(args.prefix + ".tris.bin", "wb") as out:
        check = check_rebuild(stream_to_file(window_triangles(args.tris, x0, y0, args.window), out), grid, occupied, actors, x0, y0, args.window)
    print("triangles in window", in_window_triangles, flush=True)
    print("rebuild check", check, flush=True)

    in_window = occupied[(lambda c: (c % grid.width * grid.cell + grid.min_x >= x0) & (c % grid.width * grid.cell + grid.min_x < x0 + args.window)
                                    & (c // grid.width * grid.cell + grid.min_y >= y0) & (c // grid.width * grid.cell + grid.min_y < y0 + args.window))(occupied >> columns.Z_BITS)]
    centres = np.stack(grid.voxel_center(in_window[::max(1, len(in_window) // 200000)]), 1)
    rng = np.random.default_rng(args.seed)
    segments, clearance = make_segments(rng, args.count, centres, land, x0, y0, args.window)
    print("segments", len(segments), flush=True)

    global MODEL
    never = models.Landscape(np.full((2, 2), -1e9), np.zeros((2, 2), bool), 0.0, 0.0)
    MODEL = models.VoxelModel(never, grid, occupied)
    with multiprocessing.Pool(4) as pool:
        answers = np.array(pool.map(python_answer, list(segments), chunksize=500))
    segments.astype("<f8").tofile(args.prefix + ".segments.f64")
    answers.astype("<f8").tofile(args.prefix + ".python.f64")
    clearance.astype("<f4").tofile(args.prefix + ".ground.f32")
    meta = dict(slug=args.slug, vcol=args.vcol, window=[x0, y0, args.window], segments=int(len(segments)), blocked_by_python_model=int((answers >= 0).sum()),
                grid=dict(cell=grid.cell, dz=grid.dz, width=grid.width, height=grid.height), rebuild_check=check, seed=args.seed)
    json.dump(meta, open(args.prefix + ".json", "w"), indent=1)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
