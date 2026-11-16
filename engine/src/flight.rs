//! Flight of a Squad projectile: where it is, and the elevation that lands it on a target.
//!
//! A port, function for function, of `src/js/squadBallistics.js` of SquadCalc (which is the same model as
//! Squad Ballistics, `ballistics.py`): the flight ([`Flight::height_at`], [`Flight::path_at`]; the closures of the
//! JS `trajectory` object are these two and [`Flight::above`]), the elevation solver with its warm start and the
//! check of a path against a terrain profile ([`Flight::above`], [`RangeMax`]). The model is the game's own: no
//! drag, gravity `g = world gravity x ProjectileGravityScale`, the barrel pivots at `pivot_height` above the
//! weapon's ground and the projectile starts at the muzzle, `muzzle_forward` along the barrel and `muzzle_up`
//! above its axis, so the launch point moves with the elevation. A rocket motor (ConstantAcceleration) pushes along the path for
//! `boost_time` seconds (in whole steps, see below) and `max_speed` caps the speed at every step.
//!
//! The game moves the projectile once per frame, in one step of the frame's length; the dedicated server runs
//! frames of [`FRAME_TIME`] = 1/49.87 s = 20.052 ms (the median of 48 055 ten-second `Server Tick Rate` samples
//! of the production server over 133.5 h, 99.51 % of them at 49.5 Hz or more; the Training server's median is
//! the same; the world time of two `FireProjectile()` log lines advanced 23.619521 s over 1178 frames, 20.0505 ms
//! each). A server under load (0.17 % of the samples are below 45 Hz) flies rockets differently: a limit of the
//! model. The motor acts on `ceil(T / dt) - 1` steps, one fewer than the steps that start before `T`: the
//! server's thrust runs while `float(CreationTime + Timeout) > World->TimeSeconds`, strict (`0xa747770`); the
//! projectile is spawned inside the RPC handler `ServerFireProjectileWithId_Implementation` (`0xa74f290`), which
//! runs in the network receive of `UWorld::Tick` (`0x804d3a0`) before the world time advances (`CreationTime` is
//! written in `AActor::PostSpawnInitialize`, `0x79ff162`), so at the k-th movement tick `now - creation = k dt`
//! and the motor acts while `k dt < T`. One link is inferred from stock engine behaviour and was not read in the
//! binary: the first movement tick is in the frame of the spawn (were it one frame later, the count would be
//! `ceil(T / dt)`). The 32-bit `CreationTime` rounds to 2 ms above a world time of 16 384 s, which can flip the
//! count for a short motor late in a long server session; that is not modelled. Binary excerpts, logs and the
//! integrator that checks the model independently: deadline-squad/deadline-squadcalc#49.
//!
//! Every phase that has a closed form is computed exactly: the parabola of a coasting shell, a motor along the
//! barrel's axis, a shell coasting at its speed cap (the path angle turns at a constant speed). A motor along
//! the path, or one that the cap could clamp, has none; the game's own steps are flown for it ([`fly_boost`]),
//! tabulated over the elevation and interpolated ([`BoostTable`]), exactly as the JS solver does, so that both
//! agree to rounding.
//!
//! Elevation for a target `D` metres away and `H` metres above the weapon's ground: the roots of
//! `F(theta) = y(theta, D) - H`. A plain parabola has the closed form; every other shot is solved by a
//! golden-section search for the highest elevation and the Illinois method on each side of it, started around
//! the roots of a neighbouring target when the caller has them ([`SolveHints`]). A root the muzzle has already
//! passed is no shot: the projectile starts at the muzzle and the flight is only extended backwards for the
//! searches.

use std::f64::consts::{FRAC_PI_2, PI};
use std::ops::RangeInclusive;
use std::sync::{Arc, OnceLock};

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
/// First half-width of the bracket around the guess of a warm-started root search, radians (doubled until it
/// holds the root): about the change of the root between two cells of the fire coverage.
pub const WARM_STEP: f64 = 2e-4;
/// The dedicated server's frame and the projectile's step, seconds: the reciprocal of the median 49.87 Hz of its
/// `Server Tick Rate` log lines (see the module documentation). The server aims at 50 Hz and its frames take
/// 20.052 ms.
pub const FRAME_TIME: f64 = 1.0 / 49.87;
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
    /// Whether the shot has a motor phase: a motor that acts on at least one step.
    pub fn has_boost(&self) -> bool {
        self.boost_steps() > 0
    }

    /// Steps the motor acts on: `ceil(boost_time / FRAME_TIME) - 1` (see the module documentation: the server's
    /// thrust is strict, `k dt < T`, from the first movement tick on); the `1e-9` keeps a `boost_time` that is a
    /// whole number of frames, up to rounding, from gaining a step. 0 without boost.
    ///
    /// Formula: F2 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn boost_steps(&self) -> usize {
        if !(self.boost_time > 0.0) || self.acceleration == 0.0 {
            return 0;
        }
        ((self.boost_time / FRAME_TIME - 1e-9).ceil() as usize).saturating_sub(1)
    }

    /// Seconds the motor acts: its steps, not the `boost_time` it is configured with. 0 without boost.
    ///
    /// Formula: F2 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn burn_time(&self) -> f64 {
        self.boost_steps() as f64 * FRAME_TIME
    }

    /// Whether the cap could clamp a motor along the barrel's axis.
    fn cap_binds_on_axis(&self) -> bool {
        if self.max_speed == 0.0 {
            return false;
        }
        let burn = self.burn_time();
        let end = (self.velocity + self.acceleration * burn).abs();
        self.velocity > self.max_speed || end + self.gravity * burn > self.max_speed
    }

    /// Whether the boost has no closed form and is flown with the game's steps: a motor along the path,
    /// or one along the barrel that the cap could clamp. A flight without gravity is straight either way.
    pub fn flies_boost_in_steps(&self) -> bool {
        if !self.has_boost() || self.gravity == 0.0 {
            return false;
        }
        self.rotation_follows_velocity || self.cap_binds_on_axis()
    }

    /// Whether the shot is fired faster than its cap without a motor: the first step slows it (tank HE).
    pub fn launch_clamped(&self) -> bool {
        self.max_speed != 0.0 && self.velocity > self.max_speed && !self.has_boost()
    }

    /// Seconds the closed-form motor along the barrel speeds the projectile up: the motor's
    /// [`burn_time`](Shot::burn_time) (whole steps), ended earlier by the cap in a straight flight.
    ///
    /// Formula: F11 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn axis_boost_time(&self) -> f64 {
        let burn = self.burn_time();
        if self.gravity == 0.0 && self.max_speed != 0.0 && self.acceleration > 0.0 {
            return burn.min(((self.max_speed - self.velocity) / self.acceleration).max(0.0));
        }
        burn
    }

    /// Whether the trajectory is the textbook parabola from the pivot (no boost, no muzzle offset, not fired
    /// above its cap), as long as it does not come down faster than its cap ([`Shot::clamps_before`]).
    ///
    /// Formula: F8 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn is_parabola(&self) -> bool {
        !self.has_boost()
            && self.muzzle_forward == 0.0
            && self.muzzle_up == 0.0
            && !self.launch_clamped()
    }

    /// Whether a plain parabola from the pivot comes down faster than its cap before it reaches a target
    /// `height` metres above the weapon's ground.
    ///
    /// Formula: F8 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn clamps_before(&self, height: f64) -> bool {
        if self.max_speed == 0.0 {
            return false;
        }
        let drop = self.pivot_height - height;
        self.velocity.powi(2) + 2.0 * self.gravity * drop > self.max_speed.powi(2)
    }

    /// The parameters a [`BoostTable`] of this shot depends on.
    pub fn boost_key(&self) -> BoostKey {
        BoostKey {
            velocity: self.velocity,
            gravity: self.gravity,
            acceleration: self.acceleration,
            boost_time: self.boost_time,
            max_speed: self.max_speed,
            rotation_follows_velocity: self.rotation_follows_velocity,
        }
    }

    /// Where the projectile starts for an elevation: `(metres ahead of the pivot, metres above the ground)`.
    ///
    /// Formula: F5 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn launch_point(&self, angle: f64) -> (f64, f64) {
        let (sin, cos) = angle.sin_cos();
        (
            self.muzzle_forward * cos - self.muzzle_up * sin,
            self.pivot_height + self.muzzle_forward * sin + self.muzzle_up * cos,
        )
    }
}

/// The boost of a shot fired at one angle, flown with the game's steps from the muzzle.
#[derive(Debug, Clone)]
pub struct BoostNode {
    /// X (metres from the muzzle) at the start of every step and at the end.
    pub xs: Vec<f64>,
    /// Y (metres from the muzzle) at the start of every step and at the end.
    pub ys: Vec<f64>,
    /// Horizontal velocity at the end of the boost, m/s.
    pub vx: f64,
    /// Vertical velocity at the end of the boost, m/s.
    pub vy: f64,
}

/// Flies the boost of a shot fired at `angle` with the game's steps (Velocity Verlet, rotation following
/// the velocity, speed cap at every step).
///
/// Formula: F3 in docs/thesis-methods-and-results.md of mapping-squad.
pub fn fly_boost(shot: &Shot, angle: f64) -> BoostNode {
    let dt = FRAME_TIME;
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

/// What a [`BoostTable`] depends on: the parameters of the flight relative to the muzzle (the pivot height and
/// the muzzle's offsets move the whole path and are not part of it).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoostKey {
    velocity: f64,
    gravity: f64,
    acceleration: f64,
    boost_time: f64,
    max_speed: f64,
    rotation_follows_velocity: bool,
}

/// What a caller that solves a row of neighbouring targets already knows, for [`Flight::solve_elevation_with`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolveHints {
    /// [`Flight::peak_angle`] of the target's distance, when the caller has it.
    pub peak: Option<f64>,
    /// Whether the low arc is wanted (the fire coverage skips the arcs the weapon cannot fire); not wanted: NaN.
    pub wanted_low: bool,
    /// Whether the high arc is wanted; not wanted: NaN.
    pub wanted_high: bool,
    /// The low root of a neighbouring target, radians: the search starts around it; NaN for an arc without one.
    pub guess_low: f64,
    /// The high root of a neighbouring target, radians; NaN for an arc without one.
    pub guess_high: f64,
}

impl Default for SolveHints {
    /// No hints: both arcs wanted, searched from the highest elevation.
    fn default() -> Self {
        SolveHints {
            peak: None,
            wanted_low: true,
            wanted_high: true,
            guess_low: f64::NAN,
            guess_high: f64::NAN,
        }
    }
}

/// Sparse table of the maximum of a terrain profile over any range of samples: [`RangeMax::max`] in O(1) after a
/// build in O(n log n). [`Flight::above`] uses it to clear a whole stretch of the profile with one comparison.
#[derive(Debug, Clone)]
pub struct RangeMax {
    levels: Vec<Vec<f64>>,
}

impl RangeMax {
    /// Indexes the maxima of `profile` (heights).
    ///
    /// Formula: F23 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn new(profile: &[f64]) -> Self {
        let size = profile.len();
        let mut levels = vec![profile.to_vec()];
        let mut span = 1;
        while span * 2 <= size {
            let previous = &levels[levels.len() - 1];
            let next = (0..=size - span * 2)
                .map(|i| previous[i].max(previous[i + span]))
                .collect();
            levels.push(next);
            span *= 2;
        }
        RangeMax { levels }
    }

    /// Largest height of the samples from `first` to `last` (indices, `first <= last`).
    ///
    /// Formula: F23 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn max(&self, first: usize, last: usize) -> f64 {
        let level = (last - first + 1).ilog2() as usize;
        self.levels[level][first].max(self.levels[level][last + 1 - (1 << level)])
    }
}

/// Samples of a stretch of the profile that [`Flight::above`] checks one by one instead of halving it.
const COAST_LEAF: usize = 8;

/// [`Flight::above`] on a concave stretch of the path: the heights `sample(i)` rise to an apex and fall, so the
/// stretch from `first` to `last` splits at the apex (a binary search on the sign of the slope) into two
/// monotone ones, each cleared by [`clears_stretch`].
fn concave_above(
    profile: &[f64],
    first: usize,
    last: usize,
    range_max: &RangeMax,
    sample: &dyn Fn(usize) -> f64,
) -> bool {
    // The last sample of the rising stretch: the first one the next sample falls below
    let mut low = first;
    let mut high = last;
    while low < high {
        let middle = (low + high) >> 1;
        if sample(middle + 1) < sample(middle) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    let rising = low;
    if !clears_stretch(profile, range_max, sample, first, rising) {
        return false;
    }
    rising == last || clears_stretch(profile, range_max, sample, rising + 1, last)
}

/// Whether the monotone stretch of the path from sample `from` to `to` is at or above the profile. The heights of
/// the path lie between its two ends: it clears the whole stretch when the highest terrain sample is at or under
/// the lower end, and none of it when that sample is over the higher end (it is over the path); otherwise the
/// stretch is halved.
fn clears_stretch(
    profile: &[f64],
    range_max: &RangeMax,
    sample: &dyn Fn(usize) -> f64,
    from: usize,
    to: usize,
) -> bool {
    let (height_from, height_to) = (sample(from), sample(to));
    if to - from < COAST_LEAF {
        if (from + 1..to).any(|i| sample(i) < profile[i]) {
            return false;
        }
        return !(height_from < profile[from] || height_to < profile[to]);
    }
    let highest = range_max.max(from, to);
    if highest <= height_from.min(height_to) {
        return true;
    }
    if highest > height_from.max(height_to) {
        return false;
    }
    let middle = (from + to) >> 1;
    clears_stretch(profile, range_max, sample, from, middle)
        && clears_stretch(profile, range_max, sample, middle + 1, to)
}

/// A stepped boost tabulated over the barrel elevation: nodes every [`BOOST_NODE_SPACING`] from -90 to +90
/// degrees, each flown the first time it is needed, and four-point Lagrange interpolation between them.
#[derive(Debug)]
pub struct BoostTable {
    shot: Shot,
    /// Steps of the boost.
    pub steps: usize,
    count: usize,
    nodes: Vec<OnceLock<BoostNode>>,
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

    /// Interpolated x of step point `k`.
    ///
    /// Formula: F15 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn x(&self, k: usize) -> f64 {
        self.mix(|n| n.xs[k])
    }

    /// Interpolated y of step point `k`.
    ///
    /// Formula: F15 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn y(&self, k: usize) -> f64 {
        self.mix(|n| n.ys[k])
    }

    /// Interpolated horizontal end velocity.
    ///
    /// Formula: F15 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn vx(&self) -> f64 {
        self.mix(|n| n.vx)
    }

    /// Interpolated vertical end velocity.
    ///
    /// Formula: F15 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn vy(&self) -> f64 {
        self.mix(|n| n.vy)
    }

    /// The step whose straight segment holds the distance `ahead` from the muzzle (the first one for a
    /// distance behind the muzzle), found by binary search on the interpolated x.
    ///
    /// Formula: F17 in docs/thesis-methods-and-results.md of mapping-squad.
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
            nodes: (0..count).map(|_| OnceLock::new()).collect(),
        }
    }

    /// The parameters this table was built for.
    pub fn key(&self) -> BoostKey {
        self.shot.boost_key()
    }

    fn node(&self, index: usize) -> &BoostNode {
        self.nodes[index]
            .get_or_init(|| fly_boost(&self.shot, -FRAC_PI_2 + index as f64 * BOOST_NODE_SPACING))
    }

    /// The four nodes that interpolate `angle` (two on each side, shifted inwards at the ends) and their weights.
    ///
    /// Formula: F15 in docs/thesis-methods-and-results.md of mapping-squad.
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

/// State after the first step of a shell fired above its cap: the velocity `v0 + g*dt` clamped to the cap.
struct ClampedLaunch {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

fn clamped_launch(shot: &Shot, cos: f64, sin: f64) -> ClampedLaunch {
    let v0 = shot.velocity;
    let mut vx = v0 * cos;
    let mut vy = v0 * sin - shot.gravity * FRAME_TIME;
    let scale = shot.max_speed / vx.hypot(vy);
    vx *= scale;
    vy *= scale;
    ClampedLaunch {
        x: 0.5 * (v0 * cos + vx) * FRAME_TIME,
        y: 0.5 * (v0 * sin + vy) * FRAME_TIME,
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

/// A shot ready to fly: the [`Shot`] and, for a stepped boost, its lazily filled [`BoostTable`], which a caller
/// that flies the same weapon again shares (see [`Flight::with_table`]; a table costs a hundred boosts).
#[derive(Debug)]
pub struct Flight {
    /// How the weapon fires.
    pub shot: Shot,
    table: Option<Arc<BoostTable>>,
}

impl Flight {
    /// Prepares `shot` for flying, with a boost table of its own if it needs one.
    pub fn new(shot: Shot) -> Self {
        let table = shot
            .flies_boost_in_steps()
            .then(|| Arc::new(BoostTable::new(shot)));
        Flight { shot, table }
    }

    /// Prepares `shot` for flying with the boost table of an earlier flight of the same parameters. The table is
    /// used when `shot` needs one and `table` was built for the same [`BoostKey`]; otherwise a new one is built.
    pub fn with_table(shot: Shot, table: Option<&Arc<BoostTable>>) -> Self {
        let table = shot.flies_boost_in_steps().then(|| match table {
            Some(table) if table.key() == shot.boost_key() => Arc::clone(table),
            _ => Arc::new(BoostTable::new(shot)),
        });
        Flight { shot, table }
    }

    /// The boost table, if the shot has a stepped boost, to give to [`Flight::with_table`] for the next flight.
    pub fn boost_table(&self) -> Option<&Arc<BoostTable>> {
        self.table.as_ref()
    }

    fn table(&self) -> &BoostTable {
        self.table
            .as_ref()
            .expect("a stepped boost always has a table")
    }

    /// Height of the projectile when it is `distance` metres away horizontally from the pivot, with the
    /// barrel at elevation `angle`.
    ///
    /// Formula: F6, F11, F12, F13, F14, F17 in docs/thesis-methods-and-results.md of mapping-squad.
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
                    + (next_y - start_point_y) * (ahead - start_point_x)
                        / (next_x - start_point_x);
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
    ///
    /// Formula: F6, F11, F12, F13, F14, F17 in docs/thesis-methods-and-results.md of mapping-squad.
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
                    time: ((k as f64 + part) * FRAME_TIME).max(0.0),
                    angle: (by - ay).atan2(bx - ax),
                }
            } else {
                coast_at(
                    shot,
                    end_x,
                    stencil.y(steps),
                    stencil.vx(),
                    stencil.vy(),
                    steps as f64 * FRAME_TIME,
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
                    time: (FRAME_TIME * ahead / first.x).max(0.0),
                    angle: first.y.atan2(first.x),
                }
            } else {
                coast_at(
                    shot, first.x, first.y, first.vx, first.vy, FRAME_TIME, ahead,
                )
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
            (
                stencil.x(table.steps),
                stencil.y(table.steps),
                stencil.vx(),
                stencil.vy(),
            )
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
    ///
    /// Formula: F18 in docs/thesis-methods-and-results.md of mapping-squad.
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
    /// +1: higher): bracket expansion, then the Illinois method. A `guess` (a root found for a neighbouring
    /// target) that lies beyond `top` in `direction` builds the bracket around it from [`WARM_STEP`]; NaN: from
    /// `top`. NaN when `error` stays at or above 0 up to [`ELEVATION_LIMIT`] (no root).
    fn find_root(
        error: impl Fn(f64) -> f64,
        top: f64,
        top_error: f64,
        direction: f64,
        guess: f64,
    ) -> f64 {
        // Bracket [a, b]: error(a) >= 0 on the top side, error(b) < 0 on the far side
        let mut a = top;
        let mut error_a = top_error;
        let mut b = top;
        let mut error_b = top_error;

        if direction * (guess - top) > 0.0 && guess.abs() <= ELEVATION_LIMIT {
            let guess_error = error(guess);
            a = guess;
            b = guess;
            error_a = guess_error;
            error_b = guess_error;
            if guess_error >= 0.0 {
                let mut step = WARM_STEP;
                while error_b >= 0.0 {
                    b = (guess + direction * step).clamp(-ELEVATION_LIMIT, ELEVATION_LIMIT);
                    error_b = error(b);
                    if b.abs() == ELEVATION_LIMIT {
                        break;
                    }
                    step *= 2.0;
                }
            } else {
                let mut step = WARM_STEP;
                while error_a < 0.0 {
                    a = guess - direction * step;
                    if direction * (a - top) <= 0.0 {
                        a = top;
                        error_a = top_error;
                        break;
                    }
                    error_a = error(a);
                    step *= 2.0;
                }
            }
        } else {
            let mut step = BRACKET_STEP;
            while error_b >= 0.0 {
                b = (top + direction * step).clamp(-ELEVATION_LIMIT, ELEVATION_LIMIT);
                error_b = error(b);
                if b.abs() == ELEVATION_LIMIT {
                    break;
                }
                step *= 2.0;
            }
        }

        if error_b >= 0.0 {
            return f64::NAN;
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
    /// NaN for an arc out of range, for an arc whose root the muzzle has already passed (the projectile starts
    /// at the muzzle: the barrel's own line through the target is no shot), and for a distance that is not
    /// positive or a height that is not finite.
    ///
    /// Formula: F7, F8, F9, F18, F19, F20 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn solve_elevation(&self, distance: f64, height: f64) -> (f64, f64) {
        self.solve_elevation_with(distance, height, SolveHints::default())
    }

    /// [`Flight::solve_elevation`] for a caller that solves a row of neighbouring targets (the fire coverage,
    /// along a ray) and passes what it already knows ([`SolveHints`]). The roots are the same to the tolerances
    /// of the search; the hints save about half of the evaluations.
    ///
    /// Formula: F7, F8, F9, F18, F19, F20 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn solve_elevation_with(
        &self,
        distance: f64,
        height: f64,
        hints: SolveHints,
    ) -> (f64, f64) {
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
            let high = (v.powi(2) + discriminant.sqrt()) / (g * distance);
            // The roots of tan^2 - (2 v^2 / (g d)) tan + (1 + 2 rise v^2 / (g d^2)) = 0 multiply to its constant
            // term: the low one from the product, not from (v^2 - sqrt(D)) / (g d), which subtracts nearly
            // equal numbers for a small d
            let low = (1.0 + 2.0 * rise * v.powi(2) / (g * distance.powi(2))) / high;
            return (low.atan(), high.atan());
        }

        let top = hints.peak.unwrap_or_else(|| self.peak_angle(distance));
        let top_error = self.height_at(top, distance) - height;
        if top_error < 0.0 {
            return (f64::NAN, f64::NAN);
        }

        let error = |angle: f64| self.height_at(angle, distance) - height;
        // The projectile starts at the muzzle. height_at extends the first phase behind it, so a root can be the
        // barrel's own line through a target the muzzle has already passed: that is not a shot
        let past_muzzle = |root: f64| {
            if shot.launch_point(root).0 < distance {
                root
            } else {
                f64::NAN
            }
        };
        let low = if hints.wanted_low {
            past_muzzle(Self::find_root(
                error,
                top,
                top_error,
                -1.0,
                hints.guess_low,
            ))
        } else {
            f64::NAN
        };
        let high = if hints.wanted_high {
            past_muzzle(Self::find_root(
                error,
                top,
                top_error,
                1.0,
                hints.guess_high,
            ))
        } else {
            f64::NAN
        };
        (low, high)
    }

    /// Whether the path at elevation `angle` stays at or above a terrain profile sampled every `step` metres
    /// from the pivot, over the `samples` indices (`profile[i]` is the terrain at distance `i * step`), the
    /// weapon's ground being `ground` in the profile's reference: `ground + height(i * step) >= profile[i]` for
    /// every sample (the fire coverage). False for a NaN angle. With a [`RangeMax`] of the profile the samples
    /// after a stepped boost are cleared by stretches: the path there (the coast, or the closed-form flight
    /// without a stepped boost) is concave, so it splits at its apex into two monotone stretches, and a
    /// monotone stretch is clear when the highest terrain sample is at or under its lower end and blocked when
    /// that sample is over its higher end; otherwise it is halved. The answer is that of the sample-by-sample
    /// check, in O(log n) comparisons when the path does not graze the terrain.
    ///
    /// Formula: F22, F23, F24 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn above(
        &self,
        angle: f64,
        profile: &[f64],
        samples: RangeInclusive<usize>,
        step: f64,
        ground: f64,
        range_max: Option<&RangeMax>,
    ) -> bool {
        if angle.is_nan() {
            return false;
        }
        let (first, last) = (*samples.start(), *samples.end());
        if samples.is_empty() {
            return true;
        }
        let sample = |i: usize| ground + self.height_at(angle, i as f64 * step);
        let Some(range_max) = range_max else {
            return (first..=last).all(|i| !(sample(i) < profile[i]));
        };

        let mut i = first;
        if self.shot.flies_boost_in_steps() {
            // The stepped boost is not concave: its samples are checked one by one
            let (start_x, _) = self.shot.launch_point(angle);
            let end_x = self.table().stencil(angle).x(self.table().steps);
            while i <= last && i as f64 * step - start_x < end_x {
                if sample(i) < profile[i] {
                    return false;
                }
                i += 1;
            }
            if i > last {
                return true;
            }
        }
        concave_above(profile, i, last, range_max, &sample)
    }

    /// Farthest target on flat ground (at the height of the weapon's ground), metres: the largest distance
    /// whose peak height reaches 0 (doubling, then bisection on the distance to 1 mm). Needs gravity > 0.
    ///
    /// Formula: F10 in docs/thesis-methods-and-results.md of mapping-squad.
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

#[cfg(test)]
mod tests {
    use super::*;

    const WORLD_GRAVITY: f64 = 9.8;

    /// A shot of the catalogue: `(velocity, gravity scale, acceleration, boost time, max speed)` and the launch
    /// point.
    fn shot(
        (velocity, gravity_scale, acceleration, boost_time, max_speed): (f64, f64, f64, f64, f64),
        rotation_follows_velocity: bool,
        (pivot_height, muzzle_forward, muzzle_up): (f64, f64, f64),
    ) -> Shot {
        Shot {
            velocity,
            gravity: WORLD_GRAVITY * gravity_scale,
            acceleration,
            boost_time,
            max_speed,
            rotation_follows_velocity,
            pivot_height,
            muzzle_forward,
            muzzle_up,
        }
    }

    fn ub32() -> Shot {
        shot(
            (300.0, 2.0, -50.0, 2.0, 300.0),
            false,
            (2.2659, 1.4303, 0.2513),
        )
    }

    fn rpg7() -> Shot {
        shot((117.0, 1.0, 150.0, 0.8, 250.0), true, (0.0, 0.0, 0.0))
    }

    fn mortar() -> Shot {
        shot((110.0, 1.0, 0.0, 0.0, 0.0), true, (0.0245, 1.569, 0.002))
    }

    fn tank_ap() -> Shot {
        shot(
            (1300.0, 2.5, 0.0, 0.0, 1500.0),
            true,
            (1.8356, 5.1178, -0.0127),
        )
    }

    /// The server's frame as measured, written here apart from [`FRAME_TIME`] so that the tests do not follow a
    /// change of the constant.
    const SERVER_FRAME: f64 = 1.0 / 49.87;

    /// A flight written from the server's rule and not from [`fly_boost`]: one Velocity Verlet step per server
    /// frame, the motor acting on the first `ceil(T / frame) - 1` steps, the cap on every step. Returns the height
    /// and the time at `distance` on the straight segment of the step that crosses it.
    fn fly_server_rule(shot: &Shot, angle: f64, distance: f64) -> (f64, f64) {
        let motor_steps = if shot.boost_time > 0.0 && shot.acceleration != 0.0 {
            (shot.boost_time / SERVER_FRAME - 1e-9).ceil() as usize - 1
        } else {
            0
        };
        let clamp = |vx: f64, vy: f64| {
            let speed = vx.hypot(vy);
            if shot.max_speed > 0.0 && speed > shot.max_speed {
                (vx * shot.max_speed / speed, vy * shot.max_speed / speed)
            } else {
                (vx, vy)
            }
        };
        let (mut x, mut y) = shot.launch_point(angle);
        let (sin, cos) = angle.sin_cos();
        let (mut vx, mut vy) = (shot.velocity * cos, shot.velocity * sin);
        let (mut ax, mut ay) = (shot.acceleration * cos, shot.acceleration * sin);
        for step in 0..1_000_000 {
            let push = if step < motor_steps { 1.0 } else { 0.0 };
            let (mx, my) = clamp(
                vx + push * ax * SERVER_FRAME,
                vy + (push * ay - shot.gravity) * SERVER_FRAME,
            );
            let next_x = x + 0.5 * (vx + mx) * SERVER_FRAME;
            let next_y = y + 0.5 * (vy + my) * SERVER_FRAME;
            if shot.rotation_follows_velocity {
                let speed = vx.hypot(vy);
                (ax, ay) = (
                    shot.acceleration * vx / speed,
                    shot.acceleration * vy / speed,
                );
            }
            (vx, vy) = clamp(
                vx + push * ax * SERVER_FRAME,
                vy + (push * ay - shot.gravity) * SERVER_FRAME,
            );
            if next_x >= distance {
                let part = (distance - x) / (next_x - x);
                return (y + (next_y - y) * part, (step as f64 + part) * SERVER_FRAME);
            }
            (x, y) = (next_x, next_y);
        }
        panic!("the flight never reaches {distance} m");
    }

    /// Misses of the solver's roots against the reference flight, metres.
    fn misses(shot: &Shot, distance: f64, height: f64) -> Vec<f64> {
        let (low, high) = Flight::new(*shot).solve_elevation(distance, height);
        [low, high]
            .into_iter()
            .filter(|root| !root.is_nan())
            .map(|root| fly_server_rule(shot, root, distance).0 - height)
            .collect()
    }

    #[test]
    fn the_frame_is_the_measured_server_frame_and_the_motor_acts_on_one_step_fewer() {
        assert_eq!(FRAME_TIME, SERVER_FRAME);
        let motor = |boost_time: f64, acceleration: f64| Shot {
            boost_time,
            acceleration,
            ..rpg7()
        };
        // 0.8 s is 39.9 frames: 40 steps start before it ends, the motor acts on 39
        assert_eq!(motor(0.8, 150.0).boost_steps(), 39);
        assert_eq!(motor(2.0 * SERVER_FRAME, 150.0).boost_steps(), 1);
        assert_eq!(motor(SERVER_FRAME, 150.0).boost_steps(), 0);
        assert_eq!(motor(0.8, 0.0).boost_steps(), 0);
        assert!(!motor(SERVER_FRAME, 150.0).flies_boost_in_steps());
        assert_eq!(motor(0.8, 150.0).burn_time(), 39.0 * SERVER_FRAME);
    }

    /// A time that is a whole number of frames up to rounding (the `1e-9` of `boost_steps`) does not gain a step;
    /// one beyond that does.
    #[test]
    fn a_motor_of_a_whole_number_of_frames_up_to_1e_9_of_a_frame_does_not_gain_a_step() {
        let frames = |count: f64| Shot {
            boost_time: count * SERVER_FRAME,
            acceleration: 100.0,
            gravity: 0.0,
            max_speed: 1000.0,
            ..rpg7()
        };
        assert_eq!(
            frames(40.0 + 1e-10).boost_steps(),
            39,
            "a rounding above 40 frames"
        );
        assert_eq!(
            frames(40.0 - 1e-10).boost_steps(),
            39,
            "a rounding below 40 frames"
        );
        assert_eq!(
            frames(40.0 + 2e-9).boost_steps(),
            40,
            "2e-9 of a frame past 40 frames"
        );
        assert_eq!(frames(40.0 + 1e-10).burn_time(), 39.0 * SERVER_FRAME);
        assert_eq!(frames(40.0 + 1e-10).axis_boost_time(), 39.0 * SERVER_FRAME);
        let with_gravity = |count: f64| Shot {
            gravity: WORLD_GRAVITY,
            ..frames(count)
        };
        assert!(
            !with_gravity(1.0 + 1e-10).has_boost(),
            "a motor of one frame and a rounding never acts"
        );
        assert!(!with_gravity(1.0 + 1e-10).flies_boost_in_steps());
        assert!(
            with_gravity(1.0 + 2e-9).flies_boost_in_steps(),
            "2e-9 of a frame past one frame acts on one step"
        );
        assert_eq!(frames(1.0 + 1e-10).axis_boost_time(), 0.0);
        assert_eq!(frames(1.0 + 2e-9).axis_boost_time(), SERVER_FRAME);
    }

    /// The closed-form motor along the axis ends with its steps, or earlier when the cap is reached in a flight
    /// without gravity.
    #[test]
    fn the_axis_motor_ends_at_the_cap_when_it_is_reached_before_the_burn_ends() {
        let nlaw = Shot {
            velocity: 40.0,
            gravity: 0.0,
            acceleration: 350.0,
            boost_time: 0.65,
            max_speed: 250.0,
            ..rpg7()
        };
        assert_eq!(nlaw.boost_steps(), 32);
        assert!(nlaw.burn_time() > 0.64, "the burn is 0.6417 s");
        assert!(
            (nlaw.axis_boost_time() - 0.6).abs() < 1e-12,
            "{} s to the cap, not the burn",
            nlaw.axis_boost_time()
        );
        let burn = nlaw.burn_time();
        let with = |change: &dyn Fn(Shot) -> Shot| change(nlaw).axis_boost_time();
        assert_eq!(
            with(&|s| Shot {
                max_speed: 1000.0,
                ..s
            }),
            burn,
            "a cap that is not reached"
        );
        assert_eq!(
            with(&|s| Shot {
                max_speed: 0.0,
                ..s
            }),
            burn,
            "no cap"
        );
        assert_eq!(
            with(&|s| Shot {
                velocity: 260.0,
                ..s
            }),
            0.0,
            "fired above the cap: the motor adds nothing"
        );
        assert_eq!(
            with(&|s| Shot {
                gravity: WORLD_GRAVITY,
                ..s
            }),
            burn,
            "with gravity the cap does not end the motor"
        );
        let slowing = Shot {
            acceleration: -50.0,
            ..nlaw
        };
        assert_eq!(
            slowing.axis_boost_time(),
            slowing.burn_time(),
            "a motor that slows down is not ended by the cap"
        );
    }

    /// Whether the cap could clamp a motor along the axis is asked with the steps the motor acts on, not with
    /// its time.
    #[test]
    fn the_cap_of_an_axis_motor_binds_on_the_speed_after_its_steps_not_after_its_time() {
        // 100 m/s and 100 m/s^2 for 49 steps (0.98254 s): 198.254 m/s, 208.08 with gravity; the 1 s would reach 210
        let motor = Shot {
            velocity: 100.0,
            gravity: 10.0,
            acceleration: 100.0,
            boost_time: 1.0,
            rotation_follows_velocity: false,
            ..rpg7()
        };
        assert_eq!(motor.boost_steps(), 49);
        let capped = |max_speed: f64| Shot { max_speed, ..motor }.flies_boost_in_steps();
        assert!(!capped(209.0), "the steps do not reach the cap");
        assert!(
            !capped(208.2),
            "the gravity term is that of the steps (208.08), not of the time (208.25)"
        );
        assert!(capped(208.0), "the steps do reach the cap");
        let at_end = (motor.velocity + motor.acceleration * motor.burn_time()).abs()
            + motor.gravity * motor.burn_time();
        assert!(!capped(at_end), "a speed at the cap is not clamped");
        assert!(
            Shot {
                max_speed: 90.0,
                acceleration: 1.0,
                ..motor
            }
            .flies_boost_in_steps(),
            "fired above the cap"
        );
        assert!(
            Shot {
                velocity: 300.0,
                acceleration: -100.0,
                max_speed: 250.0,
                ..motor
            }
            .flies_boost_in_steps(),
            "fired above the cap and slowed under it by the motor"
        );
        assert!(!capped(0.0), "no cap");
        // A motor that slows the projectile past zero: the speed at the end is the magnitude of v0 + a T
        let reversing = Shot {
            velocity: 10.0,
            acceleration: -200.0,
            ..motor
        };
        assert!(
            Shot {
                max_speed: 150.0,
                ..reversing
            }
            .flies_boost_in_steps(),
            "the end speed is 186 m/s backwards"
        );
        assert!(!Shot {
            max_speed: 250.0,
            ..reversing
        }
        .flies_boost_in_steps());
    }

    #[test]
    fn a_motor_shot_lands_on_the_target_in_a_flight_of_the_servers_frames() {
        for height in [-100.0, -10.0] {
            let found = misses(&ub32(), 2183.06736034, height);
            assert_eq!(found.len(), 2);
            for miss in found {
                assert!(miss.abs() < 0.05, "UB-32 misses by {miss} m");
            }
        }
        let path_motors = [
            (
                "TBG-7V",
                shot((63.0, 1.0, 150.0, 0.6, 160.0), true, (0.0, 0.0, 0.0)),
                450.0,
            ),
            (
                "PG-7VR",
                shot((63.0, 1.0, 45.0, 0.6, 160.0), true, (0.0, 0.0, 0.0)),
                340.0,
            ),
            (
                "PF98 HE-I",
                shot((220.0, 1.0, 180.0, 1.5, 220.0), true, (0.0, 0.0, 0.0)),
                700.0,
            ),
            ("RPG-7", rpg7(), 500.0),
        ];
        for (name, shot, distance) in path_motors {
            for height in [-20.0, 0.0, 20.0] {
                let found = misses(&shot, distance, height);
                assert!(!found.is_empty(), "{name} reaches {distance} m");
                for miss in found {
                    assert!(
                        miss.abs() < 0.05,
                        "{name} misses by {miss} m at {distance} m"
                    );
                }
            }
        }
    }

    /// The tank gun's high-explosive shell: fired at 1100 m/s above its 850 m/s cap, so the first step slows it.
    fn tank_he() -> Shot {
        shot(
            (1100.0, 2.0, 0.0, 0.0, 850.0),
            true,
            (1.8356, 5.1178, -0.0127),
        )
    }

    /// The time of flight is the number of the server's frames (fractions of the last one): a motor along the path,
    /// inside the boost (distances up to 140 m) and past it, the closed-form motor along the barrel, and the first
    /// step of a shell fired above its cap (the muzzle is 5 m ahead of the pivot, the first step 22 m long). The
    /// bounds are the measured differences between the closed forms and the stepped flight (1.2e-5 s, 2.7e-3 m at
    /// the worst) and sit well under what a frame of 0.02 s instead of 1 / 49.87 s changes: 2.5e-3 of the time.
    #[test]
    fn the_time_of_flight_and_the_height_follow_the_servers_frames() {
        let cases = [
            ("RPG-7", rpg7(), vec![20.0, 60.0, 140.0, 300.0, 600.0]),
            ("UB-32", ub32(), vec![450.0, 1000.0, 2000.0]),
            ("tank HE", tank_he(), vec![10.0, 15.0, 100.0, 1000.0]),
        ];
        let mut compared = 0;
        for (name, shot, distances) in cases {
            let flight = Flight::new(shot);
            for distance in distances {
                let (low, high) = flight.solve_elevation(distance, 0.0);
                for root in [low, high].into_iter().filter(|root| !root.is_nan()) {
                    let (height, time) = fly_server_rule(&shot, root, distance);
                    let flown = flight.path_at(root, distance);
                    assert!(
                        (flown.time - time).abs() < 2.5e-5,
                        "{name} at {distance} m: {} s, the server's frames {time} s",
                        flown.time
                    );
                    assert!(
                        (flown.height - height).abs() < 3e-3,
                        "{name} at {distance} m: {} m, the server's frames {height} m",
                        flown.height
                    );
                    compared += 1;
                }
            }
        }
        assert!(compared >= 14, "{compared} flights compared");
    }

    #[test]
    fn the_axis_motor_of_a_time_that_is_not_whole_frames_burns_for_its_steps() {
        let shot = Shot {
            boost_time: 2.005,
            ..ub32()
        };
        assert!(!shot.flies_boost_in_steps());
        let found = misses(&shot, 2000.0, 0.0);
        assert_eq!(found.len(), 2);
        for miss in found {
            assert!(miss.abs() < 0.005, "the axis motor misses by {miss} m");
        }
    }

    #[test]
    fn no_low_arc_when_there_is_no_root() {
        // SPG-9 FRAG with its muzzle, 0.786 m below the pivot at 8 and 10 cm: the search used to return an angle
        // of 6840 rad and 3.8 rad
        let spg9 = shot(
            (315.0, 1.2, 100.0, 1.1, 250.0),
            true,
            (0.6443, 1.7739, 0.1231),
        );
        let flight = Flight::new(spg9);
        for distance in [0.08050000000000006, 0.1] {
            let (low, _) = flight.solve_elevation(distance, -0.786);
            assert!(low.is_nan(), "low {low} rad at {distance} m");
        }
    }

    #[test]
    fn every_root_is_a_barrel_angle() {
        let shots = [mortar(), tank_ap(), rpg7(), ub32()];
        for shot in shots {
            let flight = Flight::new(shot);
            for distance in [0.01, 0.0326, 0.0805, 0.1, 0.17, 0.5, 1.0, 2.0, 5.0] {
                for height in [-5.0, -0.786, 0.0, 1.0, 5.0] {
                    let (low, high) = flight.solve_elevation(distance, height);
                    for root in [low, high] {
                        assert!(
                            root.is_nan() || root.abs() < FRAC_PI_2,
                            "{root} rad at {distance} m"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_target_the_muzzle_has_passed_has_no_elevation() {
        // The mortar's muzzle is 1.569 m ahead of the pivot: a target 0.5 m ahead and 1 m up is behind it
        let flight = Flight::new(mortar());
        for distance in [0.1, 0.3885, 0.5, 1.0, 1.5] {
            let (low, high) = flight.solve_elevation(distance, 1.0);
            for root in [low, high] {
                assert!(
                    root.is_nan() || flight.shot.launch_point(root).0 < distance,
                    "{root} rad for a target {distance} m ahead"
                );
            }
        }
        let tank = Flight::new(tank_ap());
        let (low, _) = tank.solve_elevation(3.0, 2.0);
        assert!(
            low.is_nan(),
            "a target inside the tank gun's barrel: {low} rad"
        );
    }

    #[test]
    fn a_target_just_past_the_muzzle_keeps_its_elevation() {
        for shot in [mortar(), tank_ap()] {
            let flight = Flight::new(shot);
            let level = shot.launch_point(0.0);
            let distance = level.0 + 1.0;
            let (low, _) = flight.solve_elevation(distance, level.1);
            assert!(!low.is_nan());
            assert!(shot.launch_point(low).0 < distance);
            assert!((flight.height_at(low, distance) - level.1).abs() < 1e-6);
        }
    }

    /// `tan(low)` of a plain parabola by the rationalised form `(g d + 2 rise v^2 / d) / (v^2 + sqrt(D))`, which
    /// has no subtraction of nearly equal numbers either, apart from the implementation's product form.
    fn low_tangent(v: f64, g: f64, d: f64, rise: f64) -> f64 {
        let discriminant = v.powi(4) - g * (g * d * d + 2.0 * rise * v * v);
        (g * d + 2.0 * rise * v * v / d) / (v * v + discriminant.sqrt())
    }

    #[test]
    fn the_low_arc_of_a_plain_parabola_has_no_cancellation_for_a_close_target_of_a_fast_shell() {
        let mut compared = 0;
        for velocity in [110.0_f64, 300.0, 1000.0, 1400.0, 1800.0] {
            for gravity in [1.96, 9.8, 19.6] {
                for distance in [0.5, 1.0, 2.0, 3.5, 6.0, 25.0, 100.0, 1000.0] {
                    for rise in [-4.0, -1.0, -0.25, 0.0, 0.25, 1.0, 4.0] {
                        let discriminant = velocity.powi(4)
                            - gravity
                                * (gravity * distance * distance
                                    + 2.0 * rise * velocity * velocity);
                        if discriminant < 0.0 {
                            continue;
                        }
                        let flight = Flight::new(Shot {
                            velocity,
                            gravity,
                            acceleration: 0.0,
                            boost_time: 0.0,
                            max_speed: 0.0,
                            rotation_follows_velocity: true,
                            pivot_height: 0.0,
                            muzzle_forward: 0.0,
                            muzzle_up: 0.0,
                        });
                        let (low, _) = flight.solve_elevation(distance, rise);
                        let expected = low_tangent(velocity, gravity, distance, rise);
                        let relative = (low.tan() - expected).abs() / expected.abs().max(1e-300);
                        assert!(
                            expected == 0.0 || relative < 1e-13,
                            "v {velocity} g {gravity} d {distance} rise {rise}: tan {} vs {expected}",
                            low.tan()
                        );
                        compared += 1;
                    }
                }
            }
        }
        assert!(compared > 400, "{compared} cases compared");
    }

    #[test]
    fn a_warm_start_finds_the_same_roots_as_a_cold_search() {
        for shot in [mortar(), rpg7(), tank_ap(), ub32()] {
            let flight = Flight::new(shot);
            let height = shot.pivot_height + 5.0;
            let mut guess = (f64::NAN, f64::NAN);
            let mut warm_roots = 0;
            for i in 0..60 {
                let distance = 100.0 + 9.0 * f64::from(i);
                let cold = flight.solve_elevation(distance, height);
                let warm = flight.solve_elevation_with(
                    distance,
                    height,
                    SolveHints {
                        guess_low: guess.0,
                        guess_high: guess.1,
                        peak: Some(flight.peak_angle(distance)),
                        ..SolveHints::default()
                    },
                );
                for (cold, warm) in [(cold.0, warm.0), (cold.1, warm.1)] {
                    assert!(
                        (cold.is_nan() && warm.is_nan()) || (cold - warm).abs() < 1e-9,
                        "cold {cold} warm {warm} at {distance} m"
                    );
                    warm_roots += usize::from(!warm.is_nan() && !guess.0.is_nan());
                }
                guess = cold;
            }
            assert!(warm_roots > 0, "a warm search ran");
        }
    }

    /// Every stepped-boost parameter of the cache key changes the table; the launch point does not.
    #[test]
    fn a_boost_table_is_shared_only_by_shots_with_the_same_boost() {
        // The cap binds along the axis, so the shot has a table with either rotation
        let base = Shot {
            rotation_follows_velocity: false,
            max_speed: 200.0,
            ..rpg7()
        };
        let table = Arc::clone(Flight::new(base).boost_table().unwrap());
        let same_boost = [
            Shot {
                pivot_height: 1.0,
                ..base
            },
            Shot {
                muzzle_forward: 1.0,
                ..base
            },
            Shot {
                muzzle_up: 0.2,
                ..base
            },
        ];
        for shot in same_boost {
            let flight = Flight::with_table(shot, Some(&table));
            assert!(Arc::ptr_eq(&table, flight.boost_table().unwrap()));
        }
        let other_boost = [
            (
                "velocity",
                Shot {
                    velocity: 120.0,
                    ..base
                },
            ),
            (
                "gravity",
                Shot {
                    gravity: 4.9,
                    ..base
                },
            ),
            (
                "acceleration",
                Shot {
                    acceleration: 140.0,
                    ..base
                },
            ),
            (
                "boost time",
                Shot {
                    boost_time: 0.7,
                    ..base
                },
            ),
            (
                "max speed",
                Shot {
                    max_speed: 210.0,
                    ..base
                },
            ),
            (
                "rotation",
                Shot {
                    rotation_follows_velocity: true,
                    ..base
                },
            ),
        ];
        for (name, shot) in other_boost {
            let flight = Flight::with_table(shot, Some(&table));
            let rebuilt = flight.boost_table().unwrap();
            assert!(
                !Arc::ptr_eq(&table, rebuilt),
                "{name}: the table was reused"
            );
            assert_eq!(rebuilt.key(), shot.boost_key(), "{name}");
            let fresh = Flight::new(shot).solve_elevation(300.0, 0.0);
            let solved = flight.solve_elevation(300.0, 0.0);
            assert_eq!(fresh.0.to_bits(), solved.0.to_bits(), "{name}");
            assert_eq!(fresh.1.to_bits(), solved.1.to_bits(), "{name}");
        }
    }

    /// The angles `find_root` asks `error` about, in order, and its answer. A search that does not stop panics
    /// instead of hanging.
    fn searched(
        error: impl Fn(f64) -> f64,
        top: f64,
        direction: f64,
        guess: f64,
    ) -> (Vec<f64>, f64) {
        let asked = std::cell::RefCell::new(Vec::new());
        let root = Flight::find_root(
            |angle| {
                let mut asked = asked.borrow_mut();
                assert!(asked.len() < 100, "the search does not stop");
                asked.push(angle);
                error(angle)
            },
            top,
            error(top),
            direction,
            guess,
        );
        (asked.into_inner(), root)
    }

    /// A warm search brackets the root from the guess, in steps of [`WARM_STEP`] that double: away from the
    /// top from a guess short of the root, back towards it from one beyond the root (the top bounds the
    /// bracket without being asked about).
    #[test]
    fn a_warm_search_grows_its_bracket_from_the_guess() {
        for direction in [1.0_f64, -1.0] {
            let top = 0.1 * direction;
            let root = 0.5 * direction;
            let error = |angle: f64| direction * (root.sin() - angle.sin());

            let guess = 0.3 * direction;
            let mut grown = vec![guess];
            let mut step = WARM_STEP;
            while error(*grown.last().unwrap()) >= 0.0 {
                grown.push(guess + direction * step);
                step *= 2.0;
            }
            let (asked, found) = searched(error, top, direction, guess);
            assert_eq!(
                asked[..grown.len()],
                grown[..],
                "short of the root, {direction}"
            );
            assert!((found - root).abs() < 1e-9);
            // then the Illinois steps inside the bracket
            assert_eq!(
                asked.len(),
                grown.len() + 4,
                "short of the root, {direction}"
            );

            // 0.7 and the limit itself, the farthest guess that is used
            for guess in [0.7 * direction, ELEVATION_LIMIT * direction] {
                let mut grown = vec![guess];
                let mut step = WARM_STEP;
                // Past the top the bracket ends at the top itself
                while error(*grown.last().unwrap()) < 0.0
                    && direction * (guess - direction * step - top) > 0.0
                {
                    grown.push(guess - direction * step);
                    step *= 2.0;
                }
                let (asked, found) = searched(error, top, direction, guess);
                assert_eq!(asked[..grown.len()], grown[..], "beyond the root, {guess}");
                assert!((found - root).abs() < 1e-9);
            }
        }
    }

    /// A guess beyond the root whose steps back reach the top exactly, or pass it, leaves the top as the end of the
    /// bracket, which is not asked about; a top on the other side of the zero is passed at its own angle.
    #[test]
    fn a_warm_bracket_stops_at_the_top() {
        for direction in [1.0_f64, -1.0] {
            let root = 5e-5 * direction;
            let error = |angle: f64| direction * (root.sin() - angle.sin());
            // The first step back lands on the top exactly (2e-4 - 2e-4), the second past it
            for (guess, evaluations) in [(WARM_STEP * direction, 2), (3e-4 * direction, 3)] {
                let (asked, found) = searched(error, 0.0, direction, guess);
                assert_eq!(asked[0], guess);
                assert!((found - root).abs() < 1e-9);
                assert_eq!(asked.len(), evaluations, "guess {guess}: {asked:?}");
            }

            let top = -0.1 * direction;
            let root = -0.05 * direction;
            let error = |angle: f64| direction * (root.sin() - angle.sin());
            let guess = 0.05 * direction;
            let mut grown = vec![guess];
            let mut step = WARM_STEP;
            while error(*grown.last().unwrap()) < 0.0 {
                grown.push(guess - direction * step);
                step *= 2.0;
            }
            let (asked, found) = searched(error, top, direction, guess);
            assert_eq!(asked[..grown.len()], grown[..], "{direction}");
            assert!((found - root).abs() < 1e-9);
        }
    }

    /// Without a usable guess (none, on the wrong side of the top or at it, past the limit) the bracket
    /// grows from the top in steps of [`BRACKET_STEP`].
    #[test]
    fn a_search_without_a_usable_guess_grows_its_bracket_from_the_top() {
        for direction in [1.0_f64, -1.0] {
            let top = 0.1 * direction;
            let root = 0.5 * direction;
            let error = |angle: f64| direction * (root.sin() - angle.sin());
            let mut grown = Vec::new();
            let mut step = BRACKET_STEP;
            while grown.last().is_none_or(|last| error(*last) >= 0.0) {
                grown.push(top + direction * step);
                step *= 2.0;
            }
            for guess in [f64::NAN, 0.05 * direction, top, 1.6 * direction] {
                let (asked, found) = searched(error, top, direction, guess);
                assert_eq!(
                    asked[..grown.len()],
                    grown[..],
                    "guess {guess}, {direction}"
                );
                assert!((found - root).abs() < 1e-9, "guess {guess}, {direction}");
            }
        }
    }

    /// An error of exactly 0 at an end of the bracket is a root that is not yet past: the bracket grows to the
    /// next step (a warm one from the guess, a cold one from the top), and a guess at the root is searched from.
    #[test]
    fn a_zero_error_ends_the_search_only_when_it_is_the_root() {
        for direction in [1.0_f64, -1.0] {
            let linear = |root: f64| move |angle: f64| direction * (root - angle);
            let guess = 0.3 * direction;

            // The guess is the root: the bracket grows once, to an angle past it
            let (asked, found) = searched(linear(guess), 0.0, direction, guess);
            assert_eq!(asked[..2], [guess, guess + direction * WARM_STEP]);
            assert_eq!(found, guess);

            // The first angle of the warm bracket is the root: the second is asked about
            let first = guess + direction * WARM_STEP;
            let (asked, found) = searched(linear(first), 0.0, direction, guess);
            assert_eq!(
                asked[..3],
                [guess, first, guess + direction * 2.0 * WARM_STEP]
            );
            assert_eq!(found, first);

            // The first angle of the bracket back from a guess beyond the root is the root: it ends the bracket
            let guess = 0.7 * direction;
            let first = guess - direction * WARM_STEP;
            let (asked, found) = searched(linear(first), 0.0, direction, guess);
            assert_eq!(asked, [guess, first, first]);
            assert_eq!(found, first);

            // The first angle of a cold bracket is the root
            let first = direction * BRACKET_STEP;
            let (asked, found) = searched(linear(first), 0.0, direction, f64::NAN);
            assert_eq!(asked[..2], [first, direction * 2.0 * BRACKET_STEP]);
            assert_eq!(found, first);
        }
    }

    /// Without a root before the elevation limit the bracket stops at the limit, from a guess or from the top, and
    /// the answer is NaN, also when the error is exactly 0 at the limit.
    #[test]
    fn a_search_without_a_root_stops_at_the_elevation_limit() {
        for direction in [1.0_f64, -1.0] {
            let limit = ELEVATION_LIMIT * direction;
            for guess in [0.3 * direction, f64::NAN] {
                let (asked, found) = searched(|_| 1.0, 0.0, direction, guess);
                assert!(found.is_nan(), "guess {guess}");
                assert_eq!(asked.last(), Some(&limit));
                let (asked, found) =
                    searched(|angle| direction * (limit - angle), 0.0, direction, guess);
                assert!(found.is_nan(), "guess {guess}");
                assert_eq!(asked.last(), Some(&limit));
            }
        }
    }

    #[test]
    fn an_arc_that_is_not_wanted_is_nan() {
        let flight = Flight::new(rpg7());
        let hints = SolveHints {
            wanted_low: false,
            ..SolveHints::default()
        };
        let (low, high) = flight.solve_elevation_with(400.0, 0.0, hints);
        assert!(low.is_nan() && !high.is_nan());
    }

    /// A deterministic sequence in [0, 1) (linear congruential), so that the tests need no random-number crate.
    fn sequence(seed: u64) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    #[test]
    fn range_max_is_the_maximum_of_every_range() {
        let mut next = sequence(1);
        for size in [1, 2, 3, 7, 8, 9, 64, 100] {
            let profile: Vec<f64> = (0..size).map(|_| next() * 100.0).collect();
            let table = RangeMax::new(&profile);
            for first in 0..size {
                for last in first..size {
                    let expected = profile[first..=last]
                        .iter()
                        .copied()
                        .fold(f64::MIN, f64::max);
                    assert_eq!(
                        table.max(first, last),
                        expected,
                        "{first}..={last} of {size}"
                    );
                }
            }
        }
    }

    #[test]
    fn above_with_a_range_max_is_the_sample_by_sample_check() {
        let step = 5.0;
        let mut next = sequence(7);
        let (mut clear, mut blocked) = (0, 0);
        // A mortar (closed-form path), a tank gun (capped coast), the RPG-7 (stepped boost) and the UB-32
        // (closed-form motor)
        for (shot, angle, noise) in [
            (mortar(), 1.2, 3.0),
            (tank_ap(), 0.05, 2.0),
            (rpg7(), 0.3, 2.0),
            (ub32(), 0.5, 5.0),
        ] {
            let flight = Flight::new(shot);
            for _ in 0..200 {
                let len = 40 + (next() * 200.0) as usize;
                // Terrain under, around or over the path, with bumps
                let lift = (next() - 0.7) * noise;
                let profile: Vec<f64> = (0..len)
                    .map(|i| flight.height_at(angle, i as f64 * step) - lift - next() * noise)
                    .collect();
                let table = RangeMax::new(&profile);
                let first = (next() * 10.0) as usize;
                let by_samples = flight.above(angle, &profile, first..=len - 1, step, 0.0, None);
                let by_stretches =
                    flight.above(angle, &profile, first..=len - 1, step, 0.0, Some(&table));
                assert_eq!(
                    by_stretches, by_samples,
                    "{shot:?} at {angle} rad, {len} samples"
                );
                if by_samples {
                    clear += 1;
                } else {
                    blocked += 1;
                }
            }
        }
        assert!(
            clear > 50 && blocked > 50,
            "{clear} clear, {blocked} blocked"
        );
    }

    /// A terrain sample just over the path blocks it wherever it is in the stepped boost, and the path itself,
    /// sample for sample, is clear: with and without a `RangeMax`, over the whole profile, the boost alone and
    /// the rest. Returns the samples of the boost at the elevations of `angles`, summed.
    fn every_sample_of_the_stepped_boost_blocks_the_path(
        shot: Shot,
        angles: &[f64],
        step: f64,
    ) -> usize {
        let mut boost_samples = 0;
        for &angle in angles {
            let flight = Flight::new(shot);
            let (start_x, _) = shot.launch_point(angle);
            let end_x = flight.table().stencil(angle).x(flight.table().steps);
            let in_boost = ((start_x + end_x) / step) as usize;
            boost_samples += in_boost;
            // The boost alone, ending at its last sample or at the first one past it, and from inside it on
            for samples in [
                0..=149,
                0..=in_boost / 2,
                0..=in_boost,
                0..=in_boost + 1,
                in_boost - 1..=149,
            ] {
                let on_path: Vec<f64> = (0..=*samples.end())
                    .map(|i| flight.height_at(angle, i as f64 * step))
                    .collect();
                for with_range_max in [false, true] {
                    let table = RangeMax::new(&on_path);
                    let range_max = with_range_max.then_some(&table);
                    assert!(
                        flight.above(angle, &on_path, samples.clone(), step, 0.0, range_max),
                        "{angle} rad, {samples:?}"
                    );
                    for blocked in samples.clone() {
                        let mut profile = on_path.clone();
                        profile[blocked] += 1e-6;
                        let table = RangeMax::new(&profile);
                        let range_max = with_range_max.then_some(&table);
                        assert!(
                            !flight.above(angle, &profile, samples.clone(), step, 0.0, range_max),
                            "{angle} rad, {samples:?}: sample {blocked}, {in_boost} in the boost"
                        );
                    }
                }
            }
        }
        boost_samples
    }

    #[test]
    fn a_sample_over_the_stepped_boost_blocks_the_path_with_a_range_max() {
        let boost_samples =
            every_sample_of_the_stepped_boost_blocks_the_path(rpg7(), &[0.3, -0.2, 1.3], 2.0);
        assert!(boost_samples > 100, "{boost_samples} samples in the boost");
    }

    /// A motor that brakes the shell until its horizontal speed changes sign (the steps then alternate around
    /// the stop) folds the path of the boost back on itself: it is not concave, and a stretch of it is not
    /// monotone between its two ends. The comparison of a stretch's ends with its highest terrain sample then
    /// decides wrongly, so only the one-by-one scan of the boost, up to its last step, gives the answer of the
    /// sample-by-sample check: without it the path itself is blocked, or a sample over it is clear, at some
    /// elevations and sample spacings of the grid.
    #[test]
    fn a_sample_over_a_braked_stepped_boost_blocks_the_path_with_a_range_max() {
        let braked = shot((100.0, 1.0, -400.0, 2.0, 0.0), true, (0.0, 1.0, 0.0));
        let angles: Vec<f64> = (-14..=14).map(|tenth| f64::from(tenth) * 0.1).collect();
        let mut boost_samples = 0;
        for step in [0.05, 0.1, 0.25, 0.5, 1.0] {
            boost_samples +=
                every_sample_of_the_stepped_boost_blocks_the_path(braked, &angles, step);
        }
        assert!(boost_samples > 1000, "{boost_samples} samples in the boost");
    }

    #[test]
    fn a_path_that_is_not_an_angle_is_never_above_the_terrain() {
        let flight = Flight::new(mortar());
        assert!(!flight.above(f64::NAN, &[0.0; 4], 0..=3, 1.0, 0.0, None));
        assert!(flight.above(1.0, &[0.0; 4], RangeInclusive::new(3, 2), 1.0, 0.0, None));
    }
}
