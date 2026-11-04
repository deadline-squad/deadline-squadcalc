//! Timed benchmark of the BVH on a triangle soup: build time, then segments per second for the `f64`
//! and `f32` first-hit queries.
//!
//! ```text
//! cargo run --release --features threads --example bench -- <triangles.bin> <segments.f64> [threads]
//! ```
//!
//! `triangles.bin` is nine little-endian `f32` per triangle (`tools/npz_to_bin.py`), `segments.f64` six
//! little-endian `f64` per segment (`tools/make_segments.py`).

use squad_engine::bvh::{triangles_from_reader, BuildOptions, BvhSet, MAX_TRIANGLES};
use squad_engine::trace::{first_hits, Scene};
use std::fs::File;
use std::io::BufReader;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let soup = triangles_from_reader(BufReader::new(File::open(&args[1]).unwrap())).unwrap();
    let segments: Vec<([f64; 3], [f64; 3])> = std::fs::read(&args[2])
        .unwrap()
        .chunks_exact(48)
        .map(|b| {
            let f = |i: usize| f64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
            ([f(0), f(1), f(2)], [f(3), f(4), f(5)])
        })
        .collect();
    println!("{} triangles, {} segments", soup.len(), segments.len());

    let started = Instant::now();
    let set = BvhSet::build(soup, MAX_TRIANGLES, BuildOptions::default()).unwrap();
    println!(
        "build: {:.2} s -> {} hierarchies, {} nodes ({:.0} MB), {:.0} MB of triangles",
        started.elapsed().as_secs_f64(),
        set.parts.len(),
        set.node_count(),
        set.node_count() as f64 * 32.0 / 1e6,
        set.triangle_count() as f64 * 48.0 / 1e6
    );

    let started = Instant::now();
    let hits = first_hits(&set, &segments);
    let seconds = started.elapsed().as_secs_f64();
    println!(
        "f64 first_hit, all threads: {seconds:.3} s, {:.0} segments/s ({} hit)",
        segments.len() as f64 / seconds,
        hits.iter().flatten().count()
    );

    let started = Instant::now();
    let single = segments
        .iter()
        .filter(|(a, b)| set.first_hit(*a, *b).is_some())
        .count();
    let seconds = started.elapsed().as_secs_f64();
    println!(
        "f64 first_hit, 1 thread: {seconds:.3} s, {:.0} segments/s ({single} hit)",
        segments.len() as f64 / seconds
    );

    let started = Instant::now();
    let single = segments
        .iter()
        .filter(|(a, b)| {
            let (a, b) = (
                [a[0] as f32, a[1] as f32, a[2] as f32],
                [b[0] as f32, b[1] as f32, b[2] as f32],
            );
            set.parts
                .iter()
                .any(|part| part.first_hit_f32(a, b).is_some())
        })
        .count();
    let seconds = started.elapsed().as_secs_f64();
    println!(
        "f32 first_hit (every part tested, no box pruning between parts), 1 thread: {seconds:.3} s, {:.0} segments/s ({single} hit)",
        segments.len() as f64 / seconds
    );
}
