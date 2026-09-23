// On-device benchmark (`?bench=1`, optional `&benchSec=N` per phase, default 8).
// For each quality level (Ultra → Low) it pins the level, lets the resample
// settle, then measures a calm phase and a phase with an injected hard shake
// (tank acceleration ±20 m/s² at 4 Hz, the same stress as the verify runs):
// frame time avg / p95 / max, worker step avg, sim real-time ratio. Results
// are shown as JSON in the debug overlay with a Copy button, so a real phone
// can report back without devtools. Frame samples go into a preallocated ring.

import { LEVELS } from '../src/quality.js';

const SETTLE = 3; // s after each level change before measuring

export class Bench {
  constructor({ quality, sim, motion, overlay, seconds = 8 }) {
    this.quality = quality;
    this.sim = sim;
    this.motion = motion;
    this.overlay = overlay;
    this.phaseSec = seconds;
    this.samples = new Float32Array(4096);
    this.n = 0;
    this.plan = [];
    for (let l = LEVELS.length - 1; l >= 0; l--) {
      this.plan.push({ level: l, phase: 'settle', sec: SETTLE });
      this.plan.push({ level: l, phase: 'calm', sec: seconds });
      this.plan.push({ level: l, phase: 'shake', sec: seconds });
    }
    this.i = -1;
    this.t = 0;
    this.shakeT = 0;
    this.results = [];
    this.done = false;
    this._sim0 = 0; this._wall0 = 0; this._step = 0; this._stepN = 0;
  }

  // Called every frame after motion.update(), before the sim update.
  tick(dt) {
    if (this.done) return;
    if (this.i < 0) { this._next(); }
    const p = this.plan[this.i];
    this.t += dt;
    if (p.phase === 'shake') {
      this.shakeT += dt;
      this.motion.ax = 20 * Math.sin(2 * Math.PI * 4 * this.shakeT);
    }
    if (p.phase !== 'settle') {
      if (this.n < this.samples.length) this.samples[this.n++] = dt * 1000;
      const s = this.sim.stats;
      if (s) { this._step += s.stepMs; this._stepN++; }
    }
    if (this.t >= p.sec) this._finish(p);
  }

  _next() {
    this.i++;
    if (this.i >= this.plan.length) { this._report(); return; }
    const p = this.plan[this.i];
    if (p.phase === 'settle') this.quality.force(p.level);
    this.t = 0; this.n = 0; this._step = 0; this._stepN = 0;
    this._sim0 = this.sim.stats ? this.sim.stats.simTime : 0;
    this._wall0 = performance.now();
  }

  _finish(p) {
    if (p.phase !== 'settle') {
      const a = Array.from(this.samples.subarray(0, this.n)).sort((x, y) => x - y);
      const avg = a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      const simDt = (this.sim.stats ? this.sim.stats.simTime : 0) - this._sim0;
      this.results.push({
        level: LEVELS[p.level].name, phase: p.phase, particles: this.sim.stats ? this.sim.stats.count : 0,
        frameAvgMs: +avg.toFixed(2), frameP95Ms: +(a[Math.floor(a.length * 0.95)] || 0).toFixed(2),
        frameMaxMs: +(a[a.length - 1] || 0).toFixed(2), stepMs: +(this._step / Math.max(1, this._stepN)).toFixed(2),
        simRatio: +(simDt / ((performance.now() - this._wall0) / 1000)).toFixed(2),
      });
    }
    this._next();
  }

  _report() {
    this.done = true;
    this.quality.auto = true;
    const report = { ua: navigator.userAgent, dpr: window.devicePixelRatio, screen: [screen.width, screen.height], results: this.results };
    const json = JSON.stringify(report, null, 1);
    window.__benchReport = report;
    console.log('[bench]', json);
    this.overlay.showReport(json);
  }
}
