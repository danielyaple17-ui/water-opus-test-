// M8 verification: HDR post (ACES, highlight bloom, glass feel, meniscus),
// pour-in start, tap splash, two-finger reset, plus the usual poses and volume.
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('M8');
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url + query);
  await page.waitForTimeout(400);
  // Motion stream first so the pour sees gravity from the very first step.
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
async function shot(p, name) { await water(p, true); await p.waitForTimeout(1300); await p.screenshot({ path: path.join(dir, `${name}.png`) }); await water(p, false); }
const snap = (p) => p.evaluate(() => {
  const w = window.__water, s = w.sim.stats;
  return { particles: s.count, capacity: w.sim.count, pourRemaining: s.pourRemaining, outside: s.outside, fill: +s.fillVolume.toFixed(1),
    activity: +s.activity.toFixed(3), maxSpeed: +(s.maxSpeed || 0).toFixed(3), meanFoam: +(s.foamSum / Math.max(1, s.count)).toFixed(4), bubbles: s.bubbles,
    stepMs: +s.stepMs.toFixed(2), simTime: +s.simTime.toFixed(2), frameAvg: +w.stats.frameAvg.toFixed(1), frameMax: +w.stats.frameMax.toFixed(1) };
});
async function avgFill(p) {
  let f = 0;
  for (let i = 0; i < 6; i++) { await waitSim(p, 0.2); f += (await p.evaluate(() => window.__water.sim.stats.fillVolume)) / 6; }
  return +f.toFixed(1);
}

try {
  // Reference: a pre-filled tank (no pour), settled, same level.
  const ref = await newPage('?q=high&pour=0');
  await water(ref, false);
  await waitSimAbs(ref, 6);
  results.referenceFill = await avgFill(ref);
  await ref.context().close();

  const page = await newPage('?q=high');
  await water(page, false);
  // ---- pour-in ------------------------------------------------------------
  const pour = [];
  for (const t of [0.25, 0.6, 1.0, 1.6]) {
    await waitSimAbs(page, t);
    pour.push(await snap(page));
    await shot(page, `01-pour-${String(t).replace('.', '_')}s`);
  }
  await waitSimAbs(page, 8);
  const settled = await snap(page);
  settled.fillAvg = await avgFill(page);
  await shot(page, '02-poured-settled');
  results.pour = { samples: pour, settled };
  results.checks.pour = {
    fillsUp: pour[0].particles < pour[pour.length - 1].particles && settled.pourRemaining === 0 && settled.particles === settled.capacity,
    fillVsPrefilledPct: +(((settled.fillAvg - results.referenceFill) / results.referenceFill) * 100).toFixed(2),
  };
  results.checks.pour.pass = results.checks.pour.fillsUp && Math.abs(results.checks.pour.fillVsPrefilledPct) <= 1.5;

  // ---- poses ----------------------------------------------------------------
  const setMotion = (s) => page.evaluate((s) => { window.__spec = s; }, s);
  const poses = [
    ['03-tilt-left', { x: G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['04-tilt-right', { x: -G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['05-upside-down', { x: 0, y: -G, shake: 0 }, 2.5],
    ['06-hard-shake', { x: 0, y: G, shake: 20 }, 2.0],
    ['07-resettled', { x: 0, y: G, shake: 0 }, 6.0],
  ];
  results.poses = {};
  for (const [name, spec, sec] of poses) {
    await setMotion(spec);
    await waitSim(page, sec);
    await shot(page, name);
    results.poses[name] = await snap(page);
  }
  // Settle until calm (the software-GL run is slow and uneven), then measure.
  for (let i = 0; i < 40 && (await snap(page)).activity > 0.05; i++) await waitSim(page, 0.5);
  const endFill = await avgFill(page);
  const P = Object.values(results.poses);
  results.volume = { neverOutside: P.every((x) => x.outside === 0) && settled.outside === 0,
    particlesConstant: P.every((x) => x.particles === settled.particles),
    fillStart: settled.fillAvg, fillEnd: endFill, fillChangePct: +(((endFill - settled.fillAvg) / settled.fillAvg) * 100).toFixed(2) };

  // ---- tap splash -------------------------------------------------------------
  for (let i = 0; i < 40 && (await snap(page)).activity > 0.05; i++) await waitSim(page, 0.5);
  // Peak speed is polled continuously (delivery of the tap and the worker's
  // step timing are uneven here): 1 s window before vs 2 s window after.
  const peak = async (ms) => page.evaluate((ms) => new Promise((res) => { let m = 0; const id = setInterval(() => {
    const s = window.__water.sim.stats; if (s) m = Math.max(m, s.maxSpeed); }, 5); setTimeout(() => { clearInterval(id); res(m); }, ms); }), ms);
  const before = { ...(await snap(page)), maxSpeed: +(await peak(1000)).toFixed(3) };
  await water(page, true);
  const pk = peak(2000);
  await page.touchscreen.tap(195, 700);
  const peakAfter = await pk;
  await water(page, false);
  const after = { ...(await snap(page)), maxSpeed: +peakAfter.toFixed(3) };
  await shot(page, '08-tap-splash');
  // The splash is local, so whole-tank rms barely moves; check the peak speed and foam.
  results.checks.tap = { activityBefore: before.activity, activityAfter: after.activity, maxSpeedBefore: before.maxSpeed, maxSpeedAfter: after.maxSpeed,
    foamBefore: before.meanFoam, foamAfter: after.meanFoam,
    // Calm water already has single outlier particles near 0.8 m/s, so peak speed
    // is logged but not judged; the splash's whitewater (foam) is the robust signal.
    pass: after.meanFoam > 5 * before.meanFoam };

  // ---- post pass comparisons ----------------------------------------------------
  await waitSim(page, 3);
  const setPasses = (o) => page.evaluate((o) => Object.assign(window.__water.renderer.passes, o), o);
  for (const [name, o] of [['09-no-bloom', { bloom: false }], ['10-no-tonemap', { bloom: true, tonemap: false }], ['11-no-glass', { tonemap: true, glass: false }]]) {
    await setPasses(o);
    await shot(page, name);
  }
  await setPasses({ glass: true });

  // Frame time with everything on (software GL; not representative).
  await water(page, true);
  await page.evaluate(() => window.__water.stats.reset());
  await page.waitForTimeout(4000);
  results.frame = await snap(page);
  await water(page, false);

  // ---- two-finger tap resets --------------------------------------------------
  const cdp = await page.context().newCDPSession(page);
  const pts = [{ x: 140, y: 500, id: 1 }, { x: 250, y: 520, id: 2 }];
  // Record the minimum active-particle count seen right after the gesture (the
  // re-pour completes in ~1.7 s of sim, so a slow poll could miss it).
  await page.evaluate(() => {
    window.__ev = []; const st = document.getElementById('stage');
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) st.addEventListener(t, (e) => window.__ev.push([t, e.pointerId, Math.round(e.timeStamp)]));
    const orig = window.__water.sim.init.bind(window.__water.sim); window.__inits = 0;
    window.__water.sim.init = (o) => { window.__inits++; return orig(o); };
  });
  await page.evaluate(() => { window.__minActive = 1e9; window.__pourSeen = 0; window.__probe = setInterval(() => {
    const s = window.__water.sim.stats; if (!s) return; window.__minActive = Math.min(window.__minActive, s.count);
    window.__pourSeen = Math.max(window.__pourSeen, s.pourRemaining); }, 5); });
  // Let software GL drain (water off) so the gesture isn't stretched past the tap window.
  await page.waitForTimeout(3000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1500);
  const probe = await page.evaluate(() => { clearInterval(window.__probe); return { minActive: window.__minActive, pourSeen: window.__pourSeen, inits: window.__inits, events: window.__ev }; });
  const reset = { ...(await snap(page)), ...probe };
  await shot(page, '12-after-reset');
  results.checks.reset = { minActiveAfterGesture: reset.minActive, maxPourRemainingSeen: reset.pourSeen, initCalls: reset.inits, events: reset.events,
    pass: reset.inits === 1 && reset.pourSeen > 0 };
} finally {
  results.consoleErrors = errors;
  const v = results.volume || {};
  results.pass = errors.length === 0 && v.neverOutside && v.particlesConstant && Math.abs(v.fillChangePct) <= 1 &&
    Object.values(results.checks).every((c) => c.pass);
  logResult(dir, results);
  console.log(JSON.stringify({ checks: results.checks, volume: results.volume, referenceFill: results.referenceFill, frame: results.frame, errors, pass: results.pass }, null, 1));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
