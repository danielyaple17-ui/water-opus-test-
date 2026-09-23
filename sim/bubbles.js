// Entrained air bubbles: a small fixed pool (no allocation after construction).
// Bubbles are born where the liquid takes a hard impact *inside* the water,
// are carried by the grid velocity, rise against the effective gravity at a
// radius-dependent terminal speed, and pop when they reach air.

import { FLUID } from './flip.js';

export const MAX_BUBBLES = 256;

export class Bubbles {
  constructor(sim) {
    this.sim = sim;
    this.x = new Float32Array(MAX_BUBBLES);
    this.y = new Float32Array(MAX_BUBBLES);
    this.r = new Float32Array(MAX_BUBBLES); // radius, m
    this.age = new Float32Array(MAX_BUBBLES);
    this.count = 0;
    this._v = new Float32Array(2);
    this._seed = 1234567;
  }

  _rand() {
    // xorshift32 → [0, 1)
    let s = this._seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this._seed = s >>> 0;
    return this._seed / 4294967296;
  }

  _isFluid(x, y) {
    const sim = this.sim;
    const i = Math.floor(x * sim.invH), j = Math.floor(y * sim.invH);
    if (i < 1 || j < 1 || i >= sim.nx - 1 || j >= sim.ny - 1) return false;
    return sim.cellType[i * sim.ny + j] === FLUID;
  }

  // fx, fy: effective body acceleration on the water (buoyancy points against it).
  step(dt, fx, fy) {
    const sim = this.sim;
    // Sample random particles; those taking a hard impact while submerged
    // (liquid two cells "above" them, against gravity) entrain air.
    const g0 = Math.hypot(fx, fy) || 1;
    const upx = -fx / g0 * sim.h * 2, upy = -fy / g0 * sim.h * 2;
    const tries = 160;
    let budget = 6;
    for (let t = 0; t < tries && budget > 0 && this.count < MAX_BUBBLES; t++) {
      const i = Math.floor(this._rand() * sim.numParticles);
      const a = sim.impact[i];
      if (a < 45) continue;
      const px = sim.pos[2 * i], py = sim.pos[2 * i + 1];
      if (!this._isFluid(px, py) || !this._isFluid(px + upx, py + upy)) continue;
      if (this._rand() > Math.min(1, (a - 45) / 100)) continue;
      const k = this.count++;
      this.x[k] = px; this.y[k] = py;
      const u = this._rand();
      this.r[k] = 0.00025 + u * u * 0.0009; // 0.25–1.15 mm, mostly small
      this.age[k] = 0;
      budget--;
    }

    // Move: fluid velocity + terminal rise speed (Stokes-ish, capped) against gravity.
    const g = Math.hypot(fx, fy) || 1;
    const ux = -fx / g, uy = -fy / g;
    const v = this._v;
    const minX = sim.h * 1.2, maxX = (sim.nx - 1.2) * sim.h;
    const minY = sim.h * 1.2, maxY = (sim.ny - 1.2) * sim.h;
    let k = 0;
    for (let b = 0; b < this.count; b++) {
      let x = this.x[b], y = this.y[b];
      const r = this.r[b];
      sim.sampleVelocity(x, y, v);
      const rise = Math.min(0.25, 180 * r) * Math.min(1, g / 9.81); // ~0.05–0.2 m/s
      x += (v[0] + ux * rise) * dt;
      y += (v[1] + uy * rise) * dt;
      x = x < minX ? minX : x > maxX ? maxX : x;
      y = y < minY ? minY : y > maxY ? maxY : y;
      const age = this.age[b] + dt;
      // Pop on reaching air (or after a long life); compact the pool in place.
      if (!this._isFluid(x, y) || age > 8) continue;
      this.x[k] = x; this.y[k] = y; this.r[k] = r; this.age[k] = age;
      k++;
    }
    this.count = k;
  }

  // A tap entrains a few bubbles around (x, y) if that point is inside the water.
  burst(x, y, n) {
    const sim = this.sim;
    for (let k = 0; k < n && this.count < MAX_BUBBLES; k++) {
      const bx = x + (this._rand() - 0.5) * sim.h * 8, by = y + (this._rand() - 0.5) * sim.h * 8;
      if (!this._isFluid(bx, by)) continue;
      const i = this.count++;
      this.x[i] = bx; this.y[i] = by;
      const u = this._rand();
      this.r[i] = 0.0003 + u * u * 0.0007;
      this.age[i] = 0;
    }
  }

  clear() { this.count = 0; }
}
