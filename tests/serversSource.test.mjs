/**
 * The servers of server mode (src/js/serversSource.js): the map of a layer, the home feed (age, shape) and what is
 * left when the feed is missing or broken.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MAPS } from "../src/data/maps.js";
import { HOME_FEED_MAX_AGE_MS, fetchServers, homeServers, mapNameOfLayer } from "../src/js/serversSource.js";

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

/** Replaces `fetch` by answers per URL; an answer is a Response or an Error to reject with. Returns the URLs asked. */
function stubFetch(answers) {
    const asked = [];
    globalThis.fetch = async (url) => {
        asked.push(url);
        const answer = answers[url];
        if (answer instanceof Error) throw answer;
        return answer.clone();
    };
    return asked;
}
const json = (body, init = {}) => new Response(JSON.stringify(body), init);

test("every map is found from a layer of its own", () => {
    assert.deepEqual(Object.keys(LAYER_OF_MAP).sort(), MAPS.map(map => map.name).sort());
    for (const [map, layer] of Object.entries(LAYER_OF_MAP)) assert.equal(mapNameOfLayer(layer), map, layer);
});

test("a layer of no known map has no map", () => {
    assert.equal(mapNameOfLayer("SU_Belaya_AAS_v1"), null);
    assert.equal(mapNameOfLayer(undefined), null);
});

test("a fresh home feed gives its servers, marked home and with their map", () => {
    const [server] = homeServers({ generated: GENERATED, servers: [home()] }, NOW);
    assert.equal(server.home, true);
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

test("fetchServers gives the feed's servers; the feed's age is counted from its response's Date", async () => {
    process.env.HOME_SERVERS_URL = "/live/servers.json";
    const feed = { generated: GENERATED, servers: [home()] };
    const asked = stubFetch({ "/live/servers.json": json(feed, { headers: { Date: new Date(NOW).toUTCString() } }) });
    const servers = await fetchServers();
    assert.deepEqual(servers.map(server => [server.id, server.mapName, server.home]), [["deadline", "AlBasrah", true]]);
    assert.deepEqual(asked, ["/live/servers.json"]);

    stubFetch({ "/live/servers.json": json(feed, { headers: { Date: new Date(NOW + HOME_FEED_MAX_AGE_MS + 60000).toUTCString() } }) });
    assert.deepEqual(await fetchServers(), []);
});

test("a deployment without a home feed has no servers and asks for none", async () => {
    delete process.env.HOME_SERVERS_URL;
    const asked = stubFetch({});
    assert.deepEqual(await fetchServers(), []);
    assert.deepEqual(asked, []);
});

test("a missing or broken feed gives no servers", async () => {
    process.env.HOME_SERVERS_URL = "/live/servers.json";
    console.warn = () => {};
    for (const answer of [new Response("", { status: 404 }), new Response("<html>"), new TypeError("network")]) {
        stubFetch({ "/live/servers.json": answer });
        assert.deepEqual(await fetchServers(), []);
    }
});
