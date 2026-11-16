/**
 * The page's own URL (src/js/urlParams.js): the parameters it keeps and their order, and that the address it writes
 * back resolves under any path, `//` included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchWithUpdates } from "../src/js/urlParams.js";

test("the parameters are sorted: the known ones first in their order, the others after", () => {
    assert.equal(searchWithUpdates("?session=abc&foo=1&map=Kohat&server=deadline", {}), "?map=Kohat&session=abc&server=deadline&foo=1");
});

test("a parameter repeated outside the known ones keeps its last value", () => {
    assert.equal(searchWithUpdates("?foo=1&foo=2&map=Kohat", {}), "?map=Kohat&foo=2");
});

test("a value sets or replaces a parameter, null and undefined remove it", () => {
    const search = "?map=Kohat&layer=Kohat_RAAS_v2&team1=USA";
    assert.equal(searchWithUpdates(search, { map: "Anvil", type: "relief", layer: null, team1: undefined }), "?map=Anvil&type=relief");
});

test("an empty query stays a query alone", () => {
    assert.equal(searchWithUpdates("", {}), "?");
    assert.equal(searchWithUpdates("?server=deadline", { server: null }), "?");
});

test("the address written back resolves under every path, `//` included, and keeps the path", () => {
    for (const path of ["/", "//", "///", "/a//b/", "/index.html"]) {
        const current = new URL(`https://calc.example${path}?server=deadline`);
        const written = new URL(searchWithUpdates(current.search, { map: "Kohat" }), current);
        assert.equal(written.host, "calc.example", path);
        assert.equal(written.pathname, current.pathname, path);
        assert.equal(written.search, "?map=Kohat&server=deadline", path);
    }
});
