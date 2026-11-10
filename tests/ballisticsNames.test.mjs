import { test } from "node:test";
import assert from "node:assert/strict";
import { WEAPONS } from "../src/data/weapons.js";
import { matchBallisticsName } from "../src/js/ballisticsNames.js";

// A made-up catalogue: a weapon Squad Ballistics does not have, one with two more views, an old name and an
// old name of one of those views, one with a name only
const CATALOGUE = [
    { name: "Mortar", ballistics: null },
    {
        name: "DF_Gun",
        ballistics: "Gun",
        ballisticsViews: ["Gun · gunner sight ×6", "Gun · gunner sight ×12"],
        legacyBallistics: ["Gun / Other gun"],
        legacyBallisticsViews: { "Gun / Other gun · gunner sight ×12": "Gun · gunner sight ×12" },
    },
    { name: "DF_Launcher", ballistics: "Launcher" },
];

test("a weapon is found by its Squad Ballistics name, which is reported back", () => {
    assert.deepEqual(matchBallisticsName(CATALOGUE, "Gun"), { index: 1, reported: "Gun" });
    assert.deepEqual(matchBallisticsName(CATALOGUE, "Launcher"), { index: 2, reported: "Launcher" });
});

test("the name of a view finds the weapon that stands for it and is reported back as it came", () => {
    assert.deepEqual(matchBallisticsName(CATALOGUE, "Gun · gunner sight ×6"), { index: 1, reported: "Gun · gunner sight ×6" });
    assert.deepEqual(matchBallisticsName(CATALOGUE, "Gun · gunner sight ×12"), { index: 1, reported: "Gun · gunner sight ×12" });
});

test("a name from before a rename finds the weapon and is reported as its current name", () => {
    assert.deepEqual(matchBallisticsName(CATALOGUE, "Gun / Other gun"), { index: 1, reported: "Gun" });
});

test("a name a view had before a rename finds the weapon and is reported as the view's current name", () => {
    assert.deepEqual(matchBallisticsName(CATALOGUE, "Gun / Other gun · gunner sight ×12"), { index: 1, reported: "Gun · gunner sight ×12" });
});

test("an unknown name, a part of a name, a property every object has and a value that is no name find nothing", () => {
    for (const name of ["no such weapon", "Gun · gunner sight", "gun", "", "constructor", "toString", "__proto__", null, undefined, 1]) {
        assert.equal(matchBallisticsName(CATALOGUE, name), null, String(name));
    }
});

test("a weapon without a Squad Ballistics name is never found", () => {
    assert.equal(matchBallisticsName([{ name: "Mortar" }, { name: "UB-32", ballistics: null }], null), null);
    assert.equal(matchBallisticsName([{ name: "Mortar" }], undefined), null);
});

test("weapons.js: the zoom levels of a gunner's sight select the gun's weapon and keep their name", () => {
    const t72 = WEAPONS.findIndex((weapon) => weapon.name === "DF_Tank_AP_2A46_ZPT98_2A20_2A45_KBA3");
    assert.deepEqual(matchBallisticsName(WEAPONS, "Tank AP · T-72 (2A46)"), { index: t72, reported: "Tank AP · T-72 (2A46)" });
    assert.deepEqual(matchBallisticsName(WEAPONS, "Tank AP · T-72 (2A46) · gunner sight ×12"), { index: t72, reported: "Tank AP · T-72 (2A46) · gunner sight ×12" });
    const mk19 = WEAPONS.findIndex((weapon) => weapon.name === "DF_MK19_PARS_III_RWS");
    for (const zoom of ["×3", "×9"]) {
        const name = `MK19 · PARS III RWS · gunner sight ${zoom}`;
        assert.deepEqual(matchBallisticsName(WEAPONS, name), { index: mk19, reported: name });
    }
});

test("weapons.js: the names of the entries Squad Ballistics split still select the vehicle that kept them", () => {
    const renamed = [
        ["Tank AP · 2A46 / ZPT98 / 2A20 / M68A2", "DF_Tank_AP_2A46_ZPT98_2A20_2A45_KBA3", "Tank AP · T-72 (2A46)"],
        ["Tank AP · 2A46 / ZPT98 / 2A20 / 2A45 / KBA3", "DF_Tank_AP_2A46_ZPT98_2A20_2A45_KBA3", "Tank AP · T-72 (2A46)"],
        ["Tank HEAT/HE · M256 / Rh120 / 2A46 / ZPT98 / 2A20 / M68A2", "DF_Tank_HEAT_HE_M256_Rh120_2A46_ZPT98_2A20_M68A2", "Tank HEAT/HE · T-72 (2A46)"],
        ["QLZ87 · Lynx / CSK131", "DF_QLZ87_Lynx_CSK131", "QLZ87 · Lynx · optic (RMB ×3)"],
        ["QLZ87 · Lynx / CSK131 · optic (RMB ×3)", "DF_QLZ87_Lynx_CSK131", "QLZ87 · Lynx · optic (RMB ×3)"],
        ["QLZ87 · Lynx / CSK131 · no optic", "DF_QLZ87_Lynx_CSK131_no_optic", "QLZ87 · Lynx · no optic"],
    ];
    for (const [old, entry, current] of renamed) {
        const index = WEAPONS.findIndex((weapon) => weapon.name === entry);
        assert.deepEqual(matchBallisticsName(WEAPONS, old), { index, reported: current }, old);
        assert.deepEqual(matchBallisticsName(WEAPONS, current), { index, reported: current }, current);
    }
});

test("weapons.js: the names the ×12 zoom of the T-72's sight had in Squad Ballistics 1.6.4 select the T-72 and report that zoom", () => {
    const renamed = [
        ["Tank AP · T-72 / T-90 (2A46) · gunner sight ×12", "DF_Tank_AP_2A46_ZPT98_2A20_2A45_KBA3", "Tank AP · T-72 (2A46) · gunner sight ×12"],
        ["Tank HEAT/HE · T-72 / T-90 (2A46) · gunner sight ×12", "DF_Tank_HEAT_HE_M256_Rh120_2A46_ZPT98_2A20_M68A2", "Tank HEAT/HE · T-72 (2A46) · gunner sight ×12"],
    ];
    for (const [old, entry, view] of renamed) {
        const index = WEAPONS.findIndex((weapon) => weapon.name === entry);
        assert.deepEqual(matchBallisticsName(WEAPONS, old), { index, reported: view }, old);
        assert.deepEqual(matchBallisticsName(WEAPONS, view), { index, reported: view }, view);
    }
});
