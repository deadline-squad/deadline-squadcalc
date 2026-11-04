# GPU benchmark (`engine/wgsl/bench`)

A static page that times the four WebGPU kernels (`trace_segments`, `trace_trajectories`, `heatmap`, `voxel_segments`) on
the machine that opens it, and checks a sample of every run against the float64 CPU mirrors. It exists to get real-GPU
numbers (plan item C9 of deadline-squad/deadline-squadcalc#22): the test server has no GPU, so `test/last-run.txt` only
holds SwiftShader (CPU) numbers.

## What to run

Needs Chrome or Edge 113+ (WebGPU on by default on Windows, macOS and ChromeOS; on Linux start Chrome with
`--enable-unsafe-webgpu --enable-features=Vulkan`) and Node.js or Python to serve the files. No install, no build.

```
cd engine/wgsl
python3 -m http.server 8000          # or: npx http-server -p 8000, or any static server (Windows: py -m http.server 8000)
```

Open <http://localhost:8000/bench/bench.html> (`localhost` is a secure context, `file://` does not work), leave the
defaults and press **Run**. Keep the tab in the foreground and the machine plugged in; do not run a game at the same time.

* Defaults: 1e4, 1e5, 1e6 segments for `trace_segments`, `trace_trajectories` (16 chords per trajectory) and `voxel_segments`;
  1e3, 1e4, 1e5 candidates for `heatmap` (one candidate is 2 arcs x 32 chords, about 130 rays); one warm-up run and the median of 5
  timed runs per size.
* A size is skipped when it does not fit the device's buffer limits, or when its projected time per run exceeds the budget
  (120 s by default), so a slow adapter finishes instead of hanging; skipped sizes are listed in the output.
* Expected duration: 10-60 s on a discrete GPU, a few minutes on an integrated one (a software adapter can take the whole
  budget per size: 15-20 min).
* On a laptop with two GPUs leave "prefer the high-performance GPU" ticked and check the printed adapter line.

## What to paste back

Press **Copy JSON** and paste it into the issue or the chat (the **Copy markdown table** button gives the readable table). The
JSON holds the adapter (vendor, architecture, device, description, `isFallbackAdapter`, features, all limits including
`maxStorageBufferBindingSize` and `maxComputeWorkgroupStorageSize`), the timer used, the settings, every row (median, min, max, wall
and GPU time, items per second, f64 check counts) and the skipped sizes. It contains no personal data except the browser
user-agent string.

## How it measures

* **Timer.** If the adapter has `timestamp-query` (the host `gpu.mjs` requests it), the GPU's own start and end stamps of the
  compute pass are the reported time (`medianGpuMs`); the wall clock from submit to `queue.onSubmittedWorkDone` is always
  recorded too (`medianWallMs`). Without the feature the wall clock is the reported time and the output says so. Chrome rounds
  timestamps to 100 microseconds unless started with `--enable-webgpu-developer-features`; at 1e4 items a kernel can be that short,
  so read the larger sizes for throughput.
* **Excluded:** buffer creation, upload and readback; **included:** nothing but the dispatch.
* **Correctness.** The warm-up run of every size is checked on a sample against `../test/bvh_tools.mjs` (`cpuTrace`,
  `cpuHeatCell`) and a float64 port of the voxel walk in `bench.mjs`: 2000 segments, 1000 trajectories, 150 heatmap candidates (300
  cells), 5000 voxel segments. As in `test/last-run.txt`, a few grazing disagreements are expected from `f32`; a row passes when at most
  0.5 % of the sample differ (voxel: differences that the f64 mirror on the f32-rounded segment does not reproduce).
* **Batches** are deterministic (seeded), so every machine times the same input.

## Fixtures (`fixture/`)

| File | Size | Content |
|---|---:|---|
| `bvh.bin` | 3.9 MB | BVH (engine `bvh.bin` layout) of the 60 000 Fallujah collision triangles nearest to the middle of the dense test window (a 12 m wide cut), built by `test/bvh_tools.mjs` |
| `jensen.vcol` | 117 KB | the Jensen voxel columns served by the site (109 334 columns, `VCOL1`) |

The BVH is small, so ray cost per segment is lower than on a whole map; the numbers rank devices and show scaling, they are not
the final per-map figure. To benchmark a bigger BVH, build it and replace `fixture/bvh.bin` (the page reads whatever is there):

```
# 1. triangles of the densest window as float32 [n, 9] (needs numpy and the Fallujah npz, see test/make_fixture.py)
python3 -I engine/wgsl/test/make_fixture.py <fallujah_tris.npz> ~/agl/tools/volumetric/py <dataDir> 20000 300 1
# 2. cut and index the nearest N triangles (N = 1 500 000 gives about 100 MB; keep it under maxStorageBufferBindingSize)
node engine/wgsl/bench/make_fixture.mjs <dataDir>/tris.bin engine/wgsl/bench/fixture/bvh.bin 1500000
```

or export a map with the Rust crate (`engine/`) and copy its `bvh.bin`. Other voxel maps: copy any `volume.vcol` to
`fixture/jensen.vcol`. `*.bin` is git-ignored except under `bench/fixture/`; do not commit a big file.

## Validation without a GPU

`node engine/wgsl/bench/run_headless.mjs [sizes] [heatmapSizes] [runs] [budgetSeconds]` drives the same page in headless Chromium
on SwiftShader. `last-run-swiftshader.txt` is its output: it proves the page, the kernels and the checks work, and is CPU
emulation, not a GPU measurement.

## Files

| File | Role |
|---|---|
| `bench.html`, `bench.mjs` | the page and the benchmark (imports `../gpu.mjs`, `../test/bvh_tools.mjs`) |
| `make_fixture.mjs` | cuts and indexes a BVH fixture from a triangle soup |
| `run_headless.mjs` | headless SwiftShader driver |
| `last-run-swiftshader.txt` | its recorded output |
