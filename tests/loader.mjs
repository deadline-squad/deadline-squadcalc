/**
 * Module resolution hook for the tests: SquadCalc's pure modules import `../app.js` (the whole UI) and
 * the coverage and protection zone modules import Leaflet at load time. The first is replaced by a stub holding
 * what the pure modules read from App (gravity, active weapon); Leaflet is replaced by the classes of
 * stubs/leaflet.mjs: empty ones, and a circle and a polygon that keep what they were made with, which the tests of
 * the protection zones read (the Leaflet regression tests import the real package).
 */
export async function resolve(specifier, context, nextResolve) {
    const fromSource = context.parentURL?.includes("/src/");
    if (fromSource && specifier === "../app.js") {
        return { url: new URL("./stubs/app.mjs", import.meta.url).href, shortCircuit: true };
    }
    // squadGrid.test.mjs draws the grid with the real Leaflet
    if (fromSource && specifier === "leaflet" && !context.parentURL.endsWith("/src/js/squadGrid.js")) {
        return { url: new URL("./stubs/leaflet.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}


/**
 * `import pkg from "../../package.json"` of the sources is resolved by webpack without an import attribute;
 * Node needs one, so the file is served as a module that exports the parsed JSON.
 */
export async function load(url, context, nextLoad) {
    if (!url.endsWith("/package.json") || context.importAttributes?.type === "json") return nextLoad(url, context);
    const { readFile } = await import("node:fs/promises");
    const source = `export default ${await readFile(new URL(url), "utf8")};`;
    return { format: "module", source, shortCircuit: true };
}
