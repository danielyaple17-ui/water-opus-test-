// M1 verification: page boots with no console errors, start screen works,
// synthetic motion maps to the expected gravity direction, overlay shows it.
import { loadPlaywright, startServer, launch, outDir, streamMotion, logResult } from './lib.mjs';
import path from 'node:path';

const { chromium } = loadPlaywright();
const dir = outDir('M1');
const server = await startServer();
const browser = await launch(chromium);
const errors = [];
const results = { checks: {} };

try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(dir, '00-start.png') });

  results.webgl2 = await page.evaluate(() => !!window.__water && !window.__water.renderer.lost);
  await page.click('#start');
  await page.waitForTimeout(700);
  results.started = await page.evaluate(() => window.__water.state.started);
  // Open the debug overlay via triple-tap in the top-right corner.
  for (let i = 0; i < 3; i++) await page.touchscreen.tap(370, 20);
  await page.waitForTimeout(100);
  results.overlayVisible = await page.evaluate(() => !document.getElementById('debug').hidden);

  const G = 9.81;
  const scenes = [
    ['01-upright', `return {aig:{x:0,y:${G},z:0}, acc:{x:0,y:0,z:0}}`, (g) => g.gy > 9 && Math.abs(g.gx) < 0.5],
    ['02-tilt-left', `return {aig:{x:${G * Math.sin(0.6)},y:${G * Math.cos(0.6)},z:0}, acc:{x:0,y:0,z:0}}`, (g) => g.gx < -5 && g.gy > 7],
    ['03-tilt-right', `return {aig:{x:${-G * Math.sin(0.6)},y:${G * Math.cos(0.6)},z:0}, acc:{x:0,y:0,z:0}}`, (g) => g.gx > 5 && g.gy > 7],
    ['04-upside-down', `return {aig:{x:0,y:${-G},z:0}, acc:{x:0,y:0,z:0}}`, (g) => g.gy < -9],
    ['05-flat', `return {aig:{x:0,y:0,z:${G}}, acc:{x:0,y:0,z:0}}`, (g) => Math.hypot(g.gx, g.gy) < 0.5],
    // Hard shake along device x at 6 Hz, 20 m/s² amplitude, upright.
    ['06-shake', `const a=20*Math.sin(2*Math.PI*6*t); return {aig:{x:a,y:${G},z:0}, acc:{x:a,y:0,z:0}, rot:{alpha:90,beta:0,gamma:0}}`,
      (g) => g.gy > 9 && Math.abs(g.gx) < 1.0 && g.maxA > 10 && g.maxA <= 30.001 && g.spin < -1],
  ];
  for (const [name, src, check] of scenes) {
    await page.evaluate(() => { window.__maxA = 0; window.__probe = setInterval(() => {
      const m = window.__water.motion; window.__maxA = Math.max(window.__maxA, Math.hypot(m.ax, m.ay)); }, 8); });
    await streamMotion(page, src, 1200);
    const g = await page.evaluate(() => { clearInterval(window.__probe); const m = window.__water.motion;
      return { gx: m.gx, gy: m.gy, ax: m.ax, ay: m.ay, spin: m.spin, maxA: window.__maxA, source: m.source }; });
    await page.waitForTimeout(300); // let overlay refresh
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    results.checks[name] = { ...g, pass: !!check(g) };
  }

  // Frame timing over 3 s of idle running.
  await page.evaluate(() => window.__water.stats.reset());
  await page.waitForTimeout(3000);
  results.frame = await page.evaluate(() => {
    const s = window.__water.stats;
    return { avgMs: s.frameAvg, maxMs: s.frameMax, cpuAvgMs: s.cpuAvg, simSteps: window.__water.clock.steps };
  });
  results.volume = 'n/a (no water until M2)';

  // Desktop fallback: mouse tilts gravity.
  const dctx = await browser.newContext({ viewport: { width: 600, height: 800 }, ignoreHTTPSErrors: true });
  const dp = await dctx.newPage();
  dp.on('pageerror', (e) => errors.push(String(e)));
  await dp.goto(server.url);
  await dp.waitForTimeout(500);
  await dp.mouse.move(50, 400);
  await dp.waitForTimeout(100);
  const dg = await dp.evaluate(() => ({ gx: window.__water.motion.gx, gy: window.__water.motion.gy, src: window.__water.motion.source }));
  results.checks['desktop-mouse-tilt'] = { ...dg, pass: dg.gx < -9 && dg.src === 'mouse' };
  await dp.mouse.move(300, 780);
  await dp.mouse.down();
  for (let i = 0; i < 12; i++) { await dp.mouse.move(i % 2 ? 100 : 500, 780); await dp.waitForTimeout(34); }
  const da = await dp.evaluate(() => { const m = window.__water.motion; return { ax: m.ax, ay: m.ay }; });
  await dp.mouse.up();
  results.checks['desktop-drag-shake'] = { ...da, pass: Math.hypot(da.ax, da.ay) > 2 };
} finally {
  results.consoleErrors = errors;
  results.pass = errors.length === 0 && results.webgl2 && results.started && results.overlayVisible &&
    Object.values(results.checks).every((c) => c.pass);
  logResult(dir, results);
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  server.stop();
}
process.exit(results.pass ? 0 : 1);
