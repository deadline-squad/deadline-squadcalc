# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.47.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **The Training layers of Pacific Proving Grounds open.** Picking one (PLANMC-VDV, USMC-RGF) threw "Unsupported gamemode" and left the map's spinner turning, with the previous layer cleared. A layer of a gamemode whose objectives the calculator does not draw now opens with its other assets (spawn points and the rest). A layer that arrives and cannot be drawn says so ("The layer could not be drawn") and stops the spinner.
- **Changing the map stops a layer still loading.** A layer picked just before the map changed was drawn on the new map when its answer arrived, and FOB circles took its radius.
- **A list of layers that arrives after the map changed again is dropped.** The selector could list the layers of a map no longer shown, for example on a page opened with `?server=` whose own map's list came after the server's.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `App.layerRequest` is the `AbortController` of the layer under way; the map selector aborts it. A failed load fires `layer:failed` (the layer) or `layers:failed` (the list, also when empty); `SquadServersBrowser.switchLayer` ends its switch on either.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.46.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- **The Detailed map has a legend.** With the Detailed layer on, a *Legend* box at the bottom left opens the list of its symbols: buildings by height, walls, bridge and quay decks, paved and dirt roads, railways, trenches, shallow and deep water, contour lines, summits with their height, trees, bushes, rocks, crops and the ground covers. The colours are read from the tiles themselves (`legend` in their `meta.json`, written by `tools/maptiles/py/render.py` in the deployment repository), so the legend always matches the tiles on screen; tiles made before the legend existed, and every other layer, show no legend. Labels in all six languages.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `src/js/detailedLegend.js` (`LEGEND_KEYS`, `legendRows`: the rows of the legend from a `meta.json`, malformed or unknown symbols dropped) with `tests/detailedLegend.test.mjs` (rows, and a label for every symbol in every language); `squadMinimap.js` `updateDetailedLegend`.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.45.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **Kohat TC v1: the protection zone of team 2's first main base is drawn.** It is a capsule, which the map left out: 200 m in radius, 600 m from its centre to each tip, lying almost flat (pitched by -87.2 degrees). The map draws what it covers seen from above, a stadium of 1199 m by 400 m running 8.4 degrees south of east. It has no dashed no-deploy outline: the game does not size that area from the capsule but from a 32 cm box at the zone actor's root, 40.5 m from the capsule's centre (a box reaching 400.3 m from that point), and the layer data does not give that point.
- **Fallujah Invasion v2: all three boxes of team 1's second protection zone are drawn.** Only the first, 6 m by 70 m, was, with a no-deploy box of 306 m by 370 m around it. The boxes of 50 m by 40 m and 30 m by 30 m are drawn too, each turned as in the game. The no-deploy outline is gone: the game's area for this zone is one box of 350 m by 340 m around the zone actor's root, not turned (the largest box grown by the lock distance of 150 m), and the layer data does not give that root or its turn.
- **Sumari Invasion v1 and TC v1: the no-deploy area of 50 m around team 2's third protection zone is drawn.** The zone is a box of 0.44 m (on Invasion v1 175 m from team 2's staging zone), which the map left out as too small. The game sizes the no-deploy area of every protection zone the same way, from the larger of its box and a 32 cm box at the zone's root plus its lock distance, so this point gets one reaching 50.5 m from it like any main base. The same kind of zone is on Sumari Insurgency v1 (the same box) and Kohat Insurgency v1 (a sphere of 1.5 m with a lock distance of 300 m), layers the calculator does not offer.
- A turned box is turned in the game's metres. It was turned on the map's own units, so on Skorpo, whose map is 0.3 % longer north to south than east to west, the corners of a turned box were up to 0.72 m off (Skorpo Skirmish v1).
- **Where the map still differs from the game: the dashed no-deploy outline.** For a zone of one sphere or one box the map draws that shape grown by the zone's lock distance. In the game the area is the BP_NoDeployZone actor that the zone (Gameplay_TeamZone) sizes when the match starts: a box around the zone actor's root, turned with the root, reaching from it as far as the shape's radius or extent before the actor's scale plus the lock distance, with a sphere inside it. The two agree only where the shape sits at the root, unscaled and not turned against it, and the layer data gives neither the root nor the unscaled size. Of the 422 zones of one sphere or box in the 206 layers, 218 are drawn more than 1 m off that area and 173 more than 10 m, even counted against the sphere inside the box: on Goose Bay AAS v1 the first main's area is 300 m around a point 30.5 m from the sphere's centre, not the 386.4 m circle the 45.42.0 entry calls the game's; on Tallil RAAS v2 team 2's is centred 303 m from its sphere; on Tallil Seed v1 team 1's is 2280 m long, from a box 1000 m long before its actor's scale of 0.1. Which of the box and the sphere inside it stops a deployable is decided by the game's native code, not by its data files.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `protectionShapes` (`src/js/protectionZone.js`) gives each zone of a team every shape (`outlines`: circle, box, or stadium for a capsule, whose axis is the third row of the engine's rotation matrix for its pitch, yaw and roll) and the no-deploy area the map draws (`noDeploy`, for a zone of one sphere or box). `protectionZoneLayers` turns them into Leaflet circles and polygons, the polygons from points in the game's coordinates (a box's four corners, 33 points on each half-circle of a stadium) through `SquadLayer.convertToLatLng`, and `SquadLayer.createProtectionZones` only puts them on the map. The 1 m limit is gone; a shape of size 0, how the layer data gives a sphere left at the engine's 32 cm (Lashkar Invasion v1), is left out.
- `tests/protectionZone.test.mjs` runs both on the layer data (`tests/fixtures/protectionZones.json`, now also Kohat TC v1, Fallujah Invasion v2, Lashkar Invasion v1, Al Basrah Seed v1 and Skorpo Skirmish v1) against the shapes of the game (build 26005357), `protectionZoneLayers` with the circle and polygon of `tests/stubs/leaflet.mjs`; its header has the table of the four layers whose zones changed. Over the 206 layers the layer API offers for the 25 maps these four are the only ones.
- `tests/maps.test.mjs` freezes the order of `MAPS` (`tests/fixtures/mapOrder.json`): a saved `.squadcalc` file and a session store the map by its position (`getAppState`'s `activeMap`, the session's `UPDATE_MAP`), so a new map is appended and no entry is inserted, moved or removed. Its header said a map is never picked by its position, which holds for links only. `CLAUDE.md` has the rule.
- `tools/browser_check/browser_check.mjs` of the deployment repository checks on the served page the stadium of Kohat TC v1 and the three boxes of Fallujah Invasion v2, each with its size, that neither zone has a dashed outline, and the dashed box of the point of Sumari Invasion v1.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.44.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **Leaving server mode while the server's next map loads stops the switch.** When the followed server moved to a layer of another map, the page changed the map and waited for its list of layers. If the user left server mode in that time, the page still opened the server's layer and set its factions once the list arrived. Leaving server mode, or choosing another server, now stops a switch under way; what has loaded stays as it is. The page also notes the server's layer as shown only once the layer and its factions are set, so a switch that has not finished is not taken for one that has.
- **Ukrainian: three messages were in Russian.** "Server not found or empty", the request to report a problem on GitHub or Discord, and the hint that a file can be dragged onto the map are now in Ukrainian.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- The one-shot handlers of `SquadServersBrowser.switchLayer` carry the namespace `.serverSwitch`; `cancelSwitch` removes them, and `leaveServerMode` and `initServerMode` call it. `switchingTo` holds the layer being opened, so a read of the feed during the switch does not start it again.
- `npm run locales` (`scripts/check-locales.mjs`) also fails on a Ukrainian text that is Russian left untranslated: one with a letter only Russian has (ы, э, ъ, ё), or one of three or more words that is the Russian text word for word.
- `SDK_data.heightmap.origin` of Skorpo is the first vertex of its landscape components, [-4138, -2142], as on the other 24 maps, so that `origin` and `size` describe one rectangle; it was the location of the turned landscape actor. No calculation reads the field (open item O9 of `docs/game-data-audit.md` in the deployment repository).

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.42.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **Goose Bay AAS v1, RAAS v1 and RAAS v2: the protection zone of the first main base is drawn.** Nothing was drawn around the first main on these three layers. The zone's actor has a negative scale in the level, so the layer data carries its radius as -236.4 m, and the check that leaves out zones under 1 m took it for one. The check now measures a zone without the sign, and the map draws this one with the game's size: a circle of 236.4 m (a sphere of 150 m scaled by 1.5759) and around it the no-deploy circle of 386.4 m (150 m further, the zone's lock distance). The second main keeps its 150 m and 300 m. No other layer changes: the only zone under 1 m, a box of 0.44 m with a lock distance of 50 m that Sumari Invasion v1 and TC v1 have at neither main base, is left out as before.
- **Every FOB marker shows the exclusion circle of the loaded layer.** The circle was sized once, when the marker was placed. A marker created before its layer had loaded kept the map's regular 400 m on a 300 m layer: the markers of a joined session or of an imported `.squadcalc` file, and one placed while the layer of a link was still loading. A marker also kept its circle when another layer was picked, and after the layer selector was cleared a new FOB still got the cleared layer's 300 m. The circles of all FOB markers now change with the layer: when it loads, when another replaces it, and back to the map's regular radius when it is cleared.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `protectionShapes` (`src/js/protectionZone.js`) decides which protection zones are drawn and how large, and `SquadLayer.createProtectionZones` draws what it returns; it replaces `protectionRadii`, which the page reached only after the check that dropped the zone. `tests/protectionZone.test.mjs` runs it on the layer data of the three Goose Bay layers and of Sumari Invasion v1 and TC v1 (`tests/fixtures/protectionZones.json`, cut from the answers of the layer API) and compares the sizes with the zones of the game (Squad dedicated server build 26005357).
- `squadMinimap.setLayer` sets the loaded layer and resizes the circles of the FOB markers; `fobExclusionSize` is the one place that computes the radius. The layer selector calls `setLayer` with the layer that arrived and with none when it is cleared (`minimap.layer` kept the cleared layer before). The settings that restyle a loaded layer (`showRespawnCam`, `showMapBorders`, `showMainZones`, `showMainAssets`) return while there is none: their handlers read `minimap.layer` unchecked and threw a TypeError on a page without a layer, the state a cleared selector now leaves too.
- `tests/maps.test.mjs` compares `fobExclusionRadius` with the game for each of its 221 layers (`tests/fixtures/gameFobExclusion.json`: the `FOBRadius` row of every layer's data asset, build 26005357) and `SMALL_FOB_LAYERS` with the game's 300 m layers of the maps whose regular radius is 400 m. The list was right; the 45.38.0 entry below described it wrongly and is corrected.
- `tests/weapons.test.mjs` freezes the order of `WEAPONS` (`tests/fixtures/weaponOrder.json`): the selected weapon is stored by its position in the list, so a new weapon is appended and no entry is inserted, moved or removed. It also checks that every name the weapon and ammunition selectors show has its text in each of the six `weapons.json`, the English one included, which `npm run locales` takes as the reference and cannot check. Ten names had no key and were shown as the key itself; they have one now, with the same text: `BTR4-AGS`, the modded `MO120RTF1`, `PZL07`, `M777` and `Ural-HellCannon`, and the shells `MO-SHORT`, `MO-MEDIUM`, `MO-LONG`, `High-Explosive` and `Air-Burst`.
- `tools/browser_check/browser_check.mjs` of the deployment repository checks both on the served page: the circle of FOB markers before a layer, on Al Basrah RAAS v3, after RAAS v1 replaced it and after the layer was cleared, the four circles of Goose Bay AAS v1, and that those settings switch without an error while no layer is loaded.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.41.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **The page stops following the Deadline server when the feed no longer confirms what it plays, and says so.** A followed server that left the feed (the status service or the site down, so that the feed is older than two minutes) stayed marked as followed: `server=deadline` in the address, the servers button lit, the last map on screen. A server that moved to a layer the calculator cannot show (a layer of a map it does not have, or one whose factions the feed does not name) was recorded as followed while the old map stayed, or the map changed without the factions. At its next read of the feed (every 20 s) the page now leaves server mode: the `server` parameter, the choice in the dropdown and the mark on the servers button go, the map stays as it is, and one message says why. A read of the feed that fails (the device offline for a moment) does not end it: the page goes by its last read until that feed is two minutes old. A page opened with `/?server=deadline` on such a layer says so too (it fell back without a word).
- **Choosing the server again opens the layer it plays now.** After the dropdown was cleared, choosing the server again switched the map to the layer of the page's last read, however old, and corrected it up to 20 s later, or never when the server had left the feed. The feed is now read before anything is switched, from the dropdown and from a row of the servers list alike. A choice the feed does not confirm no longer resets the layer menu.
- **The server dropdown follows the feed.** It was filled once, when the page opened. Its servers are now read again every 20 s: a server that left the feed is no longer offered, one whose layer the calculator cannot show is listed as unavailable (it was labelled "Modded layer"), and both are offered again when the feed has them again, without a reload.
- The servers list no longer writes "Map Voting" under the layer of a server: the status names no next layer. Its "No servers found" line no longer throws when clicked, and no longer stays `noServersFound` when the feed was read before the translations.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `followDecision` and `canFollow` in `src/js/serversSource.js` say after each read of the feed what server mode does with the followed server (open its layer, stay, leave with a reason). `SquadServersBrowser.applyFeed` applies it at page load, on a choice and on every sync; `SquadCalc.leaveServerMode` is the only place that leaves server mode. `feedReader` keeps the last read through a read that fails, for as long as its feed is fresh (`serversAfterRead`); the servers list and the dropdown share one reader. `tests/serversSource.test.mjs` covers the decision, that rule, the longest-name rule of `mapNameOfLayer`, the age of a feed whose response has no `Date` and the options of the feed's request.
- Removed what only read the upstream servers API: the play-time log line with `toMinSec` and `formatPlayTime`, the next-layer cell with its style and the `common:next` texts, the unit arguments of `switchLayer` (it takes the server), the `home` mark of a server. The servers list escapes the faction and server IDs of the feed where it writes them into its HTML.
- `README.md`: the "Server Syncing" section describes the single home server, and the screenshot of the removed list is gone. In the deployment repository `tools/browser_check/home_server_check.mjs` checks the cases above in Chromium against a made-up feed, and `deploy/live_servers.py` no longer stops on an answer of another shape.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.40.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **No firing solution for a target the muzzle has already passed.** The projectile starts at the muzzle, which stands ahead of the weapon's pivot (0.6 m on a tripod MK19, 1.6 m on a mortar, 5.1 m on a tank gun). For a target nearer than that, at a height the mount can be laid on, the calculator answered with the angle at which the barrel's own line runs through the target and a flight time of 0 s: 82 of the 145 weapons, 1452 of 2050 sampled targets. Such a target now has no solution on that arc, as in Squad Ballistics 1.7.2 (#31)

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `solveElevation` (`squadBallistics.js`) returns NaN for a root whose `launchPoint` is not short of the target, so the firing solution, the fire coverage and the position heatmap agree on it; `tests/squadBallistics.test.mjs` checks every weapon whose muzzle is ahead of its pivot. Solutions at 40 m and beyond are identical (`tools/direct_fire/solution_bench.mjs`: 0 differing of 40 per weapon) and so are the coverage cells (`coverage_bench.mjs --compare`: 0 differing cells on seven weapons). `tools/direct_fire/compare.py` of the deployment repository now solves targets inside the barrel's length: 0 mismatches of 32 652 here, 696 on 45.39.0.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.39.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **The loading spinner over the map stops when the map has loaded.** A layer change that came while another was still under way left the spinner turning with nothing left to load: two quick clicks in the layer menu, the layer shortcut pressed twice, a map switched during a layer change, and the page itself on a slow connection (it draws the map image again 0.8 s after it appears, and the first image was then still waiting for its `meta.json`). The change that was overtaken never ended its turn of the spinner, and a tile layer taken off the map before its last tile arrived reports no load at all. A layer change in progress now holds one turn of the spinner, whatever number of changes it replaced, and the map image of the last one ends it, also when that image fails to load and when the map is dragged out of view so that there is no tile to load. The image of a replaced change no longer stays under the new one: every earlier image is removed once a later one has loaded.
- **The names Squad Ballistics 1.6.4 gave the ×12 zoom of the T-72's sight select it again.** `Tank AP · T-72 / T-90 (2A46) · gunner sight ×12` and `Tank HEAT/HE · T-72 / T-90 (2A46) · gunner sight ×12` were refused, so the weapon selected before stayed on the map. They select the T-72's gun now and are reported back as its ×12 view (`… T-72 (2A46) · gunner sight ×12`), not as the gun's own name, which is the ×4 view to Squad Ballistics.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `squadMinimap.js`: `changeLayer` starts the spinner once per change in progress (`layerChanging`) and `showMapImage` ends it for the latest request; `mapImages` lists the images on the map so that a later one removes all before it. `smcConnector.js` no longer stops the spinner by hand before its layer change. `tools/browser_check/browser_check.mjs` in the deployment repository checks the spinner and the number of map images after a superseded change, a tile layer replaced while it loaded, an image that failed and a layer with no tile in view.
- `legacyBallisticsViews` of a `weapons.js` entry maps the name a view had before a rename to the view's current name; `matchBallisticsName` reports the view. It is written by `tools/direct_fire/gen_squadcalc_weapons.py` of the deployment repository from its `RENAMED` table, where the data decides whether a current name is an entry or a view. `tests/ballisticsNames.test.mjs`, `tests/weapons.test.mjs` (the old name of a view stands for a view of the same weapon).
- The `weapons` labels of `src/data/structureDamage.js` are Squad Ballistics' current names (`QLZ87 · optic (RMB ×3)`, `AGS-17 · emplacement · optic (RMB ×2.5)`, `ZiS-3 · optic (RMB ×4)`, and each tank gun under its own vehicle instead of the two merged tank names), regenerated by `tools/volumetric/semantics/structure_damage.py`. Labels only: no health, multiplier or damage value changed.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.38.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **The mortar no longer offers shots its tube cannot be laid on.** In the game the mount pitches the tube 0° to 43.8° above its rest at 45° (`PitchInterval` of `BP_GenericDeployableMortarVehicle`; the sight `UMG_MortarControl` turns its elevation wheel by the tube pitch + 45), so the top elevation is 88.8° (1578.7 mil), not 88.875° (1580 mil): a target between 48.5 m and 51.8 m on level ground got a solution the game cannot fire. The minimum-distance circle follows the mount: 51.8 m for the mortar and the technical's mortar (it was 51 m) and 358 m for the M1064's M121 (it was 340 m; its tube stops at 85°). Two launchers that had no circle get one: 985 m for the BM-21, whose rail cannot go below 14.2°, and 147 m for the technical's UB-32, whose pod cannot go below 0°.
- **BTR-4 AGS: elevations the turret cannot reach are refused.** The entry accepted -45° to 135° on the gunner's display; the turret pitches -5° to 45° and the display reads 0.1° above it (`PitchInterval` of `BP_BMP1TS_Turret`, `BTR4_GunnerReticle`), so the range is -4.9° to 45.1°.
- The range circle of a hell cannon marker is 924 m, the weapon's longest shot on level ground (it was 923 m).
- **The FOB exclusion circle takes the radius of the loaded layer.** The game sets the distance between two FOBs per layer (`FOBRadius` of the layer's data asset, a row of `DT_FOBExclusionRadius`), not per map: 38 layers play with 300 m on a map whose other layers have 400 m. They are the 28 Skirmish layers of those maps, 9 of their Seed layers and Al Basrah RAAS v3; three Seed layers play with 400 m (Manicouagan Seed v1 and Seed v2 CL, Pacific Proving Grounds Seed v1). A FOB marker placed while such a layer is loaded draws the 300 m circle; one that was on the map before the layer loaded, or placed after it was cleared, kept another radius until 45.42.0.
- **Goose Bay AAS v1, RAAS v1 and RAAS v2: the size of the first main base's protection zone is computed as the game does.** The zone's actor has a negative scale in the level (-1.58), and the layer data carries its radius as -236 m. The game takes the size of the scale: 236 m for the zone and 386 m for deployables, and the calculator now computes these radii from the negative figure. The zone was still not drawn: before the radii are computed, a check leaves out every zone under 1 m, and it took the negative radius for one. It is drawn since 45.42.0.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- Every value above is read from the Squad dedicated server build 26005357. `tests/weapons.test.mjs` holds the pitch range of the mount of the eight artillery weapons and what the game's sight adds to it, and checks the elevation ranges against them, the minimum distances against the range at the mount's stop, and the marker circles against the weapons' longest shot.
- `SDK_data.heightmap` of seven maps described a landscape the game does not have: Chora's origin lay 762 m north of the landscape's, Mestia's 98 m, Narva's was 16 m off and 32 vertices short, Harju's one vertex short, Kokan's, Sumari's and Tallil's a metre off. These fields only feed `npm run mapinfo`, no height or firing solution used them; `tests/maps.test.mjs` now checks origin, size and scale of the 25 maps against the game's level data.
- `fobExclusionRadius` and `SMALL_FOB_LAYERS` in `src/data/maps.js`, with tests.
- `src/js/protectionZone.js` (`protectionRadii`) with `tests/protectionZone.test.mjs`.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.37.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **Squad Ballistics selects every one of its weapons on the map again.** Squad Ballistics 1.6.4 and 1.7.0 gave every zoom level of a vehicle gunner's sight an entry of its own and split the weapons whose vehicles sit at different heights; the map knew 93 of its 160 overlay weapons and, for the other 67, kept the weapon selected before, so the fire coverage and the popups were another weapon's. All 160 are selected now. 53 of them are another view of a weapon the list already has (a higher zoom level of the same sight, the normal view next to an optic: the same shell from the same launch point) and select that weapon; `window.squadBallistics.weapon()` answers with the name the weapon was selected by, so Squad Ballistics keeps the view picked there.
- **The Squad Ballistics weapons are those of Squad Ballistics 1.7.1.** Regenerated from its `weapons.json`: 44 vehicle guns and emplacements now fire from the gun's height above the ground and from the muzzle (the MK19 emplacement, AGS-30, QLZ87, SPG-9, 2A28 Grom, 2A70, ZiS-3, ZPL-98A and every tank gun; they were solved from the ground), and the AGS-17 emplacements start their hold at 85.85 and 89.5 degrees (85.87 and 89.52 before). Ten weapons are new: QLZ87 on the bunker tripod, on the CSK131 / WZ551 and on the ZBL08, 2A28 Grom of the BMP-1 technical (HEAT, FRAG), 2A70 100mm of the BMP-3 / BMD-4M through the ×14 sight, Tank AP and Tank HEAT/HE of the T-90A and of the Sprut-SDM1. Four keep their place under a new name, and their old names still select them: *Tank AP · T-72 (2A46)* and *Tank HEAT/HE · T-72 (2A46)* (they stood for several tanks), *QLZ87 · Lynx · optic (RMB ×3)* and *QLZ87 · Lynx · no optic* (were *Lynx / CSK131*). Both apps give the same solutions again (`tools/direct_fire/compare.py`: 167 names, 31 194 cases, 0 mismatches; before, 11 212 mismatches on 43 of 100 weapons).

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `ballisticsViews` of a `weapons.js` entry lists the Squad Ballistics names of the other views of the weapon; `src/js/ballisticsNames.js` (`matchBallisticsName`: the weapon a name selects and the name reported back) with `tests/ballisticsNames.test.mjs`, and `tests/weapons.test.mjs` checks that a name, current, of a view or from before a rename, belongs to one weapon only. The shells of the ten new weapons are linked to their game projectiles for the structure line (`src/data/structureLinks.js`). The bridge stays version 5: `selectWeapon(name)` and `weapon()` are called as before.
- In the deployment repository, `tools/direct_fire/gen_squadcalc_weapons.py` makes one entry per distinct firing solution and decides the views by comparing the generated entries, never by the name; `compare.py` also solves every view name and fails when an overlay weapon of Squad Ballistics is neither an entry nor a view here.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.36.0** *(2026-11-10)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- **The servers list is the Deadline game server.** The menu's server dropdown and the servers browser offer `[RU] Deadline` with the layer it plays, its players and both factions, read every 20 s from the game host's own status; choosing it (or opening `/?server=deadline`) opens that layer and follows the server to the next one. The list of other communities' servers and the favourites that went with it are gone

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `src/js/serversSource.js` (`fetchServers`, `homeServers`, `mapNameOfLayer`) with `tests/serversSource.test.mjs`: the servers come from the same-origin feed `HOME_SERVERS_URL` (`/live/servers.json`, written by `deploy/live_servers.py` of the deployment repository); a feed older than two minutes, by the `Date` of its own response, is dropped, so a state that can no longer be confirmed is not shown as live. The upstream API's `get/servers` is no longer asked. `tools/browser_check/home_server_check.mjs` in the deployment repository checks it in Chromium.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.35.0** *(2026-11-08)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- **HD map, rendered from the game, is the default layer.** A new layer button (*HD Map · rendered from the game*) shows a top-down render of the game client's own meshes, materials, landscape layers and placements (`tools/maprender` in the deployment repository), with colours fitted to each map's whole-map texture: 25 maps, 0.17 to 0.32 m per pixel at the finest zoom, 1.4 GB of 256 px WebP tiles in `/maptiles/<map>-hd/`. It is shown when the address names no layer (a plain link stays plain); the layer chosen before is remembered as until now, and the toggle shortcut cycles through the HD map first. A map without HD tiles shows the detailed map.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `src/js/mapLayers.js` (`DEFAULT_LAYER`, `LAYER_ORDER`, `TILE_FOLDER_SUFFIX`, `urlTypeOf`) with `tests/mapLayers.test.mjs`; the detailed, game-colour and HD layers load through one path (`showDetailedLayer` with the layer's tile folder suffix). `tools/browser_check/standard_hd_check.mjs` in the deployment repository checks the layer in Chromium on every map.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.34.0** *(2026-11-06)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- **Seed and Skirmish layers show the game's own map of the layer.** A layer such as Mutaha Seed v1 has a minimap texture of its own, 4096 px over the 1300 m the layer covers (0.32 m per pixel), where the image of the whole map has 0.67 m per pixel on Mutaha; the in-game map (M) draws that texture, which is why it looked sharper than SquadCalc. SquadCalc now draws it above the map image where the layer's `MapTextureCorner` actors put it (the same corners the grid starts from), on the default map image only (the topographic, terrain, detailed, game-colour and relief layers are drawings of the whole map) and for the 15 textures of 10 maps that differ from the map's own (Mutaha, Tallil, Chora, Fallujah, Goose Bay, Gorodok, Manicouagan, Skorpo, Al Basrah, Black Coast); the other layers are unchanged. The images come from the game client's files (build 26234431), 4096 px each, served by this deployment (`/maptiles/<texture>/0/0_0.webp`, listed in `/maptiles/layer-minimaps.json`; `tools/maptiles`, step `layer-minimaps`). The place of Mutaha Seed v1's texture was checked against the whole-map texture by matching their edges (633.6 m east and 581.1 m south of the image corner, within one pixel of 0.67 m).

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `src/js/layerMinimap.js` (`layerMinimapBounds`: the rectangle of the layer's corners in map units) with `tests/layerMinimap.test.mjs`; `tools/browser_check/layer_minimap_check.mjs` in the deployment repository checks the overlay in Chromium (place, topographic layer, clearing the layer, a layer without a texture of its own, a map change).

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.33.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- **A target's calculation popup is no longer closed by a target that is gone.** Hovering a target for half a second fades the other targets and closes their popups; the timer of a target that had been removed in the meantime (the map was cleared, for example by a map change or a session) still ran and closed the popup of the new target, so the line of the chosen height (`⌖ Floor +3.3 m`) and the rest of the popup disappeared after the next pointer move over the old spot. The timer now does nothing for a target that is no longer on the map (deadline-squad/deadline-squadcalc#28). The choice of a height, the ammunition, the weapon, a drag and the settings all re-render the popup through the same path; each was checked in a browser against a freshly computed content and none left a field stale.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- The content of the calculation popup moved from `squadTargetMarker.js` to the pure `targetPopup.js` (`popupContent`, `formatHeightChoice`) and has unit tests (`tests/targetPopup.test.mjs`: the chosen height's line, the elevation following the height, ammunition and weapon, the order of the lines).

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.32.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- **Object volumes in the line of fire for all 25 maps.** Until now 11 maps had volume files, built with the earlier lattice method; all 25 now have the exact conservative builds (a voxel is occupied when any collision triangle of the game touches it, so a thin opening may close but a wall never opens). `volume.vcol` is 0.1 to 48.6 MB per map and `terrain.bin` 0.4 to 13.0 MB, 1.3 to 61.6 MB together (table in `engine/README.md`, "Files served for each map"). The biggest (Yehorivka, Harju, Gorodok, Chora) are ready 2.7 to 4.4 s after the setting is turned on in headless Chromium on a fast local link and make the browser use 0.9 to 1.8 GB more memory; nothing failed.
- The setting's label states the download: *Object volumes in the line of fire (downloads 1 to 62 MB of map data)* (all six languages).

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- Documentation: the sizes, voxel and column counts of the 25 files, the heatmap time per map re-measured with them (`engine/README.md`, "Time"), the file sizes in `README.md`.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.31.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-fixes-orange">  
- **Direct-fire weapons use the lifespan of their projectile.** The game destroys a projectile `InitialLifeSpan` seconds after it is fired (RPG-7, M3 MAAWS, Carl Gustav and SMAW 4 s; RPG-29 and RPG-28 5 s; autocannons 5 s; SPG-9, Grom, tank AP and machine guns 8 s; NLAW 12 s; 40 mm grenades and tank HEAT/HE 20 s), but the 108 generated direct-fire weapons carried the default 100 s, so the firing solution offered an elevation for targets no round reaches: an RPG-7 at 1500 m is in the air 6.6 s and its rocket is gone after 4 s, about 900 m. Such a target now has no solution, like the UB-32's 20 s and the AGS-17's 40 s did already. The values come from Squad Ballistics' `weapons.json` (`lifespan`, read from the game by `tools/game_weapons.py`) through `gen_squadcalc_weapons.py` and, for the autocannons and machine guns only SquadCalc has, from the Blueprints of `tools/game_ballistics` (`provenance.py` compares every weapon of this file with the game). The maximum range circle is still the geometric range of the flight and ignores the lifespan.
- Squad Ballistics 1.6.1 has the same `lifespan` and the two apps still give the same solutions (`tools/direct_fire/compare.py`: 104 weapons, 20 178 cases, 0 mismatches).

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- Tests: `tests/weapons.test.mjs` (every direct-fire weapon states a lifespan of the game, spot values), `tests/squadBallistics.test.mjs` (an RPG-7 target beyond 4 s has no elevation).
- Documentation: `tools/volumetric/docs/data-provenance.md` (deployment repository) lists every input of the firing solution per weapon with its source and label.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.30.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-fixes-orange">  
- The grid starts where the game's grid starts. Audit of the map constants against the Squad dedicated server package (build 26005357): the game anchors A1 at the north-west corner of the minimap (`MapTextureCorner0/1` of each gameplay layer's `SQWorldSettings`) and splits 300 m keypads into 3 x 3 sub-keypads (`UI/Widgets/Map/Grids/W_SQMapGridLines`, scale factors 1, 3, 9), which the grid already did; what was wrong is its origin. Skorpo's image corners (`-3611 / 3238`, fitted to the image) lie 9.5 m / 10.5 m from the game's (`-3601.5 / 3248.5`), so every Skorpo grid line was 9.5 m west of the game's; the other 24 maps are within 1 m (rounded or truncated corners). Layers that ship a smaller minimap of their own (Skirmish and Seed layers of Chora, Mutaha, Tallil, Skorpo, GooseBay, Manicouagan and Black Coast) start their grid at that layer's corner, up to 1.2 km from the map's (Chora Skirmish v1: 1007 m east, 1222 m south), and a few regular layers differ by 0.5 to 1.5 m (Manicouagan RAAS v1/v2). The grid now starts at the game's corner of the loaded layer (the layer's `mapTextureCorners`), or the map's `SDK_data.minimap.game` corners without a layer; nothing is drawn north or west of it, and lines and letters are counted instead of tested for multiples. The map image, the heightmap and the markers keep the image corners.
- `SDK_data.minimap.game` holds the game's corners of all 25 maps (metres, from the layers' `SQWorldSettings`); `corner0` / `corner1` remain the image and heightmap extent.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- Tests: `tests/squadGrid.test.mjs` (grid origin, rows and columns, game corners of all 25 maps within 1 m of the image except Skorpo, the layer offset of a Skirmish layer); `tests/loader.mjs` lets `squadGrid.js` use the real Leaflet.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.29.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- Belaya Pass was removed from the map list (25 maps again): its level is not in the Squad dedicated server package, so its terrain could only come from community data that nothing here can check, and the owner decided to leave the map out. The terrain-only notice, the selector tooltip, the load toast, their translations in six languages and the special cases that skipped the layer API and the Detailed tiles for it are gone. A map is picked by its name (`?map=`), never by its position, so no saved link or selection moves; a link to the removed map opens a random map as for any unknown name.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- Tests: `tests/maps.test.mjs` now checks the 25 maps, each named once and in six languages; the terrain-only tests were removed, the "no `volume` entry starts no worker" test stays with a neutral map.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.28.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- Belaya Pass is back in the map list (26 maps), **terrain only, from community data**: its level is not in the Squad dedicated server package, so nothing of it is derived from the game files. Its heightmap is SquadHeight 1.3.0's (a Squad Mod SDK export, June 2026, 1 m grid, x -1954..1950, y -2080..1825), its relief archive and topographic metrics are computed from it, and its map images are the upstream ones. `meta.json` carries `"provenance": "SquadHeight 1.3.0 (Mod SDK export), terrain only, not validated against server data"`. Choosing the map shows a warning that its terrain is community data, unverified, and its entry in the selector has the same note as a tooltip (six languages). The API has no game layers for it, so the layer selector stays empty without asking (no error toast), and it has no Detailed tiles, so that layer shows the upstream topographic map without a request or a warning; the Relief layer is offered. There are no building or object heights and no volume layer for it: with *Object volumes in the line of fire* on, the map falls back to the heightmap, as every map without a `volume` entry does. The accuracy figures of the other 25 maps (server-derived) do not apply to it.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `tools/heightmaps`: `heightmaps.sh belaya` / `py/build_squadheight_only.py` build a heightmap from SquadHeight alone (tests: `py/test_build_squadheight_only.py`); `SquadExtract texture` writes the top mip of a Texture2D (the server package keeps no pixels of the Belaya minimap).
- Tests: `tests/maps.test.mjs` (26 maps, Belaya's size and flag, locale names and notices in six languages), a map without a `volume` entry starts no worker (`tests/squadVolume.test.mjs`), the notice on load (`tests/squadHeightmaps.test.mjs`).

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.27.0** *(2026-11-05)*

</br><img src="https://img.shields.io/badge/-fixes-orange">  
Findings of the independent review of 45.22 to 45.26 (deadline-squad/deadline-squadcalc#22):
- A target at the *Landscape* height was reported as behind an obstacle about half the time: the trajectory solver lands the shell a hair (up to 2e-6 m) under the ground at the target, and the line-of-fire check counted that as meeting the landscape. A point is now under the landscape only when it is more than 0.1 mm below it.
- Turning *Object volumes in the line of fire* off and on while the map's `meta.json` was being fetched started two workers and left one running (and fired `volume:ready` twice). A load now stops when another one started after it or the layer was turned off.
- A voxel buried under the ground hid the ground in front of it: of a voxel and the landscape on the same segment the one reached first is reported, the landscape where the segment crosses it.
- Structure damage beyond the explosion's outer radius stays zero in the app although the engine returns the minimum damage (`Lerp(Min, Damage, 0)`) for a structure that is inside the burst by its box and outside it by the ray's hit point. Documented as a known deviation (`tools/volumetric/docs/structure-damage.md`, `.ru.md`), in the structure tooltip (six languages) and in `structureDamage.js`.
- The engine accepted malformed volume and region files: run lengths and column ids that wrap around in 64-bit arithmetic, an infinite or NaN cell size, origin or margin. Sums are checked, empty runs and non-finite header values are rejected (`engine/src/voxel.rs`, `precision.rs`); the WebAssembly engine is rebuilt.
- The volume files' sha256 check was skipped without `crypto.subtle` (a plain-HTTP page) and failed for an upper-case hash in `meta.json`. The digest is now always checked, with SubtleCrypto when there is one and with a plain-JavaScript SHA-256 (`src/js/sha256.js`) otherwise, and compared in either case.
- The position heatmap was not recomputed when only the weapon's range, its elevation limits or the gravity scale changed: they are part of its signature now.
- README: the volume layer paragraph said both that a shot passes through an open window or doorway and that windows and doors let nothing through. Open windows and doorways (a door is open or absent) pass, closed windows, walls and trees stop it; the same correction in `engine/README.md` and `.ru.md`.
- Accessibility: the position heatmap's status line is a live region (`role="status"`); an open structure popup of a deployable marker is refreshed when the weapon or the shell changes.
- A target height that the list no longer offers (another weapon, map or setting) went on applying while the select read *Ground*: it is reset to the ground.
- `npm test` failed on Node 22 (`ERR_UNSUPPORTED_DIR_IMPORT`: from Node 22 a directory argument is not searched). The script names the files by glob (`tests/*.test.mjs`), as does the engine workflow (`js/test/*.test.mjs`). `leaflet.test.mjs` and `structureInfo.test.mjs` stop with `ERR_MODULE_NOT_FOUND` on a checkout without `node_modules`: `npm ci` first (`tests/README.md`).

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- Tests that fail without the fixes: `tests/volumeLayer.test.mjs` (a point a hair under the ground; the Mortar, M1064M121 and HellCannon on flat ground at the landscape height over 1100 m of terrain; a buried voxel; checksum mismatch, upper-case hash and no SubtleCrypto; a 100 m tower against a lob), `tests/squadVolume.test.mjs` (the doubled load), `tests/sha256.test.mjs`, `tests/positionHeatmap.test.mjs` (signature), `tests/targetHeights.test.mjs` (the height reset), `tests/targetHeight.test.mjs` (the samples stop 0.5 m before an elevated target: `ELEVATED_TARGET_SAMPLE_END` mutated to 3 was green), Rust unit tests of `voxel.rs` and `precision.rs`. `tests/loader.mjs` serves `package.json` imports of the sources to Node. `targets_check.mjs` and `heatmap_check.mjs` of the deployment repository check the popup refresh and the live region.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.26.0** *(2026-11-04)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- Firing positions (needs *Object volumes in the line of fire*, off by default; direct-fire weapons only): the target dialog has a *Firing positions* button that draws, from the volume layer's worker, the ground positions up to the weapon's range (at most 2000 m) from where the weapon has a clear line of fire to the target at the height chosen for it. Green is a close position with room around the line of fire, amber a far one or one where the line passes close to an obstacle, faint red a blocked one; the score counts distance (a far position stays viable) and the clearance around obstacles, as wide as the weapon's spread. Open windows and doorways let the line through, closed ones and walls stop it, no penetration is computed. The module is loaded only when the button is pressed. Where the target lies 50 m or more inside the square of a precision region (the exact collision triangles of 150 m around a target; one is published, on Jensen) the lines that pass close to geometry there are decided by the exact triangles and the legend says how far they reach; otherwise it says *Voxels only*. Against the exact triangle tracer on a Jensen building: no false clear and no false blocked position with the region, 1 and 275 (1 and 1 337 at a second height) of 31 560 without it. Times per map: `engine/README.md`.
- The damage zone around a target (kill, wound, covered) uses the voxels as cover when the volume layer is on: a soldier behind a wall is covered, one in line with an open doorway or window is not, and the round lands at the height chosen for the target (a floor, a window, a roof). The heightmap is used as before otherwise.

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `src/js/positionHeatmap.js` (the pure classifier: score, rays, polylines, image, choice of the precision region), `src/js/squadPositionHeatmap.js` (the layer, a chunk loaded on demand), the `heatInit`/`heatRays`/`heatFinish` and `cover` messages of `volumeWorker.js`, `squadDamage.damageField(..., objects)`; `meta.json` `volume.regions` lists the precision regions of a map (`tools/volumetric/py/publish_regions.py` of the deployment repository). `tests/positionHeatmap.test.mjs` and the new cases of `tests/volumeLayer.test.mjs` and `tests/squadDamage.test.mjs`; `engine/tools/js/heatmap_validate.mjs` compares the heatmap with the exact triangles of a window; the browser checks are `heatmap_check.mjs` and `heatmap_timing.mjs` of the deployment repository.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.25.0** *(2026-11-04)*

</br><img src="https://img.shields.io/badge/-fixes-orange">  
- Structure damage follows the rules read from the game server (`ASQDeployable::TakeDamage`, build 26005357; `tools/volumetric/docs/native-rules.md`) instead of the earlier guess: the radial part of a direct hit uses the direct-hit multiplier, not the direct-radial one (which only vehicles read, so ammunition crates take the full explosion); the impact has no hit multiplier; `ExplosiveMinimumDamage` is a floor that the modifier does not scale (ten projectiles, 125 mm HEAT 35); a type that passes damage only on a direct hit does nothing to a near miss; the burst is measured from the impact point moved along the impact normal (1 m for the mortar round, 0.15 m for tank HEAT). Damage types are matched by exact class, health is clamped to 0..max. The impact damage of a direct hit and the mortars' secondary explosion stay inferred (Blueprint code, not in the binary); the help text says so and nothing else.
- Shells to destroy, old guess / game rules (full health, one shell each; direct hit, burst 3, 5, 10 m away): mortar against the FOB radio 2/2, 8/8, 22/22, 65/65; mortar against a HAB 18/18, 81/85, 342/350, 1071/1083; mortar against a HESCO barrier 4/4, 17/17, 126/129, 429/434; 125 mm HEAT against the FOB radio 3/3, 30/30, 39/20, 131/11; against a HAB 8/8, 80/80, 103/40, 344/18; against a HESCO barrier 10/10, 100/100, 130/22, 435/8. The 12 x 14 direct-hit table of the docs changes in 3 cells (mortar on sandbags 9 to 10, BM-21 on the observation tower 51 to 50 and on the mortar emplacement 10 to 11).

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `src/data/structureDamage.js` is regenerated by `tools/volumetric/semantics/structure_damage.py export` (adds `minimum`, `onlyDirect`; drops `directRadial`, 44 structure entries instead of 45); `tests/structureDamage.test.mjs` encodes the native-rules cases (direct-hit multiplier, floor, near miss with `onlyDirect`, exact class, burst distance, ammunition crate), all failing against the previous implementation.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.24.0** *(2026-11-04)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- Target heights (needs *Object volumes in the line of fire*, off by default): the target dialog (click a target) has a *Target height* list when the setting is on and the map has volume files. It holds the heights a vertical ray through the voxel column at the target finds: the floors a soldier can stand on, the ceilings, the roof, and the windows and doorways in walls (open ones are holes, closed windows are solid, a door is open or absent; they are recognised from the shape of the walls, not from the game's building data). Where the heightmap, which fuses a building with the landscape, stands above the landscape, *Ground* is the top of the building and *Landscape* the ground under it. The chosen height replaces the target's ground height in the elevation, the height difference and the line-of-fire check (checked up to the target point itself instead of stopping 3 m short), and shows in the target's popup. Dragging a target or turning the setting off puts it back on the ground. With the setting off, or a map without volume files, nothing changes
- Structure damage: clicking a deployable marker (FOB radio, HAB, mortar, HMG, GMG, AA gun, ammo crate, repair station) opens a popup with the shells of the selected ammunition needed to destroy it from full health, and the target dialog shows the same for a target within 5 m of such a marker. Health and the damage-type multipliers are the game's; how the game combines them into damage is inferred from the field names and was not verified in game, which the tooltip says. Armour-piercing and machine-gun rounds do no structure damage, and nothing is shown for weapons the game data does not cover (howitzers, rocket artillery, modded weapons). One shell per count, each landing where aimed: the spread is not included

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `tests/targetHeights.test.mjs` (classification of a column), `tests/volumeLayer.test.mjs` (the worker's column through the real engine on a house with a storey, a window and a doorway), `tests/targetHeight.test.mjs` (the firing solution and the line of fire of a target with a height), `tests/structureInfo.test.mjs` and `tests/structureDamage.test.mjs` (the links between `weapons.js` shells and the game's projectiles, `src/data/structureLinks.js`)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.23.0** *(2026-11-04)*

</br><img src="https://img.shields.io/badge/-new%20feature-green">  
- Object volumes in the line of fire (settings, off by default): the obstacle check of a shot to a target and the fire coverage test the shell against the voxel columns of the game's buildings, walls, bridges and trees (about 0.5 m wide, 0.25 m high) instead of the heightmap, which has one height per cell and so shows an open doorway or window as solid wall and has no trees. A shot passes through an open window or doorway and is stopped by a closed window, a wall or a tree; no penetration is computed. The landscape comes from its own file (the heights without the buildings, landscape holes such as rivers do not stop a shot). Voxel columns exist for Fallujah, Fool's Road, Goose Bay, Jensen, Kamdesh, Kohat, Kokan, Logar, Mestia, Pacific and Sumari; the other maps keep the heightmap. Nothing is downloaded until the setting is on and the map has them (0.1 to 15 MB of voxels, 0.4 to 6.5 MB of landscape heights, and the 0.4 MB WebAssembly engine, all in a background worker); when anything fails to load the heightmap answers as before. Against the exact triangle tracer on 100 000 random segments the voxel walk is wrong for 4.1 % (Jensen) and 8.4 % (Kokan) of them, almost all of it blocked-instead-of-clear within a voxel of the geometry (engine/README.md). The fire coverage with the layer takes 2 to 3 times longer than with the heightmap (about 5 s on a dense map)

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `npm run build:engine` builds the WebAssembly engine (`engine/`) into `public/engine/` (not committed); the site builds and runs without it. `tests/volumeLayer.test.mjs` runs the volume worker through the real engine on a wall with a doorway (skipped without the engine), `tests/volumeTerrain.test.mjs` the landscape file

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.22.0** *(2026-11-04)*

</br><img src="https://img.shields.io/badge/-new%20feature-green">  
- A Relief layer in the layers menu: the terrain of the map shaded from its precise heightmap alone, without colours, roads or labels, so cliffs, ridges, ditches and the outline of every building and wall stand out. Four lights (north, north-west, west, south-west) are blended by the slope's direction, so no slope is lost in its own shadow, and an anisotropic sky-view factor darkens hollows and the foot of walls. Each map is one PMTiles file read with range requests, and nothing is downloaded until the layer is selected: the layer's code is a separate 7.5 KB (gzip) script loaded at that moment, and the page's own scripts grow by 0.5 KB. Available for all 25 maps; a map without a relief file keeps showing the detailed map

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.21.0** *(2026-11-04)*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange">  
- The hit probability of a direct-fire weapon launched from a muzzle above the ground (the vehicle MK19 and AGS-17 mounts, 2 to 3 m up) takes its spread from the shell's own trajectory instead of the closed-form parabola from the pivot: the shell comes down at a grazing angle, and the closed form overstated the range spread (78 m along the line of fire for the PARS III at 300 m). PARS III MK19 at 300 m: kill chance 0.090 to 0.117 (a simulation of the game's cone gives 0.112), wound 0.347 to 0.415 (0.419), rounds for 90 % 25/6 to 19/5. Weapons without a muzzle offset are unchanged
- Accessibility: map buttons, dialog close buttons and header selects have localised names (six locales), toggles report `aria-pressed`, the select widgets take the name of their select, weapon and target markers take focus and open their dialog with Enter or Space, and the layer menu opens on keyboard focus
- Locales: 15 unused keys removed, and the live "Air Assault" unit type added to the English file (checked against all 93 API layers of the 25 maps)

</br><img src="https://img.shields.io/badge/-%20dev%20-lightgrey">  
- `npm test` runs a `node --test` suite over the pure modules (firing solution, damage, heightmap triangle rule, weapons data, Leaflet 2 event names) with no new dependency, and a GitHub workflow runs it on pushes to dev and on pull requests

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.20.0** *(2026-10-31)*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange">  
- Chora and Kokan Valley have their heights at the game's own 0.5 m: their landscapes have a vertex every 0.5 m, and the 1 m heightmap dropped every other one. Against the landscape's vertices (22 million on Chora, 24 million on Kokan, Squad build 26005357) the error of the 1 m heightmap was 8.9 cm RMS and 9.4 cm at the 99th percentile on Chora (31 m at the worst vertex, on a cliff) and 0.9 cm RMS, 3.1 cm 99th percentile on Kokan; the 0.5 m heightmap reads the vertices back to within its 0.8 to 1 cm height step (0.2 to 0.3 cm RMS). Around buildings, walls and rocks (the densest square kilometre of each map, against a 0.25 m reference) the heightmap is closer to the game too: within 2 m of an object the RMS error falls from 0.35 m to 0.18 m on Chora and from 0.41 m to 0.23 m on Kokan, and the share of points more than 25 cm off from 13.2 % to 4.9 % and from 14.6 % to 6.1 %. Direct-fire line of sight in that window disagrees with the 0.25 m reference in 1.8 % of the pairs instead of 5.6 % on Chora, 0.2 % instead of 0.6 % on Kokan; the mortar's lob is unchanged. The price is the download of these two maps only, and only when you open them: heightmap.webp grows from 4.9 to 14.2 MB (Chora) and from 2.6 to 6.4 MB (Kokan), and their decoding in the background worker from 0.6 to 1.8 s and from 0.2 to 0.7 s; every other map keeps its 1 m heightmap. The page reads the sample spacing from `resolution_m` in meta.json and scales its grid from the image size, as before
- The check for obstacles in the line of fire (the hill, wall or building between weapon and target) steps along the line every 0.5 m on these two maps instead of every metre, so a 0.5 m wall between two samples is not skipped. The fire coverage keeps its coarser ray sampling (at least 1.25 m, for speed), which was never tied to the heightmap's samples

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.19.0** *(2026-10-31)*

</br><img src="https://img.shields.io/badge/-new%20feature-green">  
- The Squad Ballistics group has the AGS-17, MK19 and SPG-9 of every vehicle that carries them, 24 weapons more: the AGS-17 on the Technical, Tigr, Safir, M1151 and BTR-D; the MK19 on the AAVP-7A1, M113 (with and without its sights), M1151, MATV and RHIB; the SPG-9 on the Technical and the INS armoured technical (HEAT and FRAG, with and without the ×4 scope). Each starts its shell where the game does: the barrel pivots at the game's height above the ground (1.80 m on the Safir to 3.22 m on the AAVP-7A1) and the muzzle sits along and above the barrel, so the firing solution, the line-of-sight angle and the fire coverage use that point. The PARS III, TAPV C16, M113 and M1151 MK19 get their launch point too. Also the C90-CR, the DZJ-08, the RPG-28 and the PG-7VR tandem round of the RPG-7V1 (65 m/s) and RPG-7V2 (117 m/s; the older RPG-7 keeps 63 m/s). All from the game files (Squad build 26005357); `compare.py` finds no difference with Squad Ballistics over the 104 weapons. The M1117 and RHIB MK19 and the Kozak-2M1 and RHIB AGS-17 are not in the files with a launch height (Squad Ballistics #12).

</br><img src="https://img.shields.io/badge/-%20improv%20-orange">  
- "MK19 · M1151 / RHIB open turret" is now "MK19 · M1151 open turret" (the RHIB has its own entry); the old name still selects it from an older Squad Ballistics.

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.18.0** *(2026-10-31)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Heights between two heightmap samples follow the game's own collision surface. The game splits every quad of its landscape into two triangles along one diagonal (found with 1,300 positions the game server logged: the diagonal from a quad's (row, col) corner to its (row + 1, col + 1) corner is the closer to the logged ground in 79 of 89 decisive points), and SquadCalc interpolated bilinearly, which differs from it by up to a quarter of the quad's twist at its centre. On maps whose heightmap sits on the game's vertices the old read was off by 0.3-2.2 cm RMS and up to 0.2-1.1 m on the steepest quads (Al Basrah 1.1 m); the new one is exact there (0.0-0.1 cm RMS). Against the logged positions the read is within 2 cm for 92 % of the Fallujah points (bilinear 90 %, nearest sample 79 %) with a 95th percentile of 5.5 cm instead of 10.1 cm. On building cells the triangle read is 2 % worse than the bilinear one (the buildings are mesh heights, not triangles of the landscape): RMS 0.95 m instead of 0.93 m in the densest square kilometre of Fallujah

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.17.0** *(2026-10-31)*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange">  
- The page opens and works without a network after one visit: the service worker keeps the last page, the translations, the Google fonts and the precise heightmap of the maps seen (the 8 latest, 30 days; meta.json comes from the network first, the heavy file is saved under its `?v=` URL), so a reload offline shows the app in your language with the real heights instead of a browser error page. Online nothing is served stale: the page, the translations and meta.json always come from the network first
- An older Squad Ballistics that still selects a weapon by a name SquadCalc renamed in the game-data update (`MK19 / AGS-17 / AGS-30`, `BTR-4 AGS`, `Carl Gustav / M3 MAAWS · HEAT` and `· Tandem`, `Tank AP · 2A46 / ZPT98 / 2A20 / M68A2`, `Tank AP · L30A1 (Challenger 2)`, `M203 / M320 / GP-25 / HK79 / MKE MGL`) gets the weapon again instead of `false`, as it does for the RMB sights
- The fonts (Montserrat, Oswald, Roboto) are served from the site itself instead of fonts.googleapis.com / fonts.gstatic.com: the render-blocking stylesheet and the two font requests to another host are gone (no request leaves for Google), and the page looks the same in all six languages (screenshots byte-identical). The files are the OFL woff2 subsets latin, latin-ext, cyrillic and cyrillic-ext (12 files, the same unicode-range split as Google's, so only the subsets a page uses are downloaded; Chinese falls back to the system font as before). The two latin files are preloaded. The service worker precaches the three latin files (72 kB) and keeps the other subsets for a year once used, so the fonts also work offline
- Keyboard focus is visible: tabbing through the map buttons, the settings sliders and checkboxes draws an outline (a mouse click looks as before). Screen readers now get a name for the layer and tools buttons, the simple-mode button (it was announced as "Download map") and every settings checkbox and slider
- The strings that German, French, Russian, Ukrainian and Chinese lacked are translated: "Move to" in the weapon dialog, the km and min units, the Squad unit types (mountain, recon, air-mobile and wheeled mechanized units, MLRS support), the CRF, MEI and GFI factions in German and the "show only the last three digits" tooltip in Ukrainian. Before, the English key or nothing was shown. `npm run locales` now fails when a language lacks a key that English has
</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Hovering a placed mortar or Hell Cannon marker shows its range circle again (1237 m and 923 m) and hides it when the pointer leaves: the marker listened for mouse events that Leaflet 2 no longer fires. Dragging such a marker also pauses the keypad popup under the cursor again, as it does for weapons and targets
</br><img src="https://img.shields.io/badge/-new%20feature-green">  
- Direct-fire weapons (the Squad Ballistics overlay mark) show a damage zone, kill / wound chance per round and the rounds needed for 90 %, like the mortar. Their explosion comes from the game files (Squad build 26005357): grenade launchers 115 damage within 1 to 15 m (rifle grenade: HE 250 / HEAT 130), the MK19 and AGS-30 the same, M72 / RPG-26 100 within 1.5 to 7.5 m, AT-4 115 within 1.5 to 7.5 m, SMAW, RPG-29, NLAW, Carl Gustav and the MAAWS 130 to 250 within 2 to 16 m, tank HEAT / HESH 200 within 3.5 to 20 m, tank HE and the 2A70 300 within 4 to 35 m (the table is in tools/direct_fire/gen_squadcalc_weapons.py). A weapon with several ammunitions (RPG-7 HEAT / HE, SMAW HEAT / Tandem, ZiS-3, tank HEAT / HE) gets a shell for each. The SMAW tandem warhead deals 80 damage: it wounds but never kills, and its kill zone is empty (it was a radius of infinity). A shell that hits an obstacle before the target shows no rounds line
- The 19 autocannons and machine guns only SquadCalc has (M242, 2A42, 2A72, RARDEN, CTAS40, ZPT99, KPVT, M2A1, NSV, Kord, DShK) get the MOA of their game weapon (1.35 to 7 MOA; the machine guns the value of a rested gun, a sustained burst spreads wider) and, for their HE rounds, the explosion; the AP, APFSDS and machine-gun rounds do not explode and show no damage zone. The Blueprint each number comes from is in tools/direct_fire/gen_squadcalc_weapons.py, which regenerates weapons.js and checks it against the game files (`--verify`)
- The hit chance of a rocket or a capped shell (SPG-9 400 m: spread 16.9 m with the closed form, 8.1 m in the game) is computed from its trajectory and agrees within 0.01 with a simulation of the game's cone flown in the game's 20 ms steps for the RPG-7, SPG-9, tank, 2A70, CTAS40, MK19 and the M203 at three distances each; weapons without an explosion in the game files keep their popup and spread as they were

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.15.0** *(2026-10-31)*

</br><img src="https://img.shields.io/badge/-new%20feature-green">  
- A new map layer, "Detailed map · game colours", for Al Basrah, Gorodok and Fallujah: the same data as the Detailed layer (hillshade, contours, roads, building footprints with heights, trees, water, 0.24 m per pixel at the finest zoom) painted in the colours of the game's own map, so the sand, the dark river water and green ponds, the brown roads and the dark roofs look as in the game. Its button appears next to Detailed on those maps only (other maps have no such tiles; with the layer selected, another map shows Detailed and the layer has to be picked again on the next of the three), it is off by default and the default layer is unchanged; the `M` shortcut includes it where it exists. The colours are fitted to the upstream basemap of each map (tools/maptiles, style `colour`): the mean colour distance (CIEDE2000, 64 m cells) to the basemap falls from 33.5, 38.9 and 26.2 for the Detailed layer to 1.1, 0.9 and 1.5. The tiles are in `/maptiles/<map>-colour/` next to the Detailed ones (46-70 MB per map)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.14.0** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- The Squad Ballistics weapons with an RMB optic are named by their view. "QLZ87" was the entry for the ×3 optic, and fired from the normal view (no RMB) its mark put the shot hundreds of metres past the target (FOV 120: a target at 300 m, a shot at ~830 m). Now "QLZ87 · optic (RMB ×3)" and "QLZ87 · no optic" say which view they are for, and so do the QLZ87 on the Lynx / CSK131, the AGS-17 ("AGS-17 · optic (RMB ×2.5)", "AGS-17 · emplacement · no optic"), the SPG-9 scope and the ZiS-3. The entries keep their place in the list and their saved selection; only the names change. Squad Ballistics 1.6.0 shows the same names and says in the weapon header, the overlay and the how-to steps whether to hold RMB; an older Squad Ballistics still selects the weapons by their old names (`legacyBallistics`)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.13.0** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange">  
- Switching to a map downloads and decodes the precise heightmap faster: it is a lossless WebP the browser decodes itself (Yehorivka 30.7 MB to 20.5 MB, Al Basrah 14.1 MB to 6.6 MB; 326 MB to 171 MB for the 25 maps), with the heights rounded to 1 cm (5 mm from the old ones at most; Chora and Skorpo are unchanged). A heightmap is requested only once its `meta.json` was found, so a site without precise heightmaps no longer downloads the PNG for nothing, and with a `generated` date in `meta.json` the file is requested as `?v=<date>` and can stay in the browser's cache. The PNG of older deployments is decoded with the browser's own inflate instead of JavaScript's, and is used when the WebP cannot be
- The first visit downloads about 19 MB less (the service worker's precache falls from 20.8 MB to 1.9 MB on the wire): the 220 vehicle images (15.7 MB) and the README screenshots are no longer precached; a vehicle image is saved the first time it is shown, then served from the cache for 30 days
- The detailed map layer keeps one tile beyond the screen instead of two, so a zoom step or a pan requests fewer tiles

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.12.0** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- The rounds-to-kill and rounds-to-wound line used a spread the game does not have: impacts were spread evenly over the area of the spread ellipse, but the game's cone (`FMath::VRandCone`, `Phi = fmodf(acosf(2v - 1), h)`, build 26005357) puts the miss *radius* evenly, so rounds crowd at the centre and a kill is `kill radius / spread radius` likely, not its square. The count was too high by up to 10 times: AGS-17 at 300 m asked for 184 rounds to kill (now 19, wound 8 now 4), the mortar at 300 m 16 (now 5). Kill / wound per round, mortar 300 m 0.135 / 0.507 now 0.370 / 0.710, 1000 m 0.253 / 0.835 now 0.492 / 0.905, AGS-17 300 m 0.013 / 0.263 now 0.115 / 0.510 (a 400,000-shot simulation of the game's cone on exact flat-ground physics gives 0.369 / 0.711, 0.494 / 0.910 and 0.115 / 0.510). The drawn spread ellipse is unchanged (it matches the cone within 0.1 %)
- Direct-fire weapons had no spread (MOA 0), so no spread ellipse was drawn for them. They now have the MOA of their game weapon: grenade launchers 30-40, RPG-7 20 (RPG-7V1 15), RPG-26 / M72 15, AT-4 and RPG-29 10, SMAW, PF98, Carl Gustav and M3 MAAWS 7, SPG-9, Grom and ZiS-3 3, 2A70 1.6, tank guns 1.5 (Leopard 1.2), NLAW 1, MK19 on the M1117, AAV-7 and PARS III 50, AGS-30 15. The tripod and open-turret MK19 and the QLZ87 spread by a curve (15 MOA for the first shot of a rested gun, up to 50 in a sustained burst) whose input the game files do not give: they show the 15 MOA of the first shot, a burst spreads wider. The AGS-17 keeps its 50 MOA (a burst). Their hit probability is not shown yet: their explosion is not in the data

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.11.0** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- The page no longer freezes while the fire coverage, the damage zones or a dragged target are computed. Fire coverage: the highest trajectories are searched once instead of in every chunk, each root starts from the previous cell's, the terrain along a ray is cleared with a sparse range-maximum table instead of sample by sample, and the cells are classified in two workers while the page only samples the terrain (in chunks of 8 ms, started by a `MessageChannel`; the PNG is encoded by `toBlob`). Without workers the same chunks run on the page. Every cell is the same as before (111 weapons on a real heightmap, three positions). A weapon now takes 0.5-0.8 s to draw (UB-32 2.9 s, SPG-9 2.4 s, Tank HE 2.0 s before) and the longest task of the page went from 83-144 ms to 10-46 ms
- Damage zones: cover is read from a horizon sweep of the impact (a pass along 2π·radius/0.5 directions instead of a line walked for every cell; 0-0.2 % of the cells change class), zones are drawn one 8 ms task at a time and kept per map, position and shell, and the hit probability is cached. Dragging a target updates once per frame and leaves the rounds line out until it is dropped
- The firing solution solves once and traces on one trajectory (2-8x faster, same elevations, times, spreads and obstacles); `getMaxDistance()` is cached; the 4096 px map image is decoded off the main thread (230-710 ms before on every map switch)
- A solution is for flat ground until the precise heightmap has loaded: the popups show "no height data" and the bridge sends `heightDiff: null`, then both follow `heightmap:loaded`. A target on the weapon, or at an unknown height, shows as out of range
- Squad Ballistics bridge, version 5: `window.squadBallistics.lastTarget()` (the newest target alone, shaped like one element of `targets()`, or `null`) and `window.squadBallistics.revision()` (a number that changes when a target, the weapon or the heights change; `console.info("sb:changed")` is logged at the same moment). The profile of a target is computed once per solution. `targets()`, `weapon()` and `selectWeapon()` are unchanged

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.10.0** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- The Technical's mortar and UB-32, the BM-21 and the M1064 M121 start their shell where the game does: the barrel socket `Attach_Muzzle`, at the hinge height and reach read from the game files (build 26005357), instead of a guessed 2.5-3 m above the ground. The elevation for a target moves by 0.01-0.2° at 450-2000 m; it now matches Squad Ballistics (whose old values were up to 3° off) to 1e-6°
- Their elevation limits are the game's: Technical mortar 40°-83.8° (its HUD's table), M1064 50°-85°, BM-21 14.2°-55° (nothing nearer than about 985 m), Technical UB-32 0°-50°; targets past them show as out of range

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.9.0** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Direct fire flies like the game's server: 20 ms steps, the projectile's top speed (MaxSpeed) applied from the first step, and a rocket motor that pushes along the path. Tank HEAT/HE (1100 m/s, held at 850 or 800 m/s) and SPG-9 / Grom HEAT and FRAG now land where aimed instead of 70-330 m short at 200-800 m; the RPG-7, M3 MAAWS, Carl Gustav, PF98, SMAW and RPG-29 now land on the target too (the RPG-7 passed 1.6-9 m under it at 200-800 m). Same model as Squad Ballistics (deadline-squad/squad-ballistics#4)
- The direct-fire weapons on mounts and turrets have the elevation limits of the game files (SPG-9 tripod +-10°, MK19 tripod -35..20°, AGS-17 -12..86°); targets past them show as out of range
- New Squad Ballistics weapons: "MK19 · emplacement / C16 / L134A1 · no sights" (fired without RMB) and "AGS-30 (BMP-1TS)"; "AGS-30 / BTR-4 AGS" now has the BTR-4's own 1.6° sight
- The UB-32's S-5 keeps its 300 m/s cap and its motor along the pod's axis
- The machine guns and autocannons that only SquadCalc has get their projectile's top speed too: the .50 cal, NSV, Kord and DShK (850-890 m/s) fly at 800 m/s from the first step, the KPVT at 900, the CTAS40 at 1385 / 1000 and the RARDEN and 2A72 HE at 1000

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.8.3** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- 26 more Squad Ballistics weapons, so an embedded map selects them instead of keeping the previous weapon: each tank's own AP and HEAT/HE entry (T-62, T-64BM2, ZTZ-99, Leopard 2A6, M60T, M1128 MGS, M1A1 / M1A2), the MK19 mounts (PARS III and TAPV C16 RWS, M113 and M1151 / RHIB open turrets), SPG-9 · HEAT / FRAG · scope, QLZ87 · Lynx / CSK131, AGS-30 (BMP-2M), 2A28 Grom (BMD-1M) · HEAT / FRAG, 2A70 100mm (ZBD-04A, BMD-4M) · FRAG and AGS-17 · iron sights emplacement
- "AGS-17 · emplacement · no optic" and the new "AGS-17 · iron sights emplacement" work like the AGS-17: hold time on the high arc, direct fire on the low arc, its grenade's spread and damage, listed with it under Deployables (the no-optic one was direct fire only). The iron-sights gun lobs from 33 m (its barrel sits 4.5° higher)
- The saved weapon selection is unchanged

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.8.2** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- A precise heightmap download the network drops (connection lost, a server error) is tried again, up to four times over about 7 s, instead of silently keeping the coarse 8-bit heightmap for the whole visit. If it still fails, a warning says the heights are coarse. A site without precise heightmaps (404) still uses the 8-bit one at once

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.8.1** *(2026-10-30)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Squad Ballistics' "· no optic" weapons (QLZ87, QLZ87 · Lynx / CSK131, AGS-17 · emplacement, SPG-9 · HEAT / FRAG · scope, ZiS-3), for aiming from the normal view without the optic, are in the "Direct fire (Squad Ballistics)" group, so an embedded map selects them instead of keeping the previous weapon. They fly like their optic entries; the AGS-17 one is direct fire (low arc) only. The saved weapon selection is unchanged

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.8.0** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-removed-b22">  
- The device link is removed: the "Link a timer overlay" setting with its session code, the `#link=<code>` pairing link and the relay connection (`/relay/<code>`). Targets no longer go to a second device or monitor; the browser forgets the saved link and code. Squad Ballistics still reads the targets and the weapon of an embedded map through `window.squadBallistics`, and the SquadMortarOverlay connection is unchanged

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.7.0** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Skorpo (6849 x 6869 m) and the other non-square maps: distances, bearings, heights, keypads, the coverage and the map assets use the scale of each map axis; the north-south one was 0.3 % off (up to 6 m on a 2 km shot, 19 m off in the heightmap at the south edge)
- Heights are read at the exact point of the heightmap grid (the last sample is on the map edge, the far corner read 0 m) and interpolated between its four neighbours instead of taken from the nearest one
- Rockets (UB-32, RPG-7, M3 MAAWS) follow their exact trajectory: a UB-32 fired at the old elevation landed 2 / 6 / 13 m short at 800 / 1200 / 1600 m; under 500 m its velocity was also wrong (wrong sign in the deceleration)
- World gravity 9.80 m/s² from the game files, and the mortar, Hell Cannon and UB-32 fire from their real muzzle, which moves with the elevation: the solutions land within a millimetre in a simulation with the game's values (the UB-32 missed by up to 22 m at short range)
- AGS-17 spread drawn from the game's MOA curve: 50 MOA in a burst (was 1.5 MOA, a 1.6 m wide spread at 1 km instead of 54 m)
- The overlay relay sends the distance and the height to 0.1 m (were rounded to the metre)
- A heightmap that fails to load is announced (error message) and the targets say "no height data" instead of silently using flat ground; Squad Ballistics gets an unknown height
- In a session, a weapon's height set by another member is a number again (its precise range ring was broken)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.6.0** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Pairing with Squad Ballistics without a code: its Settings show a link and a QR code (`https://<this site>/#link=<code>`). Opening it here takes over the app's session code, turns the overlay link on and shows a confirmation; the browser remembers both, so later visits reconnect by themselves. The code travels in the URL fragment, which is never sent to the server, and is removed from the address bar at once. Pasting the link into an open tab works too
- The overlay link accepts session codes of 6 to 16 characters (Squad Ballistics makes 12-character codes) and shows them in groups of four

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.5.1** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Weapons and targets placed while the map's heightmap was still loading kept a solution computed on flat ground (wrong elevation, no damage zone) until moved; they are now solved again as soon as the heights arrive. Sessions and imported maps also wait for these heights
- Turning the damage radius off now also removes the rounds-to-kill line from the popups
- Bursts marked for fire correction are cleared when the weapon, its shell or the first weapon marker changes, instead of correcting a weapon that never fired them
- The damage zone and the fire coverage no longer disappear under the map after switching the map layer with standard-quality images
- No more missing marker-icon.png / marker-shadow.png requests (404) when placing weapons and targets

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- Switching maps no longer freezes the page while the heightmap is decoded (up to 3.5 s on Yehorivka, now done in the background) and the heights take half the memory
- Hovering a target no longer recomputes the damage zones of all the others when the mouse leaves it
- The old 8-bit heightmap.json (2.2 MB per map) is no longer downloaded

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.5.0** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Damage zone with cover: inside the damage circles the map colors where a round on the target kills (red), wounds (orange), or would wound a soldier hidden behind a wall, a building or a ridge (blue). Unreal only damages what the explosion can see, so the cover is the line from the explosion to the soldier's body passing under the game heightmap (terrain and buildings)
- Rounds to kill: the target popup shows `☠ 6 · 🩸 2`, the rounds to fire so that one kills, or at least wounds, a soldier standing on the target with 90 % confidence, from the weapon's spread (the ellipse on the map), its explosion and the cover around the target
- Fire correction: Ctrl + double-click where a round burst marks it for the nearest target; the weapon's aim moves against the mean error of the marked bursts (in range and bearing, so it holds when the target moves), the popup shows `↻2 −12m +0.4°` and Squad Ballistics gets the corrected solution. Right-click a burst to remove it

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.4.2** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Spread and damage circles checked against the game files for every artillery weapon: AGS-17 spreads 1.5 MOA (was 15, the circle was ten times too wide) and its grenade hurts 1.5-18 m around the impact (was 1-15 m); AGS-30 / BTR-4 AGS and Technical Mortar use the game's explosion height; BM-21 Grad rockets expire after 20 s like in the game

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.4.1** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- The obstacle check starts the trajectory at the real muzzle (the weapon's height, or the shoulder for direct-fire weapons), so the slope under a weapon is no longer reported as an obstacle a few meters away

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.4.0** *(2026-10-29)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Precise heightmaps built from the game itself (Squad build 26005357): the terrain is the landscape collision read from the game files (0.3 mm steps, every landscape tile) and the buildings, rocks, walls, bridges and road embankments are the collision of every static mesh placed on the map, fused with SquadHeight's trace of the Squad SDK. Heights are 16-bit (about 1.6 cm) instead of 8-bit (up to 2.1 m), and the villages the SDK lacks on some maps are there
- The target popup strikes through a trajectory that hits the terrain or a building before the target, and shows where (`⛔ 230m (+8m)`): fire the other trajectory or move
- Weapon ballistics read from the game files: velocity, gravity scale, rocket boost and lifespan of every weapon. AGS-17 185 m/s with gravity ×1.8 (its hold rate refitted on 67 in-game measurements), Challenger 2 HESH 670 m/s, M3 MAAWS 63 m/s boosted to 230 m/s, RPG-7 boosts; weapons that shared an entry but fly differently are split (MGL/M32, AK-40GL, Carl Gustav M2 rounds, ZTD-05, BMD-4M / BMP-3M 30 mm, ZPT99 variants, emplaced M2 / Kord)
- Squad Ballistics gets the terrain and building profile to each target (bridge version 4) and warns in its overlay when the shot is blocked

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.3.1** *(2026-10-28)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Squad Ballistics can select the weapon picked there (`window.squadBallistics.selectWeapon(name)`, bridge version 3), so the fire coverage and popups follow the weapon chosen in the app

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.3.0** *(2026-10-28)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Fire coverage (new map button): colors where the selected weapon can hit from the first weapon marker. The heightmap includes the buildings, so every cell is checked for a trajectory that clears the terrain and the buildings on the way: green for the low trajectory (direct fire), yellow when only the high one (lob, the AGS-17 hold range) gets there, red when it is in range but blocked. It follows the weapon, its position and height, and the map

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.2.1** *(2026-10-28)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Direct-fire weapons (and the direct-fire angle of the AGS-17) show the elevation above the line of sight to the target, the angle you aim with, instead of the elevation to the horizon, which counted the height difference twice uphill and downhill

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.2.0** *(2026-10-28)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added a "Direct fire (Squad Ballistics)" weapon group: the 43 weapons aimed with the Squad Ballistics overlay mark (grenade launchers, AGLs, launchers including boosted rockets and the NLAW, recoilless and tank guns, autocannons, HMGs). Their physics come from Squad Ballistics' weapons.json, so the elevation shown (with the terrain height of both markers) is the one its overlay aims at
- AGS-17: the target popup shows the hold time of the lob and the elevation for direct fire through the sight (`2.31s / 3.2°`), and targets reachable only in direct fire (under 280 m) are no longer shown as out of range
- Squad Ballistics follows the weapon selected here: `window.squadBallistics.weapon()` (embedded map, bridge version 2) and a `weapon: <name>` line after the targets on the overlay link give its name in Squad Ballistics

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- The time of flight of direct-fire shots at a target above the weapon is the time to reach it on the way up (the projectile was counted until it came back down)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.1.0** *(2026-10-28)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Added the AGS-17 emplacement. It is aimed by holding the elevation key (the mount starts at its highest elevation and the key lowers it), so SquadCalc tells you how long to hold it (in seconds) instead of an angle, for the exact weapon and target heights. The ballistic model was fitted on 67 in-game measurements (280 m at 0 s to 1930 m at 4.1 s, 6.4 m RMS error)
- The weapon card shows the hold time range and the elevation speed of such weapons
- The heatmap is not available for the AGS-17 yet
- Squad Ballistics integration: its embedded map reads the targets (distance, height difference, bearing) through `window.squadBallistics.targets()` and solves them for the weapon picked there; overlay link messages also carry the signed height difference (`... | 1000m | +12m`)
- Added an overlay link: a session code (Settings > Weapons) lets a timer overlay running on another device or network receive your targets through a relay server (`/relay/<code>`), so the AGS-17 hold time can be shown over the game

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Targets whose projectile would expire mid-air are now consistently out of range in every elevation display (previously only the map markers noticed)
- The SquadMortarOverlay bridge, the copied/saved results and the legacy calculator tooltip use the hold time for the AGS-17; the bridge now sends `---` (instead of `NaN`) for targets out of range

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.0.2** *(2026-07-12)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed faction bar background blur effects not working on Chrome/Edge
- Fixed responsiveness of various UX element on 1440p monitors (thanks yobaNGE!)
- Fixed dialogs close button being invisible on Safari (fix [#503](https://github.com/sh4rkman/SquadCalc/issues/503), thanks Josephant & ButtGrinder!)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **45.0.1** *(2026-07-10)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed the changelog being permanently stuck open in legacy mode (Thanks DeeplyBreatheInAir!)
- Fixed several background blur effects not working on Chrome/Edge (fix [#500](https://github.com/sh4rkman/SquadCalc/issues/500))
- Fixed settings sliders theme on Chrome/Edge
- Fixed missing French/Ukrainian translations in the settings dialog

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **45.0.0** *(2026-07-08)*


Heightmaps have been fully reworked: they are now way more precise (each square meter has its own average height), and they now take buildings and other assets into account! If you are shooting from or at a building, its height will now be taken into account when calculating the required elevation. Thanks a lot to **yobaNGE** for the loading mechanics and **Metroseksuaali** for the heightmap export tool!

</br><img src="https://img.shields.io/badge/-new%20features-green">
- You can now create carpet bombs by holding `alt` and dragging a target marker
- You can now create a grid of targets by holding `shift` and dragging a target marker (Thanks Sh1nS0u & YuKI!)
- You can now move a weapon by typing precise coordinates (thanks Josephant!)
- Added a link to the [squad-armor.com](https://squad-armor.com) viewer for each vehicle in the factions panel (thanks MJH1606!)
- Added a dialog to browse the changelog directly from squadcalc.app
- You can now search the map & weapon dropdowns

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- In the faction panel, vehicle images are now mirrored and facing each other
- Improved the projectile simulation panel so it now displays some terrain before the weapon and after the target
- Removed Belaya and Flooded Narva from the map list 😭
- Fixed `M109` height & angle offset (thanks yobaNGE, fix [#495](https://github.com/sh4rkman/SquadCalc/issues/495))

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">   
- Fixed laggy map scrolling on first load (thanks jesrt!)
- Fixed Factions & Units not loading correctly when opening a URL containing a server id (Thanks wwrp450!)
- Fixed missing vehicle images for `ZSL92 IFV` & `ZSL92A APC QLZ87`
- Fixed `map_ifv` icon (thanks driver_061!)

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **44.0.0** *(2026-05-22)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- Menu is now fully customisable from settings : show/hide the buttons you want in your toolbar
- Added a new "Share" button that allows sharing a long URL holding the selected factions and units (thanks Hans-Vader, [#481](https://github.com/sh4rkman/SquadCalc/issues/481))
- Weapon dialog now display the shell damage ([#483](https://github.com/sh4rkman/SquadCalc/issues/483))
- Added `PZL07` Chinese 122mm self-propelled artillery from Infinite Warfare mod (Thanks ovalnik!)
- Added `Type63` multiple rocket launcher from Supermod (Thanks MJH1606 !)
- Modded weapons rework
  - Each mod now has its own category in the weapon dropdown
  - When "Enable modded weapons" is on, individual mods can be toggled on/off in the settings

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed layer not loading when using an URL with a server in it
- Fixed weapon selector not hiding when switching map (fix [#480](https://github.com/sh4rkman/SquadCalc/issues/480))

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **43.0.1** *(2026-05-12)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed weapon selector not showing on legacy mode (thanks scrubbadubba98!)

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **43.0.0** *(2026-05-07)*

</br><img src="https://img.shields.io/badge/-new%20features-green">
- When servers are favorited, they now appear in a new dropdown button directly accessible from the map
- Each team's factions and units are now stored in the URL (thanks Hans Wurst!)
- Added a button to upload a saved file (thanks d503-ai !)
- Added SquadCalc and Squad Data version in the Settings dialog
- Keyboard shortcuts Overhaul
  - Keyboard shortcuts can now be customized in a new setting panel
  - Added a shortcut (default: `M`) to switch basemap (Thanks SphaeroX ! [#476](https://github.com/sh4rkman/SquadCalc/issues/476))
  - Added a shortcut (default: `CTRL` + `M`) to switch from Map to Legacy mode
- UI General Overhaul
  - Reworked the faction button to show current factions & units
  - Added a setting to minimize the faction bar by default
  - Moved legacy button into the Map Buttons (thanks Madlifer!)
  - Map buttons are now dark-themed
  - Added tooltips for settings and legacy mode buttons
  - Added `color-scheme: dark` to prevent browsers from forcing their own dark mode override on the app
  - Layer selector is now hidden on legacy mode
  - weapon selectors are now hidden until a weapon is placed on the map


</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed Server Syncing not working when joining a server from a URL (fix [#459](https://github.com/sh4rkman/SquadCalc/issues/459))
- Fixed MO120RTF1 MOA from 50 to 30 (Thanks yobaNGE ! fix [#473](https://github.com/sh4rkman/SquadCalc/issues/473))
- In the server browser, teams are now correctly hidden on mobile (fix [#472](https://github.com/sh4rkman/SquadCalc/issues/472))
- Fixed session links sometimes not working when opening them in a new tab (fix [#458](https://github.com/sh4rkman/SquadCalc/issues/458))
- Vehicle emplacements that disappear will now prioritise vehicles that don't respawn, as in-game.
- Changed `Hellcanon` German translation (thanks Hans Wurst!)
- Fixed unit characteristics not hiding when removing a faction entirely
- Fixed the server browser tooltip staying open after closing the server list
- Fixed `FV107` missing icon
- Fixed vehicle respawn alerts sound not playing
- Fix attempt at caching bug that displayed the old version after each update

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.4.0** *(2026-03-08)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed flags not appearing in AAS when joining an existing session (fix [#448](https://github.com/sh4rkman/SquadCalc/issues/448))
- Fixed HAB icons not having the correct size when imported from a file (fix [#451](https://github.com/sh4rkman/SquadCalc/issues/451), thanks Panda !)
- Unselecting a server now properly remove `&server=xxx` from the URL (fix [#452](https://github.com/sh4rkman/SquadCalc/issues/452),)


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.3.0** *(2026-02-28)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- The **Factions & Units panel** now shows units’ special characteristics (thanks to C-BoT-AU, fixes [#444](https://github.com/sh4rkman/SquadCalc/issues/444)).
- When synced with a server, the server is now included in the URL. This allows you to bookmark your favorite server, for example: https://squadcalc.app/?server=29812439 (thanks to C-BoT-AU, fixes [#443](https://github.com/sh4rkman/SquadCalc/issues/443)).


</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed a bug when syncing a map with a server that changed map since last time the browser was refreshed  
- Fixed a bug where modded server could be selected
- Added missing vehicles icon for open top APC's (fix [#445](https://github.com/sh4rkman/SquadCalc/issues/445))
- Fixed some lists and tooltips not translating when switch languages on factions menu (fix [#418](https://github.com/sh4rkman/SquadCalc/issues/418))

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.2.0** *(2026-02-17)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- The right-click menu now supports multiple new icon colors (thanks to BL4CK for the SVGs!)
- Added 10.3 new layers
- Added 10.3 PLA Vehicle images
- Added 10.3 new Unit icons

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- Syncing with a server now avoid refreshing the map/layer if already on the right one



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.1.0** *(2026-01-31)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- You can now mark a server as favorite ⭐, making it appear top of the servers lists at any time *(thanks Matador)*
- You can now duplicate a map marker holding `Alt` while dragging it *(thanks Karasiq)*
- Added 4 more colors to drawing tools *(thanks Snowflake)*
- Added tunnels on terrain map layer for Black Coast, Skorpo and Fallujah *(thanks pickletrack)*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- Improved teams collumn to be more compact in Server Browser
- Added a placeholder flag for unknown units in Server Browser

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed toast icons being stretched on small screens
- Fixed AAS flags losing their border when focused by a mouse click (fix [#432](https://github.com/sh4rkman/SquadCalc/issues/432))
- Fixed shape context menu staying open when main menu close
- Fixed mouse cursor behaviour when using right clic context menu (fix [#427](https://github.com/sh4rkman/SquadCalc/issues/427))
- Fixed a bug in server browser where the list was repopulating when sorting a collumn (fix [#433](https://github.com/sh4rkman/SquadCalc/issues/433))
- Fixed some markers that were blocking the mouseover on shapes


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.0.5** *(2026-01-17)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- `M1O-120-RTF1` now use milliradians as intended (Thanks Sh1nS0u_!)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.0.4** *(2026-01-14)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- M121 can now shoot at low angles again (Thanks Dan!)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.0.3** *(2026-01-11)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Updated `M777` velocity (Thanks ovalnik/Dutch!)

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.0.2** *(2026-01-09)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed `M121` having wrong velocity (Thanks Matador!)

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **42.0.1** *(2026-01-09)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed SquadMortarOverlay connector not loading the right map url



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **42.0.0** *(2026-01-08)*

</br><img src="https://img.shields.io/badge/-new%20features-green">  
- Added French 120 Mortar `MO120RTF1` from SuperMod *(thanks Kryger)*
- Added `Ural HellCanon` from Steel Division *(Thanks Mooraragi)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed missing `M777` marker *(thanks Madlifer, Dutch)*
- Fixed default value for fontsize & zoom speed settings
- Fixed `UB32` & `Technical UB32` icon that were reverted
- Marker's icons placed by other members within a session now correctly update when moved out of range

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- Reworked menu buttons to be more compact
- Added back shape-drawing from squadtactics *(thanks Metroseksuaali!)*
- Added a free-hand drawing tool on right clic
- Added `CTRL` + `Z` as an alternative hotkey to `backspace` for removing last target/marker/drawing
- Added new icons for Mortar & Hellcanon
- Weapon & Target markers now scale with marker size settings

</br><img src="https://img.shields.io/badge/-other%20-grey">
- squadcalc.app moved to a brand new server, cutting response times by three !
- With the imminent removal of squadtactics.app, a lot of image assets have been moved back from the API to the `/public/` folder of the repository. Should improve performance & loading times, specifically in regions with huge internet censorship.
- `npm run build` & `npm run start` now run a check list and fails if something is wrong : missing `.env`, missing or badly formatted API_URL
- Added new custom settings to be defined in `.env`
  - `DEV_SERVER_PORT` (default to `3000`)
  - `DEV_SERVER_AUTO_OPEN` to disable a tab being opened when launching `npm run start` (default to `true`)
- Renammed `INDEX` .env setting to `SEARCH_ENGINES`
- Renammed `WEBSOCKET` .env setting to `SMO_WEBSOCKET`
- Improved caching :
  - Most of the images websites should now be precached a few seconds after page is loaded
  - API responses will **not** be cached anymore
  - Main HTML page will **not** be cached anymore
- Reworked the MIT Licence

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **41.1.0** *(2025-12-13)*

</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">  
- Fixed a text not updating when swithing language *([#415](https://github.com/sh4rkman/SquadCalc/issues/415))*

</br><img src="https://img.shields.io/badge/-%20improv%20-orange"> 
- Server search now use [fuzzy matching](https://en.wikipedia.org/wiki/Approximate_string_matching) so typos are more forgiving and still return results

</br><img src="https://img.shields.io/badge/-other%20-grey">
- Settings code fully reworked by Metroseksuaali *([#274](https://github.com/sh4rkman/SquadCalc/issues/274))*  
- Added a [BattleMetrics.com](https://www.battlemetrics.com/) attribution link in the server browser
- Updated readme

</br></br><!-- CHANGELOG SPLIT MARKER -->
# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **41.0.0** *(2025-12-03)*


</br><img src="https://img.shields.io/badge/-new%20features-green"> 

- **Server Browser & Server Syncing** *([#394](https://github.com/sh4rkman/SquadCalc/issues/394))*  

You can now browse the list of active servers and select the one you’re playing on. SquadCalc will automatically update the current layer, factions, and units to match the selected server. If the server changes the map, SquadCalc will detect it and update the layer accordingly as soon as possible. *(thanks Takyon Scure, C-BoT-AU!)*

- **BTR4 AGS30**  

Added the new Ukrainian BTR-4 equipped with the AGS-30 grenade launcher to the mortar calculator.


</br><img src="https://img.shields.io/badge/-%20improv%20-orange">  

- **Projectile Lifespan** *([#399](https://github.com/sh4rkman/SquadCalc/issues/399))*  
SquadCalc now accounts for projectiles with a limited lifespan. If a shot would expire mid-air, it will be marked as out of range.  


</br><img src="https://img.shields.io/badge/-bug%20fixes-b22">   

- Joining a session that switched layer after its creation now correctly load the current layer *([#406](https://github.com/sh4rkman/SquadCalc/issues/406))*
- Opening a SquadCalc link with an embedded session now correctly loads the associated layer. *([#403](https://github.com/sh4rkman/SquadCalc/issues/403), thanks Metroseksuaali)*
- Vehicle Spawner texts are still visible after changing the base layer *([#407](https://github.com/sh4rkman/SquadCalc/issues/407))*
- Adjusted Jensen's range heightmap by a few meters
- Fixed Projectile Trajectory Simulations being wrong for Technical Mortars 
- Fixed a missing French locale  


</br><img src="https://img.shields.io/badge/-other%20-grey">  

- Updated TOS-1A MOA from `500` to `200` *(thanks ovalnik!)*  
- Grids code have been updated to handle maps that are rectangle (looking at you Skorpo)


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **40.2.0** *(2025-11-12)*


<img src="https://img.shields.io/badge/-new%20features-green">

- **Respawn Camera:** : Added a feature to display the Respawn Cam position on the map. (thanks jadow)
Can be disabled in settings, marker can be deleted with a right clic.


<img src="https://img.shields.io/badge/-bug%20fixes-b22">  

- Fixed an issue where existing markers did not appear when joining a session
- Fixed an issue where markers where not created when importing a save file
- Fixed TC hexagons displaying with incorrect colors when joining a session ([#383](https://github.com/sh4rkman/SquadCalc/issues/383))
- Skirmish links between flags now correctly fade out when the layer is hidden ([#391](https://github.com/sh4rkman/SquadCalc/issues/391))

<img src="https://img.shields.io/badge/-other%20-grey"> 

- Added a `.env` template/example file for developers ([#393](https://github.com/sh4rkman/SquadCalc/issues/393))



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-hotfix-grey?style=for-the-badge"> **40.1.1** *(2025-11-02)*

<img src="https://img.shields.io/badge/-bug%20fixes-b22">  

- Fixed map not refreshing after taking a screenshot with squadmortaroverlay (thanks Hans_Wurst)


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **40.1.0** *(2025-11-02)*

<img src="https://img.shields.io/badge/-new%20features-green">  

- **Compact Elevation setting:** Enable this option to decluster the map and only keep the last 3 digit of elevations (1275 -> 275) ([#387](https://github.com/sh4rkman/SquadCalc/pull/387), thanks d503-ai!)
  

<img src="https://img.shields.io/badge/-dev%20-grey">  

- Updated code structure to make it easier for developers to add custom local maps.
- Changed heightmaps & locales caching

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **40.0.0** *(2025-10-19)*


<img src="https://img.shields.io/badge/-new%20features-green"> 

- 🎃

- **Interactive Hexagons for Territory control**  
Hexagons in TC can now be right-clicked to cycle through red/blue/neutral colors. Colors are Synced between sessions.

- **New Settings**  
  - Brightness, Contrast, Zoom Sensitivity, Grid Opacity can now be customised in `Settings > Map` (thanks exhausted_ghost ! fix #372)
  - A line can now be toggled on/off between weapons and targets in `Settings > Mortars` ([#380](https://github.com/sh4rkman/SquadCalc/pull/380), thanks Antiaris74!)

<img src="https://img.shields.io/badge/-%20improv%20-orange">  

- If a target isn't reachable by first mortar but reachable by second one, a deviation grid will now be displayed for the second weapon ([#380](https://github.com/sh4rkman/SquadCalc/pull/380), thanks Antiaris74!)
- Font-Size selector is now a slider
- Logo is now vertical on mobile

<img src="https://img.shields.io/badge/-bug%20fixes-b22">   

- Territory control Hexagons are now correctly hidden when hiding the layer
- Territory control Hexagons numbers now scale with font size settings (fix #373)
- Layer should now correctly load when joining a session
- Fixed missing BMP-2M illustration (fix #371)
- When hovering a target, other targets deviation grids are now correctly faded out
- When dragging a weapon, deviations grids are now faded out

<img src="https://img.shields.io/badge/-other%20-grey">  

- Custom context menu and markers are back in `Settings > Map`
- Removed blur effect when dialogs are open

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-hotfix-grey?style=for-the-badge"> **39.2.1** *(2025-09-29)*

<img src="https://img.shields.io/badge/-%20improv%20-orange">  

- Added a setting to enable/disable next flag probabilities (fix #369)

<img src="https://img.shields.io/badge/-bug%20fixes-b22">   

- Fixed bottom-right buttons being clickable even when not displayed (fix #367)
- Mains now shows "Team 1" / "Team 2" when factions are disabled
- FactionContextMenu is now disabled when factions are disabled (fix #368)
- SpawnPoints now correctly display a generic "team1/2" image on hover when factions are disabled
- Fixed mains icons having no background color when no faction are selected
- Fixed AlBasrah Invasion layers that couldn't be fully completed
- Fixed missing translations for Commander/SpawnPoints (fix #365)

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **39.2.0** *(2025-09-28)*


<img src="https://img.shields.io/badge/-new%20features-green"> 

- **Map Spawns**  
SquadCalc now displays the available spawns for each team. This includes main bases as well as temporary spawns in Invasion, and advanced spawns that appear later in the game.

- **Next flags %**  
In Invasion and RAAS, now displaying for each possible next flag the percentage chance that it will appear in the layer.

<img src="https://img.shields.io/badge/-%20improv%20-orange">  

- Vehicle tooltips now open with a 200ms delay to avoid accidental openings
- Improved faction selector panel responsiveness on mobile  
- Vehicle names can no longer be clicked on mobile to avoid misclicks
- Vehicle spawns now show their reserved vehicle type, if any
- Main base names now include the team number for clarity (Thanks AndersHogqvist & grey275, fix #361)

<img src="https://img.shields.io/badge/-bug%20fixes-b22">   

- Fixed bottom-right buttons being clickable even when not displayed (Thanks Madlifer!)
- Commander assets are now hidden on layers where they are not available (fix #358)
- Commander assets are now hidden on layers after unselecting a faction
- Hovering over the number of available seats now correctly triggers the tooltip
- Vehicle spawn emplacements are now correctly hidden if the "show main assets" setting is disabled
- Fixed HellCannon data so it can be fired from 10° to 90° (Thanks Mooraragi!)
- Fixed map grid sometimes not displaying the last letter/number on large maps (fix #362)
- Fixed main bases on Harju Skirmish v2 (Thanks ghoti!)
- Fixed flag orders on Kohat_Invasion_v1, Kohat_Invasion_v2, Manicouagan_Invasion_v1, Anvil_Invasion_v1, Harju_Invasion_v3, Narva_Invasion_v1 (Thanks Take The L-iam!)



</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-hotfix-grey?style=for-the-badge">  **39.1.1** *(2025-09-05)*

<img src="https://img.shields.io/badge/-bug%20fixes-b22"> Commander Assets icons now loads properly


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **39.1.0** *(2025-09-05)*

<img src="https://img.shields.io/badge/-new%20features-green"> **Commanders Assets !**

You can know see on faction panel what commander asset each time has.  
You can now track the enemy commander assets cooldowns when pinning a faction.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Keypad under cursors now reflect UE5 "Fake grids" (Thanks yourothersis!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Deviation Grid tooltips now indicate the correct angle deviation value (Thanks yourothersis!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a bug where quicly changing maps could mix up their layers (Thanks Snowflake!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed tooltips styles on Weapons & Targets information pop-ups

<img src="https://img.shields.io/badge/-other%20fix%20-grey"> "Only Track High Respawn Times Pinned Vehicles" setting is now activated by default

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-hotfix-grey?style=for-the-badge">  **39.0.4** *(2025-09-04)*

<img src="https://img.shields.io/badge/-bug%20fixes-b22"> SquadMortarOverlay images now load properly


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-hotfix-grey?style=for-the-badge">  **39.0.3** *(2025-09-04)*

<img src="https://img.shields.io/badge/-bug%20fixes-b22"> creating weapon & target markers on mobile should now be working

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-hotfix-grey?style=for-the-badge">  **39.0.1** *(2025-09-03)*

<img src="https://img.shields.io/badge/-bug%20fixes-b22"> Fixed Albasrah/Skorpo size and grid. (thanks Mooraragi)

<img src="https://img.shields.io/badge/-bug%20fixes-b22"> Fixed squadtactics.app button URL


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **39.0.0** *(2025-09-03)*

<img src="https://img.shields.io/badge/-new%20features-green">

- **9.0 & UE5 Ready** 
New AlBasrah and updated Factions/Units/Layers.

- **Spawning Vehicles** ([#343](https://github.com/sh4rkman/SquadCalc/issues/343))  
Vehicles now spawn on map's main after picking a faction, so you can anticipate where they will appear. All spawns possibilities are shown.  
Hovering over an icon opens an info card about it.

- **Faction & Unit Selection from the Map**  
You can now right-click any main flag to select the Faction/Unit of that team and pin it to the screen.

- **Target Deviation Grids**  
  You can now enable a deviation grid on targets that helps adjust shots without the need to place another target: vertical lines show angle deviation (2°), and horizontal arcs show elevation deviation (10 mils or 1° depending on the weapon's unit system).

- **Modded Weapons** ([#327](https://github.com/sh4rkman/SquadCalc/issues/327))  
  Added support for 5 new artillery vehicles from popular mods : Himars, TOS-1A, M109 Paladin, MTLB БЕГЕМОТ, T62 Dump Truck.  
  (Thanks [yobaNGE](https://github.com/yobaNGE) for the weapons data !)

- **Territory Control, Seed & Skirmish Layers Support** 

- **Vehicle Illustration in Faction Selection**  
  Click any vehicle in the faction panel to see what it looks like in-game.
  Added in-cards showing tickets values, if a vehicle is amphibious or has ATGM, and its number of available seats.

- **SquadTactics!** https://squadtactics.app  
Features for creating markers, strategizing, and planning your future games have been removed from squadcalc.app and moved to their own dedicated (but very similar) app. If you need a companion app while playing, use squadcalc.app; if you want to plan your next match outside the game, use squadtactics.app.  


- **And more**  
  - Added complete faction names when hovering over a flag in faction selection.  
  - Added links in faction selection redirecting to each vehicle's `squad.fandom.com` page in a new tab.  
  - "Auto pick single flag" is now activated by default: SquadCalc will automatically pick a flag if it's the only available option. The setting has been removed.  
  - Enabling distance on target markers also displays the distance in squadmortaroverlay (thanks TheMatheusDev! [#345](https://github.com/sh4rkman/SquadCalc/pull/345)).  
  - Logi Boats now appear next to other boats in the vehicle list.  
  - Factions are now sorted alphabetically
  - Vehicles now show if they won't respawn instead of showing default respawn time.
  - Boats are removed from vehicle lists if they can't spawn in the current layer.  
  - Changed the maximum additional height a user can set for a weapon from 100 to 300m.  
  - Improved contrast of the target's compact icon.  
  - Improved map & heightmap caching to speed up image loading.  
  - Reduced button and selector sizes on mobile to be more compact.  
  - Added a custom "Under Maintenance" page.  
  - Added a custom `404` page.



<img src="https://img.shields.io/badge/-bug%20fixes-b22">

- Fixed a Skorpo heightmap being slightly misrotated (Thanks ZFZR031! fix [#295](https://github.com/sh4rkman/SquadCalc/issues/295)).  
- SquadCalc is now installable again as a Progressive Web App (Thanks Acemantura! fix [#328](https://github.com/sh4rkman/SquadCalc/issues/328)).  
- Additional weapon heights are now correctly shared between session members (Thanks aiphton! fix [#322](https://github.com/sh4rkman/SquadCalc/issues/322)).  
- Vehicle respawn timers no longer appear in seconds after being started/aborted (Thanks Petro! fix [#324](https://github.com/sh4rkman/SquadCalc/issues/324)).  
- Changing layers while in a session now broadcasts the layer change to other session members (fix [#305](https://github.com/sh4rkman/SquadCalc/issues/324)).  
- Changing factions/units while in a session now broadcasts the change to other session members (fix [#305](https://github.com/sh4rkman/SquadCalc/issues/324)).  
- Main faction names are now correctly translated.  
- Fixed `CreateSquad` commands to work with vehicle names containing spaces (Thanks Snowflake!).   
- SquadCalc no longer tries to copy targets to the clipboard when moving a weapon if "auto-copy target to clipboard" is enabled.  
- SquadCalc no longer tries to copy targets created by session members to the clipboard when "auto-copy target to clipboard" is enabled.  
- Fixed a rare calculation error when shooting at very close range and high elevation with BM21-Grad (fix [#329](https://github.com/sh4rkman/SquadCalc/issues/329)).  
- Fixed console errors appearing when switching languages.  
- Added missing vehicle translation file for German.  
- Fixed typo in vehicle translation file for Russian (Thanks kimochi!).  
- Right-clicking a marker no longer triggers a console error.



</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **38.1.0** *(2025-05-07)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Sound Notifications & Vehicles Localization Support (fix [#320](https://github.com/sh4rkman/SquadCalc/issues/320))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Vehicles timers will try to continue to run in background on mobile when phone is locked (sounds notifications won't play !) (fix [#319](https://github.com/sh4rkman/SquadCalc/issues/319))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Security fixes


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **38.0.0** *(2025-05-06)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Factions and Destroyed Vehicles Tracking!**  
When selecting a layer, you can now choose the two active factions and their units to view their vehicle lists, respawn times, and delays. You can also pin a unit list to the map to keep it in view and mark vehicles as destroyed—a timer will start, and a sound notification will alert you when they respawn. ([#304](https://github.com/sh4rkman/SquadCalc/issues/304))

<img src="https://img.shields.io/badge/-new%20feature-green"> Selecting a layer now also displays the playable area, if available (invisible walls within the actual map borders). This can be toggled off in `Settings > Layer Settings`. ([#310](https://github.com/sh4rkman/SquadCalc/issues/310))

<img src="https://img.shields.io/badge/-new%20feature-green"> Added new settings to toggle main assets and main zones on/off

<img src="https://img.shields.io/badge/-%20translations%20-blue"> Added German translations by [f0xcb](https://github.com/f0xcb) (Thanks!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Narva_Invasion_v2 Invaders starting to the wrong main (thanks Devil4ngle !)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Distance units between flags are now correctly translated

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Clicking an already selected terrain type no longer reloads the image

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed borders disappearing when clicking an unselectable flag

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Added tracked MSV, tracked logistics, and tracked artillery icons to the context menu icons list

<img src="https://img.shields.io/badge/-%20other%20-grey"> Removed the "Auto-copy next flags" feature


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **37.4.0** *(2025-04-20)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Markers export/import:** You can now export the current state of the map to a file that can be shared or dragged & dropped back later, recreating the markers. ([#298](https://github.com/sh4rkman/SquadCalc/issues/298))

<img src="https://img.shields.io/badge/-new%20feature-green"> **Custom Markers Size:** You can change the default size of the map markers ([#294](https://github.com/sh4rkman/SquadCalc/issues/294))

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Calculations now take the height of the weapon into account (fix [#287](https://github.com/sh4rkman/SquadCalc/issues/287))

<img src="https://img.shields.io/badge/-%20translations%20-blue"> Improved ZH-CH translations by Guducat (Thanks!)

<img src="https://img.shields.io/badge/-%20translations%20-blue"> Improved ru-RU translations by sitroz (Thanks!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed existing markers not taking the heightmap into account when joining a session (fix [#301](https://github.com/sh4rkman/SquadCalc/issues/301), thanks modern-nm!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Hiding the layer now also works with Destruction layers (fix [#291](https://github.com/sh4rkman/SquadCalc/issues/291))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed rectangle markers not being synced in a session when created before a session is created



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **37.3.1** *(2025-04-02)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed SquadCalc not loading on Firefox > 137.0 (fix [#292](https://github.com/sh4rkman/SquadCalc/issues/292), thanks mrbeatbox!)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Kohat heightmap (fix [#297](https://github.com/sh4rkman/SquadCalc/issues/297), thanks ZFZR031!)

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **37.3.0** *(2025-02-23)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a button to Show/Hide flags while a layer is selected (Thanks @Syntax for the suggestion, fix [#289](https://github.com/sh4rkman/SquadCalc/issues/289))


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **37.2.0** *(2025-02-05)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Circles and Rectangles Markers (fix [#285](https://github.com/sh4rkman/SquadCalc/issues/285))

<img src="https://img.shields.io/badge/-new%20feature-green"> Shapes/Arrows are now available in Blue/Red/Green/Black

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed enemy markers context menu positions (fix [#286](https://github.com/sh4rkman/SquadCalc/issues/286))

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Code Refactoring


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **37.1.1** *(2025-02-03)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Under-Cursor Keypads sub-digits are now smaller for clarity (fix [#283](https://github.com/sh4rkman/SquadCalc/issues/283), thanks Flandflard!)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Under-Cursor Keypads, and Markers position Keypads now scale with the font size set in settings

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a FadeIn animation when switching layers 

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Target position keypads are a little higher when several weapons are on the map

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a slight fade-in animation on markers

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Disabled shortcuts panel in settings (shortcuts keys can now be found directly on buttons tooltips)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed pings being oversized on mobile

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Refactoring


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **37.1.0** *(2025-01-31)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Session Pings: Left-clicking the map while in a session displays a ping for everyone in the session. Pings also occur when other participants interact with markers (adding, deleting, etc.).

<img src="https://img.shields.io/badge/-%20Translations%20-blue"> Improved ZH-CH translations by @Guducat (Thanks! Fix [#281](https://github.com/sh4rkman/SquadCalc/issues/281)).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Sharing a session URL now correctly preserves the shared layer.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Clicking the close button on the "Session Created" toast no longer copies the session ID (Fix [#272](https://github.com/sh4rkman/SquadCalc/issues/272)).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Leaving a session now correctly re-colors other players' markers, as well as the spread and damage zones, in red (Fix [#270](https://github.com/sh4rkman/SquadCalc/issues/270)).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Closing SquadMortarOverlay now correctly re-enables the HD map button.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Opening multiple toasts now correctly restarts the timer and closing animation.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Flag names are now properly adjusted when using rectangular flags.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed the missing Logar Valley topographic HD map.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed background color inside context menus for Chromium-based browsers (Fix [#275](https://github.com/sh4rkman/SquadCalc/issues/275)).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> The "Cap Zones on Hover" setting is now properly checked if previously selected (Fix [#277](https://github.com/sh4rkman/SquadCalc/issues/277), thanks @matoid!).

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Session IDs are now restricted to 6–20 characters. A toast message has been added for invalid session ID attempts.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Distance text between flags now fades out while dragging targets/markers (Fix [#264](https://github.com/sh4rkman/SquadCalc/issues/264)).

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a "Undo" button in addition of the backspace shortcut. Undo now also remove the last marker/arrow dropped on the map.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> The "Delete All" button and shortcuts now also remove every markers/arrows on the map.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Buttons that have shortcuts are now displaying it in their tooltips

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Removed 750MB of unused HD map files.

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Improved connector for SquadMortarOverlay v2.4.0 (#278 by @devil4ngle).


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **37.0.0** *(2025-01-24)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Sessions !**

Introducing the session system: You can now create collaborative sessions and share a unique link with friends. This allows multiple users to place markers together on a shared map in real time. Whether you’re strategizing, planning, or simply collaborating, the session system makes teamwork easier and more interactive!

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reordered marker categories in the context menu.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Improved the map list display on devices with small screen heights (fix [#266](https://github.com/sh4rkman/SquadCalc/issues/266)).

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Standardized URL parameters order (Map>Layer>type>Session)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed arrow markers not working on Chromium-based browsers (fix [#268](https://github.com/sh4rkman/SquadCalc/issues/268), thanks @devil4ngle!).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a bug where hovering over a marker would cause target text to fade out permanently (fix [#267](https://github.com/sh4rkman/SquadCalc/issues/267), thanks @dkanrjteh!).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue where arrow markers would "blink" when displayed for the first time (fix [#265](https://github.com/sh4rkman/SquadCalc/issues/265)).



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **36.0.0** *(2025-01-15)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Squad Map Markers:** Right-click on the map to open a context menu that lets you place markers, helping you strategize for future games.

<img src="https://img.shields.io/badge/-new%20feature-green"> **Auto-Copy Targets:** Enable this setting to automatically copy the calculations of the most recently placed or moved target to the clipboard, making it easy to share them in-game using Ctrl+V.

<img src="https://img.shields.io/badge/-new%20feature-green"> **Auto-Copy Next Flags:** Enable this setting to automatically copy the name of the next flag when clicking a flag in a RAAS/Invasion layer, making it easy to share in-game using Ctrl+V.

<img src="https://img.shields.io/badge/-new%20feature-green"> **Display Low & High Angles:** Enable this setting to display both low- and high-angle solutions on the marker for weapons that support both. (Thanks, Matador, for the suggestion. Fix #258)

<img src="https://img.shields.io/badge/-new%20feature-green"> **Flags Distance:** In AAS/RAAS/Invasion, a new setting allows you to show or hide the distance between flags.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> HD maps (8k × 8k) are now tiled for better performance and efficiency.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added various tooltips to settings.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added various animations.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Yehorivka heightmaps being twice the size they should be. (Fix #259)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> The heatmap is no longer redrawn each time the layer is changed on the same map.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed flag numbers being off-center on rectangular flags.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed seconds being displayed as meters in some languages.



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **35.0.0** *(2025-01-02)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Custom font size:** you can now change the size of the texts appearing on the map to your liking (Fixes [#254](https://github.com/sh4rkman/SquadCalc/issues/254))

<img src="https://img.shields.io/badge/-new%20feature-green"> Added new "HD" buttons to use very high-quality maps (previously located in Settings)
SquadCalc now serves very high-quality (8192px × 8192px) terrain and topographic images upon request.
Performance may be significantly affected, especially when using the Steam browser, which appears to deliver the worst performance—even on high-end machines, for reasons unknown.
(Fixes [#253](https://github.com/sh4rkman/SquadCalc/issues/253))

<img src="https://img.shields.io/badge/-new%20feature-green"> New keyboard shortcut: Press Backspace to remove the last target placed on the map.

<img src="https://img.shields.io/badge/-new%20feature-green"> New Settings tab listing shortcuts: A new tab in Settings allows you to browse all available keyboard shortcuts for SquadCalc. Not customizable (yet?).

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a bug where layers weren't correctly removed when switching maps.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed circle flags being slightly off-center.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed flag numbers being off-centered on some browsers.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a visual bug in calculation popups when adding and removing a second weapon.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a typo in french locales

<img src="https://img.shields.io/badge/-%20improv%20-orange"> The "Emphasis markers on hover" option is now activated by default, and the corresponding setting has been removed.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Removed ant-lines connecting weapons to targets when hovering over a marker.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Main icons now use regular image icons instead of emojis.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> The Settings preview now displays the selected marker type (Big or Minimalistic).

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added various button animations.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Now using .svg icons to improve speed and eliminate dependency on CDNs.


</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **34.1.4** *(2024-12-27)*


<img src="https://img.shields.io/badge/-new%20feature-green"> **New keyboard shortcut:** press delete to clear all targets on the map (fix #250)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed KP-gridlines sometimes being drawn outside of map bounds (fix #251)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed KP-gridlines somestimes not appearing when zooming too fast

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Heatmaps should be scaled better on very small/large maps (fix #249)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Security enhancements

<img src="https://img.shields.io/badge/-%20other%20-grey"> Removed Christmas theme


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **34.1.3** *(2024-12-17)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed markers being undraggable on mobile

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed toasts not showing on mobile

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Replaced Albasrah basemap with a better encoded version

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Damage radiuses option is now activated by default



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **34.1.2** *(2024-12-16)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Hovering a flag while zooming in doesn't reveal hidden flags capzones anymore

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Removed an empty space appearing when no layers were available on mobile

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed empty space between map buttons that couldn't be used

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Damage radiuses option is now activated by default

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Removed the ability to right-click on different buttons

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Changelog rework for lane finder


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **34.1.1** *(2024-12-11)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed some aeras around weapons/maps selectors where it was impossible to click on map/markers

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Souk capzone on Sumari RAAS v1

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Police Station capzones on Anvil Invasion v1



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **34.1.0** *(2024-12-09)*


<img src="https://img.shields.io/badge/-%20improv%20-orange"> Clicking the enemy main in RAAS now resets the layer and switches sides even if you’ve already selected flags

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Time of flight is now rounded when displayed next to markers to improve readability

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Previewing a layer now also hides faded-out flags' cap zones

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> "Reveal Layer" settings are now correctly checked by default

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed simulations for the emplaced UB32

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed RealMaxRange for the emplaced UB32 (fix #241)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed damage radii not showing on the emplaced UB32 (fix #242)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Snowflakes no longer block mouse clicks

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed incorrect cursor on the enemy main in Invasion (fix #237)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Qalat, Compound 16, Lavender Farm, Riverside, Vineyard, and Police Station cap zones on Anvil RAAS v1, RAAS v2, and Invasion v1

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Radio Station cap zones on Chora AAS v1 and AAS v2

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Added a script to convert heightmaps to .json in /js/tests/ (fix #240)

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **34.0.1** *(2024-12-06)*

<img src="https://img.shields.io/badge/-new%20feature-green"> ⛄

<img src="https://img.shields.io/badge/-new%20feature-green"> 🔵 Circles Icon for flags
You can now toggle flags icon between circles & rectangles in settings.

<img src="https://img.shields.io/badge/-new%20feature-green"> 🔎Layer Preview
Without clicking a flag, you can preview what would happen by hovering it

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Clicking the enemy main in RAAS now reset layer and switch sides even if you are have already selected flags.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Real Max Range "Circle" now stops at map borders

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Real Max Range "Circle" now stops at weapon angle boundaries (e.g it won't show ranges that are not reachable because you have to go below 800mil)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed markers displaying elevation that couldn't be reached by weapons emplacements with a minimum and a maximum elevation (fix #226)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed some rare capzones being misoriented on Harju RAAS v1/v2 (fix #233)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Map Buttons sometimes appearing behind map & layer selectors on small screens (fix #235)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed FavIcon



</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **34.0.0** *(2024-12-02)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Lane Finder !** You can now select a layer to reveal the potential flags/Cache in AAS/RAAS/Invasion/Destruction gamemodes.  
* **Auto-picker**: If only one flag is reachable next step, SquadCalc will automatically advance into the layer (can be disabled in settings)
* **Capzone:** Zoom in or hover a flag (can be set in settings) to reveal flags capzones
* **Main Zones:** Display Main Protection & NoDeployement zones
* **Game Assets:** Helipads, Repair stations, ammoboxes are displayed when zooming in
* **Known Bug :** capzone can sometimes be very, very small.

<img src="https://img.shields.io/badge/-new%20feature-green"> **Minimistic Icons**  
You now have the choice between Large Animated Target Icons and small circles to help declustering the map when spaming targets. [#224](https://github.com/sh4rkman/SquadCalc/issues/224)  
Option "Animated target icon" have been replaced with "Use Large Icons"  

<img src="https://img.shields.io/badge/-new%20feature-green"> **Real Max Range** *(code by devil4ngle)*  
You can now toggle "Real Max Range" in settings to make the max range circle take heights into account.  
**CPU intensive**, be advised.

<img src="https://img.shields.io/badge/-new%20feature-green"> **FOB Construction Radius** [#225](https://github.com/sh4rkman/SquadCalc/issues/225) *(thanks cytuk)*  
A new circle now appear when hovering/dragging a deployable weapon showing the FOB Range radius.     
Usefull if you are wondering where to place a radio for the weapon to be constructed here.

<img src="https://img.shields.io/badge/-new%20feature-green"> **Sharable URL's** [#222](https://github.com/sh4rkman/SquadCalc/issues/222) *(thanks grey275)*  
URL's now hold the map, layer and type of basemap so it can be easily shared/bookmarked 

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Reapplied -5° Offset to technical mortar [#227](https://github.com/sh4rkman/SquadCalc/issues/227) *(thanks zoslcne)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed faulty pixel on Sanxian heightmap [#229](https://github.com/sh4rkman/SquadCalc/issues/229) *(thanks zoslcne)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed ammo selector being misplaced on 2/4K resolution *(thanks mahtoid)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed logo not properly displaying on slow connection

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed calculations being done twice when placing a new marker

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Gridline now takes map size into accounts when appearing/disapearing [#221](https://github.com/sh4rkman/SquadCalc/issues/227)  

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Bigger gridlines now appears on top of smaller ones for a better clarity

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a fadein animation on "delete on targets" button

<img src="https://img.shields.io/badge/-%20dev%20-grey"> "Frequent weapon position" button is now hidden if no api is provided in a `.env` file

<img src="https://img.shields.io/badge/-%20dev%20-grey"> API new routes: ``/api/get/layers`` & ``/api/get/layer``


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **33.0.2** *(2024-11-14)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> SquadCalc now attempt to connect to SquadMortarOverlay regulary (no need to refresh squadcalc if SMO is launched after squadcalc) - [#219](https://github.com/sh4rkman/SquadCalc/pull/219)

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Moved websockets code for SMO to its own file - [#219](https://github.com/sh4rkman/SquadCalc/pull/219)


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **33.0.1** *(2024-11-04)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Targets not working properly on Safari (thanks @Hooded_Lizard & @SOHNER)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Keypads appearing randomly on touch on mobile devices



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **33.0.0** *(2024-11-01)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Dragging or hovering a target for more than 0.5s will create a line between the target and the placed weapons simulating the projectile path.

<img src="https://img.shields.io/badge/-new%20feature-green"> Hovering a target for more than 0.5s will fade out other markers for clarity. Can be toggled off though settings.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Kokan/Goosebay/Foolroad gamma (thanks zfzr031 ! fix #206)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed incorrect cursor sometimes appearing while dragging

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed incorrect cursor sometimes appearing when hovering the lower part of a marker

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Atempt to fix toast message sometimes shifting the window at launch

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Focus mode should now be correctly hidden on mobile devices

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> "Keypad Under Cursor" & "Use Classic Cursor" settings are now correctly disabled on mobile devices

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed slow image loading in settings preview

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Removed Halloween event theme

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Settings preview is now hidden on small screens to provide more space for settings

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added new tooltip on "Use classic cursor" setting

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Settings will be displayed compacted on width smaller than 992px (previously 768px)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Settings preview is now hidden on small screens to provide more space for settings

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Settings added this last two months has been marked as 'New'

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Replaced deprecated sass import function (fix [#213](https://github.com/sh4rkman/SquadCalc/issues/213))


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **32.3.0** *(2024-10-20)*

<img src="https://img.shields.io/badge/-new%20feature-green"> 🎃

<img src="https://img.shields.io/badge/-%20dev%20-grey"> reworked changelog

<img src="https://img.shields.io/badge/-%20dev%20-grey"> fixed memory leaks

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **32.2.0** *(2024-10-14)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New Options: "Show keypads while dragging". Enable to display current keypad while dragging weapon/target markers

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reworked Setting tab on three columns : Map, Weapon and Target settings

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Target Texts are now rised over anything else when hovering a Marker (avoid confusion when trying to read text when two targets are close to each others)


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **32.1.0** *(2024-10-13)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Narva (Flooded) to the map list

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Pacific Proving Grounds to the map list

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed MK19 spash damage values

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a quick ping to Squad Mortar Overlay before opening websocket to it, avoid ugly error message in console when it's off (code by Devil4ngle)

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Splited HTML/SCSS into components 


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **32.0.0** *(2024-10-06)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **New Weapon : MK19-RWS.** This vehicule mounted MK19 can actually be shot *kinda* precisely at very long range (5km!!) thanks to the degrees indicator in the HUD. It's added as "experimental weapon" for now because of some flows : At very long range the projectile tends to disapear, and the HUD angle indicator being rounded the overall precision can be meh. Thanks to [Ferrariic](https://github.com/Ferrariic) for his original idea and numerous tests (see [this discussion](https://github.com/sh4rkman/SquadCalc/pull/204))

<img src="https://img.shields.io/badge/-new%20feature-green"> **New Setting : "High Quality Basemap"**, allow you to use AI Upscaled 8192px*8192px file as default basemap. Resolution and quality is actually better than the ingame map but be aware it can cause performance issues/high loading time on some browsers.

<img src="https://img.shields.io/badge/-new%20feature-green"> **New Setting : "Experimental Weapons"**, allow you to use experimental indirect-fire weapons in Squadcalc. For now MK19-RWS is available.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reworked several settings labels/tooltips in several language to be more concise

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Slightly reduced font size in weapons/maps dropdown lists.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Realigned Bearing/Distance in setting's preview


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **31.2.0** *(2024-10-01)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed "first zooms lags" due to map image not being properly decoded on Chrome

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a quick ping to Squad Mortar Overlay before opening websocket to it, avoid ugly error message in console when it's off (code by Devil4ngle)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Improved responsivness of settings dialog on very small resolution

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reduced heat points size/chroma on weapons heatmaps

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Splited HTML/SCSS into components 

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Simplified github actions workflows

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Linters : Removed w3c validator / Added htmlhint config

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Project now use module syntax (imports/exports) pretty much everywhere


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **31.1.1** *(2024-09-27)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Emplaced and mobile UB-32 are now using perfectly accurate formulas taking deceleration into account instead of "deducing" average velocities from ingame table. Thanks to @Devil4ngle and check out <a href="https://github.com/Devil4ngle/squadmortar">his project</a>

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Projectile Simulation now plays at consistent speed whatever refresh rate your monitor is 

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added shitty animations on loading logo, settings texts when clicked, and dialogs

<img src="https://img.shields.io/badge/-%20improv%20-orange"> added a new tooltip on "show min/max distance" setting

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed weird span when scrolling at Min and Max zoomLevel ([#201](https://github.com/sh4rkman/SquadCalc/issues/201))

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Back to using CDN to serve Fonts/Icons

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Added support for Devil4ngle squadmortar by introducing activable websocket connection

<img src="https://img.shields.io/badge/-%20dev%20-grey"> moved non-squadcalc JS libraries to a separate folder `/src/js/libs/`


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **31.0.1** *(2024-09-23)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed faulty 'pointer' cursor when hovering settings row without any text

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Skorpo basemap

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Fixed environnement variables not correctly loaded

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **31.0.0** *(2024-09-23)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Single Image Maps : maps are now displayed with a single image file, instead of hundreds of tiles. Add a smoother usage once fully loaded at the cost of higher bandwidth/initial loading

<img src="https://img.shields.io/badge/-new%20feature-green"> New setting : "Pan/Zoom animations" allow you to toggle map animation while moving/zooming on the map. Smooth vs Reactive experience

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a loading indicator while loading maps

<img src="https://img.shields.io/badge/-new%20feature-green"> Added tooltips adding precision on some settings

<img src="https://img.shields.io/badge/-new%20feature-green"> Settings label can now be clicked to tick them

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reduced size heatmap points

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Removed service worker caching for now to see if it fixes caching problems


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **30.0.0** *(2024-09-13)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New feature : "Show Frequent Weapon Locations". Thanks to the data collected through squadcalc API users can now display a heatmap of common places where to deploy their weapon.

<img src="https://img.shields.io/badge/-new%20feature-green"> New feature : Focus Mode. A new button allow to hide everything but the map to have a minimalist/focused view. Shortcut: Enter.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Restyled tooltips

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Improved project bundling with webpack (now using webpack-copy-plugin instead of manual copy, using internal webpack ENV variable, less useless npm scripts, ...)

<img src="https://img.shields.io/badge/-%20dev%20-grey"> Updated every dependencies

<img src="https://img.shields.io/badge/-%20dev%20-grey"> removed playwright tests


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **29.0.3** *(2024-09-06)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> API calls now send current squadcalc version

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **29.0.2** *(2024-09-03)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Dragging Targets around the map doesn't call the post/target api hundreds of times anymore 

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **29.0.1** *(2024-09-02)*

<img src="https://img.shields.io/badge/-new%20feature-green"> SquadCalc now publish targets positions to the API for futur incoming features (heatmap of commonly used targets positions)

<img src="https://img.shields.io/badge/-new%20feature-green"> Now cheching the API health at startup

<img src="https://img.shields.io/badge/-%20improv%20-orange"> webpack & npm script simplifications

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **29.0.0** *(2024-09-01)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Now connected to brand new SquadCalc API, SquadCalc now publish weapons positions to the API for futur incoming features (heatmap of commonly used mortar positions)

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **28.0.5** *(2024-08-18)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed some translations not updating when switching language on settings dialog 

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed M1064 shell name not appearing on weapon dialog  

<img src="https://img.shields.io/badge/-%20improv%20-orange"> (huge) Code reworking

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **28.0.4** *(2024-07-31)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Added missing translations on legacy mode

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed height calculations on legacy mode  

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Now hidding the classic cursor setting on touch screen 

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed gorodok heightmap/zscaling

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Code reworking

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **28.0.3** *(2024-07-26)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Improved language loading mechanic

<img src="https://img.shields.io/badge/-%20improv%20-orange"> New readme with redirection to Wiki

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Code cleaning

<img src="https://img.shields.io/badge/-%20improv%20-orange"> removed self-promotion to my dead youtube channel

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **28.0.2** *(2024-07-25)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Corrected Chinese translations (thanks @peter5he1by !)

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **28.0.1** *(2024-07-19)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Now avoid loading english translations if another language is set

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Damage spreads now correctly disappear when target is out of range and spread radius is off

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Now translating site description for search engines


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">   **28.0.0** *(2024-07-16)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Chinese, Ukrainian, Russian, French language

<img src="https://img.shields.io/badge/-new%20feature-green"> Added the possibility to choose between Impact and Near-Surface rounds when using M121

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Jensen's Range to map list

<img src="https://img.shields.io/badge/-new%20feature-green"> Added the possibility to display height difference between weapon & target in target firing solution

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed UB32 imprecision at high range (2050-2150m)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a visual bug in map selector



</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **27.1.0** *(2024-07-11)*


<img src="https://img.shields.io/badge/-%20improv%20-orange"> Damage radius now take into account the height of the explosion. Mostly impact M121 proximity rounds that explode at 10m from the ground, resulting on a much smaller kill zone.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> UB-32 & Technical UB-32 now have their own damage radius

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Removed the ability to switch to high angle on UB-32 emplacement (both on legacy and map mode)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Removed the ability to switch to high angle on regular mortar (legacy mode)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> tweaked font size of dialogs on mobile





</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **27.0.0** *(2024-07-09)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Weapon Informations & advanced customisation ! You can now left click a weapon to check his properties (velocity, moa, ...). You also switch between High & Low angles, and add some elevation when shooting from the top of a building for example

<img src="https://img.shields.io/badge/-new%20feature-green"> Weapon splash damage ! Jump into settings to active target radius for 100 & 25 damage range.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> In simulation dialog, targets now use a grey/disabled version if there is no firing solution

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reworked settings on two columns on large screen

<img src="https://img.shields.io/badge/-%20improv%20-orange"> **Lot** of code rewriting



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **26.0.1** *(2024-06-30)*


<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue where alt/shift-tabbing would focus map grid and pan the map out of the current view

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed UB32 precision with the new gravity introduced in 26.0.0



</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **26.0.0** *(2024-06-27)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Each weapon now have their own map marker

<img src="https://img.shields.io/badge/-new%20feature-green"> Out of range targets now have their own "grey" marker so you can spot at a glance if it's in range or not

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Reduced global gravity from 9.8 to 9.78. This should make every weapon shoots 1-3m shorter and be more accurate than before. See [#156](https://github.com/sh4rkman/SquadCalc/issues/156)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Changed mortars velocity from 109.89 to 110m/s (SDK value)

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **25.0.3** *(2024-06-24)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Changed M121 Velocity and MOA to 8.1 hotfix

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Renamed M1064 120mm to M1064-M121

<img src="https://img.shields.io/badge/-%20improv%20-orange"> SquadCalc now load a random map at first launch instead of a the same default map

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Advanced Informations now displays elevation up to two decimals for weapons using degrees


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **25.0.2** *(2024-06-12)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Corrected Yehorivka heightmap [#155](https://github.com/sh4rkman/SquadCalc/issues/155) (Thanks SuisQi!)


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **25.0.1** *(2024-06-12)*

<img src="https://img.shields.io/badge/-%20improv%20-orange">  Added minimum range for M1064-A3


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **25.0.0** *(2024-06-12)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added M1064-A3 120mm


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **24.1.0** *(2024-05-25)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Now displaying a weapon number next to calcs when using several weapons

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fixed dead pixels on Kohat heightmap (thanks zfzr031 !)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Scaled down Kohat heightmap

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Code rewritting and three-shaking



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **24.0.0** *(2024-05-11)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Topographic maps !** Heightmap layers have been replaced with a mix of topographic, hypsometric and hillshading layers. Blue/Red heightmaps are still used behind the scene to find heights

<img src="https://img.shields.io/badge/-new%20feature-green"> Grid now display the letters and numbers next to every column and row

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fixed a bug where the grid was drawn a pixel too far

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fixed a bug where mini-placing-circles were not properly destroyed and still hoverable



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **23.3.0** *(2024-05-07)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a "loading" animation background on logo

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed some bridges/buildings being covered with terrain on kohat/manicouagan terrain maps

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fix [#142](https://github.com/sh4rkman/SquadCalc/issues/142)



</br></br><!-- CHANGELOG SPLIT MARKER -->





# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **23.2.0** *(2024-05-06)*


<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Layer preference is now properly restored when loading the page again

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Bearing is displayed again with 1 digit after the decimal point (thanks ThaViking4 [#140](https://github.com/sh4rkman/SquadCalc/issues/140))


</br></br><!-- CHANGELOG SPLIT MARKER -->







# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **23.1.0** *(2024-05-05)*

<img src="https://img.shields.io/badge/-new%20feature-green"> You can now preview calc informations for a second weapon if it's placed

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed layer button appearing sometime in legacy mode

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed calculation not taking heights in account in legacy mode when switching map on existing calcs



</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **23.0.0** *(2024-05-01)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Heightmaps** ! You can know switch to a "heightmaps" mode with better understanding of elevation.

<img src="https://img.shields.io/badge/-new%20feature-green"> **Calc Information** ! You can know clic a target to see advanced informations and previsualize the terrain between weapon and target, and if the projectile is going to hit terrain.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reworked the layer picking buttons

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Disabled target updating while dragging on mobile to avoid sluttering

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Lot of code rewriting





</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **22.0.0** *(2024-04-25)*

<img src="https://img.shields.io/badge/-new%20feature-green"> **Terrain maps** ! You can know switch to a "terrain" mode with better understanding of elevation. Straight from the SDK, makes you wondering how the fuck you can't have decent minimap ingame right.



</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **21.0.0** *(2024-04-20)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a button to clear all target markers

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a bug that prevented from placing markers near the bottom of the page

<img src="https://img.shields.io/badge/-%20improv%20-orange"> improved font caching/loading for faster experience (Largest Contentuful Paint went from 1.1s to 0.8s, and First Contentful Paint from 0.7s to 0.3s !)

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **20.7.2** *(2024-04-15)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed maps/tiles caching for better performance/fix caching problems when updating maps

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **20.7.1** *(2024-04-13)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Updated Skorpo map & heightmap (thanks peter5he1by! [#130](https://github.com/sh4rkman/SquadCalc/issues/130))



</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **20.7.0** *(2024-04-03)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New explosion animation when a target is created (can be disabled in settings)



</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **20.6.0** *(2024-03-29)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> SquadCalc is now using [ServiceWorker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) to load maps faster, and store itself offline


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **20.5.1** *(2024-03-25)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed changelog link


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **20.5.0** *(2024-03-24)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Logo is now displayed under map tiles


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **20.4.0** *(2024-03-23)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New logo/favicons

<img src="https://img.shields.io/badge/-new%20feature-green"> new loading page

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed "Show keypads under cursor" setting appearing on mobile/touch screen


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **20.3.0** *(2024-03-22)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Falling back to 256px tiles

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Updated Kokan minimap

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Updated AlBasrah Heightmap

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reworked FavIcons/PWA Manifest


</br></br><!-- CHANGELOG SPLIT MARKER -->





# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">   **20.1.0** *(2024-03-19)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Converted markers to .webp format

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Converted heightmaps to .webp format

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed -again- slight borders appearing between tiles when moving map on chromium (still visible but barely)

</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **20.0.0** *(2024-03-18)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Updated Narva, Tallil, Logar anf Yehorivka maps

<img src="https://img.shields.io/badge/-new%20feature-green"> Now using 512px*512px .WEBP images for tiles, instead of 256px*256px .JPG, thus only using 8% more bandwitch on average.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reduced grid thickness at lower zoom level

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Default map is now Chora (new Basrah is ugly af)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reduced Javascript bundles size for faster load

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **19.0.0** *(2024-03-07)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Updated AlBasrah, Belaya and Kokan maps according to Squad 7.2 update

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Disabled cursor choice on mobile

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **18.0.0** *(2024-03-07)*

<img src="https://img.shields.io/badge/-new%20feature-green"> You can know choose between classic cursor and crosshair

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a preview in settings popup to help visualizing how settings impact the map

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue with second weapon icons not being renamed correctly after deleting the first weapon

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **17.0.0** *(2024-03-01)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Dispersion calculations are now calculated according to ingame/real life physics and not just estimated. They should be more accurate. Thanks to Moleman for his help understanding the formulas, check [his guide](https://steamcommunity.com/sharedfiles/filedetails/?l=english&id=3118256939&searchtext=Cerca+tra+le+guide+di+Squad) on mortars btw.

<img src="https://img.shields.io/badge/-new%20feature-green"> Now displaying dispersion for UB32 weapon/deployable

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Corrected dead pixels on Sanxian heightmap + resized the file

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Corrected dead pixels on Skorpo

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Corrected dead pixels on Gorodok (thanks Phir)

</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **16.0.0** *(2024-02-08)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Sanxian

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed dead pixels on AlBasrah, Belaya, Chora, Fools Road, Gorodok, Logar, Mestia, Narva, Sumari and Tallil heightmaps resulting on "Out of map" calculations


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **15.0.1** *(2023-12-07)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Weapons being able to be placed outside of map with right click ([#104](https://github.com/sh4rkman/SquadCalc/issues/104))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Map/Settings buttons being offcentered on Safari/SteamBrowsers ([#105](https://github.com/sh4rkman/SquadCalc/issues/105))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Enable calc text zoomanimation so it doesn't "jump" on the map while zooming/unzooming

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Map can now be unzoom further away, allowing to see whole map on mobile/small device

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Re-enabled map-tile buffering : when idle on the map, tiles ouside of view are loading in background to avoid tiles appearing while panning


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **15.0.0** *(2023-12-04)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Simplified interractions with markers : double-click - new targets (or weapon if no weapon have been placed), right-clic - new weapon. Left clicking any markers delete it

<img src="https://img.shields.io/badge/-new%20feature-green"> Weapons Marker can now be deleted even if there is only one left. In this case every target markers are also deleted

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a new setting to show/hide grid

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a new "Shortcuts" in the settings dialog to display how to use the map mode

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Added a slight shadow outline on target markers so they are easier to see on red-ish background or on top of another marker

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed image being cached improperly



</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **14.1.0** *(2023-12-02)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a new setting to replace bearing (°) with distance to target (m) on map mode's targets.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Settings background is now more constrasted, specially in classic mode.

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Moved "show markers animations" to the Performance category in settings

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reduced switchmode/settings buttons on mobile

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed UB32 being inaccurate between 1500-1600m, thanks @Butterhead98 ([#102](https://github.com/sh4rkman/SquadCalc/issues/102))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed social media buttons being blue in settings menu



</br></br><!-- CHANGELOG SPLIT MARKER -->





# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **14.0.0** *(2023-12-01)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New settings menu on bottom right corner to customize map/marker behaviour (external links have been moved here aswell in a more compact way)

<img src="https://img.shields.io/badge/-new%20feature-green"> New animations for weapons & targets markers when created (can be desactivated in settings)

<img src="https://img.shields.io/badge/-new%20feature-green"> New icon for targets markers

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Grid have been reworked to be less blurry at every zoom level

<img src="https://img.shields.io/badge/-%20improv%20-orange"> now buffering grid outside of view to avoid entire parts of maps without grid while panning

<img src="https://img.shields.io/badge/-%20improv%20-orange"> now buffering map tiles outside of view to avoid appearing tiles while panning

<img src="https://img.shields.io/badge/-%20removed%20-red"> Themes have been removed for now, maybe to return later in another form.


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **13.1.0** *(2023-11-26)*

<img src="https://img.shields.io/badge/-new%20feature-green"> A new spread circle has been added on targets to show the spread possibility of rounds (mortar, hellcanon, technicals only)

<img src="https://img.shields.io/badge/-new%20feature-green"> You can now place up to two weapons on the map (CTRL+doubleclick)

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Reduced target marker size

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> The switchmode icon is now correctly centered ([#101](https://github.com/sh4rkman/SquadCalc/issues/101))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Page now waits to be fully loaded before displaying content, avoiding flash of unstyled content. ([#99](https://github.com/sh4rkman/SquadCalc/issues/99))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> On mapmode, calculations doesn't avoid mouse-grabbing the map anymore ([#97](https://github.com/sh4rkman/SquadCalc/issues/97))


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **13.0.1** *(2023-11-22)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Markers now cannot be placed/dragged outside of map ([#98](https://github.com/sh4rkman/SquadCalc/issues/98))

<img src="https://img.shields.io/badge/-%20improv%20-orange">A map (al basrah) is selected by default (legacy/mapmode) ([#93](https://github.com/sh4rkman/SquadCalc/issues/93))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Grid is now fully covering the map ([#92](https://github.com/sh4rkman/SquadCalc/issues/92))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Updated Kokan map



</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **13.0.0** *(2023-11-21)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New interactive map mode ! You can know switch UI mode with the bottom right button to display a map where you can place and drag markers.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed a bug where in legacy mode calculations were displayed even if target was too close. ([#90](https://github.com/sh4rkman/SquadCalc/issues/90)) 


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **12.2** *(2023-11-07)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Sanxian Island (beta)


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **12.1.2** *(2023-11-04)*

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Bottom-right menu now autoclose when clicking elsewhere in the window


</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **12.1.1** *(2023-11-02)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue on Chrome/Edge where calcs on heightmaps were slightly off ([#88](https://github.com/sh4rkman/SquadCalc/issues/88)) 


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **12.1.0** *(2023-11-01)*

<img src="https://img.shields.io/badge/-new%20feature-green"> You are now able to choose high/low angle for every vehicles and Hell cannon by clicking the icon next to elevation

<img src="https://img.shields.io/badge/-new%20feature-green"> You are now able to get negative elevation results for vehicles, it should cover situation where you can tilt a vehicle on a slope to hit a target under you.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue on Safari/Webkit where focus was skipping from target to weapon input when editing weapon coordinates ([#69](https://github.com/sh4rkman/SquadCalc/issues/69) - thanks to TheGrimReaper13/PhiR)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue on Safari Mobile where keyboard is blinking when editing weapon coordinates (Thanks to PhiR)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed an issue where the tooltip encouraging clicking the results to copy them was covering the target input on mobile with on-screen keyboard open. Tooltip is now hidden on mobile

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Implementated an automated testing tool to detect issues and test on various browswers

<img src="https://img.shields.io/badge/-%20improv%20-orange"> Various code refactor & rework


</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **12.0.1** *(2023-10-26)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added new UB32 deployables (same calc than technical UB32, but fancy icon)

<img src="https://img.shields.io/badge/-new%20feature-green"> Reworked weapons in two categories : Deployables/Vehicles

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed [#83](https://github.com/sh4rkman/SquadCalc/issues/83)

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed [#84](https://github.com/sh4rkman/SquadCalc/issues/84)

</br></br><!-- CHANGELOG SPLIT MARKER -->




# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **12.0.0** *(2023-10-26)*

<img src="https://img.shields.io/badge/-new%20feature-green"> New "counting" animation when updating calc numbers

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **11.2.0** *(2023-10-24)*

<img src="https://img.shields.io/badge/-new%20feature-green"> You can know switch between high/low angle with BM-21 Grad by clicking the elevation icon next to elevation number.

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Disabling French DLC mortar for now

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **11.1.2** *(2023-10-16)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fontawesome Icons are now selfhosted


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge">  **11.1.1** *(2023-05-11)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed weapon image width for Steam Browser ([#71](https://github.com/sh4rkman/SquadCalc/issues/66))

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Shooting animation is now hidden when screen size is too small

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **11.1.0** *(2023-05-04)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added a new fancy shooting animation

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed weapon list so it doesn't need scrolling on mobile

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Reduced classic mortar icon size

</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge">  **11.0.0** *(2023-04-26)*

<img src="https://img.shields.io/badge/-new%20feature-green"> aded UB-32 suport

<img src="https://img.shields.io/badge/-%20improv%20-orange"> HellCannon and technical mortar are now using the standard projectile motion formula instead of estimated calculations on ingame table


</br></br><!-- CHANGELOG SPLIT MARKER -->



# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **10.4.0** *(2023-04-24)*

<img src="https://img.shields.io/badge/-new%20feature-green"> updated BM-21 to V4.4  
* new min & max ranges.  
* Reworked weapon to work with a fixed velocity instead of working with the ingame table.  
* BM-21 is now using x2 gravity scale  
* removed min angle

<img src="https://img.shields.io/badge/-new%20feature-green"> added a new red theme



</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **10.3.0** *(2023-04-16)*

<img src="https://img.shields.io/badge/-dev-grey"> Reworked project structure

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **10.2.0** *(2023-04-14)*

<img src="https://img.shields.io/badge/-new%20feature-green"> now auto-generating robots.txt in prod/dev building scripts

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fixed weapon selector list being offset

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fixed [#66](https://github.com/sh4rkman/SquadCalc/issues/66)


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **10.1.0** *(2023-04-08)*

<img src="https://img.shields.io/badge/-new%20feature-green"> updated hellcannon icon

<img src="https://img.shields.io/badge/-new%20feature-green"> added color on save button hover

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> fixed saved calc being misplaced when resizing window

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> updated readme still mentioning 'MSMC'

<img src="https://img.shields.io/badge/-dev-grey"> JS refactoring


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **10.0.0** *(2023-04-06)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Active weapon icon is now displayed in the keypads section

<img src="https://img.shields.io/badge/-new%20feature-green"> Weapons selector is now a classic dropdown selector, displaying weapons in category : mortars, vehicles, frenchdlc

<img src="https://img.shields.io/badge/-new%20feature-green"> Dropdown list now shows current selected in a light red color

<img src="https://img.shields.io/badge/-new%20feature-green"> Added fancy animations on first page load

<img src="https://img.shields.io/badge/-dev-grey"> HTML/CSS refactoring

</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **9.0.3** *(2023-03-20)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added informative tooltips on results

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Removed an unecessary space when saving calcs to clipboard 

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Copy to clipboard now working again on Steam Browser

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Saved calcs should now be correctly centered on all devices

<img src="https://img.shields.io/badge/-dev-grey"> Code refactoring

</br></br><!-- CHANGELOG SPLIT MARKER -->


# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **9.0.2** *(2023-03-18)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added this changelog file

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed caracter " ° " encoding when saving a Tehnical/Hellcanon/Grad-21 calc (Thanks @TheGrimReaper13 !)


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-minor%20release-cd6f68?style=for-the-badge"> **9.0.1** *(2023-03-18)*

<img src="https://img.shields.io/badge/-bug%20fix%20-b22"> Fixed Yehorivka heightmap's offset, heights calculations should be right for now (Thanks @TheGrimReaper13 !)


</br></br><!-- CHANGELOG SPLIT MARKER -->

# <img src="https://img.shields.io/badge/-major%20release-b22222?style=for-the-badge"> **9.0.0** *(2023-03-16)*

<img src="https://img.shields.io/badge/-new%20feature-green"> Added Manicouagan in the map list (removed Manic)

<img src="https://img.shields.io/badge/-new%20feature-green"> Added new weapon : BM-21 "Grad"

<img src="https://img.shields.io/badge/-dev-grey"> Added a "Debug mode" that can be activated in conf.js to make debugging easier
