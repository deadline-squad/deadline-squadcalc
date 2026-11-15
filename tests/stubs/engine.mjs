// Stands for src/js/squadEngine.js: the real WebAssembly engine (npm run build:engine puts it in public/engine), loaded
// from the file system instead of the page's URL
import { readFile } from "node:fs/promises";

const ENGINE = new URL("../../public/engine/", import.meta.url);
let loading = null;

/**
 * @returns {Promise<typeof import("../../engine/js/index.mjs")>} - the engine module, initialised
 * @throws {Error} - when the engine was not built
 */
export function loadCore() {
    loading ??= (async () => {
        const wasm = await readFile(new URL("pkg/squad_engine_bg.wasm", ENGINE)).catch(() => {
            throw new Error("the engine is not built: run `npm run build:engine` first");
        });
        const module = await import(new URL("index.mjs", ENGINE).href);
        await module.loadEngine(wasm);
        return module;
    })();
    return loading;
}
