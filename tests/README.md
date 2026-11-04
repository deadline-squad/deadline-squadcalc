# Tests

`npm test` runs `node --test` over `tests/` (no extra dependency; Node >= 22.13). The pure modules
(`squadBallistics.js`, `squadDamage.js`, `squadHeightmaps.js`, `squadFiringSolution.js`, `squadWeapons.js`,
`weapons.js`) import `../app.js` (the whole UI); `register.mjs` preloads `loader.mjs`, which replaces it
with `stubs/app.mjs` (gravity and the active weapon) and, for modules in `src/`, Leaflet with empty
classes. `leaflet.test.mjs` imports the real Leaflet 2 package.

- `squadBallistics.test.mjs`: elevation roots, range, and that the solved elevation lands the shot of every kind of weapon.
- `squadDamage.test.mjs`: damage falloff, cover, hit probability, rounds needed.
- `squadHeightmaps.test.mjs`: height interpolation (the game's triangle rule), edges, height path.
- `structureDamage.test.mjs`: damage of shells to player-built structures (the native rules of ASQDeployable::TakeDamage on a made-up wall: direct-hit multiplier, no direct-radial multiplier, minimum-damage floor, only-direct near miss, exact damage-type class, burst distance; and the game data for the mortar round and HEAT against the FOB radio and a HAB, `structureOutcome`, and the links of `src/data/structureLinks.js` to the shells of `weapons.js`).
- `weapons.test.mjs`: invariants of the `weapons.js` data.
- `hitProbability.test.mjs`: the hit probability of direct-fire weapons from a muzzle above the ground against a simulation of the game's cone (#19).
- `volumeTerrain.test.mjs`: the `TER1` landscape file of the volume layer (decoding, the game's triangle rule, holes).
- `targetHeights.test.mjs`: the heights a vertical ray offers (floor, ceiling, roof, window, doorway) from the solids it crosses.
- `targetHeight.test.mjs`: a target with a height of its own in the firing solution and the line-of-fire samples.
- `structureInfo.test.mjs`: the marker near a target and the structure line of the dialog and popups.
- `volumeLayer.test.mjs`: the volume worker end to end on a synthetic wall with a doorway and a small house (the `column` query of the target heights) through the real WebAssembly engine (skipped unless `npm run build:engine` was run), and the structures of the fire-coverage classifier.
- `leaflet.test.mjs`: Leaflet 2 event names (pointer, not mouse; `bubblingPointerEvents`).

What needs a browser (hover, drag, clean console on a served build) is covered by
`tools/browser_check/browser_check.mjs`, `volume_check.mjs` (the volume layer) and `targets_check.mjs` (target heights, structure damage) in the deployment repository (Playwright and Chromium).
CI: `.github/workflows/test.yml`.
