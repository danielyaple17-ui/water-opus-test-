// Known Issue (thin-water caustics) verification: caustics fade in thin tongues.
// Early pour frames + the usual poses, volume, leaks and console errors.
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('caustics-thin');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = {};
const G = 9.81;

async function newPage(query) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url + query);
  await page.waitForTimeout(400);
  await page.evaluate((G) => {
    window.__spec = { x: 0, y: G, shake: 0 };
    const t0 = performance.now();
    setInterval(() => {
      const t = (performance.now() - t0) / 1000, s = window.__spec, a = s.shake * Math.sin(2 * Math.PI * 5 * t);
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: s.x + a, y: s.y, z: 0 }, acceleration: { x: a, y: 0, z: 0 },
        rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16,
      }));
    }, 16);
  }, G);
  await page.click('#start');
  return page;
}
const simTime = (p) => p.evaluate(() => (window.__water.sim.stats ? window.__water.sim.stats.simTime : 0));
async function waitSimAbs(p, t, limitMs = 300000) {
  const w0 = Date.now();
  while ((await simTime(p)) < t) { if (Date.now() - w0 > limitMs) throw new Error('sim stalled'); await p.waitForTimeout(100); }
}
async function waitSim(p, sec) { await waitSimAbs(p, (await simTime(p)) + sec); }
const water = (p, on) => p.evaluate((on) => { window.__water.renderer.passes.water = on; }, on);
const freeze = (p, on) => p.evaluate((on) => { window.__water.sim.ready = !on; }, on);
const setPasses = (p, o) => p.evaluate((o) => Object.assign(window.__water.renderer.passes, o), o);
async function shot(p, name) { await water(p, true); await p.waitForTimeout(1300); await p.screenshot({ path: path.join(dir, `${name}.png`) }); await water(p, false); }
// Frozen frame (identical sim state while the screenshot renders).
async function pair(p, name) { await freeze(p, true); await shot(p, name); await freeze(p, false); }
const snap = (p) => p.evaluate(() => {
  const w = window.__water, s = w.sim.stats;
  return { particles: s.count, outside: s.outside, fill: +s.fillVolume.toFixed(1), activity: +s.activity.toFixed(3),
    stepMs: +s.stepMs.toFixed(2), simTime: +s.simTime.toFixed(2), frameAvg: +w.stats.frameAvg.toFixed(1), frameMax: +w.stats.frameMax.toFixed(1) };
});
async function avgFill(p) {
  let f = 0;
  // 15 samples over 3 s of sim: single readings swing up to ±2.5% while the
  // water is still settling (see PROGRESS.md), a 1.2 s mean is not enough.
  for (let i = 0; i < 15; i++) { await waitSim(p, 0.2); f += (await p.evaluate(() => window.__water.sim.stats.fillVolume)) / 15; }
  return +f.toFixed(1);
}

try {
  // Pour frame (fresh page with the pour-in).
  const pourPage = await newPage('?q=high');
  await water(pourPage, false);
  for (const t of [0.5, 1.0, 2.0]) {
    await waitSimAbs(pourPage, t);
    await pair(pourPage, `01-pour-${String(t).replace('.', '_')}s`);
  }
  await pourPage.context().close();

  const page = await newPage('?q=high&pour=0');
  await water(page, false);
  await waitSimAbs(page, 5);
  const start = { ...(await snap(page)), fillAvg: await avgFill(page) };
  await pair(page, '02-calm');
  const setMotion = (s) => page.evaluate((s) => { window.__spec = s; }, s);
  const poses = [
    ['03-tilt-left', { x: G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['04-tilt-right', { x: -G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['05-upside-down', { x: 0, y: -G, shake: 0 }, 2.5],
    ['06-hard-shake', { x: 0, y: G, shake: 20 }, 2.0],
    ['06b-hard-shake-more', { x: 0, y: G, shake: 20 }, 0.7],
    ['06c-after-0_5s', { x: 0, y: G, shake: 0 }, 0.5],
    ['06d-after-1_5s', { x: 0, y: G, shake: 0 }, 1.0],
    ['07-resettled', { x: 0, y: G, shake: 0 }, 6.0],
  ];
  results.poses = {};
  for (const [name, spec, sec] of poses) {
    await setMotion(spec);
    await waitSim(page, sec);
    await pair(page, name);
    results.poses[name] = await snap(page);
  }
  for (let i = 0; i < 40 && (await snap(page)).activity > 0.05; i++) await waitSim(page, 0.5);
  const endFill = await avgFill(page);
  const P = Object.values(results.poses);
  results.volume = { neverOutside: P.every((x) => x.outside === 0) && start.outside === 0,
    particlesConstant: P.every((x) => x.particles === start.particles),
    fillStart: start.fillAvg, fillEnd: endFill, fillChangePct: +(((endFill - start.fillAvg) / start.fillAvg) * 100).toFixed(2) };

  // Frame time with everything on (software GL; not representative of a phone).
  await water(page, true);
  await page.evaluate(() => window.__water.stats.reset());
  await page.waitForTimeout(4000);
  results.frame = await snap(page);
} finally {
  results.consoleErrors = errors;
  const v = results.volume || {};
  results.pass = errors.length === 0 && v.neverOutside && v.particlesConstant && Math.abs(v.fillChangePct) <= 1;
  logResult(dir, results);
  console.log(JSON.stringify({ volume: results.volume, frame: results.frame, errors, pass: results.pass }, null, 1));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
