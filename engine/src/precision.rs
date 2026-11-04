//! Precision pass: the voxel columns decide the segments that stay away from geometry, the exact triangles of one
//! region decide the rest.
//!
//! A voxel is marked when a triangle meets it, so the voxel walk of [`crate::voxel`] blocks segments that pass up
//! to a voxel diagonal from a surface (most of its errors) and misses hits in voxels the builder's sampling lost.
//! A [`PrecisionRegion`] fixes this around one target: the part of a segment inside the region's square is
//! re-checked against the region's triangles whenever it comes within `margin` of an occupied voxel (it meets
//! the voxels grown by the margin, see [`VoxelColumns::dilated`]); a part that stays farther away is clear, and the
//! parts outside the square are answered by the plain voxel walk. The triangles come from a [`RegionFile`], built
//! offline by `tools/volumetric/py/build_region.py` from the same `world_tris.py` triangles as the voxels.
//!
//! No penetration is modelled: the answer is the first thing the segment meets, voxel or triangle.

use crate::bvh::{BuildOptions, BvhError, BvhSet, Triangle, MAX_TRIANGLES};
use crate::path::Segment;
use crate::trace::Scene;
use crate::voxel::{VoxelColumns, VoxelHit};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};

const MAGIC: &[u8; 8] = b"RTRI1\0\0\0";
const HEADER_LEN: usize = 48;

/// Metres per unit of the stored vertex coordinates (0.1 mm: about one `f32` ulp at 1 km).
pub const QUANT: f64 = 1e-4;

/// Why a region file cannot be used.
#[derive(Debug, PartialEq, Eq)]
pub enum RegionError {
    /// The bytes are not an `RTRI1` file (wrong magic).
    NotRegion,
    /// The gzip layer is damaged.
    Gzip(String),
    /// The file ends inside a header or a varint.
    Truncated,
    /// A value is out of range (message).
    Invalid(&'static str),
    /// The triangles cannot form a hierarchy.
    Bvh(String),
}

impl fmt::Display for RegionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegionError::NotRegion => write!(f, "not an RTRI1 file"),
            RegionError::Gzip(e) => write!(f, "bad gzip data: {e}"),
            RegionError::Truncated => write!(f, "RTRI1 data ends too early"),
            RegionError::Invalid(m) => write!(f, "invalid RTRI1 data: {m}"),
            RegionError::Bvh(e) => write!(f, "region triangles: {e}"),
        }
    }
}

impl std::error::Error for RegionError {}

impl From<BvhError> for RegionError {
    fn from(error: BvhError) -> Self {
        RegionError::Bvh(error.to_string())
    }
}

/// The contents of an `RTRI1` file: the square of a region and the triangles that matter inside it.
///
/// Layout, before gzip (little endian): the magic `RTRI1\0\0\0`, `f32` `min_x, min_y, max_x, max_y` of the square,
/// `f32` margin (metres, the one the triangles were selected with), `f32` origin `x, y, z`, `u32` vertex count,
/// `u32` triangle count; then per vertex three zigzag varints, the difference to the previous vertex in units of
/// [`QUANT`] of its position relative to the origin; then per triangle three zigzag varints, the difference of
/// the vertex index to the previously written index (0 before the first). The frame is that of the voxel file.
#[derive(Debug, Clone, PartialEq)]
pub struct RegionFile {
    /// `[min_x, min_y, max_x, max_y]`, metres.
    pub bounds: [f64; 4],
    /// Distance from an occupied voxel within which a segment is re-checked, metres.
    pub margin: f64,
    /// The collision triangles of the region.
    pub triangles: Vec<Triangle>,
}

fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value & 0x7F) as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn varint(&mut self) -> Result<u64, RegionError> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.bytes.get(self.pos).ok_or(RegionError::Truncated)?;
            self.pos += 1;
            value |= u64::from(byte & 0x7F) << shift;
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err(RegionError::Invalid("varint longer than 64 bits"))
    }

    fn signed(&mut self) -> Result<i64, RegionError> {
        let value = self.varint()?;
        Ok((value >> 1) as i64 ^ -((value & 1) as i64))
    }

    fn f32_at(&self, offset: usize) -> f64 {
        f64::from(f32::from_le_bytes(
            self.bytes[offset..offset + 4].try_into().unwrap(),
        ))
    }

    fn u32_at(&self, offset: usize) -> u32 {
        u32::from_le_bytes(self.bytes[offset..offset + 4].try_into().unwrap())
    }
}

impl RegionFile {
    /// Decodes an `RTRI1` file, gzip or already decompressed.
    ///
    /// # Errors
    /// [`RegionError`] for a wrong magic, damaged gzip, truncated data or an index outside the vertex list.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, RegionError> {
        if bytes.starts_with(&[0x1F, 0x8B]) {
            let mut raw = Vec::new();
            GzDecoder::new(bytes)
                .read_to_end(&mut raw)
                .map_err(|e| RegionError::Gzip(e.to_string()))?;
            return Self::from_raw(&raw);
        }
        Self::from_raw(bytes)
    }

    fn from_raw(bytes: &[u8]) -> Result<Self, RegionError> {
        if bytes.len() < HEADER_LEN || &bytes[..8] != MAGIC {
            return Err(RegionError::NotRegion);
        }
        let mut reader = Reader {
            bytes,
            pos: HEADER_LEN,
        };
        let bounds = [8, 12, 16, 20].map(|offset| reader.f32_at(offset));
        let margin = reader.f32_at(24);
        let origin = [28, 32, 36].map(|offset| reader.f32_at(offset));
        let (vertex_count, triangle_count) =
            (reader.u32_at(40) as usize, reader.u32_at(44) as usize);
        if !(bounds[0] <= bounds[2] && bounds[1] <= bounds[3] && margin >= 0.0) {
            return Err(RegionError::Invalid("square or margin"));
        }
        // Every value takes at least one byte: a plausibility bound before allocating
        let remaining = bytes.len() - HEADER_LEN;
        if vertex_count > remaining || triangle_count > remaining {
            return Err(RegionError::Truncated);
        }
        let mut vertices: Vec<[f32; 3]> = Vec::with_capacity(vertex_count);
        let mut previous = [0i64; 3];
        for _ in 0..vertex_count {
            let mut vertex = [0.0f32; 3];
            for axis in 0..3 {
                previous[axis] += reader.signed()?;
                vertex[axis] = (origin[axis] + previous[axis] as f64 * QUANT) as f32;
            }
            vertices.push(vertex);
        }
        let mut triangles = Vec::with_capacity(triangle_count);
        let mut index = 0i64;
        for _ in 0..triangle_count {
            let mut triangle = [[0.0f32; 3]; 3];
            for corner in &mut triangle {
                index += reader.signed()?;
                *corner = *usize::try_from(index)
                    .ok()
                    .and_then(|i| vertices.get(i))
                    .ok_or(RegionError::Invalid("vertex index out of range"))?;
            }
            triangles.push(triangle);
        }
        Ok(RegionFile {
            bounds,
            margin,
            triangles,
        })
    }

    /// The gzip bytes of the file (the reference writer; `tools/volumetric/py/build_region.py` writes the same
    /// layout). Vertices are quantised to [`QUANT`] relative to the square's centre and the lowest `z`, shared
    /// between triangles where they agree after quantisation, and numbered in the order of first use.
    pub fn to_bytes(&self) -> Vec<u8> {
        let origin = [
            ((self.bounds[0] + self.bounds[2]) / 2.0) as f32,
            ((self.bounds[1] + self.bounds[3]) / 2.0) as f32,
            self.triangles
                .iter()
                .flatten()
                .map(|v| v[2])
                .fold(f32::INFINITY, f32::min)
                .min(f32::MAX),
        ];
        let mut numbering: HashMap<[i64; 3], i64> = HashMap::new();
        let mut vertices: Vec<[i64; 3]> = Vec::new();
        let mut indices: Vec<i64> = Vec::with_capacity(self.triangles.len() * 3);
        for corner in self.triangles.iter().flatten() {
            let key = [0, 1, 2].map(|axis| {
                ((f64::from(corner[axis]) - f64::from(origin[axis])) / QUANT).round() as i64
            });
            let next = vertices.len() as i64;
            let index = *numbering.entry(key).or_insert_with(|| {
                vertices.push(key);
                next
            });
            indices.push(index);
        }
        let mut raw = Vec::new();
        raw.extend_from_slice(MAGIC);
        for value in self.bounds.iter().chain([&self.margin]) {
            raw.extend_from_slice(&(*value as f32).to_le_bytes());
        }
        for value in origin {
            raw.extend_from_slice(&value.to_le_bytes());
        }
        raw.extend_from_slice(&(vertices.len() as u32).to_le_bytes());
        raw.extend_from_slice(&(self.triangles.len() as u32).to_le_bytes());
        let mut previous = [0i64; 3];
        for vertex in &vertices {
            for axis in 0..3 {
                push_varint(&mut raw, zigzag(vertex[axis] - previous[axis]));
            }
            previous = *vertex;
        }
        let mut last = 0i64;
        for index in indices {
            push_varint(&mut raw, zigzag(index - last));
            last = index;
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(&raw).expect("writing to a Vec");
        encoder.finish().expect("writing to a Vec")
    }
}

/// What a segment met in the precision pass.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HitKind {
    /// An occupied voxel in a part of the segment that lies outside the region's square; `t` is relative to the
    /// whole segment.
    Voxel(VoxelHit),
    /// A triangle of the region, by its index in leaf order of the region's hierarchy.
    Triangle(u32),
}

/// The first obstacle on a segment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrecisionHit {
    /// Position along the whole segment, `0..=1`.
    pub t: f64,
    /// What was met.
    pub kind: HitKind,
}

/// The answer for one segment and whether the exact pass was needed for it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Query {
    /// The first obstacle, or `None` when the segment is clear.
    pub hit: Option<PrecisionHit>,
    /// Whether a part of the segment inside the square came within the margin of a voxel and was tested against
    /// the region's triangles.
    pub rechecked: bool,
}

/// Where a trajectory first meets an obstacle in the precision pass.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrecisionPathHit {
    /// Index of the segment of the trajectory.
    pub segment: usize,
    /// The obstacle.
    pub hit: PrecisionHit,
    /// The point, metres.
    pub point: [f64; 3],
    /// Time of flight at the point, seconds.
    pub time: f64,
}

/// The exact triangles around one target, with the grown voxels that select the segments to re-check.
#[derive(Debug)]
pub struct PrecisionRegion {
    bounds: [f64; 4],
    margin: f64,
    near: VoxelColumns,
    triangles: BvhSet,
}

fn along(p0: [f64; 3], p1: [f64; 3], t: f64) -> [f64; 3] {
    [0, 1, 2].map(|axis| p0[axis] + t * (p1[axis] - p0[axis]))
}

impl PrecisionRegion {
    /// Builds the region of the square `bounds` (`[min_x, min_y, max_x, max_y]`, the frame of `columns`): the
    /// triangles' hierarchy, and the voxels of `columns` in the square grown by `margin` metres.
    ///
    /// # Errors
    /// [`RegionError::Bvh`] if a triangle has a vertex that is not finite.
    pub fn new(
        columns: &VoxelColumns,
        bounds: [f64; 4],
        margin: f64,
        triangles: Vec<Triangle>,
    ) -> Result<Self, RegionError> {
        Ok(PrecisionRegion {
            bounds,
            margin,
            near: columns.dilated(bounds, margin),
            triangles: BvhSet::build(triangles, MAX_TRIANGLES, BuildOptions::default())?,
        })
    }

    /// The region of a decoded file, for the voxel columns it was built against.
    ///
    /// # Errors
    /// As [`PrecisionRegion::new`].
    pub fn from_file(columns: &VoxelColumns, file: RegionFile) -> Result<Self, RegionError> {
        Self::new(columns, file.bounds, file.margin, file.triangles)
    }

    /// `[min_x, min_y, max_x, max_y]` of the square the exact pass covers.
    pub fn bounds(&self) -> [f64; 4] {
        self.bounds
    }

    /// The margin the segments are re-checked within, metres (before rounding up to whole voxels).
    pub fn margin(&self) -> f64 {
        self.margin
    }

    /// Number of triangles in the region.
    pub fn triangle_count(&self) -> usize {
        self.triangles.triangle_count()
    }

    /// The part `[t_in, t_out]` of the segment inside the square, if any.
    fn inside(&self, p0: [f64; 3], p1: [f64; 3]) -> Option<(f64, f64)> {
        let (mut t_in, mut t_out) = (0.0f64, 1.0f64);
        for axis in 0..2 {
            let (low, high) = (self.bounds[axis], self.bounds[axis + 2]);
            let delta = p1[axis] - p0[axis];
            if delta == 0.0 {
                if p0[axis] < low || p0[axis] > high {
                    return None;
                }
                continue;
            }
            let (a, b) = ((low - p0[axis]) / delta, (high - p0[axis]) / delta);
            t_in = t_in.max(a.min(b));
            t_out = t_out.min(a.max(b));
        }
        (t_in <= t_out).then_some((t_in, t_out))
    }

    /// Answers the segment `p0 -> p1`: the voxel walk of `columns` (the columns the region was built against)
    /// for the parts outside the square; inside it, the part that meets the grown voxels is tested against the
    /// triangles and any other part is clear.
    pub fn query(&self, columns: &VoxelColumns, p0: [f64; 3], p1: [f64; 3]) -> Query {
        let voxel_part = |from: f64, to: f64| {
            let hit = columns.first_block(along(p0, p1, from), along(p0, p1, to))?;
            Some(PrecisionHit {
                t: from + hit.t * (to - from),
                kind: HitKind::Voxel(VoxelHit {
                    t: from + hit.t * (to - from),
                    ..hit
                }),
            })
        };
        let Some((t_in, t_out)) = self.inside(p0, p1) else {
            return Query {
                hit: voxel_part(0.0, 1.0),
                rechecked: false,
            };
        };
        if t_in > 0.0 {
            if let hit @ Some(_) = voxel_part(0.0, t_in) {
                return Query {
                    hit,
                    rechecked: false,
                };
            }
        }
        let (a, b) = (along(p0, p1, t_in), along(p0, p1, t_out));
        let rechecked = self.near.first_block(a, b).is_some();
        if rechecked {
            if let Some(hit) = self.triangles.first_hit(a, b) {
                return Query {
                    hit: Some(PrecisionHit {
                        t: t_in + hit.t * (t_out - t_in),
                        kind: HitKind::Triangle(hit.triangle),
                    }),
                    rechecked,
                };
            }
        }
        Query {
            hit: if t_out < 1.0 {
                voxel_part(t_out, 1.0)
            } else {
                None
            },
            rechecked,
        }
    }

    /// The first obstacle on the segment, or `None` if it is clear; see [`PrecisionRegion::query`].
    pub fn first_block(
        &self,
        columns: &VoxelColumns,
        p0: [f64; 3],
        p1: [f64; 3],
    ) -> Option<PrecisionHit> {
        self.query(columns, p0, p1).hit
    }

    /// Answers many independent segments; on several threads with the `threads` feature.
    pub fn queries(&self, columns: &VoxelColumns, segments: &[([f64; 3], [f64; 3])]) -> Vec<Query> {
        crate::bvh::map_parallel(segments, |(p0, p1)| self.query(columns, *p0, *p1))
    }

    /// Line-of-fire query: the first obstacle the trajectory (its segments, in flight order) meets, or `None`.
    pub fn first_block_along(
        &self,
        columns: &VoxelColumns,
        segments: &[Segment],
    ) -> Option<PrecisionPathHit> {
        segments.iter().enumerate().find_map(|(index, segment)| {
            let hit = self.first_block(columns, segment.p0, segment.p1)?;
            Some(PrecisionPathHit {
                segment: index,
                hit,
                point: along(segment.p0, segment.p1, hit.t),
                time: segment.t0 + hit.t * (segment.t1 - segment.t0),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cell 0.5, dz 0.25, origin (0, 0, 0): voxel `(c, r, z)` is `[c/2, c/2 + 0.5) x [r/2, ..) x [z/4, ..)`.
    fn columns(voxels: &[(u32, u32, u32)]) -> VoxelColumns {
        VoxelColumns::from_voxels([0.0; 3], 0.5, 0.25, 400, 400, voxels).unwrap()
    }

    /// Two triangles filling the rectangle `x0..x1` at height `z` and `y` from `y0` to `y1`: a floor patch.
    fn patch(x0: f32, x1: f32, y0: f32, y1: f32, z: f32) -> Vec<Triangle> {
        vec![
            [[x0, y0, z], [x1, y0, z], [x1, y1, z]],
            [[x0, y0, z], [x1, y1, z], [x0, y1, z]],
        ]
    }

    /// A wall in the plane `y = y` spanning `x0..x1` and `z0..z1`.
    fn wall(x0: f32, x1: f32, y: f32, z0: f32, z1: f32) -> Vec<Triangle> {
        vec![
            [[x0, y, z0], [x1, y, z0], [x1, y, z1]],
            [[x0, y, z0], [x1, y, z1], [x0, y, z1]],
        ]
    }

    const SQUARE: [f64; 4] = [40.0, 40.0, 60.0, 60.0];

    /// A wall at y = 50.1 m whose voxel row 100 (y 50.0..50.5) is marked, plus the marked voxels behind it that the
    /// builder's sampling would also mark (row 100 only).
    fn wall_scene() -> (VoxelColumns, Vec<Triangle>) {
        let voxels: Vec<_> = (80..120)
            .flat_map(|c| (0..40).map(move |z| (c, 100, z)))
            .collect();
        (columns(&voxels), wall(40.0, 60.0, 50.1, 0.0, 10.0))
    }

    #[test]
    fn a_segment_in_a_marked_voxel_that_the_triangles_do_not_touch_is_clear() {
        let (voxels, triangles) = wall_scene();
        let region = PrecisionRegion::new(&voxels, SQUARE, 0.6, triangles).unwrap();
        // Runs along the wall at y = 50.4: inside the marked voxel row, 0.3 m from the wall
        let (p0, p1) = ([41.0, 50.4, 2.0], [59.0, 50.4, 2.0]);
        assert!(
            voxels.first_block(p0, p1).is_some(),
            "the voxels alone block it"
        );
        let answer = region.query(&voxels, p0, p1);
        assert_eq!(answer.hit, None);
        assert!(answer.rechecked);
    }

    #[test]
    fn a_segment_through_the_wall_hits_the_triangle_at_its_exact_position() {
        let (voxels, triangles) = wall_scene();
        let region = PrecisionRegion::new(&voxels, SQUARE, 0.6, triangles).unwrap();
        let hit = region
            .first_block(&voxels, [50.0, 45.0, 2.0], [50.0, 55.0, 2.0])
            .unwrap();
        assert!((hit.t - 0.51).abs() < 1e-6, "{hit:?}");
        assert!(matches!(hit.kind, HitKind::Triangle(_)));
    }

    #[test]
    fn a_hit_in_a_voxel_the_file_lacks_is_found_when_a_neighbour_is_marked() {
        // The wall's voxel (row 100) is missing, the one beside it (row 99) is marked: false clear for the voxels
        let voxels = columns(
            &(80..120)
                .flat_map(|c| (0..40).map(move |z| (c, 99, z)))
                .collect::<Vec<_>>(),
        );
        let region =
            PrecisionRegion::new(&voxels, SQUARE, 0.6, wall(40.0, 60.0, 50.1, 0.0, 10.0)).unwrap();
        let (p0, p1) = ([50.0, 45.0, 2.0], [50.0, 55.0, 2.0]);
        assert!(
            voxels.first_block(p0, p1).is_some(),
            "row 99 is crossed first"
        );
        let region_far = PrecisionRegion::new(&voxels, SQUARE, 0.6, Vec::new()).unwrap();
        assert_eq!(region_far.first_block(&voxels, p0, p1), None);
        let hit = region.first_block(&voxels, p0, p1).unwrap();
        assert!((hit.t - 0.51).abs() < 1e-6);
    }

    #[test]
    fn a_segment_far_from_every_voxel_is_not_rechecked() {
        let (voxels, triangles) = wall_scene();
        let region = PrecisionRegion::new(&voxels, SQUARE, 0.6, triangles).unwrap();
        let answer = region.query(&voxels, [41.0, 42.0, 2.0], [59.0, 42.0, 2.0]);
        assert_eq!(
            answer,
            Query {
                hit: None,
                rechecked: false
            }
        );
    }

    #[test]
    fn the_margin_decides_which_segments_are_rechecked() {
        let (voxels, triangles) = wall_scene();
        // 0.75 m from the marked row (row 100 starts at y = 50.0): 49.25
        let (p0, p1) = ([41.0, 49.25, 2.0], [59.0, 49.25, 2.0]);
        let wide = PrecisionRegion::new(&voxels, SQUARE, 0.6, triangles.clone()).unwrap();
        let narrow = PrecisionRegion::new(&voxels, SQUARE, 0.2, triangles).unwrap();
        assert!(wide.query(&voxels, p0, p1).rechecked);
        assert!(!narrow.query(&voxels, p0, p1).rechecked);
    }

    #[test]
    fn outside_the_square_the_voxels_decide() {
        let (voxels, _) = wall_scene();
        let elsewhere = [140.0, 140.0, 160.0, 160.0];
        let region = PrecisionRegion::new(&voxels, elsewhere, 0.6, Vec::new()).unwrap();
        let (p0, p1) = ([50.0, 45.0, 2.0], [50.0, 55.0, 2.0]);
        assert_eq!(
            region.first_block(&voxels, p0, p1),
            voxels.first_block(p0, p1).map(|v| PrecisionHit {
                t: v.t,
                kind: HitKind::Voxel(v)
            })
        );
        assert!(!region.query(&voxels, p0, p1).rechecked);
    }

    #[test]
    fn a_segment_that_enters_the_square_is_blocked_by_voxels_before_it() {
        // A marked voxel at x 30 (outside the square), then the exact pass would find nothing
        let voxels = columns(&[(60, 100, 8)]);
        let region = PrecisionRegion::new(&voxels, SQUARE, 0.6, Vec::new()).unwrap();
        let hit = region
            .first_block(&voxels, [20.0, 50.25, 2.125], [80.0, 50.25, 2.125])
            .unwrap();
        assert!((hit.t - 10.0 / 60.0).abs() < 1e-9);
        assert!(
            matches!(hit.kind, HitKind::Voxel(v) if v.column == 60 && (v.t - hit.t).abs() < 1e-12)
        );
    }

    #[test]
    fn a_segment_leaving_the_square_is_blocked_by_voxels_after_it() {
        let voxels = columns(&[(140, 100, 8)]);
        let region = PrecisionRegion::new(&voxels, SQUARE, 0.6, Vec::new()).unwrap();
        let hit = region
            .first_block(&voxels, [45.0, 50.25, 2.125], [100.0, 50.25, 2.125])
            .unwrap();
        assert!((hit.t - 25.0 / 55.0).abs() < 1e-9);
        assert!(matches!(hit.kind, HitKind::Voxel(v) if v.column == 140));
    }

    #[test]
    fn a_floor_patch_is_hit_from_above_and_missed_beside() {
        let voxels = columns(
            &(90..110)
                .flat_map(|c| (90..110).map(move |r| (c, r, 4)))
                .collect::<Vec<_>>(),
        );
        let region =
            PrecisionRegion::new(&voxels, SQUARE, 0.6, patch(45.0, 55.0, 45.0, 55.0, 1.1)).unwrap();
        let hit = region
            .first_block(&voxels, [50.0, 50.0, 5.0], [50.0, 50.0, -3.0])
            .unwrap();
        assert!((hit.t - 3.9 / 8.0).abs() < 1e-6);
        assert_eq!(
            region.first_block(&voxels, [57.0, 50.0, 5.0], [57.0, 50.0, -3.0]),
            None
        );
    }

    #[test]
    fn a_trajectory_reports_the_segment_the_point_and_the_time() {
        let (voxels, triangles) = wall_scene();
        let region = PrecisionRegion::new(&voxels, SQUARE, 0.6, triangles).unwrap();
        let path = [
            Segment {
                p0: [50.0, 30.0, 2.0],
                p1: [50.0, 45.0, 2.0],
                t0: 0.0,
                t1: 1.5,
            },
            Segment {
                p0: [50.0, 45.0, 2.0],
                p1: [50.0, 55.0, 2.0],
                t0: 1.5,
                t1: 2.5,
            },
        ];
        let hit = region.first_block_along(&voxels, &path).unwrap();
        assert_eq!(hit.segment, 1);
        assert!((hit.point[1] - 50.1).abs() < 1e-5);
        assert!((hit.time - 2.01).abs() < 1e-5);
    }

    #[test]
    fn a_file_round_trips_within_the_quantisation() {
        let file = RegionFile {
            bounds: [-404.5, 120.25, -254.5, 270.25],
            margin: 0.6f32 as f64,
            triangles: [
                wall(-300.0, -290.123, 200.0, 3.25, 9.5),
                patch(-310.0, -300.0, 210.0, 215.5, 4.0),
            ]
            .concat(),
        };
        let bytes = file.to_bytes();
        let back = RegionFile::from_bytes(&bytes).unwrap();
        assert_eq!(back.bounds, file.bounds);
        assert_eq!(back.margin, file.margin);
        assert_eq!(back.triangles.len(), 4);
        for (a, b) in back
            .triangles
            .iter()
            .flatten()
            .zip(file.triangles.iter().flatten())
        {
            for axis in 0..3 {
                assert!((f64::from(a[axis]) - f64::from(b[axis])).abs() <= QUANT / 2.0 + 1e-4);
            }
        }
        // Shared corners are stored once: 4 + 4 distinct corners of 2 + 2 triangles
        let raw = {
            let mut raw = Vec::new();
            GzDecoder::new(&bytes[..]).read_to_end(&mut raw).unwrap();
            raw
        };
        assert_eq!(u32::from_le_bytes(raw[40..44].try_into().unwrap()), 8);
        // A decompressed file is accepted too
        assert_eq!(RegionFile::from_bytes(&raw).unwrap(), back);
    }

    #[test]
    fn damaged_files_are_errors_not_panics() {
        let good = RegionFile {
            bounds: [0.0, 0.0, 10.0, 10.0],
            margin: 0.6f32 as f64,
            triangles: patch(1.0, 2.0, 1.0, 2.0, 0.0),
        }
        .to_bytes();
        let mut raw = Vec::new();
        GzDecoder::new(&good[..]).read_to_end(&mut raw).unwrap();
        assert_eq!(
            RegionFile::from_bytes(b"nonsense"),
            Err(RegionError::NotRegion)
        );
        assert_eq!(
            RegionFile::from_bytes(&raw[..raw.len() - 2]),
            Err(RegionError::Truncated)
        );
        let mut wrong_index = raw.clone();
        *wrong_index.last_mut().unwrap() = 0x7E;
        assert!(RegionFile::from_bytes(&wrong_index).is_err());
        let mut absurd_count = raw.clone();
        absurd_count[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            RegionFile::from_bytes(&absurd_count),
            Err(RegionError::Truncated)
        );
        assert!(matches!(
            RegionFile::from_bytes(&good[..good.len() / 2]),
            Err(RegionError::Gzip(_) | RegionError::Truncated)
        ));
    }
}
