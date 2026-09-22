// Simulation worker: owns the FlipSim and its fixed 120 Hz clock. The main
// thread sends frame dt + input and a free output buffer; the worker advances
// whole fixed steps and returns the buffer filled with particle state
// (x, y normalised to the tank interior [0,1], vx, vy in m/s), transferred
// back zero-copy. The same ArrayBuffers ping-pong forever: no per-frame allocation
// of particle data.

import { FlipSim } from './flip.js';
import { FixedStep } from './fixed-step.js';

let sim = null;
const clock = new FixedStep(120, 4);
const input = { gx: 0, gy: 9.81, ax: 0, ay: 0, spin: 0, alpha: 0, prevSpin: 0 };
const stats = {
  type: 'frame', buf: null, count: 0,
  steps: 0, stepMs: 0, stepMsMax: 0, substeps: 1,
  fluidCells: 0, fillVolume: 0, outside: 0, comX: 0.5, comY: 0.5, angMom: 0, maxSpeed: 0, simTime: 0,
};

function stepOnce(dt) {
  // The tank accelerates by a, so in the tank frame the water feels g − a.
  sim.step(dt, input.gx - input.ax, input.gy - input.ay, input.spin, input.alpha);
  stats.simTime += dt;
}

function writeOut(out) {
  const n = sim.numParticles, pos = sim.pos, vel = sim.vel, h = sim.h;
  const invW = 1 / ((sim.nx - 2) * h), invH = 1 / ((sim.ny - 2) * h);
  const minX = h, maxX = (sim.nx - 1) * h, minY = h, maxY = (sim.ny - 1) * h;
  const cx = 0.5 * sim.width, cy = 0.5 * sim.height;
  let outside = 0, sx = 0, sy = 0, L = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[2 * i], y = pos[2 * i + 1];
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) outside++;
    sx += x; sy += y;
    // Angular momentum about the tank centre, + = clockwise on screen (y down).
    L += (x - cx) * vel[2 * i + 1] - (y - cy) * vel[2 * i];
    out[4 * i] = (x - h) * invW;
    out[4 * i + 1] = (y - h) * invH;
    out[4 * i + 2] = vel[2 * i];
    out[4 * i + 3] = vel[2 * i + 1];
  }
  stats.outside = outside;
  stats.comX = (sx / n - h) * invW;
  stats.comY = (sy / n - h) * invH;
  stats.angMom = L / n;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    sim = new FlipSim(m.opts);
    clock.reset();
    stats.simTime = 0;
    self.postMessage({
      type: 'ready',
      count: sim.numParticles,
      radius: sim.r / ((sim.nx - 2) * sim.h), // particle radius as a fraction of tank width
      cellsX: sim.nx - 2,
      cellsY: sim.ny - 2,
    });
    return;
  }
  if (m.type === 'step') {
    input.gx = m.gx; input.gy = m.gy; input.ax = m.ax; input.ay = m.ay; input.spin = m.spin;
    // Angular acceleration for the Euler force, smoothed over ~50 ms.
    if (m.dt > 0) {
      const a = (m.spin - input.prevSpin) / m.dt;
      input.alpha += (a - input.alpha) * (1 - Math.exp(-m.dt / 0.05));
    }
    input.prevSpin = m.spin;
    const t0 = performance.now();
    const n = clock.advance(m.dt, stepOnce);
    const ms = performance.now() - t0;
    if (n > 0) {
      const per = ms / n;
      stats.stepMs = stats.stepMs ? stats.stepMs * 0.9 + per * 0.1 : per;
      if (per > stats.stepMsMax) stats.stepMsMax = per;
    }
    stats.steps = n;
    stats.substeps = sim.substeps;
    stats.fluidCells = sim.fluidCells;
    stats.fillVolume = sim.fillVolume;
    stats.maxSpeed = sim.maxSpeed;
    const out = new Float32Array(m.buf);
    writeOut(out);
    stats.buf = m.buf;
    stats.count = sim.numParticles;
    self.postMessage(stats, [m.buf]);
    stats.buf = null;
  }
};
