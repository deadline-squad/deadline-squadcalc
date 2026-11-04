//! The heightmap: a grid of 16-bit samples (G16) of the terrain, sampled the way the game's landscape
//! collision is, as in `getHeight` of SquadCalc's `src/js/squadHeightmaps.js`.
//!
//! World frame of the engine: X east, Y north, Z up, in metres. Sample `(row, col)` lies at
//! `X = origin_x + col * resolution`, `Y = origin_y - row * resolution`, so row 0 is the northern edge (SquadCalc's
//! `row = -lat`, `col = lng`). The height of a sample is `Z = (v / 65535 * 2 - 1) * z_scale`.

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
}

impl fmt::Display for HeightmapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HeightmapError::Size { expected, found } => {
                write!(f, "heightmap buffer has {found} samples, expected {expected}")
            }
            HeightmapError::TooSmall => write!(f, "heightmap needs at least 2 x 2 samples"),
            HeightmapError::Png(reason) => write!(f, "heightmap PNG: {reason}"),
        }
    }
}

impl std::error::Error for HeightmapError {}

/// A G16 heightmap and the transform from its samples to metres.
#[derive(Debug, Clone)]
pub struct Heightmap {
    width: usize,
    height: usize,
    levels: Vec<u16>,
    /// Half of the full height range of the map, metres (`Z = (v / 65535 * 2 - 1) * z_scale`).
    pub z_scale: f64,
    /// Metres between two samples (1 on most maps, 0.5 on Chora and Kokan).
    pub resolution: f64,
    /// World X of column 0, metres.
    pub origin_x: f64,
    /// World Y of row 0, metres.
    pub origin_y: f64,
}

impl Heightmap {
    /// A heightmap from `width * height` samples, row 0 first.
    ///
    /// # Errors
    /// [`HeightmapError::TooSmall`] below 2 x 2 samples, [`HeightmapError::Size`] if `levels` does not
    /// have `width * height` entries.
    pub fn new(
        width: usize,
        height: usize,
        levels: Vec<u16>,
        z_scale: f64,
        resolution: f64,
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
        Ok(Heightmap {
            width,
            height,
            levels,
            z_scale,
            resolution,
            origin_x: 0.0,
            origin_y: 0.0,
        })
    }

    /// A heightmap from the raw `.g16` format: `u32` width, `u32` height (little endian), then the samples
    /// as little-endian `u16`, row 0 first.
    ///
    /// # Errors
    /// As [`Heightmap::new`]; also [`HeightmapError::Size`] if the header is missing.
    pub fn from_g16(bytes: &[u8], z_scale: f64, resolution: f64) -> Result<Self, HeightmapError> {
        let header: [u8; 8] = bytes
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

    /// A heightmap from a 16-bit grayscale PNG (the format of the site's `heightmap.png`).
    ///
    /// # Errors
    /// [`HeightmapError::Png`] if the file is not a decodable 16-bit grayscale PNG.
    pub fn from_png(bytes: &[u8], z_scale: f64, resolution: f64) -> Result<Self, HeightmapError> {
        let png_error = |e: png::DecodingError| HeightmapError::Png(e.to_string());
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .map_err(png_error)?;
        let info = reader.info();
        if info.color_type != png::ColorType::Grayscale || info.bit_depth != png::BitDepth::Sixteen {
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

    /// Columns of the grid.
    pub fn width(&self) -> usize {
        self.width
    }

    /// Rows of the grid.
    pub fn height(&self) -> usize {
        self.height
    }

    /// Height at world `(x, y)` on the game's collision surface: every quad of four samples is two triangles
    /// split along the diagonal from its `(row, col)` corner to its `(row + 1, col + 1)` corner, and the
    /// height is interpolated on the triangle the point is in. Returns 0 more than half a sample outside the
    /// grid (the edge sample within half a sample).
    pub fn height_at(&self, x: f64, y: f64) -> f64 {
        self.height_at_scaled(x, y, self.z_scale)
    }

    /// As [`Heightmap::height_at`] with another `z_scale` (the one of a request's environment).
    pub fn height_at_scaled(&self, x: f64, y: f64, z_scale: f64) -> f64 {
        let rows = self.height;
        let cols = self.width;
        let mut row = (self.origin_y - y) / self.resolution;
        let mut col = (x - self.origin_x) / self.resolution;
        if !(row >= -0.5 && row <= rows as f64 - 0.5 && col >= -0.5 && col <= cols as f64 - 0.5) {
            return 0.0;
        }
        row = row.clamp(0.0, (rows - 1) as f64);
        col = col.clamp(0.0, (cols - 1) as f64);

        let row0 = (row.floor() as usize).min(rows - 2);
        let col0 = (col.floor() as usize).min(cols - 2);
        let row_weight = row - row0 as f64;
        let col_weight = col - col0 as f64;
        let at = |r: usize, c: usize| f64::from(self.levels[r * cols + c]);
        let corner = at(row0, col0);
        let level = if col_weight >= row_weight {
            corner
                + (at(row0, col0 + 1) - corner) * col_weight
                + (at(row0 + 1, col0 + 1) - at(row0, col0 + 1)) * row_weight
        } else {
            corner
                + (at(row0 + 1, col0) - corner) * row_weight
                + (at(row0 + 1, col0 + 1) - at(row0 + 1, col0)) * col_weight
        };
        (level / 65535.0 * 2.0 - 1.0) * z_scale
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(levels: [u16; 4]) -> Heightmap {
        Heightmap::new(2, 2, levels.to_vec(), 100.0, 1.0).unwrap()
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
    fn outside_the_grid_is_zero_and_the_edge_holds_half_a_sample() {
        let h = map([65535; 4]);
        assert_eq!(h.height_at(5.0, 0.0), 0.0);
        assert!((h.height_at(1.4, 0.0) - 100.0).abs() < 1e-9);
        assert_eq!(h.height_at(1.6, 0.0), 0.0);
    }

    #[test]
    fn rejects_a_wrong_buffer_size() {
        assert!(matches!(
            Heightmap::new(2, 2, vec![0; 3], 1.0, 1.0),
            Err(HeightmapError::Size { .. })
        ));
        assert!(matches!(
            Heightmap::new(1, 2, vec![0; 2], 1.0, 1.0),
            Err(HeightmapError::TooSmall)
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
}
