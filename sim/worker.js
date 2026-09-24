// Simulation worker: owns the FlipSim and its fixed 120 Hz clock. The main
// thread sends frame dt + input and a free output buffer; the worker advances
// whole fixed steps and returns the buffer filled with particle state
// (x, y normalised to the tank interior [0,1], seed + foam packed as int + fraction, foam freshness 0..1), followed
// by MAX_BUBBLES × (x, y, radius as fraction of tank width, alpha), transferred
// back zero-copy. The same ArrayBuffers ping-pong forever and the per-frame
// inputs/stats live in the buffer header (sim/layout.js), so no message objects
// are cloned per frame.

import { FlipSim, FLUID } from './flip.js';
import { FixedStep } from './fixed-step.js';
import { Bubbles, MAX_BUBBLES } from './bubbles.js';
import * as LY from './layout.js';

let sim = null;
let bubbles = null;
const clock = new FixedStep(120, 4);
const input = { gx: 0, gy: 9.81, ax: 0, ay: 0, spin: 0, alpha: 0, prevSpin: 0 };
let gen = 0; // bumps on init/resample so the host can drop stale buffers
let goal = null; // game: goal rect [u0, v0, u1, v1] in tank-interior coords
const stats = {
  steps: 0, stepMs: 0, stepMsMax: 0, simTime: 0,
  outside: 0, comX: 0.5, comY: 0.5, angMom: 0, activity: 0, foamSum: 0,
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
  const foam = sim.foam, seed = sim.seed, fresh = sim.fresh;
  let outside = 0, sx = 0, sy = 0, L = 0, e = 0, fs = 0, inGoal = 0;
  const g0 = goal ? goal[0] : 2, g1 = goal ? goal[1] : 2, g2 = goal ? goal[2] : -1, g3 = goal ? goal[3] : -1;
  for (let i = 0; i < n; i++) {
    const x = pos[2 * i], y = pos[2 * i + 1];
    if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) outside++;
    sx += x; sy += y;
    // Angular momentum about the tank centre, + = clockwise on screen (y down).
    L += (x - cx) * vel[2 * i + 1] - (y - cy) * vel[2 * i];
    const o = LY.HEADER + 4 * i;
    const u = (x - h) * invW, v = (y - h) * invH;
    out[o] = u;
    out[o + 1] = v;
    if (u >= g0 && u <= g2 && v >= g1 && v <= g3) inGoal++;
    const vx = vel[2 * i], vy = vel[2 * i + 1];
    const sp2 = vx * vx + vy * vy;
    e += sp2;
    fs += foam[i];
    // Packed: integer part = stable particle seed, fraction = foam (0..0.999).
    const fo = foam[i];
    out[o + 2] = seed[i] + (fo < 0.999 ? fo : 0.999);
    out[o + 3] = fresh[i]; // foam freshness (whitewater); speed is only in the stats
  }
  stats.outside = outside;
  const nn = n > 0 ? n : 1; // pour-in starts with no active particles
  stats.comX = n > 0 ? (sx / nn - h) * invW : 0.5;
  stats.comY = n > 0 ? (sy / nn - h) * invH : 0.5;
  stats.angMom = L / nn;
  stats.activity = Math.sqrt(e / nn);
  stats.foamSum = fs;
  // Bubbles after the particles (payload is laid out for full capacity).
  const base = 4 * sim.capacity, invWm = 1 / ((sim.nx - 2) * h);
  const nb = bubbles.count;
  for (let b = 0; b < nb; b++) {
    const o = LY.HEADER + base + 4 * b;
    out[o] = (bubbles.x[b] - h) * invW;
    out[o + 1] = (bubbles.y[b] - h) * invH;
    out[o + 2] = bubbles.r[b] * invWm;
    const age = bubbles.age[b];
    out[o + 3] = Math.min(1, age / 0.15);
  }
  // Header: stats for the host.
  out[LY.S_COUNT] = n;
  out[LY.S_BUBBLES] = nb;
  out[LY.S_SIMTIME] = stats.simTime;
  out[LY.S_STEPMS] = stats.stepMs;
  out[LY.S_STEPMSMAX] = stats.stepMsMax;
  out[LY.S_SUBSTEPS] = sim.substeps;
  out[LY.S_FLUID] = sim.fluidCells;
  out[LY.S_FILL] = sim.fillVolume;
  out[LY.S_OUTSIDE] = outside;
  out[LY.S_COMX] = stats.comX;
  out[LY.S_COMY] = stats.comY;
  out[LY.S_ANGMOM] = stats.angMom;
  out[LY.S_ACTIVITY] = stats.activity;
  out[LY.S_FOAMSUM] = fs;
  out[LY.S_MAXSPEED] = sim.maxSpeed;
  out[LY.S_POUR] = sim.pourRemaining;
  out[LY.S_STEPS] = stats.steps;
  out[LY.S_GEN] = gen;
  out[LY.S_GOAL] = inGoal;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m instanceof ArrayBuffer) { step(m); return; }
  if (m.type === 'init' || m.type === 'resample') {
    // 'resample' changes resolution (quality level) and keeps the water.
    sim = m.type === 'resample' && sim ? FlipSim.resampleFrom(sim, m.opts) : new FlipSim(m.opts);
    goal = m.opts.goal || null;
    bubbles = new Bubbles(sim);
    clock.reset();
    gen++;
    if (m.type === 'init') stats.simTime = 0;
    stats.stepMs = 0; stats.stepMsMax = 0;
    self.postMessage({
      type: 'ready',
      count: sim.capacity, // buffer capacity; frames report the active count (pour-in)
      radius: sim.r / ((sim.nx - 2) * sim.h), // particle radius as a fraction of tank width
      cellsX: sim.nx - 2,
      cellsY: sim.ny - 2,
      maxBubbles: MAX_BUBBLES,
      gen,
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
};

// One frame's worth of fixed steps; `buf` carries the inputs in, the state out.
function step(buf) {
  const io = new Float32Array(buf);
  if (!sim || io.length !== LY.bufferFloats(sim.capacity, MAX_BUBBLES)) {
    self.postMessage(buf, [buf]); // stale (pre-resample) buffer: hand it back untouched
    return;
  }
  const dt = io[LY.I_DT], spin = io[LY.I_SPIN];
  input.gx = io[LY.I_GX]; input.gy = io[LY.I_GY]; input.ax = io[LY.I_AX]; input.ay = io[LY.I_AY]; input.spin = spin;
  // Angular acceleration for the Euler force, smoothed over ~50 ms.
  if (dt > 0) {
    const a = (spin - input.prevSpin) / dt;
    input.alpha += (a - input.alpha) * (1 - Math.exp(-dt / 0.05));
  }
  input.prevSpin = spin;
  const t0 = performance.now();
  const n = clock.advance(dt, stepOnce);
  const ms = performance.now() - t0;
  if (n > 0) {
    const per = ms / n;
    stats.stepMs = stats.stepMs ? stats.stepMs * 0.9 + per * 0.1 : per;
    if (per > stats.stepMsMax) stats.stepMsMax = per;
  }
  stats.steps = n;
  writeOut(io);
  self.postMessage(buf, [buf]);
}
