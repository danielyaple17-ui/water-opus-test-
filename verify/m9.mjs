// M9 verification: robustness.
//  A. WebGL context loss → sim keeps running, volume intact → restore → water drawn again;
//     a loss that is never restored shows the reload message after 5 s.
//  B. Hidden tab pauses sim + rendering, resumes without fast-forward.
//  C. Main-thread allocation rate in steady state (performance.memory sawtooth).
//  D. ?bench=1 runs end to end (short phases) and produces a report.
//  E. Poses (tilt L/R, flip, shake) with volume/leak checks after all of the above.
// (Controller logic incl. thermal + battery cap: verify/quality-test.mjs.)
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('M9');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = { checks: {} };
const G = 9.81;

async function newPage(query) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL restore|CONTEXT_LOST/i.test(m.text())) errors.push(m.text()); });
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
async function waitSim(p, sec, limitMs = 240000) {
  const s0 = await simTime(p), w0 = Date.now();
  while ((await simTime(p)) - s0 < sec) { if (Date.now() - w0 > limitMs) throw new Error('sim stalled'); await p.waitForTimeout(100); }
}
const snap = (p) => p.evaluate(() => {
  const w = window.__water, s = w.sim.stats;
  return { particles: s.count, outside: s.outside, fill: +s.fillVolume.toFixed(1), simTime: +s.simTime.toFixed(3),
    frames: w.stats.totalFrames, lost: w.renderer.lost, restored: w.renderer.restoredCount, particlesDrawn: w.renderer.particles.count,
    frameAvg: +w.stats.frameAvg.toFixed(1), frameMax: +w.stats.frameMax.toFixed(1), stepMs: +s.stepMs.toFixed(2), level: w.quality.name };
});
async function avgFill(p) { let f = 0; for (let i = 0; i < 6; i++) { await waitSim(p, 0.2); f += (await p.evaluate(() => window.__water.sim.stats.fillVolume)) / 6; } return +f.toFixed(1); }

try {
  const page = await newPage('?pour=0&q=high');
  await waitSim(page, 3);
  await page.screenshot({ path: path.join(dir, '01-before-context-loss.png') });
  const before = await snap(page);
  const fill0 = await avgFill(page);

  // ---- A. context loss & restore ----------------------------------------------
  await page.evaluate(() => { window.__lc = document.getElementById('gl').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  await page.waitForTimeout(300);
  const lostSnap = await snap(page);
  await waitSim(page, 1.0); // the sim keeps running while the GPU is gone
  const duringLoss = await snap(page);
  await page.screenshot({ path: path.join(dir, '02-context-lost.png') });
  await page.evaluate(() => window.__lc.restoreContext());
  await page.waitForFunction(() => !window.__water.renderer.lost && window.__water.renderer.particles.count > 0, null, { timeout: 30000 });
  await waitSim(page, 1.0);
  await page.screenshot({ path: path.join(dir, '03-context-restored.png') });
  const restored = await snap(page);
  const fill1 = await avgFill(page);
  results.checks.contextLoss = {
    lostFlag: lostSnap.lost, simAdvancedWhileLost: +(duringLoss.simTime - lostSnap.simTime).toFixed(2), restoredCount: restored.restored,
    particlesDrawnAfter: restored.particlesDrawn, fillBefore: fill0, fillAfter: fill1,
    pass: lostSnap.lost === true && duringLoss.simTime - lostSnap.simTime >= 0.9 && restored.restored === 1 && !restored.lost &&
      restored.particlesDrawn === before.particles && Math.abs(fill1 - fill0) / fill0 < 0.01,
  };

  // ---- B. hidden tab pauses ------------------------------------------------------
  const setHidden = (h) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  await setHidden(true);
  await page.waitForTimeout(400); // let an in-flight step return
  const h0 = await snap(page);
  await page.waitForTimeout(3000);
  const h1 = await snap(page);
  await setHidden(false);
  await page.waitForTimeout(1500);
  const h2 = await snap(page);
  results.checks.pause = {
    simAdvanceWhileHidden: +(h1.simTime - h0.simTime).toFixed(3), framesWhileHidden: h1.frames - h0.frames,
    simAdvanceAfterResume: +(h2.simTime - h1.simTime).toFixed(3),
    // After 3 s hidden the sim must not jump ahead by those 3 s when resumed.
    pass: h1.simTime - h0.simTime === 0 && h1.frames - h0.frames === 0 && h2.simTime > h1.simTime && h2.simTime - h1.simTime < 1.6,
  };

  // ---- C. main-thread allocation rate -------------------------------------------
  results.alloc = await page.evaluate(() => new Promise((res) => {
    if (!performance.memory) { res({ note: 'performance.memory unavailable' }); return; }
    let last = performance.memory.usedJSHeapSize, grown = 0, gcs = 0, samples = 0;
    const f0 = window.__water.stats.totalFrames;
    const id = setInterval(() => {
      const u = performance.memory.usedJSHeapSize;
      if (u > last) grown += u - last; else if (u < last) gcs++;
      last = u; samples++;
    }, 20);
    setTimeout(() => {
      clearInterval(id);
      const frames = window.__water.stats.totalFrames - f0;
      res({ seconds: 10, frames, bytesAllocated: grown, bytesPerFrame: Math.round(grown / Math.max(1, frames)), heapDrops: gcs, samples });
    }, 10000);
  }));

  // ---- E. poses + volume ----------------------------------------------------------
  const setMotion = (s) => page.evaluate((s) => { window.__spec = s; }, s);
  const water = (on) => page.evaluate((on) => { window.__water.renderer.passes.water = on; }, on);
  results.poses = {};
  for (const [name, spec, sec] of [
    ['04-tilt-left', { x: G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['05-tilt-right', { x: -G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['06-upside-down', { x: 0, y: -G, shake: 0 }, 2.5],
    ['07-hard-shake', { x: 0, y: G, shake: 20 }, 2.0],
    ['08-resettled', { x: 0, y: G, shake: 0 }, 6.0],
  ]) {
    await setMotion(spec); await water(false); await waitSim(page, sec); await water(true);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    results.poses[name] = await snap(page);
  }
  await water(false);
  for (let i = 0; i < 40 && (await page.evaluate(() => window.__water.sim.stats.activity)) > 0.05; i++) await waitSim(page, 0.5);
  const fillEnd = await avgFill(page);
  const P = Object.values(results.poses);
  results.volume = { neverOutside: P.every((x) => x.outside === 0), particlesConstant: P.every((x) => x.particles === before.particles),
    fillStart: fill0, fillEnd, fillChangePct: +(((fillEnd - fill0) / fill0) * 100).toFixed(2) };
  await water(true);
  await page.evaluate(() => window.__water.stats.reset());
  await page.waitForTimeout(4000);
  results.frame = await snap(page);

  // ---- A2. loss that is never restored → reload message -----------------------------
  await page.evaluate(() => { window.__lc = document.getElementById('gl').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  await page.waitForTimeout(6000);
  const fatal = await page.evaluate(() => ({ shown: !document.getElementById('fatal').hidden, text: document.getElementById('fatal').textContent }));
  await page.screenshot({ path: path.join(dir, '09-context-never-restored.png') });
  results.checks.contextFailed = { ...fatal, pass: fatal.shown && /reload/i.test(fatal.text) };
  await page.context().close();

  // ---- D. bench mode (short phases) ----------------------------------------------------
  const bp = await newPage('?pour=0&bench=1&benchSec=2');
  await bp.waitForFunction(() => !!window.__benchReport, null, { timeout: 600000, polling: 1000 });
  results.bench = await bp.evaluate(() => window.__benchReport);
  await bp.screenshot({ path: path.join(dir, '10-bench-report.png') });
  results.checks.bench = { rows: results.bench.results.length, pass: results.bench.results.length === 8 && results.bench.results.every((r) => r.frameAvgMs > 0) };
  await bp.context().close();
} finally {
  results.consoleErrors = errors;
  const v = results.volume || {};
  results.pass = errors.length === 0 && v.neverOutside && v.particlesConstant && Math.abs(v.fillChangePct) <= 1 &&
    Object.values(results.checks).every((c) => c.pass);
  logResult(dir, results);
  console.log(JSON.stringify({ checks: results.checks, alloc: results.alloc, volume: results.volume,
    frame: results.frame && { frameAvg: results.frame.frameAvg, frameMax: results.frame.frameMax, stepMs: results.frame.stepMs },
    errors, pass: results.pass }, null, 1));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
