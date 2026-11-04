// Segment traversal of the sparse voxel columns (VCOL1, see engine/src/voxel.rs). Standalone: it does not use
// bvh_common.wgsl and has its own bind group.
//
// Entry point `voxel_segments`: one invocation per segment, the first occupied voxel the segment enters or
// "clear". Same algorithm as VoxelColumns::first_block in Rust: a 2D DDA over the (column, row) cells the
// segment crosses and, inside each cell, a jump to the first occupied voxel of the column's runs that the
// segment's height range reaches.
//
// Coordinates are metres relative to the grid's lowest corner (min_x, min_y, z_min): the host subtracts the
// origin in float64 before it narrows to f32, so f32 keeps its precision at the far end of an 8 km map.
// Every invocation writes only hits[its own linear index]: no atomics, no races.

struct Params {
    count: u32,         // segments
    column_count: u32,  // occupied columns (length of ids)
    width: u32,         // cells along X
    height: u32,        // cells along Y
    cell: f32,          // horizontal voxel edge, metres
    dz: f32,            // vertical voxel edge, metres
    _pad0: u32,
    _pad1: u32,
}

struct VoxelHit {
    t: f32,             // entry point as a fraction of the segment, 1.0 when clear
    column: u32,        // NO_HIT when the segment is clear
    row: u32,
    z: u32,
}

struct ColumnHit {
    z: u32,             // NO_HIT when the part of the segment inside this column meets no voxel
    t: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> ids: array<u32>;               // occupied column ids (row * width + column), ascending
@group(0) @binding(2) var<storage, read> first_run: array<u32>;         // column_count + 1 offsets into runs, in runs
@group(0) @binding(3) var<storage, read> runs: array<u32>;              // [start, end) height-index pairs
@group(0) @binding(4) var<storage, read> segments: array<vec4<f32>>;    // 2 per segment: p0, p1 (w unused)
@group(0) @binding(5) var<storage, read_write> hits: array<VoxelHit>;

const NO_HIT: u32 = 0xFFFFFFFFu;
const Z_COUNT: f32 = 4096.0;
// Stands for an infinite crossing time of an axis the segment does not move along.
const FAR: f32 = 1e30;

/// Index into ids of the column with this id, NO_HIT when it is empty. Binary search.
fn find_column(id: u32) -> u32 {
    var low = 0u;
    var high = params.column_count;
    while (low < high) {
        let mid = (low + high) >> 1u;
        if (ids[mid] < id) {
            low = mid + 1u;
        } else {
            high = mid;
        }
    }
    if (low < params.column_count && ids[low] == id) {
        return low;
    }
    return NO_HIT;
}

/// The first voxel of column `column` (an index into ids) that the part t_in..t_out of a segment enters; the
/// segment's height in voxel units is z0 + dz * t.
fn first_in_column(column: u32, z0: f32, dz: f32, t_in: f32, t_out: f32) -> ColumnHit {
    let top = Z_COUNT - 1.0;
    let at_in = u32(clamp(floor(z0 + dz * t_in), 0.0, top));
    let at_out = u32(clamp(floor(z0 + dz * t_out), 0.0, top));
    let low = min(at_in, at_out);
    let high = max(at_in, at_out);
    let begin = first_run[column];
    let end = first_run[column + 1u];

    if (dz >= 0.0) {
        for (var r = begin; r < end; r++) {
            let start = runs[2u * r];
            let stop = runs[2u * r + 1u];
            if (stop > low && start <= high) {
                let voxel = max(start, low);
                var t = t_in;
                if (dz != 0.0) {
                    t = clamp((f32(voxel) - z0) / dz, t_in, t_out);
                }
                return ColumnHit(voxel, t);
            }
        }
        return ColumnHit(NO_HIT, 1.0);
    }
    for (var r = end; r > begin; r--) {
        let start = runs[2u * (r - 1u)];
        let stop = runs[2u * (r - 1u) + 1u];
        if (stop > low && start <= high) {
            let voxel = min(stop - 1u, high);
            let t = clamp((f32(voxel) + 1.0 - z0) / dz, t_in, t_out);
            return ColumnHit(voxel, t);
        }
    }
    return ColumnHit(NO_HIT, 1.0);
}

fn trace_voxels(p0: vec3<f32>, p1: vec3<f32>) -> VoxelHit {
    let clear = VoxelHit(1.0, NO_HIT, NO_HIT, NO_HIT);
    let unit = vec3<f32>(params.cell, params.cell, params.dz);
    let origin = p0 / unit;
    let delta = (p1 - p0) / unit;
    let extent = vec3<f32>(f32(params.width), f32(params.height), Z_COUNT);

    // Clip the segment to the grid's box
    var t_start = 0.0;
    var t_end = 1.0;
    for (var axis = 0; axis < 3; axis++) {
        if (delta[axis] == 0.0) {
            if (origin[axis] < 0.0 || origin[axis] >= extent[axis]) {
                return clear;
            }
            continue;
        }
        let a = -origin[axis] / delta[axis];
        let b = (extent[axis] - origin[axis]) / delta[axis];
        t_start = max(t_start, min(a, b));
        t_end = min(t_end, max(a, b));
    }
    if (t_start > t_end) {
        return clear;
    }

    var cell = vec2<i32>(0);
    var step = vec2<i32>(0);
    var t_next = vec2<f32>(FAR);
    var t_step = vec2<f32>(FAR);
    for (var axis = 0; axis < 2; axis++) {
        let at_start = origin[axis] + delta[axis] * t_start;
        cell[axis] = i32(clamp(floor(at_start), 0.0, extent[axis] - 1.0));
        if (delta[axis] != 0.0) {
            var boundary = f32(cell[axis]);
            step[axis] = -1;
            if (delta[axis] > 0.0) {
                boundary = boundary + 1.0;
                step[axis] = 1;
            }
            t_next[axis] = (boundary - origin[axis]) / delta[axis];
            t_step[axis] = 1.0 / abs(delta[axis]);
        }
    }

    var t_in = t_start;
    // A segment crosses at most width + height cells; the bound keeps a rounding accident from hanging the GPU
    for (var iteration = 0u; iteration <= params.width + params.height + 2u; iteration++) {
        let t_out = min(min(t_next.x, t_next.y), t_end);
        let id = u32(cell.y) * params.width + u32(cell.x);
        let column = find_column(id);
        if (column != NO_HIT) {
            let found = first_in_column(column, origin.z, delta.z, t_in, t_out);
            if (found.z != NO_HIT) {
                return VoxelHit(found.t, u32(cell.x), u32(cell.y), found.z);
            }
        }
        if (t_out >= t_end) {
            return clear;
        }
        if (t_next.x <= t_out) {
            cell.x += step.x;
            t_next.x += t_step.x;
        }
        if (t_next.y <= t_out) {
            cell.y += step.y;
            t_next.y += t_step.y;
        }
        if (cell.x < 0 || cell.y < 0 || cell.x >= i32(params.width) || cell.y >= i32(params.height)) {
            return clear;
        }
        t_in = t_out;
    }
    return clear;
}

@compute @workgroup_size(64)
fn voxel_segments(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let idx = gid.y * groups.x * 64u + gid.x;
    if (idx >= params.count) {
        return;
    }
    hits[idx] = trace_voxels(segments[2u * idx].xyz, segments[2u * idx + 1u].xyz);
}
