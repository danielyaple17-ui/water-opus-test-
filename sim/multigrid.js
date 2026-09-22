// Geometric multigrid V-cycle for the free-surface pressure Poisson problem
//
//   Σ_{non-solid n} (q_c − q_n) = b_c   on FLUID cells,  q = 0 on AIR cells,
//
// with solid neighbours excluded (Neumann). Smoother: red-black Gauss-Seidel.
// Coarsening: coarse cell (I,J) covers fine cells 2I−1..2I × 2J−1..2J; it is
// FLUID if any child is fluid, else AIR if any child is air, else SOLID. Every
// level keeps a solid outer ring, so the inner loops need no bounds checks.
// All storage is allocated once in the constructor.

const FLUID = 0, AIR = 1, SOLID = 2;

class Level {
  constructor(nx, ny) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.type = new Int8Array(n);
    this.q = new Float64Array(n);
    this.b = new Float64Array(n);
    this.r = new Float64Array(n);
  }
}

export class PressureMG {
  constructor(nx, ny) {
    this.levels = [];
    let lx = nx, ly = ny;
    for (;;) {
      this.levels.push(new Level(lx, ly));
      if (lx < 10 || ly < 10) break;
      lx = (lx >> 1) + 2;
      ly = (ly >> 1) + 2;
    }
    this.preSmooth = 3;
    this.postSmooth = 3;
    this.coarseIters = 30;
    this.lastResidual = 0;
  }

  // type: Int32Array of FLUID/AIR/SOLID for the fine grid; b: right-hand side;
  // q: in/out solution (warm start), both fine-grid sized. Runs `cycles` V-cycles.
  solve(type, b, q, cycles) {
    const L0 = this.levels[0];
    const n = L0.nx * L0.ny;
    for (let c = 0; c < n; c++) {
      L0.type[c] = type[c];
      L0.b[c] = type[c] === FLUID ? b[c] : 0;
      L0.q[c] = type[c] === FLUID ? q[c] : 0;
    }
    for (let l = 1; l < this.levels.length; l++) this._coarsenTypes(this.levels[l - 1], this.levels[l]);
    for (let k = 0; k < cycles; k++) this._vcycle(0);
    q.set(L0.q);
    this.lastResidual = this._residual(L0);
  }

  _coarsenTypes(F, C) {
    const fnx = F.nx, fny = F.ny, cny = C.ny;
    const ft = F.type, ct = C.type;
    for (let I = 0; I < C.nx; I++) {
      for (let J = 0; J < cny; J++) {
        let fluid = false, air = false;
        for (let di = -1; di <= 0; di++) {
          const i = 2 * I + di;
          if (i < 0 || i >= fnx) continue;
          for (let dj = -1; dj <= 0; dj++) {
            const j = 2 * J + dj;
            if (j < 0 || j >= fny) continue;
            const t = ft[i * fny + j];
            if (t === FLUID) fluid = true; else if (t === AIR) air = true;
          }
        }
        // Keep the outer ring solid regardless of coverage.
        const ring = I === 0 || J === 0 || I === C.nx - 1 || J === cny - 1;
        ct[I * cny + J] = ring ? SOLID : air ? AIR : fluid ? FLUID : SOLID;
      }
    }
  }

  _smooth(L, iters) {
    const nx = L.nx, ny = L.ny, t = L.type, q = L.q, b = L.b;
    for (let it = 0; it < iters; it++) {
      for (let color = 0; color < 2; color++) {
        for (let i = 1; i < nx - 1; i++) {
          const base = i * ny;
          for (let j = 1 + ((i + color) & 1); j < ny - 1; j += 2) {
            const c = base + j;
            if (t[c] !== FLUID) continue;
            let ss = 0, sum = 0, tn;
            tn = t[c - ny]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c - ny]; }
            tn = t[c + ny]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c + ny]; }
            tn = t[c - 1]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c - 1]; }
            tn = t[c + 1]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c + 1]; }
            if (ss > 0) q[c] = (b[c] + sum) / ss;
          }
        }
      }
    }
  }

  // r = b − A q on fluid cells; returns max |r|.
  _residual(L) {
    const nx = L.nx, ny = L.ny, t = L.type, q = L.q, b = L.b, r = L.r;
    let mx = 0;
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < ny - 1; j++) {
        const c = i * ny + j;
        if (t[c] !== FLUID) { r[c] = 0; continue; }
        let ss = 0, sum = 0, tn;
        tn = t[c - ny]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c - ny]; }
        tn = t[c + ny]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c + ny]; }
        tn = t[c - 1]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c - 1]; }
        tn = t[c + 1]; if (tn !== SOLID) { ss++; if (tn === FLUID) sum += q[c + 1]; }
        const res = b[c] - (ss * q[c] - sum);
        r[c] = res;
        const a = res < 0 ? -res : res;
        if (a > mx) mx = a;
      }
    }
    return mx;
  }

  _vcycle(l) {
    const L = this.levels[l];
    if (l === this.levels.length - 1) {
      this._smooth(L, this.coarseIters);
      return;
    }
    this._smooth(L, this.preSmooth);
    this._residual(L);
    const C = this.levels[l + 1];
    // Restrict: coarse rhs = sum of the children's residuals (the H² = 4h² scaling).
    const fnx = L.nx, fny = L.ny, cny = C.ny;
    for (let I = 0; I < C.nx; I++) {
      for (let J = 0; J < cny; J++) {
        const cc = I * cny + J;
        C.q[cc] = 0;
        if (C.type[cc] !== FLUID) { C.b[cc] = 0; continue; }
        let s = 0;
        for (let di = -1; di <= 0; di++) {
          const i = 2 * I + di;
          if (i < 0 || i >= fnx) continue;
          for (let dj = -1; dj <= 0; dj++) {
            const j = 2 * J + dj;
            if (j < 0 || j >= fny) continue;
            s += L.r[i * fny + j];
          }
        }
        C.b[cc] = s;
      }
    }
    this._vcycle(l + 1);
    // Prolongate (bilinear; solid coarse cells excluded and weights renormalised,
    // air coarse cells contribute a zero correction).
    const ct = C.type, cq = C.q;
    for (let i = 1; i < fnx - 1; i++) {
      // Fine centre i+0.5 in coarse index units; coarse centre I sits at I.
      const x = (i + 0.5) * 0.5;
      const I0 = Math.floor(x);
      const tx = x - I0;
      for (let j = 1; j < fny - 1; j++) {
        const c = i * fny + j;
        if (L.type[c] !== FLUID) continue;
        const y = (j + 0.5) * 0.5;
        const J0 = Math.floor(y);
        const ty = y - J0;
        let wsum = 0, v = 0;
        for (let a = 0; a < 2; a++) {
          const I = I0 + a;
          if (I < 0 || I >= C.nx) continue;
          const wx = a === 0 ? 1 - tx : tx;
          for (let bb = 0; bb < 2; bb++) {
            const J = J0 + bb;
            if (J < 0 || J >= cny) continue;
            const w = wx * (bb === 0 ? 1 - ty : ty);
            const k = I * cny + J;
            const tt = ct[k];
            if (tt === SOLID) continue;
            wsum += w;
            if (tt === FLUID) v += w * cq[k];
          }
        }
        if (wsum > 0) L.q[c] += v / wsum;
      }
    }
    this._smooth(L, this.postSmooth);
  }
}
