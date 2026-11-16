//! Bounding volume hierarchy over a triangle soup: a binned-SAH builder and the flattened skip-pointer
//! ("escape index") layout that the GPU traversal reads. See `README.md` for the byte layout.
//!
//! The layout is fixed by contract (another implementation, in WGSL, reads it):
//!
//! * `nodes`: 32-byte records `{ min.xyz: f32, a: u32, max.xyz: f32, b: u32 }`, depth-first, a node's first child
//!   right after it;
//! * `a` is the escape index: the node to visit when the ray misses the box or after the subtree is done
//!   ([`NO_NODE`] = end of traversal);
//! * `b` is `first_triangle << 8 | triangle_count` for a leaf (`1..=255` triangles) and `0` for an inner node;
//! * `triangles`: three `vec4<f32>` (`xyz`, padding) per triangle, in leaf order.
//!
//! `first_triangle << 8` has to fit a `u32`, so one hierarchy holds at most [`MAX_TRIANGLES`] (2^24)
//! triangles. [`BvhSet`] splits a larger soup spatially into several hierarchies of this layout.

use std::fmt;

#[cfg(feature = "threads")]
use rayon::prelude::*;

/// A triangle of the input soup: three vertices, metres.
pub type Triangle = [[f32; 3]; 3];

/// A triangle as stored for the GPU: three `vec4<f32>` (`xyz`, padding 0).
pub type GpuTriangle = [[f32; 4]; 3];

/// Escape index that ends the traversal.
pub const NO_NODE: u32 = 0xFFFF_FFFF;

/// Most triangles of one leaf (the count has 8 bits).
pub const MAX_LEAF_TRIANGLES: usize = 255;

/// Most triangles of one hierarchy: `first_triangle << 8` must fit a `u32`.
pub const MAX_TRIANGLES: usize = 1 << 24;

/// Bytes of a node record.
pub const NODE_BYTES: usize = 32;

/// Bytes of a triangle record.
pub const TRIANGLE_BYTES: usize = 48;

/// Bins per axis of the SAH sweep.
const BINS: usize = 16;

/// Ranges at least this long are built on two threads (feature `threads`).
#[cfg(feature = "threads")]
const PARALLEL_RANGE: usize = 1 << 16;

/// One 32-byte record of the flattened hierarchy.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Node {
    /// Lower corner of the box.
    pub min: [f32; 3],
    /// Escape index: next node when the ray misses the box or after this subtree; [`NO_NODE`] at the end.
    pub a: u32,
    /// Upper corner of the box.
    pub max: [f32; 3],
    /// `first_triangle << 8 | triangle_count` for a leaf, 0 for an inner node (whose first child is the next node).
    pub b: u32,
}

impl Node {
    /// Whether this node is a leaf.
    pub fn is_leaf(&self) -> bool {
        self.b & 0xFF != 0
    }

    /// Index of the first triangle of a leaf.
    pub fn first_triangle(&self) -> usize {
        (self.b >> 8) as usize
    }

    /// Number of triangles of a leaf (0 for an inner node).
    pub fn triangle_count(&self) -> usize {
        (self.b & 0xFF) as usize
    }
}

/// Reasons a hierarchy cannot be built or read.
#[derive(Debug, PartialEq, Eq)]
pub enum BvhError {
    /// More triangles than one hierarchy can address; use [`BvhSet`].
    TooManyTriangles(usize),
    /// A vertex is NaN or infinite (triangle index).
    NonFiniteVertex(usize),
    /// The byte buffer is not a `bvh.bin` (reason).
    Format(String),
}

impl fmt::Display for BvhError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BvhError::TooManyTriangles(n) => {
                write!(
                    f,
                    "{n} triangles do not fit one hierarchy (at most {MAX_TRIANGLES}); use BvhSet"
                )
            }
            BvhError::NonFiniteVertex(i) => {
                write!(f, "triangle {i} has a vertex that is not finite")
            }
            BvhError::Format(reason) => write!(f, "bvh.bin: {reason}"),
        }
    }
}

impl std::error::Error for BvhError {}

/// Reads a triangle soup from little-endian `f32` bytes: nine floats per triangle (`x y z` of three vertices).
///
/// # Errors
/// [`BvhError::Format`] if the length is not a multiple of 36 bytes.
pub fn triangles_from_le_bytes(bytes: &[u8]) -> Result<Vec<Triangle>, BvhError> {
    if bytes.len() % 36 != 0 {
        return Err(BvhError::Format(format!(
            "triangle bytes: {} is not a multiple of 36",
            bytes.len()
        )));
    }
    Ok(bytes
        .chunks_exact(36)
        .map(|chunk| {
            let f = |i: usize| {
                f32::from_le_bytes([
                    chunk[i * 4],
                    chunk[i * 4 + 1],
                    chunk[i * 4 + 2],
                    chunk[i * 4 + 3],
                ])
            };
            [[f(0), f(1), f(2)], [f(3), f(4), f(5)], [f(6), f(7), f(8)]]
        })
        .collect())
}

/// Reads a triangle soup (see [`triangles_from_le_bytes`]) from a reader to its end in chunks, without
/// holding the raw bytes and the triangles at the same time.
///
/// # Errors
/// An I/O error, or `InvalidData` if the stream ends inside a triangle.
pub fn triangles_from_reader(mut reader: impl std::io::Read) -> std::io::Result<Vec<Triangle>> {
    const CHUNK_TRIANGLES: usize = 1 << 20;
    let mut triangles = Vec::new();
    let mut buffer = vec![0u8; CHUNK_TRIANGLES * 36];
    loop {
        let mut filled = 0;
        while filled < buffer.len() {
            let n = reader.read(&mut buffer[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        let chunk = triangles_from_le_bytes(&buffer[..filled])
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        triangles.extend(chunk);
        if filled < buffer.len() {
            return Ok(triangles);
        }
    }
}

/// Bounding box and centroid of one primitive.
#[derive(Clone, Copy)]
struct Prim {
    min: [f32; 3],
    max: [f32; 3],
}

impl Prim {
    fn of(tri: &Triangle) -> Self {
        let mut min = tri[0];
        let mut max = tri[0];
        for v in &tri[1..] {
            for axis in 0..3 {
                min[axis] = min[axis].min(v[axis]);
                max[axis] = max[axis].max(v[axis]);
            }
        }
        Prim { min, max }
    }

    fn centroid(&self, axis: usize) -> f32 {
        0.5 * (self.min[axis] + self.max[axis])
    }
}

/// Axis-aligned box accumulator.
#[derive(Clone, Copy)]
struct Aabb {
    min: [f32; 3],
    max: [f32; 3],
}

impl Aabb {
    const EMPTY: Aabb = Aabb {
        min: [f32::INFINITY; 3],
        max: [f32::NEG_INFINITY; 3],
    };

    fn grow(&mut self, other: &Aabb) {
        for axis in 0..3 {
            self.min[axis] = self.min[axis].min(other.min[axis]);
            self.max[axis] = self.max[axis].max(other.max[axis]);
        }
    }

    fn of(prim: &Prim) -> Self {
        Aabb {
            min: prim.min,
            max: prim.max,
        }
    }

    fn area(&self) -> f64 {
        let dx = f64::from(self.max[0]) - f64::from(self.min[0]);
        let dy = f64::from(self.max[1]) - f64::from(self.min[1]);
        let dz = f64::from(self.max[2]) - f64::from(self.min[2]);
        if dx < 0.0 || dy < 0.0 || dz < 0.0 {
            return 0.0;
        }
        2.0 * (dx * dy + dy * dz + dz * dx)
    }
}

#[derive(Clone, Copy)]
struct Bin {
    bounds: Aabb,
    count: usize,
}

/// A hierarchy over a triangle soup, in the flattened layout.
#[derive(Debug, Clone, PartialEq)]
pub struct Bvh {
    /// Depth-first nodes with escape indices.
    pub nodes: Vec<Node>,
    /// Triangles in leaf order.
    pub triangles: Vec<GpuTriangle>,
}

/// Knobs of the SAH build.
#[derive(Debug, Clone, Copy)]
pub struct BuildOptions {
    /// Most triangles a leaf keeps when splitting does not pay (1..=255).
    pub max_leaf_triangles: usize,
}

impl Default for BuildOptions {
    fn default() -> Self {
        BuildOptions {
            max_leaf_triangles: 4,
        }
    }
}

impl Bvh {
    /// Builds a hierarchy with the binned surface area heuristic (16 bins on each axis, traversal cost 1,
    /// triangle cost 1).
    ///
    /// Formula: F52, F53, F54 in docs/thesis-methods-and-results.md of mapping-squad.
    ///
    /// # Errors
    /// [`BvhError::TooManyTriangles`] above [`MAX_TRIANGLES`], [`BvhError::NonFiniteVertex`] for a NaN or
    /// infinite vertex.
    pub fn build(triangles: &[Triangle], options: BuildOptions) -> Result<Bvh, BvhError> {
        if triangles.len() > MAX_TRIANGLES {
            return Err(BvhError::TooManyTriangles(triangles.len()));
        }
        if let Some(i) = triangles
            .iter()
            .position(|t| t.iter().flatten().any(|c| !c.is_finite()))
        {
            return Err(BvhError::NonFiniteVertex(i));
        }
        if triangles.is_empty() {
            return Ok(Bvh {
                nodes: Vec::new(),
                triangles: Vec::new(),
            });
        }

        let prims: Vec<Prim> = triangles.iter().map(Prim::of).collect();
        let mut order: Vec<u32> = (0..triangles.len() as u32).collect();
        let max_leaf = options.max_leaf_triangles.clamp(1, MAX_LEAF_TRIANGLES);
        let mut nodes = build_range(&mut order, 0, &prims, max_leaf);

        // Until here `a` holds the size of the subtree; in depth-first order the node after a subtree is
        // `index + size`, for a left child (its right sibling) and a right child (the parent's escape) alike.
        let count = nodes.len();
        for (index, node) in nodes.iter_mut().enumerate() {
            let next = index + node.a as usize;
            node.a = if next >= count { NO_NODE } else { next as u32 };
        }

        let triangles = order
            .iter()
            .map(|&i| {
                let t = &triangles[i as usize];
                [
                    [t[0][0], t[0][1], t[0][2], 0.0],
                    [t[1][0], t[1][1], t[1][2], 0.0],
                    [t[2][0], t[2][1], t[2][2], 0.0],
                ]
            })
            .collect();
        Ok(Bvh { nodes, triangles })
    }

    /// Box around everything in the hierarchy (the root's box), or `None` if it is empty.
    pub fn bounds(&self) -> Option<([f32; 3], [f32; 3])> {
        self.nodes.first().map(|n| (n.min, n.max))
    }

    /// Serialises to `bvh.bin`: `u32` node count, `u32` triangle count, the nodes, the triangles; all
    /// little endian.
    ///
    /// Formula: F56 in docs/thesis-methods-and-results.md of mapping-squad.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            8 + self.nodes.len() * NODE_BYTES + self.triangles.len() * TRIANGLE_BYTES,
        );
        out.extend_from_slice(&(self.nodes.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.triangles.len() as u32).to_le_bytes());
        for n in &self.nodes {
            for c in n.min {
                out.extend_from_slice(&c.to_le_bytes());
            }
            out.extend_from_slice(&n.a.to_le_bytes());
            for c in n.max {
                out.extend_from_slice(&c.to_le_bytes());
            }
            out.extend_from_slice(&n.b.to_le_bytes());
        }
        for t in &self.triangles {
            for v in t {
                for c in v {
                    out.extend_from_slice(&c.to_le_bytes());
                }
            }
        }
        out
    }

    /// Reads a `bvh.bin` written by [`Bvh::to_bytes`] and checks the structure (see [`Bvh::validate`]).
    ///
    /// Formula: F56 in docs/thesis-methods-and-results.md of mapping-squad.
    ///
    /// # Errors
    /// [`BvhError::Format`] if the size does not match the header or the structure is inconsistent.
    pub fn from_bytes(bytes: &[u8]) -> Result<Bvh, BvhError> {
        let format = |reason: &str| BvhError::Format(reason.to_string());
        if bytes.len() < 8 {
            return Err(format("shorter than the 8-byte header"));
        }
        let word = |at: usize| {
            u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
        };
        let node_count = word(0) as usize;
        let tri_count = word(4) as usize;
        let expected = 8usize
            .checked_add(
                node_count
                    .checked_mul(NODE_BYTES)
                    .ok_or_else(|| format("node count overflows"))?,
            )
            .and_then(|n| n.checked_add(tri_count.checked_mul(TRIANGLE_BYTES)?))
            .ok_or_else(|| format("size overflows"))?;
        if bytes.len() != expected {
            return Err(BvhError::Format(format!(
                "{} bytes, the header says {expected}",
                bytes.len()
            )));
        }
        let float = |at: usize| f32::from_bits(word(at));
        let nodes = (0..node_count)
            .map(|i| {
                let at = 8 + i * NODE_BYTES;
                Node {
                    min: [float(at), float(at + 4), float(at + 8)],
                    a: word(at + 12),
                    max: [float(at + 16), float(at + 20), float(at + 24)],
                    b: word(at + 28),
                }
            })
            .collect();
        let base = 8 + node_count * NODE_BYTES;
        let triangles = (0..tri_count)
            .map(|i| {
                let at = base + i * TRIANGLE_BYTES;
                let vertex = |v: usize| {
                    let p = at + v * 16;
                    [float(p), float(p + 4), float(p + 8), float(p + 12)]
                };
                [vertex(0), vertex(1), vertex(2)]
            })
            .collect();
        let bvh = Bvh { nodes, triangles };
        bvh.validate()?;
        Ok(bvh)
    }

    /// Checks the invariants of the layout: the escape index of a node is the index after its subtree
    /// (`NO_NODE` at the end), an inner node's left child is the next node and its right child starts at the
    /// left child's escape and shares the parent's, every leaf has 1..=255 triangles and the leaves tile
    /// `0..triangle_count` in order, and every box contains the boxes of its children and the triangles of its
    /// leaves.
    ///
    /// Formula: F56 in docs/thesis-methods-and-results.md of mapping-squad.
    ///
    /// # Errors
    /// [`BvhError::Format`] naming the first violation.
    pub fn validate(&self) -> Result<(), BvhError> {
        let fail = |reason: String| Err(BvhError::Format(reason));
        let count = self.nodes.len();
        if count == 0 {
            return if self.triangles.is_empty() {
                Ok(())
            } else {
                fail("triangles without nodes".into())
            };
        }
        let escape_of = |i: usize| {
            if self.nodes[i].a == NO_NODE {
                count
            } else {
                self.nodes[i].a as usize
            }
        };
        if self.nodes[0].a != NO_NODE {
            return fail("the root's escape must be the end".into());
        }
        let contains = |outer: &Node, min: [f32; 3], max: [f32; 3]| {
            (0..3).all(|k| min[k] >= outer.min[k] && max[k] <= outer.max[k])
        };

        let mut next_triangle = 0usize;
        for (i, n) in self.nodes.iter().enumerate() {
            let escape = escape_of(i);
            if escape <= i || escape > count {
                return fail(format!("node {i}: escape {escape} does not go forward"));
            }
            if n.is_leaf() {
                if escape != i + 1 {
                    return fail(format!(
                        "node {i}: a leaf's escape must be the next node, not {escape}"
                    ));
                }
                if n.first_triangle() != next_triangle {
                    return fail(format!(
                        "node {i}: leaf starts at triangle {}, expected {next_triangle}",
                        n.first_triangle()
                    ));
                }
                next_triangle += n.triangle_count();
                if next_triangle > self.triangles.len() {
                    return fail(format!("node {i}: leaf reaches past the triangles"));
                }
                for t in &self.triangles[n.first_triangle()..next_triangle] {
                    for v in t {
                        if !contains(n, [v[0], v[1], v[2]], [v[0], v[1], v[2]]) {
                            return fail(format!("node {i}: a triangle leaves the box"));
                        }
                    }
                }
            } else {
                if n.b != 0 {
                    return fail(format!("node {i}: inner node with b = {}", n.b));
                }
                let right = escape_of(i + 1);
                if i + 1 >= count || right >= escape || escape_of(right) != escape {
                    return fail(format!("node {i}: children do not tile its subtree"));
                }
                for child in [i + 1, right] {
                    let c = &self.nodes[child];
                    if !contains(n, c.min, c.max) {
                        return fail(format!("node {i}: child {child} leaves the box"));
                    }
                }
            }
        }
        if next_triangle != self.triangles.len() {
            return fail(format!(
                "leaves cover {next_triangle} of {} triangles",
                self.triangles.len()
            ));
        }
        Ok(())
    }
}

/// Builds the nodes of `order` (the triangles of one subtree, `base` being the position of `order[0]` in the
/// whole leaf order) in depth-first order; `a` of every node holds the size of its subtree.
fn build_range(order: &mut [u32], base: usize, prims: &[Prim], max_leaf: usize) -> Vec<Node> {
    let count = order.len();
    let mut bounds = Aabb::EMPTY;
    let mut centroids = Aabb::EMPTY;
    for &i in order.iter() {
        let prim = &prims[i as usize];
        bounds.grow(&Aabb::of(prim));
        for axis in 0..3 {
            let c = prim.centroid(axis);
            centroids.min[axis] = centroids.min[axis].min(c);
            centroids.max[axis] = centroids.max[axis].max(c);
        }
    }

    let leaf = |bounds: &Aabb| {
        vec![Node {
            min: bounds.min,
            a: 1,
            max: bounds.max,
            b: ((base as u32) << 8) | count as u32,
        }]
    };
    if count == 1 {
        return leaf(&bounds);
    }

    let split = choose_split(order, prims, &bounds, &centroids, max_leaf);
    let middle = match split {
        Split::Leaf => return leaf(&bounds),
        Split::Plane { axis, position } => {
            let middle = partition(order, prims, axis, position);
            if middle == 0 || middle == count {
                median_split(order, prims, &centroids)
            } else {
                middle
            }
        }
        Split::Median => median_split(order, prims, &centroids),
    };

    let (left_order, right_order) = order.split_at_mut(middle);
    let (left, right) = {
        #[cfg(feature = "threads")]
        {
            if count >= PARALLEL_RANGE {
                rayon::join(
                    || build_range(left_order, base, prims, max_leaf),
                    || build_range(right_order, base + middle, prims, max_leaf),
                )
            } else {
                (
                    build_range(left_order, base, prims, max_leaf),
                    build_range(right_order, base + middle, prims, max_leaf),
                )
            }
        }
        #[cfg(not(feature = "threads"))]
        {
            (
                build_range(left_order, base, prims, max_leaf),
                build_range(right_order, base + middle, prims, max_leaf),
            )
        }
    };

    let mut nodes = Vec::with_capacity(1 + left.len() + right.len());
    nodes.push(Node {
        min: bounds.min,
        a: (1 + left.len() + right.len()) as u32,
        max: bounds.max,
        b: 0,
    });
    nodes.extend(left);
    nodes.extend(right);
    nodes
}

enum Split {
    /// Keep all triangles in one leaf.
    Leaf,
    /// Split the centroids at `position` on `axis`.
    Plane { axis: usize, position: f32 },
    /// No useful plane: split the centroids at the median.
    Median,
}

/// The cheapest of the 3 x 15 binned planes by the surface area heuristic, or a leaf.
fn choose_split(
    order: &[u32],
    prims: &[Prim],
    bounds: &Aabb,
    centroids: &Aabb,
    max_leaf: usize,
) -> Split {
    let count = order.len();
    let extent = [
        centroids.max[0] - centroids.min[0],
        centroids.max[1] - centroids.min[1],
        centroids.max[2] - centroids.min[2],
    ];
    if extent.iter().all(|&e| !(e > 0.0)) {
        // Every centroid is the same point: no plane separates them
        return if count <= MAX_LEAF_TRIANGLES {
            Split::Leaf
        } else {
            Split::Median
        };
    }

    let mut bins = [[Bin {
        bounds: Aabb::EMPTY,
        count: 0,
    }; BINS]; 3];
    for &i in order {
        let prim = &prims[i as usize];
        let boxed = Aabb::of(prim);
        for axis in 0..3 {
            if extent[axis] > 0.0 {
                let bin = bin_of(prim.centroid(axis), centroids.min[axis], extent[axis]);
                bins[axis][bin].bounds.grow(&boxed);
                bins[axis][bin].count += 1;
            }
        }
    }

    let parent_area = bounds.area().max(f64::MIN_POSITIVE);
    let mut best_cost = f64::INFINITY;
    let mut best = (0usize, 0usize);
    for axis in 0..3 {
        if !(extent[axis] > 0.0) {
            continue;
        }
        // right[i] = box and count of bins i..BINS
        let mut right = [(Aabb::EMPTY, 0usize); BINS];
        let mut running = (Aabb::EMPTY, 0usize);
        for i in (1..BINS).rev() {
            running.0.grow(&bins[axis][i].bounds);
            running.1 += bins[axis][i].count;
            right[i] = running;
        }
        let mut left = (Aabb::EMPTY, 0usize);
        for i in 0..BINS - 1 {
            left.0.grow(&bins[axis][i].bounds);
            left.1 += bins[axis][i].count;
            let (right_box, right_count) = right[i + 1];
            if left.1 == 0 || right_count == 0 {
                continue;
            }
            let cost = 1.0
                + (left.0.area() * left.1 as f64 + right_box.area() * right_count as f64)
                    / parent_area;
            if cost < best_cost {
                best_cost = cost;
                best = (axis, i);
            }
        }
    }

    if !best_cost.is_finite() {
        return if count <= MAX_LEAF_TRIANGLES {
            Split::Leaf
        } else {
            Split::Median
        };
    }
    if count <= max_leaf && best_cost >= count as f64 {
        return Split::Leaf;
    }
    let (axis, plane) = best;
    // Centroids in bins 0..=plane go left
    let position = centroids.min[axis] + extent[axis] * (plane + 1) as f32 / BINS as f32;
    Split::Plane { axis, position }
}

fn bin_of(centroid: f32, min: f32, extent: f32) -> usize {
    let scaled = (centroid - min) / extent * BINS as f32;
    (scaled as usize).min(BINS - 1)
}

/// Moves the primitives whose centroid is below `position` to the front; returns how many there are.
/// Uses the same bin rule as the sweep so the partition is the one the cost was computed for.
fn partition(order: &mut [u32], prims: &[Prim], axis: usize, position: f32) -> usize {
    let mut left = 0;
    for i in 0..order.len() {
        if prims[order[i] as usize].centroid(axis) < position {
            order.swap(left, i);
            left += 1;
        }
    }
    left
}

/// Splits at the median centroid of the longest axis of the centroid box.
fn median_split(order: &mut [u32], prims: &[Prim], centroids: &Aabb) -> usize {
    let axis = (0..3)
        .max_by(|&a, &b| {
            let ea = centroids.max[a] - centroids.min[a];
            let eb = centroids.max[b] - centroids.min[b];
            ea.total_cmp(&eb)
        })
        .unwrap_or(0);
    let middle = order.len() / 2;
    order.select_nth_unstable_by(middle, |&a, &b| {
        prims[a as usize]
            .centroid(axis)
            .total_cmp(&prims[b as usize].centroid(axis))
    });
    middle
}

/// Several hierarchies over one soup that is too big for a single one (more than [`MAX_TRIANGLES`]
/// triangles): the soup is split spatially, at the median of the longest axis, into parts of at most
/// `max_triangles` triangles, each with its own [`Bvh`] in the same layout.
#[derive(Debug, Clone, PartialEq)]
pub struct BvhSet {
    /// The hierarchies; their boxes may overlap.
    pub parts: Vec<Bvh>,
}

impl BvhSet {
    /// Builds hierarchies of at most `max_triangles` triangles each (at most [`MAX_TRIANGLES`]). The soup is
    /// consumed so that its memory is handed back part by part while the hierarchies are built (a map of 72
    /// million triangles needs 2.6 GB for the soup and 3.5 GB for the hierarchies).
    ///
    /// # Errors
    /// As [`Bvh::build`].
    pub fn build(
        mut triangles: Vec<Triangle>,
        max_triangles: usize,
        options: BuildOptions,
    ) -> Result<BvhSet, BvhError> {
        let max_triangles = max_triangles.clamp(1, MAX_TRIANGLES);
        let mut ranges = Vec::new();
        split_parts(&mut triangles, max_triangles, 0, &mut ranges);

        // Build from the end so that each finished range can be cut off and its memory returned
        let mut parts = Vec::with_capacity(ranges.len());
        for (start, _) in ranges.into_iter().rev() {
            parts.push(Bvh::build(&triangles[start..], options)?);
            triangles.truncate(start);
            triangles.shrink_to_fit();
        }
        parts.reverse();
        Ok(BvhSet { parts })
    }

    /// Total triangles over all parts.
    pub fn triangle_count(&self) -> usize {
        self.parts.iter().map(|p| p.triangles.len()).sum()
    }

    /// Total nodes over all parts.
    pub fn node_count(&self) -> usize {
        self.parts.iter().map(|p| p.nodes.len()).sum()
    }
}

fn centroid(triangle: &Triangle, axis: usize) -> f32 {
    (triangle[0][axis] + triangle[1][axis] + triangle[2][axis]) / 3.0
}

/// Splits `triangles` in place, recursively at the median centroid of the longest axis, until each range has at
/// most `max` triangles; pushes the `(start, end)` ranges in order.
fn split_parts(
    triangles: &mut [Triangle],
    max: usize,
    start: usize,
    out: &mut Vec<(usize, usize)>,
) {
    if triangles.len() <= max {
        out.push((start, start + triangles.len()));
        return;
    }
    let mut low = [f32::INFINITY; 3];
    let mut high = [f32::NEG_INFINITY; 3];
    for t in triangles.iter() {
        for axis in 0..3 {
            let c = centroid(t, axis);
            low[axis] = low[axis].min(c);
            high[axis] = high[axis].max(c);
        }
    }
    let axis = (0..3)
        .max_by(|&a, &b| (high[a] - low[a]).total_cmp(&(high[b] - low[b])))
        .unwrap_or(0);
    let middle = triangles.len() / 2;
    triangles.select_nth_unstable_by(middle, |a, b| {
        centroid(a, axis).total_cmp(&centroid(b, axis))
    });
    let (left, right) = triangles.split_at_mut(middle);
    split_parts(left, max, start, out);
    split_parts(right, max, start + middle, out);
}

#[cfg(feature = "threads")]
pub(crate) fn map_parallel<T: Send, I: Sync, F: Fn(&I) -> T + Sync + Send>(
    items: &[I],
    f: F,
) -> Vec<T> {
    items.par_iter().map(f).collect()
}

#[cfg(not(feature = "threads"))]
pub(crate) fn map_parallel<T, I, F: Fn(&I) -> T>(items: &[I], f: F) -> Vec<T> {
    items.iter().map(f).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f32 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*seed >> 40) as f32) / (1u64 << 24) as f32
    }

    /// Random small triangles in a 100 m cube.
    pub(crate) fn random_soup(n: usize, seed: u64) -> Vec<Triangle> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                let o = [
                    lcg(&mut s) * 100.0,
                    lcg(&mut s) * 100.0,
                    lcg(&mut s) * 100.0,
                ];
                let mut v = |_: usize| {
                    [
                        o[0] + lcg(&mut s) * 3.0,
                        o[1] + lcg(&mut s) * 3.0,
                        o[2] + lcg(&mut s) * 3.0,
                    ]
                };
                [v(0), v(1), v(2)]
            })
            .collect()
    }

    #[test]
    fn layout_invariants_hold() {
        for n in [1usize, 2, 3, 17, 500, 5000] {
            let bvh = Bvh::build(&random_soup(n, n as u64), BuildOptions::default()).unwrap();
            bvh.validate().unwrap();
            assert_eq!(bvh.triangles.len(), n);
            assert_eq!(bvh.nodes[0].a, NO_NODE);
        }
    }

    #[test]
    fn empty_soup_builds_an_empty_hierarchy() {
        let bvh = Bvh::build(&[], BuildOptions::default()).unwrap();
        assert!(bvh.nodes.is_empty() && bvh.triangles.is_empty());
        assert_eq!(Bvh::from_bytes(&bvh.to_bytes()).unwrap(), bvh);
    }

    #[test]
    fn identical_triangles_split_into_leaves_of_at_most_255() {
        let tri: Triangle = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let soup = vec![tri; 1000];
        let bvh = Bvh::build(&soup, BuildOptions::default()).unwrap();
        bvh.validate().unwrap();
        assert!(bvh
            .nodes
            .iter()
            .filter(|n| n.is_leaf())
            .all(|n| n.triangle_count() <= MAX_LEAF_TRIANGLES));
    }

    #[test]
    fn single_triangle_is_a_leaf_root() {
        let tri: Triangle = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let bvh = Bvh::build(&[tri], BuildOptions::default()).unwrap();
        assert_eq!(bvh.nodes.len(), 1);
        assert_eq!(bvh.nodes[0].b, 1);
        assert_eq!(bvh.nodes[0].a, NO_NODE);
    }

    #[test]
    fn rejects_non_finite_vertices() {
        let tri: Triangle = [[0.0, f32::NAN, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        assert_eq!(
            Bvh::build(&[tri], BuildOptions::default()),
            Err(BvhError::NonFiniteVertex(0))
        );
    }

    #[test]
    fn bytes_round_trip_and_have_the_documented_size() {
        let bvh = Bvh::build(&random_soup(300, 7), BuildOptions::default()).unwrap();
        let bytes = bvh.to_bytes();
        assert_eq!(
            bytes.len(),
            8 + 32 * bvh.nodes.len() + 48 * bvh.triangles.len()
        );
        assert_eq!(
            u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize,
            bvh.nodes.len()
        );
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize,
            bvh.triangles.len()
        );
        assert_eq!(Bvh::from_bytes(&bytes).unwrap(), bvh);
    }

    #[test]
    fn node_record_fields_sit_where_the_layout_says() {
        let bvh = Bvh::build(&random_soup(40, 3), BuildOptions::default()).unwrap();
        let bytes = bvh.to_bytes();
        let n = &bvh.nodes[1];
        let at = 8 + 32;
        assert_eq!(
            f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
            n.min[0]
        );
        assert_eq!(
            u32::from_le_bytes(bytes[at + 12..at + 16].try_into().unwrap()),
            n.a
        );
        assert_eq!(
            f32::from_le_bytes(bytes[at + 16..at + 20].try_into().unwrap()),
            n.max[0]
        );
        assert_eq!(
            u32::from_le_bytes(bytes[at + 28..at + 32].try_into().unwrap()),
            n.b
        );
    }

    #[test]
    fn corrupt_files_are_rejected() {
        let bvh = Bvh::build(&random_soup(50, 9), BuildOptions::default()).unwrap();
        let mut bytes = bvh.to_bytes();
        assert!(Bvh::from_bytes(&bytes[..bytes.len() - 1]).is_err());
        assert!(Bvh::from_bytes(&bytes[..4]).is_err());
        // A leaf that does not start where the previous one ended
        let leaf = bvh.nodes.iter().rposition(|n| n.is_leaf()).unwrap();
        let at = 8 + leaf * 32 + 28;
        bytes[at + 1] ^= 1;
        assert!(Bvh::from_bytes(&bytes).is_err());
    }

    #[test]
    fn set_splits_large_soups_and_keeps_every_triangle() {
        let soup = random_soup(2000, 11);
        let set = BvhSet::build(soup, 300, BuildOptions::default()).unwrap();
        assert!(set.parts.len() >= 7);
        assert!(set.parts.iter().all(|p| p.triangles.len() <= 300));
        assert_eq!(set.triangle_count(), 2000);
    }

    #[test]
    fn too_many_triangles_for_one_hierarchy_is_an_error() {
        let tri: Triangle = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let soup = vec![tri; MAX_TRIANGLES + 1];
        assert_eq!(
            Bvh::build(&soup, BuildOptions::default()),
            Err(BvhError::TooManyTriangles(MAX_TRIANGLES + 1))
        );
    }
}
