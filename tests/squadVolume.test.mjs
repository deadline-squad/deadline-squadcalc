/**
 * The load of the volume layer (squadVolume.js) when the setting is switched while meta.json is still being
 * fetched: one worker is started and kept, the other load stops (review of 45.22 to 45.26, finding 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "./stubs/app.mjs";

const events = [];
const workers = [];

class FakeWorker {
    constructor() {
        this.terminated = false;
        workers.push(this);
    }

    postMessage() {
        queueMicrotask(() => this.onmessage({ data: { loaded: true } }));
    }

    terminate() {
        this.terminated = true;
    }
}

globalThis.$ = () => ({ on: () => {}, trigger: (name) => events.push(name) });
globalThis.document = {};
globalThis.window = { location: { origin: "http://localhost" } };
globalThis.Worker = FakeWorker;
globalThis.requestAnimationFrame = (callback) => callback();

const { default: SquadVolume } = await import("../src/js/squadVolume.js");

const META = { bounds_m: [0, 0, 1, 1], z_min_m: 0, generated: "g", volume: { bytes: 1, terrain: { bytes: 1 } } };

test("turning the setting off and on while meta.json is being fetched starts one worker, and no other stays alive", async () => {
    const heightmap = { failed: false };
    const map = { heightmap, activeMap: { mapURL: "/maps/test/" }, updateTargets: () => {} };
    const volume = new SquadVolume(map);
    const releases = [];
    globalThis.fetch = () => new Promise((resolve) => releases.push(() => resolve({ ok: true, json: async () => META })));
    App.userSettings = { volumeLayer: true };

    const first = volume.load();
    App.userSettings.volumeLayer = false;
    volume.applySetting();
    App.userSettings.volumeLayer = true;
    volume.applySetting();
    assert.equal(releases.length, 2, "two fetches of meta.json are under way");
    releases.forEach((release) => release());
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(volume.state, "ready");
    assert.equal(workers.filter((worker) => !worker.terminated).length, 1, "one worker is alive");
    assert.equal(workers.length, 1, "and only one was started");
    assert.equal(events.filter((name) => name === "volume:ready").length, 1, "volume:ready once");
});

test("a map whose meta.json has no volume entry (Belaya Pass, terrain only) starts no worker and keeps the heightmap", async () => {
    const before = workers.length;
    const heightmap = { failed: false };
    const map = { heightmap, activeMap: { mapURL: "/img/maps/belaya/" }, updateTargets: () => {} };
    const volume = new SquadVolume(map);
    const requested = [];
    const terrainOnlyMeta = { map: "Belaya", bounds_m: { min_x: -1954, max_x: 1950, min_y: -2080, max_y: 1825 }, z_min_m: -307.2, generated: "g", provenance: "terrain only" };
    globalThis.fetch = async (url) => {
        requested.push(url);
        return { ok: true, json: async () => terrainOnlyMeta };
    };
    App.userSettings = { volumeLayer: true };

    await volume.load();

    assert.equal(volume.state, "unavailable");
    assert.equal(volume.ready, false);
    assert.equal(workers.length, before, "no worker started");
    assert.deepEqual(requested, ["http://localhost/heightmaps/belaya/meta.json"], "only meta.json was fetched");
    assert.equal(map.heightmap, heightmap, "the heightmap stays");
});
