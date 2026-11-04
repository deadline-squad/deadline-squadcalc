//! A trajectory as straight segments in world coordinates, ready for the ray queries of [`crate::trace`].
//!
//! Points are evaluated on the exact flight ([`Flight::path_at`], closed forms and the game's substeps; no
//! numerical integration), and a stretch is split in two until the exact point at its middle lies within
//! `tolerance` metres of the chord. The segments therefore follow the true path to `tolerance` (sampled at
//! the middle of every stretch, after a first split into [`INITIAL_PIECES`] equal pieces and at the apex).
//! Every vertex is on the trajectory.

use crate::flight::Flight;

/// Equal pieces the flight is split into before the tolerance test.
pub const INITIAL_PIECES: usize = 8;

/// Deepest split of one initial piece.
const MAX_DEPTH: u32 = 24;

/// One straight piece of a trajectory.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    /// Start, metres.
    pub p0: [f64; 3],
    /// End, metres.
    pub p1: [f64; 3],
    /// Time of flight at the start, seconds.
    pub t0: f64,
    /// Time of flight at the end, seconds.
    pub t1: f64,
}

/// A point of the flight in the vertical plane of the shot.
#[derive(Clone, Copy)]
struct PlanePoint {
    x: f64,
    y: f64,
    time: f64,
}

/// The segments of the trajectory that leaves the weapon's muzzle and reaches the horizontal `distance` from
/// the pivot with the barrel at `elevation` (the physical barrel angle, radians).
///
/// `origin` is the weapon's ground point (world metres: X east, Y north, Z up) and `azimuth_rad` the bearing
/// of the shot, clockwise from north. `tolerance` is the largest distance, metres, between the true path and
/// the polyline at the middle of a segment. Returns no segments for a NaN elevation or a flight that
/// never reaches `distance`.
pub fn trajectory_segments(
    flight: &Flight,
    elevation: f64,
    distance: f64,
    origin: [f64; 3],
    azimuth_rad: f64,
    tolerance: f64,
) -> Vec<Segment> {
    let (start_x, _) = flight.shot.launch_point(elevation);
    let point_at = |x: f64| {
        let p = flight.path_at(elevation, x);
        PlanePoint {
            x,
            y: p.height,
            time: p.time,
        }
    };
    let first = point_at(start_x);
    let last = point_at(distance);
    if !(first.y.is_finite() && last.y.is_finite() && distance > start_x) {
        return Vec::new();
    }

    let (apex_x, _) = flight.apex(elevation, distance);
    let mut breaks: Vec<f64> = (0..=INITIAL_PIECES)
        .map(|i| start_x + (distance - start_x) * i as f64 / INITIAL_PIECES as f64)
        .collect();
    if apex_x > start_x && apex_x < distance {
        breaks.push(apex_x);
        breaks.sort_by(f64::total_cmp);
    }

    let mut points = vec![first];
    for pair in breaks.windows(2) {
        let end = if pair[1] == distance { last } else { point_at(pair[1]) };
        refine(&point_at, *points.last().unwrap_or(&first), end, tolerance, MAX_DEPTH, &mut points);
    }

    let (sin_az, cos_az) = azimuth_rad.sin_cos();
    let world = |p: &PlanePoint| [origin[0] + p.x * sin_az, origin[1] + p.x * cos_az, origin[2] + p.y];
    points
        .windows(2)
        .map(|w| Segment {
            p0: world(&w[0]),
            p1: world(&w[1]),
            t0: w[0].time,
            t1: w[1].time,
        })
        .collect()
}

/// Appends the points after `a` up to and including `b`, splitting the stretch while its middle is off the chord.
fn refine(
    point_at: &impl Fn(f64) -> PlanePoint,
    a: PlanePoint,
    b: PlanePoint,
    tolerance: f64,
    depth: u32,
    out: &mut Vec<PlanePoint>,
) {
    if depth > 0 {
        let middle = point_at(0.5 * (a.x + b.x));
        if middle.y.is_finite() && distance_to_chord(&a, &b, &middle) > tolerance {
            refine(point_at, a, middle, tolerance, depth - 1, out);
            refine(point_at, middle, b, tolerance, depth - 1, out);
            return;
        }
    }
    out.push(b);
}

/// Distance of `p` from the infinite line through `a` and `b` in the plane.
fn distance_to_chord(a: &PlanePoint, b: &PlanePoint, p: &PlanePoint) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length = dx.hypot(dy);
    if length == 0.0 {
        return (p.x - a.x).hypot(p.y - a.y);
    }
    ((p.x - a.x) * dy - (p.y - a.y) * dx).abs() / length
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flight::Shot;

    fn mortar_shot() -> Shot {
        Shot {
            velocity: 110.0,
            gravity: 9.8,
            acceleration: 0.0,
            boost_time: 0.0,
            max_speed: 0.0,
            rotation_follows_velocity: true,
            pivot_height: 0.0245,
            muzzle_forward: 1.569,
            muzzle_up: 0.002,
        }
    }

    #[test]
    fn segments_chain_from_muzzle_to_target_and_follow_the_path() {
        let flight = Flight::new(mortar_shot());
        let (_, high) = flight.solve_elevation(800.0, 12.0);
        let tolerance = 0.01;
        let segments = trajectory_segments(&flight, high, 800.0, [0.0, 0.0, 0.0], 0.0, tolerance);
        assert!(segments.len() > INITIAL_PIECES);
        for pair in segments.windows(2) {
            assert_eq!(pair[0].p1, pair[1].p0);
            assert!(pair[0].t1 <= pair[1].t0 + 1e-12);
        }
        let end = segments.last().unwrap().p1;
        assert!((end[1] - 800.0).abs() < 1e-9 && (end[2] - 12.0).abs() < 1e-6);
        // Azimuth 0 is north: no drift east
        assert!(segments.iter().all(|s| s.p0[0].abs() < 1e-12));

        // Between vertices the polyline stays within the tolerance of the exact path (checked off-vertex)
        let mut worst = 0.0f64;
        for s in &segments {
            for k in 1..8 {
                let f = f64::from(k) / 8.0;
                let y = s.p0[1] + f * (s.p1[1] - s.p0[1]);
                let z = s.p0[2] + f * (s.p1[2] - s.p0[2]);
                let exact = flight.path_at(high, y).height;
                worst = worst.max((exact - z).abs());
            }
        }
        assert!(worst < 2.0 * tolerance, "worst deviation {worst}");
    }

    #[test]
    fn the_apex_is_a_vertex_and_matches_the_closed_form() {
        let flight = Flight::new(Shot {
            muzzle_forward: 0.0,
            muzzle_up: 0.0,
            pivot_height: 0.0,
            ..mortar_shot()
        });
        let angle = 60f64.to_radians();
        let (x, y) = flight.apex(angle, 2000.0);
        let (v, g) = (110.0, 9.8);
        assert!((y - (v * angle.sin()).powi(2) / (2.0 * g)).abs() < 1e-9);
        assert!((x - v * v * (2.0 * angle).sin() / (2.0 * g)).abs() < 1e-9);
        let segments = trajectory_segments(&flight, angle, 1000.0, [0.0; 3], 0.0, 0.01);
        assert!(segments.iter().any(|s| (s.p1[1] - x).abs() < 1e-9));
    }

    #[test]
    fn azimuth_turns_the_plane_clockwise_from_north() {
        let flight = Flight::new(mortar_shot());
        let (_, high) = flight.solve_elevation(500.0, 0.0);
        let east = trajectory_segments(&flight, high, 500.0, [10.0, 20.0, 5.0], std::f64::consts::FRAC_PI_2, 0.05);
        let end = east.last().unwrap().p1;
        assert!((end[0] - 510.0).abs() < 1e-6 && (end[1] - 20.0).abs() < 1e-6 && (end[2] - 5.0).abs() < 1e-6);
    }

    #[test]
    fn nan_elevation_gives_no_segments() {
        let flight = Flight::new(mortar_shot());
        assert!(trajectory_segments(&flight, f64::NAN, 500.0, [0.0; 3], 0.0, 0.05).is_empty());
    }
}
