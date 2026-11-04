// ES-module wrapper of the Squad ballistics engine (wasm). Build the module first with `js/build.sh`.
//
//   import { loadEngine } from "./index.mjs";
//   const engine = await loadEngine(wasmBytes);          // Node: fs.readFileSync(".../squad_engine_bg.wasm")
//   const response = engine.solve({ weapon_specs: { v0: 110 }, pos_gun: [0, 0], pos_target: [0, 600, 0] });
//
// In a browser `loadEngine()` without argument fetches `pkg/squad_engine_bg.wasm` next to this file.
import init, { initSync, Engine as WasmEngine, build_bvh, segment_triangle, has_simd } from "./pkg/squad_engine.js";

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
