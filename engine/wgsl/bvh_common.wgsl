// Shared BVH layer of the Squad ballistics compute shaders (prepended to trace.wgsl / heatmap.wgsl by gpu.mjs;
// WGSL has no #include). Reads the engine export layout, see README.md:
//   node = 32 bytes { min.xyz f32, a u32, max.xyz f32, b u32 }
//     a = escape index (next node when the ray misses the box or the subtree is done, 0xFFFFFFFF = end)
//     b = (first_triangle << 8 | triangle_count) for a leaf (count 1..255), 0 for an inner node whose first
//         child is the node at index + 1
//   triangle = 3 x vec4<f32> (xyz, pad) in leaf order
// Traversal is stackless and non-recursive: it keeps a node index and the closest hit, nothing else.

struct Node {
    box_min: vec3<f32>,
    escape: u32,
    box_max: vec3<f32>,
    leaf: u32,
}

@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> tris: array<vec4<f32>>;

const NO_HIT: u32 = 0xFFFFFFFFu;
const END_OF_TRAVERSAL: u32 = 0xFFFFFFFFu;
// Box slack in metres: absorbs the f32 rounding of the slab test so that a hit on a leaf's face is not lost.
const BOX_PAD: f32 = 1e-3;
// Moller-Trumbore determinant below which the ray is treated as parallel to the triangle (as reference.py).
const DET_EPS: f32 = 1e-12;
// Direction components below this are replaced, so that 1 / d stays finite (no inf * 0 = NaN in the slab test).
const DIR_EPS: f32 = 1e-30;

struct Closest {
    t: f32,
    tri: u32,
}

/// Closest hit of the segment o + t * d, t in [t_min, t_max], with the triangles under the BVH.
/// `d` is not normalised: t is the segment fraction when d = p1 - p0. Triangle ids are in leaf order.
/// Returns tri = NO_HIT (and t = t_max) when nothing is hit. Double-sided, like reference.py.
fn trace_closest(o: vec3<f32>, d: vec3<f32>, t_min: f32, t_max: f32, node_count: u32) -> Closest {
    var best = Closest(t_max, NO_HIT);
    let safe_d = select(d, vec3<f32>(DIR_EPS), abs(d) < vec3<f32>(DIR_EPS));
    let inv_d = 1.0 / safe_d;

    var i = 0u;
    // Every node is visited at most once in a forward-only traversal, so node_count steps always suffice
    // and a corrupt escape chain cannot hang the GPU.
    for (var step = 0u; step < node_count && i != END_OF_TRAVERSAL; step++) {
        let node = nodes[i];
        let t0 = (node.box_min - vec3<f32>(BOX_PAD) - o) * inv_d;
        let t1 = (node.box_max + vec3<f32>(BOX_PAD) - o) * inv_d;
        let near = min(t0, t1);
        let far = max(t0, t1);
        let enter = max(max(near.x, near.y), max(near.z, t_min));
        let leave = min(min(far.x, far.y), min(far.z, best.t));
        if (enter > leave) {
            i = node.escape;
            continue;
        }
        if (node.leaf == 0u) {
            i = i + 1u;
            continue;
        }

        let first = node.leaf >> 8u;
        let count = node.leaf & 255u;
        for (var k = 0u; k < count; k++) {
            let tri = first + k;
            let a = tris[3u * tri].xyz;
            let e1 = tris[3u * tri + 1u].xyz - a;
            let e2 = tris[3u * tri + 2u].xyz - a;
            let h = cross(d, e2);
            let det = dot(e1, h);
            if (abs(det) <= DET_EPS) {
                continue;
            }
            let inv_det = 1.0 / det;
            let s = o - a;
            let u = inv_det * dot(s, h);
            if (u < 0.0 || u > 1.0) {
                continue;
            }
            let q = cross(s, e1);
            let v = inv_det * dot(d, q);
            if (v < 0.0 || u + v > 1.0) {
                continue;
            }
            let t = inv_det * dot(e2, q);
            if (t >= t_min && t <= best.t) {
                best = Closest(t, tri);
            }
        }
        i = node.escape;
    }
    return best;
}
