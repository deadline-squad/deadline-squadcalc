// Compares the keys of every public/locales/<lng>/<namespace>.json with the English file.
//
//     node scripts/check-locales.mjs [locales directory]
//
// A key that English has and another language lacks is an error (the app has no fallback language, so the
// key itself would be shown); exit code 1. A key a language has and English lacks is only reported as stale.
// A Ukrainian text that is Russian left untranslated is an error too: one with a letter only Russian has (ы, э, ъ, ё),
// or one of three or more Cyrillic words (abbreviations such as ПКМ aside) that is the Russian text word for word.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const localesDir = process.argv[2] ?? join(import.meta.dirname, "..", "public", "locales");
const reference = "en";

const readKeys = (file) => new Set(Object.keys(JSON.parse(readFileSync(file, "utf8"))));
const RUSSIAN_ONLY = /[ыэъёЫЭЪЁ]/;
const isRussian = (text, russianText) => typeof text === "string"
    && (RUSSIAN_ONLY.test(text) || (text === russianText && (text.match(/[А-ЯЁІЇЄҐ]?[а-яёіїєґ]+/g) ?? []).length >= 3));

let missingCount = 0;
let staleCount = 0;
let russianCount = 0;

for (const file of readdirSync(join(localesDir, reference)).filter((name) => name.endsWith(".json"))) {
    const referenceKeys = readKeys(join(localesDir, reference, file));
    for (const language of readdirSync(localesDir).filter((name) => name !== reference)) {
        const keys = readKeys(join(localesDir, language, file));
        const missing = [...referenceKeys].filter((key) => !keys.has(key));
        const stale = [...keys].filter((key) => !referenceKeys.has(key));
        missingCount += missing.length;
        staleCount += stale.length;
        if (missing.length) console.error(`${language}/${file}: missing ${missing.length}: ${missing.join(", ")}`);
        if (stale.length) console.warn(`${language}/${file}: not in ${reference}: ${stale.join(", ")}`);
    }
    const russianTexts = JSON.parse(readFileSync(join(localesDir, "ru", file), "utf8"));
    const russian = Object.entries(JSON.parse(readFileSync(join(localesDir, "uk", file), "utf8")))
        .filter(([key, text]) => isRussian(text, russianTexts[key])).map(([key]) => key);
    russianCount += russian.length;
    if (russian.length) console.error(`uk/${file}: Russian text in ${russian.length}: ${russian.join(", ")}`);
}

console.log(`${missingCount} missing keys, ${staleCount} keys not in ${reference}, ${russianCount} Ukrainian texts in Russian`);
process.exit(missingCount || russianCount ? 1 : 0);
