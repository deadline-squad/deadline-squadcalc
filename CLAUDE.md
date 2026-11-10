# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- `npm start` — webpack dev server (localhost:3000)
- `npm run build` — production build to `/dist/`
- `npm run build:engine` — builds the WebAssembly engine (`engine/`, needs the pinned Rust toolchain and `wasm-bindgen-cli`) and copies it to `public/engine/` (gitignored); the volume layer loads it at run time, without it the site works and the layer stays unavailable
- `npm run lint` — stylelint + htmlhint + eslint (run once after a batch of changes, not after every edit)

## Setup
Copy `.env.template` to `.env` before first run. `API_URL` is required — default points to `https://squadcalc.app/api`.

## Architecture

### The App singleton
`src/app.js` creates the single `SquadCalc` instance and exports it as `App`. Every other module imports `{ App }` from `../app.js` to access shared state and utilities. This is the primary communication pattern — there is no event bus or prop-passing.

```js
// src/app.js
export var App = new SquadCalc(options);
App.init();

// Every other module
import { App } from "../app.js";
App.activeWeapon; // current weapon
App.userSettings; // SquadSettings instance
App.sanitize(str); // HTML escape utility (static method)
```

### Startup flow
`App.init()` → `applyUrlIntent()` branches into one of three modes:
- **Static mode** — default, user picks map/layer manually
- **Server mode** (`?server=<id>`) — follows a server: the page opens the layer it plays with the factions of both teams and reads its status again every 20 s. The only servers are the home servers of the deployment: `src/js/serversSource.js` reads the same-origin feed `HOME_SERVERS_URL` (`/live/servers.json`, the Deadline game server, id `deadline`). `SquadCalc.initServerMode` enters the mode (page load, the menu's dropdown, a row of the servers list) after a fresh read of the feed; `SquadCalc.leaveServerMode` is the only place that leaves it. After every read `followDecision` (`serversSource.js`) says what to do with the followed server: open its new layer, stay, or leave with a toast because the feed no longer has it or the calculator cannot show its layer (`canFollow`: a map of `MAPS` and the faction of both teams). While no server is followed, the dropdown is refreshed from the feed every 20 s
- **Session mode** (`?session=<id>`) — collaborative real-time session over WebSocket

### Key classes
| Class/Module | File | Role |
|---|---|---|
| `SquadCalc` | `squadCalc.js` | Main app — weapon selector, UI wiring, URL state, toast/shortcuts |
| `squadMinimap` | `squadMinimap.js` | Leaflet `Map` **extension** (not a regular class) — basemap, markers, heatmap, context menu |
| `SquadVolume` | `squadVolume.js` | Volume layer (voxel columns of buildings, walls, bridges, trees): lazy `volumeWorker.js` with the WASM engine; used by `SquadFiringSolution.getObstacle`, `SquadCoverage`, the damage zone's cover (`squadDamage.damageField` with `objects`) and the position heatmap when the `volumeLayer` setting is on and the map's `meta.json` has a `volume` entry |
| position heatmap | `positionHeatmap.js`, `squadPositionHeatmap.js` | Reverse-position heatmap of a target (button in the target dialog, direct-fire weapons, needs the volume layer): which ground positions have a clear line of fire to it, scored by distance and clearance. `positionHeatmap.js` is the pure classifier (run by the volume worker with the voxel walk and, where `meta.json` `volume.regions` has a precision region of the target, the exact triangles), `squadPositionHeatmap.js` the lazy-loaded layer that draws it |
| target heights, structure damage | `targetHeights.js`, `structureInfo.js`, `structureDamage.js` | `targetHeights.js` turns a vertical ray through the volume layer (`SquadVolume.heightsAt`, worker `column`) into the floors, ceilings, roof, windows and doorways offered by the target dialog; `squadTargetMarker.heightChoice` feeds `SquadFiringSolution`'s `targetHeight`. `structureInfo.js` + `structureDamage.js` (`structureOutcome`) give the shells that destroy a deployable marker's structure; `src/data/structureLinks.js` links `weapons.js` shells and marker icons to the game data |
| `SquadLayer` | `squadLayer.js` | Renders one game layer: objectives, capture zones, spawn groups, faction assets |
| `SquadFiringSolution` | `squadFiringSolution.js` | Ballistics engine — computes bearing, elevation (low/high), spread, time of flight from two LatLngs |
| `SquadFactions` | `squadFactions.js` | Faction/unit picker dialogs and background images |
| `SquadSession` | `squadSession.js` | WebSocket collab session (create/join/sync map state) |
| `SquadSettings` | `squadSettings.js` | Settings definitions, localStorage bindings, mod toggles |
| `SquadServersBrowser` | `squadServersBrowser.js` | Servers list dialog and the state of server mode: the followed server, the layer opened for it, the sync timer; `applyFeed` applies `followDecision` after each read, `switchLayer` opens a server's map, layer and factions |
| `squadCalcAPI.js` | `squadCalcAPI.js` | All backend fetch calls (`process.env.API_URL`) — layers, heatmap markers, health check |
| `smcConnector.js` | `smcConnector.js` | Optional WebSocket bridge to SquadMortarOverlay.exe (enabled via `SMO_WEBSOCKET=true` in `.env`) |

### Weapons data model
```js
{
    name: "WeaponName",   // i18next key: weapons:WeaponName
    type: "deployables" | "vehicles" | "modded",
    mod: "ModKey",        // modded weapons only; drives per-mod filtering
    shells: [{ name, velocity, moa, ... }]
    // ... physics props
}
```
`loadWeapons()` in `squadCalc.js` replaces every plain object with `new Weapon(...)`. **Any new property in `weapons.js` must also be added to the `Weapon` constructor in `squadWeapons.js`** — otherwise it is silently dropped.

### Modded weapons
- `type: "modded"` kept for legacy compat; filtering now uses `mod:` property
- Current mods: `SuperMod`, `InfiniteWarefare`, `SteelDivision`, `SquadAdminTools`
- Each mod gets its own `<optgroup data-mod="${modKey}">` in the weapon dropdown
- Per-mod toggles appear in settings when "Enable modded weapons" is on (`#modFiltersRow`)
- Mod display names: `public/locales/*/settings.json` (same key as `mod:` value)
- Mod enable state: localStorage key `settings-mod-${modKey}`

### Settings system
- Definitions in `SquadSettings` constructor — each entry has `key`, `default`, `selector`, `onChange`
- Stored in localStorage as `"1"` / `"0"`
- `isModEnabled(modKey)` / `setModEnabled(modKey, bool)` helpers for mod toggles
- Checkbox animation: `animateCSS($(element), "headShake")`

### Locales
- Namespaces: `tooltips`, `settings`, `maps`, `weapons`, `common`, `factions`, `units`, `vehicles`
- Languages: `en`, `fr`, `de`, `ru`, `uk`, `zh`
- `npm run locales` fails when a language lacks a key that `en` has (there is no fallback language)
- Files: `public/locales/{{lng}}/{{ns}}.json`, cache-busted with `?v=${version}` from `package.json`
- Weapon display names: key = `weapon.name` value — **spaces in weapon names break i18next keys**, use underscores (e.g. `type_63` not `Type 63`)

## Stack
- **Bundler**: webpack 5, entry `src/app.js`, output `dist/` with `[contenthash]`
- **CSS**: SCSS per component via sass-loader
- **UI**: jQuery + select2 for dropdowns, Leaflet for the map
- **i18n**: i18next with http-backend
- **Animations**: `animateCSS($el, "animationName")` from `src/js/animations.js`

## Changelog
- File: `CHANGELOG.md`
- Format: shields.io badges (`-new%20features-green`, `-bug%20fixes-b22`, `-minor%20release-cd6f68`)
- Version bump also required in `package.json`

## Never commit
User manages all git commits — never run `git commit`.
