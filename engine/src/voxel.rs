//! Sparse voxel columns (the `VCOL1` file of `tools/volumetric/py/codec.py`) and the segment query on them.
//!
//! A map is a grid of `width x height` columns of `cell` metres; a column holds runs of occupied voxels of
//! `dz` metres, counted from `z_min`. Voxel `(column, row, z)` is the half-open box
//! `[min_x + column * cell, min_x + (column + 1) * cell) x [min_y + row * cell, ..) x [z_min + z * dz, ..)`,
//! as in `columns.Grid.keys` of the builder. Positions are in the frame the file was built in (the Unreal
//! frame of the game files: metres, X east, Y south, Z up); a caller that works in another frame converts
//! before it asks, as for the BVH.
//!
//! [`VoxelColumns::first_block`] walks a segment through the columns it crosses (an Amanatides-Woo 2D DDA over
//! `(column, row)`) and, inside each column, jumps straight to the first occupied voxel the segment's height
//! range reaches, so the cost is the number of columns crossed, not the number of voxels. It returns the first
//! voxel the segment enters (the entry point), or `None` when the segment is clear. Every voxel the segment
//! touches is seen, unlike the sampled walk of `tools/volumetric/py/models.py`, which can step over a corner.
//! `engine/wgsl/voxel.wgsl` implements the same walk in `f32`.

use crate::path::Segment;
use flate2::read::GzDecoder;
use std::fmt;
use std::io::Read;

/// Bits of the voxel height index in the builder's keys; a column holds at most `1 << Z_BITS` voxels.
pub const Z_BITS: u32 = 12;

/// Number of height indices of a column.
pub const Z_COUNT: u32 = 1 << Z_BITS;

const MAGIC: &[u8; 8] = b"VCOL1\0\0\0";
const HEADER_LEN: usize = 40;

/// Why a `VCOL1` file cannot be used.
#[derive(Debug, PartialEq, Eq)]
pub enum VoxelError {
    /// The bytes are not a `VCOL1` file (wrong magic).
    NotVcol,
    /// The gzip layer is damaged.
    Gzip(String),
    /// The file ends inside a header, a varint or a column.
    Truncated,
    /// A value is out of range (message).
    Invalid(&'static str),
}

impl fmt::Display for VoxelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VoxelError::NotVcol => write!(f, "not a VCOL1 file"),
            VoxelError::Gzip(e) => write!(f, "bad gzip data: {e}"),
            VoxelError::Truncated => write!(f, "VCOL1 data ends too early"),
            VoxelError::Invalid(m) => write!(f, "invalid VCOL1 data: {m}"),
        }
    }
}

impl std::error::Error for VoxelError {}

/// The first occupied voxel a segment enters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VoxelHit {
    /// Column index along X (`floor((x - min_x) / cell)`).
    pub column: u32,
    /// Row index along Y (`floor((y - min_y) / cell)`).
    pub row: u32,
    /// Height index (`floor((z - z_min) / dz)`).
    pub z: u32,
    /// Position of the entry point along the segment, `0..=1` (0 when the segment starts inside the voxel).
    pub t: f64,
}

/// Where a trajectory first enters an occupied voxel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VoxelPathHit {
    /// Index of the segment of the trajectory.
    pub segment: usize,
    /// The voxel entered.
    pub hit: VoxelHit,
    /// The entry point, metres.
    pub point: [f64; 3],
    /// Time of flight at the entry point, seconds.
    pub time: f64,
}

/// The occupied voxels of a map as sorted columns of runs.
#[derive(Debug, Clone, PartialEq)]
pub struct VoxelColumns {
    min_x: f64,
    min_y: f64,
    cell: f64,
    dz: f64,
    z_min: f64,
    width: u32,
    height: u32,
    /// Ids (`row * width + column`) of the occupied columns, strictly increasing.
    ids: Vec<u32>,
    /// `first[i]..first[i + 1]` are the runs of column `ids[i]`; one entry more than `ids`.
    first: Vec<u32>,
    /// Runs as `[start, end)` height-index pairs, ascending and disjoint within a column.
    runs: Vec<u32>,
}

/// Cursor over the decompressed bytes of a file.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn varint(&mut self) -> Result<u64, VoxelError> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.bytes.get(self.pos).ok_or(VoxelError::Truncated)?;
            self.pos += 1;
            value |= u64::from(byte & 0x7F) << shift;
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err(VoxelError::Invalid("varint longer than 64 bits"))
    }

    fn u32_at(&self, offset: usize) -> u32 {
        u32::from_le_bytes(self.bytes[offset..offset + 4].try_into().unwrap())
    }

    fn f32_at(&self, offset: usize) -> f64 {
        f64::from(f32::from_le_bytes(
            self.bytes[offset..offset + 4].try_into().unwrap(),
        ))
    }
}

impl VoxelColumns {
    /// Decodes a `VCOL1` file, either as written by `codec.py` (gzip) or already decompressed (what a browser's
    /// `DecompressionStream` yields).
    ///
    /// # Errors
    /// [`VoxelError`] for a wrong magic, damaged gzip, truncated data or values outside the grid.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, VoxelError> {
        if bytes.starts_with(&[0x1F, 0x8B]) {
            let mut raw = Vec::new();
            GzDecoder::new(bytes)
                .read_to_end(&mut raw)
                .map_err(|e| VoxelError::Gzip(e.to_string()))?;
            return Self::from_raw(&raw);
        }
        Self::from_raw(bytes)
    }

    /// Decodes the decompressed layout documented in `codec.py`.
    fn from_raw(bytes: &[u8]) -> Result<Self, VoxelError> {
        if bytes.len() < HEADER_LEN || &bytes[..8] != MAGIC {
            return Err(VoxelError::NotVcol);
        }
        let mut reader = Reader {
            bytes,
            pos: HEADER_LEN,
        };
        let (width, height) = (reader.u32_at(28), reader.u32_at(32));
        let column_count = reader.u32_at(36) as usize;
        let cell = reader.f32_at(16);
        let dz = reader.f32_at(20);
        if !(cell > 0.0 && dz > 0.0) {
            return Err(VoxelError::Invalid("cell and dz must be positive"));
        }
        let grid_columns = u64::from(width) * u64::from(height);
        if grid_columns == 0 || grid_columns > u64::from(u32::MAX) {
            return Err(VoxelError::Invalid("grid size"));
        }
        // Every column takes at least 3 bytes: a plausibility bound before allocating
        if column_count > bytes.len() / 3 {
            return Err(VoxelError::Truncated);
        }
        let mut ids = Vec::with_capacity(column_count);
        let mut first = Vec::with_capacity(column_count + 1);
        let mut runs: Vec<u32> = Vec::new();
        let mut id = 0u64;
        for index in 0..column_count {
            let delta = reader.varint()?;
            if index > 0 && delta == 0 {
                return Err(VoxelError::Invalid("column ids must increase"));
            }
            id += delta;
            if id >= grid_columns {
                return Err(VoxelError::Invalid("column outside the grid"));
            }
            ids.push(id as u32);
            first.push((runs.len() / 2) as u32);
            let run_count = reader.varint()?;
            if run_count == 0 {
                return Err(VoxelError::Invalid("a column without runs"));
            }
            let mut end = 0u64;
            for _ in 0..run_count {
                let start = end + reader.varint()?;
                end = start + reader.varint()? + 1;
                if end > u64::from(Z_COUNT) {
                    return Err(VoxelError::Invalid("run above the height range"));
                }
                runs.extend([start as u32, end as u32]);
            }
        }
        first.push((runs.len() / 2) as u32);
        Ok(VoxelColumns {
            min_x: reader.f32_at(8),
            min_y: reader.f32_at(12),
            cell,
            dz,
            z_min: reader.f32_at(24),
            width,
            height,
            ids,
            first,
            runs,
        })
    }

    /// Builds the columns from an unsorted list of `(column, row, z)` voxels; duplicates are merged.
    ///
    /// # Errors
    /// [`VoxelError::Invalid`] for a voxel outside the `width x height x Z_COUNT` grid or a non-positive size.
    pub fn from_voxels(
        origin: [f64; 3],
        cell: f64,
        dz: f64,
        width: u32,
        height: u32,
        voxels: &[(u32, u32, u32)],
    ) -> Result<Self, VoxelError> {
        if !(cell > 0.0 && dz > 0.0 && width > 0 && height > 0) {
            return Err(VoxelError::Invalid("grid size"));
        }
        let mut keys = Vec::with_capacity(voxels.len());
        for &(column, row, z) in voxels {
            if column >= width || row >= height || z >= Z_COUNT {
                return Err(VoxelError::Invalid("voxel outside the grid"));
            }
            keys.push((u64::from(row) * u64::from(width) + u64::from(column), z));
        }
        keys.sort_unstable();
        keys.dedup();
        let mut ids = Vec::new();
        let mut first = Vec::new();
        let mut runs: Vec<u32> = Vec::new();
        let mut previous: Option<(u64, u32)> = None;
        for &(id, z) in &keys {
            match previous {
                Some((last_id, last_z)) if last_id == id && last_z + 1 == z => {
                    *runs.last_mut().unwrap() = z + 1;
                }
                Some((last_id, _)) if last_id == id => runs.extend([z, z + 1]),
                _ => {
                    ids.push(u32::try_from(id).map_err(|_| VoxelError::Invalid("grid size"))?);
                    first.push((runs.len() / 2) as u32);
                    runs.extend([z, z + 1]);
                }
            }
            previous = Some((id, z));
        }
        first.push((runs.len() / 2) as u32);
        Ok(VoxelColumns {
            min_x: origin[0],
            min_y: origin[1],
            cell,
            dz,
            z_min: origin[2],
            width,
            height,
            ids,
            first,
            runs,
        })
    }

    /// World coordinates (metres) of the grid's lowest corner: `min_x`, `min_y`, `z_min`.
    pub fn origin(&self) -> [f64; 3] {
        [self.min_x, self.min_y, self.z_min]
    }

    /// Horizontal edge of a voxel, metres.
    pub fn cell(&self) -> f64 {
        self.cell
    }

    /// Vertical edge of a voxel, metres.
    pub fn dz(&self) -> f64 {
        self.dz
    }

    /// Number of columns along X and rows along Y.
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Number of columns that hold at least one voxel.
    pub fn column_count(&self) -> usize {
        self.ids.len()
    }

    /// Number of occupied voxels.
    pub fn voxel_count(&self) -> u64 {
        self.runs
            .chunks_exact(2)
            .map(|run| u64::from(run[1] - run[0]))
            .sum()
    }

    /// The occupied columns as the GPU reads them: sorted ids, run offsets (one more than ids) and the
    /// `[start, end)` run pairs. See `engine/wgsl/voxel.wgsl`.
    pub fn gpu_arrays(&self) -> (&[u32], &[u32], &[u32]) {
        (&self.ids, &self.first, &self.runs)
    }

    /// Whether voxel `(column, row, z)` is occupied.
    pub fn is_occupied(&self, column: u32, row: u32, z: u32) -> bool {
        if column >= self.width || row >= self.height {
            return false;
        }
        let id = u64::from(row) * u64::from(self.width) + u64::from(column);
        self.column_runs(id)
            .is_some_and(|runs| runs.chunks_exact(2).any(|r| z >= r[0] && z < r[1]))
    }

    /// The `[start, end)` run pairs of column `id`, if it is occupied.
    fn column_runs(&self, id: u64) -> Option<&[u32]> {
        let index = self
            .ids
            .binary_search_by(|probe| u64::from(*probe).cmp(&id))
            .ok()?;
        Some(&self.runs[2 * self.first[index] as usize..2 * self.first[index + 1] as usize])
    }

    /// The first occupied voxel the segment `p0 -> p1` enters, or `None` if it is clear. Parts of the segment
    /// outside the grid are not blocked. A segment that starts inside an occupied voxel hits it at `t = 0`.
    pub fn first_block(&self, p0: [f64; 3], p1: [f64; 3]) -> Option<VoxelHit> {
        // Grid units: one unit is a cell horizontally and dz vertically, the origin is the grid's corner
        let origin = [
            (p0[0] - self.min_x) / self.cell,
            (p0[1] - self.min_y) / self.cell,
            (p0[2] - self.z_min) / self.dz,
        ];
        let delta = [
            (p1[0] - p0[0]) / self.cell,
            (p1[1] - p0[1]) / self.cell,
            (p1[2] - p0[2]) / self.dz,
        ];
        let extent = [
            f64::from(self.width),
            f64::from(self.height),
            f64::from(Z_COUNT),
        ];
        let (mut t_start, mut t_end) = (0.0f64, 1.0f64);
        for axis in 0..3 {
            if delta[axis] == 0.0 {
                if origin[axis] < 0.0 || origin[axis] >= extent[axis] {
                    return None;
                }
                continue;
            }
            let a = -origin[axis] / delta[axis];
            let b = (extent[axis] - origin[axis]) / delta[axis];
            t_start = t_start.max(a.min(b));
            t_end = t_end.min(a.max(b));
        }
        if t_start > t_end {
            return None;
        }

        let mut cell = [0i64; 2];
        let mut step = [0i64; 2];
        let mut t_next = [f64::INFINITY; 2];
        let mut t_step = [f64::INFINITY; 2];
        for axis in 0..2 {
            let at_start = origin[axis] + delta[axis] * t_start;
            cell[axis] = (at_start.floor() as i64).clamp(0, extent[axis] as i64 - 1);
            if delta[axis] != 0.0 {
                step[axis] = if delta[axis] > 0.0 { 1 } else { -1 };
                let boundary = if delta[axis] > 0.0 {
                    cell[axis] + 1
                } else {
                    cell[axis]
                };
                t_next[axis] = (boundary as f64 - origin[axis]) / delta[axis];
                t_step[axis] = 1.0 / delta[axis].abs();
            }
        }

        let mut t_in = t_start;
        loop {
            let t_out = t_next[0].min(t_next[1]).min(t_end);
            let id = cell[1] as u64 * u64::from(self.width) + cell[0] as u64;
            if let Some(runs) = self.column_runs(id) {
                if let Some((z, t)) = first_in_column(runs, origin[2], delta[2], t_in, t_out) {
                    return Some(VoxelHit {
                        column: cell[0] as u32,
                        row: cell[1] as u32,
                        z,
                        t,
                    });
                }
            }
            if t_out >= t_end {
                return None;
            }
            for axis in 0..2 {
                if t_next[axis] <= t_out {
                    cell[axis] += step[axis];
                    t_next[axis] += t_step[axis];
                    if cell[axis] < 0 || cell[axis] >= extent[axis] as i64 {
                        return None;
                    }
                }
            }
            t_in = t_out;
        }
    }

    /// Traces many independent segments; on several threads with the `threads` feature.
    pub fn first_blocks(&self, segments: &[([f64; 3], [f64; 3])]) -> Vec<Option<VoxelHit>> {
        crate::bvh::map_parallel(segments, |(p0, p1)| self.first_block(*p0, *p1))
    }

    /// Whether the segment meets an occupied voxel.
    pub fn blocked(&self, p0: [f64; 3], p1: [f64; 3]) -> bool {
        self.first_block(p0, p1).is_some()
    }

    /// Line-of-fire query: the first voxel the trajectory (its segments, in flight order) enters, or `None`.
    pub fn first_block_along(&self, segments: &[Segment]) -> Option<VoxelPathHit> {
        segments.iter().enumerate().find_map(|(index, segment)| {
            let hit = self.first_block(segment.p0, segment.p1)?;
            let point = [
                segment.p0[0] + hit.t * (segment.p1[0] - segment.p0[0]),
                segment.p0[1] + hit.t * (segment.p1[1] - segment.p0[1]),
                segment.p0[2] + hit.t * (segment.p1[2] - segment.p0[2]),
            ];
            Some(VoxelPathHit {
                segment: index,
                hit,
                point,
                time: segment.t0 + hit.t * (segment.t1 - segment.t0),
            })
        })
    }
}

/// The first voxel of a column's `runs` that the part `t_in..t_out` of a segment enters, with its entry `t`.
/// The segment's height in grid units is `z0 + dz * t`.
fn first_in_column(runs: &[u32], z0: f64, dz: f64, t_in: f64, t_out: f64) -> Option<(u32, f64)> {
    let top = f64::from(Z_COUNT - 1);
    let index = |t: f64| (z0 + dz * t).floor().clamp(0.0, top) as u32;
    let (at_in, at_out) = (index(t_in), index(t_out));
    let (low, high) = (at_in.min(at_out), at_in.max(at_out));
    let overlaps = |run: &&[u32]| run[1] > low && run[0] <= high;
    if dz >= 0.0 {
        let run = runs.chunks_exact(2).find(overlaps)?;
        let voxel = run[0].max(low);
        let t = if dz == 0.0 {
            t_in
        } else {
            ((f64::from(voxel) - z0) / dz).clamp(t_in, t_out)
        };
        Some((voxel, t))
    } else {
        let run = runs.chunks_exact(2).rev().find(overlaps)?;
        let voxel = (run[1] - 1).min(high);
        let t = ((f64::from(voxel) + 1.0 - z0) / dz).clamp(t_in, t_out);
        Some((voxel, t))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world(voxels: &[(u32, u32, u32)]) -> VoxelColumns {
        VoxelColumns::from_voxels([100.0, -50.0, -10.0], 0.5, 0.25, 40, 40, voxels).unwrap()
    }

    /// World position of the grid point `(column, row, z)` given in voxel units.
    fn at(c: f64, r: f64, z: f64) -> [f64; 3] {
        [100.0 + c * 0.5, -50.0 + r * 0.5, -10.0 + z * 0.25]
    }

    #[test]
    fn a_horizontal_segment_stops_at_the_face_of_the_first_voxel() {
        let map = world(&[(10, 5, 8), (14, 5, 8)]);
        let hit = map
            .first_block(at(2.3, 5.5, 8.5), at(30.3, 5.5, 8.5))
            .unwrap();
        assert_eq!((hit.column, hit.row, hit.z), (10, 5, 8));
        // The face is at x = 10 voxel units: (10 - 2.3) / 28
        assert!((hit.t - 7.7 / 28.0).abs() < 1e-12);
    }

    #[test]
    fn a_segment_above_or_beside_the_voxel_is_clear() {
        let map = world(&[(10, 5, 8)]);
        assert!(map
            .first_block(at(2.3, 5.5, 9.5), at(30.3, 5.5, 9.5))
            .is_none());
        assert!(map
            .first_block(at(2.3, 6.5, 8.5), at(30.3, 6.5, 8.5))
            .is_none());
        assert!(map
            .first_block(at(2.3, 5.5, 8.5), at(9.9, 5.5, 8.5))
            .is_none());
    }

    #[test]
    fn a_descending_segment_enters_a_roof_from_above() {
        // A deck of voxels at heights 20..=21 over one column
        let map = world(&[(10, 5, 20), (10, 5, 21)]);
        let hit = map
            .first_block(at(10.5, 5.5, 30.0), at(10.5, 5.5, 5.0))
            .unwrap();
        assert_eq!(hit.z, 21);
        // Enters the top face z = 22 voxel units: (30 - 22) / 25
        assert!((hit.t - 8.0 / 25.0).abs() < 1e-12);
    }

    #[test]
    fn an_ascending_segment_enters_a_ceiling_from_below() {
        let map = world(&[(10, 5, 20), (10, 5, 21)]);
        let hit = map
            .first_block(at(10.5, 5.5, 5.0), at(10.5, 5.5, 30.0))
            .unwrap();
        assert_eq!(hit.z, 20);
        assert!((hit.t - 15.0 / 25.0).abs() < 1e-12);
    }

    #[test]
    fn a_segment_passes_under_a_deck_and_meets_its_pillar() {
        // Deck at heights 20..=21 over columns 8..=12 of row 5, a pillar in column 10 below it
        let mut voxels: Vec<_> = (8..=12).flat_map(|c| [(c, 5, 20), (c, 5, 21)]).collect();
        voxels.extend((0..20).map(|z| (10, 5, z)));
        let map = world(&voxels);
        // Under the deck, one row beside the pillar: clear
        assert!(map
            .first_block(at(2.2, 6.5, 10.5), at(20.2, 6.5, 10.5))
            .is_none());
        // At the pillar's height along its row
        let hit = map
            .first_block(at(2.2, 5.5, 10.5), at(20.2, 5.5, 10.5))
            .unwrap();
        assert_eq!((hit.column, hit.z), (10, 10));
    }

    #[test]
    fn a_climbing_segment_enters_the_deck_from_below() {
        let deck: Vec<_> = (8..=12).flat_map(|c| [(c, 5, 20), (c, 5, 21)]).collect();
        let map = world(&deck);
        // Rises 2.07 height indices per column: reaches z = 20 inside column 11
        let hit = map
            .first_block(at(6.5, 5.5, 10.0), at(13.5, 5.5, 24.5))
            .unwrap();
        assert_eq!((hit.column, hit.row, hit.z), (11, 5, 20));
        assert!((hit.t - (10.0 / 14.5)).abs() < 1e-12);
    }

    #[test]
    fn a_segment_that_starts_inside_a_voxel_hits_at_zero() {
        let map = world(&[(3, 3, 3)]);
        let hit = map
            .first_block(at(3.5, 3.5, 3.5), at(9.0, 9.0, 9.0))
            .unwrap();
        assert_eq!((hit.column, hit.row, hit.z, hit.t), (3, 3, 3, 0.0));
    }

    #[test]
    fn only_the_part_inside_the_grid_counts() {
        let map = world(&[(0, 0, 0)]);
        // Starts 5 columns outside the grid and runs into the corner voxel
        let hit = map
            .first_block(at(-5.5, 0.5, 0.5), at(5.5, 0.5, 0.5))
            .unwrap();
        assert_eq!((hit.column, hit.row, hit.z), (0, 0, 0));
        assert!((hit.t - 5.5 / 11.0).abs() < 1e-12);
        // Never enters the grid
        assert!(map
            .first_block(at(-5.5, -3.0, 0.5), at(5.5, -3.0, 0.5))
            .is_none());
        // Below the lowest height index
        assert!(map
            .first_block(at(-5.5, 0.5, -3.0), at(5.5, 0.5, -3.0))
            .is_none());
    }

    #[test]
    fn a_pass_through_a_voxel_corner_enters_the_diagonal_cell() {
        let map = world(&[(6, 6, 4)]);
        let hit = map
            .first_block(at(4.0, 4.0, 4.5), at(8.0, 8.0, 4.5))
            .unwrap();
        assert_eq!((hit.column, hit.row), (6, 6));
    }

    #[test]
    fn the_walk_equals_a_slab_test_against_every_voxel() {
        // Random voxels in a small block and random segments, against the entry time of each voxel's box
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut random = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let voxels: Vec<(u32, u32, u32)> = (0..400)
            .map(|_| {
                (
                    (random() * 12.0) as u32,
                    (random() * 12.0) as u32,
                    (random() * 12.0) as u32,
                )
            })
            .collect();
        let map = world(&voxels);
        let mut blocked = 0;
        for _ in 0..5000 {
            let p0 = at(
                random() * 16.0 - 2.0,
                random() * 16.0 - 2.0,
                random() * 16.0 - 2.0,
            );
            let p1 = at(
                random() * 16.0 - 2.0,
                random() * 16.0 - 2.0,
                random() * 16.0 - 2.0,
            );
            let expected = voxels
                .iter()
                .filter_map(|&(c, r, z)| {
                    let low = at(f64::from(c), f64::from(r), f64::from(z));
                    let high = at(f64::from(c) + 1.0, f64::from(r) + 1.0, f64::from(z) + 1.0);
                    slab_entry(p0, p1, low, high).map(|t| (t, (c, r, z)))
                })
                .min_by(|a, b| a.0.total_cmp(&b.0));
            let got = map.first_block(p0, p1);
            match (expected, got) {
                (None, None) => {}
                (Some((t, voxel)), Some(hit)) => {
                    blocked += 1;
                    assert!((t - hit.t).abs() < 1e-9, "t {t} vs {}", hit.t);
                    assert_eq!(voxel, (hit.column, hit.row, hit.z));
                }
                other => panic!("disagreement for {p0:?} -> {p1:?}: {other:?}"),
            }
        }
        assert!(blocked > 500, "the random scene is too empty: {blocked}");
    }

    /// Entry parameter of the segment into the closed box `low..high`, if it meets it.
    fn slab_entry(p0: [f64; 3], p1: [f64; 3], low: [f64; 3], high: [f64; 3]) -> Option<f64> {
        let (mut t_in, mut t_out) = (0.0f64, 1.0f64);
        for axis in 0..3 {
            let d = p1[axis] - p0[axis];
            if d == 0.0 {
                if p0[axis] < low[axis] || p0[axis] > high[axis] {
                    return None;
                }
                continue;
            }
            let (a, b) = ((low[axis] - p0[axis]) / d, (high[axis] - p0[axis]) / d);
            t_in = t_in.max(a.min(b));
            t_out = t_out.min(a.max(b));
        }
        (t_in <= t_out).then_some(t_in)
    }

    #[test]
    fn from_voxels_merges_runs_and_counts() {
        let map = world(&[(1, 1, 5), (1, 1, 6), (1, 1, 6), (1, 1, 9), (3, 0, 0)]);
        assert_eq!(map.voxel_count(), 4);
        assert_eq!(map.column_count(), 2);
        assert!(map.is_occupied(1, 1, 6) && !map.is_occupied(1, 1, 7) && map.is_occupied(1, 1, 9));
        assert!(!map.is_occupied(99, 1, 6));
        assert!(VoxelColumns::from_voxels([0.0; 3], 0.5, 0.25, 4, 4, &[(4, 0, 0)]).is_err());
    }

    #[test]
    fn a_trajectory_reports_the_segment_and_the_time() {
        let map = world(&[(10, 5, 8)]);
        let segments = [
            Segment {
                p0: at(0.0, 5.5, 8.5),
                p1: at(8.0, 5.5, 8.5),
                t0: 0.0,
                t1: 1.0,
            },
            Segment {
                p0: at(8.0, 5.5, 8.5),
                p1: at(16.0, 5.5, 8.5),
                t0: 1.0,
                t1: 3.0,
            },
        ];
        let hit = map.first_block_along(&segments).unwrap();
        assert_eq!(hit.segment, 1);
        assert!((hit.time - 1.5).abs() < 1e-12);
        assert!((hit.point[0] - at(10.0, 0.0, 0.0)[0]).abs() < 1e-12);
        assert!(map.first_block_along(&segments[..1]).is_none());
    }
}
