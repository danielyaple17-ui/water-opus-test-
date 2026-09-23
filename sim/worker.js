// Simulation worker: owns the FlipSim and its fixed 120 Hz clock. The main
// thread sends frame dt + input and a free output buffer; the worker advances
// whole fixed steps and returns the buffer filled with particle state
// (x, y normalised to the tank interior [0,1], foam 0..1, speed m/s), followed
// by MAX_BUBBLES × (x, y, radius as fraction of tank width, alpha), transferred
// back zero-copy. The same ArrayBuffers ping-pong forever: no per-frame allocation
// of particle data.

import { FlipSim, FLUID } from './flip.js';
import { FixedStep } from './fixed-step.js';
import { Bubbles, MAX_BUBBLES } from './bubbles.js';

let sim = null;
let bubbles = null;
const clock = new FixedStep(120, 4);
const input = { gx: 0, gy: 9.81, ax: 0, ay: 0, spin: 0, alpha: 0, prevSpin: 0 };
const stats = {
  type: 'frame', buf: null, count: 0,
  steps: 0, stepMs: 0, stepMsMax: 0, substeps: 1,
  fluidCells: 0, fillVolume: 0, outside: 0, comX: 0.5, comY: 0.5, angMom: 0,
  bubbles: 0, activity: 0, foamSum: 0, maxSpeed: 0, simTime: 0,
};

function stepOnce(dt) {
  // The tank accelerates by a, so in the tank frame the water feels g − a.
  const fx = input.gx - input.ax, fy = input.gy - input.ay;
  sim.step(dt, fx, fy, input.spin, input.alpha);
  bubbles.step(dt, fx, fy);
  stats.simTime += dt;
}

function writeOut(out) {
  const n = sim.numParticles, pos = sim.pos, vel = sim.vel, h = sim.h;
  const invW = 1 / ((sim.nx - 2) * h), invH = 1 / ((sim.ny - 2) * h);
  const minX = h, maxX = (sim.nx - 1) * h, minY = h, maxY = (sim.ny - 1) * h;
  const cx = 0.5 * sim.width, cy = 0.5 * sim.height;
  const foam = sim.foam;
  let outside = 0, sx = 0, sy = 0, L = 0, e = 0, fs = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[2 * i], y = pos[2 * i + 1];
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) outside++;
    sx += x; sy += y;
    // Angular momentum about the tank centre, + = clockwise on screen (y down).
    L += (x - cx) * vel[2 * i + 1] - (y - cy) * vel[2 * i];
    out[4 * i] = (x - h) * invW;
    out[4 * i + 1] = (y - h) * invH;
    const vx = vel[2 * i], vy = vel[2 * i + 1];
    const sp2 = vx * vx + vy * vy;
    e += sp2;
    fs += foam[i];
    out[4 * i + 2] = foam[i];
    out[4 * i + 3] = Math.sqrt(sp2);
  }
  stats.outside = outside;
  const nn = n > 0 ? n : 1; // pour-in starts with no active particles
  stats.comX = n > 0 ? (sx / nn - h) * invW : 0.5;
  stats.comY = n > 0 ? (sy / nn - h) * invH : 0.5;
  stats.angMom = L / nn;
  stats.activity = Math.sqrt(e / nn);
  stats.foamSum = fs;
  // Bubbles after the particles.
  const base = 4 * n, invWm = 1 / ((sim.nx - 2) * h);
  const nb = bubbles.count;
  for (let b = 0; b < nb; b++) {
    const o = base + 4 * b;
    out[o] = (bubbles.x[b] - h) * invW;
    out[o + 1] = (bubbles.y[b] - h) * invH;
    out[o + 2] = bubbles.r[b] * invWm;
    const age = bubbles.age[b];
    out[o + 3] = Math.min(1, age / 0.15);
  }
  stats.bubbles = nb;
  stats.pourRemaining = sim.pourRemaining;
  stats.maxSpeed = sim.maxSpeed;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init' || m.type === 'resample') {
    // 'resample' changes resolution (quality level) and keeps the water.
    sim = m.type === 'resample' && sim ? FlipSim.resampleFrom(sim, m.opts) : new FlipSim(m.opts);
    bubbles = new Bubbles(sim);
    clock.reset();
    if (m.type === 'init') stats.simTime = 0;
    stats.stepMs = 0; stats.stepMsMax = 0;
    self.postMessage({
      type: 'ready',
      count: sim.capacity, // buffer capacity; frames report the active count (pour-in)
      radius: sim.r / ((sim.nx - 2) * sim.h), // particle radius as a fraction of tank width
      cellsX: sim.nx - 2,
      cellsY: sim.ny - 2,
      maxBubbles: MAX_BUBBLES,
    });
    return;
  }
  if (m.type === 'impulse' && sim) {
    // Tap splash at tank-normalised (x, y).
    const ix = sim.h + m.x * (sim.nx - 2) * sim.h, iy = sim.h + m.y * (sim.ny - 2) * sim.h;
    sim.impulse(ix, iy, 0.011, 0.9);
    bubbles.burst(ix, iy, 10);
    // Ripple: also kick the free surface directly "above" the tap (against the
    // body force), so a tap anywhere in the water raises a visible crown that
    // spreads as ripples.
    const fx = input.gx - input.ax, fy = input.gy - input.ay;
    const g = Math.hypot(fx, fy) || 1;
    const ux = -fx / g, uy = -fy / g;
    let sx = ix, sy = iy, found = false;
    for (let k = 0; k < 400; k++) {
      const i = Math.floor(sx * sim.invH), j = Math.floor(sy * sim.invH);
      if (i < 1 || j < 1 || i >= sim.nx - 1 || j >= sim.ny - 1) break;
      if (sim.cellType[i * sim.ny + j] !== FLUID) { found = k > 0; break; }
      sx += ux * sim.h * 0.5; sy += uy * sim.h * 0.5;
    }
    if (found) sim.impulse(sx - ux * sim.h * 5, sy - uy * sim.h * 5, 0.009, 0.7);
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
