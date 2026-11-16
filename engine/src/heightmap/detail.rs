//! The detail layer of a heightmap (`HMD1`, the site's `heightmap.detail.bin`): where objects stand, the lattice
//! quads that hold it are read on a sub-grid of `factor` sub-quads per side, with the same triangle rule.
//!
//! Layout, after the gzip layer (little endian): the magic `HMD1`, `u32` `factor`, `unit`, quad columns (heightmap
//! width - 1), quad rows, quad count; the bitset of the quads with detail (quad `q = row * quad columns + col`,
//! bit `q % 8` of byte `q >> 3`); then for each of those quads in the order of `q` the `(factor + 1)^2 - 4` nodes of
//! its sub-grid that are not its corners, row-major, as zigzag varints of `v`: the node's level is the level the
//! triangle rule reads there from the quad's four corners, rounded half up, plus `v * unit`. Levels are the
//! heightmap's; a node may lie outside `0..=65535`.
//!
//! A quad without detail beside one that has it takes the nodes of their shared edge from that neighbour, so the
//! surface is continuous across the edge (the builder keeps a quad's detail only where a node is more than its
//! threshold from the corner read, so the jump the plain corner read would leave there is at most that threshold).

use super::HeightmapError;
use flate2::read::GzDecoder;
use std::io::Read;

const MAGIC: &[u8; 4] = b"HMD1";
const HEADER_BYTES: usize = 24;
/// Largest `factor` read: a sub-grid of 65 x 65 nodes per quad.
const MAX_FACTOR: u32 = 64;

/// The decoded detail of a heightmap.
#[derive(Debug, Clone)]
pub(super) struct Detail {
    factor: usize,
    quad_columns: usize,
    quad_rows: usize,
    /// The bitset of the quads with detail, quad `q` in bit `q % 64` of word `q / 64`.
    words: Vec<u64>,
    /// The number of quads with detail before each word.
    ranks: Vec<u32>,
    /// The levels of the stored nodes of each quad with detail, in the order of the quads.
    nodes: Vec<i32>,
}

/// A `HMD1` file in the middle of being decoded, a few quads at a time, so that a page can keep answering while a
/// large detail is read (see `Heightmap::continue_detail`).
#[derive(Debug)]
pub struct DetailLoad {
    raw: Vec<u8>,
    factor: usize,
    unit: i64,
    quad_columns: usize,
    quad_rows: usize,
    words: Vec<u64>,
    ranks: Vec<u32>,
    /// Quads with detail, as the header counts them.
    count: usize,
    /// Quads decoded so far.
    decoded: usize,
    nodes: Vec<i32>,
    /// Where the next quad's nodes start in `raw`.
    position: usize,
    /// Words of `words` taken into `bits` so far.
    taken: usize,
    /// The quads of the word being decoded that are still to do.
    bits: u64,
}

fn invalid(reason: &'static str) -> HeightmapError {
    HeightmapError::Detail(reason)
}

/// Position in a quad's stored nodes of the sub-grid node `(i, j)`, which is not a corner of the quad.
fn stored_index(factor: usize, i: usize, j: usize) -> usize {
    let position = i * (factor + 1) + j;
    position - 1 - usize::from(position > factor) - usize::from(position > factor * (factor + 1))
}

impl Detail {
    /// Decodes a `HMD1` file (gzip, or already decompressed) for a heightmap of `width` x `height` samples whose
    /// levels are `levels`.
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] for a wrong magic, a detail of another grid, damaged gzip, or a truncated or
    /// damaged file.
    pub(super) fn from_bytes(
        bytes: &[u8],
        levels: &[u16],
        width: usize,
        height: usize,
    ) -> Result<Self, HeightmapError> {
        let mut load = DetailLoad::new(bytes.to_vec(), width, height)?;
        load.advance(levels, width, usize::MAX)?;
        load.finish()
    }

    /// Number of quads with detail.
    pub(super) fn quad_count(&self) -> usize {
        self.nodes.len() / self.inner()
    }

    fn inner(&self) -> usize {
        (self.factor + 1) * (self.factor + 1) - 4
    }

    /// The stored nodes of the quad `(row, col)`, if it has detail.
    fn stored(&self, row: usize, col: usize) -> Option<&[i32]> {
        let quad = row * self.quad_columns + col;
        let word = self.words[quad / 64];
        let bit = quad % 64;
        if (word >> bit) & 1 == 0 {
            return None;
        }
        let before = (word & ((1u64 << bit) - 1)).count_ones() as usize;
        let first = (self.ranks[quad / 64] as usize + before) * self.inner();
        Some(&self.nodes[first..first + self.inner()])
    }

    /// Whether the quad `(row, col)` has detail.
    fn has(&self, row: usize, col: usize) -> bool {
        let quad = row * self.quad_columns + col;
        (self.words[quad / 64] >> (quad % 64)) & 1 == 1
    }

    /// Level of the surface at the fraction `(row_weight, col_weight)` of the quad `(row, col)` whose corner
    /// levels are `corners` (`[(row, col), (row, col + 1), (row + 1, col), (row + 1, col + 1)]`), or `None` when
    /// neither the quad nor a neighbour has detail and the corner read is the surface.
    pub(super) fn level(
        &self,
        row: usize,
        col: usize,
        corners: [f64; 4],
        row_weight: f64,
        col_weight: f64,
    ) -> Option<f64> {
        let (rows, columns) = (self.quad_rows, self.quad_columns);
        // The quad and its four neighbours that have detail: a bit test each, the nodes are looked up only if one does
        let holding = [
            Some((row, col)),
            (row > 0).then(|| (row - 1, col)),
            (row + 1 < rows).then(|| (row + 1, col)),
            (col > 0).then(|| (row, col - 1)),
            (col + 1 < columns).then(|| (row, col + 1)),
        ]
        .map(|at| at.filter(|&(r, c)| self.has(r, c)));
        if holding.iter().all(Option::is_none) {
            return None;
        }
        let [own, above, below, left, right] =
            holding.map(|at| at.and_then(|(r, c)| self.stored(r, c)));

        let factor = self.factor;
        let node = |i: usize, j: usize| -> f64 {
            if (i == 0 || i == factor) && (j == 0 || j == factor) {
                return corners[usize::from(i == factor) * 2 + usize::from(j == factor)];
            }
            if let Some(nodes) = own {
                return f64::from(nodes[stored_index(factor, i, j)]);
            }
            // A quad without detail takes the nodes of an edge it shares with a quad that has it
            let shared = if i == 0 {
                above.map(|n| n[stored_index(factor, factor, j)])
            } else if i == factor {
                below.map(|n| n[stored_index(factor, 0, j)])
            } else if j == 0 {
                left.map(|n| n[stored_index(factor, i, factor)])
            } else if j == factor {
                right.map(|n| n[stored_index(factor, i, 0)])
            } else {
                None
            };
            shared.map_or_else(
                || {
                    let scaled = predicted_scaled_f64(corners, factor as f64, i as f64, j as f64);
                    scaled / factor as f64
                },
                f64::from,
            )
        };

        let sub_row = row_weight * factor as f64;
        let sub_col = col_weight * factor as f64;
        let i = (sub_row.floor() as usize).min(factor - 1);
        let j = (sub_col.floor() as usize).min(factor - 1);
        let row_part = sub_row - i as f64;
        let col_part = sub_col - j as f64;
        let corner = node(i, j);
        let diagonal = node(i + 1, j + 1);
        Some(if col_part >= row_part {
            let right = node(i, j + 1);
            corner + (right - corner) * col_part + (diagonal - right) * row_part
        } else {
            let below = node(i + 1, j);
            corner + (below - corner) * row_part + (diagonal - below) * col_part
        })
    }
}

impl DetailLoad {
    /// Reads the header and the bitset of a `HMD1` file (gzip, or already decompressed; the load keeps the bytes) for a
    /// heightmap of `width` x `height` samples; the nodes are decoded by [`DetailLoad::advance`].
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] for a wrong magic, a detail of another grid, damaged gzip, or a truncated or
    /// damaged header or bitset.
    pub(super) fn new(bytes: Vec<u8>, width: usize, height: usize) -> Result<Self, HeightmapError> {
        let raw = if bytes.starts_with(&[0x1F, 0x8B]) {
            let mut raw = Vec::new();
            GzDecoder::new(&bytes[..])
                .read_to_end(&mut raw)
                .map_err(|_| invalid("bad gzip data"))?;
            raw
        } else {
            bytes
        };
        if raw.len() < HEADER_BYTES || &raw[..4] != MAGIC {
            return Err(invalid("not an HMD1 detail"));
        }
        let header = |at: usize| u32::from_le_bytes(raw[at..at + 4].try_into().unwrap());
        let (factor, unit, quad_columns, quad_rows, count) = (
            header(4),
            i64::from(header(8)),
            header(12) as usize,
            header(16) as usize,
            header(20) as usize,
        );
        if quad_columns != width - 1 || quad_rows != height - 1 {
            return Err(invalid("detail of another heightmap"));
        }
        if !(2..=MAX_FACTOR).contains(&factor) {
            return Err(invalid("unsupported detail factor"));
        }
        let factor = factor as usize;
        let quads = quad_columns * quad_rows;
        let bit_bytes = quads.div_ceil(8);
        if raw.len() < HEADER_BYTES + bit_bytes {
            return Err(invalid("truncated detail"));
        }

        let mut words = vec![0u64; quads.div_ceil(64)];
        for (word, bytes) in words
            .iter_mut()
            .zip(raw[HEADER_BYTES..HEADER_BYTES + bit_bytes].chunks(8))
        {
            let mut little_endian = [0u8; 8];
            little_endian[..bytes.len()].copy_from_slice(bytes);
            *word = u64::from_le_bytes(little_endian);
        }
        // A set bit past the last quad names a quad that does not exist
        if quads % 64 != 0 && words[quads / 64] >> (quads % 64) != 0 {
            return Err(invalid("damaged detail"));
        }
        let mut ranks = Vec::with_capacity(words.len());
        let mut total = 0usize;
        for word in &words {
            ranks.push(total as u32);
            total += word.count_ones() as usize;
        }
        if total != count {
            return Err(invalid("damaged detail"));
        }

        let inner = (factor + 1) * (factor + 1) - 4;
        // Every node takes at least one byte: a count the file cannot hold is refused before allocating
        if raw.len() - HEADER_BYTES - bit_bytes < count * inner {
            return Err(invalid("truncated detail"));
        }
        Ok(DetailLoad {
            factor,
            unit,
            quad_columns,
            quad_rows,
            words,
            ranks,
            count,
            decoded: 0,
            nodes: Vec::with_capacity(count * inner),
            position: HEADER_BYTES + bit_bytes,
            taken: 0,
            bits: 0,
            raw,
        })
    }

    /// Decodes the nodes of the next `quads` quads with detail, or of all that are left.
    ///
    /// `levels` and `width` are those of the heightmap this load was begun for.
    ///
    /// # Returns
    /// Whether every quad is decoded: [`DetailLoad::finish`] makes the detail then.
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] for a truncated or damaged file.
    pub(super) fn advance(
        &mut self,
        levels: &[u16],
        width: usize,
        quads: usize,
    ) -> Result<bool, HeightmapError> {
        let factor = self.factor;
        for _ in 0..quads.min(self.count - self.decoded) {
            while self.bits == 0 {
                self.bits = self.words[self.taken];
                self.taken += 1;
            }
            let quad = (self.taken - 1) * 64 + self.bits.trailing_zeros() as usize;
            self.bits &= self.bits - 1;
            let first = (quad / self.quad_columns) * width + quad % self.quad_columns;
            let corners = [
                i64::from(levels[first]),
                i64::from(levels[first + 1]),
                i64::from(levels[first + width]),
                i64::from(levels[first + width + 1]),
            ];
            for i in 0..=factor {
                for j in 0..=factor {
                    if (i == 0 || i == factor) && (j == 0 || j == factor) {
                        continue;
                    }
                    let mut value = 0u64;
                    let mut shift = 0;
                    loop {
                        let byte = *self
                            .raw
                            .get(self.position)
                            .ok_or(invalid("truncated detail"))?;
                        self.position += 1;
                        if shift > 56 {
                            return Err(invalid("damaged detail"));
                        }
                        value |= u64::from(byte & 0x7F) << shift;
                        shift += 7;
                        if byte < 0x80 {
                            break;
                        }
                    }
                    let residual = (value >> 1) as i64 ^ -((value & 1) as i64);
                    let scaled = predicted_scaled(corners, factor as i64, i as i64, j as i64);
                    let predicted = (2 * scaled + factor as i64).div_euclid(2 * factor as i64);
                    let level = residual
                        .checked_mul(self.unit)
                        .and_then(|offset| offset.checked_add(predicted))
                        .and_then(|level| i32::try_from(level).ok())
                        .ok_or(invalid("damaged detail"))?;
                    self.nodes.push(level);
                }
            }
            self.decoded += 1;
        }
        Ok(self.decoded == self.count)
    }

    /// The detail, once [`DetailLoad::advance`] decoded every quad.
    ///
    /// # Errors
    /// [`HeightmapError::Detail`] when quads are left or the file holds more than its quads.
    pub(super) fn finish(&mut self) -> Result<Detail, HeightmapError> {
        if self.decoded != self.count || self.position != self.raw.len() {
            return Err(invalid("damaged detail"));
        }
        Ok(Detail {
            factor: self.factor,
            quad_columns: self.quad_columns,
            quad_rows: self.quad_rows,
            words: std::mem::take(&mut self.words),
            ranks: std::mem::take(&mut self.ranks),
            nodes: std::mem::take(&mut self.nodes),
        })
    }
}

/// `factor` times the level the triangle rule reads at the sub-grid node `(i, j)` of a quad (integer corners).
fn predicted_scaled(corners: [i64; 4], factor: i64, i: i64, j: i64) -> i64 {
    let [c00, c01, c10, c11] = corners;
    if j >= i {
        factor * c00 + j * (c01 - c00) + i * (c11 - c01)
    } else {
        factor * c00 + i * (c10 - c00) + j * (c11 - c10)
    }
}

/// As [`predicted_scaled`] on `f64` corner levels.
fn predicted_scaled_f64(corners: [f64; 4], factor: f64, i: f64, j: f64) -> f64 {
    let [c00, c01, c10, c11] = corners;
    if j >= i {
        factor * c00 + j * (c01 - c00) + i * (c11 - c01)
    } else {
        factor * c00 + i * (c10 - c00) + j * (c11 - c10)
    }
}
