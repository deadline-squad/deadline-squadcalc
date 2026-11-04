//! Core of the Squad ballistics engine: closed-form firing solutions, analytic trajectory segments, a
//! SAH BVH in a GPU-friendly layout and exact line-of-fire queries. See `README.md`.

pub mod bvh;
pub mod flight;
pub mod heightmap;
pub mod path;
pub mod trace;
pub mod weapon;
pub mod io;
pub mod materials;
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;
