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
    // Bounding box of FLUID cells (inclusive, within the solid ring): every
    // sweep is restricted to it, which roughly halves the work for a calm pool.
    this.i0 = 1; this.i1 = nx - 2; this.j0 = 1; this.j1 = ny - 2;
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
    this.lastCycles = 0;
  }

  // type: Int32Array of FLUID/AIR/SOLID for the fine grid; b: right-hand side;
  // q: in/out solution (warm start), both fine-grid sized. Runs `cycles` V-cycles.
  // Runs V-cycles until max|r| ≤ relTol·max|b| (at least 1, at most maxCycles).
  solve(type, b, q, maxCycles, relTol = 0) {
    const L0 = this.levels[0];
    const nx = L0.nx, ny = L0.ny;
    let i0 = nx, i1 = 0, j0 = ny, j1 = 0, bmax = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        const t = type[c];
        L0.type[c] = t;
        if (t === FLUID) {
          const bc = b[c];
          L0.b[c] = bc;
          L0.q[c] = q[c];
          const a = bc < 0 ? -bc : bc;
          if (a > bmax) bmax = a;
          if (i < i0) i0 = i; if (i > i1) i1 = i;
          if (j < j0) j0 = j; if (j > j1) j1 = j;
        } else {
          L0.b[c] = 0;
          L0.q[c] = 0;
        }
      }
    }
    if (i1 < i0) { q.fill(0); this.lastResidual = 0; this.lastCycles = 0; return; }
    L0.i0 = i0; L0.i1 = i1; L0.j0 = j0; L0.j1 = j1;
    for (let l = 1; l < this.levels.length; l++) this._coarsenTypes(this.levels[l - 1], this.levels[l]);
    const tol = relTol * bmax;
    let k = 0, res = 0;
    while (k < maxCycles) {
      this._vcycle(0);
      k++;
      if (relTol > 0 && k < maxCycles) {
        res = this._residual(L0);
        if (res <= tol) break;
      }
    }
    q.set(L0.q);
    this.lastCycles = k;
    this.lastResidual = relTol > 0 && k < maxCycles ? res : this._residual(L0);
  }

  _coarsenTypes(F, C) {
    const fnx = F.nx, fny = F.ny, cny = C.ny;
    const ft = F.type, ct = C.type;
    // Coarse cell I covers fine 2I−1..2I, so the fluid box maps to [(i0+1)>>1, (i1+1)>>1].
    const I0 = Math.max(1, (F.i0 + 1) >> 1), I1 = Math.min(C.nx - 2, (F.i1 + 1) >> 1);
    const J0 = Math.max(1, (F.j0 + 1) >> 1), J1 = Math.min(cny - 2, (F.j1 + 1) >> 1);
    C.i0 = I0; C.i1 = I1; C.j0 = J0; C.j1 = J1;
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
    const ny = L.ny, t = L.type, q = L.q, b = L.b;
    const i0 = L.i0, i1 = L.i1, j0 = L.j0, j1 = L.j1;
    for (let it = 0; it < iters; it++) {
      for (let color = 0; color < 2; color++) {
        for (let i = i0; i <= i1; i++) {
          const base = i * ny;
          for (let j = j0 + ((i + j0 + color) & 1); j <= j1; j += 2) {
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
    const ny = L.ny, t = L.type, q = L.q, b = L.b, r = L.r;
    let mx = 0;
    for (let i = L.i0; i <= L.i1; i++) {
      for (let j = L.j0; j <= L.j1; j++) {
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
    for (let I = C.i0; I <= C.i1; I++) {
      for (let J = C.j0; J <= C.j1; J++) {
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
    for (let i = L.i0; i <= L.i1; i++) {
      // Fine centre i+0.5 in coarse index units; coarse centre I sits at I.
      const x = (i + 0.5) * 0.5;
      const I0 = Math.floor(x);
      const tx = x - I0;
      for (let j = L.j0; j <= L.j1; j++) {
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
