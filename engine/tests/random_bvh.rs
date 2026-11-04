//! BVH against brute force on a random soup (runs everywhere; the Fallujah test is the full-scale version),
//! and the `f32` GPU-parity traversal against the `f64` one.

use squad_engine::bvh::{BuildOptions, Bvh, BvhSet, Triangle};
use squad_engine::trace::{segment_triangle_f64, Scene};

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn soup(n: usize, rng: &mut Lcg) -> Vec<Triangle> {
    (0..n)
        .map(|_| {
            let o = [rng.next() * 200.0, rng.next() * 200.0, rng.next() * 50.0];
            let mut v = || {
                [
                    (o[0] + rng.next() * 6.0) as f32,
                    (o[1] + rng.next() * 6.0) as f32,
                    (o[2] + rng.next() * 6.0) as f32,
                ]
            };
            [v(), v(), v()]
        })
        .collect()
}

fn segments(n: usize, rng: &mut Lcg) -> Vec<([f64; 3], [f64; 3])> {
    (0..n)
        .map(|_| {
            let p0 = [rng.next() * 200.0, rng.next() * 200.0, rng.next() * 50.0];
            let len = 5.0 + rng.next() * 120.0;
            let (az, el) = (rng.next() * std::f64::consts::TAU, (rng.next() - 0.5) * 1.2);
            let p1 = [
                p0[0] + len * el.cos() * az.sin(),
                p0[1] + len * el.cos() * az.cos(),
                p0[2] + len * el.sin(),
            ];
            (p0, p1)
        })
        .collect()
}

fn brute_force(bvh: &Bvh, p0: [f64; 3], p1: [f64; 3]) -> Option<f64> {
    let d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    bvh.triangles
        .iter()
        .filter_map(|t| segment_triangle_f64(p0, d, t))
        .min_by(f64::total_cmp)
}

#[test]
fn first_hit_equals_brute_force_over_every_triangle() {
    let mut rng = Lcg(42);
    let triangles = soup(20_000, &mut rng);
    let bvh = Bvh::build(&triangles, BuildOptions::default()).unwrap();
    let set = BvhSet::build(triangles, 3_000, BuildOptions::default()).unwrap();
    assert!(set.parts.len() > 1);
    let mut hit = 0;
    for (p0, p1) in segments(5_000, &mut rng) {
        let expected = brute_force(&bvh, p0, p1);
        assert_eq!(bvh.first_hit(p0, p1).map(|h| h.t), expected);
        assert_eq!(Scene::first_hit(&set, p0, p1).map(|h| h.t), expected);
        hit += usize::from(expected.is_some());
    }
    assert!(hit > 500, "only {hit} segments hit: the test is too weak");
}

#[test]
fn the_f32_traversal_agrees_with_f64_except_on_grazing_cases() {
    let mut rng = Lcg(7);
    let bvh = Bvh::build(&soup(20_000, &mut rng), BuildOptions::default()).unwrap();
    let mut differ = 0;
    let segs = segments(5_000, &mut rng);
    for (p0, p1) in &segs {
        let a = bvh.first_hit(*p0, *p1);
        let f = |p: &[f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
        let b = bvh.first_hit_f32(f(p0), f(p1));
        if a.is_some() != b.is_some() {
            differ += 1;
        } else if let (Some(a), Some(b)) = (a, b) {
            assert!((a.t - b.t).abs() < 1e-3, "{a:?} {b:?}");
        }
    }
    assert!(
        differ * 100 <= segs.len(),
        "{differ} of {} differ",
        segs.len()
    );
}
