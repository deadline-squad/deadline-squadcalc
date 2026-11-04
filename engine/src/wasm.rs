//! WebAssembly exports (feature `wasm`), built with `wasm-bindgen`; `js/index.mjs` wraps them.

use crate::bvh::{triangles_from_le_bytes, BuildOptions, Bvh, BvhSet, MAX_TRIANGLES};
use crate::heightmap::Heightmap;
use crate::io::{run_json, Resources};
use crate::trace::{segment_triangle_f32, Scene};
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

    /// Answers a JSON request (see `README.md`) with a JSON response.
    pub fn run(&self, request_json: &str) -> Result<String, JsError> {
        run_json(request_json, &self.resources).map_err(js_error)
    }

    /// First hit of the segment `p0 -> p1` (6 numbers) in the BVH `reference`: `[part, triangle, t]`, or an
    /// empty array if the segment is clear.
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
}

/// Answers a JSON request that needs no heightmap or BVH.
#[wasm_bindgen]
pub fn solve_json(request_json: &str) -> Result<String, JsError> {
    run_json(request_json, &Resources::new()).map_err(js_error)
}

/// Builds a BVH from triangle bytes (nine little-endian `f32` per triangle) and returns the `bvh.bin`.
/// At most 2^24 triangles.
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
