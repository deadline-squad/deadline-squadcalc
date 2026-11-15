//! The JSON interface of the engine: a request in, a response out.
//!
//! Request:
//! ```json
//! { "weapon_specs": { "v0": 110.0, "mass": 4.1, "drag_coef": 0.0 },
//!   "pos_gun": [X, Y], "pos_target": [X, Y, Z],
//!   "environment": { "z_scale": 100.0, "heightmap_ref": "map.png", "bvh_buffer_ref": "bvh.bin" } }
//! ```
//! Response:
//! ```json
//! { "firing_solution": { "azimuth_deg": .., "elevation_mrad": .. },
//!   "flight_data": { "time_sec": .., "max_ordinate_meters": .. },
//!   "occlusion_status": "clear",
//!   "collision_details": { "point": [x, y, z], "material": "unknown", "lethality": 1.0, "splash_footprint_radius": 0.0 } }
//! ```
//! `drag_coef` and `mass` are accepted and ignored: Squad projectiles fly without drag in vacuum
//! (`g = 9.80 * ProjectileGravityScale`). Optional extras: `weapon_specs.model` (a [`Weapon`] describing
//! boost, speed cap, muzzle offsets and elevation limits; its `velocity` is replaced by `v0`) and a top-level
//! `options` object ([`Options`]). World frame and the meaning of the refs: see `README.md`.

use crate::bvh::BvhSet;
use crate::heightmap::Heightmap;
use crate::materials;
use crate::path::{trajectory_segments, Segment};
use crate::precision::{PrecisionRegion, RegionFile};
use crate::trace::{first_hit_along, Scene};
use crate::voxel::VoxelColumns;
use crate::weapon::{deg_to_rad, rad_to_deg, Weapon};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Horizontal distance at each end of the flight that is not checked against the terrain, metres (SquadCalc's
/// `MUZZLE_CLEARANCE` and `TARGET_CLEARANCE`).
pub const TERRAIN_CLEARANCE: f64 = 3.0;

/// The weapon of a request.
#[derive(Debug, Clone, Deserialize)]
pub struct WeaponSpecs {
    /// Muzzle velocity, m/s.
    pub v0: f64,
    /// Projectile mass, kg. Accepted for compatibility, not used by the model.
    #[serde(default)]
    pub mass: Option<f64>,
    /// Drag coefficient. Accepted and ignored: Squad has no drag.
    #[serde(default)]
    pub drag_coef: Option<f64>,
    /// Boost, cap, muzzle and elevation limits; `velocity` is overridden by `v0`.
    #[serde(default)]
    pub model: Option<Weapon>,
}

/// Where the terrain and the obstacles come from.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Environment {
    /// Half of the heightmap's height range, metres: `Z = (v / 65535 * 2 - 1) * z_scale`.
    #[serde(default)]
    pub z_scale: f64,
    /// Name of a heightmap in [`Resources`] (a file path for the CLI); none: flat ground at Z = 0.
    #[serde(default)]
    pub heightmap_ref: Option<String>,
    /// Metres between two heightmap samples when the CLI loads `heightmap_ref` (default 1).
    #[serde(default)]
    pub heightmap_resolution_m: Option<f64>,
    /// Name of a BVH in [`Resources`] (a `bvh.bin` path for the CLI); none: the line of fire is not checked.
    #[serde(default)]
    pub bvh_buffer_ref: Option<String>,
    /// Name of voxel columns in [`Resources`] (a `.vcol` path for the CLI); none: no voxel layer. Positions are
    /// then in the frame of the file, see [`crate::voxel`].
    #[serde(default)]
    pub vcol_ref: Option<String>,
    /// Name of a precision region in [`Resources`] (an `RTRI1` file path for the CLI); needs `vcol_ref`. Inside the
    /// region's square a path that comes near a voxel is tested against the region's exact triangles instead of
    /// being blocked by the voxel, see [`crate::precision`].
    #[serde(default)]
    pub region_ref: Option<String>,
}

/// Which arc to fire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Arc {
    /// The low arc if the weapon can fire it, else the high one.
    #[default]
    Auto,
    /// The low arc only.
    Low,
    /// The high arc only.
    High,
}

/// Optional settings of a request.
#[derive(Debug, Clone, Deserialize)]
pub struct Options {
    /// Arc to fire (default [`Arc::Auto`]).
    #[serde(default)]
    pub arc: Arc,
    /// Largest distance between the true path and its segments, metres (default 0.05).
    #[serde(default = "default_tolerance")]
    pub tolerance_m: f64,
}

fn default_tolerance() -> f64 {
    0.05
}

impl Default for Options {
    fn default() -> Self {
        Options {
            arc: Arc::Auto,
            tolerance_m: default_tolerance(),
        }
    }
}

/// A request.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// The weapon.
    pub weapon_specs: WeaponSpecs,
    /// Gun position `[X, Y]`, metres; its Z is the ground under it.
    pub pos_gun: [f64; 2],
    /// Target position `[X, Y, Z]`, metres.
    pub pos_target: [f64; 3],
    /// Terrain and obstacles.
    #[serde(default)]
    pub environment: Environment,
    /// Optional settings.
    #[serde(default)]
    pub options: Options,
}

/// Azimuth and elevation to lay the weapon at.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FiringSolution {
    /// Bearing clockwise from north, degrees in `[0, 360)`.
    pub azimuth_deg: f64,
    /// Elevation of the sight in milliradians; `null` if the target cannot be reached.
    pub elevation_mrad: Option<f64>,
}

/// The flight to the target.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlightData {
    /// Time of flight, seconds; `null` without a solution.
    pub time_sec: Option<f64>,
    /// Highest point of the flight above the gun's ground, metres; `null` without a solution.
    pub max_ordinate_meters: Option<f64>,
}

/// Where the projectile lands.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CollisionDetails {
    /// Impact point `[x, y, z]`: the first obstacle on the path, or the target if the line of fire is clear;
    /// `null` without a solution.
    pub point: Option<[f64; 3]>,
    /// Material of the surface (stub: `"unknown"`, see [`materials`]).
    pub material: String,
    /// Fraction of the damage the surface lets through (stub: 1.0).
    pub lethality: f64,
    /// Radius of the splash footprint on the surface, metres (stub: 0.0).
    pub splash_footprint_radius: f64,
}

/// A response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Response {
    /// Azimuth and elevation.
    pub firing_solution: FiringSolution,
    /// Time of flight and apex.
    pub flight_data: FlightData,
    /// `"clear"`, `"occluded"` (the path meets the BVH, a voxel or the terrain before the target), `"unchecked"`
    /// (no heightmap, BVH or voxel columns given) or `"no_solution"`.
    pub occlusion_status: String,
    /// Impact and its surface.
    pub collision_details: CollisionDetails,
}

/// Why a request cannot be answered.
#[derive(Debug)]
pub enum EngineError {
    /// The JSON is not a valid request.
    Json(serde_json::Error),
    /// The request names a heightmap that was not loaded.
    UnknownHeightmap(String),
    /// The request names a BVH that was not loaded.
    UnknownBvh(String),
    /// The request names voxel columns that were not loaded.
    UnknownVcol(String),
    /// The request names a precision region that was not loaded.
    UnknownRegion(String),
    /// A value is not usable (message).
    Invalid(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Json(e) => write!(f, "invalid request: {e}"),
            EngineError::UnknownHeightmap(r) => write!(f, "heightmap_ref {r:?} was not loaded"),
            EngineError::UnknownBvh(r) => write!(f, "bvh_buffer_ref {r:?} was not loaded"),
            EngineError::UnknownVcol(r) => write!(f, "vcol_ref {r:?} was not loaded"),
            EngineError::UnknownRegion(r) => write!(f, "region_ref {r:?} was not loaded"),
            EngineError::Invalid(m) => write!(f, "invalid request: {m}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// The heightmaps and BVHs a request can refer to by name.
#[derive(Debug, Default)]
pub struct Resources {
    heightmaps: HashMap<String, Heightmap>,
    bvhs: HashMap<String, BvhSet>,
    vcols: HashMap<String, VoxelColumns>,
    regions: HashMap<String, PrecisionRegion>,
}

impl Resources {
    /// No resources.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a heightmap under `reference`.
    pub fn add_heightmap(&mut self, reference: &str, heightmap: Heightmap) {
        self.heightmaps.insert(reference.to_string(), heightmap);
    }

    /// Registers a BVH under `reference`.
    pub fn add_bvh(&mut self, reference: &str, bvh: BvhSet) {
        self.bvhs.insert(reference.to_string(), bvh);
    }

    /// Registers voxel columns under `reference`.
    pub fn add_vcol(&mut self, reference: &str, columns: VoxelColumns) {
        self.vcols.insert(reference.to_string(), columns);
    }

    /// Registers a precision region under `reference`, built against the voxel columns registered as
    /// `vcol_reference` (the ones requests must then name with `vcol_ref`).
    ///
    /// # Errors
    /// [`EngineError::UnknownVcol`] if `vcol_reference` is not registered, [`EngineError::Invalid`] if the
    /// triangles cannot form a hierarchy.
    pub fn add_region(
        &mut self,
        reference: &str,
        vcol_reference: &str,
        file: RegionFile,
    ) -> Result<(), EngineError> {
        let columns = self
            .vcols
            .get(vcol_reference)
            .ok_or_else(|| EngineError::UnknownVcol(vcol_reference.to_string()))?;
        let region = PrecisionRegion::from_file(columns, file)
            .map_err(|e| EngineError::Invalid(format!("region {reference}: {e}")))?;
        self.regions.insert(reference.to_string(), region);
        Ok(())
    }

    /// Loads the files a request names: `heightmap_ref` is a `.png` (16-bit grayscale) or a raw `.g16` path,
    /// `bvh_buffer_ref` a `bvh.bin` path or a directory whose `*.bin` files are the parts of a [`BvhSet`],
    /// `vcol_ref` a `VCOL1` file (gzip or decompressed), `region_ref` an `RTRI1` file (loaded after the voxel columns).
    /// Refs already registered are kept.
    ///
    /// # Errors
    /// [`EngineError::Invalid`] naming the file that cannot be read or parsed.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn load_files(&mut self, request: &Request) -> Result<(), EngineError> {
        let environment = &request.environment;
        let fail = |what: &str, path: &str, e: &dyn fmt::Display| {
            EngineError::Invalid(format!("{what} {path}: {e}"))
        };
        if let Some(path) = environment
            .heightmap_ref
            .as_deref()
            .filter(|p| !self.has_heightmap(p))
        {
            let bytes = std::fs::read(path).map_err(|e| fail("heightmap", path, &e))?;
            let resolution = environment.heightmap_resolution_m.unwrap_or(1.0);
            let map = if path.ends_with(".png") {
                Heightmap::from_png(&bytes, environment.z_scale, resolution)
            } else {
                Heightmap::from_g16(&bytes, environment.z_scale, resolution)
            };
            self.add_heightmap(path, map.map_err(|e| fail("heightmap", path, &e))?);
        }
        if let Some(path) = environment
            .bvh_buffer_ref
            .as_deref()
            .filter(|p| !self.has_bvh(p))
        {
            let mut files = if std::path::Path::new(path).is_dir() {
                let mut found: Vec<_> = std::fs::read_dir(path)
                    .map_err(|e| fail("bvh", path, &e))?
                    .filter_map(|entry| entry.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|x| x == "bin"))
                    .collect();
                found.sort();
                found
            } else {
                vec![std::path::PathBuf::from(path)]
            };
            let mut parts = Vec::new();
            for file in files.drain(..) {
                let bytes = std::fs::read(&file).map_err(|e| fail("bvh", path, &e))?;
                parts.push(crate::bvh::Bvh::from_bytes(&bytes).map_err(|e| fail("bvh", path, &e))?);
            }
            self.add_bvh(path, BvhSet { parts });
        }
        if let Some(path) = environment
            .vcol_ref
            .as_deref()
            .filter(|p| !self.has_vcol(p))
        {
            let bytes = std::fs::read(path).map_err(|e| fail("vcol", path, &e))?;
            let columns = VoxelColumns::from_bytes(&bytes).map_err(|e| fail("vcol", path, &e))?;
            self.add_vcol(path, columns);
        }
        if let Some(path) = environment
            .region_ref
            .as_deref()
            .filter(|p| !self.has_region(p))
        {
            let vcol = environment
                .vcol_ref
                .as_deref()
                .ok_or_else(|| EngineError::Invalid("region_ref needs vcol_ref".to_string()))?;
            let bytes = std::fs::read(path).map_err(|e| fail("region", path, &e))?;
            let file = RegionFile::from_bytes(&bytes).map_err(|e| fail("region", path, &e))?;
            self.add_region(path, vcol, file)?;
        }
        Ok(())
    }

    /// Whether a heightmap is registered under `reference`.
    pub fn has_heightmap(&self, reference: &str) -> bool {
        self.heightmaps.contains_key(reference)
    }

    /// Whether a BVH is registered under `reference`.
    pub fn has_bvh(&self, reference: &str) -> bool {
        self.bvhs.contains_key(reference)
    }

    /// The voxel columns registered under `reference`.
    pub fn vcol(&self, reference: &str) -> Option<&VoxelColumns> {
        self.vcols.get(reference)
    }

    /// Whether voxel columns are registered under `reference`.
    pub fn has_vcol(&self, reference: &str) -> bool {
        self.vcols.contains_key(reference)
    }

    /// The precision region registered under `reference`.
    pub fn region(&self, reference: &str) -> Option<&PrecisionRegion> {
        self.regions.get(reference)
    }

    /// Whether a precision region is registered under `reference`.
    pub fn has_region(&self, reference: &str) -> bool {
        self.regions.contains_key(reference)
    }
}

/// Parses a JSON request and answers it as JSON.
///
/// # Errors
/// [`EngineError`] for malformed JSON, unusable values or refs that are not in `resources`.
pub fn run_json(input: &str, resources: &Resources) -> Result<String, EngineError> {
    let request: Request = serde_json::from_str(input).map_err(EngineError::Json)?;
    let response = run(&request, resources)?;
    serde_json::to_string(&response).map_err(EngineError::Json)
}

/// Answers a request.
///
/// # Errors
/// [`EngineError::UnknownHeightmap`] / [`EngineError::UnknownBvh`] / [`EngineError::UnknownVcol`] / [`EngineError::UnknownRegion`] for refs that are not in `resources`,
/// [`EngineError::Invalid`] for a non-finite position or velocity.
pub fn run(request: &Request, resources: &Resources) -> Result<Response, EngineError> {
    let finite = request
        .pos_gun
        .iter()
        .chain(&request.pos_target)
        .all(|c| c.is_finite());
    if !finite || !request.weapon_specs.v0.is_finite() || request.weapon_specs.v0 <= 0.0 {
        return Err(EngineError::Invalid(
            "positions and v0 must be finite, v0 positive".into(),
        ));
    }
    let environment = &request.environment;
    let heightmap = match &environment.heightmap_ref {
        Some(r) => Some(
            resources
                .heightmaps
                .get(r)
                .ok_or_else(|| EngineError::UnknownHeightmap(r.clone()))?,
        ),
        None => None,
    };
    let bvh = match &environment.bvh_buffer_ref {
        Some(r) => Some(
            resources
                .bvhs
                .get(r)
                .ok_or_else(|| EngineError::UnknownBvh(r.clone()))?,
        ),
        None => None,
    };
    let voxels = match &environment.vcol_ref {
        Some(r) => Some(
            resources
                .vcols
                .get(r)
                .ok_or_else(|| EngineError::UnknownVcol(r.clone()))?,
        ),
        None => None,
    };
    let region = match &environment.region_ref {
        Some(r) => {
            if voxels.is_none() {
                return Err(EngineError::Invalid("region_ref needs vcol_ref".into()));
            }
            Some(
                resources
                    .regions
                    .get(r)
                    .ok_or_else(|| EngineError::UnknownRegion(r.clone()))?,
            )
        }
        None => None,
    };

    let mut weapon = request
        .weapon_specs
        .model
        .clone()
        .unwrap_or_else(|| Weapon::parabola(request.weapon_specs.v0));
    weapon.velocity = request.weapon_specs.v0;

    let ground =
        |x: f64, y: f64| heightmap.map_or(0.0, |h| h.height_at_scaled(x, y, environment.z_scale));
    let [gx, gy] = request.pos_gun;
    let [tx, ty, tz] = request.pos_target;
    let gz = ground(gx, gy);
    let (east, north) = (tx - gx, ty - gy);
    let distance = east.hypot(north);
    // A tiny negative angle gains the whole turn to exactly 360 in double precision: that is north, 0
    let azimuth_deg = match east.atan2(north).to_degrees().rem_euclid(360.0) {
        turn if turn >= 360.0 => 0.0,
        azimuth => azimuth,
    };

    let solution = weapon.solve(distance, tz - gz);
    let chosen = match request.options.arc {
        crate::io::Arc::Low => solution.low,
        crate::io::Arc::High => solution.high,
        crate::io::Arc::Auto => {
            if solution.low.elevation_rad.is_nan() {
                solution.high
            } else {
                solution.low
            }
        }
    };

    let firing_solution = |elevation: Option<f64>| FiringSolution {
        azimuth_deg,
        elevation_mrad: elevation.map(|e| e * 1000.0),
    };
    if chosen.elevation_rad.is_nan() {
        let surface = materials::lookup(None);
        return Ok(Response {
            firing_solution: firing_solution(None),
            flight_data: FlightData {
                time_sec: None,
                max_ordinate_meters: None,
            },
            occlusion_status: "no_solution".to_string(),
            collision_details: CollisionDetails {
                point: None,
                material: surface.material,
                lethality: surface.lethality,
                splash_footprint_radius: surface.splash_footprint_radius,
            },
        });
    }

    let flight = weapon.flight(weapon.shot());
    // The sight angle has the weapon's angle offset taken off; the barrel is at sight + offset
    let barrel = chosen.elevation_rad + deg_to_rad(weapon.angle_offset_deg);
    let (_, apex_height) = flight.apex(barrel, distance);
    let segments = trajectory_segments(
        &flight,
        barrel,
        distance,
        [gx, gy, gz],
        azimuth_deg.to_radians(),
        request.options.tolerance_m,
    );

    let target = [tx, ty, tz];
    let mut impact = target;
    let mut hit_triangle = None;
    let mut occluded = false;
    let mut impact_time = f64::INFINITY;
    if let Some(set) = bvh {
        if let Some(hit) = first_hit_along(set as &dyn Scene, &segments) {
            occluded = true;
            impact = hit.point;
            impact_time = hit.time;
            hit_triangle = Some((hit.hit.part, hit.hit.triangle));
        }
    }
    let layer_hit = match (voxels, region) {
        (Some(columns), Some(region)) => region
            .first_block_along(columns, &segments)
            .map(|hit| (hit.point, hit.time)),
        (Some(columns), None) => columns
            .first_block_along(&segments)
            .map(|hit| (hit.point, hit.time)),
        (None, _) => None,
    };
    if let Some((point, time)) = layer_hit {
        if time < impact_time {
            occluded = true;
            impact = point;
            impact_time = time;
            hit_triangle = None;
        }
    }
    if let Some(map) = heightmap {
        if let Some((point, time)) =
            first_terrain_hit(map, environment.z_scale, &segments, distance)
        {
            if time < impact_time {
                occluded = true;
                impact = point;
                hit_triangle = None;
            }
        }
    }

    let surface = materials::lookup(hit_triangle);
    let status = if occluded {
        "occluded"
    } else if bvh.is_some() || heightmap.is_some() || voxels.is_some() {
        "clear"
    } else {
        "unchecked"
    };
    Ok(Response {
        firing_solution: firing_solution(Some(chosen.elevation_rad)),
        flight_data: FlightData {
            time_sec: Some(chosen.time_of_flight),
            max_ordinate_meters: Some(apex_height),
        },
        occlusion_status: status.to_string(),
        collision_details: CollisionDetails {
            point: Some(impact),
            material: surface.material,
            lethality: surface.lethality,
            splash_footprint_radius: surface.splash_footprint_radius,
        },
    })
}

/// First point of the path under the terrain, sampled every heightmap resolution along each segment, leaving
/// out [`TERRAIN_CLEARANCE`] metres of horizontal distance at both ends. Returns the point and the time.
fn first_terrain_hit(
    map: &Heightmap,
    z_scale: f64,
    segments: &[Segment],
    distance: f64,
) -> Option<([f64; 3], f64)> {
    let origin = segments.first()?.p0;
    for segment in segments {
        let length = (segment.p1[0] - segment.p0[0])
            .hypot(segment.p1[1] - segment.p0[1])
            .max(1e-9);
        let steps = (length / map.resolution).ceil().max(1.0) as usize;
        for k in 0..=steps {
            let f = k as f64 / steps as f64;
            let p = [
                segment.p0[0] + f * (segment.p1[0] - segment.p0[0]),
                segment.p0[1] + f * (segment.p1[1] - segment.p0[1]),
                segment.p0[2] + f * (segment.p1[2] - segment.p0[2]),
            ];
            let along = (p[0] - origin[0]).hypot(p[1] - origin[1]);
            if along < TERRAIN_CLEARANCE || along > distance - TERRAIN_CLEARANCE {
                continue;
            }
            if p[2] < map.height_at_scaled(p[0], p[1], z_scale) {
                return Some((p, segment.t0 + f * (segment.t1 - segment.t0)));
            }
        }
    }
    None
}

/// Elevation in degrees of a response's `elevation_mrad`.
pub fn mrad_to_deg(mrad: f64) -> f64 {
    rad_to_deg(mrad / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bvh::{BuildOptions, Triangle};

    fn request(extra: &str) -> String {
        format!(
            r#"{{"weapon_specs":{{"v0":110.0,"mass":4.1,"drag_coef":0.47}},
                "pos_gun":[0.0,0.0],"pos_target":[0.0,600.0,0.0]{extra}}}"#
        )
    }

    fn run_text(input: &str, resources: &Resources) -> serde_json::Value {
        serde_json::from_str(&run_json(input, resources).unwrap()).unwrap()
    }

    #[test]
    fn answers_a_plain_request_and_ignores_drag() {
        let a = run_text(&request(""), &Resources::new());
        let without_drag = request("").replace(r#","drag_coef":0.47"#, "");
        let b = run_text(&without_drag, &Resources::new());
        assert_eq!(a, b);
        // v = 110, d = 600: low arc atan((v^2 - sqrt(v^4 - g^2 d^2)) / (g d))
        let g = 9.8f64;
        let expected = (((110.0f64.powi(2) - (110.0f64.powi(4) - (g * 600.0).powi(2)).sqrt())
            / (g * 600.0))
            .atan())
            * 1000.0;
        assert!((a["firing_solution"]["elevation_mrad"].as_f64().unwrap() - expected).abs() < 1e-9);
        assert_eq!(a["firing_solution"]["azimuth_deg"], 0.0);
        assert_eq!(a["occlusion_status"], "unchecked");
        assert_eq!(a["collision_details"]["material"], "unknown");
        assert_eq!(a["collision_details"]["lethality"], 1.0);
        assert_eq!(
            a["collision_details"]["point"],
            serde_json::json!([0.0, 600.0, 0.0])
        );
    }

    #[test]
    fn the_high_arc_flies_longer_and_higher() {
        let low = run_text(&request(""), &Resources::new());
        let high = run_text(&request(r#","options":{"arc":"high"}"#), &Resources::new());
        assert!(high["flight_data"]["time_sec"].as_f64() > low["flight_data"]["time_sec"].as_f64());
        assert!(
            high["flight_data"]["max_ordinate_meters"].as_f64()
                > low["flight_data"]["max_ordinate_meters"].as_f64()
        );
        // The apex of a parabola: (v sin e)^2 / 2g
        let e = high["firing_solution"]["elevation_mrad"].as_f64().unwrap() / 1000.0;
        let apex = (110.0 * e.sin()).powi(2) / (2.0 * 9.8);
        assert!((high["flight_data"]["max_ordinate_meters"].as_f64().unwrap() - apex).abs() < 1e-9);
    }

    #[test]
    fn a_target_out_of_range_has_no_solution() {
        let far = request("").replace("600.0,0.0]", "5000.0,0.0]");
        let r = run_text(&far, &Resources::new());
        assert_eq!(r["occlusion_status"], "no_solution");
        assert!(r["firing_solution"]["elevation_mrad"].is_null());
        assert!(r["collision_details"]["point"].is_null());
    }

    #[test]
    fn a_hair_west_of_north_is_azimuth_0_not_360() {
        let hair_west = request("").replace("[0.0,600.0,0.0]", "[-1e-15,600.0,0.0]");
        let azimuth = run_text(&hair_west, &Resources::new())["firing_solution"]["azimuth_deg"]
            .as_f64()
            .unwrap();
        assert_eq!(azimuth, 0.0);
    }

    #[test]
    fn azimuth_is_clockwise_from_north() {
        let east = request("").replace("[0.0,600.0,0.0]", "[300.0,0.0,0.0]");
        assert!(
            (run_text(&east, &Resources::new())["firing_solution"]["azimuth_deg"]
                .as_f64()
                .unwrap()
                - 90.0)
                .abs()
                < 1e-12
        );
        let west = request("").replace("[0.0,600.0,0.0]", "[-300.0,0.0,0.0]");
        assert!(
            (run_text(&west, &Resources::new())["firing_solution"]["azimuth_deg"]
                .as_f64()
                .unwrap()
                - 270.0)
                .abs()
                < 1e-12
        );
    }

    #[test]
    fn a_wall_on_the_path_occludes_and_is_the_impact() {
        // A wall across the line of fire at Y = 300, from the ground to 400 m
        let wall: Vec<Triangle> = vec![
            [
                [-50.0, 300.0, -10.0],
                [50.0, 300.0, -10.0],
                [50.0, 300.0, 400.0],
            ],
            [
                [-50.0, 300.0, -10.0],
                [50.0, 300.0, 400.0],
                [-50.0, 300.0, 400.0],
            ],
        ];
        let mut resources = Resources::new();
        resources.add_bvh(
            "wall",
            BvhSet::build(wall, 10, BuildOptions::default()).unwrap(),
        );
        let r = run_text(
            &request(r#","environment":{"bvh_buffer_ref":"wall"}"#),
            &resources,
        );
        assert_eq!(r["occlusion_status"], "occluded");
        let point = r["collision_details"]["point"].as_array().unwrap();
        assert!((point[1].as_f64().unwrap() - 300.0).abs() < 1e-9);

        let r = run_text(
            &request(r#","environment":{"bvh_buffer_ref":"wall"},"options":{"arc":"low"}"#),
            &resources,
        );
        assert_eq!(r["occlusion_status"], "occluded");
    }

    #[test]
    fn a_clear_line_of_fire_is_clear() {
        let far_wall: Vec<Triangle> = vec![[
            [500.0, 100.0, 0.0],
            [600.0, 100.0, 0.0],
            [550.0, 100.0, 50.0],
        ]];
        let mut resources = Resources::new();
        resources.add_bvh(
            "far",
            BvhSet::build(far_wall, 10, BuildOptions::default()).unwrap(),
        );
        let r = run_text(
            &request(r#","environment":{"bvh_buffer_ref":"far"}"#),
            &resources,
        );
        assert_eq!(r["occlusion_status"], "clear");
    }

    #[test]
    fn a_ridge_in_the_heightmap_occludes() {
        // 2 samples wide strip of 1 m cells, 700 rows, ridge of full scale between rows 250 and 350
        let rows = 700usize;
        let mut levels = vec![32768u16; rows * 3];
        for row in 250..350 {
            for col in 0..3 {
                levels[row * 3 + col] = 65535;
            }
        }
        let mut map = Heightmap::new(3, rows, levels, 1.0, 1.0).unwrap();
        map.origin_x = -1.0;
        let mut resources = Resources::new();
        resources.add_heightmap("ridge", map);
        // Rows run south from Y = 0, so the target is at Y = -600
        let south = request(
            r#","environment":{"z_scale":300.0,"heightmap_ref":"ridge"},"options":{"arc":"low"}"#,
        )
        .replace("[0.0,600.0,0.0]", "[0.0,-600.0,0.0]");
        let low = run_text(&south, &resources);
        assert_eq!(low["occlusion_status"], "occluded");
        let y = low["collision_details"]["point"][1].as_f64().unwrap();
        assert!((-350.0..-249.0).contains(&y), "impact at Y = {y}");
    }

    /// A wall of voxels across the line of fire (Y = 300, X in -50..50, Z in 0..400), grid in the request's frame.
    fn voxel_wall(y_cell: u32) -> VoxelColumns {
        let voxels: Vec<(u32, u32, u32)> = (0..200)
            .flat_map(|column| (0..400).map(move |z| (column, y_cell, z)))
            .collect();
        VoxelColumns::from_voxels([-50.0, 0.0, 0.0], 0.5, 1.0, 200, 1400, &voxels).unwrap()
    }

    #[test]
    fn a_voxel_wall_on_the_path_occludes_and_is_the_impact() {
        let mut resources = Resources::new();
        resources.add_vcol("wall", voxel_wall(600));
        let r = run_text(
            &request(r#","environment":{"vcol_ref":"wall"},"options":{"arc":"low"}"#),
            &resources,
        );
        assert_eq!(r["occlusion_status"], "occluded");
        let point = r["collision_details"]["point"].as_array().unwrap();
        assert!((point[1].as_f64().unwrap() - 300.0).abs() < 1e-9);
    }

    #[test]
    fn a_voxel_wall_beyond_the_target_leaves_the_line_clear() {
        let mut resources = Resources::new();
        resources.add_vcol("far", voxel_wall(1250));
        let r = run_text(&request(r#","environment":{"vcol_ref":"far"}"#), &resources);
        assert_eq!(r["occlusion_status"], "clear");
    }

    #[test]
    fn the_nearer_of_a_voxel_and_a_triangle_is_the_impact() {
        let near_wall: Vec<Triangle> = vec![[
            [-50.0, 100.0, -10.0],
            [50.0, 100.0, -10.0],
            [0.0, 100.0, 400.0],
        ]];
        let mut resources = Resources::new();
        resources.add_bvh(
            "near",
            BvhSet::build(near_wall, 10, BuildOptions::default()).unwrap(),
        );
        resources.add_vcol("wall", voxel_wall(600));
        let r = run_text(
            &request(
                r#","environment":{"bvh_buffer_ref":"near","vcol_ref":"wall"},"options":{"arc":"low"}"#,
            ),
            &resources,
        );
        assert!((r["collision_details"]["point"][1].as_f64().unwrap() - 100.0).abs() < 1e-9);
    }

    /// A marked voxel row at Y = 300..300.5 across the line of fire and, 0.4 m before it, no triangle: the voxels
    /// block the path, the exact triangles of the region (none) let it through.
    #[test]
    fn a_region_overrules_a_voxel_the_triangles_do_not_touch() {
        let mut resources = Resources::new();
        resources.add_vcol("wall", voxel_wall(600));
        let file = RegionFile {
            bounds: [-20.0, 250.0, 20.0, 350.0],
            margin: 0.6,
            triangles: vec![[
                [100.0, 100.0, 0.0],
                [101.0, 100.0, 0.0],
                [100.0, 101.0, 0.0],
            ]],
        };
        resources.add_region("near-target", "wall", file).unwrap();
        let plain = r#","environment":{"vcol_ref":"wall"},"options":{"arc":"low"}"#;
        let precise = r#","environment":{"vcol_ref":"wall","region_ref":"near-target"},"options":{"arc":"low"}"#;
        assert_eq!(
            run_text(&request(plain), &resources)["occlusion_status"],
            "occluded"
        );
        assert_eq!(
            run_text(&request(precise), &resources)["occlusion_status"],
            "clear"
        );
    }

    #[test]
    fn a_region_triangle_is_the_impact_instead_of_the_voxel_behind_it() {
        let mut resources = Resources::new();
        resources.add_vcol("wall", voxel_wall(600));
        let file = RegionFile {
            bounds: [-20.0, 250.0, 20.0, 350.0],
            margin: 0.6,
            triangles: vec![[
                [-10.0, 299.8, -10.0],
                [10.0, 299.8, -10.0],
                [0.0, 299.8, 400.0],
            ]],
        };
        resources.add_region("near-target", "wall", file).unwrap();
        let r = run_text(
            &request(
                r#","environment":{"vcol_ref":"wall","region_ref":"near-target"},"options":{"arc":"low"}"#,
            ),
            &resources,
        );
        assert_eq!(r["occlusion_status"], "occluded");
        let y = r["collision_details"]["point"][1].as_f64().unwrap();
        assert!((y - 299.8).abs() < 1e-4, "impact at Y = {y}");
    }

    #[test]
    fn a_region_needs_voxel_columns_and_must_be_loaded() {
        let mut resources = Resources::new();
        resources.add_vcol("wall", voxel_wall(600));
        let file = RegionFile {
            bounds: [0.0, 0.0, 1.0, 1.0],
            margin: 0.6,
            triangles: Vec::new(),
        };
        assert!(matches!(
            resources.add_region("r", "missing", file.clone()),
            Err(EngineError::UnknownVcol(_))
        ));
        resources.add_region("r", "wall", file).unwrap();
        assert!(matches!(
            run_json(&request(r#","environment":{"region_ref":"r"}"#), &resources),
            Err(EngineError::Invalid(_))
        ));
        assert!(matches!(
            run_json(
                &request(r#","environment":{"vcol_ref":"wall","region_ref":"nope"}"#),
                &resources
            ),
            Err(EngineError::UnknownRegion(_))
        ));
    }

    #[test]
    fn unknown_refs_and_bad_json_are_errors() {
        assert!(matches!(
            run_json(
                &request(r#","environment":{"vcol_ref":"nope"}"#),
                &Resources::new()
            ),
            Err(EngineError::UnknownVcol(_))
        ));
        let r = run_json(
            &request(r#","environment":{"bvh_buffer_ref":"nope"}"#),
            &Resources::new(),
        );
        assert!(matches!(r, Err(EngineError::UnknownBvh(_))));
        assert!(matches!(
            run_json("{", &Resources::new()),
            Err(EngineError::Json(_))
        ));
        assert!(matches!(
            run_json(
                r#"{"weapon_specs":{"v0":-1},"pos_gun":[0,0],"pos_target":[1,1,1]}"#,
                &Resources::new()
            ),
            Err(EngineError::Invalid(_))
        ));
    }
}
