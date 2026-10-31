/**
 * Module resolution hook for the tests: SquadCalc's pure modules import `../app.js` (the whole UI) and
 * the coverage module imports Leaflet at load time. The first is replaced by a stub holding what the
 * pure modules read from App (gravity, active weapon); Leaflet is replaced by empty classes, because the
 * pure functions under test never use it (the Leaflet regression tests import the real package).
 */
export async function resolve(specifier, context, nextResolve) {
    const fromSource = context.parentURL?.includes("/src/");
    if (fromSource && specifier === "../app.js") {
        return { url: new URL("./stubs/app.mjs", import.meta.url).href, shortCircuit: true };
    }
    if (fromSource && specifier === "leaflet") {
        return { url: new URL("./stubs/leaflet.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
