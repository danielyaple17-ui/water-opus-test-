// M7 verification: optimised worker + automatic quality levels.
//  A. Auto controller on SwiftShader (slow GPU): must step down and settle without oscillating.
//  B. Volume across quality changes: High → Low → High resample round trip, settled fill at High.
//  C. Pose sequence (tilt L/R, flip, shake) at the settled auto level: leaks + volume.
//  D. Screenshots of each forced level (settled + mid-shake).
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('M7');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = {};
const G = 9.81;

async function newPage(query = '') {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url + (query ? query + '&pour=0' : '?pour=0'));
  await page.waitForTimeout(400);
  await page.click('#start');
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
  return page;
}
const simTime = (p) => p.evaluate(() => (window.__water.sim.stats ? window.__water.sim.stats.simTime : 0));
async function waitSim(p, sec, limitMs = 240000) {
  const s0 = await simTime(p), w0 = Date.now();
  while ((await simTime(p)) - s0 < sec) { if (Date.now() - w0 > limitMs) throw new Error('sim stalled'); await p.waitForTimeout(150); }
}
// Grid fill fluctuates by ~±0.5% with sloshing: average several samples over ~1 s of sim.
async function avgFill(p) {
  let f = 0, fr = 0;
  for (let i = 0; i < 6; i++) {
    await waitSim(p, 0.2);
    const s = await p.evaluate(() => { const w = window.__water; return [w.sim.stats.fillVolume, w.sim.stats.fillVolume / (w.sim.cellsX * w.sim.cellsY)]; });
    f += s[0] / 6; fr += s[1] / 6;
  }
  return { fillAvg: +f.toFixed(1), fracAvg: +fr.toFixed(4) };
}
const snap = (p) => p.evaluate(() => {
  const w = window.__water, s = w.sim.stats, q = w.quality;
  return { level: q.name, particles: s.count, outside: s.outside, fill: +s.fillVolume.toFixed(1),
    fillFrac: +(s.fillVolume / (w.sim.cellsX * w.sim.cellsY)).toFixed(4), stepMs: +s.stepMs.toFixed(2),
    frameAvgMs: +(q.frameAvg * 1000).toFixed(1), simRatio: +q.simRatio.toFixed(2), simTime: +s.simTime.toFixed(2),
    renderPx: `${w.renderer.width}x${w.renderer.height}` };
});

try {
  // ---- A: auto controller --------------------------------------------------
  const page = await newPage();
  const timeline = [];
  const w0 = Date.now();
  while (Date.now() - w0 < 70000) {
    await page.waitForTimeout(2000);
    timeline.push({ t: Math.round((Date.now() - w0) / 1000), ...(await snap(page)),
      reason: await page.evaluate(() => window.__water.quality.lastReason) });
  }
  results.autoTimeline = timeline;
  const changes = await page.evaluate(() => window.__water.quality.changes);
  const levels = timeline.map((x) => x.level);
  let flips = 0;
  for (let i = 2; i < levels.length; i++) if (levels[i] === levels[i - 2] && levels[i] !== levels[i - 1]) flips++;
  results.auto = { changes, finalLevel: levels[levels.length - 1], oscillations: flips,
    pass: flips === 0 && levels[levels.length - 1] === levels[levels.length - 4] };
  await page.screenshot({ path: path.join(dir, '01-auto-settled.png') });

  // ---- C: pose sequence at the settled auto level (pinned so a mid-run level
  // change can't mix resolutions in the volume comparison) ---------------------
  await page.evaluate(() => { const q = window.__water.quality; q.auto = false; });
  const setMotion = (s) => page.evaluate((s) => { window.__spec = s; }, s);
  const water = (on) => page.evaluate((on) => { window.__water.renderer.passes.water = on; }, on);
  const poses = [
    ['02-settled', { x: 0, y: G, shake: 0 }, 2.0],
    ['03-tilt-left', { x: G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['04-tilt-right', { x: -G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['05-upside-down', { x: 0, y: -G, shake: 0 }, 2.5],
    ['06-hard-shake', { x: 0, y: G, shake: 20 }, 2.0],
    ['07-resettled', { x: 0, y: G, shake: 0 }, 5.0],
  ];
  results.poses = {};
  for (const [name, spec, sec] of poses) {
    await setMotion(spec);
    await water(false);
    await waitSim(page, sec);
    await water(true);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    results.poses[name] = await snap(page);
  }
  const P = Object.values(results.poses);
  results.poseVolume = {
    endAvg: await avgFill(page),
    level: P[0].level, neverOutside: P.every((x) => x.outside === 0), particlesConstant: P.every((x) => x.particles === P[0].particles),
    fillStart: P[0].fill, fillEnd: P[P.length - 1].fill,
    fillChangePct: +(((P[P.length - 1].fill - P[0].fill) / P[0].fill) * 100).toFixed(2),
  };

  // ---- B: resample round trip High → Low → High ------------------------------
  const force = (l) => page.evaluate((l) => window.__water.quality.force(l), l);
  const waitReady = () => page.waitForFunction(() => window.__water.sim.ready && window.__water.sim.stats && window.__water.sim.stats.count === window.__water.sim.count, null, { timeout: 60000 });
  await water(false);
  await force(2); await waitReady(); await waitSim(page, 4.0);
  const hi1 = { ...(await snap(page)), ...(await avgFill(page)) };
  await force(0); await waitReady(); await waitSim(page, 4.0);
  const lo = { ...(await snap(page)), ...(await avgFill(page)) };
  await force(2); await waitReady(); await waitSim(page, 5.0);
  const hi2 = { ...(await snap(page)), ...(await avgFill(page)) };
  results.roundTrip = { high1: hi1, low: lo, high2: hi2,
    fillChangePct: +(((hi2.fillAvg - hi1.fillAvg) / hi1.fillAvg) * 100).toFixed(2),
    lowFracVsHighPct: +(((lo.fracAvg - hi1.fracAvg) / hi1.fracAvg) * 100).toFixed(2),
    pass: Math.abs((hi2.fillAvg - hi1.fillAvg) / hi1.fillAvg) <= 0.01 && hi2.outside === 0 && lo.outside === 0 };
  await page.context().close();

  // ---- D: forced levels ------------------------------------------------------
  results.levels = {};
  for (const q of ['low', 'med', 'high', 'ultra']) {
    const p = await newPage(`?q=${q}`);
    await p.evaluate(() => { window.__water.renderer.passes.water = false; });
    await waitSim(p, 2.5);
    await p.evaluate(() => { window.__water.renderer.passes.water = true; window.__water.stats.reset(); });
    await p.waitForTimeout(3000);
    await p.screenshot({ path: path.join(dir, `10-level-${q}-settled.png`) });
    const calm = await snap(p);
    await p.evaluate((s) => { window.__spec = s; window.__water.renderer.passes.water = false; }, { x: 0, y: G, shake: 20 });
    await waitSim(p, 1.2);
    await p.evaluate(() => { window.__water.renderer.passes.water = true; });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(dir, `11-level-${q}-shake.png`) });
    results.levels[q] = { calm, shake: await snap(p) };
    await p.context().close();
  }
} finally {
  results.consoleErrors = errors;
  const v = results.poseVolume || {};
  results.pass = errors.length === 0 && results.auto && results.auto.pass && results.roundTrip && results.roundTrip.pass &&
    v.neverOutside && v.particlesConstant && Math.abs(v.fillChangePct) <= 1;
  logResult(dir, results);
  console.log(JSON.stringify({ auto: results.auto, poseVolume: results.poseVolume, roundTrip: results.roundTrip && { fillChangePct: results.roundTrip.fillChangePct, lowFracVsHighPct: results.roundTrip.lowFracVsHighPct, pass: results.roundTrip.pass }, errors, pass: results.pass }, null, 1));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
