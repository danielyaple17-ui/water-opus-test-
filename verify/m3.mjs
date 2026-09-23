// M3 verification: slosh from shakes (tank acceleration), swirl from spin, surface tension.
// Sensor events are wall-clock driven, so the sim must run ~real time: we use ?cells=48
// and 1× pixel density here (the headless VM cannot run the 84-cell sim next to
// SwiftShader in real time; the worker takes ≤4 steps per rendered frame). Tilt thresholds:
// in this tall tank a 34° tilt only moves the centre of mass ≈0.026 of the width.
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('M3');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = { phases: {}, checks: {} };
const G = 9.81;
const CELLS = Number(process.env.CELLS || 48);

try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${server.url}?cells=${CELLS}`);
  await page.waitForTimeout(500);
  await page.click('#start');
  // Physics test: render the cheap dot view so SwiftShader keeps ~real-time (the M4
  // surface passes drop it to ~8 fps, which would slow the sim ~8x vs the wall-clock sensors).
  const dots = (pg) => pg.evaluate(() => Object.assign(window.__water.renderer.passes, { water: false, particles: true }));
  await dots(page);

  // Sensor generator: window.__mode picks a function of wall time since the mode began.
  await page.evaluate((G) => {
    const modes = {
      rest: () => ({ ax: 0, ay: G, lin: 0, alpha: 0 }),
      tiltL: () => ({ ax: G * Math.sin(0.6), ay: G * Math.cos(0.6), lin: 0, alpha: 0 }),
      tiltR: () => ({ ax: -G * Math.sin(0.6), ay: G * Math.cos(0.6), lin: 0, alpha: 0 }),
      flip: () => ({ ax: 0, ay: -G, lin: 0, alpha: 0 }),
      // Phone jerked to the right: +25 m/s² for 100 ms, then −25 m/s² for 100 ms.
      jerk: (t) => { const a = t < 0.1 ? 25 : t < 0.2 ? -25 : 0; return { ax: a, ay: G, lin: a, alpha: 0 }; },
      shake: (t) => { const a = 22 * Math.sin(2 * Math.PI * 4 * t); return { ax: a, ay: G, lin: a, alpha: 0 }; },
      // Upright phone twisted counter-clockwise at 180°/s for 1 s: gravity rotates in the device frame.
      twist: (t) => { const th = Math.PI * Math.min(t, 1); return { ax: G * Math.sin(th), ay: G * Math.cos(th), lin: 0, alpha: t < 1 ? 180 : 0, hold: th }; },
      twisted: () => ({ ax: 0, ay: -G, lin: 0, alpha: 0 }),
    };
    window.__setMode = (m) => { window.__mode = m; window.__modeT0 = performance.now(); };
    window.__setMode('rest');
    window.__samples = [];
    setInterval(() => {
      const t = (performance.now() - window.__modeT0) / 1000;
      const s = modes[window.__mode](t);
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: s.ax, y: s.ay, z: 0 },
        acceleration: { x: s.lin, y: 0, z: 0 },
        rotationRate: { alpha: s.alpha, beta: 0, gamma: 0 }, interval: 16,
      }));
      const st = window.__water.sim.stats;
      if (st && window.__rec) window.__samples.push([+t.toFixed(3), +st.comX.toFixed(4), +st.comY.toFixed(4), +st.angMom.toExponential(3), +st.simTime.toFixed(3)]);
    }, 16);
  }, G);

  const simTime = () => page.evaluate(() => (window.__water.sim.stats ? window.__water.sim.stats.simTime : 0));
  async function waitSim(sec) {
    const start = await simTime();
    while ((await simTime()) - start < sec) await page.waitForTimeout(50);
  }
  const snap = () => page.evaluate(() => {
    const w = window.__water, s = w.sim.stats;
    return {
      particles: s.count, outside: s.outside, fillVolume: +s.fillVolume.toFixed(1), comX: +s.comX.toFixed(3), comY: +s.comY.toFixed(3),
      angMom: +s.angMom.toExponential(2), stepMs: +s.stepMs.toFixed(2), stepMsMax: +s.stepMsMax.toFixed(2), substeps: s.substeps,
      simTime: +s.simTime.toFixed(2), frameAvg: +w.stats.frameAvg.toFixed(1), frameMax: +w.stats.frameMax.toFixed(1),
    };
  });
  async function phase(name, mode, simSec, { shotAt = null } = {}) {
    await page.evaluate((m) => { window.__samples = []; window.__rec = true; window.__water.stats.reset(); window.__setMode(m); }, mode);
    const wall0 = Date.now(); const sim0 = await simTime();
    if (shotAt !== null) {
      // Screenshot as soon as `shotAt` sim-seconds have passed (captures the transient).
      await waitSim(shotAt);
      await page.screenshot({ path: path.join(dir, `${name}.png`) });
      await waitSim(Math.max(0, simSec - shotAt));
    } else {
      await waitSim(simSec);
      await page.screenshot({ path: path.join(dir, `${name}.png`) });
    }
    const sim1 = await simTime();
    const samples = await page.evaluate(() => { window.__rec = false; return window.__samples; });
    const r = { ...(await snap()), realtimeRatio: +((sim1 - sim0) / ((Date.now() - wall0) / 1000)).toFixed(2) };
    results.phases[name] = r;
    return { r, samples };
  }

  await phase('01-settled', 'rest', 2.5);
  const base = results.phases['01-settled'];

  const jerk = await phase('02-jerk-right-peak', 'jerk', 1.0, { shotAt: 0.12 });
  const comXs = jerk.samples.map((s) => s[1]);
  results.checks.jerk = {
    comXSettled: base.comX, comXMin: Math.min(...comXs), comXMax: Math.max(...comXs),
    // Tank jerked right → water must first pile against the LEFT wall, then get thrown right on the stop.
    pass: Math.min(...comXs) < base.comX - 0.08 && comXs.indexOf(Math.min(...comXs)) < comXs.indexOf(Math.max(...comXs)),
  };
  await phase('03-after-jerk', 'rest', 2.0);

  const shake = await phase('04-hard-shake', 'shake', 2.0, { shotAt: 1.4 });
  const sx = shake.samples.map((s) => s[1]);
  results.checks.shake = { comXRange: +(Math.max(...sx) - Math.min(...sx)).toFixed(3), pass: Math.max(...sx) - Math.min(...sx) > 0.12 };
  await phase('05-resettle', 'rest', 3.0);

  await phase('06-tilt-left', 'tiltL', 2.0);
  results.checks.tiltLeft = { comX: results.phases['06-tilt-left'].comX, pass: results.phases['06-tilt-left'].comX < base.comX - 0.015 };
  await phase('07-tilt-right', 'tiltR', 2.0);
  results.checks.tiltRight = { comX: results.phases['07-tilt-right'].comX, pass: results.phases['07-tilt-right'].comX > base.comX + 0.015 };
  await phase('08-upside-down', 'flip', 2.5);
  results.checks.flip = { comY: results.phases['08-upside-down'].comY, pass: results.phases['08-upside-down'].comY < 0.4 };
  await phase('09-upright', 'rest', 3.0);

  const tw = await phase('10-twist-ccw', 'twist', 1.2, { shotAt: 0.6 });
  const L = tw.samples.filter((s) => s[0] < 1.0).map((s) => s[3]);
  const meanL = L.reduce((a, b) => a + b, 0) / Math.max(1, L.length);
  // Phone spins CCW (stage spin < 0) → water lags → clockwise relative motion → L > 0.
  results.checks.twist = { meanAngMomDuringSpin: +meanL.toExponential(2), pass: meanL > 0 };
  await phase('11-after-twist', 'twisted', 3.0);
  await phase('12-final-upright', 'rest', 6.0);

  // Surface tension / spray: after settling, the free surface should be smooth.
  const last = results.phases['12-final-upright'];
  results.volume = {
    particlesConstant: Object.values(results.phases).every((x) => x.particles === base.particles),
    neverOutside: Object.values(results.phases).every((x) => x.outside === 0),
    fillStart: base.fillVolume, fillEnd: last.fillVolume,
    fillChangePct: +(((last.fillVolume - base.fillVolume) / base.fillVolume) * 100).toFixed(2),
  };

  // Desktop fallback: click-drag to the right should slosh water left.
  const dctx = await browser.newContext({ viewport: { width: 500, height: 900 }, ignoreHTTPSErrors: true });
  const dp = await dctx.newPage();
  dp.on('pageerror', (e) => errors.push(String(e)));
  await dp.goto(`${server.url}?cells=${CELLS}`);
  await dp.mouse.move(250, 880);
  await dp.mouse.click(250, 450);
  await dots(dp);
  await dp.mouse.move(250, 880);
  await dp.waitForFunction(() => window.__water.sim.stats && window.__water.sim.stats.simTime > 2.0, null, { timeout: 60000 });
  const c0 = await dp.evaluate(() => window.__water.sim.stats.comX);
  await dp.mouse.move(100, 880);
  await dp.mouse.down();
  let cmin = 1;
  for (let i = 0; i <= 8; i++) {
    await dp.mouse.move(100 + i * 40, 880);
    await dp.waitForTimeout(16);
    cmin = Math.min(cmin, await dp.evaluate(() => window.__water.sim.stats.comX));
  }
  await dp.mouse.up();
  for (let i = 0; i < 20; i++) { await dp.waitForTimeout(25); cmin = Math.min(cmin, await dp.evaluate(() => window.__water.sim.stats.comX)); }
  await dp.screenshot({ path: path.join(dir, '13-desktop-drag.png') });
  results.checks.desktopDrag = { comXBefore: +c0.toFixed(3), comXMin: +cmin.toFixed(3), pass: cmin < c0 - 0.03 };
} finally {
  results.consoleErrors = errors;
  const v = results.volume || {};
  results.pass = errors.length === 0 && v.particlesConstant && v.neverOutside && Math.abs(v.fillChangePct) <= 1 &&
    Object.values(results.checks).every((c) => c.pass);
  logResult(dir, results);
  console.log(JSON.stringify({ checks: results.checks, volume: results.volume, errors, pass: results.pass }, null, 1));
  for (const [k, p] of Object.entries(results.phases)) console.log(k.padEnd(20), JSON.stringify(p));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
