// Dev helper: renders one settled + one shaken scene under several surface
// parameter sets and saves crops for side-by-side comparison.
// usage: node verify/tune-surface.mjs '[{"sigmaS":3},{"sigmaS":5,"blurPasses":3}]'
import { loadPlaywright, startServer, launch, outDir } from './lib.mjs';
import path from 'node:path';
const { chromium } = loadPlaywright();
const sets = JSON.parse(process.argv[2] || '[{}]');
const dir = outDir('tune');
const server = await startServer();
const browser = await launch(chromium);
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true })).newPage();
page.on('pageerror', (e) => console.error('pageerror', e));
await page.goto(server.url);
await page.click('#start');
const G = 9.81;
await page.evaluate((G) => { window.__spec = { x: 0, y: G, shake: 0 }; const t0 = performance.now(); setInterval(() => { const t = (performance.now() - t0) / 1000, s = window.__spec, a = s.shake * Math.sin(2 * Math.PI * 5 * t);
  window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: s.x + a, y: s.y, z: 0 }, acceleration: { x: a, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })); }, 16); }, G);
const waitSim = async (sec) => { const s0 = await page.evaluate(() => window.__water.sim.stats ? window.__water.sim.stats.simTime : 0); while ((await page.evaluate(() => window.__water.sim.stats ? window.__water.sim.stats.simTime : 0)) - s0 < sec) await page.waitForTimeout(100); };
const scenes = [['calm', { x: 0, y: G, shake: 0 }, 3], ['shake2', { x: 0, y: G, shake: 22 }, 1.6], ['tilt', { x: G * Math.sin(0.5), y: G * Math.cos(0.5), shake: 0 }, 1.2], ['shake', { x: 0, y: G, shake: 22 }, 1.0]];
for (const [scene, spec, sec] of scenes) {
  await page.evaluate((s) => { window.__spec = s; window.__water.renderer.passes.water = false; }, spec);
  await waitSim(sec);
  await page.evaluate(() => { window.__water.sim.ready = false; }); // freeze the sim for identical frames
  for (let k = 0; k < sets.length; k++) {
    await page.evaluate((o) => { Object.assign(window.__water.renderer.surface, o.surface || o); if (o.passes) Object.assign(window.__water.renderer.passes, o.passes); window.__water.renderer.passes.water = true; }, sets[k]);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(dir, `${scene}-${k}.png`) });
  }
  await page.evaluate(() => { window.__water.sim.ready = true; });
}
await browser.close(); server.stop();
