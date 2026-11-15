//! The heightmap: a lattice of 16-bit levels of the terrain, read the way the game's landscape collision is, as the
//! site's heightmaps are (`/heightmaps/<map>/`, built by `tools/heightmaps` of the deployment repository).
//!
//! World frame of the engine: metres, X east, Y north, Z up. Sample `(row, col)` lies at
//! `origin + col * spacing * (cos θ, sin θ) + row * spacing * (sin θ, -cos θ)`: row 0 is the lattice's northern
//! edge when `θ = 0`, the sample axes are turned by the yaw `θ` (Skorpo's landscape is turned by 2.006 degrees). The
//! height of a level `v` is `Z = z_min + v * z_step`. The site's `meta.json` states the lattice in Unreal's frame
//! (Y south, yaw clockwise): negate `Y` of the origin and the yaw.
//!
//! The surface: every quad of four samples is two triangles split along the diagonal from its `(row, col)` corner
//! to its `(row + 1, col + 1)` corner, and the height is interpolated on the triangle the point is in. A quad that
//! has detail (`detail`, the `HMD1` layer) is read the same way on a sub-grid, and a quad without it beside a quad
//! with it shares the nodes of their edge, so the surface is continuous. A point more than half a sample outside
//! the lattice, or a non-finite coordinate, has no height: NaN. The edge sample holds within half a sample.

mod detail;

use detail::Detail;
pub use detail::DetailLoad;
use std::fmt;

/// Reasons a heightmap cannot be loaded.
#[derive(Debug)]
pub enum HeightmapError {
    /// The raw buffer is not `width * height` samples.
    Size {
        /// Samples expected.
        expected: usize,
        /// Samples found.
        found: usize,
    },
    /// The grid is smaller than 2 x 2 samples.
    TooSmall,
    /// The PNG could not be decoded or is not a 16-bit grayscale image.
    Png(String),
    /// A number of the frame (origin, spacing, yaw, `z_min`, `z_step`) is not finite, or the spacing is not positive.
    Frame(&'static str),
    /// The detail layer cannot be used with this heightmap.
    Detail(&'static str),
}

impl fmt::Display for HeightmapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HeightmapError::Size { expected, found } => {
                write!(
                    f,
                    "heightmap buffer has {found} samples, expected {expected}"
                )
            }
            HeightmapError::TooSmall => write!(f, "heightmap needs at least 2 x 2 samples"),
            HeightmapError::Png(reason) => write!(f, "heightmap PNG: {reason}"),
            HeightmapError::Frame(reason) => write!(f, "heightmap frame: {reason}"),
            HeightmapError::Detail(reason) => write!(f, "heightmap detail: {reason}"),
        }
    }
}

impl std::error::Error for HeightmapError {}

/// Where the samples of a heightmap lie, in the engine's frame (X east, Y north).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lattice {
    /// World X of sample `(0, 0)`, metres.
    pub origin_x: f64,
    /// World Y of sample `(0, 0)`, metres.
    pub origin_y: f64,
    /// Metres between two neighbouring samples (1 on most maps, 0.5 on Chora and Kokan, 1.2 on Skorpo).
    pub spacing: f64,
    /// Turn of the sample axes, degrees counter-clockwise: the columns run along `(cos, sin)` of it.
    pub yaw_deg: f64,
}

/// A heightmap: the levels of its samples, the transform to metres and the lattice they lie on.
#[derive(Debug, Clone)]
pub struct Heightmap {
    width: usize,
    height: usize,
    levels: Vec<u16>,
    z_min: f64,
    z_step: f64,
    origin_x: f64,
    origin_y: f64,
    spacing: f64,
    cos: f64,
    sin: f64,
    detail: Option<Detail>,
}

impl Heightmap {
    /// A heightmap of `width * height` levels, row 0 first, on `lattice`, with `Z = z_min + level * z_step`.
    ///
    /// # Errors
    /// [`HeightmapError::TooSmall`] below 2 x 2 samples, [`HeightmapError::Size`] if `levels` does not have
    /// `width * height` entries, [`HeightmapError::Frame`] if a number of the frame is not finite or the spacing is
    /// not positive.
    pub fn with_frame(
        width: usize,
        height: usize,
        levels: Vec<u16>,
        z_min: f64,
        z_step: f64,
        lattice: Lattice,
    ) -> Result<Self, HeightmapError> {
        if width < 2 || height < 2 {
            return Err(HeightmapError::TooSmall);
        }
        if levels.len() != width * height {
            return Err(HeightmapError::Size {
                expected: width * height,
                found: levels.len(),
            });
        }
        let finite = [
            z_min,
            z_step,
            lattice.origin_x,
            lattice.origin_y,
            lattice.spacing,
            lattice.yaw_deg,
        ]
        .iter()
        .all(|v| v.is_finite());
        if !finite {
            return Err(HeightmapError::Frame("every number must be finite"));
        }
        if lattice.spacing <= 0.0 {
            return Err(HeightmapError::Frame("the spacing must be positive"));
        }
        let yaw = lattice.yaw_deg.to_radians();
        Ok(Heightmap {
            width,
            height,
            levels,
            z_min,
            z_step,
            origin_x: lattice.origin_x,
            origin_y: lattice.origin_y,
            spacing: lattice.spacing,
            cos: yaw.cos(),
            sin: yaw.sin(),
            detail: None,
        })
    }

    /// A heightmap in the legacy frame of the first release: sample `(row, col)` at `X = col * resolution`,
    /// `Y = -row * resolution`, and `Z = (v / 65535 * 2 - 1) * z_scale`.
    ///
    /// # Errors
    /// As [`Heightmap::with_frame`].
    pub fn new(
        width: usize,
        height: usize,
        levels: Vec<u16>,
        z_scale: f64,
        resolution: f64,
    ) -> Result<Self, HeightmapError> {
        Heightmap::with_frame(
            width,
            height,
            levels,
            -z_scale,
            2.0 * z_scale / 65535.0,
            Lattice {
                origin_x: 0.0,
                origin_y: 0.0,
                spacing: resolution,
                yaw_deg: 0.0,
            },
        )
    }

    /// A heightmap from the raw `.g16` format: `u32` width, `u32` height (little endian), then the samples
    /// as little-endian `u16`, row 0 first; in the legacy frame of [`Heightmap::new`].
    ///
    /// # Errors
    /// As [`Heightmap::new`]; also [`HeightmapError::Size`] if the header is missing.
    pub fn from_g16(bytes: &[u8], z_scale: f64, resolution: f64) -> Result<Self, HeightmapError> {
        let header: [u8; 8] =
            bytes
                .get(..8)
                .and_then(|b| b.try_into().ok())
                .ok_or(HeightmapError::Size {
                    expected: 8,
                    found: bytes.len(),
                })?;
        let width = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let height = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let levels = bytes[8..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        Heightmap::new(width, height, levels, z_scale, resolution)
    }

    /// A heightmap from a 16-bit grayscale PNG (the format of the site's `heightmap.png`), in the legacy frame of
    /// [`Heightmap::new`].
    ///
    /// # Errors
    /// [`HeightmapError::Png`] if the file is not a decodable 16-bit grayscale PNG.
    pub fn from_png(bytes: &[u8], z_scale: f64, resolution: f64) -> Result<Self, HeightmapError> {
        let png_error = |e: png::DecodingError| HeightmapError::Png(e.to_string());
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .map_err(png_error)?;
        let info = reader.info();
        if info.color_type != png::ColorType::Grayscale || info.bit_depth != png::BitDepth::Sixteen
        {
            return Err(HeightmapError::Png("not a 16-bit grayscale image".into()));
        }
        let mut buffer = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buffer).map_err(png_error)?;
        let levels = buffer[..frame.buffer_size()]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        Heightmap::new(
            frame.width as usize,
            frame.height as usize,
            levels,
            z_scale,
            resolution,
        )
    }

    /// Adds the `HMD1` detail layer (gzip, or already decompressed) to the heightmap, replacing a former one.
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] for a wrong magic, a detail of another grid, damaged gzip, or a truncated or
    /// damaged file; the heightmap keeps its former detail then.
    pub fn set_detail(&mut self, bytes: &[u8]) -> Result<(), HeightmapError> {
        self.detail = Some(Detail::from_bytes(
            bytes,
            &self.levels,
            self.width,
            self.height,
        )?);
        Ok(())
    }

    /// Begins reading the `HMD1` detail layer (gzip, or already decompressed) in slices: the header and the bitset
    /// are checked now, [`Heightmap::continue_detail`] decodes the nodes a few quads at a time.
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] for a wrong magic, a detail of another grid, damaged gzip, or a truncated or
    /// damaged header or bitset.
    pub fn begin_detail(&self, bytes: Vec<u8>) -> Result<DetailLoad, HeightmapError> {
        DetailLoad::new(bytes, self.width, self.height)
    }

    /// Decodes the next `quads` quads of `load` (or all that are left); the layer replaces the heightmap's detail when
    /// the last one is decoded. `load` must come from [`Heightmap::begin_detail`] of this heightmap, whose levels
    /// have not changed since.
    ///
    /// # Returns
    /// Whether the layer is complete.
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] for a truncated or damaged file; the heightmap keeps its former detail then.
    pub fn continue_detail(
        &mut self,
        load: &mut DetailLoad,
        quads: usize,
    ) -> Result<bool, HeightmapError> {
        if !load.advance(&self.levels, self.width, quads)? {
            return Ok(false);
        }
        self.detail = Some(load.finish()?);
        Ok(true)
    }

    /// Columns of the grid.
    pub fn width(&self) -> usize {
        self.width
    }

    /// Rows of the grid.
    pub fn height(&self) -> usize {
        self.height
    }

    /// Metres between two samples.
    pub fn resolution(&self) -> f64 {
        self.spacing
    }

    /// Number of quads that have detail, 0 without the layer.
    pub fn detail_quads(&self) -> usize {
        self.detail.as_ref().map_or(0, Detail::quad_count)
    }

    /// Height at world `(x, y)` on the game's collision surface, in metres (`z_min + level * z_step`); NaN more
    /// than half a sample outside the lattice (the edge sample holds within half a sample) and for a
    /// non-finite coordinate.
    pub fn height_at(&self, x: f64, y: f64) -> f64 {
        self.z_min + self.level_at(x, y) * self.z_step
    }

    /// As [`Heightmap::height_at`] with the legacy transform of another `z_scale` (the one of a request's
    /// environment): `Z = (level / 65535 * 2 - 1) * z_scale`.
    pub fn height_at_scaled(&self, x: f64, y: f64, z_scale: f64) -> f64 {
        (self.level_at(x, y) / 65535.0 * 2.0 - 1.0) * z_scale
    }

    /// [`Heightmap::height_at`] of every `(x, y)` pair of `xy` (a trailing odd value is ignored), in order.
    pub fn heights(&self, xy: &[f64]) -> Vec<f64> {
        xy.chunks_exact(2)
            .map(|point| self.height_at(point[0], point[1]))
            .collect()
    }

    /// The level of the surface at world `(x, y)`, NaN where there is none (see [`Heightmap::height_at`]).
    fn level_at(&self, x: f64, y: f64) -> f64 {
        let rows = self.height;
        let cols = self.width;
        let (dx, dy) = (x - self.origin_x, y - self.origin_y);
        let mut row = (dx * self.sin - dy * self.cos) / self.spacing;
        let mut col = (dx * self.cos + dy * self.sin) / self.spacing;
        // False for NaN: a point outside the lattice or a non-finite coordinate has no height
        if !(row >= -0.5 && row <= rows as f64 - 0.5 && col >= -0.5 && col <= cols as f64 - 0.5) {
            return f64::NAN;
        }
        row = row.clamp(0.0, (rows - 1) as f64);
        col = col.clamp(0.0, (cols - 1) as f64);

        let row0 = (row.floor() as usize).min(rows - 2);
        let col0 = (col.floor() as usize).min(cols - 2);
        let row_weight = row - row0 as f64;
        let col_weight = col - col0 as f64;
        let at = |r: usize, c: usize| f64::from(self.levels[r * cols + c]);
        let corner = at(row0, col0);
        let right = at(row0, col0 + 1);
        let below = at(row0 + 1, col0);
        let diagonal = at(row0 + 1, col0 + 1);
        if let Some(level) = self.detail.as_ref().and_then(|detail| {
            detail.level(
                row0,
                col0,
                [corner, right, below, diagonal],
                row_weight,
                col_weight,
            )
        }) {
            return level;
        }
        if col_weight >= row_weight {
            corner + (right - corner) * col_weight + (diagonal - right) * row_weight
        } else {
            corner + (below - corner) * row_weight + (diagonal - below) * col_weight
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn map(levels: [u16; 4]) -> Heightmap {
        Heightmap::new(2, 2, levels.to_vec(), 100.0, 1.0).unwrap()
    }

    /// A heightmap whose levels are `rows`, one sample per metre from (0, 0) with rows running south, `Z = level`.
    fn grid(rows: &[&[u16]]) -> Heightmap {
        let levels = rows.iter().flat_map(|row| row.iter().copied()).collect();
        let lattice = Lattice {
            origin_x: 0.0,
            origin_y: 0.0,
            spacing: 1.0,
            yaw_deg: 0.0,
        };
        Heightmap::with_frame(rows[0].len(), rows.len(), levels, 0.0, 1.0, lattice).unwrap()
    }

    /// The bytes of a `HMD1` file without its gzip layer: `quads` maps a quad (`row * quad_columns + col`) to the
    /// stored values of its sub-grid nodes without the corners, row-major.
    fn detail_bytes(
        factor: u32,
        unit: u32,
        quad_columns: u32,
        quad_rows: u32,
        quads: &[(u32, Vec<i64>)],
    ) -> Vec<u8> {
        let mut bytes = b"HMD1".to_vec();
        for value in [factor, unit, quad_columns, quad_rows, quads.len() as u32] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let mut bits = vec![0u8; (quad_columns * quad_rows).div_ceil(8) as usize];
        for (quad, _) in quads {
            bits[(quad / 8) as usize] |= 1 << (quad % 8);
        }
        bytes.extend(bits);
        for (_, values) in quads {
            for &value in values {
                let mut zigzag = if value >= 0 {
                    2 * value as u64
                } else {
                    (-2 * value - 1) as u64
                };
                while zigzag >= 0x80 {
                    bytes.push((zigzag % 128) as u8 | 0x80);
                    zigzag /= 128;
                }
                bytes.push(zigzag as u8);
            }
        }
        bytes
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn samples_are_exact_at_the_corners() {
        let h = map([0, 65535, 32768, 16384]);
        let z = |v: f64| (v / 65535.0 * 2.0 - 1.0) * 100.0;
        assert!((h.height_at(0.0, 0.0) - z(0.0)).abs() < 1e-12);
        assert!((h.height_at(1.0, 0.0) - z(65535.0)).abs() < 1e-12);
        assert!((h.height_at(0.0, -1.0) - z(32768.0)).abs() < 1e-12);
        assert!((h.height_at(1.0, -1.0) - z(16384.0)).abs() < 1e-12);
    }

    #[test]
    fn a_twisted_quad_is_split_along_the_main_diagonal() {
        // Corners (row, col): (0,0)=0 (0,1)=1000 (1,0)=1000 (1,1)=0, twisted. At fx = 0.75, fy = 0.25 the
        // point is in the upper-right triangle (col weight >= row weight): 0 + 1000*0.75 + (0-1000)*0.25.
        let h = map([0, 1000, 1000, 0]);
        let expected_level = 500.0;
        let expected = (expected_level / 65535.0 * 2.0 - 1.0) * 100.0;
        assert!((h.height_at(0.75, -0.25) - expected).abs() < 1e-12);
        // Bilinear interpolation of the same quad gives 625: the diagonal rule is not bilinear
        let bilinear = 1000.0 * 0.5625 + 1000.0 * 0.0625;
        assert!((bilinear - expected_level).abs() > 1.0);
    }

    #[test]
    fn outside_the_lattice_and_for_a_non_finite_coordinate_there_is_no_height() {
        let h = grid(&[&[5, 5], &[5, 5]]);
        // The edge sample holds within half a sample
        assert_eq!(h.height_at(1.4, 0.0), 5.0);
        assert_eq!(h.height_at(0.0, 0.4), 5.0);
        for (x, y) in [
            (1.6, 0.0),
            (0.0, -1.6),
            (-0.6, 0.0),
            (0.0, 0.6),
            (50.0, 0.0),
            (f64::NAN, 0.0),
            (0.0, f64::NAN),
            (f64::INFINITY, 0.0),
            (0.0, f64::NEG_INFINITY),
        ] {
            assert!(h.height_at(x, y).is_nan(), "({x}, {y})");
        }
        assert!(h.height_at_scaled(50.0, 0.0, 10.0).is_nan());
    }

    #[test]
    fn rejects_a_wrong_buffer_size_and_a_bad_frame() {
        let lattice = Lattice {
            origin_x: 0.0,
            origin_y: 0.0,
            spacing: 1.0,
            yaw_deg: 0.0,
        };
        assert!(matches!(
            Heightmap::new(2, 2, vec![0; 3], 1.0, 1.0),
            Err(HeightmapError::Size { .. })
        ));
        assert!(matches!(
            Heightmap::new(1, 2, vec![0; 2], 1.0, 1.0),
            Err(HeightmapError::TooSmall)
        ));
        for bad in [
            Lattice {
                spacing: 0.0,
                ..lattice
            },
            Lattice {
                origin_x: f64::NAN,
                ..lattice
            },
            Lattice {
                yaw_deg: f64::INFINITY,
                ..lattice
            },
        ] {
            assert!(matches!(
                Heightmap::with_frame(2, 2, vec![0; 4], 0.0, 1.0, bad),
                Err(HeightmapError::Frame(_))
            ));
        }
        assert!(matches!(
            Heightmap::with_frame(2, 2, vec![0; 4], f64::NAN, 1.0, lattice),
            Err(HeightmapError::Frame(_))
        ));
    }

    #[test]
    fn raw_g16_round_trip() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        for v in [1u16, 2, 3, 65535] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let h = Heightmap::from_g16(&bytes, 10.0, 1.0).unwrap();
        assert_eq!((h.width(), h.height()), (2, 2));
        assert!((h.height_at(1.0, -1.0) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn z_min_and_z_step_give_the_height_of_a_level() {
        let lattice = Lattice {
            origin_x: 0.0,
            origin_y: 0.0,
            spacing: 1.0,
            yaw_deg: 0.0,
        };
        let h =
            Heightmap::with_frame(2, 2, vec![0, 100, 200, 300], -360.75, 0.25, lattice).unwrap();
        assert_eq!(h.height_at(0.0, 0.0), -360.75);
        assert_eq!(h.height_at(1.0, 0.0), -335.75);
        assert_eq!(h.height_at(1.0, -1.0), -285.75);
    }

    #[test]
    fn the_samples_lie_where_the_lattice_puts_them() {
        // Goose Bay: the landscape's vertices are 0.431 m east and 0.252 m south of a whole metre
        let lattice = Lattice {
            origin_x: -0.431,
            origin_y: 0.252,
            spacing: 1.0,
            yaw_deg: 0.0,
        };
        let levels = vec![0, 0, 0, 0, 100, 0, 0, 0, 0];
        let h = Heightmap::with_frame(3, 3, levels, 0.0, 1.0, lattice).unwrap();
        assert!((h.height_at(0.569, -0.748) - 100.0).abs() < 1e-9);
        // Read from the origin (0, 0) instead, that point would be 57 % lower
        assert!((h.height_at(1.0, -1.0) - 100.0 * (1.0 - 0.431)).abs() < 1e-9);
    }

    #[test]
    fn a_turned_lattice_is_read_along_its_own_axes() {
        // 1.2 m samples turned by 2.006195 degrees counter-clockwise: sample (row, col) at
        // origin + 1.2 col (cos, sin) + 1.2 row (sin, -cos), the plane z = 40 row + 10 col
        let lattice = Lattice {
            origin_x: -3851.481,
            origin_y: 3285.1115,
            spacing: 1.2,
            yaw_deg: 2.006195,
        };
        let rows: Vec<Vec<u16>> = (0..4)
            .map(|r| (0..4).map(|c| 40 * r + 10 * c).collect())
            .collect();
        let levels = rows.concat();
        let h = Heightmap::with_frame(4, 4, levels, 0.0, 1.0, lattice).unwrap();
        let (cos, sin) = (
            2.006195f64.to_radians().cos(),
            2.006195f64.to_radians().sin(),
        );
        let at = |row: f64, col: f64| {
            (
                lattice.origin_x + 1.2 * (col * cos + row * sin),
                lattice.origin_y + 1.2 * (col * sin - row * cos),
            )
        };
        for (row, col) in [(0.0, 0.0), (1.0, 2.0), (3.0, 3.0), (1.25, 2.5)] {
            let (x, y) = at(row, col);
            assert!(
                (h.height_at(x, y) - (40.0 * row + 10.0 * col)).abs() < 1e-6,
                "({row}, {col})"
            );
        }
        // Read along X and Y alone, sample (3, 3) would lie 0.13 m off
        let unturned = Heightmap::with_frame(
            4,
            4,
            rows.concat(),
            0.0,
            1.0,
            Lattice {
                yaw_deg: 0.0,
                ..lattice
            },
        )
        .unwrap();
        let (x, y) = at(3.0, 3.0);
        assert!((unturned.height_at(x, y) - 150.0).abs() > 3.0);
    }

    #[test]
    fn heights_reads_every_pair_in_order() {
        let h = grid(&[&[0, 10], &[20, 30]]);
        let xy = [0.0, 0.0, 1.0, 0.0, f64::NAN, 0.0, 0.0, -1.0, 5.0];
        let heights = h.heights(&xy);
        assert_eq!(heights.len(), 4);
        assert_eq!((heights[0], heights[1], heights[3]), (0.0, 10.0, 20.0));
        assert!(heights[2].is_nan());
        assert!(h.heights(&[]).is_empty());
    }

    // A flat 2 x 2 heightmap at level 0 (one quad) whose five inner nodes the detail raises: the middles of the top,
    // left, right and bottom edges and the centre
    fn chimney() -> Heightmap {
        let mut h = grid(&[&[0, 0], &[0, 0]]);
        h.set_detail(&detail_bytes(2, 1, 1, 1, &[(0, vec![10, 20, 100, 30, 40])]))
            .unwrap();
        h
    }

    #[test]
    fn a_quad_with_detail_is_read_on_its_sub_grid_with_the_triangle_rule() {
        let h = chimney();
        let z = |x: f64, y: f64| h.height_at(x, -y);
        let at = |row: f64, col: f64| z(col, row);
        assert_eq!(h.detail_quads(), 1);
        let nodes = [
            at(0.0, 0.5),
            at(0.5, 0.0),
            at(0.5, 0.5),
            at(0.5, 1.0),
            at(1.0, 0.5),
        ];
        assert_eq!(nodes, [10.0, 20.0, 100.0, 30.0, 40.0]);
        assert_eq!(
            [at(0.0, 0.0), at(0.0, 1.0), at(1.0, 0.0), at(1.0, 1.0)],
            [0.0; 4]
        );
        // On the diagonal of the upper-left sub-quad from its corner (0) to the centre (100), the upper-right one
        // from the top edge's middle (10) to the right edge's middle (30)
        assert_eq!(at(0.25, 0.25), 50.0);
        assert_eq!(at(0.25, 0.75), 20.0);
    }

    #[test]
    fn the_nodes_count_from_the_triangle_rules_read_rounded_half_up_in_units() {
        // Corners 0, 1, 1, 2: the read is 0.5 at the middle of the top edge, which counts as 1
        let mut plane = grid(&[&[0, 1], &[1, 2]]);
        plane
            .set_detail(&detail_bytes(2, 1, 1, 1, &[(0, vec![0; 5])]))
            .unwrap();
        assert_eq!(plane.height_at(0.5, 0.0), 1.0);
        assert_eq!(plane.height_at(0.5, -0.5), 1.0);
        // A unit of 5 levels: the centre's 3 units lift it from the read 10 to 25, a negative value lowers a node
        let mut units = grid(&[&[0, 10], &[10, 20]]);
        units
            .set_detail(&detail_bytes(2, 5, 1, 1, &[(0, vec![0, -1, 3, 0, 0])]))
            .unwrap();
        assert_eq!(units.height_at(0.5, -0.5), 25.0);
        assert_eq!(units.height_at(0.0, -0.5), 0.0);
        assert_eq!(units.height_at(0.5, 0.0), 5.0);
    }

    #[test]
    fn a_gzipped_detail_is_read_like_a_plain_one() {
        let bytes = detail_bytes(2, 1, 1, 1, &[(0, vec![10, 20, 100, 30, 40])]);
        let mut h = grid(&[&[0, 0], &[0, 0]]);
        h.set_detail(&gzip(&bytes)).unwrap();
        assert_eq!(h.height_at(0.5, -0.5), 100.0);
    }

    #[test]
    fn a_detail_of_another_heightmap_or_a_damaged_one_is_refused() {
        let good = detail_bytes(2, 1, 2, 1, &[(1, vec![1, 2, 3, 4, 5])]);
        let mut h = grid(&[&[0, 0, 0], &[0, 0, 0]]);
        assert!(h.set_detail(&good).is_ok());
        assert_eq!(
            refused_detail(&detail_bytes(2, 1, 1, 1, &[])),
            "detail of another heightmap"
        );
        let mut magic = good.clone();
        magic[3] = b'2';
        assert_eq!(refused_detail(&magic), "not an HMD1 detail");
        let mut count = good.clone();
        count[20] = 2;
        assert_eq!(refused_detail(&count), "damaged detail");
        assert_eq!(refused_detail(&good[..good.len() - 1]), "truncated detail");
        let mut longer = good.clone();
        longer.push(0);
        assert_eq!(refused_detail(&longer), "damaged detail");
        assert_eq!(refused_detail(&good[..10]), "not an HMD1 detail");
        assert_eq!(
            refused_detail(&detail_bytes(1, 1, 2, 1, &[])),
            "unsupported detail factor"
        );
        assert_eq!(refused_detail(&[0x1F, 0x8B, 0, 0]), "bad gzip data");
        // A refused detail leaves the former one
        let mut kept = chimney();
        assert!(kept.set_detail(&magic).is_err());
        assert_eq!(kept.height_at(0.5, -0.5), 100.0);
    }

    fn refused_detail(bytes: &[u8]) -> &'static str {
        match grid(&[&[0, 0, 0], &[0, 0, 0]]).set_detail(bytes) {
            Err(HeightmapError::Detail(reason)) => reason,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_bit_set_past_the_last_quad_is_refused() {
        // Two quads leave six padding bits in the one bitset byte; bit 2 names a third quad, and the count of 1
        // agrees with it
        let mut padding = detail_bytes(2, 1, 2, 1, &[]);
        padding[20] = 1;
        padding[24] = 1 << 2;
        padding.extend([0; 5]);
        assert_eq!(refused_detail(&padding), "damaged detail");
    }

    #[test]
    fn a_varint_cut_short_or_too_long_is_refused() {
        let good = detail_bytes(2, 1, 2, 1, &[(1, vec![1, 2, 3, 4, 1000])]);
        // The last value takes two bytes: dropping the second leaves a continuation byte at the end of the file
        assert_eq!(refused_detail(&good[..good.len() - 1]), "truncated detail");
        // Ten continuation bytes are longer than any value of 63 bits
        let mut long = detail_bytes(2, 1, 2, 1, &[(1, vec![1, 2, 3, 4])]);
        long.extend([0x80; 10]);
        assert_eq!(refused_detail(&long), "damaged detail");
    }

    #[test]
    fn a_value_beyond_the_level_range_is_refused_without_overflow() {
        // 2^33 units of 2^31 levels is 2^64, which wraps to 0 in 64-bit arithmetic
        let wrapping = detail_bytes(2, 1 << 31, 2, 1, &[(1, vec![1 << 33, 0, 0, 0, 0])]);
        assert_eq!(refused_detail(&wrapping), "damaged detail");
        // The longest varint, 2^63 - 1, is a zigzag value whose decoding must not overflow
        let mut longest = detail_bytes(2, 1, 2, 1, &[(1, vec![0, 0, 0, 0])]);
        longest.extend([0xFF; 8]);
        longest.push(0x7F);
        assert_eq!(refused_detail(&longest), "damaged detail");
    }

    const SLICED: [&[u16]; 3] = [&[0, 5, 9], &[3, 8, 2], &[7, 1, 6]];

    // 2 x 2 quads, the first and the last with detail
    fn sliced_detail() -> Vec<u8> {
        detail_bytes(
            2,
            2,
            2,
            2,
            &[(0, vec![1, -2, 3, 0, 4]), (3, vec![-1, 0, 2, 5, -3])],
        )
    }

    fn surface(h: &Heightmap) -> Vec<f64> {
        (0..=16)
            .flat_map(|row| (0..=16).map(move |col| (row, col)))
            .map(|(row, col)| h.height_at(f64::from(col) / 8.0, -f64::from(row) / 8.0))
            .collect()
    }

    #[test]
    fn a_detail_read_in_slices_is_the_detail_read_at_once() {
        let mut at_once = grid(&SLICED);
        at_once.set_detail(&sliced_detail()).unwrap();
        let mut sliced = grid(&SLICED);
        let mut load = sliced.begin_detail(sliced_detail()).unwrap();
        assert!(!sliced.continue_detail(&mut load, 1).unwrap());
        assert_eq!(sliced.detail_quads(), 0);
        assert!(sliced.continue_detail(&mut load, 1).unwrap());
        assert_eq!(sliced.detail_quads(), 2);
        assert_eq!(surface(&sliced), surface(&at_once));
        assert_ne!(surface(&sliced), surface(&grid(&SLICED)));
    }

    #[test]
    fn a_damaged_detail_read_in_slices_is_refused_and_keeps_the_former_one() {
        let mut h = grid(&SLICED);
        h.set_detail(&sliced_detail()).unwrap();
        let before = surface(&h);
        // The first quad's last value takes two bytes and the file lacks the last: the first slice is fine, the second
        // finds the file truncated
        let cut = detail_bytes(2, 2, 2, 2, &[(0, vec![0, 0, 0, 0, 1000]), (3, vec![0; 5])]);
        let mut load = h.begin_detail(cut[..cut.len() - 1].to_vec()).unwrap();
        assert!(!h.continue_detail(&mut load, 1).unwrap());
        assert!(matches!(
            h.continue_detail(&mut load, 1),
            Err(HeightmapError::Detail("truncated detail"))
        ));
        assert_eq!(surface(&h), before);
        assert!(matches!(
            h.begin_detail(b"HMD2 and no more of it than this".to_vec()),
            Err(HeightmapError::Detail("not an HMD1 detail"))
        ));
    }

    #[test]
    fn a_quad_without_detail_beside_one_with_it_has_no_jump_on_their_edge() {
        // Each side of the chimney's quad in turn gets a plain neighbour, with a factor of 4: along the shared edge
        // the surface of both sides agrees, and the neighbour keeps its corner read where the detail does not reach
        for side in 0..4 {
            // A 3 x 3 lattice of quads' corners: the quad with detail in the middle, a plain quad on `side`
            let levels = vec![
                0u16, 8, 16, 24, 8, 16, 24, 32, 16, 24, 32, 40, 24, 32, 40, 48,
            ];
            let mut h = grid(&[
                &levels[0..4],
                &levels[4..8],
                &levels[8..12],
                &levels[12..16],
            ]);
            let inner: Vec<i64> = (0..21).map(|k| 40 + k).collect();
            h.set_detail(&detail_bytes(4, 1, 3, 3, &[(4, inner)]))
                .unwrap();
            // The quad (1, 1) spans x 1..2, y -2..-1; its neighbour on `side`
            let (dx, dy) = [(0.0, 1.0), (0.0, -1.0), (-1.0, 0.0), (1.0, 0.0)][side];
            let eps = 1e-9;
            for k in 1..20 {
                let t = f64::from(k) / 20.0;
                // A point on the shared edge, nudged to either side
                let (ex, ey) = match side {
                    0 => (1.0 + t, -1.0),
                    1 => (1.0 + t, -2.0),
                    2 => (1.0, -1.0 - t),
                    _ => (2.0, -1.0 - t),
                };
                let inside = h.height_at(ex - dx * eps, ey - dy * eps);
                let outside = h.height_at(ex + dx * eps, ey + dy * eps);
                assert!(
                    (inside - outside).abs() < 1e-6,
                    "side {side}, t {t}: {inside} against {outside}"
                );
            }
            // A quad two away from the detail keeps the corner read
            let far = grid(&[
                &levels[0..4],
                &levels[4..8],
                &levels[8..12],
                &levels[12..16],
            ]);
            assert_eq!(h.height_at(0.3, -0.2), far.height_at(0.3, -0.2));
        }
    }

    #[test]
    fn a_plain_quad_takes_the_node_its_detail_neighbour_has_on_their_edge() {
        // The chimney's top-edge node is 10 where the corners read 0: the plain quad above it (row 0) reads that 10
        // at the middle of its bottom edge, and its other nodes stay on the corner read
        let mut h = grid(&[&[0, 0], &[0, 0], &[0, 0]]);
        h.set_detail(&detail_bytes(2, 1, 1, 2, &[(1, vec![10, 20, 100, 30, 40])]))
            .unwrap();
        assert!((h.height_at(0.5, -1.0 + 1e-9) - 10.0).abs() < 1e-6);
        // Half way down from the quad's centre to that node: 5; the centre and the top edge stay 0
        assert_eq!(h.height_at(0.5, -0.75), 5.0);
        assert_eq!(h.height_at(0.5, -0.5), 0.0);
        assert_eq!(h.height_at(0.5, 0.0), 0.0);
    }

    #[test]
    fn a_turned_lattice_with_detail_agrees_with_the_independent_reference() {
        // 6 x 5 levels on a lattice turned by 2.006195 degrees, five quads with detail (unit 3) among plain ones that
        // touch them, read at points inside and off the lattice. The expected heights are those of
        // `tools/heightmap/reference.py`, written from the format's description without this code, `Z = level * 0.0625`
        let levels: Vec<u16> = vec![
            1020, 1049, 1105, 1161, 1163, 1204, 1092, 1114, 1126, 1183, 1237, 1243, 1138, 1152,
            1173, 1202, 1245, 1307, 1146, 1164, 1215, 1245, 1315, 1347, 1163, 1252, 1276, 1287,
            1334, 1400,
        ];
        let detail: Vec<u8> = vec![
            72, 77, 68, 49, 2, 0, 0, 0, 3, 0, 0, 0, 5, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 70, 40, 0,
            68, 65, 66, 68, 20, 67, 23, 69, 62, 45, 5, 26, 43, 58, 49, 66, 1, 62, 33, 53, 68, 66,
            31, 14, 55,
        ];
        let lattice = Lattice {
            origin_x: -3.25,
            origin_y: -2.5,
            spacing: 1.2,
            yaw_deg: 2.006195,
        };
        let mut h = Heightmap::with_frame(6, 5, levels, 0.0, 0.0625, lattice).unwrap();
        h.set_detail(&detail).unwrap();
        assert_eq!(h.detail_quads(), 5);
        let expected = [
            (-2.8818188499086412, -2.727250172095434, 65.10625),
            (-1.4300987818110587, -3.036618631836807, 74.1875),
            (-0.2413365906642582, -2.6947934529809214, 64.6875),
            (-0.7884574886349914, -4.214878556849682, 77.3125),
            (0.03422400564723551, -3.7057664287623986, 70.41875),
            (-0.8957812150023529, -4.57885880048747, 72.925),
            (-0.5023946261895718, -5.525667646951339, 73.35),
            (0.8083944639120861, -5.23960478450592, 76.975),
            (2.148589899188737, -5.793027042157009, 82.8125),
            (1.8098150942723705, -6.405261990158083, 83.075),
            (-2.966238202582682, -7.1729304769412625, 73.1375),
            (-3.742308502273002, -2.1570242886300637, 63.75),
            (3.2825396946378054, -7.314262678539819, 87.5),
            (2.6305967471291294, -2.414082029503123, 75.2375),
        ];
        for (x, y, height) in expected {
            assert!(
                (h.height_at(x, y) - height).abs() < 1e-9,
                "({x}, {y}): {} against {height}",
                h.height_at(x, y)
            );
        }
        // Two points of the reference's lie more than half a sample outside the lattice
        assert!(h.height_at(4.029604872755765, -4.6464745273472285).is_nan());
        assert!(h
            .height_at(-4.0474760555608045, -3.728670802455719)
            .is_nan());
    }
}
