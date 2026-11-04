/**
 * Drives bench.html in headless Chromium on the SwiftShader software adapter (a CPU): the proof that the page
 * works on a machine without a GPU. The numbers it prints measure a CPU.
 *
 *   node engine/wgsl/bench/run_headless.mjs [sizes] [heatmapSizes] [runs] [budgetSeconds]
 *
 * Env: PLAYWRIGHT_CORE (playwright-core dir), CHROME (chrome binary).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const wgslDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [sizes = '10000,100000,1000000', heatmapSizes = '1000,10000,100000', runs = '5', budget = '30'] = process.argv.slice(2);
const playwrightDir = process.env.PLAYWRIGHT_CORE || '/home/seregatipich/cafe-pulse-sync/node_modules/playwright-core';
const chrome = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
const CHROME_ARGS = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan,UseSkiaRenderer', '--use-gl=angle', '--use-angle=swiftshader'];
const TYPES = { '.mjs': 'text/javascript', '.html': 'text/html', '.wgsl': 'text/plain' };

const server = http.createServer((req, res) => {
    const file = path.join(wgslDir, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(wgslDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
}).listen(0);

const { chromium } = createRequire(playwrightDir + '/')(playwrightDir);
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: CHROME_ARGS });
const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/bench/bench.html`);
await page.fill('#sizes', sizes);
await page.fill('#heatSizes', heatmapSizes);
await page.fill('#runs', runs);
await page.fill('#budget', budget);
await page.click('#run');
await page.waitForFunction(() => !document.getElementById('run').disabled, null, { timeout: 0, polling: 1000 });
const out = await page.evaluate(() => ({ log: document.getElementById('log').textContent, table: document.getElementById('table').textContent, json: document.getElementById('json').value }));
console.log(`${out.log}\n--- markdown table\n${out.table}\n--- JSON\n${out.json}`);
await browser.close();
server.close();
process.exit(out.json ? 0 : 1);
