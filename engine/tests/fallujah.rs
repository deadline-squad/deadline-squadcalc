//! The BVH against the exact reference tracer on the collision triangles of Fallujah (72 098 154 triangles
//! blocking the Projectile channel, `tools/npz_to_bin.py`) with 100 000 random segments whose first hit was
//! computed by `tools/volumetric/py/reference.py` (`tools/make_segments.py`).
//!
//! Ignored by default (needs the data, about 8 GB of memory and a few minutes):
//!
//! ```text
//! ENGINE_FALLUJAH_DIR=~/work/engine-data cargo test --release --features threads --test fallujah -- --ignored --nocapture
//! ```
//!
//! The directory holds `fallujah_proj.bin`, `fallujah.segments.f64` and `fallujah.expected.f64`.

use squad_engine::bvh::{triangles_from_reader, BuildOptions, BvhSet, MAX_TRIANGLES};
use squad_engine::trace::first_hits;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::time::Instant;

fn read_f64(path: &PathBuf) -> Vec<f64> {
    std::fs::read(path)
        .unwrap()
        .chunks_exact(8)
        .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

#[test]
#[ignore = "needs the Fallujah data, see the module docs"]
fn bvh_agrees_with_the_reference_tracer_on_fallujah() {
    let dir = PathBuf::from(std::env::var("ENGINE_FALLUJAH_DIR").expect("ENGINE_FALLUJAH_DIR"));
    let segments: Vec<([f64; 3], [f64; 3])> = read_f64(&dir.join("fallujah.segments.f64"))
        .chunks_exact(6)
        .map(|s| ([s[0], s[1], s[2]], [s[3], s[4], s[5]]))
        .collect();
    let expected: Vec<(bool, f64)> = read_f64(&dir.join("fallujah.expected.f64"))
        .chunks_exact(2)
        .map(|e| (e[0] == 1.0, e[1]))
        .collect();
    assert_eq!(segments.len(), expected.len());

    let started = Instant::now();
    let soup = triangles_from_reader(BufReader::new(
        File::open(dir.join("fallujah_proj.bin")).unwrap(),
    ))
    .unwrap();
    println!(
        "loaded {} triangles in {:.1} s",
        soup.len(),
        started.elapsed().as_secs_f64()
    );

    let started = Instant::now();
    let set = BvhSet::build(soup, MAX_TRIANGLES, BuildOptions::default()).unwrap();
    println!(
        "built {} hierarchies, {} nodes, {} triangles in {:.1} s",
        set.parts.len(),
        set.node_count(),
        set.triangle_count(),
        started.elapsed().as_secs_f64()
    );
    for (i, part) in set.parts.iter().enumerate() {
        part.validate().unwrap_or_else(|e| panic!("part {i}: {e}"));
    }

    let started = Instant::now();
    let hits = first_hits(&set, &segments);
    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "{} segments traced in {elapsed:.2} s ({:.0} segments/s)",
        segments.len(),
        segments.len() as f64 / elapsed
    );

    let mut hit_disagreements = Vec::new();
    let mut worst_point = 0.0f64;
    let mut both_hit = 0usize;
    for (i, ((p0, p1), (expected_hit, expected_t))) in segments.iter().zip(&expected).enumerate() {
        let got = hits[i];
        if got.is_some() != *expected_hit {
            hit_disagreements.push(i);
            continue;
        }
        if let Some(hit) = got {
            both_hit += 1;
            let length =
                ((p1[0] - p0[0]).powi(2) + (p1[1] - p0[1]).powi(2) + (p1[2] - p0[2]).powi(2))
                    .sqrt();
            worst_point = worst_point.max((hit.t - expected_t).abs() * length);
        }
    }
    println!(
        "hit/no-hit disagreements: {}; segments both hit: {both_hit}; worst hit point difference: {worst_point:e} m",
        hit_disagreements.len()
    );
    for &i in hit_disagreements.iter().take(10) {
        println!(
            "  segment {i}: {:?} rust {:?} reference {:?}",
            segments[i], hits[i], expected[i]
        );
    }
    assert!(hit_disagreements.is_empty());
    assert!(worst_point <= 1e-6);
}
