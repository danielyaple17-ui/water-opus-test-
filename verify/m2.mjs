// M2 verification: particle water in a worker, walls, gravity from tilt.
// Phases wait on *simulated* time (the headless VM may run the sim slower than real time).
import { loadPlaywright, startServer, launch, outDir, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('M2');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = { phases: {} };
const G = 9.81;

try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url + '?pour=0');
  await page.waitForTimeout(500);
  await page.click('#start');

  // Continuous synthetic motion at 60 Hz driven from the page; `setMotion` swaps the spec.
  await page.evaluate(() => {
    window.__spec = { x: 0, y: 9.81, shake: 0 };
    const t0 = performance.now();
    setInterval(() => {
      const t = (performance.now() - t0) / 1000, s = window.__spec;
      const a = s.shake * Math.sin(2 * Math.PI * 5 * t);
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: s.x + a, y: s.y, z: 0 },
        acceleration: { x: a, y: 0, z: 0 },
        rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16,
      }));
    }, 16);
  });
  const setMotion = (spec) => page.evaluate((s) => { window.__spec = s; }, spec);
  const simTime = () => page.evaluate(() => (window.__water.sim.stats ? window.__water.sim.stats.simTime : 0));
  async function waitSim(sec) {
    const start = await simTime();
    const wall0 = Date.now();
    while ((await simTime()) - start < sec) {
      if (Date.now() - wall0 > 120000) throw new Error('sim stalled');
      await page.waitForTimeout(200);
    }
    return (Date.now() - wall0) / 1000;
  }
  const snap = () => page.evaluate(() => {
    const w = window.__water, s = w.sim.stats;
    return {
      particles: s.count, outside: s.outside, fluidCells: s.fluidCells, fillVolume: +s.fillVolume.toFixed(1), stepMs: +s.stepMs.toFixed(2),
      stepMsMax: +s.stepMsMax.toFixed(2), substeps: s.substeps, simTime: +s.simTime.toFixed(2),
      frameAvg: +w.stats.frameAvg.toFixed(1), frameMax: +w.stats.frameMax.toFixed(1), cpuAvg: +w.stats.cpuAvg.toFixed(2),
    };
  });

  const phases = [
    ['01-settled', { x: 0, y: G, shake: 0 }, 2.5],
    ['02-tilt-left', { x: G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['03-tilt-right', { x: -G * Math.sin(0.6), y: G * Math.cos(0.6), shake: 0 }, 2.0],
    ['04-upside-down', { x: 0, y: -G, shake: 0 }, 2.5],
    ['05-upright-again', { x: 0, y: G, shake: 0 }, 2.5],
    ['06-hard-shake', { x: 0, y: G, shake: 20 }, 2.0],
    ['07-resettled', { x: 0, y: G, shake: 0 }, 6.0],
  ];
  for (const [name, spec, sec] of phases) {
    await setMotion(spec);
    await page.evaluate(() => window.__water.stats.reset());
    const wall = await waitSim(sec);
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    results.phases[name] = { ...(await snap()), wallSec: +wall.toFixed(1) };
  }
  // Overlay view for the record.
  await page.keyboard.press('d');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, '08-overlay.png') });

  const p = results.phases;
  const first = p['01-settled'], last = p['07-resettled'];
  results.volume = {
    particlesConstant: Object.values(p).every((x) => x.particles === first.particles),
    neverOutside: Object.values(p).every((x) => x.outside === 0),
    fluidCellsSettledStart: first.fluidCells,
    fluidCellsSettledEnd: last.fluidCells,
    fluidCellsChangePct: +(((last.fluidCells - first.fluidCells) / first.fluidCells) * 100).toFixed(2),
    // Pass criterion: density-weighted grid fill Σ min(ρ/ρ0,1), settled start vs settled end.
    fillSettledStart: first.fillVolume,
    fillSettledEnd: last.fillVolume,
    fillChangePct: +(((last.fillVolume - first.fillVolume) / first.fillVolume) * 100).toFixed(2),
    fillMaxDeviationPct: +Math.max(...Object.values(p).map((x) => Math.abs(x.fillVolume - first.fillVolume) / first.fillVolume * 100)).toFixed(2),
  };
} finally {
  results.consoleErrors = errors;
  const v = results.volume || {};
  results.pass = errors.length === 0 && v.particlesConstant && v.neverOutside && Math.abs(v.fillChangePct) <= 1;
  logResult(dir, results);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
