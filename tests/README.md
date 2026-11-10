# Tests

`npm test` runs `node --test` over the `tests/*.test.mjs` glob (no extra dependency; Node >= 22.13; from Node 22 a directory
argument is no longer searched, it fails with `ERR_UNSUPPORTED_DIR_IMPORT`, so the script names the files by glob; CI runs it on
Node 22). `leaflet.test.mjs` and `structureInfo.test.mjs` import the packages `leaflet` and `i18next`: run `npm ci` first, on a
checkout without `node_modules` they stop with `ERR_MODULE_NOT_FOUND`. The pure modules
(`squadBallistics.js`, `squadDamage.js`, `squadHeightmaps.js`, `squadFiringSolution.js`, `squadWeapons.js`,
`weapons.js`) import `../app.js` (the whole UI); `register.mjs` preloads `loader.mjs`, which replaces it
with `stubs/app.mjs` (gravity and the active weapon) and, for modules in `src/`, Leaflet with empty
classes. `leaflet.test.mjs` imports the real Leaflet 2 package. `fixtures/` holds data the tests compare with: tables
read from the game files and answers of the layer API, each file naming its source.

- `squadBallistics.test.mjs`: elevation roots, range, that the solved elevation lands the shot of every kind of weapon, and that a target the muzzle is not short of has no elevation on any weapon whose muzzle is ahead of its pivot.
- `squadDamage.test.mjs`: damage falloff, cover, hit probability, rounds needed, and `damageField` with the objects of the volume layer as cover (the blocked-between-clearances callback, the landscape still covering, the impact height).
- `squadHeightmaps.test.mjs`: height interpolation (the game's triangle rule), edges, height path.
- `structureDamage.test.mjs`: damage of shells to player-built structures (the native rules of ASQDeployable::TakeDamage on a made-up wall: direct-hit multiplier, no direct-radial multiplier, minimum-damage floor, only-direct near miss, exact damage-type class, burst distance; and the game data for the mortar round and HEAT against the FOB radio and a HAB, `structureOutcome`, and the links of `src/data/structureLinks.js` to the shells of `weapons.js`).
- `weapons.test.mjs`: invariants of the `weapons.js` data (among them: a Squad Ballistics name, current, of another view or from before a rename, belongs to one weapon only; the old name of a view stands for a view of the same weapon); the elevation ranges of the artillery weapons against the pitch ranges of their mounts in the game, their minimum distances against the range at the mount's stop, and the range circles of the mortar and hell cannon markers.
- `ballisticsNames.test.mjs`: the weapon a Squad Ballistics name selects through `window.squadBallistics.selectWeapon` and the name reported back (`ballisticsNames.js`): its own name, the name of another view of it, a name from before a rename (the weapon's, reported as its current one; a view's, reported as that view), with the weapons of `weapons.js`.
- `maps.test.mjs`: the map list (25 maps, each named once and in six languages), the landscape origin, size and scale of every map against the game's level data, and the FOB exclusion radius of a layer (`fobExclusionRadius`). `squadVolume.test.mjs` also checks that a `meta.json` without a `volume` entry starts no worker and keeps the heightmap.
- `hitProbability.test.mjs`: the hit probability of direct-fire weapons from a muzzle above the ground against a simulation of the game's cone (#19).
- `volumeTerrain.test.mjs`: the `TER1` landscape file of the volume layer (decoding, the game's triangle rule, holes).
- `targetHeights.test.mjs`: the heights a vertical ray offers (floor, ceiling, roof, window, doorway) from the solids it crosses.
- `targetHeight.test.mjs`: a target with a height of its own in the firing solution and the line-of-fire samples.
- `structureInfo.test.mjs`: the marker near a target and the structure line of the dialog and popups.
- `targetPopup.test.mjs`: the content of a target's calculation popup (`targetPopup.js`): the line of the height chosen in the dialog, the elevation following the height, the ammunition and the weapon, and the order of the lines.
- `volumeLayer.test.mjs`: the volume worker end to end on a synthetic wall with a doorway and a small house (the `column` query of the target heights, the `cover` damage zone: a soldier behind the wall is covered, one in line with the doorway is not; the `heat` reverse-position heatmap: positions behind the wall blocked, those in line with the doorway clear) through the real WebAssembly engine (skipped unless `npm run build:engine` was run), and the structures of the fire-coverage classifier.
- `positionHeatmap.test.mjs`: the reverse-position heatmap's scoring (closer is better, a long shot stays viable, clearance counts), the classification of positions on flat ground, behind a ridge, out of the map and out of the weapon's reach, the polylines handed to the objects callback, the image, and the choice of a precision region.
- `squadVolume.test.mjs`: the load of the volume layer when the setting is switched while meta.json is being fetched (one worker, `volume:ready` once). `sha256.test.mjs`: the plain-JavaScript SHA-256 against `node:crypto`.
- `serversSource.test.mjs`: the servers of server mode (the home feed of the Deadline game server): the map of a layer for every map (the longest name when one map's name starts another's), a feed older than two minutes or malformed is dropped (its age counted from the `Date` of its response, from the device's clock when the response has none), a missing feed gives no servers, a read that fails leaves the servers of the last read until their feed is two minutes old (`feedReader`, `serversAfterRead`), and what server mode does with the followed server after a read of the feed (`followDecision`: open the layer it plays, stay, or leave because the server is not in the feed or plays what the calculator cannot show, `canFollow`).
- `leaflet.test.mjs`: Leaflet 2 event names (pointer, not mouse; `bubblingPointerEvents`).
- `protectionZone.test.mjs`: what the map draws for the protection zones of a layer (`protectionShapes`, the shapes `SquadLayer.createProtectionZones` puts on the map) on the layer data of the API in `fixtures/protectionZones.json`, against the zones of the game: Goose Bay AAS v1, RAAS v1 and RAAS v2, whose first main has a negative radius in the layer data, and Sumari Invasion v1 and TC v1, whose zone of 0.44 m is not drawn.

What needs a browser (hover, drag, clean console on a served build) is covered by
`tools/browser_check/browser_check.mjs`, `volume_check.mjs` (the volume layer), `targets_check.mjs` (target heights, structure damage), `heatmap_check.mjs` (the position heatmap and the damage zone with voxel cover, against the exact triangle tracer's output) and `home_server_check.mjs` (server mode against a made-up feed: following a layer change, leaving when the feed no longer confirms the server, choosing the server again) in the deployment repository (Playwright and Chromium).
CI: `.github/workflows/test.yml`.
