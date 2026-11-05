/**
 * The plain-JavaScript SHA-256 that checks the volume files on pages without crypto.subtle, against node:crypto
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sha256Hex } from "../src/js/sha256.js";

const reference = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("sha256Hex equals node:crypto for the empty message, the padding boundaries and a long random one", () => {
    assert.equal(sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 100_003]) {
        const bytes = randomBytes(length);
        assert.equal(sha256Hex(bytes), reference(bytes), `${length} bytes`);
    }
});
