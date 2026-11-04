# Tests

`npm test` runs `node --test` over `tests/` (no extra dependency; Node >= 22.13). The pure modules
(`squadBallistics.js`, `squadDamage.js`, `squadHeightmaps.js`, `squadFiringSolution.js`, `squadWeapons.js`,
`weapons.js`) import `../app.js` (the whole UI); `register.mjs` preloads `loader.mjs`, which replaces it
with `stubs/app.mjs` (gravity and the active weapon) and, for modules in `src/`, Leaflet with empty
classes. `leaflet.test.mjs` imports the real Leaflet 2 package.

- `squadBallistics.test.mjs`: elevation roots, range, and that the solved elevation lands the shot of every kind of weapon.
- `squadDamage.test.mjs`: damage falloff, cover, hit probability, rounds needed.
- `squadHeightmaps.test.mjs`: height interpolation (the game's triangle rule), edges, height path.
- `structureDamage.test.mjs`: damage of shells to player-built structures (arithmetic on a made-up wall, and the game data for the mortar round and HEAT against the FOB radio and a HAB).
- `weapons.test.mjs`: invariants of the `weapons.js` data.
- `hitProbability.test.mjs`: the hit probability of direct-fire weapons from a muzzle above the ground against a simulation of the game's cone (#19).
- `volumeTerrain.test.mjs`: the `TER1` landscape file of the volume layer (decoding, the game's triangle rule, holes).
- `volumeLayer.test.mjs`: the volume worker end to end on a synthetic wall with a doorway through the real WebAssembly engine (skipped unless `npm run build:engine` was run), and the structures of the fire-coverage classifier.
- `leaflet.test.mjs`: Leaflet 2 event names (pointer, not mouse; `bubblingPointerEvents`).

What needs a browser (hover, drag, clean console on a served build) is covered by
`tools/browser_check/browser_check.mjs` and `volume_check.mjs` (the volume layer) in the deployment repository (Playwright and Chromium).
CI: `.github/workflows/test.yml`.
