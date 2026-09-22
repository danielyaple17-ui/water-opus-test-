// Shared helpers for headless verification runs (Playwright + dev server).
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch (_) { /* fall through to global */ }
  const g = execSync('npm root -g').toString().trim();
  return require(path.join(g, 'playwright'));
}

export async function startServer(port = 8443 + Math.floor(Math.random() * 500)) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/dev-server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server start timeout')), 15000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('https://localhost')) { clearTimeout(to); resolve(); }
    });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return { url: `https://localhost:${port}/`, stop: () => proc.kill() };
}

export async function launch(chromium) {
  return chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
}

export function outDir(name) {
  const d = path.join(ROOT, 'verify', name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Streams synthetic DeviceMotion events at 60 Hz inside the page for `ms`.
// `spec(t)` is serialised and evaluated in the page: returns {aig:{x,y,z}, acc:{x,y,z}|null, rot:{alpha,beta,gamma}}.
export async function streamMotion(page, specSrc, ms) {
  await page.evaluate(([src, dur]) => new Promise((resolve) => {
    const spec = new Function('t', src);
    const t0 = performance.now();
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const s = spec(t);
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: s.aig,
        acceleration: s.acc || null,
        rotationRate: s.rot || { alpha: 0, beta: 0, gamma: 0 },
        interval: 16,
      }));
      if (t * 1000 >= dur) { clearInterval(id); resolve(); }
    }, 16);
  }), [specSrc, ms]);
}

export function logResult(dir, obj) {
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(obj, null, 2));
}
