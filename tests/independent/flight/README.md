# Independent flight oracle

Checks the calculator's solver (`src/js/squadBallistics.js`) against a flight simulator that shares no code with it.
`npm test` runs it through `tests/independentFlight.test.mjs`.

## What it checks

For every shell of `src/data/weapons.js`, `cases.mjs` asks the calculator's solver for the elevations that land on a
grid of targets: 16 fixed distances and 9 fractions of the weapon's range (0.02 to 0.999), 10 target heights from -300 m
to +200 m, both arcs, roots that do not exist dropped. A root the calculator would not show is dropped too: outside the
weapon's elevation range (`minElevation`, less `angleOffset`) or reached after its `projectileLifespan`.
`fly.c` flies each elevation through the game's discrete model and reports where the flight crosses the target distance.

The miss of a case is the distance of the flight from the target measured across the path:
`|dy| / sqrt(1 + slope^2)`, `dy` being the flight's height above the target where it crosses the target's distance and
`slope` the slope of the step's chord there. The test asserts:

- every flight reaches its target distance;
- the number of cases is at least `inLimitsCases` of `bounds.json` (a smaller grid checks less);
- the largest miss of each shell class is at most its `bound`;
- the largest difference between the flight's time and the solver's time of flight is at most `time.bound`.

The shell classes (`CLASSES` of `cases.mjs`, how a shot flies): `capped` (speed cap, launch below 1000 m/s),
`fast_capped` (speed cap, 1000 m/s or more: tank rounds), `grenade` (direct-fire weapon without cap or motor),
`howitzer` (gravity scale 2), `plain_mortar` (the rest), `axis_motor` (rocket whose motor pushes along the barrel's
axis: the UB-32), `path_motor` (rocket whose motor pushes along the path).

## The model

`fly.c` is written from the module docstring of Squad Ballistics (`ballistics.py`, lines 17-63 and 88) and the thesis
formulas F1 to F5 (`docs/thesis-methods-and-results.md`), not from the calculator: one velocity-Verlet step per server
frame of 1 / 49.87 s, the motor acting on `ceil(T / dt) - 1` steps, the speed cap applied on every step, the first one
too, the projectile starting at the muzzle. C99, libm only. `fly.c` applies F2 as written; the calculator's `boostSteps`
takes `ceil(T / dt - 1e-9) - 1`, a guard against a `T` that is a whole number of frames up to rounding. The two agree on
every `T` of `weapons.js`.

```
cc -std=c99 -O2 -Wall -Wextra -o fly fly.c -lm
fly specs.txt cases.txt > flights.txt
```

The test compiles `fly.c` into a fresh temporary directory with `cc` and fails, not skips, when there is no compiler.

## Formats

Text, one record per line, numbers separated by a space, in SI units and radians.

`specs.txt`, one shot per line, `sid` from 0:

```
sid v0 g a T cap follows h f u
```

`v0` launch speed (m/s), `g` gravity (m/s^2), `a` motor acceleration (m/s^2, negative slows down), `T` motor time (s),
`cap` speed cap (m/s, 0: none), `follows` 1 when the motor pushes along the path, 0 along the barrel's axis, `h` pivot
height, `f` muzzle distance along the barrel, `u` muzzle height above the barrel's axis (m).

`cases.txt`, one flight per line:

```
sid theta distance height
```

`theta` barrel elevation (rad), `distance` horizontal distance from the pivot to the target (m), `height` target height
above the pivot's ground (m).

`flights.txt`, one line per case, in the order of `cases.txt`:

```
ok dy t slope
```

`ok` is 1 when the flight crosses the distance, 0 when the muzzle is already past it or the projectile turns back (the
other fields are then 0). `dy` is the flight's height minus `height` (m), `t` the time since launch (s), `slope` the slope
of the step's chord (dimensionless).

## Bounds

`bounds.json` holds, per shell class, the largest miss measured on `measuredOn` (date and commit of `dev`) and the
`bound` the test enforces: the measurement rounded up to two significant digits, so the margin stays visible. It holds the
same for the time of flight, and `inLimitsCases`, the number of cases measured. After a change that moves a number on
purpose, measure again (run the test, read the largest misses off its failure messages, or compute them from the flights
as the test does), then record the new measurements and bounds with the commit.

The margin of a bound over its measurement is 0.5 to 3 %, so a change to the weapon data that moves a class's worst case
fails the test and calls for a new measurement. What the measured floors are:

- `grenade`, `howitzer`, `plain_mortar` (under 1 mm): the calculator and the oracle both step the shell, what remains is
  the step that crosses the target distance (F4, the chord).
- `axis_motor` (1.4 mm): the calculator flies the motor along the barrel in closed form, the oracle in steps.
- `capped`, `fast_capped` (5.3 and 3.1 mm): the calculator coasts a shell at its cap on a continuous arc, which the
  game's steps follow to 1e-5 of the turn.
- `path_motor` (2.5 cm, at DF_DZJ_08, a rocket held at its 172 m/s cap): the same coast over a longer flight. It is not
  the Lagrange table of `BoostTable`: nodes every 0.1 degree instead of every degree leave it at 0.02484 m.

`tests/squadBallistics.test.mjs` keeps its own integrator of the server's rocket rule for the rockets, written earlier for
issue #49; this oracle covers every shell and the solver's output, so the older one may go in a later stage.

A deliberately wrong rule in `fly.c` fails the test: a motor acting on `ceil(T / dt)` steps instead of `ceil(T / dt) - 1`
misses the UB-32 by 14 m and the path-following rockets by 2.2 m; a frame of 0.02 s misses the UB-32 by 3.6 m.
