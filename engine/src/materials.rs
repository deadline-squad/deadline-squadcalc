//! Surface material lookup for the collision details of a shot.
//!
//! STUB: the collision-semantics data (which mesh is which material, lethality and splash footprint per
//! material) has not been delivered yet. Until it is, every surface is `"unknown"` with lethality 1.0 and a
//! splash footprint radius of 0.0 m. The call sites already pass the triangle that was hit so that the real
//! table only has to replace [`lookup`].

/// What the engine knows about the surface a projectile lands on.
#[derive(Debug, Clone, PartialEq)]
pub struct SurfaceInfo {
    /// Material name, `"unknown"` until the table exists.
    pub material: String,
    /// Fraction of the damage that the surface lets through, 1.0 = full.
    pub lethality: f64,
    /// Radius in metres of the splash footprint on the surface.
    pub splash_footprint_radius: f64,
}

/// Material of the surface a projectile lands on. `triangle` is `(part, triangle index)` of the hit in the
/// BVH, or `None` for terrain or the target point itself.
pub fn lookup(triangle: Option<(u32, u32)>) -> SurfaceInfo {
    let _ = triangle;
    SurfaceInfo {
        material: "unknown".to_string(),
        lethality: 1.0,
        splash_footprint_radius: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stub_knows_nothing() {
        let info = lookup(Some((0, 5)));
        assert_eq!(info.material, "unknown");
        assert_eq!(info.lethality, 1.0);
        assert_eq!(info, lookup(None));
    }
}
