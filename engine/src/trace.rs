//! Segment queries against a [`Bvh`]: Moller-Trumbore segment/triangle tests in `f64` (the reference) and
//! `f32` (the GPU parity path, optionally with SIMD128), first-hit queries by stackless skip-pointer
//! traversal, and the line-of-fire query for a whole trajectory.
//!
//! A segment is `p(t) = p0 + t * d`, `d = p1 - p0`, `t` in `[0, 1]`. A triangle is hit when the segment meets it
//! at `t` in `[0, 1]`, edges included, from either side; a segment (nearly) parallel to the triangle's plane
//! (`|det| <= 1e-12`) never hits it. This is the test of `tools/volumetric/py/reference.py`.

use crate::bvh::{Bvh, BvhSet, GpuTriangle, NO_NODE};
use crate::path::Segment;

/// `|det|` at or under which a segment counts as parallel to the triangle.
pub const PARALLEL_EPSILON: f64 = 1e-12;

/// Slack added to the `f64` boxes, metres: the box test only has to be conservative, the triangle test
/// decides, so rounding in the slab arithmetic can never lose a hit on a box face or edge.
const BOX_SLACK: f64 = 1e-6;

/// The nearest triangle a segment meets.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    /// Index of the hierarchy in a [`BvhSet`] (0 for a single [`Bvh`]).
    pub part: u32,
    /// Index of the triangle in that hierarchy's leaf order.
    pub triangle: u32,
    /// Position along the segment, `0..=1`.
    pub t: f64,
}

/// A structure a segment can be traced through.
pub trait Scene: Sync {
    /// The nearest hit of the segment `p0 -> p1`, if any.
    fn first_hit(&self, p0: [f64; 3], p1: [f64; 3]) -> Option<Hit>;
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Moller-Trumbore in `f64` for the segment `o + t d`, `t` in `[0, 1]`: the `t` of the hit, if any.
pub fn segment_triangle_f64(o: [f64; 3], d: [f64; 3], tri: &GpuTriangle) -> Option<f64> {
    let v = |i: usize| {
        [
            f64::from(tri[i][0]),
            f64::from(tri[i][1]),
            f64::from(tri[i][2]),
        ]
    };
    let a = v(0);
    let e1 = sub(v(1), a);
    let e2 = sub(v(2), a);
    let h = cross(d, e2);
    let det = dot(e1, h);
    if !(det.abs() > PARALLEL_EPSILON) {
        return None;
    }
    let inv = 1.0 / det;
    let s = sub(o, a);
    let u = inv * dot(s, h);
    let q = cross(s, e1);
    let w = inv * dot(q, d);
    let t = inv * dot(e2, q);
    (u >= 0.0 && w >= 0.0 && u + w <= 1.0 && (0.0..=1.0).contains(&t)).then_some(t)
}

/// Moller-Trumbore in `f32`, the arithmetic of the GPU shader: the `t` of the hit, if any.
#[cfg(not(all(feature = "simd", target_arch = "wasm32", target_feature = "simd128")))]
pub fn segment_triangle_f32(o: [f32; 3], d: [f32; 3], tri: &GpuTriangle) -> Option<f32> {
    segment_triangle_f32_scalar(o, d, tri)
}

/// Moller-Trumbore in `f32` with SIMD128 lanes (same results as the scalar version, bit for bit).
#[cfg(all(feature = "simd", target_arch = "wasm32", target_feature = "simd128"))]
pub fn segment_triangle_f32(o: [f32; 3], d: [f32; 3], tri: &GpuTriangle) -> Option<f32> {
    use core::arch::wasm32::*;
    let load = |v: &[f32; 4]| f32x4(v[0], v[1], v[2], 0.0);
    let cross = |a: v128, b: v128| {
        let (ay, az) = (
            i32x4_shuffle::<1, 2, 0, 3>(a, a),
            i32x4_shuffle::<2, 0, 1, 3>(a, a),
        );
        let (by, bz) = (
            i32x4_shuffle::<1, 2, 0, 3>(b, b),
            i32x4_shuffle::<2, 0, 1, 3>(b, b),
        );
        f32x4_sub(f32x4_mul(ay, bz), f32x4_mul(az, by))
    };
    let dot = |a: v128, b: v128| {
        let m = f32x4_mul(a, b);
        f32x4_extract_lane::<0>(m) + f32x4_extract_lane::<1>(m) + f32x4_extract_lane::<2>(m)
    };
    let a = load(&tri[0]);
    let e1 = f32x4_sub(load(&tri[1]), a);
    let e2 = f32x4_sub(load(&tri[2]), a);
    let d = f32x4(d[0], d[1], d[2], 0.0);
    let h = cross(d, e2);
    let det = dot(e1, h);
    if !(det.abs() > PARALLEL_EPSILON as f32) {
        return None;
    }
    let inv = 1.0 / det;
    let s = f32x4_sub(f32x4(o[0], o[1], o[2], 0.0), a);
    let u = inv * dot(s, h);
    let q = cross(s, e1);
    let w = inv * dot(q, d);
    let t = inv * dot(e2, q);
    (u >= 0.0 && w >= 0.0 && u + w <= 1.0 && (0.0..=1.0).contains(&t)).then_some(t)
}

/// The scalar `f32` Moller-Trumbore (also the reference for the SIMD version).
pub fn segment_triangle_f32_scalar(o: [f32; 3], d: [f32; 3], tri: &GpuTriangle) -> Option<f32> {
    let v = |i: usize| [tri[i][0], tri[i][1], tri[i][2]];
    let sub = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = |a: [f32; 3], b: [f32; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let a = v(0);
    let e1 = sub(v(1), a);
    let e2 = sub(v(2), a);
    let h = cross(d, e2);
    let det = dot(e1, h);
    if !(det.abs() > PARALLEL_EPSILON as f32) {
        return None;
    }
    let inv = 1.0 / det;
    let s = sub(o, a);
    let u = inv * dot(s, h);
    let q = cross(s, e1);
    let w = inv * dot(q, d);
    let t = inv * dot(e2, q);
    (u >= 0.0 && w >= 0.0 && u + w <= 1.0 && (0.0..=1.0).contains(&t)).then_some(t)
}

/// Whether the segment `o + t d` meets the box for some `t` in `[0, t_max]` (`inv_d` = 1/d per axis).
fn hits_box_f64(min: [f32; 3], max: [f32; 3], o: [f64; 3], inv_d: [f64; 3], t_max: f64) -> bool {
    let mut t_near = 0.0f64;
    let mut t_far = t_max;
    for axis in 0..3 {
        let t1 = (f64::from(min[axis]) - BOX_SLACK - o[axis]) * inv_d[axis];
        let t2 = (f64::from(max[axis]) + BOX_SLACK - o[axis]) * inv_d[axis];
        // `min`/`max` ignore a NaN (0 * inf, an origin on the slab of a ray parallel to it): not constraining
        t_near = t_near.max(t1.min(t2));
        t_far = t_far.min(t1.max(t2));
    }
    t_near <= t_far
}

/// `f32` slab test, with the far distance widened by two ulps as in Ize's robust ray-box test.
fn hits_box_f32(min: [f32; 3], max: [f32; 3], o: [f32; 3], inv_d: [f32; 3], t_max: f32) -> bool {
    let mut t_near = 0.0f32;
    let mut t_far = t_max;
    for axis in 0..3 {
        let t1 = (min[axis] - o[axis]) * inv_d[axis];
        let t2 = (max[axis] - o[axis]) * inv_d[axis];
        t_near = t_near.max(t1.min(t2));
        t_far = t_far.min(t1.max(t2));
    }
    t_near <= t_far * (1.0 + 2.0 * f32::EPSILON)
}

impl Bvh {
    /// The nearest triangle the segment `p0 -> p1` meets, in `f64` (the arithmetic of `reference.py`).
    /// Traversal is stackless: a missed box or a finished subtree jumps to its escape index.
    pub fn first_hit(&self, p0: [f64; 3], p1: [f64; 3]) -> Option<Hit> {
        let d = sub(p1, p0);
        let inv_d = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best: Option<Hit> = None;
        let mut t_max = 1.0f64;
        let mut i = 0usize;
        while i < self.nodes.len() {
            let node = &self.nodes[i];
            if !hits_box_f64(node.min, node.max, p0, inv_d, t_max) {
                i = next_after(node.a);
                continue;
            }
            if node.is_leaf() {
                let first = node.first_triangle();
                for (k, tri) in self.triangles[first..first + node.triangle_count()]
                    .iter()
                    .enumerate()
                {
                    if let Some(t) = segment_triangle_f64(p0, d, tri) {
                        if best.is_none_or(|b| t < b.t) {
                            best = Some(Hit {
                                part: 0,
                                triangle: (first + k) as u32,
                                t,
                            });
                            t_max = t;
                        }
                    }
                }
                i = next_after(node.a);
            } else {
                i += 1;
            }
        }
        best
    }

    /// As [`Bvh::first_hit`] in `f32`, the arithmetic of the GPU traversal (boxes and triangles).
    pub fn first_hit_f32(&self, p0: [f32; 3], p1: [f32; 3]) -> Option<Hit> {
        let d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let inv_d = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best: Option<Hit> = None;
        let mut t_max = 1.0f32;
        let mut i = 0usize;
        while i < self.nodes.len() {
            let node = &self.nodes[i];
            if !hits_box_f32(node.min, node.max, p0, inv_d, t_max) {
                i = next_after(node.a);
                continue;
            }
            if node.is_leaf() {
                let first = node.first_triangle();
                for (k, tri) in self.triangles[first..first + node.triangle_count()]
                    .iter()
                    .enumerate()
                {
                    if let Some(t) = segment_triangle_f32(p0, d, tri) {
                        if best.is_none_or(|b| f64::from(t) < b.t) {
                            best = Some(Hit {
                                part: 0,
                                triangle: (first + k) as u32,
                                t: f64::from(t),
                            });
                            t_max = t;
                        }
                    }
                }
                i = next_after(node.a);
            } else {
                i += 1;
            }
        }
        best
    }
}

/// Node to visit after an escape index (`NO_NODE` ends the traversal).
fn next_after(escape: u32) -> usize {
    if escape == NO_NODE {
        usize::MAX
    } else {
        escape as usize
    }
}

impl Scene for Bvh {
    fn first_hit(&self, p0: [f64; 3], p1: [f64; 3]) -> Option<Hit> {
        Bvh::first_hit(self, p0, p1)
    }
}

impl Scene for BvhSet {
    /// The nearest hit over all parts.
    fn first_hit(&self, p0: [f64; 3], p1: [f64; 3]) -> Option<Hit> {
        let mut best: Option<Hit> = None;
        for (index, part) in self.parts.iter().enumerate() {
            let Some((min, max)) = part.bounds() else {
                continue;
            };
            let d = sub(p1, p0);
            let inv_d = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
            if !hits_box_f64(min, max, p0, inv_d, best.map_or(1.0, |b| b.t)) {
                continue;
            }
            if let Some(mut hit) = part.first_hit(p0, p1) {
                hit.part = index as u32;
                if best.is_none_or(|b| hit.t < b.t) {
                    best = Some(hit);
                }
            }
        }
        best
    }
}

/// Where a trajectory first meets the scene.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathHit {
    /// Index of the segment of the trajectory.
    pub segment: usize,
    /// The triangle hit.
    pub hit: Hit,
    /// The point of the hit, metres.
    pub point: [f64; 3],
    /// Time of flight at the hit, seconds.
    pub time: f64,
}

/// Line-of-fire query: the first point where the trajectory (its segments, in flight order) meets the scene,
/// or `None` if the line of fire is clear.
pub fn first_hit_along<S: Scene + ?Sized>(scene: &S, segments: &[Segment]) -> Option<PathHit> {
    segments.iter().enumerate().find_map(|(index, segment)| {
        let hit = scene.first_hit(segment.p0, segment.p1)?;
        let point = [
            segment.p0[0] + hit.t * (segment.p1[0] - segment.p0[0]),
            segment.p0[1] + hit.t * (segment.p1[1] - segment.p0[1]),
            segment.p0[2] + hit.t * (segment.p1[2] - segment.p0[2]),
        ];
        Some(PathHit {
            segment: index,
            hit,
            point,
            time: segment.t0 + hit.t * (segment.t1 - segment.t0),
        })
    })
}

/// Traces many independent segments; on several threads with the `threads` feature.
pub fn first_hits<S: Scene + ?Sized>(
    scene: &S,
    segments: &[([f64; 3], [f64; 3])],
) -> Vec<Option<Hit>> {
    crate::bvh::map_parallel(segments, |(p0, p1)| scene.first_hit(*p0, *p1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bvh::{BuildOptions, Triangle};

    fn floor() -> Triangle {
        [[-10.0, -10.0, 0.0], [10.0, -10.0, 0.0], [0.0, 10.0, 0.0]]
    }

    fn gpu(t: Triangle) -> GpuTriangle {
        [
            [t[0][0], t[0][1], t[0][2], 0.0],
            [t[1][0], t[1][1], t[1][2], 0.0],
            [t[2][0], t[2][1], t[2][2], 0.0],
        ]
    }

    #[test]
    fn a_segment_through_a_triangle_hits_at_the_right_t() {
        let t = segment_triangle_f64([0.0, 0.0, 5.0], [0.0, 0.0, -10.0], &gpu(floor()));
        assert!((t.unwrap() - 0.5).abs() < 1e-15);
        let t = segment_triangle_f32([0.0, 0.0, 5.0], [0.0, 0.0, -10.0], &gpu(floor()));
        assert!((t.unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_short_segment_misses() {
        assert!(segment_triangle_f64([0.0, 0.0, 5.0], [0.0, 0.0, -4.0], &gpu(floor())).is_none());
    }

    #[test]
    fn a_segment_parallel_to_the_plane_misses() {
        assert!(segment_triangle_f64([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], &gpu(floor())).is_none());
    }

    #[test]
    fn the_edge_counts_as_a_hit_and_from_below_too() {
        assert!(segment_triangle_f64([0.0, -10.0, 1.0], [0.0, 0.0, -2.0], &gpu(floor())).is_some());
        assert!(segment_triangle_f64([0.0, 0.0, -5.0], [0.0, 0.0, 10.0], &gpu(floor())).is_some());
    }

    #[test]
    fn first_hit_returns_the_nearest_of_two_layers() {
        let mut upper = floor();
        for v in &mut upper {
            v[2] = 3.0;
        }
        let bvh = Bvh::build(&[floor(), upper], BuildOptions::default()).unwrap();
        let hit = bvh.first_hit([0.0, 0.0, 10.0], [0.0, 0.0, -10.0]).unwrap();
        assert!((hit.t - 0.35).abs() < 1e-12);
        let hit = bvh
            .first_hit_f32([0.0, 0.0, 10.0], [0.0, 0.0, -10.0])
            .unwrap();
        assert!((hit.t - 0.35).abs() < 1e-6);
    }

    #[test]
    fn axis_aligned_flat_triangles_are_found_on_their_box_face() {
        // The box of a horizontal triangle has zero height: the slab test must still let a ray reach it
        let bvh = Bvh::build(&[floor()], BuildOptions::default()).unwrap();
        assert!(bvh.first_hit([1.0, 1.0, 2.0], [1.0, 1.0, 0.0]).is_some());
        assert!(bvh.first_hit([1.0, 1.0, 2.0], [1.0, 1.0, 0.1]).is_none());
    }

    #[test]
    fn set_and_single_hierarchy_agree() {
        let soup: Vec<Triangle> = (0..60)
            .map(|i| {
                let z = i as f32;
                [[-5.0, -5.0, z], [5.0, -5.0, z], [0.0, 5.0, z]]
            })
            .collect();
        let single = Bvh::build(&soup, BuildOptions::default()).unwrap();
        let set = BvhSet::build(soup, 7, BuildOptions::default()).unwrap();
        for k in 0..20 {
            let p0 = [0.0, 0.0, 70.0 - k as f64];
            let p1 = [0.5, 0.0, -3.0];
            let a = Scene::first_hit(&single, p0, p1).map(|h| h.t);
            let b = Scene::first_hit(&set, p0, p1).map(|h| h.t);
            assert_eq!(a, b);
        }
    }

    #[test]
    fn a_clear_line_of_fire_has_no_hit() {
        let bvh = Bvh::build(&[floor()], BuildOptions::default()).unwrap();
        let segments = [Segment {
            p0: [50.0, 0.0, 5.0],
            p1: [60.0, 0.0, 5.0],
            t0: 0.0,
            t1: 1.0,
        }];
        assert!(first_hit_along(&bvh, &segments).is_none());
    }
}
