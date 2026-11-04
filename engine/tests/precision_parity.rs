//! The precision pass (voxel walk away from geometry, exact triangles of a 150 m region near it) against the
//! exact triangle tracer, on the 100 000 random segments of `tools/make_voxel_segments.py`, next to the voxel walk
//! alone.
//!
//! Ignored by default. Needs the directory of `voxel_parity.rs` (run that test first: it writes
//! `<name>.exact.f64` and `<name>.grazing.u8`) plus the region files that
//! `tools/volumetric/py/build_region.py` writes for a grid of targets into `<dir>/regions/<name>/*.rtri`:
//!
//! ```text
//! ENGINE_VOXEL_DIR=~/work/voxel-data/parity ENGINE_REGION_DIR=~/work/voxel-data/regions \
//!   ENGINE_VOXEL_MAPS=jensen,kokan \
//!   cargo test --release --features threads --test precision_parity -- --ignored --nocapture
//! ```
//!
//! Every segment is answered with the region whose centre is nearest to its target (the segment's end, and in a
//! second run its start; the targets lie on a 250 m grid, so every end is inside a 300 m square). With
//! `ENGINE_PRECISION_MARGINS=0,0.3,0.6,1.0` the test also builds one region that covers the whole window from
//! `<name>.tris.bin` for each margin: the pass with the exact triangles available everywhere, which measures the
//! margin itself. Writes `<name>.precision.txt`.
//!
//! With `ENGINE_PRECISION_ONE_REGION_AT_A_TIME=1` a region is loaded only while its own segments are answered, for
//! maps whose 16 regions do not fit memory together (Fallujah: 35 M triangles). Each segment is still answered by
//! the same region and the time per segment counts the queries only, not the loading, but the segments are
//! answered region by region instead of in file order.

use squad_engine::bvh::{triangles_from_reader, Triangle};
use squad_engine::precision::{PrecisionRegion, RegionFile};
use squad_engine::voxel::VoxelColumns;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::Instant;

type Segment = ([f64; 3], [f64; 3]);

fn read_f64(path: &Path) -> Vec<f64> {
    std::fs::read(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .chunks_exact(8)
        .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

/// Disagreements with the exact tracer, split by whether the exact answer flips for a 0.25 m move.
#[derive(Default, Clone, Copy)]
struct Errors {
    false_clear: usize,
    false_clear_grazing: usize,
    false_blocked: usize,
    false_blocked_grazing: usize,
}

impl Errors {
    fn count(blocked: &[bool], exact: &[bool], grazing: &[u8]) -> Errors {
        let mut errors = Errors::default();
        for i in 0..blocked.len() {
            match (blocked[i], exact[i]) {
                (false, true) => {
                    errors.false_clear += 1;
                    errors.false_clear_grazing += usize::from(grazing[i] == 1);
                }
                (true, false) => {
                    errors.false_blocked += 1;
                    errors.false_blocked_grazing += usize::from(grazing[i] == 1);
                }
                _ => {}
            }
        }
        errors
    }

    fn wrong(&self) -> usize {
        self.false_clear + self.false_blocked
    }

    fn wrong_without_grazing(&self) -> usize {
        self.wrong() - self.false_clear_grazing - self.false_blocked_grazing
    }

    fn line(&self, label: &str, n: usize) -> String {
        format!(
            "{label:<44} false clear {:>4} ({:>3} grazing)  false blocked {:>5} ({:>5} grazing)  wrong {:.2} %  without grazing {:.2} %",
            self.false_clear,
            self.false_clear_grazing,
            self.false_blocked,
            self.false_blocked_grazing,
            100.0 * self.wrong() as f64 / n as f64,
            100.0 * self.wrong_without_grazing() as f64 / n as f64,
        )
    }
}

struct Targeted {
    files: Vec<PathBuf>,
    /// Empty when the regions are loaded one at a time.
    regions: Vec<PrecisionRegion>,
    centres: Vec<[f64; 2]>,
    file_bytes: Vec<usize>,
    triangles: Vec<usize>,
}

fn load_region(file: &Path, columns: &VoxelColumns) -> (PrecisionRegion, [f64; 2], usize) {
    let bytes = std::fs::read(file).unwrap();
    let started = Instant::now();
    let parsed = RegionFile::from_bytes(&bytes).unwrap();
    let decoded = started.elapsed().as_secs_f64();
    let b = parsed.bounds;
    let started = Instant::now();
    let region = PrecisionRegion::from_file(columns, parsed).unwrap();
    println!(
        "  {}: {} bytes, {} triangles, decoded in {:.3} s, hierarchy and grown voxels in {:.3} s",
        file.file_name().unwrap().to_string_lossy(),
        bytes.len(),
        region.triangle_count(),
        decoded,
        started.elapsed().as_secs_f64()
    );
    (
        region,
        [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0],
        bytes.len(),
    )
}

fn load_regions(dir: &Path, columns: &VoxelColumns, one_at_a_time: bool) -> Targeted {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rtri"))
        .collect();
    files.sort();
    let mut loaded = Targeted {
        files: files.clone(),
        regions: Vec::new(),
        centres: Vec::new(),
        file_bytes: Vec::new(),
        triangles: Vec::new(),
    };
    for file in &files {
        let (region, centre, bytes) = load_region(file, columns);
        loaded.centres.push(centre);
        loaded.file_bytes.push(bytes);
        loaded.triangles.push(region.triangle_count());
        if !one_at_a_time {
            loaded.regions.push(region);
        }
    }
    assert!(
        !loaded.files.is_empty(),
        "no .rtri files in {}",
        dir.display()
    );
    loaded
}

/// For each segment, the region whose centre is nearest to the point `target(segment)`.
fn assign(targeted: &Targeted, segments: &[Segment], at_start: bool) -> Vec<usize> {
    segments
        .iter()
        .map(|(p0, p1)| {
            let target = if at_start { p0 } else { p1 };
            let distance = |centre: &[f64; 2]| {
                (target[0] - centre[0])
                    .abs()
                    .max((target[1] - centre[1]).abs())
            };
            (0..targeted.centres.len())
                .min_by(|&a, &b| {
                    distance(&targeted.centres[a]).total_cmp(&distance(&targeted.centres[b]))
                })
                .unwrap()
        })
        .collect()
}

struct Run {
    blocked: Vec<bool>,
    rechecked: usize,
    micros_per_segment: f64,
}

/// One thread, in order, so that the time is the cost of one query. With `one_at_a_time` the segments of a region
/// are answered together while it is loaded, and the loading is not timed.
fn run_targeted(
    targeted: &Targeted,
    columns: &VoxelColumns,
    segments: &[Segment],
    assignment: &[usize],
    at_start: bool,
    one_at_a_time: bool,
) -> Run {
    let mut blocked = vec![false; segments.len()];
    let mut rechecked = 0;
    let mut spent = std::time::Duration::ZERO;
    let mut answer = |region: &PrecisionRegion, i: usize| {
        let (p0, p1) = &segments[i];
        let (from, to) = if at_start { (p1, p0) } else { (p0, p1) };
        let answered = region.query(columns, *from, *to);
        blocked[i] = answered.hit.is_some();
        rechecked += usize::from(answered.rechecked);
    };
    if one_at_a_time {
        for (index, file) in targeted.files.iter().enumerate() {
            let (region, _, _) = load_region(file, columns);
            let started = Instant::now();
            for i in (0..segments.len()).filter(|&i| assignment[i] == index) {
                answer(&region, i);
            }
            spent += started.elapsed();
        }
    } else {
        let started = Instant::now();
        for (i, &index) in assignment.iter().enumerate() {
            answer(&targeted.regions[index], i);
        }
        spent = started.elapsed();
    }
    Run {
        blocked,
        rechecked,
        micros_per_segment: spent.as_secs_f64() * 1e6 / segments.len() as f64,
    }
}

fn check_map(dir: &Path, regions_dir: &Path, name: &str) {
    let at = |suffix: &str| dir.join(format!("{name}.{suffix}"));
    let columns = VoxelColumns::from_bytes(&std::fs::read(at("vcol")).unwrap()).unwrap();
    let segments: Vec<Segment> = read_f64(&at("segments.f64"))
        .chunks_exact(6)
        .map(|s| ([s[0], s[1], s[2]], [s[3], s[4], s[5]]))
        .collect();
    let exact: Vec<bool> = read_f64(&at("exact.f64"))
        .iter()
        .map(|t| *t >= 0.0)
        .collect();
    let grazing = std::fs::read(at("grazing.u8")).unwrap();
    let n = segments.len();
    assert_eq!(exact.len(), n);
    assert_eq!(grazing.len(), n);

    let mut report = format!(
        "{name}: {n} segments, {} exact blocked\n",
        exact.iter().filter(|b| **b).count()
    );

    // The voxel walk alone, one thread
    let started = Instant::now();
    let voxel_only: Vec<bool> = segments
        .iter()
        .map(|(p0, p1)| columns.first_block(*p0, *p1).is_some())
        .collect();
    let voxel_micros = started.elapsed().as_secs_f64() * 1e6 / n as f64;
    let baseline = Errors::count(&voxel_only, &exact, &grazing);
    report += &format!("{}\n", baseline.line("voxel walk alone", n));
    report += &format!("  {voxel_micros:.2} us per segment (one thread)\n");

    println!("{name}: regions");
    let one_at_a_time =
        std::env::var("ENGINE_PRECISION_ONE_REGION_AT_A_TIME").is_ok_and(|v| v == "1");
    let targeted = load_regions(regions_dir, &columns, one_at_a_time);
    let total: usize = targeted.file_bytes.iter().sum();
    let mut sizes = targeted.file_bytes.clone();
    sizes.sort_unstable();
    report += &format!(
        "  {} regions of 300 m x 300 m: file bytes min {} median {} max {} total {}; triangles min {} max {}\n",
        sizes.len(),
        sizes[0],
        sizes[sizes.len() / 2],
        sizes[sizes.len() - 1],
        total,
        targeted.triangles.iter().min().unwrap(),
        targeted.triangles.iter().max().unwrap(),
    );
    for at_start in [false, true] {
        let assignment = assign(&targeted, &segments, at_start);
        let run = run_targeted(
            &targeted,
            &columns,
            &segments,
            &assignment,
            at_start,
            one_at_a_time,
        );
        let errors = Errors::count(&run.blocked, &exact, &grazing);
        let label = if at_start {
            "precision pass, target at the segment start"
        } else {
            "precision pass, target at the segment end"
        };
        report += &format!("{}\n", errors.line(label, n));
        report += &format!(
            "  sent to the exact pass {} = {:.2} %, {:.2} us per segment (one thread)\n",
            run.rechecked,
            100.0 * run.rechecked as f64 / n as f64,
            run.micros_per_segment
        );
        assert!(
            errors.wrong() <= baseline.wrong(),
            "the precision pass is worse than the voxel walk: {} > {}",
            errors.wrong(),
            baseline.wrong()
        );
    }

    if let Ok(margins) = std::env::var("ENGINE_PRECISION_MARGINS") {
        let window: Vec<f64> = {
            let text = std::fs::read_to_string(at("json")).unwrap();
            let json: serde_json::Value = serde_json::from_str(&text).unwrap();
            json["window"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect()
        };
        let bounds = [
            window[0],
            window[1],
            window[0] + window[2],
            window[1] + window[2],
        ];
        let soup: Vec<Triangle> =
            triangles_from_reader(BufReader::new(File::open(at("tris.bin")).unwrap())).unwrap();
        report += &format!(
            "exact triangles of the whole window ({} triangles) in every segment's reach:\n",
            soup.len()
        );
        for margin in margins.split(',') {
            let margin: f64 = margin.trim().parse().unwrap();
            let region = PrecisionRegion::new(&columns, bounds, margin, soup.clone()).unwrap();
            let started = Instant::now();
            let mut blocked = Vec::with_capacity(n);
            let mut rechecked = 0;
            for (p0, p1) in &segments {
                let answer = region.query(&columns, *p0, *p1);
                blocked.push(answer.hit.is_some());
                rechecked += usize::from(answer.rechecked);
            }
            let micros = started.elapsed().as_secs_f64() * 1e6 / n as f64;
            let errors = Errors::count(&blocked, &exact, &grazing);
            report += &format!(
                "{}\n",
                errors.line(&format!("margin {margin} m, region = window"), n)
            );
            report += &format!(
                "  sent to the exact pass {} = {:.2} %, {micros:.2} us per segment (one thread)\n",
                rechecked,
                100.0 * rechecked as f64 / n as f64
            );
        }
    }
    std::fs::write(at("precision.txt"), &report).unwrap();
    println!("{report}");
}

#[test]
#[ignore = "needs the data of voxel_parity.rs and build_region.py, see the module docs"]
fn the_precision_pass_agrees_with_the_exact_tracer_better_than_the_voxel_walk() {
    let dir = PathBuf::from(std::env::var("ENGINE_VOXEL_DIR").expect("ENGINE_VOXEL_DIR"));
    let regions = PathBuf::from(std::env::var("ENGINE_REGION_DIR").expect("ENGINE_REGION_DIR"));
    let maps = std::env::var("ENGINE_VOXEL_MAPS").unwrap_or_else(|_| "jensen,kokan".to_string());
    for name in maps.split(',') {
        check_map(&dir, &regions.join(name), name);
    }
}
