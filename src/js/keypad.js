/**
 * Keypad text of the game's map grid, read and written as the game does (`USQMapConversions::
 * MapLocationToGridCoordinateString` of the Squad dedicated server build 26005357): 300 m keypads lettered A, B, ...
 * from west to east and numbered 1, 2, ... from north to south, counted from the north-west corner of the loaded
 * layer's minimap, each split into 3 x 3 sub-keypads numbered 7 8 9 / 4 5 6 / 1 2 3 from the north. The game prints
 * two levels with an unpadded row (`C3 - 3 - 7`); the calculator prints the row with two digits (`C03-3-7`), goes
 * up to four levels deep and reads both forms.
 */

/** Size of a keypad in metres (`ASQWorldSettings.MapGridSpacing`, which no layer of the game overrides) */
export const KEYPAD = 300;

/**
 * Keypad text of a point
 * @param {number} east - metres east of the map image's north-west corner
 * @param {number} south - metres south of that corner
 * @param {number[]} origin - [east, south] metres from that corner to the grid's north-west corner (`squadGrid.originOffset`)
 * @param {number[]} size - [width, height] of the grid in metres (`squadGrid.areaSize`): outside it the game gives no keypad
 * @param {number} precision - map zoom: up to 2 the keypad alone, then one more sub-keypad a level, four at most from 6
 * @returns {string} for example "C03-3-7", or "" outside the grid
 */
export function keypadText(east, south, origin, size, precision) {
    const x = east - origin[0];
    const y = south - origin[1];
    if (!(x >= 0 && x <= size[0] && y >= 0 && y <= size[1])) return "";

    const letter = String.fromCharCode(65 + Math.floor(x / KEYPAD));
    const row = String(Math.floor(y / KEYPAD) + 1).padStart(2, "0");
    const parts = [`${letter}${row}`];
    const depth = Math.min(Math.max(precision - 2, 0), 4);
    for (let level = 1; level <= depth; level++) {
        const interval = KEYPAD / 3 ** level;
        // the row from the north gives 7, 4 or 1, the column from the west adds 0, 1 or 2
        parts.push(10 - (Math.floor(y / interval) % 3 + 1) * 3 + Math.floor(x / interval) % 3);
    }
    return parts.join("-");
}

/**
 * Tidy a typed keypad: upper case, spaces removed, one dash between the parts. The first part is the letter and the
 * row, padded or not (`C03`, or `C3` as the game prints it): it ends at the first dash, or after three characters
 * when the text has no dash there. Every character after it is one sub-keypad digit. A dash typed last stays, so the
 * game's `C3-` is not read as row 33 once the next digit comes.
 * @param {string} text - for example "c3 - 3 - 7", "C03-3-7" or "c0337"
 * @returns {string} for example "C3-3-7", "C03-3-7" or "C03-3-7"
 */
export function formatKeyPad(text) {
    const compact = text.toUpperCase().replace(/\s/g, "");
    const dash = compact.indexOf("-");
    const head = compact.slice(0, dash >= 0 && dash < 3 ? dash : 3);
    const formatted = [head, ...compact.slice(head.length).replaceAll("-", "")].join("-");
    return compact.length > head.length && compact.endsWith("-") ? `${formatted}-` : formatted;
}

/**
 * Centre of the deepest sub-keypad a keypad text names (inverse of keypadText)
 * @param {string} text - keypad text in any form formatKeyPad reads, for example "C3 - 3 - 7" or "C03-3-7"
 * @param {number[]} origin - [east, south] metres from the map image's north-west corner to the grid's
 * @returns {{east: number, south: number}} - metres east and south of the map image's north-west corner; NaN for a
 * text that is not a letter, a row from 1 to 99 and sub-keypad digits from 1 to 9
 */
export function keypadPosition(text, origin) {
    const [head = "", ...digits] = formatKeyPad(text).split("-").filter((part) => part !== "");
    const keypad = /^([A-Z])(\d{1,2})$/.exec(head);
    if (!keypad || Number(keypad[2]) < 1 || !digits.every((digit) => /^[1-9]$/.test(digit))) return { east: NaN, south: NaN };

    let east = KEYPAD * (keypad[1].charCodeAt(0) - 65);
    let south = KEYPAD * (Number(keypad[2]) - 1);
    let interval = KEYPAD;
    for (const digit of digits.map(Number)) {
        interval /= 3;
        east += interval * ((digit - 1) % 3);
        south += interval * (2 - Math.floor((digit - 1) / 3));
    }
    return { east: origin[0] + east + interval / 2, south: origin[1] + south + interval / 2 };
}
