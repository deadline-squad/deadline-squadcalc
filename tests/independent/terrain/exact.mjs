// The exact reference: the lowest clearance of a shell's path over a heightmap's ground track, computed from the shell's
// closed parabola and the ground's own crossings, with no sampling step. Independent of the calculator's height code
// (heightmap.mjs reads the files itself); the elevation and the shot's parameters are what it takes from the calculator.

/**
 * The height of a shell that flies a parabola, from the weapon's parameters and the barrel elevation. The barrel pivots
 * `pivotHeight` above the ground; the shell leaves the muzzle, `muzzleForward` along the barrel and `muzzleUp` above its
 * axis, at `velocity` along the barrel, and falls under `gravity`:
 *     start = (forward * cos - up * sin, pivot + forward * sin + up * cos)
 *     z(s) = start.y + t * (v * sin - gravity * t / 2),  t = (s - start.x) / (v * cos)
 * Where the shell has fallen so far that its speed would pass `maxSpeed` (only a shell launched at its cap does, once it
 * is below the muzzle), the speed is held there and gravity only turns the direction: the path is an arc of radius
 * R = maxSpeed^2 / gravity, from the point where the free fall reaches the cap, at angle phi below the horizontal,
 *     z(s) = z_cap + R * ln(cos(phi) / cos(phi_cap)),  phi = phi_cap + (s - s_cap) / R,  cos(phi_cap) = vx / maxSpeed
 * @param {{velocity: number, gravity: number, acceleration: number, boostTime: number, maxSpeed: number, pivotHeight: number,
 *   muzzleForward: number, muzzleUp: number}} shot - Weapon.getShot of the calculator
 * @param {number} angle - barrel elevation, radians
 * @returns {function(number): number} - height above the pivot ground at horizontal distance s from the pivot, metres,
 *   concave in s; minus infinity where the held shell would be falling straight down
 * @throws {Error} - when the shot is not of this kind: no gravity, a motor, or a launch above the speed cap
 */
export function flightPath(shot, angle) {
    if (!(shot.gravity > 0)) throw new Error("not a parabola: no gravity");
    if (shot.acceleration || shot.boostTime) throw new Error("not a parabola: a motor");
    const cap = shot.maxSpeed || Infinity;
    if (shot.velocity > cap) throw new Error("not a parabola: launched above the speed cap");
    const g = shot.gravity;
    const vx = shot.velocity * Math.cos(angle);
    const vy = shot.velocity * Math.sin(angle);
    const startX = shot.muzzleForward * Math.cos(angle) - shot.muzzleUp * Math.sin(angle);
    const startY = shot.pivotHeight + shot.muzzleForward * Math.sin(angle) + shot.muzzleUp * Math.cos(angle);
    const free = (t) => startY + t * (vy - 0.5 * g * t);

    // Seconds after the launch when the free fall reaches the cap (never, without a cap)
    const capTime = Number.isFinite(cap) ? Math.max(0, (vy + Math.sqrt(Math.max(0, cap * cap - vx * vx))) / g) : Infinity;
    const radius = cap * cap / g;
    const phiCap = Math.acos(Math.min(1, vx / cap));
    return (s) => {
        const t = (s - startX) / vx;
        if (t <= capTime) return free(t);
        const phi = phiCap + (s - startX - vx * capTime) / radius;
        if (phi >= Math.PI / 2) return -Infinity;
        return free(capTime) + radius * Math.log(Math.cos(phi) / Math.cos(phiCap));
    };
}

/**
 * The lowest clearance z(s) - ground(s) over the ground track A + s * u, s in [s0, s1] metres, for a concave z(s). The
 * ground is linear between the track's crossings of the lines of the sub-grid (rows, columns and diagonals at every 1/f
 * of the lattice), z minus a linear function is concave there, so the minimum is at a crossing or at an end.
 * @param {{factor: number, terrainAt: function(number, number): number, toLattice: function(number, number): number[]}} field -
 *   readHeightmap
 * @param {number} ax - world X of A
 * @param {number} ay - world Y of A
 * @param {number} ux - X of the unit direction of the track
 * @param {number} uy - Y of the unit direction of the track
 * @param {number} s0 - metres from A
 * @param {number} s1 - metres from A
 * @param {function(number): number} z - the path's height above the lowest level at metres s from A, concave
 * @returns {number} - the lowest clearance, metres; negative when the path goes under the ground
 */
export function lowestClearance(field, ax, ay, ux, uy, s0, s1, z) {
    const { factor, terrainAt, toLattice } = field;
    const [col0, row0] = toLattice(ax, ay);
    const [col1, row1] = toLattice(ax + ux, ay + uy);
    const perCol = col1 - col0; // lattice units per metre
    const perRow = row1 - row0;

    const crossings = [s0, s1];
    const family = (p0, perMetre) => { // where p0 + s * perMetre is a multiple of 1/factor
        if (Math.abs(perMetre) < 1e-15) return;
        const a = (p0 + s0 * perMetre) * factor;
        const b = (p0 + s1 * perMetre) * factor;
        for (let k = Math.ceil(Math.min(a, b)); k <= Math.floor(Math.max(a, b)); k++) {
            const s = (k / factor - p0) / perMetre;
            if (s > s0 && s < s1) crossings.push(s);
        }
    };
    family(col0, perCol);
    family(row0, perRow);
    family(col0 - row0, perCol - perRow);

    let lowest = Infinity;
    for (const s of crossings) lowest = Math.min(lowest, z(s) - terrainAt(col0 + s * perCol, row0 + s * perRow));
    return lowest;
}
