//! Core of the Squad ballistics engine: closed-form firing solutions, analytic trajectory segments, a
//! SAH BVH in a GPU-friendly layout and exact line-of-fire queries. See `README.md`.

pub mod bvh;
pub mod flight;
pub mod heightmap;
pub mod weapon;
