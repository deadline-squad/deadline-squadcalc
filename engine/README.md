# squad-engine

Rust core of the Squad ballistics engine for SquadCalc. Russian version: [README.ru.md](README.ru.md).

* **Solver** (`flight`, `weapon`): closed-form `f64` firing solutions for both arcs, rocket motor
  (ConstantAcceleration) phases, `MaxSpeed` clamp, launch offsets and elevation limits. A function-for-function port of
  `src/js/squadBallistics.js` and `src/js/squadFiringSolution.js`; the parity test runs the real JS classes.
* **Trajectory segments** (`path`): the flight as straight segments whose vertices lie exactly on the path.
* **BVH** (`bvh`): binned-SAH builder, flattened into the skip-pointer layout below, with `bvh.bin` import/export.
* **Queries** (`trace`): Moller-Trumbore segment/triangle test in `f64` (reference) and `f32` (GPU parity, optional
  SIMD128), stackless first-hit traversal, line-of-fire query for a whole trajectory.
* **Heightmap** (`heightmap`): 16-bit G16 sampler with the game's triangle-diagonal rule.
* **Voxel columns** (`voxel`): decoder of the `VCOL1` file (`tools/volumetric/py/codec.py`) and the segment query by
  voxel-column DDA (first occupied voxel or clear), see [Voxel columns](#voxel-columns-vcol1).
* **Precision pass** (`precision`): around one target the voxel walk decides what stays far from geometry and the exact
  triangles of a 150 m region (`RTRI1`) decide what comes within a margin of it, see
  [Precision pass](#precision-pass-rtri1).
* **JSON interface** (`io`), a CLI (`squad-cli`) and wasm exports (`wasm`, feature `wasm`) with an ES-module wrapper
  in `js/`.

World frame of the engine: metres, **X east, Y north, Z up**. Bearings are clockwise from north
(`atan2(dX, dY)`). Unreal's world has Y pointing south: convert before building the BVH or sending positions.

## BVH layout (`bvh.bin`)

This layout is a contract with the WGSL traversal. All values are little endian.

```
bvh.bin
  u32 node_count
  u32 tri_count
  node[node_count]       32 bytes each
  triangle[tri_count]    48 bytes each

node (32 bytes)                          triangle (48 bytes) = 3 x vec4<f32>
  offset  0  f32 min.x                     offset  0  f32 x0, y0, z0, pad (0)   vertex 0
          4  f32 min.y                             16  f32 x1, y1, z1, pad (0)   vertex 1
          8  f32 min.z                             32  f32 x2, y2, z2, pad (0)   vertex 2
         12  u32 a
         16  f32 max.x
         20  f32 max.y
         24  f32 max.z
         28  u32 b
```

* Nodes are in depth-first order. The first child of an inner node is the next node (`index + 1`); the right child is
  at the left child's escape index.
* `a` is the **escape index**: the node to visit next when the ray misses this node's box, or after the whole
  subtree has been visited. `0xFFFFFFFF` ends the traversal. For a node `i` it is always `i + size_of_subtree(i)`
  (a leaf's escape is `i + 1`), `0xFFFFFFFF` when that is `node_count`. The root's escape is `0xFFFFFFFF`.
* `b` is `(first_triangle << 8) | triangle_count` for a **leaf** (`1..=255` triangles) and `0` for an **inner** node.
  A leaf is recognised by `(b & 0xFF) != 0`.
* Triangles are stored in leaf order: leaf `L` owns `triangles[first_triangle .. first_triangle + count]`.
* An empty hierarchy is `node_count = 0`, `tri_count = 0` (8 bytes).

Stackless traversal:

```
i = 0
while i != 0xFFFFFFFF:
    node = nodes[i]
    if ray hits node box (t in [0, t_max]):
        if node.b & 0xFF:                       # leaf
            test triangles node.b >> 8 .. + (node.b & 0xFF); shrink t_max on a hit
            i = node.a
        else:
            i = i + 1                           # descend into the first child
    else:
        i = node.a
```

**Limit: 2^24 triangles per `bvh.bin`.** `first_triangle << 8` has to fit a `u32`, so one file addresses at most
16 777 216 triangles. `BvhSet` therefore splits a larger soup spatially (median of the longest centroid axis) into
several hierarchies of exactly this layout (`bvh_000.bin`, ...); their boxes may overlap and a query visits every
part whose root box the ray enters. Fallujah's 72 098 154 collision triangles become 8 parts. A single `bvh.bin` of
that size would also need 3.5 GB of triangle storage, over WebGPU's default `maxStorageBufferBindingSize`.

Box corners are the exact `f32` coordinates of the vertices (no padding); the `f64` query widens boxes by 1e-6 m
internally. Leaves hold up to 4 triangles when splitting does not pay (SAH, 16 bins per axis, traversal cost 1,
triangle cost 1); leaves are forced to split above 255 triangles.

## JSON interface

Request:

```json
{
  "weapon_specs": { "v0": 110.0, "mass": 4.1, "drag_coef": 0.47 },
  "pos_gun": [0.0, 0.0],
  "pos_target": [0.0, 600.0, 0.0],
  "environment": { "z_scale": 100.0, "heightmap_ref": "map.png", "bvh_buffer_ref": "bvh.bin" }
}
```

Response:

```json
{
  "firing_solution": { "azimuth_deg": 0.0, "elevation_mrad": 253.7 },
  "flight_data": { "time_sec": 5.63, "max_ordinate_meters": 38.9 },
  "occlusion_status": "clear",
  "collision_details": { "point": [0.0, 600.0, 0.0], "material": "unknown", "lethality": 1.0, "splash_footprint_radius": 0.0 }
}
```

* `drag_coef` (and `mass`) are **accepted and ignored**: Squad projectiles fly in vacuum, `g = 9.80 *
  ProjectileGravityScale`, without drag.
* `pos_gun` is `[X, Y]`; the gun's Z is the heightmap at that point (0 without a heightmap). `pos_target` is
  `[X, Y, Z]`. `azimuth_deg` is in `[0, 360)`.
* `environment.z_scale` is half of the heightmap's height range: `Z = (v / 65535 * 2 - 1) * z_scale` for a 16-bit
  sample `v`. `heightmap_ref` and `bvh_buffer_ref` are names of resources the host loaded (the CLI treats them as file
  paths: `.png` 16-bit grayscale or raw `.g16` for the heightmap; a `bvh.bin`, or a directory of `*.bin` parts, for the
  BVH). Both are optional: without a heightmap the ground is Z = 0, without a BVH the line of fire is not checked
  against obstacles. `environment.heightmap_resolution_m` (default 1) is the sample spacing for the CLI.
* `environment.vcol_ref` names voxel columns (a `.vcol` path for the CLI, gzip or already decompressed). The path is
  traced through them like through a BVH; the nearer of voxel, triangle and terrain is the impact. **Positions are then
  in the frame of the file** (Unreal: Y south), see [Voxel columns](#voxel-columns-vcol1).
* `environment.region_ref` names a precision region (an `.rtri` path for the CLI) and needs `vcol_ref`: inside the
  region's square a path that comes within the margin of a voxel is tested against the region's triangles instead of
  being blocked by the voxel, see [Precision pass](#precision-pass-rtri1).
* Heightmap grid: row 0 is the northern edge, `X = col * resolution`, `Y = -row * resolution` (SquadCalc's `lng`,
  `-lat`). Between samples each quad is two triangles split along the diagonal from `(row, col)` to
  `(row + 1, col + 1)`, as in `src/js/squadHeightmaps.js`; a point more than half a sample outside the grid has height 0.
  Raw `.g16`: `u32` width, `u32` height, then `u16` samples, little endian, row 0 first.
* `elevation_mrad` is the elevation of the sight in milliradians.
  `null` fields and `occlusion_status: "no_solution"` mean the target cannot be reached.
* `occlusion_status`: `clear`, `occluded` (the path meets a BVH triangle, an occupied voxel or the terrain before the target; the terrain
  is checked every heightmap sample, leaving out 3 m at both ends like SquadCalc), `unchecked` (no heightmap, BVH
  or voxel columns), `no_solution`.
* `collision_details.point` is the first obstacle on the path, or the target when the line of fire is clear.
* **`material`, `lethality` and `splash_footprint_radius` are a stub** (`materials.rs`): the collision-semantics data
  has not been delivered, so every surface is `"unknown"`, lethality `1.0`, footprint radius `0.0` m. The call site
  already passes the triangle that was hit; only `materials::lookup` has to change.
* Optional extras: `weapon_specs.model` (boost, `max_speed`, `muzzle`, elevation limits, ... see `weapon::Weapon`; its
  `velocity` is replaced by `v0`) and `options` (`arc`: `auto` | `low` | `high`, default `auto` = low arc if the weapon
  can fire it; `tolerance_m`: segment tolerance, default 0.05).

CLI: `cargo run --release --bin squad-cli -- request.json` (or the request on stdin) prints the response.

## Building and testing

The toolchain is pinned in `rust-toolchain.toml` (installed per user by `rustup`, no sudo).

```sh
cargo fmt --check
cargo clippy --all-targets --features threads -- -D warnings
cargo test --release --features threads            # unit, CLI, random-soup BVH, parity with the JS solver
```

`tests/parity.rs` runs `tools/js/reference.mjs` under Node (the real `Weapon` and `SquadFiringSolution` of this
checkout, with the stubs of `tools/direct_fire`) over the grid of `tools/direct_fire/compare.py` - 143 shells, 15
distances x 9 heights plus 18 cases around each maximum range - and compares both arcs, the sight angle, both times
of flight, the hold time and the maximum range. Tolerance: 1e-9 degree for angles, 1e-9 s for times, except times of
flight above 10 s, which are held to 3e-10 relative (near-vertical high arcs of close targets, where the time changes
by ~5e3 s per radian and the two libm `sin`/`cos` differ in the last bit).

### BVH against the exact tracer on Fallujah

```sh
# 1. triangles that block the Projectile channel -> raw bytes (docker image with numpy, see tools/docker)
docker build -q -t sc-engine-py tools/docker
docker run --rm --user $(id -u):$(id -g) -v ~/data/volumetric:/data:ro -v ~/work/engine-data:/out \
  -v $PWD/tools:/tools:ro sc-engine-py python3 -I /tools/npz_to_bin.py /data/fallujah_tris.npz /out/fallujah_proj.bin --bits 2
# 2. 100 000 random segments and their first hit from tools/volumetric/py/reference.py
docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -v ~/agl/tools/volumetric/py:/ref:ro -v ~/work/engine-data:/out \
  -v $PWD/tools:/tools:ro sc-engine-py python3 -I /tools/make_segments.py /ref /out/fallujah_proj.bin /out/fallujah --count 100000
# 3. the test and the benchmark
ENGINE_FALLUJAH_DIR=~/work/engine-data cargo test --release --features threads --test fallujah -- --ignored --nocapture
cargo run --release --features threads --example bench -- ~/work/engine-data/fallujah_proj.bin ~/work/engine-data/fallujah.segments.f64
```

### Results (Fallujah, 72 098 154 collision triangles, 100 000 segments, 29 947 hits)

```
loaded 72098154 triangles in 4.0 s
built 8 hierarchies, 69699116 nodes, 72098154 triangles in 67.2 s
100000 segments traced in 0.04 s (2343517 segments/s)
hit/no-hit disagreements: 0; segments both hit: 29947; worst hit point difference: 3.9e-13 m
test bvh_agrees_with_the_reference_tracer_on_fallujah ... ok
```

Benchmark (`examples/bench.rs`, 8 hierarchies = 2230 MB of nodes + 3461 MB of triangles; the machine was shared and
loaded, so read the throughput as a lower bound):

| | time | segments/s |
|---|---|---|
| BVH build (binned SAH, all threads) | 66.3 s | |
| `f64` first hit, all threads | 0.046 s | 2 163 790 |
| `f64` first hit, 1 thread | 0.186 s | 536 697 |
| `f32` first hit, 1 thread (GPU arithmetic) | 0.157 s | 638 749 |

**About the reference.** The stock `TriangleIndex.tiles_on` of `reference.py` samples a segment every 2 m over 8 m
tiles and misses tiles that the segment only clips at a corner. With the stock sampler 21 of the 100 000 segments
disagreed with the BVH: 6 where the reference reported no hit, 15 where it reported a later hit. For each of the 21
the first hit was recomputed with the reference's own Moller-Trumbore formulas against *every* triangle whose box
meets the segment's box (`tools/recheck_expected.py`, plain numpy); all 21 equal the BVH result to the last digit
(`t` differences below 1e-15). `tools/make_segments.py` now uses all tiles of the segment's bounding box, so a new
generation has no such misses; the shipped data set was repaired with the recheck tool (the repaired entries are the
only difference from a regeneration). The BVH never disagreed with the exact answer.


## Voxel columns (`VCOL1`)

The browser cannot hold the collision triangles of a map (Fallujah: 5.7 GB of BVH), but it can hold its voxel columns
(Fallujah statics at 0.5 m x 0.25 m: 3.4 MB gzip, 3.7 MB with the foliage; 4.7 MB with the earlier sample-lattice builder). `voxel::VoxelColumns::from_bytes` reads the file of
`tools/volumetric/py/codec.py` (layout there; gzip or already decompressed, malformed input is an error, never a
panic). A voxel `(column, row, z)` is the half-open box `[min_x + column * cell, +cell) x [min_y + row * cell, +cell) x
[z_min + z * dz, +dz)`; at most 4096 height indices per column. The positions of every query are in the frame the file
was built in (Unreal: metres, X east, **Y south**), exactly as the triangles of a BVH built from `world_tris.py` are:
convert before you ask if you work in the engine frame.

`VoxelColumns::first_block(p0, p1)` returns the first occupied voxel the segment enters (`column`, `row`, `z`, the
entry `t` in `0..=1`; `t = 0` if it starts inside one) or `None`. A 2D DDA (Amanatides-Woo) walks the `(column, row)`
cells the segment crosses; inside a cell the runs of the column are tested against the segment's height range and the
entry is computed in closed form, so the cost is the number of cells crossed, not the number of voxels. Every voxel
the segment touches is seen (the sampled walk of `models.py` steps over corners). Parts of a segment outside the grid
do not block. `first_blocks` does many segments (rayon with `threads`), `first_block_along` a whole trajectory.
`wgsl/voxel.wgsl` is the same walk in `f32` (see `wgsl/README.md`). Browser: `Engine.loadVcol(ref, bytes)`,
`Engine.voxelFirstBlock(ref, segment)`.

Unit tests: `src/voxel.rs` (hand-made scenes; 5 000 random segments against a slab test of every voxel),
`tests/voxel.rs` (a file written by `codec.py`, damaged files, the CLI), `src/io.rs` (JSON requests), `js/test/`.

### In the page (volume layer)

`src/js/volumeWorker.js` loads `public/engine/` (`npm run build:engine` builds the module and copies `index.mjs`,
`pkg/squad_engine.js` and `pkg/squad_engine_bg.wasm` there; the page builds and runs without it) and, for the active map, the
two files that `tools/volumetric/py/publish_volume.py` put next to the heightmap: `volume.vcol` (this section's
`VCOL1`) and `terrain.bin` (`TER2`, landscape-only heights with the landscape holes on the heightmap's grid of the landscape's
vertices, `src/js/volumeTerrain.js`; the `TER1` files of the heightmaps before it are read too). It starts
only when the user turned the *Object volumes in the line of fire* setting on and `meta.json` has a `volume` entry
(file names, sizes, sha256, grid); a map without the entry, a missing engine or a failed download keeps the heightmap.
The page's heights count from the heightmap's lowest level (`meta.json` `z_min_m`), the files hold the game's Z.

* Line of fire (`SquadFiringSolution.getObstacle`): the trajectory is sampled every metre like the heightmap check
  (3 m at both ends skipped), each segment is tested with `voxelFirstBlock`, each point against the landscape. A hole
  of a building (an open window, a doorway: a door is open or absent) passes, a closed window or a wall is solid. Until the worker answers the heightmap's result stands.
* Fire coverage (`SquadCoverage` through `SquadVolume.coverage`): per ray the worker samples the landscape and the top of
  the voxels under every sample (a vertical `voxelFirstBlock`), classifies with the landscape as the profile, and tests a
  trajectory that is under a structure's top segment by segment (`squadCoverageRays.clearsStructures`). Targets in a
  landscape hole or outside the landscape are out. A wall thinner than the sample step (1 to 3 m) that falls between two
  samples of a ray is not seen, as with the heightmap.

* Target heights (`SquadVolume.heightsAt`, worker message `column`): the worker probes the voxel column at the target's
  position from 1 m under the landscape up to 120 m above it (one `voxelFirstBlock` per voxel centre) and returns the solids
  it crosses; `src/js/targetHeights.js` turns the free spaces between them into floors (top of a solid with at least 1.8 m
  free above), ceilings, the roof, and windows and doorways (a free space with solid on both sides of the ray along X or Y
  within 0.75 m, a doorway when a soldier fits, 1.8 m). A heuristic from the shape of the column, not the game's building
  data. The chosen height is the target's height in `SquadFiringSolution`, and its line of fire is checked up to the target
  point (0.1 m above a floor or roof, below a ceiling) instead of stopping 3 m short.

* Damage zone cover (`SquadVolume.coverZone`, worker message `cover`): `squadDamage.damageField` runs in the worker with the
  landscape (`terrain.bin`) as the heightmap and the voxels as `objects`: a soldier is covered when the landscape hides him (the
  horizon sweep, as before) or when `voxelFirstBlock` finds a voxel between the explosion and him, on the stretch of the line the
  heightmap trace uses (from 1 m off the explosion to 0.5 m short of his body centre, 0.9 m above the landscape). A wall covers a
  soldier, an open doorway or window does not, no penetration is computed. The round lands at the height of the target (the
  floor, window or roof chosen for it, else the heightmap's height at the target) and the soldiers stand on the landscape, so
  one on an upper floor is not drawn. The rounds-to-kill line of the popup (`hitProbability`) still reads the heightmap. A
  zone computed without the layer, or when the worker cannot answer, is the heightmap's as before. Tests: `tests/squadDamage.test.mjs`
  (`objects` with a callback) and `tests/volumeLayer.test.mjs` (the `cover` message through the real engine: a soldier behind
  the wall is covered, one in line with the doorway is not); in a browser `tools/browser_check/heatmap_check.mjs`.

No penetration is computed (owner decision 2026-11-04). Tests: `tests/volumeLayer.test.mjs`; in a browser
`tools/browser_check/volume_check.mjs` (deployment repository) on the Jensen and Kokan parity segments.

#### Files served for each map

All 25 maps have a `volume.vcol` and a `terrain.bin` under `/heightmaps/<slug>/` (published 2026-11-05 with
`tools/volumetric/py/publish_volume.py`; `meta.json` `volume` holds their size, sha256, `cell` 0.5, `dz` 0.25 (Skorpo 0.5),
`z_min_m` and column count, and the page checks every download against it). The voxel files are the exact conservative
builds (a voxel is occupied when any collision triangle touches it); `terrain.bin` is the landscape alone on the served
heightmap's grid. Sizes are the gzip files as served (`Content-Length`), MB = 10^6 bytes:

| map | voxels | columns | volume.vcol MB | terrain.bin MB | total MB |
|---|---:|---:|---:|---:|---:|
| Al Basrah | 30 451 611 | 6 651 616 | 6.7 | 4.0 | 10.6 |
| Anvil | 10 967 659 | 3 799 365 | 3.8 | 3.3 | 7.1 |
| Black Coast | 56 465 424 | 11 436 477 | 29.8 | 5.0 | 34.9 |
| Chora | 91 931 376 | 46 320 086 | 36.9 | 5.1 | 42.0 |
| Fallujah | 26 207 218 | 4 293 607 | 3.7 | 2.2 | 5.9 |
| Fool's Road | 11 313 484 | 1 954 982 | 6.2 | 1.0 | 7.1 |
| Goose Bay | 31 546 317 | 8 328 396 | 15.0 | 3.6 | 18.6 |
| Gorodok | 84 623 955 | 16 190 947 | 39.3 | 5.8 | 45.1 |
| Harju | 83 968 689 | 14 156 430 | 41.2 | 3.9 | 45.1 |
| Jensen | 723 221 | 113 863 | 0.1 | 3.6 | 3.7 |
| Kamdesh | 26 351 783 | 5 611 970 | 14.4 | 5.4 | 19.7 |
| Kohat | 5 294 803 | 2 140 481 | 2.0 | 6.5 | 8.5 |
| Kokan | 2 198 643 | 536 181 | 0.7 | 4.0 | 4.7 |
| Lashkar | 32 899 158 | 12 971 740 | 13.3 | 9.9 | 23.2 |
| Logar | 3 044 202 | 789 524 | 1.3 | 1.1 | 2.4 |
| Manicouagan | 63 760 981 | 9 631 372 | 17.6 | 5.2 | 22.7 |
| Mestia | 13 341 383 | 3 114 491 | 7.6 | 1.2 | 8.8 |
| Mutaha | 4 367 244 | 755 369 | 1.0 | 1.7 | 2.7 |
| Narva | 22 401 380 | 4 478 752 | 6.0 | 1.8 | 7.8 |
| Pacific | 6 432 244 | 1 597 851 | 2.8 | 5.2 | 8.0 |
| Sanxian | 53 268 036 | 7 028 913 | 16.4 | 3.8 | 20.2 |
| Skorpo | 35 144 900 | 10 512 339 | 24.8 | 8.9 | 33.7 |
| Sumari | 5 052 864 | 1 903 765 | 1.0 | 0.4 | 1.3 |
| Tallil | 25 877 723 | 16 031 048 | 5.2 | 4.6 | 9.8 |
| Yehorivka | 122 097 455 | 18 617 851 | 48.6 | 13.0 | 61.6 |

Range: `volume.vcol` 0.1 to 48.6 MB (median 6.7 MB), `terrain.bin` 0.4 to 13.0 MB, both together 1.3 to 61.6 MB, 455 MB for
all 25 maps. Yehorivka, Harju, Gorodok and Chora are over 36 MB for the voxel file alone.

Loading the biggest ones in headless Chromium 153 (`tools/browser_check/volume_check.mjs`, tk104, nothing else running): from
turning the setting on to "ready" (download from the local Caddy, sha256, wasm engine start, decompression of both files)
Skorpo 2.3 s, Black Coast 2.2 s, Gorodok 2.8 s, Harju 2.7 s, Yehorivka 3.3 to 3.7 s, Chora 4.2 to 4.4 s; the browser's whole
process tree (summed resident memory) grew from 1.4 GB (page alone) to 2.1 GB (Skorpo, Black Coast), 2.2 to 2.3 GB (Harju, Gorodok), 2.8 GB (Yehorivka) and
3.3 GB (Chora: 46 million columns and a 66-million-vertex landscape) and stays there; a fire coverage over the loaded map takes
2 to 3 s on all of them. Nothing failed or ran out of memory on a 15 GB host. Over a real network the download dominates
(62 MB for Yehorivka), which the setting's label states ("downloads 1 to 62 MB of map data").

### Position heatmap (reverse positions)

`src/js/positionHeatmap.js` answers the question the fire coverage asks the other way round: for a chosen target (at the
height chosen for it) which ground positions around it, up to the weapon's range, have a clear line of fire to it, and
how good a position each is. Direct-fire weapons only (those with a sight and a MOA, `type: "directFire"`). The page
side is `src/js/squadPositionHeatmap.js` (a button in the target dialog, loaded on demand, drawn as a canvas image over
the map like the coverage), the computation runs in the volume worker (`heatInit`, `heatRays`, `heatFinish` messages of
`volumeWorker.js`, `SquadVolume.positionHeatmap`) with the engine.

* **Positions** lie on rays from the target (at least 360, at most 1440, neighbours about two cells apart at the edge),
  every `cell = max(2 m, range / 160)` metres; the range is the weapon's, at most 2000 m (the ballistic ranges of the
  weapons reach tens of kilometres). The landscape profile of a ray (TER2 heights, sampled every 1 to 3 m) is read once for
  all its positions.
* **The shot** is the weapon's low trajectory from the muzzle of a shooter standing at the position (shouldered, 1.5 m,
  unless the weapon has a muzzle model or a height offset), solved exactly like `SquadFiringSolution` and the fire
  coverage (`squadBallistics.solveElevation`/`trajectory`: gravity scale, rocket boost, elevation limits, projectile
  lifespan). A position where the weapon cannot be laid or the projectile expires is out (value 0).
* **Line of fire**: the landscape along the ray (the first and last 3 m skipped, as everywhere), then the objects: the
  trajectory as a polyline with pieces of at most 25 m (the sagitta of the slowest direct-fire shell stays under 7 cm),
  each piece tested with `voxelFirstBlock`, or with `precisionFirstBlock` where the target has a precision region. A
  target that is not on the ground (a floor, a window, a roof) is traced up to 0.5 m short of it and the last piece ends at
  the point itself. A position where the shooter's body (a 0.3 m vertical segment under the muzzle) is inside a voxel
  is out. Open windows and doorways are holes, closed windows and walls are solid, no penetration is computed (owner
  decisions of 2026-11-04).
* **Score** of a clear position, 0 to 1: `proximity * clearance`, `proximity = 1 - 0.6 * distance / range` (a close
  position is better, the farthest keeps 0.4: a long shot stays viable) and `clearance = 0.5 + 0.5 * k / 4`, where `k`
  of the four lines of fire displaced up, down and to either side by the margin are clear too. The margin is the weapon's
  spread radius at the target (`distance * tan(MOA / 2)`), at least 0.5 m and at most 2 m, and grows linearly from the
  muzzle. Byte per position: 0 out, 1 blocked, 2 to 255 the score.
* **Precision regions**: `meta.json` `volume.regions` lists the `RTRI1` files published for a map
  (`tools/volumetric/py/publish_regions.py`, `{file, bytes, sha256, centre, radius, margin}`). The page uses the region
  whose square holds the target farthest from its edge, at least 50 m (so the exact triangles reach at least 50 m around
  the target), fetches it as `<file>?v=<generated>`, checks its sha256 and loads it in the worker, which builds the
  hierarchy of its triangles (`Engine.loadRegion`); the legend says `Exact triangles within N m of the target, voxels
  beyond`, or `Voxels only` when there is none or it failed to load. Region files exist only for targets someone
  validated: Jensen, `regions/region_221_-229.rtri` (1.93 MB, 300 m x 300 m centred at (221, -229)).

Tests: `tests/positionHeatmap.test.mjs` (score, classification, callbacks, image, region choice),
`tests/volumeLayer.test.mjs` (the worker through the real engine on a wall with a doorway), in a browser
`tools/browser_check/heatmap_check.mjs` (deployment repository).

#### Against the exact triangles

`engine/tools/js/heatmap_validate.mjs` runs the same classifier three times on one target and weapon: with the volume worker
(voxel walk only), with the worker and the target's region, and in Node with every line of fire traced against the BVH of
the exact collision triangles of the window (`tools/make_voxel_segments.py` output, 3 594 819 triangles; the BVH against the
python reference tracer is the check of `tests/parity.rs`). The landscape is the same file in all three, so the positions
differ only by what the objects do. Jensen, a target in a window of a building at (127, -205) (1.57 m and 4.45 m over the
landscape; the region `region_221_-229.rtri` holds it 56 m from its edge), DF_M2A1_50 (3 MOA, a numeric trajectory), range 200 m,
cell 2 m, 360 rays, 31 560 positions inside the 1 km window (the triangles exist there only). *False clear*: the run says
clear, the exact tracer blocked; *false blocked*: the other way.

```sh
node --import ./engine/tools/js/hooks.mjs engine/tools/js/heatmap_validate.mjs --served <heightmaps/jensen> \
  --region region_221_-229.rtri --tris jensen.tris.bin --window=-404,-1104,1000 --target=127,-205 \
  --weapon DF_M2A1_50 --height window:1,window:0 --range 200 --out <dir>
```

| 31 560 positions | window +1.57 m: voxel | + region | window +4.45 m: voxel | + region |
|---|---|---|---|---|
| exact tracer: clear / blocked | 1 081 / 30 306 | 1 081 / 30 306 | 3 033 / 28 354 | 3 033 / 28 354 |
| false CLEAR | 1 | **0** | 1 | **0** |
| false BLOCKED | 275 | **0** | 1 337 | **0** |
| shooter inside an object (out) differs from exact | 2 696 (315 of them clear by exact) | 607 (0 clear) | 2 696 (283 clear) | 607 (0) |

Other runs of the same tool: the target (131, -195) of a three-storey building (floor +3.30, roof +6.05, floor +0.30, the
landscape), same region: 0 false clear and 0 false blocked with the region at all four heights; without it false blocked 0 (floor +3.30),
126 (floor +0.30), 0 (roof) and 604 (landscape) and no false clear. The target (-93, -213) (floor +0.30), region `region_-29_-229.rtri` (5.04 MB, 2.78 M
triangles): 0 / 0 with the region, 0 false clear and 130 false blocked without it. The logs are in the issue.

These runs (and the table) are with the sample-lattice voxel file that is served today. **With the exact-voxeliser file**
(a staged copy of the Jensen directory with the new 85 476 B `volume.vcol`; the region file and `terrain.bin` unchanged, since
the region rebuilt from the new voxels is identical after gunzip) the building at (127, -205) no longer offers its windows:
the dialog's heights are `roof +6.30` only. In the old file the wall at y = -205 to -204.5 has a 0.5 m wide gap at
x = 127.0 to 127.5, the window; in the new file the voxels the frame triangles touch on both sides of it fill the wall
across x = 124 to 128 (read from the two decoded files at the heights 1.12 and 4.0 m), and `classifyColumn` finds no free space with
solid on both sides. The exact tracer still has the opening (1 081 clear positions for the window height in the old run),
so a thin opening is a case where the conservative voxels are wrong in the blocking direction and only the precision region
can recover it. The validation therefore ran on the roof and on the landscape of that target (31 560 positions):

| 31 560 positions | roof +6.30 m: voxel | + region | landscape: voxel | + region |
|---|---|---|---|---|
| exact tracer: clear / blocked | 8 685 / 22 702 | 8 685 / 22 702 | 1 725 / 29 662 | 1 725 / 29 662 |
| false CLEAR | 0 | 0 | 0 | 0 |
| false BLOCKED | 2 355 | **8** (all beyond 100 m from the target) | 717 | **0** |
| shooter inside an object (out) differs from exact | 2 793 (306 of them clear by exact) | 615 (0 clear) | 2 793 (527) | 615 (0) |

The other targets with the new file: (131, -195) (floors +3.30 and +0.30, roof +6.05, the landscape; region `region_221_-229.rtri`):
0 false clear and 0 false blocked with the region at all four heights; without it false blocked 0 (floor +3.30), 139 (floor
+0.30), 0 (roof) and 571 (landscape) and no false clear (old file: 0, 126, 0, 604). The target (-93, -213) (floor +0.30), region
`region_-29_-229.rtri`: 0 / 0 with the region, 0 false clear and 129 false blocked without it (old: 130). The output is in
`~/work/ui-shots/heat-val-exact/` of the build host. The browser check `heatmap_check.mjs` passes on a staged build with the
new file when told to use the roof (`--height roof:0 --reference heat-val-exact`: the page's run equals the validation's, 6 of
36 360 positions differ by one in value, 0 false clear and 8 false blocked as in the validation) and on the served build with
the old file as before (`--reference heat-val`, window).

How to read it:

* **The voxel walk blocks what grazes**: its false blocked are lines that pass within a voxel diagonal of a corner or a frame
  (mostly in the first 50 m for a window, where the frames are); the precision region removes them all inside its square.
  The few false clear of the old file were triangles that clip a voxel corner the sample-lattice builder lost; the exact-voxeliser file has none.
* **"Out" positions**: the shooter's body probe asks the same question as a line of fire. A voxel is marked when a
  triangle meets it, so a position beside a wall or under a tree can read as inside it while the exact triangles do not
  contain it; 315 and 283 positions that are clear by the exact tracer are lost that way without the region, none with it
  inside its square. The 607 that remain are beyond 56 m, outside the region.
* **Beams through a window are narrow**: a window 1 m wide seen from 100 m is 0.6 degrees wide, the rays are about
  1 degree apart, so a beam is drawn as a few thin spokes (a position between two rays takes the nearest). More rays would
  cost time linearly; the heatmap is a map of where to look, not a firing table.
* **Ground shooters only**: the shooter stands at the landscape's height (a shooter on a roof or an upper floor is not
  asked), at the weapon's muzzle height.

#### Time

Measured on 2026-11-05 in headless Chromium (153, the real WebAssembly engine in the volume worker, `tools/browser_check/heatmap_timing.mjs` of the
deployment repository) on tk104 (8 logical CPUs, Intel i5-9300HF) with the volume files of all 25 maps (the exact conservative builds) and
the host nearly idle (load average 1.8 at the start, no map build running). Per map: a target inside a building nearest the centre of the map
(a floor, a window or a doorway found by the vertical ray; the voxel files changed, so the targets are not those of the earlier table), DF_M2A1_50, the voxel
walk alone, at the ranges 600 m and 2000 m (80 480 positions each, cell 3.7 m and 12.5 m). *trace* is the worker's own time for all
the rays, *wall* the time from the request to the values in the page (it adds the messages between the batches); a position outside the
map or the landscape counts as out, so the big maps' 2000 m rows have fewer traced positions. Raw output: deadline-squad/deadline-squadcalc#22.

| map (side, volume file) | range | positions | trace, ms | per position, us | wall, ms | clear / blocked / out |
|---|---|---|---|---|---|---|
| Al Basrah (4.0 km, 6.7 MB) | 600 m | 80480 | 1769 | 22 | 1783 | 0 / 76095 / 4385 |
|  | 2000 m | 80480 | 5606 | 69.7 | 5618 | 0 / 77312 / 3168 |
| Anvil (3.1 km, 3.8 MB) | 600 m | 80480 | 1045 | 13 | 1056 | 369 / 76382 / 3729 |
|  | 2000 m | 80480 | 768 | 9.5 | 777 | 47 / 66740 / 13693 |
| Black Coast (4.6 km, 29.8 MB) | 600 m | 80480 | 2340 | 29.1 | 2351 | 84 / 77406 / 2990 |
|  | 2000 m | 80480 | 1749 | 21.7 | 1759 | 0 / 75823 / 4657 |
| Chora (4.1 km, 36.9 MB) | 600 m | 80480 | 3904 | 48.5 | 3917 | 28 / 77189 / 3263 |
|  | 2000 m | 80480 | 3586 | 44.6 | 3596 | 0 / 47081 / 33399 |
| Fallujah (3.0 km, 3.7 MB) | 600 m | 80480 | 1245 | 15.5 | 1258 | 167 / 72595 / 7718 |
|  | 2000 m | 80480 | 2875 | 35.7 | 2885 | 0 / 64440 / 16040 |
| Fool's Road (1.8 km, 6.2 MB) | 600 m | 80480 | 1111 | 13.8 | 1122 | 1234 / 77996 / 1250 |
|  | 2000 m | 80480 | 665 | 8.3 | 674 | 450 / 38795 / 41235 |
| Goose Bay (4.0 km, 15.0 MB) | 600 m | 80480 | 1009 | 12.5 | 1020 | 791 / 76971 / 2718 |
|  | 2000 m | 80480 | 2546 | 31.6 | 2555 | 122 / 77634 / 2724 |
| Gorodok (4.1 km, 39.3 MB) | 600 m | 80480 | 4207 | 52.3 | 4220 | 5302 / 71060 / 4118 |
|  | 2000 m | 80480 | 4738 | 58.9 | 4748 | 2755 / 74260 / 3465 |
| Harju (4.0 km, 41.2 MB) | 600 m | 80480 | 3868 | 48.1 | 3881 | 10189 / 66846 / 3445 |
|  | 2000 m | 80480 | 3228 | 40.1 | 3240 | 3211 / 72818 / 4451 |
| Jensen (4.0 km, 0.1 MB) | 600 m | 80480 | 1919 | 23.8 | 1933 | 0 / 77996 / 2484 |
|  | 2000 m | 80480 | 2850 | 35.4 | 2861 | 0 / 79033 / 1447 |
| Kamdesh (4.0 km, 14.4 MB) | 600 m | 80480 | 1627 | 20.2 | 1639 | 3263 / 75271 / 1946 |
|  | 2000 m | 80480 | 1507 | 18.7 | 1517 | 937 / 77845 / 1698 |
| Kohat (4.6 km, 2.0 MB) | 600 m | 80480 | 1334 | 16.6 | 1346 | 464 / 78310 / 1706 |
|  | 2000 m | 80480 | 3161 | 39.3 | 3170 | 0 / 79586 / 894 |
| Kokan (2.5 km, 0.7 MB) | 600 m | 80480 | 664 | 8.2 | 675 | 717 / 78626 / 1137 |
|  | 2000 m | 80480 | 1888 | 23.5 | 1898 | 475 / 53613 / 26392 |
| Lashkar (4.3 km, 13.3 MB) | 600 m | 80480 | 4268 | 53 | 4281 | 6889 / 71647 / 1944 |
|  | 2000 m | 80480 | 3364 | 41.8 | 3375 | 2457 / 76525 / 1498 |
| Logar (1.8 km, 1.3 MB) | 600 m | 80480 | 2551 | 31.7 | 2566 | 424 / 76662 / 3394 |
|  | 2000 m | 80480 | 936 | 11.6 | 945 | 37 / 38426 / 42017 |
| Manicouagan (4.0 km, 17.6 MB) | 600 m | 80480 | 1015 | 12.6 | 1030 | 67 / 76326 / 4087 |
|  | 2000 m | 80480 | 2224 | 27.6 | 2234 | 0 / 76960 / 3520 |
| Mestia (2.4 km, 7.6 MB) | 600 m | 80480 | 1521 | 18.9 | 1533 | 4587 / 71306 / 4587 |
|  | 2000 m | 80480 | 2751 | 34.2 | 2761 | 2571 / 44663 / 33246 |
| Mutaha (2.8 km, 1.0 MB) | 600 m | 80480 | 1416 | 17.6 | 1428 | 154 / 77519 / 2807 |
|  | 2000 m | 80480 | 2767 | 34.4 | 2779 | 0 / 60850 / 19630 |
| Narva (2.8 km, 6.0 MB) | 600 m | 80480 | 1275 | 15.8 | 1288 | 0 / 75762 / 4718 |
|  | 2000 m | 80480 | 2115 | 26.3 | 2137 | 0 / 61058 / 19422 |
| Pacific (4.0 km, 2.8 MB) | 600 m | 80480 | 684 | 8.5 | 695 | 6 / 76872 / 3602 |
|  | 2000 m | 80480 | 3162 | 39.3 | 3172 | 0 / 78250 / 2230 |
| Sanxian (4.6 km, 16.4 MB) | 600 m | 80480 | 1522 | 18.9 | 1532 | 149 / 76083 / 4248 |
|  | 2000 m | 80480 | 1099 | 13.6 | 1107 | 0 / 76634 / 3846 |
| Skorpo (6.8 km, 24.8 MB) | 600 m | 80480 | 1830 | 22.7 | 1842 | 4 / 77728 / 2748 |
|  | 2000 m | 80480 | 6164 | 76.6 | 6174 | 0 / 78505 / 1975 |
| Sumari (1.3 km, 1.0 MB) | 600 m | 80480 | 2805 | 34.9 | 2818 | 407 / 73444 / 6629 |
|  | 2000 m | 80480 | 871 | 10.8 | 881 | 39 / 24753 / 55688 |
| Tallil (4.7 km, 5.2 MB) | 600 m | 80480 | 1279 | 15.9 | 1293 | 450 / 78784 / 1246 |
|  | 2000 m | 80480 | 8665 | 107.7 | 8677 | 69 / 79686 / 725 |
| Yehorivka (6.3 km, 48.6 MB) | 600 m | 80480 | 2216 | 27.5 | 2229 | 1245 / 75452 / 3783 |
|  | 2000 m | 80480 | 3288 | 40.9 | 3299 | 367 / 76809 / 3304 |

* **0.7 to 8.7 s for 80 480 positions (median 2.0 s; 8 to 108 us per position, median 25 us)**, with the host idle. The earlier table
  of 11 maps (0.1 to 15 MB files built with the lattice method, host load average 22) read 2 to 26 s; most of that was load. The
  differences between rows are mostly how many positions are really traced (out and blocked-at-once positions are cheap), not the size
  of the map or of its voxel file: the biggest files (Yehorivka 48.6 MB, Harju 41.2 MB, Gorodok 39.3 MB, Chora 36.9 MB) take 2.2 to
  4.7 s, the slowest rows are Tallil at 2000 m (8.7 s) and Skorpo at 2000 m (6.2 s), where lines of fire run far through open
  voxels. The voxel walk costs the cells it crosses, so a position whose line of fire meets a wall at once is cheap and one that runs
  600 m through foliage is not. The page stays responsive (the worker does the work in batches of 8 rays and the status shows the
  share done); other questions to the volume worker (a line of fire) wait for the batch they come between.
* **With a precision region** the same Jensen target (the validation's, 36 000 positions at 200 m) took in Node's wasm, at a
  quieter moment, 1.0 to 1.5 s with the voxel walk and 1.9 to 2.2 s with the region, plus the region load, 7.1 to 7.7 s (1.93 MB;
  at the loaded moments 4 to 11 s, 6 to 13 s and 23 to 47 s; the 5.04 MB region with 2.78 M triangles: 31 s); in Chromium (`heatmap_check.mjs`, 80 480 positions at 589 m) 8.4 to 12.4 s voxel only,
  10.5 to 15.9 s with the region and 7.7 to 9.8 s to load it. The load is the build of the hierarchy of the region's triangles
  in wasm, ten times its native time (0.38 s + 3.3 s for the 2.78 M region); it is paid once per target.
* **GPU: not measured.** tk104 has no GPU (no `/dev/dri`, no `nvidia-smi`; Chromium's only WebGL/Vulkan device is SwiftShader, a
  CPU rasteriser). The WGSL kernel of the voxel walk (`engine/wgsl/voxel.wgsl`) was measured on SwiftShader only (7 200 and 11 400
  segments/s on a loaded host, about 19 000 on an idle one before; `wgsl/test/last-run-voxel.txt`), which says nothing about a GPU; the heatmap uses the wasm walk. Raw output:
  deadline-squad/deadline-squadcalc#22.

### Voxel DDA against the python model and the exact triangles

100 000 random segments per map (`tools/make_voxel_segments.py`: 70 % start within 3 m of an occupied voxel, lengths
3-500 m, inside the densest 1 km x 1 km window of the map, at least 0.25 m above the landscape, so the comparison is
about objects). Maps with a small `.vcol` from `~/data/volumetric/maps/`: **Jensen** (statics only, 85 KB, 3 594 819
triangles in the window) and **Kokan** (statics + foliage, 697 KB, 2 198 643 voxels, 8 085 424 triangles in the
window). Exact = the BVH of this crate on the Visibility-blocking triangles that `world_tris.py` gives for those
layers (the channel `build_columns.py` voxelises). The check inside `make_voxel_segments.py` rebuilds the voxels of the
window from those triangles with the builder itself: 0 voxels of the file are missing from the rebuild and 0 rebuilt
voxels above the landscape are missing from the file, so the file and the triangles describe the same scene.

The files are the ones the exact conservative voxeliser (`columns.py`, issue deadline-squad/deadline-squadcalc#23, agl
`e34e481`, memory fix `f116a2b`) wrote on 2026-11-05. Everything below was measured again with them; the figures of the
earlier sample-lattice builder are kept as the "old" columns. Because the segments are drawn from the file (70 % near an
occupied voxel), the 100 000 segments of the new run are not the same segments as the old run (exact blocked 30 071 against
29 732 on Jensen, 13 214 against 12 709 on Kokan); the same segments answered by the new file give 4.04 % and 8.51 % wrong
(false blocked 4 039 and 8 508, the side experiment recorded in issue #23), so the change is not an effect of the draw.

```sh
# the generator runs in the squadcalc-heightmaps-py image (numpy, scipy) with tools/volumetric/py and tools/heightmaps/py
# on PYTHONPATH and the landscape levels mounted (see tools/volumetric/README.md); <tris.npz> are world_tris.py shards
python3 tools/make_voxel_segments.py jensen jensen.vcol out/jensen <tris.npz>... --count 100000
ENGINE_VOXEL_DIR=out ENGINE_VOXEL_MAPS=jensen,kokan cargo test --release --features threads --test voxel_parity -- --ignored --nocapture
sh js/build.sh && node wgsl/test/run_voxel.mjs out jensen,kokan      # the WGSL kernel and the wasm build on the same segments
```

| 100 000 segments | Jensen old | Jensen | Kokan old | Kokan |
|---|---|---|---|---|
| **DDA vs the sampled python voxel model** (`models.py`, step 0.0833 m) | | | | |
| both clear / both blocked | 66 449 / 33 450 | 66 007 / 33 916 | 79 043 / 20 764 | 78 287 / 21 534 |
| DDA blocked, model clear | 101 | 77 | 193 | 179 |
| DDA clear, model blocked | **0** | **0** | **0** | **0** |
| **DDA vs the exact triangles** | | | | |
| exact blocked / clear | 29 732 / 70 268 | 30 071 / 69 929 | 12 709 / 87 291 | 13 214 / 86 786 |
| false CLEAR (voxels let a hit through) | 129 (14 grazing, 115 not) | **0** | 83 (9 grazing, 74 not) | **0** |
| false BLOCKED (voxels block, triangles do not) | 3 948 (2 637 grazing, 1 311 not) | 3 922 (2 607 grazing, 1 315 not) | 8 331 (3 840 grazing, 4 491 not) | 8 499 (4 055 grazing, 4 444 not) |
| wrong, of all segments | 4.08 % | **3.92 %** | 8.41 % | **8.50 %** |
| wrong without grazing | 1.43 % | **1.31 %** | 4.57 % | **4.44 %** |
| **WGSL kernel (f32, SwiftShader) vs the exact triangles** | | | | |
| false CLEAR / false BLOCKED | 128 / 3 948 | 0 / 3 922 | 83 / 8 330 | 0 / 8 499 |
| wrong / without grazing | 4.08 % / 1.43 % | 3.92 % / 1.31 % | 8.41 % / 4.56 % | 8.50 % / 4.44 % |
| **WGSL kernel vs the native f64 DDA** | | | | |
| blocked/clear flips, other first voxel | 1, 9 | 0, 9 | 1, 1 | 0, 0 |

How to read it:

* **Grazing** = the exact answer flips when the segment is moved 0.25 m up, down or sideways (the definition of
  `eval_los.py`). Those pairs are decided by sub-voxel placement and are counted apart.
* **False clear is gone.** The old builder marked a voxel only if a sample point of its barycentric lattice landed in
  it, so a triangle that clipped a voxel corner could be lost (115 + 74 not-grazing cases, every one of them a hit in a
  voxel that was empty in the file). The exact voxeliser marks every voxel a triangle meets: 0 false clear on both maps
  and, in the precision runs below, on Fallujah too. False blocked hardly moves: 3 948 -> 3 922 on Jensen and
  8 331 -> 8 499 on Kokan on the new draw; on the same segments the new files block 91 (Jensen) and 177 (Kokan) more
  (4 039 and 8 508), so the total is 0.04 points **better** on Jensen (129 false clear gone) and 0.10 points **worse** on
  Kokan (83 gone, 177 more). The conservative file has more voxels (673 122 -> 723 221 on Jensen, 2 007 949 -> 2 198 643
  on Kokan) and is smaller anyway (112 531 -> 85 476 B and 789 376 -> 696 798 B; probably because filled surfaces make
  longer runs, not checked). Thin openings can disappear, see
  "Openings" in `tools/volumetric/README.md`.
* **DDA against the python model.** The model samples every `min(cell, dz) / 3`; a sample is a point of the DDA's
  walk, so the model can never block where the DDA is clear (0). The 77 / 179 segments the DDA blocks and the model
  does not all cross the first voxel in a chord shorter than one sampling step (checked per segment in the test): the
  sampled model steps over a voxel corner, the DDA does not. For 162 / 180 segments both are blocked but the model's
  first blocked sample is further along than one step, for the same reason.
* **False blocked.** A voxel is marked when a triangle meets it, so a segment that enters a marked voxel can still pass
  up to a voxel diagonal (0.75 m) from the surface. Every one of the not-grazing cases (1 315 + 4 444) was checked: the
  voxel the DDA reports overlaps a triangle (exact triangle-box overlap test), and `tests/voxel_parity.rs` fails on any
  not-grazing disagreement that this does not explain (0 unexplained). Kokan has more because its foliage triangles are
  small and dense.
* **WGSL vs the native DDA** differ on 9 (Jensen) and 0 (Kokan) of 100 000 segments, all of them a different first
  voxel at a voxel face where the segment's f32 coordinates differ from f64 (no blocked/clear flip on either map); for
  each, the native DDA on the f32-rounded segment, or on a segment moved by 1 mm, gives the GPU's answer. In the same
  voxel the entry point differs by at most 7.5e-3 m.
* The wasm build equals the native DDA on all 200 000 segments.
* Speed on this machine (shared, load average 11 to 13, 100 000 segments, all threads): the DDA answers 518 700 (Jensen)
  and 570 500 (Kokan) segments/s; the BVH answers 22 800 and 12 400 segments/s **including its build** (4.4 s and 8.0 s;
  the older 917 000 and 838 000 did not count the build, so the two sets are not comparable). The BVH needs the triangles
  (hundreds of MB for these windows, GB for a whole map); the DDA needs the 85-697 KB file. The WGSL kernel runs 7 200
  (Jensen) and 11 400 (Kokan) segments/s on SwiftShader (a CPU, two cores here; the old 19 000 was measured on an idle
  host; no GPU was measured).

Full output: [`wgsl/test/last-run-voxel.txt`](wgsl/test/last-run-voxel.txt).

## Precision pass (`RTRI1`)

The voxel walk is wrong in a way that a bigger file does not fix: it blocks a segment that enters a marked voxel
but passes up to a voxel diagonal from the surface (false blocked, all of its errors on the exact voxel files). The earlier
sample-lattice builder also lost voxels, so the walk missed triangles in them (false clear); the exact voxeliser does not.
Around one chosen target the engine can therefore re-check with the
real triangles. `precision::PrecisionRegion` is built from the voxel columns of the map and a **region file**:

* The region is the square `centre +- 150 m` (X/Y, the frame of the voxel file) with the Visibility-blocking triangles
  of that square, built offline from the same `world_tris.py` shards as the voxels by
  `tools/volumetric/py/build_region.py`. Only triangles that a re-checked segment can hit are stored: a triangle is
  dropped when no occupied voxel lies within the margin of its box (buried under the landscape, or far from every
  voxel), repeated triangles are stored once, degenerate ones not at all.
* A segment is cut at the square. The parts **outside** are answered by the voxel walk. The part **inside** is clear
  when it stays farther than `margin` (default 0.6 m) from every occupied voxel, and is tested against the exact
  triangles when it comes closer (it meets the voxels grown by the margin, `VoxelColumns::dilated`; the margin is
  rounded up to whole voxels, so 0.6 m is 2 columns and 3 heights on a 0.5 m x 0.25 m grid). The first thing met wins.
  No penetration is modelled.
* `PrecisionRegion::query` returns the first obstacle (a voxel outside the square or a triangle of the region) and
  whether the exact pass ran; `first_block_along` does a whole trajectory. JSON: `environment.region_ref` next to
  `vcol_ref` (CLI: path of the `.rtri`; the region is built against the `vcol_ref` columns of the same request). WASM:
  `Engine.loadRegion(ref, vcolRef, bytes)`, `Engine.precisionFirstBlock(ref, vcolRef, segment)`.

```sh
# one file per target; the shards are the world_tris.py output (see tools/volumetric/README.md), the margin is stored in the file
python3 build_region.py map.vcol out/ --centre X Y --centre X Y --radius 150 --margin 0.6 statics.npz foliage.0.npz ...
```

File (`RegionFile`, gzip): the square, the margin, a quantisation origin, shared vertices (0.1 mm steps, zigzag-varint
deltas, numbered by first use) and triangle corner indices (zigzag-varint deltas). The layout is in
`precision::RegionFile`; `tests/precision.rs` checks that the Rust writer reproduces the Python builder's bytes before gzip.
A loaded region builds its triangle hierarchy (and the grown voxels of its square) once, at load.

Unit tests: `src/precision.rs` (every case of the pass on hand-made scenes, the file codec and damaged files),
`src/voxel.rs` (dilation), `src/io.rs` (JSON), `tests/precision.rs` (a file from `build_region.py`, the CLI),
`js/test/` (wasm), `tools/volumetric/tests/test_region.py` (builder).

### Measured on Jensen, Kokan and Fallujah

Measured on 2026-11-05 with the `.vcol` files of the exact conservative voxeliser (the files of
`~/data/volumetric/maps/`; the figures of the earlier sample-lattice builder are shown as "old" where they differ). The
100 000 segments are drawn again from the new files (see the voxel section above for what that changes), the exact answers
are the BVH on the window's triangles, one run of `tests/precision_parity.rs`. **The regions were rebuilt** from the new
voxel files with `build_region.py` (the old ones had been chosen by the old voxel set). Targets: a 4 x 4 grid of regions of
150 m radius over the 1 km window (250 m apart); each segment is answered with the region nearest to its **end** (the
target is where the line of fire ends); a second run uses the **start** as the target. Segments are 3-500 m long, so a long
one has most of its length outside the square, where only the voxels decide.

**Fallujah** (statics + foliage: `fallujah.vcol` holds the voxels of both layers, so the exact answer uses both,
72.1 M + 30.7 M triangles from `world_tris.py` shards of 5 M; the check inside `make_voxel_segments.py` finds 0 voxels
of the file missing from the rebuild and 0 rebuilt voxels above the landscape missing from the file; densest window
(-415, -845), 45.3 M triangles, 26.2 M voxels in the window, 3 721 024 B file) was run under caps (4 GB per python
process, 5 GB for the Rust test; the first run used 3 GB), which changes three things and nothing in the protocol itself:

* the exact tracer holds the window's triangles in slices of 5 M (`ENGINE_EXACT_SLICE_TRIANGLES`, tests/voxel_parity.rs):
  one hierarchy per slice in turn, the first hit is the nearest over the slices. On Jensen the sliced run gives
  byte-identical `exact.f64`, `grazing.u8` and `rust.f64` to the single-hierarchy run;
* the 16 regions hold 64.4 M triangles together, so `ENGINE_PRECISION_ONE_REGION_AT_A_TIME=1` loads one region while its
  segments are answered (the same region answers every segment; the time counts the queries only). Error counts are equal
  in both modes on Jensen;
* `build_region.py` encodes in chunks with int32 corners: the two densest regions (210, -220: 7.5 M triangles; 460,
  -220: 6.5 M) were killed at 3 GB by the earlier encoder. The bytes before gzip are the same as before (checked on random
  soups with repeated and degenerate triangles and on re-encoded regions of Jensen and Fallujah). This run built the
  regions four at a time under 4 GB without a failure.

The margin sweep with a region of the whole window was not run on Fallujah: 45.3 M triangles do not fit the cap.

```sh
python3 build_region.py <map>.vcol regions/<map> $(cat regions/<map>.centres) <tris.npz>...   # in the python image, 4 GB
ENGINE_VOXEL_DIR=out ENGINE_REGION_DIR=regions ENGINE_VOXEL_MAPS=jensen,kokan ENGINE_PRECISION_MARGINS=0,0.25,0.3,0.5,0.6,1.0 \
  cargo test --release --features threads --test precision_parity -- --ignored --nocapture
```

| 100 000 segments | Jensen voxel walk | Jensen precision pass | Kokan voxel walk | Kokan precision pass | Fallujah voxel walk | Fallujah precision pass |
|---|---|---|---|---|---|---|
| false CLEAR (of them grazing) | 0 | 0 | 0 | 1 (0) | 0 | 0 |
| false BLOCKED (of them grazing) | 3 922 (2 607) | 301 (195) | 8 499 (4 055) | 866 (420) | 5 682 (3 389) | 428 (257) |
| **wrong, all segments** | 3.92 % | **0.30 %** | 8.50 % | **0.87 %** | 5.68 % | **0.43 %** |
| **wrong without grazing** | 1.31 % | **0.11 %** | 4.44 % | **0.45 %** | 2.29 % | **0.17 %** |
| sent to the exact pass | - | 42.4 % | - | 37.4 % | - | 60.4 % |
| time per segment, one thread | 3.8 us | 6.2 us | 7.8 us | 10.6 us | 11.0 us * | 40.2 us * |
| with the start as the target: wrong / without grazing | | 0.01 % / 0.00 % (0 + 9) | | 0.11 % / 0.05 % (1 + 106) | | 0.03 % / 0.01 % (0 + 31) |

The same table before the exact voxeliser (old files, old segments, old regions):

| | Jensen walk -> pass | Kokan walk -> pass | Fallujah walk -> pass |
|---|---|---|---|
| false CLEAR | 129 -> 8 | 83 -> 4 | 494 -> 35 |
| false BLOCKED | 3 948 -> 279 | 8 331 -> 858 | 5 609 -> 409 |
| wrong, all / without grazing | 4.08 % / 1.43 % -> 0.29 % / 0.10 % | 8.41 % / 4.57 % -> 0.86 % / 0.47 % | 6.10 % / 2.60 % -> 0.44 % / 0.17 % |
| sent to the exact pass | 42.0 % | 37.0 % | 60.1 % |
| start as the target: wrong / without grazing | 0.00 % / 0.00 % (0 + 3) | 0.10 % / 0.05 % (0 + 103) | 0.04 % / 0.02 % (7 + 37) |

What changed: the voxel walk has no false clear any more (129 / 83 / 494 -> 0 / 0 / 0), so the precision pass loses the
false clear it inherited from lost voxels (8 / 4 / 35 -> 0 / 1 / 0). False blocked is where the two builders differ least:
the pass leaves 301 / 866 / 428 against 279 / 858 / 409, all of it on the stretches of the segments outside the 150 m
square, where only the voxels decide, and the conservative file blocks a few more of those. The total after the pass is
therefore **0.01 points worse on Jensen (0.29 -> 0.30 %) and Kokan (0.86 -> 0.87 %) and 0.01 better on Fallujah
(0.44 -> 0.43 %)**: the pass already removed almost everything, and what is left is the voxel walk outside the square,
which the exact voxeliser did not improve. The voxel walk alone is better on Jensen and Fallujah (4.08 -> 3.92 %,
6.10 -> 5.68 %) and 0.09 points worse on Kokan (8.41 -> 8.50 %).

The one false clear left (Kokan, the same segment with the target at either end, not grazing) is a ray 0.04 mm from the
shared edge of two foliage triangles of 5 cm; the region file stores vertices on a 0.1 mm lattice (`RTRI1`), which moves the
edge by up to 0.05 mm, and the segment passes between them (shifted 1 mm up it hits the region's triangle). Not a voxel
problem; it is the stated precision of the file.

\* Every time here is from the shared host (load average 11 to 14 on 8 cores when sampled between the runs; not recorded
per run). Fallujah was timed region by region (the voxel walk in file order), so compare its two times with each other,
not with the first four columns. The old run was at a load average of about 20 (69.8 / 50.0 us).

Region files (16 regions of 300 m x 300 m per map, margin 0.6 m, gzip), old in brackets where different:

| | Jensen (statics) | Kokan (statics + foliage) | Fallujah (statics + foliage) |
|---|---|---|---|
| smallest / median / largest file | 57 B (no triangles) / 100 KB / 5.0 MB | 1.04 MB / 2.48 MB / 3.52 MB | 6.48 MB / 15.9 MB / 26.0 MB |
| total of the 16 | 8.6 MB | 38.0 MB | 239.1 MB (239.2) |
| triangles per region | 0 - 2 778 978 | 315 743 - 1 097 271 (315 706 - 1 097 166) | 1 809 377 - 7 258 961 (1 809 268 - 7 258 717) |
| load (decode + hierarchy + grown voxels), native | 0.000 - 2.8 s (the 2.78 M region 0.19 + 2.6 s) | 0.2 - 0.9 s | 2.2 - 13.1 s (the 7.26 M region 1.0 + 12.1 s) |

The sizes and triangle counts hardly moved (a region keeps a triangle when an occupied voxel lies within the margin of its
box). The Jensen region `region_221_-229.rtri` is identical
to the published one after gunzip (6 650 334 bytes, equal byte for byte; only the gzip header's time stamp differs), so the
published file stays. The load times were taken on a loaded host.

The margin, measured with the exact triangles of the **whole window** available (one region, so the only errors left
are the ones the margin allows):

| margin (grid steps) | Jensen false clear / false blocked, sent to exact | Kokan false clear / false blocked, sent to exact |
|---|---|---|
| 0 m (0 columns, 0 heights) | 0 / 0, 34.0 % (old 129 / 0, 33.6 %) | 0 / 0, 21.7 % (old 83 / 0, 21.0 %) |
| 0.25 m (1, 1) | 0 / 0, 39.4 % (old 0 / 0, 39.1 %) | 0 / 0, 31.0 % (old 5 / 0, 30.7 %) |
| 0.3 m and 0.5 m (1, 2) | 0 / 0, 41.0 % (old 0 / 0, 40.8 %) | 0 / 0, 33.4 % (old 1 / 0, 33.0 %) |
| **0.6 m (2, 3)** | **0 / 0, 45.2 %** (old 0 / 0, 45.0 %) | **0 / 0, 41.1 %** (old 0 / 0, 40.7 %) |
| 1.0 m (2, 4) | 0 / 0, 46.6 % (old 0 / 0, 46.4 %) | 0 / 0, 43.2 % (old 0 / 0, 42.8 %) |

How to read it:

* **The margin sweep changed its meaning.** With the old builder a margin was needed to find the voxels the sampling had
  lost (129 and 83 false clear at margin 0, 1 at 0.3 m on Kokan). With the exact voxeliser every margin, including 0, is
  exact on these segments, because every voxel a triangle meets is in the file: the margin only buys sent-to-exact
  share, 34 % at 0 against 45 % at 0.6 m. **0.6 m is kept** because the regions already published (Jensen) were built with
  it and because the file served today is still the old lattice file, for which 0.6 m is the smallest tested margin with no
  wrong answer; once the exact files are served a margin of 0 (about a quarter fewer re-checks and a smaller region file)
  would give the same answers on these segments. That was not run with 150 m regions and is not changed here. The
  segments are not typical: 70 % of them start within 3 m of an occupied voxel, so a share this high says little about a
  real heatmap.
* **With the triangles available everywhere the pass is exact** on these segments (0 wrong at every margin), including
  the grazing ones; before, with margin 0 only the false blocked disappeared (the segment must enter a voxel to be
  re-checked) and the 129 / 83 false clear stayed.
* **What is left with a 150 m region** is geometry outside the square: the part of a segment beyond 150 m from its
  target is answered by the voxels alone (the target at the start reverses which end is precise: 0 + 9, 1 + 106 and 0 + 31
  wrong). A bigger radius costs file size, a smaller one precision. On Fallujah, where the 150 m regions hold
  1.8 - 7.3 M triangles, the wrong share after the pass is 0.43 % (0.17 % without grazing) and the start-as-target run
  leaves 31 wrong segments.
* **The cost**: 1.4-1.6 times the voxel walk per segment on one thread on Jensen and Kokan (3.8 -> 6.2 us, 7.8 -> 10.6 us;
  shared machine, so read it as an order of magnitude; the old run said 1.1-1.7), plus the file: 0.1 - 5 MB gzip on
  Jensen, 1 - 3.5 MB on Kokan, 6.5 - 26 MB on Fallujah (median 15.9 MB; a dense city is far from the other two maps), and
  one hierarchy build per loaded region (seconds for the densest regions, up to 13 s on Fallujah, more in wasm). The share
  sent to the exact pass is 60 % on Fallujah. The voxel file stays the only whole-map download.

Full output: [`tests/last-run-precision.txt`](tests/last-run-precision.txt).

## WebAssembly

```sh
cargo install wasm-bindgen-cli --version 0.2.130 --locked    # once
sh js/build.sh        # js/pkg (plain) and js/pkg-simd (SIMD128 triangle test)
node --test "js/test/*.test.mjs"  # loads the wasm in Node
```

`js/index.mjs` is the ES-module wrapper (`loadEngine`, `Engine.solve`, `loadBvh`, `loadHeightmap`, `loadVcol`,
`firstHit`, `voxelFirstBlock`, `buildBvh`, `segmentTriangle`). The SIMD128 build is the same code compiled with `-C target-feature=+simd128` and the
`simd` feature; the Node test checks that it returns the same `f32` results bit for bit as the scalar build.

Threads: the `threads` feature turns on rayon (parallel BVH build and batch queries) natively. In the browser it needs
`SharedArrayBuffer`, i.e. cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, configured by the site owner), and the `wasm-threads` feature
(`wasm-bindgen-rayon`), which needs a nightly toolchain with atomics and `-Z build-std`; that build is **not part of the
pinned stable toolchain and was not built or run here**.

## Notes on the model

* Trajectory segments are not integrated: every vertex is evaluated on the exact flight (closed-form parabola, motor
  along the axis, capped coast, or the game's 20 ms substeps for a motor along the path as the JS does) and a stretch is
  split until its middle is within `tolerance_m` of the chord. The apex is always a vertex. The tolerance is checked at
  the middle of each stretch, after a first split into 8 equal pieces.
* The query reproduces `reference.py`: a segment `p0 + t (p1 - p0)`, `t` in `[0, 1]`, hits a triangle on its edges and
  from either side; a segment with `|det| <= 1e-12` is parallel and misses.
