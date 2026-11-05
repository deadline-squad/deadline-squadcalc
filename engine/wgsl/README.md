# engine/wgsl - WebGPU compute side of the Squad ballistics engine

Two WGSL compute shaders that read the BVH exported by the Rust core (`engine/`), plus a JS host and a test
harness that runs them on a real WebGPU device.

| File | Role |
|---|---|
| `bvh_common.wgsl` | BVH structs, bindings 1-2, `trace_closest()`: stackless slab + Moller-Trumbore traversal. Prepended to the other two files by `gpu.mjs` (WGSL has no `#include`). |
| `trace.wgsl` | Entry points `trace_segments` (one invocation per ray segment) and `trace_trajectories` (one invocation per trajectory of N segments, returns the first occluded one). |
| `heatmap.wgsl` | Entry point `heatmap`: one invocation per candidate firing position, both arcs. |
| `voxel.wgsl` | Entry point `voxel_segments`: one invocation per segment, first occupied voxel of a `VCOL1` file by voxel-column DDA (no BVH). |
| `gpu.mjs` | Host: `parseBvh`, `requestDevice` (also asks for `timestamp-query` when offered), `BallisticsGpu` (`traceSegments`, `traceTrajectories`, `heatmap`), `VoxelGpu`; every kernel call returns `elapsedMs` (submit to done) and `gpuMs` (GPU timestamps, `null` without the feature). Runs in a browser or any WebGPU runtime. |
| `bench/` | Static GPU benchmark page (`bench.html`): times all four kernels on the opener's own GPU and checks them against the f64 mirrors, see `bench/README.md`. |
| `test/` | `make_fixture.py` (real Fallujah triangles + exact float64 reference), `bvh_tools.mjs` (test-only JS BVH exporter and f64 CPU mirrors), `run.mjs` (the test run). |

## BVH layout (read, never changed here)

`bvh.bin` = `u32 node_count, u32 tri_count`, nodes, triangles, little endian.

* node, 32 bytes: `{ min.xyz f32, u32 a, max.xyz f32, u32 b }`
  * `a` escape index: next node when the ray misses the box or the subtree is finished, `0xFFFFFFFF` ends the traversal.
  * `b` = `first_triangle << 8 | triangle_count` for a leaf (count 1..255), `0` for an inner node whose first child is node `index + 1`.
* triangle: 3 x `vec4<f32>` (xyz, pad) = 48 bytes, in leaf order. The reported triangle id is the position in this array.

Because `first_triangle` has 24 bits, one BVH addresses at most 16 777 215 triangles.

## Bindings (group 0, identical layout for all three entry points)

| binding | `trace_segments` / `trace_trajectories` | `heatmap` |
|---|---|---|
| 0 uniform | `Params` (32 B: count, node_count, flags, tri_base, seg_per_traj, end_trim f32, 2 pad) | `HeatParams` (112 B, see the struct comments) |
| 1 storage, read | nodes | nodes |
| 2 storage, read | triangles | triangles |
| 3 storage, read | segments: 2 x `vec4` per segment (p0, p1; w unused) | heightmap: u16 samples, two per u32, row-major |
| 4 storage, read_write | `SegmentHit` x count (32 B: point.xyz, t, tri, seg, 2 pad) | `Cell` x 2 per candidate (16 B: state, clearance, weight, path fraction) |

`SegmentHit.t` is the fraction of the segment (`p0 + t (p1 - p0)`), `1.0` and `tri = 0xFFFFFFFF` on a miss.
For `trace_trajectories`, `seg` is the index (within the trajectory) of the first occluded segment, `0xFFFFFFFF` if clear.

## Execution model

* `@workgroup_size(64)`, one invocation per item, linear index `gid.y * num_workgroups.x * 64 + gid.x`; `gid.y` is used when more than 65 535 groups (4.19 M items) are needed, the host does this automatically.
* Each invocation writes only its own slot: no atomics, no races. Local state is fixed: a node index, the closest hit and a few vectors; there is no stack and no recursion. The traversal loop is bounded by `node_count` steps.
* Boxes are padded by 1 mm and the Moller-Trumbore test is double sided, with the same `|det| <= 1e-12` rule as `reference.py`.

## Heatmap

For a target `(x, y, z)` and a grid of candidate firing positions the shader samples the ground height
(bilinear, 16-bit, `zMin + raw * (zMax - zMin) / 65535`), puts the muzzle `muzzleHeight` above it, solves
`tan a = (v0^2 -/+ sqrt(v0^4 - g (g D^2 + 2 dz v0^2))) / (g D)` (low / high arc; `g = 9.80 * gravity scale`, as in
`squadFiringSolution.js`), cuts the vacuum parabola `z(x) = x tan a - g x^2 (1 + tan^2 a) / (2 v0^2)` into
`chords` (default 32) chords and traces them. Chords lie under the true arc (it is concave), so a result of
"blocked" is slightly pessimistic by at most `g D^2 / (8 v0^2 chords^2)` metres. `g` must be > 0.

Cell fields: `state` 0 clear / 1 blocked / 2 unreachable with `v0`; `clearance` the smallest vertical gap (m, capped at
the probe length, default 20 m) between an interior path point and the BVH surface below it (0 if blocked);
`weight = D0 / (D0 + D)` (D0 = `distanceScale`; 1 on the target, 0.5 at D0, a heavy tail so long range stays viable);
`path fraction` where the first hit lies (blocked) or 1.

## Voxel kernel (`voxel.wgsl`)

Stand-alone (it does not use `bvh_common.wgsl`). `f32` in grid-local metres: the host subtracts the grid origin in
`f64` (`VoxelGpu.traceSegments` does this). Same walk as `voxel::VoxelColumns::first_block` in the Rust core, see the
engine README.

| binding | content |
|---|---|
| 0 uniform | `Params` (count, column_count, width, height, cell, dz) |
| 1 storage, read | column ids, sorted (binary search) |
| 2 storage, read | first run of each column (`column_count + 1` entries) |
| 3 storage, read | runs: `[start, end)` height-index pairs, two `u32` per run |
| 4 storage, read | segments: 2 x `vec4` per segment (p0, p1) |
| 5 storage, read_write | `VoxelHit` x count (16 B: `t` f32, `column`, `row`, `z`; clear = `column` `0xFFFFFFFF`) |

`parseVcol` (`DecompressionStream`) turns the file into the three arrays; `VoxelGpu.create` uploads them.

## Limits and splitting a BVH over the binding limit

* The WebGPU default `maxStorageBufferBindingSize` is 128 MiB (134 217 728 B); `requestDevice()` asks for the adapter's maximum instead (1 GiB on the SwiftShader adapter used for the tests; typical desktop GPUs 2-4 GiB). `maxBufferSize` and `maxComputeInvocationsPerWorkgroup` (>= 256) are no issue for 64 threads.
* Per binding: 128 MiB holds 4 194 304 nodes (32 B) or 2 796 202 triangles (48 B). Nodes are about 0.5-2 per triangle with 1-4 triangles per leaf, so the triangles buffer binds first: about 2.7 M triangles per chunk on a default device.
* To split: partition the triangle soup spatially (for example a kd split on the scene bounds) into parts that each fit, build one BVH per part, and pass them all as `chunks` to `BallisticsGpu.create`. `traceSegments` then runs one pass per chunk over the same `hits[]` buffer with `flags = ACCUMULATE` and `tri_base` = the number of triangles in the earlier chunks: later chunks only shorten `t_max` to the closest hit found so far, so the result equals a single BVH. Triangle ids are global in chunk order. Order the chunks by proximity to the ray bundle if you want the early-out to help.
* Limits of the split: `traceTrajectories` and `heatmap` use the first chunk only (they would need the closest hit across chunks for every chord); for these keep the relevant area in one BVH. A single BVH is also capped at 2^24 - 1 triangles by the leaf encoding.

## Last verified run

Full output: `test/last-run.txt`. Device: headless Chromium WebGPU on the SwiftShader software adapter (CPU, no GPU on the
test server). Window 100 x 100 m of Fallujah, 1 574 368 triangles, 1 048 575 BVH nodes, 20 000 random segments.

* GPU f32 vs exact float64: 19 979 of 20 000 segments agree; 21 hit/no-hit disagreements, all grazing (segment ends exactly on a
  triangle centroid, or the line misses an edge by at most 1.5e-5 m). No other disagreement, no wrong triangle beyond ties.
* `reference.py` itself is wrong on 22 of the 20 000 segments (its tile list is sampled every 2 m along the segment and can skip a
  tile whose triangle the segment clips); float64 brute force over all triangles was used to adjudicate, and the float64 BVH
  traversal agrees with it on every segment. 11 more segments hit coplanar duplicate triangles with a different id at equal t.
* `trace_trajectories`: 1 500 trajectories x 16 chords, 0 mismatches against the float64 first occluded segment.
* Two-chunk accumulate vs one BVH: 0 differing segments. Heatmap: 784 candidates x 2 arcs, 0 state mismatches vs the float64 mirror.
* Throughput on SwiftShader: about 20 000 segments/s (200 000-segment dispatch, kernel only). This is a CPU number; real GPUs are not measured.
* `naga` 30.0.1 validates both concatenated shaders ("Validation successful", no warnings); Chromium's tint compiles them with 0 messages.
* Voxel kernel (`run_voxel.mjs`, Jensen and Kokan, 100 000 segments each): see `test/last-run-voxel.txt` and the table in `engine/README.md`. tint compiles `voxel.wgsl` with 0 messages; the wasm build equals the native DDA on all segments; GPU vs native f64 DDA differs on 9 / 0 segments (a different first voxel, no blocked/clear flip), all explained by `f32` rounding at voxel faces; against the exact triangles 1.31 % (Jensen) and 4.44 % (Kokan) of segments are wrong without counting grazing pairs (files of the exact voxeliser, 2026-11-05; 1.43 % and 4.56 % with the earlier sample-lattice files). 7 200 and 11 400 segments/s on SwiftShader (a CPU, two cores of a loaded host; about 19 000 on an idle one before).

## Tests

```
python3 -I engine/wgsl/test/make_fixture.py <fallujah_tris.npz> ~/agl/tools/volumetric/py <dataDir> 20000 100 1   # numpy needed
node engine/wgsl/test/run.mjs <dataDir>
```

`run.mjs` starts headless Chromium (`playwright-core`, env `PLAYWRIGHT_CORE`, `CHROME`) with
`--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-features=Vulkan,UseSkiaRenderer --use-gl=angle --use-angle=swiftshader`.
This server has no GPU and no Mesa Vulkan driver; Chromium ships SwiftShader (a CPU Vulkan implementation), which gives a real
`navigator.gpu` device (`architecture: swiftshader`). Numbers from it measure a CPU, not a GPU. Set `EXPORTED_BVH=/path/bvh.bin`
to trace the same segments through the Rust exporter's file as well. Shader validation is also done with `naga` 30.0.1 on the
concatenated sources (`cat bvh_common.wgsl trace.wgsl > x.wgsl && naga x.wgsl`).

Voxel kernel (needs `sh engine/js/build.sh` first; data from `engine/tools/make_voxel_segments.py`, see `engine/README.md`):

```
node engine/wgsl/test/run_voxel.mjs <dataDir> jensen,kokan
```
