// Firing-position heatmap for one target. Prepended with bvh_common.wgsl by gpu.mjs.
//
// One invocation per candidate firing position of a regular grid. The ground height under the candidate is
// sampled from a 16-bit heightmap, the muzzle sits `muzzle_height` above it, and the vacuum trajectory
// (z(x) = x tan(a) - g x^2 (1 + tan(a)^2) / (2 v0^2), the closed form of squadFiringSolution.js) to the target
// is flown for both arcs: it is cut into `samples` chords that are traced against the BVH, and the clearance
// is probed with short downward rays under the interior points. Each invocation writes only its own two cells.

struct HeatParams {
    target_pos: vec4<f32>,   // xyz: target in world metres (x east, y north, z up); w: muzzle height above ground
    grid: vec4<f32>,         // x, y: world position of the grid corner; z: cell size; w: clearance probe length (m)
    ballistics: vec4<f32>,   // x: muzzle velocity v0 (m/s); y: g = 9.80 * scale (m/s^2); z: distance scale D0 (m); w: end trim (m)
    heightmap: vec4<f32>,    // x, y: world position of texel (0, 0); z: texel size (m); w: height of value 0 (m)
    heightmap_range: vec4<f32>, // x: height of value 65535 minus height of value 0 (m)
    dims: vec4<u32>,         // grid width, grid height, heightmap width, heightmap height
    config: vec4<u32>,       // node_count, chords per trajectory, 0, 0
}

// Result of one (candidate, arc) pair; cells[2 * candidate] is the low arc, cells[2 * candidate + 1] the high arc.
struct Cell {
    state: f32,        // 0 clear, 1 blocked, 2 unreachable with v0 (or the target is on the muzzle)
    clearance: f32,    // clear: smallest vertical gap (m) from an interior path point to the surface below it, capped
                       // at the probe length; blocked or unreachable: 0
    weight: f32,       // D0 / (D0 + horizontal distance): 1 on top of the target, 0.5 at D0, a heavy tail for long range
    path_fraction: f32, // blocked: where along the path the first hit is, 0..1; clear: 1; unreachable: 0
}

const STATE_CLEAR: f32 = 0.0;
const STATE_BLOCKED: f32 = 1.0;
const STATE_UNREACHABLE: f32 = 2.0;

@group(0) @binding(0) var<uniform> params: HeatParams;
@group(0) @binding(3) var<storage, read> heightmap: array<u32>;      // u16 samples, two per word, row-major
@group(0) @binding(4) var<storage, read_write> cells: array<Cell>;

fn heightmap_texel(x: i32, y: i32) -> f32 {
    let w = i32(params.dims.z);
    let h = i32(params.dims.w);
    let linear = u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1));
    let word = heightmap[linear >> 1u];
    let raw = (word >> ((linear & 1u) * 16u)) & 0xFFFFu;
    return params.heightmap.w + f32(raw) * (params.heightmap_range.x / 65535.0);
}

/// Bilinear ground height at a world position; clamps to the edge texels outside the heightmap.
fn ground_height(position: vec2<f32>) -> f32 {
    let texel = (position - params.heightmap.xy) / params.heightmap.z;
    let base = floor(texel);
    let f = texel - base;
    let ix = i32(base.x);
    let iy = i32(base.y);
    let top = mix(heightmap_texel(ix, iy), heightmap_texel(ix + 1, iy), f.x);
    let bottom = mix(heightmap_texel(ix, iy + 1), heightmap_texel(ix + 1, iy + 1), f.x);
    return mix(top, bottom, f.y);
}

/// Flies one arc (tangent of the elevation) from `muzzle` towards `direction` over `range` metres.
fn fly_arc(muzzle: vec3<f32>, direction: vec2<f32>, range: f32, tan_elevation: f32, weight: f32) -> Cell {
    let v0 = params.ballistics.x;
    let g = params.ballistics.y;
    let trim = params.ballistics.w;
    let probe = params.grid.w;
    let chords = params.config.y;
    let drop_per_x2 = g * (1.0 + tan_elevation * tan_elevation) / (2.0 * v0 * v0);

    var previous = muzzle;
    var clearance = probe;
    for (var k = 1u; k <= chords; k++) {
        let x = range * f32(k) / f32(chords);
        let point = vec3<f32>(muzzle.xy + direction * x, muzzle.z + x * tan_elevation - drop_per_x2 * x * x);
        let d = point - previous;
        let length_m = length(d);
        var t_min = 0.0;
        var t_max = 1.0;
        if (k == 1u) {
            t_min = trim / length_m;
        }
        if (k == chords) {
            t_max = 1.0 - trim / length_m;
        }
        if (t_min < t_max) {
            let found = trace_closest(previous, d, t_min, t_max, params.config.x);
            if (found.tri != NO_HIT) {
                return Cell(STATE_BLOCKED, 0.0, weight, (f32(k - 1u) + found.t) / f32(chords));
            }
        }
        if (k < chords) {
            let below = trace_closest(point, vec3<f32>(0.0, 0.0, -probe), 0.0, 1.0, params.config.x);
            if (below.tri != NO_HIT) {
                clearance = min(clearance, below.t * probe);
            }
        }
        previous = point;
    }
    return Cell(STATE_CLEAR, clearance, weight, 1.0);
}

@compute @workgroup_size(64)
fn heatmap(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let idx = gid.y * groups.x * 64u + gid.x;
    let width = params.dims.x;
    if (idx >= width * params.dims.y) {
        return;
    }
    let cell_size = params.grid.z;
    let column = idx % width;
    let row = idx / width;
    let xy = params.grid.xy + vec2<f32>(f32(column) + 0.5, f32(row) + 0.5) * cell_size;
    let muzzle = vec3<f32>(xy, ground_height(xy) + params.target_pos.w);

    let to_target = params.target_pos.xy - xy;
    let range = length(to_target);
    let unreachable = Cell(STATE_UNREACHABLE, 0.0, 0.0, 0.0);
    if (range < 1e-3) {
        cells[2u * idx] = unreachable;
        cells[2u * idx + 1u] = unreachable;
        return;
    }
    let direction = to_target / range;
    let d0 = params.ballistics.z;
    let weight = d0 / (d0 + range);

    let v2 = params.ballistics.x * params.ballistics.x;
    let g = params.ballistics.y;
    let rise = params.target_pos.z - muzzle.z;
    let discriminant = v2 * v2 - g * (g * range * range + 2.0 * rise * v2);
    if (discriminant < 0.0) {
        cells[2u * idx] = unreachable;
        cells[2u * idx + 1u] = unreachable;
        return;
    }
    let root = sqrt(discriminant);
    cells[2u * idx] = fly_arc(muzzle, direction, range, (v2 - root) / (g * range), weight);
    cells[2u * idx + 1u] = fly_arc(muzzle, direction, range, (v2 + root) / (g * range), weight);
}
