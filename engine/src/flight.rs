//! Flight of a Squad projectile: where it is, and the elevation that lands it on a target.
//!
//! A port, function for function, of `src/js/squadBallistics.js` of SquadCalc (which is the same model as
//! Squad Ballistics, `ballistics.py`). The model is the game's own: no drag, gravity `g = world gravity x
//! ProjectileGravityScale`, the barrel pivots at `pivot_height` above the weapon's ground and the projectile
//! starts at the muzzle, `muzzle_forward` along the barrel and `muzzle_up` above its axis, so the launch point
//! moves with the elevation. A rocket motor (ConstantAcceleration) pushes along the path for `boost_time`
//! seconds and `max_speed` caps the speed at every substep.
//!
//! Every phase that has a closed form is computed exactly: the parabola of a coasting shell, a motor along the
//! barrel's axis, a shell coasting at its speed cap (the path angle turns at a constant speed). A motor along
//! the path, or one that the cap could clamp, has none; the game's own 20 ms substeps are flown for it
//! ([`fly_boost`]), tabulated over the elevation and interpolated ([`BoostTable`]), exactly as the JS solver
//! does, so that both agree to rounding.
//!
//! Elevation for a target `D` metres away and `H` metres above the weapon's ground: the roots of
//! `F(theta) = y(theta, D) - H`. A plain parabola has the closed form; every other shot is solved by a
//! golden-section search for the highest elevation and the Illinois method on each side of it.

use std::cell::OnceCell;
use std::f64::consts::{FRAC_PI_2, PI};

/// Largest barrel elevation searched, radians: the barrel is never vertical.
pub const ELEVATION_LIMIT: f64 = FRAC_PI_2 - 1e-6;
/// Width of the last bracket of the searches, radians.
pub const ANGLE_TOLERANCE: f64 = 1e-10;
/// Height error at the target that ends the root search, metres.
pub const HEIGHT_TOLERANCE: f64 = 1e-9;
/// First half-width of the root brackets around the highest elevation, radians.
pub const BRACKET_STEP: f64 = 0.02;
/// Iteration cap of each search.
pub const MAX_ITERATIONS: usize = 200;
/// The game's projectile substep on the dedicated server, seconds (50 Hz tick).
pub const SUBSTEP: f64 = 0.02;
/// Barrel elevations between the nodes of a boost table, radians.
pub const BOOST_NODE_SPACING: f64 = PI / 180.0;

const GOLDEN: f64 = 0.618_033_988_749_894_8;

/// How a weapon fires, in metres, seconds and radians.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shot {
    /// Launch speed `v0` along the barrel, m/s.
    pub velocity: f64,
    /// `g`, m/s^2 (world gravity times the projectile's gravity scale).
    pub gravity: f64,
    /// Acceleration `a` of the motor during `boost_time`, m/s^2 (negative: slows down).
    pub acceleration: f64,
    /// Motor burn time `T`, seconds; 0 without boost.
    pub boost_time: f64,
    /// The projectile's speed cap, m/s; 0 means none.
    pub max_speed: f64,
    /// The motor pushes along the path (the game's `bRotationFollowsVelocity`); `false`: along the barrel's
    /// axis at launch (UB-32).
    pub rotation_follows_velocity: bool,
    /// Barrel pivot above the weapon's ground, metres.
    pub pivot_height: f64,
    /// Muzzle along the barrel from the pivot, metres.
    pub muzzle_forward: f64,
    /// Muzzle above the barrel axis, metres.
    pub muzzle_up: f64,
}

impl Shot {
    /// Whether the shot has a motor phase.
    pub fn has_boost(&self) -> bool {
        self.boost_time > 0.0 && self.acceleration != 0.0
    }

    /// Game substeps the motor acts in: those that start before `boost_time` (0 without boost).
    pub fn boost_steps(&self) -> usize {
        if self.has_boost() {
            (self.boost_time / SUBSTEP - 1e-9).ceil() as usize
        } else {
            0
        }
    }

    /// Whether the cap could clamp a motor along the barrel's axis.
    fn cap_binds_on_axis(&self) -> bool {
        if self.max_speed == 0.0 {
            return false;
        }
        let end = (self.velocity + self.acceleration * self.boost_time).abs();
        self.velocity > self.max_speed || end + self.gravity * self.boost_time > self.max_speed
    }

    /// Whether the boost has no closed form and is flown with the game's substeps: a motor along the path,
    /// or one along the barrel that the cap could clamp. A flight without gravity is straight either way.
    pub fn flies_boost_in_steps(&self) -> bool {
        if !self.has_boost() || self.gravity == 0.0 {
            return false;
        }
        self.rotation_follows_velocity || self.cap_binds_on_axis()
    }

    /// Whether the shot is fired faster than its cap without a motor: the first substep slows it (tank HE).
    pub fn launch_clamped(&self) -> bool {
        self.max_speed != 0.0 && self.velocity > self.max_speed && !self.has_boost()
    }

    /// Seconds the closed-form motor along the barrel speeds the projectile up: `boost_time`, ended earlier by
    /// the cap in a straight flight.
    fn axis_boost_time(&self) -> f64 {
        if !self.has_boost() {
            return 0.0;
        }
        if self.gravity == 0.0 && self.max_speed != 0.0 && self.acceleration > 0.0 {
            return self
                .boost_time
                .min(((self.max_speed - self.velocity) / self.acceleration).max(0.0));
        }
        self.boost_time
    }

    /// Whether the trajectory is the textbook parabola from the pivot (no boost, no muzzle offset, not fired
    /// above its cap), as long as it does not come down faster than its cap ([`Shot::clamps_before`]).
    pub fn is_parabola(&self) -> bool {
        !self.has_boost()
            && self.muzzle_forward == 0.0
            && self.muzzle_up == 0.0
            && !self.launch_clamped()
    }

    /// Whether a plain parabola from the pivot comes down faster than its cap before it reaches a target
    /// `height` metres above the weapon's ground.
    pub fn clamps_before(&self, height: f64) -> bool {
        if self.max_speed == 0.0 {
            return false;
        }
        let drop = self.pivot_height - height;
        self.velocity.powi(2) + 2.0 * self.gravity * drop > self.max_speed.powi(2)
    }

    /// Where the projectile starts for an elevation: `(metres ahead of the pivot, metres above the ground)`.
    pub fn launch_point(&self, angle: f64) -> (f64, f64) {
        let (sin, cos) = angle.sin_cos();
        (
            self.muzzle_forward * cos - self.muzzle_up * sin,
            self.pivot_height + self.muzzle_forward * sin + self.muzzle_up * cos,
        )
    }
}

/// The boost of a shot fired at one angle, flown with the game's substeps from the muzzle.
#[derive(Debug, Clone)]
pub struct BoostNode {
    /// X (metres from the muzzle) at the start of every substep and at the end.
    pub xs: Vec<f64>,
    /// Y (metres from the muzzle) at the start of every substep and at the end.
    pub ys: Vec<f64>,
    /// Horizontal velocity at the end of the boost, m/s.
    pub vx: f64,
    /// Vertical velocity at the end of the boost, m/s.
    pub vy: f64,
}

/// Flies the boost of a shot fired at `angle` with the game's substeps (Velocity Verlet, rotation following
/// the velocity, speed cap at every substep).
pub fn fly_boost(shot: &Shot, angle: f64) -> BoostNode {
    let dt = SUBSTEP;
    let g = shot.gravity;
    let a = shot.acceleration;
    let cap = shot.max_speed;
    let cap_squared = cap * cap;
    let follows = shot.rotation_follows_velocity;
    let steps = shot.boost_steps();
    let (sin, cos) = angle.sin_cos();
    let mut vx = shot.velocity * cos;
    let mut vy = shot.velocity * sin;
    let mut ax = a * cos;
    let mut ay = a * sin;
    let mut x = 0.0;
    let mut y = 0.0;
    let mut xs = vec![0.0; steps + 1];
    let mut ys = vec![0.0; steps + 1];

    for k in 0..steps {
        let mut mx = vx + ax * dt;
        let mut my = vy + (ay - g) * dt;
        if cap != 0.0 {
            let speed_squared = mx * mx + my * my;
            if speed_squared > cap_squared {
                let scale = cap / speed_squared.sqrt();
                mx *= scale;
                my *= scale;
            }
        }
        x += 0.5 * (vx + mx) * dt;
        y += 0.5 * (vy + my) * dt;

        if follows {
            let speed = vx.hypot(vy);
            ax = a * vx / speed;
            ay = a * vy / speed;
        }

        vx += ax * dt;
        vy += (ay - g) * dt;
        if cap != 0.0 {
            let speed_squared = vx * vx + vy * vy;
            if speed_squared > cap_squared {
                let scale = cap / speed_squared.sqrt();
                vx *= scale;
                vy *= scale;
            }
        }

        xs[k + 1] = x;
        ys[k + 1] = y;
    }

    BoostNode { xs, ys, vx, vy }
}

/// A stepped boost tabulated over the barrel elevation: nodes every [`BOOST_NODE_SPACING`] from -90 to +90
/// degrees, each flown the first time it is needed, and four-point Lagrange interpolation between them.
#[derive(Debug)]
pub struct BoostTable {
    shot: Shot,
    /// Substeps of the boost.
    pub steps: usize,
    count: usize,
    nodes: Vec<OnceCell<BoostNode>>,
}

/// Four nodes of a [`BoostTable`] that interpolate one elevation, with their Lagrange weights.
#[derive(Debug, Clone, Copy)]
pub struct Stencil<'a> {
    weights: [f64; 4],
    nodes: [&'a BoostNode; 4],
}

impl<'a> Stencil<'a> {
    fn mix(&self, pick: impl Fn(&BoostNode) -> f64) -> f64 {
        let w = &self.weights;
        let n = &self.nodes;
        w[0] * pick(n[0]) + w[1] * pick(n[1]) + w[2] * pick(n[2]) + w[3] * pick(n[3])
    }

    /// Interpolated x of substep point `k`.
    pub fn x(&self, k: usize) -> f64 {
        self.mix(|n| n.xs[k])
    }

    /// Interpolated y of substep point `k`.
    pub fn y(&self, k: usize) -> f64 {
        self.mix(|n| n.ys[k])
    }

    /// Interpolated horizontal end velocity.
    pub fn vx(&self) -> f64 {
        self.mix(|n| n.vx)
    }

    /// Interpolated vertical end velocity.
    pub fn vy(&self) -> f64 {
        self.mix(|n| n.vy)
    }

    /// The substep whose straight segment holds the distance `ahead` from the muzzle (the first one for a
    /// distance behind the muzzle), found by binary search on the interpolated x.
    pub fn segment(&self, steps: usize, ahead: f64) -> usize {
        let mut low = 0;
        let mut high = steps;
        while high - low > 1 {
            let mid = (low + high) >> 1;
            if self.x(mid) <= ahead {
                low = mid;
            } else {
                high = mid;
            }
        }
        low
    }
}

impl BoostTable {
    /// An empty table of `shot` (nodes are flown on demand).
    pub fn new(shot: Shot) -> Self {
        let count = (PI / BOOST_NODE_SPACING).round() as usize + 1;
        BoostTable {
            shot,
            steps: shot.boost_steps(),
            count,
            nodes: (0..count).map(|_| OnceCell::new()).collect(),
        }
    }

    fn node(&self, index: usize) -> &BoostNode {
        self.nodes[index]
            .get_or_init(|| fly_boost(&self.shot, -FRAC_PI_2 + index as f64 * BOOST_NODE_SPACING))
    }

    /// The four nodes that interpolate `angle` (two on each side, shifted inwards at the ends) and their weights.
    pub fn stencil(&self, angle: f64) -> Stencil<'_> {
        let at = (angle + FRAC_PI_2) / BOOST_NODE_SPACING;
        let first = (at.trunc() - 1.0).max(0.0).min((self.count - 4) as f64) as usize;
        let u = at - first as f64;
        Stencil {
            weights: [
                -(u - 1.0) * (u - 2.0) * (u - 3.0) / 6.0,
                u * (u - 2.0) * (u - 3.0) / 2.0,
                -u * (u - 1.0) * (u - 3.0) / 2.0,
                u * (u - 1.0) * (u - 2.0) / 6.0,
            ],
            nodes: [
                self.node(first),
                self.node(first + 1),
                self.node(first + 2),
                self.node(first + 3),
            ],
        }
    }
}

/// Position, time and path angle of the projectile at one point of its flight.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathPoint {
    /// Metres above the weapon's ground.
    pub height: f64,
    /// Seconds since launch.
    pub time: f64,
    /// Radians above the horizontal; a point the capped coast never reaches is `(-inf, inf, -pi/2)`.
    pub angle: f64,
}

/// State after the first substep of a shell fired above its cap: the velocity `v0 + g*dt` clamped to the cap.
struct ClampedLaunch {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

fn clamped_launch(shot: &Shot, cos: f64, sin: f64) -> ClampedLaunch {
    let v0 = shot.velocity;
    let mut vx = v0 * cos;
    let mut vy = v0 * sin - shot.gravity * SUBSTEP;
    let scale = shot.max_speed / vx.hypot(vy);
    vx *= scale;
    vy *= scale;
    ClampedLaunch {
        x: 0.5 * (v0 * cos + vx) * SUBSTEP,
        y: 0.5 * (v0 * sin + vy) * SUBSTEP,
        vx,
        vy,
    }
}

/// Height at `ahead` metres of a projectile coasting from `(x, y)` at `(vx, vy)`, all relative to the muzzle:
/// the parabola, and once it comes down faster than its cap the capped coast.
fn coast_height(shot: &Shot, x: f64, y: f64, vx: f64, vy: f64, ahead: f64) -> f64 {
    let g = shot.gravity;
    let tau = (ahead - x) / vx;
    let cap = shot.max_speed;

    if cap != 0.0 && g != 0.0 {
        let onset = ((vy + (cap * cap - vx * vx).max(0.0).sqrt()) / g).max(0.0);
        if tau > onset {
            let yc = y + onset * (vy - 0.5 * g * onset);
            let radius = cap * cap / g;
            let cos_onset = (vx / cap).min(1.0);
            let turn = cos_onset.acos() + (ahead - x - vx * onset) / radius;
            // Far past where the capped coast turns straight down the height is a very large negative number
            return yc + radius * (turn.cos().max(1e-300) / cos_onset).ln();
        }
    }

    y + tau * (vy - 0.5 * g * tau)
}

/// Height, time and path angle at `ahead` metres of the coast started at time `t`. The capped coast turns
/// its path angle `gamma` at constant speed `V` (`R = V^2/g`):
/// `x = xc + R (gamma_c - gamma)`, `y = yc + R ln(cos gamma / cos gamma_c)`,
/// `t = tc + (V/g)(atanh sin gamma_c - atanh sin gamma)`.
fn coast_at(shot: &Shot, x: f64, y: f64, vx: f64, vy: f64, t: f64, ahead: f64) -> PathPoint {
    let g = shot.gravity;
    let tau = (ahead - x) / vx;
    let cap = shot.max_speed;

    if cap != 0.0 && g != 0.0 {
        let onset = ((vy + (cap * cap - vx * vx).max(0.0).sqrt()) / g).max(0.0);
        if tau > onset {
            let yc = y + onset * (vy - 0.5 * g * onset);
            let radius = cap * cap / g;
            let cos_onset = (vx / cap).min(1.0);
            let turn = cos_onset.acos() + (ahead - x - vx * onset) / radius;
            if turn >= FRAC_PI_2 {
                return PathPoint {
                    height: f64::NEG_INFINITY,
                    time: f64::INFINITY,
                    angle: -FRAC_PI_2,
                };
            }
            let since = (cap / g)
                * (turn.sin().atanh() - (1.0 - cos_onset * cos_onset).max(0.0).sqrt().atanh());
            return PathPoint {
                height: yc + radius * (turn.cos() / cos_onset).ln(),
                time: t + onset + since,
                angle: -turn,
            };
        }
    }

    PathPoint {
        height: y + tau * (vy - 0.5 * g * tau),
        time: t + tau,
        angle: (vy - g * tau).atan2(vx),
    }
}

/// A shot ready to fly: the [`Shot`] and, for a stepped boost, its lazily filled [`BoostTable`].
#[derive(Debug)]
pub struct Flight {
    /// How the weapon fires.
    pub shot: Shot,
    table: Option<BoostTable>,
}

impl Flight {
    /// Prepares `shot` for flying.
    pub fn new(shot: Shot) -> Self {
        let table = shot.flies_boost_in_steps().then(|| BoostTable::new(shot));
        Flight { shot, table }
    }

    fn table(&self) -> &BoostTable {
        self.table
            .as_ref()
            .expect("a stepped boost always has a table")
    }

    /// Height of the projectile when it is `distance` metres away horizontally from the pivot, with the
    /// barrel at elevation `angle`.
    pub fn height_at(&self, angle: f64, distance: f64) -> f64 {
        let shot = &self.shot;
        let (sin, cos) = angle.sin_cos();
        let v0 = shot.velocity;
        let g = shot.gravity;
        let start_x = shot.muzzle_forward * cos - shot.muzzle_up * sin;
        let start_y = shot.pivot_height + shot.muzzle_forward * sin + shot.muzzle_up * cos;
        let ahead = distance - start_x;

        if shot.flies_boost_in_steps() {
            if angle.is_nan() {
                return f64::NAN;
            }
            let table = self.table();
            let stencil = table.stencil(angle);
            let steps = table.steps;
            let end_x = stencil.x(steps);
            if ahead < end_x {
                let low = stencil.segment(steps, ahead);
                let next = low + 1;
                let start_point_x = stencil.x(low);
                let start_point_y = stencil.y(low);
                let next_x = stencil.x(next);
                let next_y = stencil.y(next);
                return start_y
                    + start_point_y
                    + (next_y - start_point_y) * (ahead - start_point_x) / (next_x - start_point_x);
            }
            return start_y
                + coast_height(
                    shot,
                    end_x,
                    stencil.y(steps),
                    stencil.vx(),
                    stencil.vy(),
                    ahead,
                );
        }

        if shot.has_boost() {
            let a = shot.acceleration;
            let boost = shot.axis_boost_time();
            let length = v0 * boost + 0.5 * a * boost * boost;
            if ahead <= cos * length {
                let along = ahead / cos;
                let t = 2.0 * along / (v0 + (v0 * v0 + 2.0 * a * along).max(0.0).sqrt());
                return start_y + sin * along - 0.5 * g * t * t;
            }
            let end_speed = v0 + a * boost;
            return start_y
                + coast_height(
                    shot,
                    cos * length,
                    sin * length - 0.5 * g * boost * boost,
                    cos * end_speed,
                    sin * end_speed - g * boost,
                    ahead,
                );
        }

        if shot.launch_clamped() {
            let first = clamped_launch(shot, cos, sin);
            if ahead < first.x {
                return start_y + first.y * ahead / first.x;
            }
            return start_y + coast_height(shot, first.x, first.y, first.vx, first.vy, ahead);
        }

        start_y + coast_height(shot, 0.0, 0.0, v0 * cos, v0 * sin, ahead)
    }

    /// Height, time and path angle of the projectile when it is `distance` metres away horizontally from the
    /// pivot, with the barrel at elevation `angle`; all NaN for a NaN angle. A distance behind the muzzle
    /// extrapolates the first phase backwards.
    pub fn path_at(&self, angle: f64, distance: f64) -> PathPoint {
        if angle.is_nan() {
            return PathPoint {
                height: f64::NAN,
                time: f64::NAN,
                angle: f64::NAN,
            };
        }
        let shot = &self.shot;
        let (sin, cos) = angle.sin_cos();
        let (start_x, start_y) = shot.launch_point(angle);
        let ahead = distance - start_x;
        let v0 = shot.velocity;
        let g = shot.gravity;

        let mut point = if shot.flies_boost_in_steps() {
            let table = self.table();
            let stencil = table.stencil(angle);
            let steps = table.steps;
            let end_x = stencil.x(steps);
            if ahead < end_x {
                let k = stencil.segment(steps, ahead);
                let (ax, ay) = (stencil.x(k), stencil.y(k));
                let (bx, by) = (stencil.x(k + 1), stencil.y(k + 1));
                let part = (ahead - ax) / (bx - ax);
                PathPoint {
                    height: ay + (by - ay) * part,
                    time: ((k as f64 + part) * SUBSTEP).max(0.0),
                    angle: (by - ay).atan2(bx - ax),
                }
            } else {
                coast_at(
                    shot,
                    end_x,
                    stencil.y(steps),
                    stencil.vx(),
                    stencil.vy(),
                    steps as f64 * SUBSTEP,
                    ahead,
                )
            }
        } else if shot.has_boost() {
            let a = shot.acceleration;
            let boost = shot.axis_boost_time();
            let length = v0 * boost + 0.5 * a * boost * boost;
            let end_speed = v0 + a * boost;
            let end_x = cos * length;
            let end_y = sin * length - 0.5 * g * boost * boost;
            if ahead <= end_x {
                let along = ahead / cos;
                let t = 2.0 * along / (v0 + (v0 * v0 + 2.0 * a * along).max(0.0).sqrt());
                let speed = v0 + a * t;
                PathPoint {
                    height: sin * along - 0.5 * g * t * t,
                    time: t.max(0.0),
                    angle: (sin * speed - g * t).atan2(cos * speed),
                }
            } else {
                coast_at(
                    shot,
                    end_x,
                    end_y,
                    cos * end_speed,
                    sin * end_speed - g * boost,
                    boost,
                    ahead,
                )
            }
        } else if shot.launch_clamped() {
            let first = clamped_launch(shot, cos, sin);
            if ahead < first.x {
                PathPoint {
                    height: first.y * ahead / first.x,
                    time: (SUBSTEP * ahead / first.x).max(0.0),
                    angle: first.y.atan2(first.x),
                }
            } else {
                coast_at(shot, first.x, first.y, first.vx, first.vy, SUBSTEP, ahead)
            }
        } else {
            let mut p = coast_at(shot, 0.0, 0.0, v0 * cos, v0 * sin, 0.0, ahead);
            p.time = p.time.max(0.0);
            p
        };
        point.height += start_y;
        point
    }

    /// Highest point of the flight from the muzzle to the horizontal `distance` from the pivot, with the barrel
    /// at elevation `angle`: `(distance from the pivot, height above the weapon's ground)`. The apex of each
    /// phase is found in closed form (the vertices of a stepped boost, the root of the vertical speed of a
    /// motor along the axis, `vy / g` of a coast); the capped coast only descends.
    pub fn apex(&self, angle: f64, distance: f64) -> (f64, f64) {
        let shot = &self.shot;
        let (sin, cos) = angle.sin_cos();
        let (start_x, start_y) = shot.launch_point(angle);
        let v0 = shot.velocity;
        let g = shot.gravity;
        let mut best = (start_x, start_y);
        let mut consider = |x: f64, y: f64| {
            if start_x + x <= distance && y + start_y > best.1 {
                best = (start_x + x, y + start_y);
            }
        };

        let (cx, cy, cvx, cvy) = if shot.flies_boost_in_steps() {
            let table = self.table();
            let stencil = table.stencil(angle);
            for k in 0..=table.steps {
                consider(stencil.x(k), stencil.y(k));
            }
            (stencil.x(table.steps), stencil.y(table.steps), stencil.vx(), stencil.vy())
        } else if shot.has_boost() {
            let a = shot.acceleration;
            let boost = shot.axis_boost_time();
            // Vertical speed (v0 + a t) sin - g t is zero at t = v0 sin / (g - a sin)
            let denominator = g - a * sin;
            if denominator != 0.0 {
                let t = v0 * sin / denominator;
                if t > 0.0 && t < boost {
                    let along = v0 * t + 0.5 * a * t * t;
                    consider(cos * along, sin * along - 0.5 * g * t * t);
                }
            }
            let length = v0 * boost + 0.5 * a * boost * boost;
            let end_speed = v0 + a * boost;
            let end = (cos * length, sin * length - 0.5 * g * boost * boost);
            consider(end.0, end.1);
            (end.0, end.1, cos * end_speed, sin * end_speed - g * boost)
        } else if shot.launch_clamped() {
            let first = clamped_launch(shot, cos, sin);
            consider(first.x, first.y);
            (first.x, first.y, first.vx, first.vy)
        } else {
            (0.0, 0.0, v0 * cos, v0 * sin)
        };

        if cvy > 0.0 && g > 0.0 && cvx > 0.0 {
            let tau = cvy / g;
            consider(cx + cvx * tau, cy + tau * (cvy - 0.5 * g * tau));
        }
        let at_target = self.path_at(angle, distance);
        if at_target.height.is_finite() && at_target.height > best.1 {
            best = (distance, at_target.height);
        }
        best
    }

    /// Elevation that sends the projectile highest at `distance` (golden-section search).
    pub fn peak_angle(&self, distance: f64) -> f64 {
        let mut low = -ELEVATION_LIMIT;
        let mut high = ELEVATION_LIMIT;
        let mut left = high - GOLDEN * (high - low);
        let mut right = low + GOLDEN * (high - low);
        let mut left_height = self.height_at(left, distance);
        let mut right_height = self.height_at(right, distance);

        let mut i = 0;
        while i < MAX_ITERATIONS && high - low > ANGLE_TOLERANCE {
            if left_height < right_height {
                low = left;
                left = right;
                left_height = right_height;
                right = low + GOLDEN * (high - low);
                right_height = self.height_at(right, distance);
            } else {
                high = right;
                right = left;
                right_height = left_height;
                left = high - GOLDEN * (high - low);
                left_height = self.height_at(left, distance);
            }
            i += 1;
        }
        (low + high) / 2.0
    }

    /// Root of `error` beyond `top` (where `error(top) >= 0`) towards `direction` (-1: lower elevations,
    /// +1: higher): bracket expansion, then the Illinois method.
    fn find_root(
        error: impl Fn(f64) -> f64,
        top: f64,
        top_error: f64,
        direction: f64,
    ) -> f64 {
        let mut a = top;
        let mut error_a = top_error;
        let mut b = top;
        let mut error_b = top_error;

        let mut step = BRACKET_STEP;
        while error_b >= 0.0 {
            b = (top + direction * step).clamp(-ELEVATION_LIMIT, ELEVATION_LIMIT);
            error_b = error(b);
            if b.abs() == ELEVATION_LIMIT {
                break;
            }
            step *= 2.0;
        }

        let mut kept = 0;
        let mut root = b;
        let mut i = 0;
        while i < MAX_ITERATIONS && (b - a).abs() > ANGLE_TOLERANCE {
            root = (a * error_b - b * error_a) / (error_b - error_a);
            let error_root = error(root);
            if error_root.abs() <= HEIGHT_TOLERANCE {
                break;
            }
            if error_root < 0.0 {
                b = root;
                error_b = error_root;
                if kept == -1 {
                    error_a /= 2.0;
                }
                kept = -1;
            } else {
                a = root;
                error_a = error_root;
                if kept == 1 {
                    error_b /= 2.0;
                }
                kept = 1;
            }
            i += 1;
        }
        root
    }

    /// Barrel elevations that land the projectile on a target `distance` metres away horizontally from the
    /// pivot and `height` metres above the weapon's ground: `(low, high)` in radians, physical barrel angles.
    /// NaN for an arc out of range, and for a distance that is not positive or a height that is not finite.
    pub fn solve_elevation(&self, distance: f64, height: f64) -> (f64, f64) {
        if !(distance > 0.0) || !height.is_finite() {
            return (f64::NAN, f64::NAN);
        }

        let shot = &self.shot;
        let g = shot.gravity;
        let v = shot.velocity;

        if shot.is_parabola() && g > 0.0 && !shot.clamps_before(height) {
            let rise = height - shot.pivot_height;
            let discriminant = v.powi(4) - g * (g * distance.powi(2) + 2.0 * rise * v.powi(2));
            if discriminant < 0.0 {
                return (f64::NAN, f64::NAN);
            }
            let root = discriminant.sqrt();
            return (
                ((v.powi(2) - root) / (g * distance)).atan(),
                ((v.powi(2) + root) / (g * distance)).atan(),
            );
        }

        let top = self.peak_angle(distance);
        let top_error = self.height_at(top, distance) - height;
        if top_error < 0.0 {
            return (f64::NAN, f64::NAN);
        }

        let error = |angle: f64| self.height_at(angle, distance) - height;
        (
            Self::find_root(error, top, top_error, -1.0),
            Self::find_root(error, top, top_error, 1.0),
        )
    }

    /// Farthest target on flat ground (at the height of the weapon's ground), metres: the largest distance
    /// whose peak height reaches 0 (doubling, then bisection on the distance to 1 mm). Needs gravity > 0.
    pub fn max_range(&self) -> f64 {
        let shot = &self.shot;
        if shot.is_parabola() && shot.pivot_height == 0.0 {
            return shot.velocity.powi(2) / shot.gravity;
        }

        let reachable = |distance: f64| self.height_at(self.peak_angle(distance), distance) >= 0.0;
        let mut cruise = shot.velocity + shot.acceleration * shot.axis_boost_time();
        if shot.max_speed != 0.0 {
            cruise = cruise.min(shot.max_speed);
        }
        let mut low = 0.0;
        let mut high = shot.velocity.max(cruise).powi(2) / shot.gravity;
        while reachable(high) {
            low = high;
            high *= 2.0;
        }
        let mut i = 0;
        while i < MAX_ITERATIONS && high - low > 1e-3 {
            let middle = (low + high) / 2.0;
            if reachable(middle) {
                low = middle;
            } else {
                high = middle;
            }
            i += 1;
        }
        low
    }
}
