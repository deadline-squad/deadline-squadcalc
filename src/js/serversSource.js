/**
 * The servers of server mode: the home servers of this deployment (`HOME_SERVERS_URL`: a same-origin JSON
 * `{ generated, servers }` written by `deploy/live_servers.py` of the deployment repository from the game host's own
 * status). A home server has the shape of the upstream API's servers without `mapName`, which is found here from its
 * layer.
 */
import { MAPS } from "../data/maps.js";

/**
 * A home feed older than this is dropped: its writer has stopped, and the layer it names may no longer be the one
 * played. The writer rewrites the feed every 20 s.
 */
export const HOME_FEED_MAX_AGE_MS = 120000;

const FETCH_TIMEOUT_MS = 10000;


/**
 * The map of a layer: the one whose name starts the layer's name ("JensensRange_Seed_v1" is a layer of "Jensen").
 * @param {string} layer - the layer's raw name, e.g. "AlBasrah_RAAS_v1"
 * @returns {string|null} the name of the map in `MAPS`, null for a layer of no known map
 */
export function mapNameOfLayer(layer) {
    const name = String(layer).toLowerCase();
    const maps = MAPS.filter(map => name.startsWith(map.name.toLowerCase()));
    if (maps.length === 0) return null;
    return maps.reduce((longest, map) => (map.name.length > longest.name.length ? map : longest)).name;
}


/**
 * The servers of a home feed, each given its map.
 * @param {object} feed - `{ generated: ISO time, servers: [...] }`
 * @param {number} now - the time the feed was received, in ms
 * @returns {Array} empty for a malformed feed or one older than `HOME_FEED_MAX_AGE_MS`
 */
export function homeServers(feed, now) {
    if (!Array.isArray(feed?.servers)) return [];
    if (!(now - Date.parse(feed.generated) <= HOME_FEED_MAX_AGE_MS)) return [];
    return feed.servers
        .filter(server => server?.id && server.attributes?.name && server.attributes.details?.map)
        .map(server => ({ ...server, mapName: mapNameOfLayer(server.attributes.details.map) }));
}


/**
 * The home servers; none when the deployment has no feed or the feed cannot be read. The feed's age is taken against
 * the `Date` header of its own response, so a wrong clock on the user's device does not drop a fresh feed.
 * @returns {Promise<Array>}
 */
export async function fetchServers() {
    if (!process.env.HOME_SERVERS_URL) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(process.env.HOME_SERVERS_URL, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const served = Date.parse(response.headers.get("Date"));
        return homeServers(await response.json(), Number.isNaN(served) ? Date.now() : served);
    } catch (error) {
        console.warn("Home servers feed unavailable:", error);
        return [];
    } finally {
        clearTimeout(timeout);
    }
}
