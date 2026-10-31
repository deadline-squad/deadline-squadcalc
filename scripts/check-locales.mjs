// Compares the keys of every public/locales/<lng>/<namespace>.json with the English file.
//
//     node scripts/check-locales.mjs [locales directory]
//
// A key that English has and another language lacks is an error (the app has no fallback language, so the
// key itself would be shown); exit code 1. A key a language has and English lacks is only reported as stale.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const localesDir = process.argv[2] ?? join(import.meta.dirname, "..", "public", "locales");
const reference = "en";

const readKeys = (file) => new Set(Object.keys(JSON.parse(readFileSync(file, "utf8"))));

let missingCount = 0;
let staleCount = 0;

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
}

console.log(`${missingCount} missing keys, ${staleCount} keys not in ${reference}`);
process.exit(missingCount ? 1 : 0);
