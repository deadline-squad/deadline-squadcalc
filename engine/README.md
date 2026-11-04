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
(Fallujah statics at 0.5 m x 0.25 m: 4.7 MB gzip). `voxel::VoxelColumns::from_bytes` reads the file of
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
two files that `tools/volumetric/py/publish_volume.py` put next to the 1 m heightmap: `volume.vcol` (this section's
`VCOL1`) and `terrain.bin` (`TER1`, landscape-only heights with the landscape holes, `src/js/volumeTerrain.js`). It starts
only when the user turned the *Object volumes in the line of fire* setting on and `meta.json` has a `volume` entry
(file names, sizes, sha256, grid); a map without the entry, a missing engine or a failed download keeps the heightmap.
The page's heights count from the heightmap's lowest level (`meta.json` `z_min_m`), the files hold the game's Z.

* Line of fire (`SquadFiringSolution.getObstacle`): the trajectory is sampled every metre like the heightmap check
  (3 m at both ends skipped), each segment is tested with `voxelFirstBlock`, each point against the landscape. A hole
  of a building passes, a closed window or door is solid. Until the worker answers the heightmap's result stands.
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

### Position heatmap (reverse positions)

`src/js/positionHeatmap.js` answers the question the fire coverage asks the other way round: for a chosen target (at the
height chosen for it) which ground positions around it, up to the weapon's range, have a clear line of fire to it, and
how good a position each is. Direct-fire weapons only (those with a sight and a MOA, `type: "directFire"`). The page
side is `src/js/squadPositionHeatmap.js` (a button in the target dialog, loaded on demand, drawn as a canvas image over
the map like the coverage), the computation runs in the volume worker (`heatInit`, `heatRays`, `heatFinish` messages of
`volumeWorker.js`, `SquadVolume.positionHeatmap`) with the engine.

* **Positions** lie on rays from the target (at least 360, at most 1440, neighbours about two cells apart at the edge),
  every `cell = max(2 m, range / 160)` metres; the range is the weapon's, at most 2000 m (the ballistic ranges of the
  weapons reach tens of kilometres). The landscape profile of a ray (TER1 heights, sampled every 1 to 3 m) is read once for
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

How to read it:

* **The voxel walk blocks what grazes**: its false blocked are lines that pass within a voxel diagonal of a corner or a frame
  (mostly in the first 50 m for a window, where the frames are); the precision region removes them all inside its square.
  The few false clear are triangles that clip a voxel corner the builder lost.
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

Measured in headless Chromium (153, the real WebAssembly engine in the volume worker, `tools/browser_check/heatmap_timing.mjs` of the
deployment repository) on tk104 (8 logical CPUs, Intel i5-9300HF) **while the host was loaded: the load average was 22**, from the
map builds that run there, so read the numbers as an order of magnitude, not as a benchmark. Per map: a target inside a building
nearest the centre of the map (a floor, a window or a doorway found by the vertical ray), DF_M2A1_50, the voxel walk alone, at the
ranges 600 m and 2000 m (80 480 positions each, cell 3.7 m and 12.5 m). *trace* is the worker's own time for all the rays,
*wall* the time from the request to the values in the page (it adds the messages between the batches); a position outside the
map or the landscape counts as out, so the big maps' 2000 m rows have fewer traced positions.

| map (side, volume file) | range | positions | trace, ms | per position, us | wall, ms | clear / blocked / out |
|---|---|---|---|---|---|---|
| Jensen (4.0 km, 0.1 MB) | 600 m | 80480 | 12827 | 159.4 | 13152 | 0 / 78065 / 2415 |
|  | 2000 m | 80480 | 10881 | 135.2 | 10987 | 0 / 79051 / 1429 |
| Kokan (2.5 km, 0.8 MB) | 600 m | 80480 | 1745 | 21.7 | 1830 | 770 / 78669 / 1041 |
|  | 2000 m | 80480 | 13720 | 170.5 | 14113 | 486 / 53627 / 26367 |
| Logar (1.8 km, 1.4 MB) | 600 m | 80480 | 13090 | 162.6 | 13258 | 371 / 76940 / 3169 |
|  | 2000 m | 80480 | 6413 | 79.7 | 6591 | 10 / 38534 / 41936 |
| Sumari (1.3 km, 1.0 MB) | 600 m | 80480 | 11719 | 145.6 | 11866 | 422 / 73659 / 6399 |
|  | 2000 m | 80480 | 2521 | 31.3 | 2646 | 39 / 24821 / 55620 |
| Kohat (4.6 km, 2.3 MB) | 600 m | 80480 | 5834 | 72.5 | 5913 | 1087 / 77912 / 1481 |
|  | 2000 m | 80480 | 26312 | 326.9 | 26406 | 188 / 79361 / 931 |
| Pacific (4.0 km, 2.9 MB) | 600 m | 80480 | 5157 | 64.1 | 5407 | 83 / 77450 / 2947 |
|  | 2000 m | 80480 | 11941 | 148.4 | 12163 | 15 / 78753 / 1712 |
| FoolsRoad (1.8 km, 6.1 MB) | 600 m | 80480 | 7108 | 88.3 | 7310 | 1263 / 77986 / 1231 |
|  | 2000 m | 80480 | 7028 | 87.3 | 7174 | 466 / 38787 / 41227 |
| Mestia (2.4 km, 7.4 MB) | 600 m | 80480 | 10239 | 127.2 | 10461 | 4693 / 72010 / 3777 |
|  | 2000 m | 80480 | 20032 | 248.9 | 20149 | 2639 / 45071 / 32770 |
| Fallujah (3.0 km, 5.1 MB) | 600 m | 80480 | 3878 | 48.2 | 3999 | 254 / 73052 / 7174 |
|  | 2000 m | 80480 | 20805 | 258.5 | 20903 | 8 / 64653 / 15819 |
| Kamdesh (4.0 km, 14.3 MB) | 600 m | 80480 | 5891 | 73.2 | 6085 | 3564 / 75165 / 1751 |
|  | 2000 m | 80480 | 5781 | 71.8 | 5853 | 1033 / 77907 / 1540 |
| GooseBay (4.0 km, 15.4 MB) | 600 m | 80480 | 2371 | 29.5 | 2446 | 0 / 78552 / 1928 |
|  | 2000 m | 80480 | 9722 | 120.8 | 9812 | 0 / 78100 / 2380 |

* **Typically 5 to 20 s for 80 000 positions on this loaded host (2 to 26 s over all rows; about 20 to 330 us per position, median about 105)**; the
  differences between rows are mostly the load of the moment and how many positions are traced (out and blocked-at-once positions
  are cheap), not the size of the map or of its voxel file: the voxel walk costs the cells it crosses, so a position whose line
  of fire meets a wall at once is cheap and one that runs 600 m through foliage is not. The page stays responsive (the worker
  does the work in batches of 8 rays and the status shows the share done); other questions to the volume worker (a line of
  fire) wait for the batch they come between.
* **With a precision region** the same Jensen target (the validation's, 36 000 positions at 200 m) took in Node's wasm, at a
  quieter moment, 1.0 to 1.5 s with the voxel walk and 1.9 to 2.2 s with the region, plus the region load, 7.1 to 7.7 s (1.93 MB;
  at the loaded moments 4 to 11 s, 6 to 13 s and 23 to 47 s; the 5.04 MB region with 2.78 M triangles: 31 s); in Chromium (`heatmap_check.mjs`, 80 480 positions at 589 m) 8.4 to 12.4 s voxel only,
  10.5 to 15.9 s with the region and 7.7 to 9.8 s to load it. The load is the build of the hierarchy of the region's triangles
  in wasm, ten times its native time (0.38 s + 3.3 s for the 2.78 M region); it is paid once per target.
* **GPU: not measured.** tk104 has no GPU (no `/dev/dri`, no `nvidia-smi`; Chromium's only WebGL/Vulkan device is SwiftShader, a
  CPU rasteriser). The WGSL kernel of the voxel walk (`engine/wgsl/voxel.wgsl`) was measured on SwiftShader only (about 19 000
  segments/s, `wgsl/test/last-run-voxel.txt`), which says nothing about a GPU; the heatmap uses the wasm walk. Raw output:
  deadline-squad/deadline-squadcalc#22.

### Voxel DDA against the python model and the exact triangles

100 000 random segments per map (`tools/make_voxel_segments.py`: 70 % start within 3 m of an occupied voxel, lengths
3-500 m, inside the densest 1 km x 1 km window of the map, at least 0.25 m above the landscape, so the comparison is
about objects). Maps with a small `.vcol` from `~/data/volumetric/maps/`: **Jensen** (statics only, 117 KB, 3 594 819
triangles in the window) and **Kokan** (statics + foliage, 789 KB, 2 007 949 voxels, 8 085 424 triangles in the
window). Exact = the BVH of this crate on the Visibility-blocking triangles that `world_tris.py` gives for those
layers (the channel `build_columns.py` voxelises). The check inside `make_voxel_segments.py` rebuilds the voxels of the
window from those triangles with the builder itself: 0 voxels of the file are missing from the rebuild and 0 rebuilt
voxels above the landscape are missing from the file, so the file and the triangles describe the same scene.

```sh
# the generator runs in the squadcalc-heightmaps-py image (numpy, scipy) with tools/volumetric/py and tools/heightmaps/py
# on PYTHONPATH and the landscape levels mounted (see tools/volumetric/README.md); <tris.npz> are world_tris.py shards
python3 tools/make_voxel_segments.py jensen jensen.vcol out/jensen <tris.npz>... --count 100000
ENGINE_VOXEL_DIR=out ENGINE_VOXEL_MAPS=jensen,kokan cargo test --release --features threads --test voxel_parity -- --ignored --nocapture
sh js/build.sh && node wgsl/test/run_voxel.mjs out jensen,kokan      # the WGSL kernel and the wasm build on the same segments
```

| 100 000 segments | Jensen | Kokan |
|---|---|---|
| **DDA vs the sampled python voxel model** (`models.py`, step 0.0833 m) | | |
| both clear / both blocked | 66 449 / 33 450 | 79 043 / 20 764 |
| DDA blocked, model clear | 101 | 193 |
| DDA clear, model blocked | **0** | **0** |
| **DDA vs the exact triangles** | | |
| exact blocked / clear | 29 732 / 70 268 | 12 709 / 87 291 |
| false CLEAR (voxels let a hit through) | 129 (14 grazing, 115 not) | 83 (9 grazing, 74 not) |
| false BLOCKED (voxels block, triangles do not) | 3 948 (2 637 grazing, 1 311 not) | 8 331 (3 840 grazing, 4 491 not) |
| wrong, of all segments | 4.08 % | 8.41 % |
| wrong without grazing | **1.43 %** | **4.57 %** |
| **WGSL kernel (f32, SwiftShader) vs the exact triangles** | | |
| false CLEAR / false BLOCKED | 128 / 3 948 | 83 / 8 330 |
| wrong / without grazing | 4.08 % / 1.43 % | 8.41 % / 4.56 % |
| **WGSL kernel vs the native f64 DDA** | | |
| blocked/clear flips, other first voxel | 1, 9 | 1, 1 |

How to read it:

* **Grazing** = the exact answer flips when the segment is moved 0.25 m up, down or sideways (the definition of
  `eval_los.py`). Those pairs are decided by sub-voxel placement and are counted apart.
* **DDA against the python model.** The model samples every `min(cell, dz) / 3`; a sample is a point of the DDA's
  walk, so the model can never block where the DDA is clear (0). The 101 / 193 segments the DDA blocks and the model
  does not all cross the first voxel in a chord shorter than one sampling step (checked per segment in the test): the
  sampled model steps over a voxel corner, the DDA does not. For 174 / 216 segments both are blocked but the model's
  first blocked sample is further along than one step, for the same reason.
* **False blocked.** A voxel is marked when a triangle meets it, so a segment that enters a marked voxel can still pass
  up to a voxel diagonal (0.75 m) from the surface. Every one of the not-grazing cases (1 311 + 4 491) was checked: the
  voxel the DDA reports overlaps a triangle (exact triangle-box overlap test). Kokan has more because its foliage
  triangles are small and dense.
* **False clear.** In all 115 + 74 not-grazing cases the voxel that holds the exact hit point is empty in the file: the
  builder marks a voxel only if a sample point of its barycentric lattice (spacing 0.45 of the smallest voxel edge,
  `columns.py`) lands in it, so a triangle that clips a voxel corner can be lost. The DDA itself never loses a voxel of
  the file (0 DDA-clear / model-blocked above); `tests/voxel_parity.rs` fails on any not-grazing disagreement that
  neither this nor the previous point explains.
* **WGSL vs the native DDA** differ on 10 (Jensen) and 2 (Kokan) of 100 000 segments, at a voxel face where the
  segment's f32 coordinates differ from f64; for each, the native DDA on the f32-rounded segment, or on a segment moved
  by 1 mm, gives the GPU's answer. In the same voxel the entry point differs by at most 9.1e-3 m.
* The wasm build equals the native DDA on all 200 000 segments.
* Speed on this machine (shared, 100 000 segments, all threads): the DDA answers 416 000 (Jensen) and 167 000 (Kokan)
  segments/s, the BVH 917 000 and 838 000. The BVH is faster but needs the triangles (hundreds of MB for these windows,
  GB for a whole map); the DDA needs the 117-789 KB file. The WGSL kernel runs about 19 000 segments/s on SwiftShader
  (a CPU; no GPU was measured).

Full output: [`wgsl/test/last-run-voxel.txt`](wgsl/test/last-run-voxel.txt).

## Precision pass (`RTRI1`)

The voxel walk is wrong in two ways that a bigger file does not fix: it blocks a segment that enters a marked voxel
but passes up to a voxel diagonal from the surface (false blocked, most of its errors), and it misses a triangle in a
voxel the builder's sampling lost (false clear). Around one chosen target the engine can therefore re-check with the
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

### Measured on Jensen and Kokan

The same 100 000 segments, voxel files and exact answers (BVH on the window's triangles) as in the table above, one
run of `tests/precision_parity.rs`. Targets: a 4 x 4 grid of regions of 150 m radius over the 1 km window (250 m
apart); each segment is answered with the region nearest to its **end** (the target is where the line of fire ends);
a second run uses the **start** as the target. Segments are 3-500 m long, so a long one has most of its length
outside the square, where only the voxels decide.

```sh
python3 build_region.py <map>.vcol regions/<map> $(cat regions/<map>.centres) <tris.npz>...   # in the python image, 3 GB
ENGINE_VOXEL_DIR=out ENGINE_REGION_DIR=regions ENGINE_VOXEL_MAPS=jensen,kokan ENGINE_PRECISION_MARGINS=0,0.25,0.3,0.5,0.6,1.0 \
  cargo test --release --features threads --test precision_parity -- --ignored --nocapture
```

| 100 000 segments | Jensen voxel walk | Jensen precision pass | Kokan voxel walk | Kokan precision pass |
|---|---|---|---|---|
| false CLEAR (of them grazing) | 129 (14) | 8 (1) | 83 (9) | 4 (1) |
| false BLOCKED (of them grazing) | 3 948 (2 637) | 279 (185) | 8 331 (3 840) | 858 (391) |
| **wrong, all segments** | 4.08 % | **0.29 %** | 8.41 % | **0.86 %** |
| **wrong without grazing** | 1.43 % | **0.10 %** | 4.57 % | **0.47 %** |
| sent to the exact pass | - | 42.0 % | - | 37.0 % |
| time per segment, one thread | 7.7 us | 8.9 us | 12.1 us | 14.4 us |
| with the start as the target: wrong / without grazing | | 0.00 % / 0.00 % (0 + 3) | | 0.10 % / 0.05 % (0 + 103) |

Region files (16 regions of 300 m x 300 m per map, margin 0.6 m, gzip):

| | Jensen (statics) | Kokan (statics + foliage) |
|---|---|---|
| smallest / median / largest file | 57 B (no triangles) / 100 KB / 5.0 MB | 1.04 MB / 2.48 MB / 3.52 MB |
| total of the 16 | 8.6 MB | 38.0 MB |
| triangles per region | 0 - 2 778 978 | 315 706 - 1 097 166 |
| load (decode + hierarchy + grown voxels), native | 0.001 - 3.7 s (the 2.78 M region 0.38 + 3.3 s) | 0.4 - 1.4 s |

The margin, measured with the exact triangles of the **whole window** available (one region, so the only errors left
are the ones the margin allows):

| margin (grid steps) | Jensen false clear / false blocked, sent to exact | Kokan false clear / false blocked, sent to exact |
|---|---|---|
| 0 m (0 columns, 0 heights) | 129 / 0, 33.6 % | 83 / 0, 21.0 % |
| 0.25 m (1, 1) | 0 / 0, 39.1 % | 5 / 0, 30.7 % |
| 0.3 m and 0.5 m (1, 2) | 0 / 0, 40.8 % | 1 / 0, 33.0 % |
| **0.6 m (2, 3)** | **0 / 0, 45.0 %** | **0 / 0, 40.7 %** |
| 1.0 m (2, 4) | 0 / 0, 46.4 % | 0 / 0, 42.8 % |

How to read it:

* **The margin 0.6 m is kept**: it is the smallest of the tested values with no wrong answer on both maps (0.3 m
  leaves one false clear on Kokan). The price is the share sent to the exact pass, 41-45 % here. These segments are
  not typical: 70 % of them start within 3 m of an occupied voxel, so a share this high says little about a real
  heatmap.
* **With the triangles available everywhere the pass is exact** on these segments (0 wrong at 0.6 m), including the
  grazing ones; with margin 0 only the false blocked disappear (the segment must enter a voxel to be re-checked) and
  the 129 / 83 false clear stay: they are hits in voxels the builder lost, and a lost voxel is found only when a
  marked voxel is within reach.
* **What is left with a 150 m region** is geometry outside the square: the part of a segment beyond 150 m from its
  target is answered by the voxels alone (the target at the start reverses which end is precise: 0 + 3 and 0 + 103
  wrong). A bigger radius costs file size, a smaller one precision.
* **The cost**: 1.1-1.7 times the voxel walk per segment on one thread (shared machine, so read it as an order of
  magnitude), plus the file: 0.1 - 5 MB gzip on Jensen, 1 - 3.5 MB on Kokan, and one hierarchy build per loaded
  region (seconds for the densest regions, more in wasm). The voxel file stays the only whole-map download.

Full output: [`tests/last-run-precision.txt`](tests/last-run-precision.txt).

## WebAssembly

```sh
cargo install wasm-bindgen-cli --version 0.2.130 --locked    # once
sh js/build.sh        # js/pkg (plain) and js/pkg-simd (SIMD128 triangle test)
node --test js/test/  # loads the wasm in Node
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
