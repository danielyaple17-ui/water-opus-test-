// Game verification: level 1 loads with obstacles, tilting right fills the cup
// and shows the win card; background presets and a photo upload apply; volume
// is kept (particles constant, none outside); no console errors.
// usage: node verify/game.mjs <photo.png>
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';
const { chromium } = loadPlaywright();
const dir = outDir('game');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = { checks: {} };
const G = 9.81;
const photo = process.argv[2];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url);
  await page.waitForTimeout(500);
  await page.evaluate((G) => {
    window.__spec = { a: 0 };
    setInterval(() => { const a = window.__spec.a;
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: -G * Math.sin(a), y: G * Math.cos(a), z: 0 },
        acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })); }, 16);
  }, G);
  results.startLabel = await page.textContent('.start-label');
  results.startSub = await page.textContent('.start-sub');
  await page.screenshot({ path: path.join(dir, '00-start.png') });
  await page.click('#start');
  const simT = () => page.evaluate(() => (window.__water.sim.stats ? window.__water.sim.stats.simTime : 0));
  const waitSim = async (s) => { const t0 = await simT(); const w0 = Date.now(); while ((await simT()) - t0 < s) { if (Date.now() - w0 > 240000) throw new Error('sim stalled'); await page.waitForTimeout(150); } };
  const snap = () => page.evaluate(() => { const s = window.__water.sim.stats; return { count: s.count, goal: s.goal, outside: s.outside, fill: +s.fillVolume.toFixed(1),
    hud: document.getElementById('hud').hidden === false, name: document.getElementById('hud-name').textContent, fillBar: document.getElementById('hud-fill').style.width,
    win: document.getElementById('win').hidden === false, stars: document.getElementById('win-stars').textContent, slabs: window.__water.renderer.level.slabs.length }; });
  await waitSim(2);
  const s0 = await snap();
  await page.screenshot({ path: path.join(dir, '01-level1-upright.png') });
  await page.evaluate(() => { window.__spec.a = 1.2; }); // tilt the phone right (about 70°)
  await waitSim(2.5);
  const s1 = await snap();
  await page.screenshot({ path: path.join(dir, '02-level1-tilted.png') });
  await page.evaluate(() => { window.__spec.a = 0; });
  let s2 = await snap();
  for (let i = 0; i < 30 && !s2.win; i++) { await waitSim(0.5); s2 = await snap(); }
  await page.screenshot({ path: path.join(dir, '03-level1-won.png') });
  results.checks.level1 = { s0, s1, s2, pass: s0.hud && s0.slabs === 1 && s0.goal === 0 && s1.goal > 0 && s2.win && s0.count === s2.count && s2.outside === 0 };
  // Next level loads with its obstacles.
  await page.click('#win-next');
  await waitSim(2);
  const l2 = await snap();
  await page.screenshot({ path: path.join(dir, '04-level2.png') });
  results.checks.level2 = { ...l2, pass: l2.name === 'Off the shelf' && l2.slabs === 3 && !l2.win && l2.goal === 0 };
  // Background presets and a photo.
  await page.click('#hud-bg');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, '05-bg-sheet.png') });
  await (await page.$$('.bg-opt'))[1].click(); // pool tiles
  await page.click('.bg-close');
  await waitSim(0.5);
  await page.screenshot({ path: path.join(dir, '06-bg-tiles.png') });
  await page.click('#hud-bg');
  await (await page.$$('.bg-opt'))[3].click(); // graph paper
  await page.click('.bg-close');
  await waitSim(0.5);
  await page.screenshot({ path: path.join(dir, '07-bg-graph.png') });
  await page.click('#hud-bg');
  await page.setInputFiles('#bg-file', photo);
  await page.waitForFunction(() => /Photo set/.test(document.querySelector('.bg-status').textContent), null, { timeout: 20000 });
  results.photoStatus = await page.textContent('.bg-status');
  await page.click('.bg-close');
  await waitSim(0.5);
  await page.screenshot({ path: path.join(dir, '08-bg-photo.png') });
  const stored = await page.evaluate(() => ({ style: localStorage.getItem('water.bg'), photo: (localStorage.getItem('water.bgPhoto') || '').length, game: localStorage.getItem('water.game') }));
  results.checks.background = { style: stored.style, photoBytes: stored.photo, pass: stored.style === 'photo' && stored.photo > 1000 };
  results.checks.progress = { saved: stored.game, pass: /"unlocked":1/.test(stored.game || '') };
  // Reload: background and progress restored.
  await page.reload(); await page.waitForTimeout(800);
  results.afterReloadSub = await page.textContent('.start-sub');
  await page.screenshot({ path: path.join(dir, '09-reload-start.png') });
  results.checks.reload = { sub: results.afterReloadSub, pass: /Level 2/.test(results.afterReloadSub) };
} finally {
  results.consoleErrors = errors;
  results.pass = errors.length === 0 && Object.values(results.checks).every((c) => c.pass);
  logResult(dir, results);
  console.log(JSON.stringify({ checks: results.checks, photo: results.photoStatus, errors, pass: results.pass }, null, 1));
  await browser.close(); server.stop();
}
process.exit(results.pass ? 0 : 1);
