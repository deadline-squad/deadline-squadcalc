//! WebAssembly exports (feature `wasm`), built with `wasm-bindgen`; `js/index.mjs` wraps them.

use crate::bvh::{triangles_from_le_bytes, BuildOptions, Bvh, BvhSet, MAX_TRIANGLES};
use crate::heightmap::{DetailLoad, Heightmap, Lattice};
use crate::io::{run_json, Resources};
use crate::precision::{HitKind, RegionFile};
use crate::trace::{segment_triangle_f32, Scene};
use crate::voxel::VoxelColumns;
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm-threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

/// Installs a panic hook that prints Rust panics to the browser console.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// An engine with its loaded heightmaps and BVHs.
#[wasm_bindgen]
pub struct Engine {
    resources: Resources,
    bvhs: std::collections::HashMap<String, BvhSet>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Engine {
    /// An engine without resources.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            resources: Resources::new(),
            bvhs: std::collections::HashMap::new(),
        }
    }

    /// Registers a raw `.g16` heightmap (`u32` width, `u32` height, `u16` samples, little endian) as `reference`.
    pub fn load_heightmap_g16(
        &mut self,
        reference: &str,
        bytes: &[u8],
        z_scale: f64,
        resolution_m: f64,
    ) -> Result<(), JsError> {
        let map = Heightmap::from_g16(bytes, z_scale, resolution_m).map_err(js_error)?;
        self.resources.add_heightmap(reference, map);
        Ok(())
    }

    /// Registers a 16-bit grayscale PNG heightmap as `reference`.
    pub fn load_heightmap_png(
        &mut self,
        reference: &str,
        bytes: &[u8],
        z_scale: f64,
        resolution_m: f64,
    ) -> Result<(), JsError> {
        let map = Heightmap::from_png(bytes, z_scale, resolution_m).map_err(js_error)?;
        self.resources.add_heightmap(reference, map);
        Ok(())
    }

    /// Adds the contents of a `bvh.bin` as a part of the BVH registered as `reference` (call once per part).
    ///
    /// Formula: F56 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn load_bvh(&mut self, reference: &str, bytes: &[u8]) -> Result<(), JsError> {
        let part = Bvh::from_bytes(bytes).map_err(js_error)?;
        let set = self
            .bvhs
            .entry(reference.to_string())
            .or_insert_with(|| BvhSet { parts: Vec::new() });
        set.parts.push(part);
        self.resources.add_bvh(reference, set.clone());
        Ok(())
    }

    /// Registers the contents of a `VCOL1` file (gzip, or already decompressed) as `reference`.
    ///
    /// Formula: F59 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn load_vcol(&mut self, reference: &str, bytes: &[u8]) -> Result<(), JsError> {
        let columns = VoxelColumns::from_bytes(bytes).map_err(js_error)?;
        self.resources.add_vcol(reference, columns);
        Ok(())
    }

    /// Registers the contents of an `RTRI1` file (gzip, or already decompressed) as the precision region
    /// `reference`, built against the voxel columns registered as `vcol_reference` (load those first).
    ///
    /// Formula: F60 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn load_region(
        &mut self,
        reference: &str,
        vcol_reference: &str,
        bytes: &[u8],
    ) -> Result<(), JsError> {
        let file = RegionFile::from_bytes(bytes).map_err(js_error)?;
        self.resources
            .add_region(reference, vcol_reference, file)
            .map_err(js_error)
    }

    /// Answers a JSON request (see `README.md`) with a JSON response.
    ///
    /// Formula: F20, F21, F37 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn run(&self, request_json: &str) -> Result<String, JsError> {
        run_json(request_json, &self.resources).map_err(js_error)
    }

    /// First hit of the segment `p0 -> p1` (6 numbers) in the BVH `reference`: `[part, triangle, t]`, or an
    /// empty array if the segment is clear.
    ///
    /// Formula: F48, F57, F58 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn first_hit(&self, reference: &str, segment: &[f64]) -> Result<Vec<f64>, JsError> {
        let set = self
            .bvhs
            .get(reference)
            .ok_or_else(|| JsError::new("unknown bvh"))?;
        if segment.len() != 6 {
            return Err(JsError::new("a segment is 6 numbers"));
        }
        Ok(
            match Scene::first_hit(
                set,
                [segment[0], segment[1], segment[2]],
                [segment[3], segment[4], segment[5]],
            ) {
                Some(hit) => vec![f64::from(hit.part), f64::from(hit.triangle), hit.t],
                None => Vec::new(),
            },
        )
    }

    /// First occupied voxel the segment `p0 -> p1` (6 numbers) enters in the columns `reference`:
    /// `[column, row, z, t]`, or an empty array if the segment is clear.
    ///
    /// Formula: F44, F45, F46, F47 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn voxel_first_block(&self, reference: &str, segment: &[f64]) -> Result<Vec<f64>, JsError> {
        let columns = self
            .resources
            .vcol(reference)
            .ok_or_else(|| JsError::new("unknown vcol"))?;
        if segment.len() != 6 {
            return Err(JsError::new("a segment is 6 numbers"));
        }
        Ok(
            match columns.first_block(
                [segment[0], segment[1], segment[2]],
                [segment[3], segment[4], segment[5]],
            ) {
                Some(hit) => vec![
                    f64::from(hit.column),
                    f64::from(hit.row),
                    f64::from(hit.z),
                    hit.t,
                ],
                None => Vec::new(),
            },
        )
    }

    /// The precision pass for the segment `p0 -> p1` (6 numbers): the voxel columns `vcol_reference` decide it
    /// away from the region `reference`'s triangles. `[t, 0, column, row, z]` for a voxel, `[t, 1, triangle]` for
    /// a triangle of the region, or an empty array if the segment is clear.
    ///
    /// Formula: F63 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn precision_first_block(
        &self,
        reference: &str,
        vcol_reference: &str,
        segment: &[f64],
    ) -> Result<Vec<f64>, JsError> {
        let region = self
            .resources
            .region(reference)
            .ok_or_else(|| JsError::new("unknown region"))?;
        let columns = self
            .resources
            .vcol(vcol_reference)
            .ok_or_else(|| JsError::new("unknown vcol"))?;
        if segment.len() != 6 {
            return Err(JsError::new("a segment is 6 numbers"));
        }
        Ok(
            match region.first_block(
                columns,
                [segment[0], segment[1], segment[2]],
                [segment[3], segment[4], segment[5]],
            ) {
                Some(hit) => match hit.kind {
                    HitKind::Voxel(voxel) => vec![
                        hit.t,
                        0.0,
                        f64::from(voxel.column),
                        f64::from(voxel.row),
                        f64::from(voxel.z),
                    ],
                    HitKind::Triangle(triangle) => vec![hit.t, 1.0, f64::from(triangle)],
                },
                None => Vec::new(),
            },
        )
    }
}

/// A heightmap of 16-bit levels read in the engine's frame (X east, Y north, metres), for the page's heights: a
/// handle of its own, so a read does not pass a name through the module's memory. Call `free` when done with it.
#[wasm_bindgen]
pub struct Terrain {
    map: Heightmap,
    /// The detail layer being read by `begin_detail` and `step_detail`.
    loading: Option<DetailLoad>,
}

#[wasm_bindgen]
impl Terrain {
    /// A heightmap of `width * height` levels (row 0 first): `Z = z_min + level * z_step`, sample `(row, col)` at
    /// `origin + col * spacing * (cos yaw, sin yaw) + row * spacing * (sin yaw, -cos yaw)`.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        levels: Vec<u16>,
        width: usize,
        height: usize,
        z_min: f64,
        z_step: f64,
        origin_x: f64,
        origin_y: f64,
        spacing: f64,
        yaw_deg: f64,
    ) -> Result<Terrain, JsError> {
        let lattice = Lattice {
            origin_x,
            origin_y,
            spacing,
            yaw_deg,
        };
        let map = Heightmap::with_frame(width, height, levels, z_min, z_step, lattice)
            .map_err(js_error)?;
        Ok(Terrain { map, loading: None })
    }

    /// Adds the `HMD1` detail layer (gzip, or already decompressed). On an error the heightmap keeps reading
    /// without it.
    ///
    /// Formula: F31, F33 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn set_detail(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.map.set_detail(bytes).map_err(js_error)
    }

    /// Begins reading the `HMD1` detail layer (gzip, or already decompressed) in slices, replacing a load in
    /// progress: `step_detail` decodes it. On an error the heightmap keeps reading without it.
    ///
    /// Formula: F31, F33 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn begin_detail(&mut self, bytes: Vec<u8>) -> Result<(), JsError> {
        self.loading = None;
        self.loading = Some(self.map.begin_detail(bytes).map_err(js_error)?);
        Ok(())
    }

    /// Decodes the next `quads` quads of the detail layer begun by `begin_detail`; true once the layer is complete
    /// and in use. On an error the load is dropped and the heightmap keeps its former detail.
    ///
    /// Formula: F31, F33 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn step_detail(&mut self, quads: usize) -> Result<bool, JsError> {
        let load = self
            .loading
            .as_mut()
            .ok_or_else(|| JsError::new("no detail load in progress"))?;
        let complete = self
            .map
            .continue_detail(load, quads)
            .inspect_err(|_| self.loading = None)
            .map_err(js_error)?;
        if complete {
            self.loading = None;
        }
        Ok(complete)
    }

    /// Height at world `(x, y)`, NaN where there is none (more than half a sample outside the lattice, a
    /// non-finite coordinate).
    ///
    /// Formula: F26, F28, F29, F32 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn height_at(&self, x: f64, y: f64) -> f64 {
        self.map.height_at(x, y)
    }

    /// Heights at the points `xy` (x0, y0, x1, y1, ...), NaN where there is none.
    ///
    /// Formula: F26, F28, F29, F32 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn heights(&self, xy: &[f64]) -> Result<Vec<f64>, JsError> {
        if xy.len() % 2 != 0 {
            return Err(JsError::new("xy holds x, y pairs"));
        }
        Ok(self.map.heights(xy))
    }
}

/// The levels of a heightmap handed over a few rows at a time, for a page that must not spend long on one call to copy
/// the largest maps' (`new Terrain` copies all of them at once). `finish` makes the `Terrain`.
#[wasm_bindgen]
pub struct TerrainBuilder {
    levels: Vec<u16>,
    samples: usize,
    width: usize,
    height: usize,
    z_min: f64,
    z_step: f64,
    lattice: Lattice,
}

#[wasm_bindgen]
impl TerrainBuilder {
    /// A builder of the heightmap `Terrain::new` takes `width * height` levels for.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        width: usize,
        height: usize,
        z_min: f64,
        z_step: f64,
        origin_x: f64,
        origin_y: f64,
        spacing: f64,
        yaw_deg: f64,
    ) -> Result<TerrainBuilder, JsError> {
        let samples = width
            .checked_mul(height)
            .ok_or_else(|| JsError::new("the grid has more samples than the module can hold"))?;
        Ok(TerrainBuilder {
            levels: Vec::with_capacity(samples),
            samples,
            width,
            height,
            z_min,
            z_step,
            lattice: Lattice {
                origin_x,
                origin_y,
                spacing,
                yaw_deg,
            },
        })
    }

    /// Appends the next levels, row 0 first.
    pub fn push_rows(&mut self, rows: &[u16]) -> Result<(), JsError> {
        if rows.len() > self.samples - self.levels.len() {
            return Err(JsError::new("more levels than the grid has samples"));
        }
        self.levels.extend_from_slice(rows);
        Ok(())
    }

    /// The heightmap, once all `width * height` levels were pushed.
    pub fn finish(self) -> Result<Terrain, JsError> {
        let map = Heightmap::with_frame(
            self.width,
            self.height,
            self.levels,
            self.z_min,
            self.z_step,
            self.lattice,
        )
        .map_err(js_error)?;
        Ok(Terrain { map, loading: None })
    }
}

/// Answers a JSON request that needs no heightmap or BVH.
///
/// Formula: F20, F21 in docs/thesis-methods-and-results.md of mapping-squad.
#[wasm_bindgen]
pub fn solve_json(request_json: &str) -> Result<String, JsError> {
    run_json(request_json, &Resources::new()).map_err(js_error)
}

/// Builds a BVH from triangle bytes (nine little-endian `f32` per triangle) and returns the `bvh.bin`.
/// At most 2^24 triangles.
///
/// Formula: F52, F53, F54, F56 in docs/thesis-methods-and-results.md of mapping-squad.
#[wasm_bindgen]
pub fn build_bvh(triangle_bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    let soup = triangles_from_le_bytes(triangle_bytes).map_err(js_error)?;
    let set = BvhSet::build(soup, MAX_TRIANGLES, BuildOptions::default()).map_err(js_error)?;
    match set.parts.as_slice() {
        [only] => Ok(only.to_bytes()),
        _ => Err(JsError::new("more triangles than one bvh.bin holds")),
    }
}

/// The `f32` segment/triangle test of the GPU path (SIMD128 when built with it): origin (3), direction (3) and
/// the triangle (9 numbers); returns `t`, or NaN if the segment misses.
///
/// Formula: F48 in docs/thesis-methods-and-results.md of mapping-squad.
#[wasm_bindgen]
pub fn segment_triangle(origin: &[f32], direction: &[f32], triangle: &[f32]) -> f32 {
    let tri = [
        [triangle[0], triangle[1], triangle[2], 0.0],
        [triangle[3], triangle[4], triangle[5], 0.0],
        [triangle[6], triangle[7], triangle[8], 0.0],
    ];
    segment_triangle_f32(
        [origin[0], origin[1], origin[2]],
        [direction[0], direction[1], direction[2]],
        &tri,
    )
    .unwrap_or(f32::NAN)
}

/// Whether this build uses the SIMD128 triangle test.
#[wasm_bindgen]
pub fn has_simd() -> bool {
    cfg!(all(feature = "simd", target_feature = "simd128"))
}
