//! The voxel DDA against the sampled python voxel model (`tools/volumetric/py/models.py`) and against the exact
//! triangle tracer (the BVH of this crate on the map's collision triangles), on 100 000 random segments per map.
//!
//! Ignored by default (needs the data of `tools/make_voxel_segments.py`; a few minutes and 2-3 GB per map):
//!
//! ```text
//! ENGINE_VOXEL_DIR=~/work/voxel-data/parity ENGINE_VOXEL_MAPS=jensen,kokan \
//!   cargo test --release --features threads --test voxel_parity -- --ignored --nocapture
//! ```
//!
//! `ENGINE_EXACT_SLICE_TRIANGLES` (default: one hierarchy, 2^24 triangles) caps how many of the window's triangles are
//! held at once. A window with more (Fallujah: 37.9 M) is cut into slices of that many triangles in file order, each
//! slice gets its own hierarchy in turn, and the first hit of a segment is the nearest over the slices, which is
//! the answer of one hierarchy over all of them.
//!
//! For every map `<name>` the directory holds `<name>.vcol`, `<name>.segments.f64`, `<name>.python.f64`,
//! `<name>.ground.f32` and `<name>.tris.bin`. The test prints the table of the README and writes the results
//! the WGSL test (`engine/wgsl/test/run_voxel.mjs`) compares with: `<name>.rust.f64` (4 numbers per segment:
//! `t`, column, row, z of the DDA hit, -1 for a clear segment) and `<name>.exact.f64` (`t` of the first
//! triangle hit, -1 for clear), `<name>.grazing.u8` (1 where the exact answer flips when the segment moves by
//! 0.25 m).

use squad_engine::bvh::{triangles_from_reader, BuildOptions, BvhSet, Triangle, MAX_TRIANGLES};
use squad_engine::trace::{first_hits, Hit, Scene};
use squad_engine::voxel::{VoxelColumns, VoxelHit};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Instant;

type Segment = ([f64; 3], [f64; 3]);

/// How far a segment is moved to decide that a disagreement is a grazing case, metres.
const GRAZE_M: f64 = 0.25;

fn read_f64(path: &Path) -> Vec<f64> {
    std::fs::read(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .chunks_exact(8)
        .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

fn read_f32(path: &Path) -> Vec<f32> {
    std::fs::read(path)
        .unwrap()
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

fn length(segment: &Segment) -> f64 {
    let (p0, p1) = segment;
    ((p1[0] - p0[0]).powi(2) + (p1[1] - p0[1]).powi(2) + (p1[2] - p0[2]).powi(2)).sqrt()
}

/// The segment moved by `distance` up, down and to both sides (horizontally, across its direction).
fn shifted(segment: &Segment, distance: f64) -> [Segment; 4] {
    let (p0, p1) = segment;
    let side = {
        let (dx, dy) = (p1[0] - p0[0], p1[1] - p0[1]);
        let norm = dx.hypot(dy).max(1e-9);
        [-dy / norm * distance, dx / norm * distance, 0.0]
    };
    let moved = |s: [f64; 3]| {
        (
            [p0[0] + s[0], p0[1] + s[1], p0[2] + s[2]],
            [p1[0] + s[0], p1[1] + s[1], p1[2] + s[2]],
        )
    };
    [
        moved([0.0, 0.0, distance]),
        moved([0.0, 0.0, -distance]),
        moved(side),
        moved([-side[0], -side[1], 0.0]),
    ]
}

/// Length of the part of the segment inside the closed voxel box, metres (0 if it misses it).
fn chord_in_voxel(columns: &VoxelColumns, segment: &Segment, hit: VoxelHit) -> f64 {
    let origin = columns.origin();
    let low = [
        origin[0] + f64::from(hit.column) * columns.cell(),
        origin[1] + f64::from(hit.row) * columns.cell(),
        origin[2] + f64::from(hit.z) * columns.dz(),
    ];
    let high = [
        low[0] + columns.cell(),
        low[1] + columns.cell(),
        low[2] + columns.dz(),
    ];
    let (p0, p1) = segment;
    let (mut t_in, mut t_out) = (0.0f64, 1.0f64);
    for axis in 0..3 {
        let d = p1[axis] - p0[axis];
        if d == 0.0 {
            if p0[axis] < low[axis] || p0[axis] > high[axis] {
                return 0.0;
            }
            continue;
        }
        let (a, b) = ((low[axis] - p0[axis]) / d, (high[axis] - p0[axis]) / d);
        t_in = t_in.max(a.min(b));
        t_out = t_out.min(a.max(b));
    }
    if t_in > t_out {
        0.0
    } else {
        (t_out - t_in) * length(segment)
    }
}

/// Whether the triangle meets the closed box (separating axis test of Akenine-Moller, `f64`).
fn triangle_meets_box(triangle: &[[f32; 3]; 3], low: [f64; 3], high: [f64; 3]) -> bool {
    let centre = [
        (low[0] + high[0]) / 2.0,
        (low[1] + high[1]) / 2.0,
        (low[2] + high[2]) / 2.0,
    ];
    let half = [
        (high[0] - low[0]) / 2.0,
        (high[1] - low[1]) / 2.0,
        (high[2] - low[2]) / 2.0,
    ];
    let v: Vec<[f64; 3]> = triangle
        .iter()
        .map(|p| {
            [
                f64::from(p[0]) - centre[0],
                f64::from(p[1]) - centre[1],
                f64::from(p[2]) - centre[2],
            ]
        })
        .collect();
    let edges = [
        [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]],
        [v[2][0] - v[1][0], v[2][1] - v[1][1], v[2][2] - v[1][2]],
        [v[0][0] - v[2][0], v[0][1] - v[2][1], v[0][2] - v[2][2]],
    ];
    let separated = |axis: [f64; 3]| {
        let projected: Vec<f64> = v
            .iter()
            .map(|p| p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2])
            .collect();
        let radius = half[0] * axis[0].abs() + half[1] * axis[1].abs() + half[2] * axis[2].abs();
        let (min, max) = projected
            .iter()
            .fold((f64::MAX, f64::MIN), |(lo, hi), &x| (lo.min(x), hi.max(x)));
        min > radius || max < -radius
    };
    for axis in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
        if separated(axis) {
            return false;
        }
    }
    let normal = [
        edges[0][1] * edges[1][2] - edges[0][2] * edges[1][1],
        edges[0][2] * edges[1][0] - edges[0][0] * edges[1][2],
        edges[0][0] * edges[1][1] - edges[0][1] * edges[1][0],
    ];
    if separated(normal) {
        return false;
    }
    for edge in &edges {
        for unit in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
            let axis = [
                edge[1] * unit[2] - edge[2] * unit[1],
                edge[2] * unit[0] - edge[0] * unit[2],
                edge[0] * unit[1] - edge[1] * unit[0],
            ];
            if separated(axis) {
                return false;
            }
        }
    }
    true
}

/// Whether any triangle of the soup meets the voxel `hit` of `columns`.
fn voxel_holds_geometry(soup: &[Triangle], columns: &VoxelColumns, hit: VoxelHit) -> bool {
    let origin = columns.origin();
    let low = [
        origin[0] + f64::from(hit.column) * columns.cell(),
        origin[1] + f64::from(hit.row) * columns.cell(),
        origin[2] + f64::from(hit.z) * columns.dz(),
    ];
    let high = [
        low[0] + columns.cell(),
        low[1] + columns.cell(),
        low[2] + columns.dz(),
    ];
    soup.iter().any(|t| {
        (0..3).all(|a| {
            let (lo, hi) = (
                t[0][a].min(t[1][a]).min(t[2][a]),
                t[0][a].max(t[1][a]).max(t[2][a]),
            );
            f64::from(hi) >= low[a] && f64::from(lo) <= high[a]
        }) && triangle_meets_box(t, low, high)
    })
}

/// The window's triangles (`<name>.tris.bin`, nine `f32` each) read in slices, one hierarchy alive at a time.
struct Slices {
    path: PathBuf,
    triangles: usize,
    slice_triangles: usize,
}

impl Slices {
    fn new(path: PathBuf, slice_triangles: usize) -> Slices {
        let triangles = std::fs::metadata(&path).unwrap().len() as usize / 36;
        Slices {
            path,
            triangles,
            slice_triangles,
        }
    }

    /// Calls `visit` with the triangles and the hierarchy of every slice in file order.
    fn for_each(&self, mut visit: impl FnMut(&[Triangle], &BvhSet)) {
        let mut file = BufReader::new(File::open(&self.path).unwrap());
        let mut left = self.triangles;
        while left > 0 {
            let count = left.min(self.slice_triangles);
            let soup = triangles_from_reader((&mut file).take(count as u64 * 36)).unwrap();
            assert_eq!(soup.len(), count);
            let set = BvhSet::build(soup.clone(), MAX_TRIANGLES, BuildOptions::default()).unwrap();
            visit(&soup, &set);
            left -= count;
        }
    }

    /// The nearest hit of every segment over all slices.
    fn first_hits(&self, segments: &[Segment]) -> Vec<Option<Hit>> {
        let mut nearest: Vec<Option<Hit>> = vec![None; segments.len()];
        self.for_each(|_, set| {
            for (best, hit) in nearest.iter_mut().zip(first_hits(set, segments)) {
                if hit.is_some_and(|h| best.is_none_or(|b| h.t < b.t)) {
                    *best = hit;
                }
            }
        });
        nearest
    }
}

/// Sets `found[i]` for every `(i, voxel)` of `voxels` whose voxel holds a triangle of the soup. Voxels already found
/// are skipped; the rest are checked on up to four threads, because a soup of tens of millions of triangles is
/// scanned once per voxel.
fn mark_voxels_with_geometry(
    soup: &[Triangle],
    columns: &VoxelColumns,
    voxels: &[(usize, VoxelHit)],
    found: &mut [bool],
) {
    let pending: Vec<(usize, VoxelHit)> =
        voxels.iter().copied().filter(|&(i, _)| !found[i]).collect();
    if pending.is_empty() {
        return;
    }
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(4));
    let chunk = pending.len().div_ceil(threads);
    let holding: Vec<usize> = std::thread::scope(|scope| {
        let workers: Vec<_> = pending
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .filter(|&&(_, hit)| voxel_holds_geometry(soup, columns, hit))
                        .map(|&(i, _)| i)
                        .collect::<Vec<usize>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap())
            .collect()
    });
    for i in holding {
        found[i] = true;
    }
}

fn percent(part: usize, whole: usize) -> f64 {
    100.0 * part as f64 / whole.max(1) as f64
}

fn check_map(dir: &Path, name: &str) {
    let at = |suffix: &str| dir.join(format!("{name}.{suffix}"));
    let columns = VoxelColumns::from_bytes(&std::fs::read(at("vcol")).unwrap()).unwrap();
    let segments: Vec<Segment> = read_f64(&at("segments.f64"))
        .chunks_exact(6)
        .map(|s| ([s[0], s[1], s[2]], [s[3], s[4], s[5]]))
        .collect();
    let python = read_f64(&at("python.f64"));
    let ground = read_f32(&at("ground.f32"));
    assert_eq!(segments.len(), python.len());
    assert_eq!(segments.len(), ground.len());
    let step = columns.cell().min(columns.dz()) / 3.0;

    let slice_triangles = std::env::var("ENGINE_EXACT_SLICE_TRIANGLES")
        .map_or(MAX_TRIANGLES, |value| value.parse().unwrap());
    let slices = Slices::new(at("tris.bin"), slice_triangles);
    let triangles = slices.triangles;

    let started = Instant::now();
    let dda = columns.first_blocks(&segments);
    let dda_seconds = started.elapsed().as_secs_f64();
    let started = Instant::now();
    let exact = slices.first_hits(&segments);
    let exact_seconds = started.elapsed().as_secs_f64();

    // DDA against the sampled python model
    let (mut both_clear, mut both_blocked, mut skipped_first, mut dda_only, mut python_only) =
        (0, 0, 0, 0, 0);
    let mut worst_entry = 0.0f64;
    for (i, segment) in segments.iter().enumerate() {
        let sampled = (python[i] >= 0.0).then_some(python[i]);
        match (dda[i], sampled) {
            (None, None) => both_clear += 1,
            (None, Some(_)) => python_only += 1,
            (Some(hit), None) => {
                dda_only += 1;
                let chord = chord_in_voxel(&columns, segment, hit);
                assert!(
                    chord < step + 1e-9,
                    "segment {i}: the DDA hit {hit:?} but the sampled model saw nothing, chord {chord} m >= step {step} m"
                );
            }
            (Some(hit), Some(distance)) => {
                both_blocked += 1;
                let entry = hit.t * length(segment);
                // The first sample inside the first voxel is at most one step after the entry point
                if distance < entry - 1e-6 || distance > entry + step + 1e-6 {
                    skipped_first += 1;
                    let chord = chord_in_voxel(&columns, segment, hit);
                    assert!(
                        distance >= entry - 1e-6 && chord < step + 1e-9,
                        "segment {i}: entry {entry} m, sampled {distance} m, chord {chord} m"
                    );
                } else {
                    worst_entry = worst_entry.max(distance - entry);
                }
            }
        }
    }
    assert_eq!(
        python_only, 0,
        "the sampled model blocked where the DDA saw nothing"
    );

    // The segments the DDA and the exact triangles disagree on: whether a move of GRAZE_M changes the exact answer
    // (any slice hit by the moved segment) and whether a slice has a triangle in the voxel the DDA reports
    let disputed: Vec<usize> = (0..segments.len())
        .filter(|&i| dda[i].is_some() != exact[i].is_some())
        .collect();
    let mut moved_hit = vec![[false; 4]; segments.len()];
    let mut voxel_has_triangle = vec![false; segments.len()];
    let reported_voxels: Vec<(usize, VoxelHit)> = disputed
        .iter()
        .filter_map(|&i| dda[i].map(|hit| (i, hit)))
        .collect();
    slices.for_each(|soup, set| {
        for &i in &disputed {
            for (k, (p0, p1)) in shifted(&segments[i], GRAZE_M).iter().enumerate() {
                moved_hit[i][k] |= Scene::first_hit(set, *p0, *p1).is_some();
            }
        }
        mark_voxels_with_geometry(soup, &columns, &reported_voxels, &mut voxel_has_triangle);
    });

    // DDA against the exact triangles; a disagreement is grazing when the exact answer flips for a move of 0.25 m
    let (mut true_clear, mut true_blocked) = (0, 0);
    let (mut false_clear, mut false_clear_grazing, mut false_clear_ground) = (0, 0, 0);
    let (mut false_blocked, mut false_blocked_grazing, mut false_blocked_ground) = (0, 0, 0);
    let mut grazing = vec![0u8; segments.len()];
    let mut unexplained = Vec::new();
    let mut false_clear_empty_voxel = 0;
    for (i, segment) in segments.iter().enumerate() {
        let truth = exact[i].is_some();
        match (dda[i].is_some(), truth) {
            (false, false) => true_clear += 1,
            (true, true) => true_blocked += 1,
            (got, _) => {
                let flips = moved_hit[i].iter().any(|&hit| hit != truth);
                grazing[i] = u8::from(flips);
                if !flips {
                    match dda[i] {
                        // A voxel is marked when a triangle meets it: conservative quantisation, not a lost hit
                        Some(_) if !voxel_has_triangle[i] => unexplained.push(i),
                        Some(_) => {}
                        // The surface the segment meets lies in a voxel that the file leaves empty
                        None => {
                            let hit = exact[i].unwrap();
                            let (p0, p1) = segment;
                            let point = [0, 1, 2].map(|a| p0[a] + hit.t * (p1[a] - p0[a]));
                            let origin = columns.origin();
                            let index = |a: usize, size: f64| {
                                ((point[a] - origin[a]) / size).floor().max(0.0) as u32
                            };
                            if columns.is_occupied(
                                index(0, columns.cell()),
                                index(1, columns.cell()),
                                index(2, columns.dz()),
                            ) {
                                unexplained.push(i);
                            } else {
                                false_clear_empty_voxel += 1;
                            }
                        }
                    }
                }
                let near_ground = ground[i] < 0.5;
                if got {
                    false_blocked += 1;
                    false_blocked_grazing += usize::from(flips);
                    false_blocked_ground += usize::from(near_ground && !flips);
                } else {
                    false_clear += 1;
                    false_clear_grazing += usize::from(flips);
                    false_clear_ground += usize::from(near_ground && !flips);
                }
            }
        }
    }

    let mut rust = Vec::with_capacity(segments.len() * 32);
    for hit in &dda {
        let cells = hit.map_or([-1.0; 4], |h| {
            [h.t, f64::from(h.column), f64::from(h.row), f64::from(h.z)]
        });
        for value in cells {
            rust.extend(value.to_le_bytes());
        }
    }
    std::fs::write(at("rust.f64"), rust).unwrap();
    let exact_t: Vec<u8> = exact
        .iter()
        .flat_map(|hit| hit.map_or(-1.0, |h| h.t).to_le_bytes())
        .collect();
    std::fs::write(at("exact.f64"), exact_t).unwrap();
    std::fs::write(at("grazing.u8"), &grazing).unwrap();

    let n = segments.len();
    let truth_blocked = true_blocked + false_clear;
    let wrong = false_clear + false_blocked;
    let wrong_free = wrong - false_clear_grazing - false_blocked_grazing;
    let table = format!(
        "{name}: {n} segments, {} voxels in {} columns, {triangles} triangles\n\
         DDA {dda_seconds:.2} s ({:.0} segments/s), BVH with its build {exact_seconds:.2} s ({:.0} segments/s)\n\
         DDA vs python voxel model (sampled every {step:.4} m):\n\
         \x20 both clear {both_clear}, both blocked {both_blocked} (first sample within {worst_entry:.4} m of the entry for all but {skipped_first})\n\
         \x20 DDA blocked / model clear {dda_only} (all with a chord in the voxel under one step), DDA clear / model blocked {python_only}\n\
         DDA vs exact triangles ({truth_blocked} segments blocked, {} clear):\n\
         \x20 both blocked {true_blocked}, both clear {true_clear}\n\
         \x20 false CLEAR   {false_clear} ({false_clear_grazing} grazing, {} not grazing, {false_clear_ground} of those within 0.5 m of the ground)\n\
         \x20 false BLOCKED {false_blocked} ({false_blocked_grazing} grazing, {} not grazing, {false_blocked_ground} of those within 0.5 m of the ground)\n\
         \x20 wrong {wrong} = {:.2} %, without grazing {wrong_free} = {:.2} %\n\
         \x20 not grazing, explained: false blocked in a voxel that holds a triangle, false clear where the voxel under the hit is empty in the file ({false_clear_empty_voxel} of {}); not explained: {} {:?}\n",
        columns.voxel_count(),
        columns.column_count(),
        n as f64 / dda_seconds,
        n as f64 / exact_seconds,
        n - truth_blocked,
        false_clear - false_clear_grazing,
        false_blocked - false_blocked_grazing,
        percent(wrong, n),
        percent(wrong_free, n),
        false_clear - false_clear_grazing,
        unexplained.len(),
        &unexplained[..unexplained.len().min(20)],
    );
    std::fs::write(at("table.txt"), &table).unwrap();
    println!("{table}");
    assert!(
        unexplained.is_empty(),
        "disagreements that the voxel quantisation does not explain: {unexplained:?}"
    );
    assert!(
        percent(wrong_free, n) < 5.0,
        "more than 5 % of the segments are wrong without grazing"
    );
}

#[test]
#[ignore = "needs the data of tools/make_voxel_segments.py, see the module docs"]
fn the_dda_agrees_with_the_python_model_and_the_exact_tracer() {
    let dir = PathBuf::from(std::env::var("ENGINE_VOXEL_DIR").expect("ENGINE_VOXEL_DIR"));
    let maps = std::env::var("ENGINE_VOXEL_MAPS").unwrap_or_else(|_| "jensen,kokan".to_string());
    for name in maps.split(',') {
        check_map(&dir, name);
    }
}
