// Ray-segment traversal against the engine BVH. Prepended with bvh_common.wgsl by gpu.mjs.
//
// Entry points (one pipeline each, same bind group layout):
//   trace_segments      one invocation per segment: first hit (t, triangle, point) of p0 -> p1
//   trace_trajectories  one invocation per trajectory of `seg_per_traj` consecutive segments: the first
//                       occluded segment of the whole path
// Every invocation writes only hits[its own linear index]: no atomics, no races.

struct Params {
    count: u32,         // segments (trace_segments) or trajectories (trace_trajectories)
    node_count: u32,
    flags: u32,         // bit 0: ACCUMULATE, keep a closer hit already in hits[] (multi-chunk BVH, see README)
    tri_base: u32,      // added to the reported triangle id (first triangle of this chunk in the whole scene)
    seg_per_traj: u32,
    end_trim: f32,      // metres cut off the start of a trajectory's first and the end of its last segment
    _pad0: u32,
    _pad1: u32,
}

struct SegmentHit {
    point: vec3<f32>,   // p0 + t * (p1 - p0); the segment end when nothing is hit
    t: f32,             // segment fraction of the hit, 1.0 when nothing is hit
    tri: u32,           // triangle id in leaf order (+ tri_base), NO_HIT when nothing is hit
    seg: u32,           // trace_segments: the segment index; trace_trajectories: the occluded segment, NO_HIT if clear
    _pad0: u32,
    _pad1: u32,
}

const ACCUMULATE: u32 = 1u;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> segments: array<vec4<f32>>;   // 2 per segment: p0, p1 (w unused)
@group(0) @binding(4) var<storage, read_write> hits: array<SegmentHit>;

fn linear_index(gid: vec3<u32>, groups: vec3<u32>) -> u32 {
    return gid.y * groups.x * 64u + gid.x;
}

@compute @workgroup_size(64)
fn trace_segments(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let idx = linear_index(gid, groups);
    if (idx >= params.count) {
        return;
    }
    let p0 = segments[2u * idx].xyz;
    let p1 = segments[2u * idx + 1u].xyz;

    var t_max = 1.0;
    let previous = hits[idx];
    let carried = (params.flags & ACCUMULATE) != 0u && previous.tri != NO_HIT;
    if (carried) {
        t_max = previous.t;
    }

    let found = trace_closest(p0, p1 - p0, 0.0, t_max, params.node_count);
    if (found.tri == NO_HIT) {
        if (!carried) {
            hits[idx] = SegmentHit(p1, 1.0, NO_HIT, idx, 0u, 0u);
        }
        return;
    }
    hits[idx] = SegmentHit(p0 + found.t * (p1 - p0), found.t, found.tri + params.tri_base, idx, 0u, 0u);
}

@compute @workgroup_size(64)
fn trace_trajectories(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let idx = linear_index(gid, groups);
    if (idx >= params.count) {
        return;
    }
    let n = params.seg_per_traj;
    var result = SegmentHit(vec3<f32>(0.0), 1.0, NO_HIT, NO_HIT, 0u, 0u);
    for (var s = 0u; s < n; s++) {
        let base = 2u * (idx * n + s);
        let p0 = segments[base].xyz;
        let p1 = segments[base + 1u].xyz;
        let d = p1 - p0;
        let length_m = length(d);
        result.point = p1;
        if (length_m <= 0.0) {
            continue;
        }
        var t_min = 0.0;
        var t_max = 1.0;
        if (s == 0u) {
            t_min = params.end_trim / length_m;
        }
        if (s == n - 1u) {
            t_max = 1.0 - params.end_trim / length_m;
        }
        if (t_min >= t_max) {
            continue;
        }
        let found = trace_closest(p0, d, t_min, t_max, params.node_count);
        if (found.tri != NO_HIT) {
            result = SegmentHit(p0 + found.t * d, found.t, found.tri + params.tri_base, s, 0u, 0u);
            break;
        }
    }
    hits[idx] = result;
}
