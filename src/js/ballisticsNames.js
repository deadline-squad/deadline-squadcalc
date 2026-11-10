/**
 * The names a weapon of weapons.js goes by in Squad Ballistics' weapons.json, for the
 * `window.squadBallistics` bridge (`SquadCalc.selectBallisticsWeapon`): `ballistics` (its name there),
 * `ballisticsViews` (the names of its other views: the zoom levels of a gunner's sight, the normal view
 * next to an optic; same firing solution, another picture in the overlay), `legacyBallistics` (the
 * names it had before a rename, which an older Squad Ballistics still sends) and `legacyBallisticsViews`
 * (the names its other views had before a rename, each with the view's current name).
 */

/**
 * Find the weapon Squad Ballistics calls `name`, and the name the bridge reports for it afterwards.
 * Squad Ballistics switches its own picker to the name the page reports, so a current name is reported
 * back as it came, whichever view it is of; a name from before a rename is reported as the current name
 * of what it named: the weapon's own, or the view's when it was the name of a view.
 * @param {Array<{ballistics?: string|null, ballisticsViews?: string[], legacyBallistics?: string[], legacyBallisticsViews?: Object<string, string>}>} weapons - WEAPONS
 * @param {string} name - a weapon name of Squad Ballistics
 * @returns {{index: number, reported: string}|null} - the weapon's index in `weapons` and the name to
 *   report, or null when no weapon has that name
 */
export function matchBallisticsName(weapons, name) {
    if (typeof name !== "string") return null;
    for (const [index, weapon] of weapons.entries()) {
        if (weapon.ballistics === name || weapon.ballisticsViews?.includes(name)) return { index, reported: name };
        if (weapon.legacyBallistics?.includes(name)) return { index, reported: weapon.ballistics };
        // Own keys only: "constructor" is no weapon name
        const renamedViews = weapon.legacyBallisticsViews;
        if (renamedViews && Object.hasOwn(renamedViews, name)) return { index, reported: renamedViews[name] };
    }
    return null;
}
