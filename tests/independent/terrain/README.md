# Independent terrain check

Is the page's sampled obstacle test (`SquadFiringSolution.getObstacle`: a ground sample every `OBSTACLE_STEP` metres,
on the heights of the engine-backed `SquadHeightmap`) as good as an exact test? This check answers it on 54 000 seeded
lines of fire against a reference that has no sampling step and shares no line with the calculator's height code.

## What is compared

Per line, for each of three weapons that fly a parabola (Tank AP `DF_Tank_AP_M256_Rh120`, `DF_ZiS_3`, `Mk19`):

- **Exact** (`exact.mjs` on `heightmap.mjs`): the lowest clearance of the shell's path over the line's ground track.
  The ground is linear between the track's crossings of the lines of the sub-grid (rows, columns and diagonals, at every
  1/f of the lattice, f the detail factor), the path minus a linear function is concave there, so the minimum is at a
  crossing, read once (the surface is continuous there: random points on quad edges show no jump over a micrometre). The path is the closed parabola of the weapon's parameters at
  the elevation, with the speed cap held where it binds (ZiS-3 below its muzzle); `flightPath` refuses a shot that is
  not of that kind (a motor, no gravity, a launch above the cap). The ground under the weapon, plus the line's height
  padding, is the path's base. The line is blocked when the lowest clearance is negative.
- **Page**: `SquadFiringSolution` as the page builds it, its `obstacle.low` (null: clear).

The reference takes from the calculator the barrel elevation (the solver's `roots.low`), the weapon's shot parameters (`getShot`)
and the two clearance constants (`MUZZLE_CLEARANCE`, `TARGET_CLEARANCE`). `heightmap.mjs` reads
`meta.json`, the 16-bit `heightmap.png` (own decoder over `node:zlib`, the sum of the levels is checked against
`meta.json`) and the `HMD1` detail from their file layouts, and imports nothing of `src/` or `engine/`.

Counted per map and weapon: lines, blocked (by exact), found (blocked by the page too), missed (blocked by exact, clear on
the page), false blocks (clear by exact, blocked on the page), and the depth of each missed line: how far under the ground
the exact lowest point of the path is.

## Lines

`lines.mjs`: nothing is stored, the seed is. The seed of a map is 1234567 plus the sum of the character codes of its name,
and the weapons draw from the one stream in the order Tank AP, ZiS-3, Mk19. A line starts uniformly in the inner 90 % of
the map, with a uniform bearing, a distance of 150 to 1500 m and a height padding of 0 to 3 m in steps of 0.5 m; it
is dropped when an end is off the lattice or the map. A line the weapon cannot fire (no elevation within its limits or
lifespan, which the page shows without an obstacle) is drawn again: exactly 3 000 counted lines per weapon.

## Data

The map files are not in the repository. `SQUADCALC_HEIGHTMAPS` names a directory laid out as the site's
`dist/heightmaps/<map>/{meta.json, heightmap.png, heightmap.detail.bin}` (on tk104: `/home/seregatipich/apps/squadcalc/dist/heightmaps`).
It exits 2, naming the variable, when it is unset or a map is missing. The engine has to be built (`npm run build:engine`).

## Run

```
SQUADCALC_HEIGHTMAPS=<directory> npm run check:terrain -- anvil blackcoast
```

Without a map name, every map of `bounds.json` runs (about 20 s per map). Exit 0: no bound broken; 1: a bound is broken; 2: data or usage.
`.github/workflows/independent-terrain.yml` runs it per map on a self-hosted runner labelled `squadcalc-heightmaps`
that holds the heightmaps and has `SQUADCALC_HEIGHTMAPS` in its environment.

## Bounds

`bounds.json` is a ratchet measured on `dev` at the commit it records: per map and weapon the number of missed lines and the
depth of the worst one (rounded up to a micrometre), exact values without a margin; false blocks are always 0. A change that misses
more lines, or one deeper, fails. A change that misses fewer is reported as `tighten bounds.json`: put the printed
values in. A false block means the page blocks what the exact test passes: the reference and the page disagree on the surface.
`blocked` is a floor: the number of lines the exact test blocks. A reference that blocks fewer lines than the floor has got
weaker (a lost crossing, a plain parabola for the capped arc) and fails; one that blocks more is reported as `tighten`.
The floor and the false blocks are the only guards on the reference itself: a weaker reference passes the bounds on missed lines.

Measured on 2026-11-16, 54 000 lines: the exact test blocks 39 649, the page finds 39 413, misses 236 (0.60 %), 0 false
blocks; the worst miss is 6.516 m under the ground (Fallujah, Mk19), the median miss 0.6 cm to 1.08 m per map and weapon (Black Coast's Tank AP has 2 misses). When
the page's check becomes exact the bounds become 0 and 0 m.

## What it can and cannot show

- It checks the page's sampled test, not the volume layer (`getVolumeObstacle`, which has its own voxel walk).
- The reference and the page read the same decoded levels, so a wrong PNG decode would not show; the checksum of `meta.json`
  catches that. The surface rule (triangle split, sub-grid, edge nodes shared with a quad that has none) is written twice,
  here and in `engine/src/heightmap`; a difference between the two shows as a false block or a changed miss count.
- Remove the crossings of columns and diagonals from `lowestClearance` and the check fails with false blocks on every map; remove
  only one of the two families, or the speed cap of the arc, and it fails on the `blocked` floor.
