/**
 * The servers of server mode (src/js/serversSource.js): the map of a layer, the home feed (age, shape), what is
 * left when the feed is missing or broken, and what server mode does with the followed server after a read of the feed.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MAPS } from "../src/data/maps.js";
import { HOME_FEED_MAX_AGE_MS, canFollow, feedReader, followDecision, homeServers, mapNameOfLayer, serversAfterRead } from "../src/js/serversSource.js";

// One layer of every map, as the game names it
const LAYER_OF_MAP = {
    AlBasrah: "AlBasrah_Seed_v2", Anvil: "Anvil_RAAS_v2", BlackCoast: "BlackCoast_AAS_v1", Chora: "Chora_Skirmish_v1",
    Fallujah: "Fallujah_Invasion_v3_CL", FoolsRoad: "FoolsRoad_Skirmish_v2", GooseBay: "GooseBay_Invasion_v1",
    Gorodok: "Gorodok_RAAS_v2", Harju: "Harju_AAS_v1", Jensen: "JensensRange_WPMC-TLF", Kamdesh: "Kamdesh_RAAS_v1",
    Kohat: "Kohat_RAAS_v2", Kokan: "Kokan_RAAS_v1", Lashkar: "Lashkar_AAS_v2", Logar: "Logar_Seed_v1",
    Manicouagan: "Manicouagan_Invasion_v1", Mestia: "Mestia_AAS_v1", Mutaha: "Mutaha_RAAS_v2", Narva: "Narva_Invasion_v2",
    Pacific: "PacificProvingGrounds_AAS_v1", Sanxian: "Sanxian_Seed_v1", Skorpo: "Skorpo_Invasion_v1",
    Sumari: "Sumari_Seed_v1", Tallil: "Tallil_Invasion_v1", Yehorivka: "Yehorivka_Invasion_v1",
};
const NOW = Date.parse("2026-11-10T00:00:00Z");
const GENERATED = "2026-11-09T23:59:50Z";
const home = (overrides = {}) => ({
    id: "deadline",
    attributes: { name: "[RU] Deadline", players: 12, maxPlayers: 100, details: { map: "AlBasrah_RAAS_v1" } },
    team1: "AFU",
    team2: "RGF",
    ...overrides,
});

const realFetch = globalThis.fetch;
const realHomeUrl = process.env.HOME_SERVERS_URL;
const realWarn = console.warn;
afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    if (realHomeUrl === undefined) delete process.env.HOME_SERVERS_URL;
    else process.env.HOME_SERVERS_URL = realHomeUrl;
});

/**
 * Replaces `fetch` by answers per URL; an answer is a Response or an Error to reject with. Returns the requests made,
 * each `[URL, options]`.
 */
function stubFetch(answers) {
    const asked = [];
    globalThis.fetch = async (url, options) => {
        asked.push([url, options]);
        const answer = answers[url];
        if (answer instanceof Error) throw answer;
        return answer.clone();
    };
    return asked;
}
const json = (body, init = {}) => new Response(JSON.stringify(body), init);
/** The home servers of a fresh feed with `servers`, as `fetchServers` gives them */
const read = (...servers) => homeServers({ generated: GENERATED, servers }, NOW);

test("every map is found from a layer of its own", () => {
    assert.deepEqual(Object.keys(LAYER_OF_MAP).sort(), MAPS.map(map => map.name).sort());
    for (const [map, layer] of Object.entries(LAYER_OF_MAP)) assert.equal(mapNameOfLayer(layer), map, layer);
});

test("a layer of no known map has no map", () => {
    assert.equal(mapNameOfLayer("SU_Belaya_AAS_v1"), null);
    assert.equal(mapNameOfLayer(undefined), null);
});

test("a layer belongs to the map with the longest name that starts its own", () => {
    for (const maps of [[{ name: "Kokan" }, { name: "KokanValley" }], [{ name: "KokanValley" }, { name: "Kokan" }]]) {
        assert.equal(mapNameOfLayer("KokanValley_RAAS_v1", maps), "KokanValley");
        assert.equal(mapNameOfLayer("Kokan_RAAS_v1", maps), "Kokan");
        assert.equal(mapNameOfLayer("Kohat_RAAS_v1", maps), null);
    }
});

test("a fresh home feed gives its servers with their map", () => {
    const [server] = homeServers({ generated: GENERATED, servers: [home()] }, NOW);
    assert.equal(server.mapName, "AlBasrah");
    assert.equal(server.attributes.details.map, "AlBasrah_RAAS_v1");
    assert.equal(server.team1, "AFU");
});

test("a home feed is dropped once older than the limit, or without a readable time or list", () => {
    const servers = [home()];
    const at = (ageMs) => new Date(NOW - ageMs).toISOString();
    assert.equal(homeServers({ generated: at(HOME_FEED_MAX_AGE_MS), servers }, NOW).length, 1);
    assert.equal(homeServers({ generated: at(HOME_FEED_MAX_AGE_MS + 1000), servers }, NOW).length, 0);
    assert.equal(homeServers({ servers }, NOW).length, 0);
    assert.equal(homeServers({ generated: "yesterday", servers }, NOW).length, 0);
    assert.equal(homeServers({ generated: GENERATED }, NOW).length, 0);
    assert.equal(homeServers(null, NOW).length, 0);
});

test("a home server without an id, a name or a layer is left out", () => {
    const servers = [home({ id: "" }), home({ attributes: { details: { map: "AlBasrah_RAAS_v1" } } }), home({ attributes: { name: "x", details: {} } }), home({ id: "kept" })];
    assert.deepEqual(homeServers({ generated: GENERATED, servers }, NOW).map(server => server.id), ["kept"]);
});

test("a read of the feed gives its servers; the feed's age is counted from its response's Date", async () => {
    process.env.HOME_SERVERS_URL = "/live/servers.json";
    const feed = { generated: GENERATED, servers: [home()] };
    const asked = stubFetch({ "/live/servers.json": json(feed, { headers: { Date: new Date(NOW).toUTCString() } }) });
    const servers = await feedReader()();
    assert.deepEqual(servers.map(server => [server.id, server.mapName]), [["deadline", "AlBasrah"]]);
    assert.equal(asked.length, 1);
    const [url, options] = asked[0];
    assert.equal(url, "/live/servers.json");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);

    stubFetch({ "/live/servers.json": json(feed, { headers: { Date: new Date(NOW + HOME_FEED_MAX_AGE_MS + 60000).toUTCString() } }) });
    assert.deepEqual(await feedReader()(), []);
});

test("the age of a feed whose response has no Date is counted from the device's clock", async () => {
    process.env.HOME_SERVERS_URL = "/live/servers.json";
    const at = (ageMs) => ({ generated: new Date(NOW - ageMs).toISOString(), servers: [home()] });
    const read = () => feedReader(() => NOW)();
    stubFetch({ "/live/servers.json": json(at(10000)) });
    assert.deepEqual((await read()).map(server => server.id), ["deadline"]);
    stubFetch({ "/live/servers.json": json(at(10000), { headers: { Date: "not a date" } }) });
    assert.deepEqual((await read()).map(server => server.id), ["deadline"]);
    stubFetch({ "/live/servers.json": json(at(HOME_FEED_MAX_AGE_MS + 60000)) });
    assert.deepEqual(await read(), []);
});

test("a deployment without a home feed has no servers and asks for none", async () => {
    delete process.env.HOME_SERVERS_URL;
    const asked = stubFetch({});
    assert.deepEqual(await feedReader()(), []);
    assert.deepEqual(asked, []);
});

test("a missing or broken feed gives no servers to a page that has read none", async () => {
    process.env.HOME_SERVERS_URL = "/live/servers.json";
    console.warn = () => {};
    for (const answer of [new Response("", { status: 404 }), new Response("<html>"), new TypeError("network")]) {
        stubFetch({ "/live/servers.json": answer });
        assert.deepEqual(await feedReader()(), []);
    }
});

test("after a read that fails, the servers of the last read stand while their feed is fresh, and no longer", () => {
    const last = { servers: [home()], freshUntil: NOW + 50000 };
    const read = { servers: [], freshUntil: 0 };
    assert.equal(serversAfterRead(last, read, NOW), read, "a feed that was read is what counts, empty or not");
    assert.equal(serversAfterRead(last, null, NOW + 50000), last);
    assert.deepEqual(serversAfterRead(last, null, NOW + 50001).servers, []);
});

test("one failed request does not lose the server; the feed's own age still ends it", async () => {
    process.env.HOME_SERVERS_URL = "/live/servers.json";
    console.warn = () => {};
    let now = NOW;
    const read = feedReader(() => now);
    const ids = async () => (await read()).map(server => server.id);
    // Written 10 s before it was served: fresh for 110 s more
    const fresh = () => json({ generated: new Date(now - 10000).toISOString(), servers: [home()] }, { headers: { Date: new Date(now).toUTCString() } });
    stubFetch({ "/live/servers.json": fresh() });
    assert.deepEqual(await ids(), ["deadline"]);

    for (const answer of [new TypeError("network"), new Response("", { status: 502 }), new Response("<html>")]) {
        now += 20000;
        stubFetch({ "/live/servers.json": answer });
        assert.deepEqual(await ids(), ["deadline"], `still listed ${(now - NOW) / 1000} s after the last read`);
    }
    now = NOW + 110000;
    assert.deepEqual(await ids(), ["deadline"], "listed until the feed is 120 s old");
    now = NOW + 111000;
    assert.deepEqual(await ids(), [], "not listed once the feed is older");

    now += 20000;
    stubFetch({ "/live/servers.json": fresh() });
    assert.deepEqual(await ids(), ["deadline"], "listed again with the next feed");
    // A feed that is read counts at once, whatever the read before left
    stubFetch({ "/live/servers.json": json({ generated: new Date(now).toISOString(), servers: [] }, { headers: { Date: new Date(now).toUTCString() } }) });
    assert.deepEqual(await ids(), []);
});

test("the calculator can show a server on a layer of a map it has, with the faction of both teams", () => {
    const [shown, noTeam1, noTeam2, unknownMap] = read(home(), home({ team1: undefined }), home({ team2: null }),
        home({ attributes: { name: "[RU] Deadline", details: { map: "SU_Belaya_AAS_v1" } } }));
    assert.equal(canFollow(shown), true);
    assert.equal(canFollow(noTeam1), false);
    assert.equal(canFollow(noTeam2), false);
    assert.equal(canFollow(unknownMap), false);
});

test("server mode opens the layer the followed server plays, and stays on it while the server does", () => {
    const servers = read(home({ id: "other", attributes: { name: "Other", details: { map: "Narva_AAS_v1" } } }), home());
    assert.deepEqual(followDecision(servers, "deadline", null), { action: "switch", server: servers[1] });
    assert.deepEqual(followDecision(servers, "deadline", "Mutaha_Seed_v1"), { action: "switch", server: servers[1] });
    assert.deepEqual(followDecision(servers, "deadline", "AlBasrah_RAAS_v1"), { action: "stay", server: servers[1] });
    assert.equal(followDecision(read(home({ id: 7 })), "7", null).action, "switch");
});

test("server mode is left when the followed server is not in the feed", () => {
    const gone = { action: "leave", reason: "serverNotFound" };
    assert.deepEqual(followDecision([], "deadline", "AlBasrah_RAAS_v1"), gone);
    assert.deepEqual(followDecision(read(home({ id: "other" })), "deadline", "AlBasrah_RAAS_v1"), gone);
    const stale = homeServers({ generated: new Date(NOW - HOME_FEED_MAX_AGE_MS - 1000).toISOString(), servers: [home()] }, NOW);
    assert.deepEqual(followDecision(stale, "deadline", "AlBasrah_RAAS_v1"), gone);
});

test("server mode is left when the followed server plays what the calculator cannot show", () => {
    const unavailable = { action: "leave", reason: "serverLayerUnavailable" };
    const unknownMap = home({ attributes: { name: "[RU] Deadline", details: { map: "SU_Belaya_AAS_v1" } } });
    for (const shownLayer of [null, "AlBasrah_RAAS_v1", "SU_Belaya_AAS_v1"]) {
        assert.deepEqual(followDecision(read(unknownMap), "deadline", shownLayer), unavailable);
        assert.deepEqual(followDecision(read(home({ team1: undefined })), "deadline", shownLayer), unavailable);
        assert.deepEqual(followDecision(read(home({ team2: undefined })), "deadline", shownLayer), unavailable);
    }
});
