//! A Squad weapon and the firing solution it gives for a target: a port of `Weapon` (`squadWeapons.js`) and
//! `SquadFiringSolution` (`squadFiringSolution.js`) of SquadCalc, without the UI and spread parts.

use crate::flight::{Flight, Shot};
use serde::{Deserialize, Serialize};

/// The game's `DefaultGravityZ` (-980 cm/s^2) in m/s^2, as in SquadCalc's `src/app.js`.
pub const WORLD_GRAVITY: f64 = 9.80;

/// Range reported for weapons without gravity (NLAW): they fly straight, beyond the largest map, metres.
pub const NO_GRAVITY_RANGE: f64 = 10_000.0;

/// Launch point that moves with the elevation, from the weapon's skeleton.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Muzzle {
    /// Barrel pivot above the weapon's ground, metres.
    pub pivot_height: f64,
    /// Muzzle along the barrel from the pivot, metres.
    pub forward: f64,
    /// Muzzle above the barrel axis, metres.
    pub up: f64,
}

fn one() -> f64 {
    1.0
}

fn default_lifespan() -> f64 {
    100.0
}

fn default_min_elevation() -> f64 {
    -90.0
}

fn default_max_elevation() -> f64 {
    90.0
}

fn forward() -> bool {
    true
}

/// How one shell of one weapon flies and where the weapon can be laid. Every field has a default, so
/// `{"velocity": 110}` is a plain parabola (gravity scale 1, no limits).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Weapon {
    /// Muzzle velocity `v0` of the shell, m/s.
    #[serde(default)]
    pub velocity: f64,
    /// `ProjectileGravityScale`: gravity is `9.80 * gravity_scale` (0: flies straight).
    #[serde(default = "one")]
    pub gravity_scale: f64,
    /// ConstantAcceleration of the rocket motor, m/s^2 (negative: slows down).
    #[serde(default)]
    pub acceleration: f64,
    /// ConstantAccelerationTimeout, seconds.
    #[serde(default)]
    pub acceleration_time: f64,
    /// MaxSpeed of the projectile, m/s; 0 means none.
    #[serde(default)]
    pub max_speed: f64,
    /// Whether the motor pushes along the path (default) or along the barrel's axis at launch.
    #[serde(default = "forward")]
    pub rotation_follows_velocity: bool,
    /// Height of the launch point above the weapon's ground when there is no `muzzle`, metres.
    #[serde(default)]
    pub height_offset: f64,
    /// Angle between the sight and the barrel, degrees; subtracted from the physical elevation.
    #[serde(default)]
    pub angle_offset_deg: f64,
    /// Lowest elevation the weapon can be laid at, degrees.
    #[serde(default = "default_min_elevation")]
    pub min_elevation_deg: f64,
    /// Highest elevation the weapon can be laid at, degrees.
    #[serde(default = "default_max_elevation")]
    pub max_elevation_deg: f64,
    /// Seconds after which the projectile dies in the air.
    #[serde(default = "default_lifespan")]
    pub projectile_lifespan: f64,
    /// Degrees per second of the mount of a weapon laid by holding a key (AGS-17); 0: not laid that way.
    #[serde(default)]
    pub elevation_rate: f64,
    /// `[lowest, top]` elevations reachable by holding the elevation key, degrees.
    #[serde(default)]
    pub hold_elevation: Option<[f64; 2]>,
    /// Launch point that moves with the elevation, if the weapon has a skeleton for it.
    #[serde(default)]
    pub muzzle: Option<Muzzle>,
}

impl Weapon {
    /// A plain parabola: gravity scale 1, no motor, no cap, no limits.
    pub fn parabola(velocity: f64) -> Self {
        Weapon {
            velocity,
            gravity_scale: 1.0,
            acceleration: 0.0,
            acceleration_time: 0.0,
            max_speed: 0.0,
            rotation_follows_velocity: true,
            height_offset: 0.0,
            angle_offset_deg: 0.0,
            min_elevation_deg: default_min_elevation(),
            max_elevation_deg: default_max_elevation(),
            projectile_lifespan: default_lifespan(),
            elevation_rate: 0.0,
            hold_elevation: None,
            muzzle: None,
        }
    }

    /// Gravity of the projectile, m/s^2.
    pub fn gravity(&self) -> f64 {
        WORLD_GRAVITY * self.gravity_scale
    }

    /// Whether the projectile is a rocket boosted by `acceleration` during `acceleration_time`.
    pub fn has_boost(&self) -> bool {
        self.acceleration_time > 0.0 && self.acceleration != 0.0
    }

    /// How the weapon fires, for [`Flight`]. `launch_height` is the launch height above the ground for
    /// weapons without `muzzle` (default `height_offset`).
    pub fn shot_with(&self, gravity: f64, launch_height: f64) -> Shot {
        let boosted = self.has_boost();
        Shot {
            velocity: self.velocity,
            gravity,
            acceleration: if boosted { self.acceleration } else { 0.0 },
            boost_time: if boosted { self.acceleration_time } else { 0.0 },
            max_speed: self.max_speed,
            rotation_follows_velocity: self.rotation_follows_velocity,
            pivot_height: self.muzzle.map_or(launch_height, |m| m.pivot_height),
            muzzle_forward: self.muzzle.map_or(0.0, |m| m.forward),
            muzzle_up: self.muzzle.map_or(0.0, |m| m.up),
        }
    }

    /// How the weapon fires at the world gravity times its gravity scale, from its own launch height.
    pub fn shot(&self) -> Shot {
        self.shot_with(self.gravity(), self.height_offset)
    }

    /// Equivalent constant velocity over `distance` for a boosted rocket flying straight along the barrel:
    /// it accelerates during `acceleration_time`, then keeps its speed, held at `max_speed`.
    fn boost_velocity(&self, distance: f64) -> f64 {
        if distance <= 0.0 {
            return self.velocity;
        }
        let a = self.acceleration;
        let boost_time = self.acceleration_time;
        let boost_distance = self.velocity * boost_time + 0.5 * a * boost_time.powi(2);
        let mut cruise = self.velocity + a * boost_time;
        if self.max_speed != 0.0 {
            cruise = cruise.min(self.max_speed);
        }
        let time = if distance <= boost_distance {
            2.0 * distance
                / (self.velocity + (self.velocity.powi(2) + 2.0 * a * distance).max(0.0).sqrt())
        } else {
            boost_time + (distance - boost_distance) / cruise
        };
        distance / time
    }

    /// Velocity over the distance to the target: the muzzle velocity, or for a boosted rocket the equivalent
    /// constant velocity.
    pub fn velocity_over(&self, distance: f64) -> f64 {
        if self.has_boost() {
            self.boost_velocity(distance)
        } else {
            self.velocity
        }
    }

    /// Time the elevation key must be held for an elevation, seconds; NaN for a weapon without
    /// `elevation_rate` or an angle outside `hold_elevation`.
    pub fn hold_time(&self, elevation_deg: f64) -> f64 {
        let Some([lowest, top]) = self.hold_elevation else {
            return f64::NAN;
        };
        if self.elevation_rate == 0.0 || !(elevation_deg >= lowest && elevation_deg <= top) {
            return f64::NAN;
        }
        (top - elevation_deg) / self.elevation_rate
    }

    /// Whether the weapon can be laid at this elevation.
    pub fn in_elevation_range(&self, elevation_rad: f64) -> bool {
        let degrees = rad_to_deg(elevation_rad);
        degrees >= self.min_elevation_deg && degrees <= self.max_elevation_deg
    }

    /// Farthest target on flat ground, metres (`Weapon.getMaxDistance`).
    pub fn max_distance(&self) -> f64 {
        let gravity = self.gravity();
        if gravity == 0.0 {
            return NO_GRAVITY_RANGE;
        }
        if self.muzzle.is_some() {
            return Flight::new(self.shot_with(gravity, self.height_offset)).max_range();
        }
        if self.has_boost() || (self.max_speed != 0.0 && self.velocity > self.max_speed) {
            return Flight::new(self.shot_with(gravity, 0.0)).max_range();
        }
        if self.elevation_rate != 0.0 {
            if let Some([lowest, _]) = self.hold_elevation {
                let angle = lowest.max(45.0) * std::f64::consts::PI / 180.0;
                return self.velocity.powi(2) * (2.0 * angle).sin() / gravity;
            }
        }
        self.velocity.powi(2) / gravity
    }

    /// The firing solution for a target `distance` metres away horizontally and `height_diff` metres above
    /// the weapon's ground (`SquadFiringSolution`).
    pub fn solve(&self, distance: f64, height_diff: f64) -> FiringSolution {
        let flight = Flight::new(self.shot());
        let angle_offset = deg_to_rad(self.angle_offset_deg);
        let straight = self.gravity() == 0.0;

        let roots = if straight {
            (f64::NAN, f64::NAN)
        } else {
            flight.solve_elevation(distance, height_diff)
        };
        let straight_elevation = if !(distance > 0.0) || !height_diff.is_finite() {
            f64::NAN
        } else {
            (height_diff - self.height_offset).atan2(distance) - angle_offset
        };
        let laid = |root: f64| {
            let elevation = if straight {
                straight_elevation
            } else {
                root - angle_offset
            };
            if self.in_elevation_range(elevation) {
                elevation
            } else {
                f64::NAN
            }
        };
        let low = self.arc(&flight, laid(roots.0), distance, straight);
        let mut high = self.arc(&flight, laid(roots.1), distance, straight);

        let hold_time = self.hold_time(high.elevation_deg);
        // Weapons laid by holding a key (AGS-17) only lob on the angles the key can reach
        if self.elevation_rate != 0.0 && hold_time.is_nan() {
            high.elevation_rad = f64::NAN;
            high.elevation_deg = f64::NAN;
        }

        let line_of_sight = (height_diff - self.height_offset).atan2(distance);
        FiringSolution {
            distance,
            height_diff,
            sight_angle_deg: rad_to_deg(low.elevation_rad - line_of_sight),
            low,
            high,
            hold_time,
        }
    }

    /// Elevation, time of flight and the lifespan check of one arc.
    fn arc(&self, flight: &Flight, elevation: f64, distance: f64, straight: bool) -> Arc {
        let time_of_flight = if straight {
            let path = distance / elevation.cos();
            path / self.velocity_over(path)
        } else {
            flight
                .path_at(elevation + deg_to_rad(self.angle_offset_deg), distance)
                .time
        };
        // A projectile that dies in the air before landing has no solution
        let reached = !(time_of_flight > self.projectile_lifespan);
        let elevation = if reached { elevation } else { f64::NAN };
        Arc {
            elevation_rad: elevation,
            elevation_deg: rad_to_deg(elevation),
            time_of_flight,
        }
    }
}

/// One of the two trajectories that reach a target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Arc {
    /// Elevation of the sight, radians; NaN if the arc is out of range or cannot be laid.
    pub elevation_rad: f64,
    /// Elevation of the sight, degrees; NaN as `elevation_rad`.
    pub elevation_deg: f64,
    /// Time of flight to the target, seconds; NaN for a NaN elevation.
    pub time_of_flight: f64,
}

/// The firing solution of a weapon for one target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FiringSolution {
    /// Horizontal distance to the target, metres.
    pub distance: f64,
    /// Height of the target above the weapon's ground, metres.
    pub height_diff: f64,
    /// The low arc.
    pub low: Arc,
    /// The high arc.
    pub high: Arc,
    /// Elevation of the low arc over the line of sight, degrees (the angle a direct-fire weapon is aimed with).
    pub sight_angle_deg: f64,
    /// Seconds the elevation key is held for the high arc (AGS-17); NaN for other weapons.
    pub hold_time: f64,
}

/// Radians to degrees.
pub fn rad_to_deg(rad: f64) -> f64 {
    (rad * 180.0) / std::f64::consts::PI
}

/// Degrees to radians.
pub fn deg_to_rad(deg: f64) -> f64 {
    (deg * std::f64::consts::PI) / 180.0
}
