/**
 * The page's own URL: which query parameters it keeps and in which order.
 */

/** Parameters written first, in this order; the others follow in the order they came */
const PARAM_ORDER = ["map", "layer", "type", "session", "server"];

/**
 * The query string of the page's URL after applying updates.
 *
 * A value that is not null or undefined adds or replaces the parameter, null or undefined removes it. The result is
 * a relative reference made of the query alone, so that resolved against the current address it keeps the path as it
 * is, whatever it is: a pathname put in front of it would start with `//` on the address `//` and be read as a host.
 *
 * @param {string} search - the current query string (`location.search`)
 * @param {Object} updates - parameters to change, for example `{ map: "Kohat", session: null }`
 * @returns {string} - `?` followed by the sorted parameters
 */
export function searchWithUpdates(search, updates) {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined) params.delete(key);
        else params.set(key, value);
    }

    const sorted = new URLSearchParams();
    for (const key of PARAM_ORDER) {
        if (params.has(key)) sorted.set(key, params.get(key));
    }
    for (const [key, value] of params.entries()) {
        if (!PARAM_ORDER.includes(key)) sorted.set(key, value);
    }
    return `?${sorted.toString()}`;
}
