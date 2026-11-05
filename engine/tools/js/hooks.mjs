// Node module hooks for the parity reference: SquadCalc's ../app.js (the whole UI) and leaflet are replaced by stubs.
import { registerHooks } from "node:module";

registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "../app.js") return { url: new URL("./stub-app.mjs", import.meta.url).href, shortCircuit: true };
        if (specifier === "leaflet") return { url: new URL("./stub-leaflet.mjs", import.meta.url).href, shortCircuit: true };
        return next(specifier, context);
    },
});
