//! Core of the Squad ballistics engine: closed-form firing solutions, analytic trajectory segments, a
//! SAH BVH in a GPU-friendly layout and exact line-of-fire queries. See `README.md`.

// The solver keeps the JS comparisons `!(x > 0)` on purpose: they are true for NaN, `x <= 0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
#![deny(missing_docs)]

pub mod bvh;
pub mod flight;
pub mod heightmap;
pub mod io;
pub mod materials;
pub mod path;
pub mod trace;
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;
pub mod weapon;
