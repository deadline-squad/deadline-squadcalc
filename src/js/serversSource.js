/**
 * The servers of server mode: the home servers of this deployment (`HOME_SERVERS_URL`: a same-origin JSON
 * `{ generated, servers }` written by `deploy/live_servers.py` of the deployment repository from the game host's own
 * status). A home server has the shape of the upstream API's servers without `mapName`, which is found here from its
 * layer. Also what server mode does with the server it follows after each read of the feed (`followDecision`).
 */
import { MAPS } from "../data/maps.js";

/**
 * The feed is read again this often: the period its writer rewrites it at.
 */
export const HOME_FEED_PERIOD_MS = 20000;

/**
 * A home feed older than this is dropped: its writer has stopped, and the layer it names may no longer be the one
 * played.
 */
export const HOME_FEED_MAX_AGE_MS = 120000;

const FETCH_TIMEOUT_MS = 10000;


/**
 * The map of a layer: the one whose name starts the layer's name ("JensensRange_Seed_v1" is a layer of "Jensen"),
 * the longest such name when one map's name starts another's.
 * @param {string} layer - the layer's raw name, e.g. "AlBasrah_RAAS_v1"
 * @param {Array<{name: string}>} [maps] - the maps to look in
 * @returns {string|null} the name of the map, null for a layer of no map in `maps`
 */
export function mapNameOfLayer(layer, maps = MAPS) {
    const name = String(layer).toLowerCase();
    const found = maps.filter(map => name.startsWith(map.name.toLowerCase()));
    if (found.length === 0) return null;
    return found.reduce((longest, map) => (map.name.length > longest.name.length ? map : longest)).name;
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
 * Whether the calculator can show what a home server plays: a layer of a map it has, with the faction of both teams
 * (the feed leaves a team out when the layer API does not have the layer or the layer does not offer the faction).
 * @param {object} server - a server of `homeServers`
 * @returns {boolean}
 */
export function canFollow(server) {
    return Boolean(server.mapName && server.team1 && server.team2);
}


/**
 * What server mode does with the server it follows, after a read of the feed.
 * @param {Array} servers - the servers of the feed just read (`homeServers`)
 * @param {string} serverId - the id of the followed server
 * @param {string|null} shownLayer - the layer the page has opened for it, null when it has opened none yet
 * @returns {{action: "leave", reason: string}|{action: "switch"|"stay", server: object}} `leave` when the feed does
 *   not confirm the server: it is not in the feed (`reason` "serverNotFound") or plays what the calculator cannot show
 *   (`canFollow`; `reason` "serverLayerUnavailable"), `reason` being the `tooltips` key of the message for the user;
 *   `switch` when the server plays another layer than `shownLayer`; `stay` when it plays `shownLayer`
 */
export function followDecision(servers, serverId, shownLayer) {
    const server = servers.find(candidate => String(candidate.id) === String(serverId));
    if (!server) return { action: "leave", reason: "serverNotFound" };
    if (!canFollow(server)) return { action: "leave", reason: "serverLayerUnavailable" };
    return { action: server.attributes.details.map === shownLayer ? "stay" : "switch", server };
}


/**
 * The servers and how long they may be gone by: until the feed they were read from is `HOME_FEED_MAX_AGE_MS` old.
 * @typedef {{servers: Array, freshUntil: number}} FeedRead - `freshUntil` in ms on the device's clock
 */
const NO_SERVERS = { servers: [], freshUntil: 0 };


/**
 * The servers to go by after a read of the feed: those just read or, when the feed could not be read (the device was
 * offline for a moment, the request timed out), those of the read before for as long as their feed is fresh. One
 * failed request thus does not throw a page out of server mode, and a state older than `HOME_FEED_MAX_AGE_MS` is
 * still never shown.
 * @param {FeedRead} last - what the read before left to go by
 * @param {FeedRead|null} read - the read just made, null when the feed could not be read
 * @param {number} now - ms on the device's clock
 * @returns {FeedRead}
 */
export function serversAfterRead(last, read, now) {
    if (read) return read;
    return now <= last.freshUntil ? last : NO_SERVERS;
}


/**
 * Reads the home feed once. The feed's age is taken against the `Date` header of its own response, so a wrong clock
 * on the user's device does not drop a fresh feed; a response without that header is taken against the device's
 * clock.
 * @param {number} now - ms on the device's clock
 * @returns {Promise<FeedRead|null>} no servers when the deployment has no feed; null when the feed cannot be read
 *   (no connection, a timeout, an error status, a body that is not JSON)
 */
async function readFeed(now) {
    if (!process.env.HOME_SERVERS_URL) return NO_SERVERS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(process.env.HOME_SERVERS_URL, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const header = Date.parse(response.headers.get("Date"));
        const served = Number.isNaN(header) ? now : header;
        const feed = await response.json();
        const servers = homeServers(feed, served);
        return { servers, freshUntil: servers.length ? now + HOME_FEED_MAX_AGE_MS - (served - Date.parse(feed.generated)) : 0 };
    } catch (error) {
        console.warn("Home servers feed unavailable:", error);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}


/**
 * A reader of the home feed that remembers its last read (`serversAfterRead`).
 * @param {function(): number} [clock] - the device's clock, ms
 * @returns {function(): Promise<Array>} reads the feed and gives the home servers to go by; none when the deployment
 *   has no feed, or the feed cannot be read and the last read is no longer fresh
 */
export function feedReader(clock = Date.now) {
    let last = NO_SERVERS;
    return async () => {
        const read = await readFeed(clock());
        last = serversAfterRead(last, read, clock());
        return last.servers;
    };
}


/**
 * The home servers, from the one reader the page shares: the servers list and the menu's dropdown go by the same read.
 */
export const fetchServers = feedReader();
