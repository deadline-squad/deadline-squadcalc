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
* Heightmap grid: row 0 is the northern edge, `X = col * resolution`, `Y = -row * resolution` (SquadCalc's `lng`,
  `-lat`). Between samples each quad is two triangles split along the diagonal from `(row, col)` to
  `(row + 1, col + 1)`, as in `src/js/squadHeightmaps.js`; a point more than half a sample outside the grid has height 0.
  Raw `.g16`: `u32` width, `u32` height, then `u16` samples, little endian, row 0 first.
* `elevation_mrad` is the elevation of the sight in milliradians (the weapon's angle offset taken off the barrel's).
  `null` fields and `occlusion_status: "no_solution"` mean the target cannot be reached.
* `occlusion_status`: `clear`, `occluded` (the path meets a BVH triangle or the terrain before the target; the terrain
  is checked every heightmap sample, leaving out 3 m at both ends like SquadCalc), `unchecked` (no heightmap, no
  BVH), `no_solution`.
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

RESULTS_PLACEHOLDER

## WebAssembly

```sh
cargo install wasm-bindgen-cli --version 0.2.130 --locked    # once
sh js/build.sh        # js/pkg (plain) and js/pkg-simd (SIMD128 triangle test)
node --test js/test/  # loads the wasm in Node
```

`js/index.mjs` is the ES-module wrapper (`loadEngine`, `Engine.solve`, `loadBvh`, `loadHeightmap`, `firstHit`,
`buildBvh`, `segmentTriangle`). The SIMD128 build is the same code compiled with `-C target-feature=+simd128` and the
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
