/**
 * A bearing as Squad's HUD compass shows it (native USQCompassMK2, Squad dedicated server build 26005357).
 *
 * The compass turns the view's yaw into a bearing clockwise from north (world -Y) in (0, 360]: exactly north is 360.
 * Its plain text cuts that bearing to a whole degree (`cvttss2si`, toward zero) and pads it to three digits ("00"
 * before it below 10, "0" below 100): the compass shows 045 for every bearing from 45.0 to just below 46.0, so a player who
 * turns until it shows the calculator's bearing rounded to a whole degree lands up to 1.5 degrees off, half a degree
 * on average. The deployable mortar's view switches the compass to its precise mode (`bPreciseBearingMode`), which
 * prints the bearing to a tenth (`%.1f`).
 */

/**
 * What the compass shows when it points exactly at a bearing: the three digits of the plain compass, then the tenth,
 * rounded as the precise mode rounds it but kept within that whole degree (45.96 gives 045 and 9, not 046 and 0: the
 * plain compass shows 046 only from 46.0)
 * @param {number} bearing - degrees clockwise from north, finite, any turn (SquadFiringSolution.getBearing gives [0, 360))
 * @returns {{degrees: string, tenth: string}} - degrees from "000" to "360" (360 for exactly north), tenth from "0" to "9"
 */
export function compassReading(bearing) {
    const turn = ((bearing % 360) + 360) % 360;
    const shown = turn === 0 ? 360 : turn;
    const degrees = Math.trunc(shown);
    const tenth = Math.min(Math.round((shown - degrees) * 10), 9);
    return { degrees: String(degrees).padStart(3, "0"), tenth: String(tenth) };
}

/**
 * The compass reading as text, the tenth after a point
 * @param {number} bearing - degrees clockwise from north
 * @returns {string} - e.g. "045.7"
 */
export function compassText(bearing) {
    const { degrees, tenth } = compassReading(bearing);
    return `${degrees}.${tenth}`;
}

/**
 * The compass reading as HTML: the three digits the game's compass shows, the tenth after them smaller
 * (`.compassTenth`)
 * @param {number} bearing - degrees clockwise from north
 * @returns {string} - e.g. `045<span class="compassTenth">.7</span>`
 */
export function compassHTML(bearing) {
    const { degrees, tenth } = compassReading(bearing);
    return `${degrees}<span class="compassTenth">.${tenth}</span>`;
}
