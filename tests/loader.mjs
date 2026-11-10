/**
 * Module resolution hook for the tests: SquadCalc's pure modules import `../app.js` (the whole UI) and
 * the coverage and protection zone modules import Leaflet at load time. The first is replaced by a stub holding
 * what the pure modules read from App (gravity, active weapon); Leaflet is replaced by the classes of
 * stubs/leaflet.mjs: empty ones, and a polygon that keeps what it was made with, which the tests of the protection
 * zones read. The grid, the shapes sized in metres (groundShapes.js, a Leaflet circle and the ellipse of
 * libs/leaflet-ellipse.js extended), the tile layer stretched onto another rectangle (stretchedTileLayer.js) and the
 * Leaflet regression tests use the real package.
 */
// The modules that get the real Leaflet: squadGrid.test.mjs draws the grid with it, groundShapes.test.mjs and
// protectionZone.test.mjs project the shapes sized in metres, measurePath.test.mjs loads the measured polyline,
// mapImages.test.mjs moves the tile levels of the stretched tile layer
const REAL_LEAFLET = ["/src/js/squadGrid.js", "/src/js/groundShapes.js", "/src/js/libs/leaflet-ellipse.js",
    "/src/js/libs/leaflet-measure-path.js", "/src/js/stretchedTileLayer.js"];

export async function resolve(specifier, context, nextResolve) {
    const fromSource = context.parentURL?.includes("/src/");
    if (fromSource && specifier === "../app.js") {
        return { url: new URL("./stubs/app.mjs", import.meta.url).href, shortCircuit: true };
    }
    if (fromSource && specifier === "leaflet" && !REAL_LEAFLET.some((path) => context.parentURL.endsWith(path))) {
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
