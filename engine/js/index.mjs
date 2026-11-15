// ES-module wrapper of the Squad ballistics engine (wasm). Build the module first with `js/build.sh`.
//
//   import { loadEngine } from "./index.mjs";
//   const engine = await loadEngine(wasmBytes);          // Node: fs.readFileSync(".../squad_engine_bg.wasm")
//   const response = engine.solve({ weapon_specs: { v0: 110 }, pos_gun: [0, 0], pos_target: [0, 600, 0] });
//
// In a browser `loadEngine()` without argument fetches `pkg/squad_engine_bg.wasm` next to this file.
import init, { initSync, Engine as WasmEngine, Terrain, TerrainBuilder, build_bvh, segment_triangle, has_simd } from "./pkg/squad_engine.js";

/**
 * Loads the wasm module once.
 * @param {BufferSource|WebAssembly.Module|string|URL} [wasm] - the module's bytes or compiled module, or its URL;
 *   default: `pkg/squad_engine_bg.wasm` next to this file
 * @returns {Promise<Engine>} a new engine without resources
 */
export async function loadEngine(wasm) {
    if (wasm instanceof ArrayBuffer || ArrayBuffer.isView(wasm) || wasm instanceof WebAssembly.Module) {
        initSync({ module: wasm });
    } else {
        await init(wasm === undefined ? undefined : { module_or_path: wasm });
    }
    return new Engine();
}

/** The engine with its heightmaps and BVHs; thin wrapper over the wasm class. */
export class Engine {
    #inner = new WasmEngine();

    /**
     * Registers a heightmap.
     * @param {string} reference - the name requests use in `environment.heightmap_ref`
     * @param {Uint8Array} bytes - a 16-bit grayscale PNG, or a raw G16 buffer (u32 width, u32 height, u16 samples, little endian)
     * @param {{zScale: number, resolutionM?: number, format?: "png"|"g16"}} options
     */
    loadHeightmap(reference, bytes, { zScale, resolutionM = 1, format = "png" }) {
        if (format === "g16") this.#inner.load_heightmap_g16(reference, bytes, zScale, resolutionM);
        else this.#inner.load_heightmap_png(reference, bytes, zScale, resolutionM);
    }

    /**
     * Registers a BVH.
     * @param {string} reference - the name requests use in `environment.bvh_buffer_ref`
     * @param {Uint8Array[]} parts - the `bvh.bin` buffers (one per part when a map needed several)
     */
    loadBvh(reference, parts) {
        for (const part of parts) this.#inner.load_bvh(reference, part);
    }

    /**
     * Registers voxel columns.
     * @param {string} reference - the name requests use in `environment.vcol_ref`
     * @param {Uint8Array} bytes - a `VCOL1` file, gzip as written by `codec.py` or already decompressed
     */
    loadVcol(reference, bytes) {
        this.#inner.load_vcol(reference, bytes);
    }

    /**
     * Registers a precision region: the exact triangles around one target, built offline by `build_region.py`.
     * @param {string} reference - the name requests use in `environment.region_ref`
     * @param {string} vcolReference - the voxel columns it was built against (load them first)
     * @param {Uint8Array} bytes - an `RTRI1` file, gzip or already decompressed
     */
    loadRegion(reference, vcolReference, bytes) {
        this.#inner.load_region(reference, vcolReference, bytes);
    }

    /**
     * Answers a request.
     * @param {object} request - see README.md
     * @returns {object} the response
     */
    solve(request) {
        return JSON.parse(this.#inner.run(JSON.stringify(request)));
    }

    /**
     * First hit of a segment in a registered BVH.
     * @param {string} reference
     * @param {number[]} segment - x0, y0, z0, x1, y1, z1
     * @returns {{part: number, triangle: number, t: number}|null}
     */
    firstHit(reference, segment) {
        const hit = this.#inner.first_hit(reference, Float64Array.from(segment));
        return hit.length ? { part: hit[0], triangle: hit[1], t: hit[2] } : null;
    }

    /**
     * First occupied voxel a segment enters in registered voxel columns.
     * @param {string} reference
     * @param {number[]} segment - x0, y0, z0, x1, y1, z1, in the frame of the file
     * @returns {{column: number, row: number, z: number, t: number}|null}
     */
    voxelFirstBlock(reference, segment) {
        const hit = this.#inner.voxel_first_block(reference, Float64Array.from(segment));
        return hit.length ? { column: hit[0], row: hit[1], z: hit[2], t: hit[3] } : null;
    }

    /**
     * First obstacle of a segment in the precision pass: voxels away from the region's square or its triangles
     * near a voxel inside it.
     * @param {string} reference - the region
     * @param {string} vcolReference - the voxel columns it was loaded against
     * @param {number[]} segment - x0, y0, z0, x1, y1, z1, in the frame of the file
     * @returns {{t: number, voxel: {column: number, row: number, z: number}}|{t: number, triangle: number}|null}
     */
    precisionFirstBlock(reference, vcolReference, segment) {
        const hit = this.#inner.precision_first_block(reference, vcolReference, Float64Array.from(segment));
        if (!hit.length) return null;
        return hit[1] === 0
            ? { t: hit[0], voxel: { column: hit[2], row: hit[3], z: hit[4] } }
            : { t: hit[0], triangle: hit[2] };
    }
}

// Levels copied, and quads of detail decoded, between two pauses of a build in slices (a few milliseconds each)
const LEVELS_PER_SLICE = 2 ** 21;
const QUADS_PER_SLICE = 64;

/**
 * A heightmap of 16-bit levels read in the engine's frame (X east, Y north, metres): sample `(row, col)` lies at
 * `origin + col * spacing * (cos yaw, sin yaw) + row * spacing * (sin yaw, -cos yaw)` and its height is
 * `zMin + level * zStep`; every quad of four samples is two triangles split along the diagonal from its `(row, col)`
 * corner to its `(row + 1, col + 1)` corner, as the game's landscape collision is. The site's `meta.json` states the
 * lattice in Unreal's frame (Y south, yaw clockwise): negate the Y of its `origin_m` and its `yaw_deg`. Load the
 * engine (`loadEngine`) first.
 */
export class Heightmap {
    #inner;

    /**
     * @param {Uint16Array|Terrain} levels - `width * height` levels, row 0 first; copied into the module in one call,
     *   which takes long on the largest maps: `Heightmap.fromSlices` copies them in slices (and hands this constructor
     *   its result)
     * @param {{width: number, height: number, zMin?: number, zStep: number, origin: [number, number], spacing: number, yawDeg?: number}} frame
     * @throws {Error} - when the grid is smaller than 2 x 2, `levels` has another length, or a number of the frame
     *   is not finite or the spacing not positive
     */
    constructor(levels, { width, height, zMin = 0, zStep, origin, spacing, yawDeg = 0 }) {
        this.#inner = levels instanceof Terrain
            ? levels
            : new Terrain(levels, width, height, zMin, zStep, origin[0], origin[1], spacing, yawDeg);
    }

    /**
     * A heightmap as `new Heightmap(levels, frame)`, whose levels are copied into the module a few rows at a time, so
     * that the page can answer between the slices
     * @param {Uint16Array} levels - `width * height` levels, row 0 first
     * @param {object} frame - see the constructor
     * @param {function(): (Promise<void>|void)} pause - awaited after each slice; it may take the time to let the page
     *   work, or throw to give the build up
     * @returns {Promise<Heightmap>}
     * @throws {Error} - as the constructor, and whatever `pause` throws
     */
    static async fromSlices(levels, frame, pause) {
        const { width, height, zMin = 0, zStep, origin, spacing, yawDeg = 0 } = frame;
        const builder = new TerrainBuilder(width, height, zMin, zStep, origin[0], origin[1], spacing, yawDeg);
        try {
            for (let first = 0; first < levels.length; first += LEVELS_PER_SLICE) {
                builder.push_rows(levels.subarray(first, first + LEVELS_PER_SLICE));
                await pause();
            }
        } catch (error) {
            builder.free();
            throw error;
        }
        return new Heightmap(builder.finish(), frame);
    }

    /**
     * Adds the detail layer: where objects stand, quads are read on a sub-grid, and a quad without detail takes the
     * nodes it shares with one that has it, so the surface has no jump (`HMD1`, the site's `heightmap.detail.bin`).
     * @param {Uint8Array} bytes - the file, gzip or already decompressed
     * @throws {Error} - on a detail of another grid or a damaged file; the heightmap then keeps reading without it
     */
    loadDetail(bytes) {
        this.#inner.set_detail(bytes);
    }

    /**
     * `loadDetail` that decodes the file a few quads at a time, so that the page can answer between the slices; the
     * detail is in use once the promise resolves; do not free the heightmap before.
     * @param {Uint8Array} bytes - the file, gzip or already decompressed
     * @param {function(): (Promise<void>|void)} pause - awaited after each slice, as in `fromSlices`
     * @returns {Promise<void>}
     * @throws {Error} - as `loadDetail`, and whatever `pause` throws
     */
    async loadDetailInSlices(bytes, pause) {
        this.#inner.begin_detail(bytes);
        while (!this.#inner.step_detail(QUADS_PER_SLICE)) await pause();
    }

    /**
     * Height at a point.
     * @param {number} x - metres east
     * @param {number} y - metres north
     * @returns {number} metres (`zMin + level * zStep`); NaN more than half a sample outside the lattice and for a
     *   non-finite coordinate
     */
    heightAt(x, y) {
        return this.#inner.height_at(x, y);
    }

    /**
     * Heights at many points, in one call.
     * @param {Float64Array|number[]} xy - x0, y0, x1, y1, ... metres east and north
     * @returns {Float64Array} one height per point, NaN where `heightAt` gives NaN
     * @throws {Error} - when `xy` has an odd length
     */
    heights(xy) {
        return this.#inner.heights(xy);
    }

    /** Frees the module's memory of this heightmap; it must not be read afterwards. */
    free() {
        this.#inner.free();
    }
}

/**
 * Builds a `bvh.bin` from triangle bytes.
 * @param {Uint8Array} triangleBytes - nine little-endian f32 per triangle (at most 2^24 triangles)
 * @returns {Uint8Array}
 */
export function buildBvh(triangleBytes) {
    return build_bvh(triangleBytes);
}

/**
 * The f32 segment/triangle test of the GPU path.
 * @param {number[]} origin
 * @param {number[]} direction
 * @param {number[]} triangle - 9 numbers
 * @returns {number} t, or NaN for a miss
 */
export function segmentTriangle(origin, direction, triangle) {
    return segment_triangle(Float32Array.from(origin), Float32Array.from(direction), Float32Array.from(triangle));
}

/** @returns {boolean} whether this build uses the SIMD128 triangle test */
export function hasSimd() {
    return has_simd();
}
