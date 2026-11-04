# Tests

`npm test` runs `node --test` over `tests/` (no extra dependency; Node >= 22.13). The pure modules
(`squadBallistics.js`, `squadDamage.js`, `squadHeightmaps.js`, `squadFiringSolution.js`, `squadWeapons.js`,
`weapons.js`) import `../app.js` (the whole UI); `register.mjs` preloads `loader.mjs`, which replaces it
with `stubs/app.mjs` (gravity and the active weapon) and, for modules in `src/`, Leaflet with empty
classes. `leaflet.test.mjs` imports the real Leaflet 2 package.

- `squadBallistics.test.mjs`: elevation roots, range, and that the solved elevation lands the shot of every kind of weapon.
- `squadDamage.test.mjs`: damage falloff, cover, hit probability, rounds needed.
- `squadHeightmaps.test.mjs`: height interpolation (the game's triangle rule), edges, height path.
- `weapons.test.mjs`: invariants of the `weapons.js` data.
- `hitProbability.test.mjs`: the hit probability of direct-fire weapons from a muzzle above the ground against a simulation of the game's cone (#19).
- `leaflet.test.mjs`: Leaflet 2 event names (pointer, not mouse; `bubblingPointerEvents`).

What needs a browser (hover, drag, clean console on a served build) is covered by
`tools/browser_check/browser_check.mjs` in the deployment repository (Playwright and Chromium).
CI: `.github/workflows/test.yml`.
