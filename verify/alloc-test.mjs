// Main-thread allocation per frame in steady state (precise heap numbers need
// --enable-precise-memory-info). Sums heap growth between GCs over 10 s.
import { loadPlaywright, startServer, outDir } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = loadPlaywright();
const server = await startServer();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
const out = {};
for (const [label, water, q] of [['water-off-low', false, 'low'], ['full-render-low', true, 'low']]) {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })).newPage();
  await page.goto(server.url + `?pour=0&q=${q}`);
  await page.click('#start');
  await page.waitForTimeout(3000);
  await page.evaluate((w) => { window.__water.renderer.passes.water = w; }, water);
  await page.waitForTimeout(1000);
  out[label] = await page.evaluate(() => new Promise((res) => {
    let last = performance.memory.usedJSHeapSize, grown = 0, gcs = 0;
    const f0 = window.__water.stats.totalFrames;
    const id = setInterval(() => { const u = performance.memory.usedJSHeapSize; if (u > last) grown += u - last; else if (u < last) gcs++; last = u; }, 10);
    setTimeout(() => { clearInterval(id); const frames = window.__water.stats.totalFrames - f0;
      res({ frames, fps: +(frames / 10).toFixed(1), bytesPerFrame: Math.round(grown / Math.max(1, frames)), heapDrops: gcs }); }, 10000);
  }));
  await page.context().close();
}
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(outDir('M9'), 'alloc.json'), JSON.stringify(out, null, 2));
await browser.close(); server.stop();
