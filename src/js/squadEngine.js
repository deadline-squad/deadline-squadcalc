import pkg from "../../package.json";

/**
 * The WebAssembly engine on the page (engine/, built by scripts/build-engine.sh into public/engine): the Rust core
 * that reads the heights (SquadHeightmap). It is fetched and compiled once, when the first heightmap asks for it, and
 * not while the page waits: the heightmap's own files load meanwhile.
 * The volume worker loads its own instance (volumeWorker.js).
 */
let loading = null;

/**
 * Load the engine module once; a load that failed is tried again by the next call
 * @returns {Promise<typeof import("../../engine/js/index.mjs")>} - the module of engine/js/index.mjs, initialised
 * @throws {Error} - when public/engine is missing (the engine was not built) or cannot be compiled
 */
export function loadCore() {
    loading ??= load().catch((error) => {
        loading = null;
        throw error;
    });
    return loading;
}

/**
 * Fetch the module and the wasm, cache-busted by the version of the page like the volume layer's copy
 * @returns {Promise<typeof import("../../engine/js/index.mjs")>}
 */
async function load() {
    const engineUrl = new URL(`/engine/index.mjs?v=${pkg.version}`, window.location.origin).href;
    const wasmUrl = new URL(`/engine/pkg/squad_engine_bg.wasm?v=${pkg.version}`, window.location.origin).href;
    const module = await import(/* webpackIgnore: true */ engineUrl);
    await module.loadEngine(wasmUrl);
    return module;
}
