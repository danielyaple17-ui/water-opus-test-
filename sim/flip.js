// 2D FLIP/PIC water on a staggered MAC grid (after Müller, "Ten Minute Physics" FLIP),
// written allocation-free over typed arrays so it can run in a worker at 120 Hz.
//
// Coordinates: metres, stage frame (x right, y DOWN). Gravity arrives in the same
// frame, so no sign juggling. Grid index = i * ny + j (column-major).
// The grid carries a 1-cell solid border: the tank walls. Particles are clamped
// inside it every substep, so water can never leave the tank and particles are
// never created or destroyed after init: volume (particle count) is exact.
//
// Pressure: warm-started geometric multigrid (sim/multigrid.js), a fixed number
// of V-cycles per step, plus Müller's density-based drift compensation, which
// counteracts the slow volume loss plain FLIP suffers from. (A 30-sweep SOR
// budget could not carry hydrostatic pressure through an 80-cell-deep pool:
// the residual error was re-injected every step by FLIP and the water boiled.)

import { PressureMG } from './multigrid.js';

export const FLUID = 0;
export const AIR = 1;
export const SOLID = 2;

export class FlipSim {
  constructor(opts) {
    const {
      worldWidth, // interior tank width  (m)
      worldHeight, // interior tank height (m)
      cellsX, // interior cells across
      fill = 0.45, // fraction of the tank filled at rest
      flipRatio = 0.95,
      pressureCycles = 3,
      separationIters = 2,
      density = 1000,
    } = opts;

    const h = worldWidth / cellsX;
    this.h = h;
    this.invH = 1 / h;
    this.nx = cellsX + 2;
    this.ny = Math.round(worldHeight / h) + 2;
    this.width = this.nx * h; // including walls
    this.height = this.ny * h;
    this.flipRatio = flipRatio;
    this.pressureCycles = pressureCycles;
    this.pressureTol = 0.02; // stop V-cycles once max|r| ≤ 2% of max|rhs|
    this.separationIters = separationIters;
    this.density = density;

    const n = this.nx * this.ny;
    this.numCells = n;
    this.u = new Float64Array(n);
    this.v = new Float64Array(n);
    this.du = new Float32Array(n);
    this.dv = new Float32Array(n);
    this.prevU = new Float64Array(n);
    this.prevV = new Float64Array(n);
    this.p = new Float64Array(n); // scaled pressure q, kept between steps (warm start)
    this.s = new Float32Array(n); // 1 = can hold fluid, 0 = solid
    this.cellType = new Int32Array(n);
    this.particleDensity = new Float32Array(n);
    this.restDensity = 0;

    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < this.ny; j++) {
        const wall = i === 0 || i === this.nx - 1 || j === 0 || j === this.ny - 1;
        this.s[i * this.ny + j] = wall ? 0 : 1;
      }
    }

    // Particles: hex-packed block filling the bottom `fill` of the tank.
    const r = 0.3 * h;
    this.r = r;
    const dx = 2 * r;
    const dy = (Math.sqrt(3) / 2) * dx;
    const interiorW = (this.nx - 2) * h;
    const interiorH = (this.ny - 2) * h;
    const cols = Math.floor((interiorW - 2 * r) / dx);
    const rows = Math.floor((interiorH * fill - 2 * r) / dy);
    const count = cols * rows;
    this.numParticles = count;
    this.pos = new Float32Array(2 * count);
    this.vel = new Float32Array(2 * count);
    let k = 0;
    const bottom = (this.ny - 1) * h - r;
    const left = h + r + 0.5 * (interiorW - 2 * r - (cols - 0.5) * dx);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        this.pos[2 * k] = left + dx * c + (row % 2 === 0 ? 0 : r);
        this.pos[2 * k + 1] = bottom - dy * row;
        k++;
      }
    }

    // Spatial hash for particle separation.
    this.pInvSpacing = 1 / (2.2 * r);
    this.pNumX = Math.floor(this.width * this.pInvSpacing) + 1;
    this.pNumY = Math.floor(this.height * this.pInvSpacing) + 1;
    const pc = this.pNumX * this.pNumY;
    this.numCellParticles = new Int32Array(pc);
    this.firstCellParticle = new Int32Array(pc + 1);
    this.cellParticleIds = new Int32Array(count);
    this._pos2 = new Float32Array(2 * count);
    this._vel2 = new Float32Array(2 * count);
    // Per-particle foam (0..1), permuted with the particles by the spatial sort.
    this.foam = new Float32Array(count);
    this._foam2 = new Float32Array(count);
    this.stepVel = new Float32Array(2 * count); // velocities at the start of a step
    this.foamTau = 0.9; // s, foam decay time constant
    this.impact = new Float32Array(count); // last step's relative impact accel (for bubbles)
    this.rhs = new Float64Array(n);
    this.smoothDensity = new Float32Array(n);
    this.stA = new Float32Array(n);
    this.stB = new Float32Array(n);
    this.ghost = new Float64Array(n);
    this.mg = new PressureMG(this.nx, this.ny);

    // Diagnostics (written each step, read by the host).
    this.fluidCells = 0;
    this.fillVolume = 0;
    this.maxSpeed = 0;
    this.substeps = 1;
    this.vmax = 1e9;
    this.vlim = 1e9;
    this.cflCells = opts.cflCells ?? 4; // cells a particle may cross per substep (6 was tried: noisier, −1.6% volume)
    this.maxSubsteps = opts.maxSubsteps ?? 3;
    this.fast1 = 0;
    this.fast2 = 0;
    this.driftK = 0.1;
    this.driftBand = 0.02;
    // Effective kinematic viscosity (m²/s). Far above water's 1e-6: in 2D the
    // thin wall boundary layers that damp real sloshing are unresolved, and an
    // inviscid 2D flow keeps its vortices forever. Clamped for explicit stability.
    this.viscosity = opts.viscosity ?? 2e-5;
    // Effective surface tension (N/m); see _surfaceTensionGhost for why it is below 0.072.
    this.surfaceTension = opts.surfaceTension ?? 0.003;
  }

  // One fixed step of length dt. Particle separation runs once per step; the
  // grid projection runs 1–3 times so the fastest water crosses ≤ 4 cells per
  // substep (wall clamping makes that CFL safe from leaks).
  // fx, fy: body acceleration on the water in the tank frame (gravity − tank
  // acceleration). omega / alpha: tank spin rate and its derivative (rad/s,
  // rad/s², + = clockwise on screen); they add Coriolis, centrifugal and Euler
  // forces about the tank centre.
  step(dt, fx, fy, omega = 0, alpha = 0) {
    const maxTravel = this.cflCells * this.h;
    // Substeps from how many particles are too fast, not the single fastest one:
    // a few outliers (spray, surface jitter) shouldn't double the cost of a calm
    // pool; they're covered by the hard speed cap and wall clamping.
    const allow = Math.max(4, this.numParticles * 0.002);
    const sub = this.fast1 <= allow ? 1 : this.fast2 <= allow || this.maxSubsteps < 3 ? 2 : 3;
    this.substeps = sub;
    this.vlim = maxTravel / dt; // max travel per step at 1 substep
    // Hard speed limit: 12 cells per step (≈1.2 m/s at 84 cells across).
    this.vmax = (12 * this.h) / dt;
    const sdt = dt / sub;
    this._pushApart(this.separationIters);
    this.stepVel.set(this.vel);
    for (let s = 0; s < sub; s++) {
      // Forces → grid → projection → back to particles → advect with the
      // divergence-free velocity. (Advecting with v+g·dt *before* projecting
      // compresses the pool by ~g·dt²/h cells each step: 0.8 cells here.)
      this._applyForces(sdt, fx, fy, omega, alpha);
      this._toGrid();
      this._updateDensity();
      this.prevU.set(this.u); // FLIP delta covers viscosity + pressure
      this.prevV.set(this.v);
      this._viscosity(sdt);
      this._solve(sdt);
      this._toParticles();
      this._advect(sdt);
      this._collide();
    }
    this._updateFoam(dt, fx, fy);
  }

  // Foam: whitewater appears where the liquid is violently decelerated
  // (impacts, crashing crests) and in fast spray, then decays. The impact
  // measure is the particle's actual acceleration |dv/dt|, thresholded above
  // the largest body force (|g − a_tank| ≤ ~40 m/s²): water resting or sloshing
  // under the body force alone stays clear, a sudden stop does not.
  _updateFoam(dt, fx, fy) {
    const { vel, stepVel, foam, impact, pos, particleDensity, ny, invH } = this;
    const decay = Math.exp(-dt / this.foamTau);
    const inv = 1 / dt, rest = this.restDensity;
    const bodyA = Math.sqrt(fx * fx + fy * fy);
    const thresh = Math.max(60, bodyA * 1.5);
    for (let i = 0, n = this.numParticles; i < n; i++) {
      const vx = vel[2 * i], vy = vel[2 * i + 1];
      const ax = (vx - stepVel[2 * i]) * inv;
      const ay = (vy - stepVel[2 * i + 1]) * inv;
      const a = Math.sqrt(ax * ax + ay * ay);
      impact[i] = a;
      let gen = (a - thresh) / 220;
      // Fast spray in sparse air cells turns white.
      const c = Math.floor(pos[2 * i] * invH) * ny + Math.floor(pos[2 * i + 1] * invH);
      if (rest > 0 && particleDensity[c] < 0.35 * rest && vx * vx + vy * vy > 0.09) gen = gen > 0.4 ? gen : 0.4;
      gen = gen < 0 ? 0 : gen > 1 ? 1 : gen;
      const f = foam[i] * decay;
      foam[i] = f > gen ? f : gen;
    }
  }

  // Bilinear grid velocity at (x, y) (m, m/s) into out[0..1].
  sampleVelocity(x, y, out) {
    const { nx, ny, h, invH, u, v } = this;
    const h2 = 0.5 * h;
    x = x < h ? h : x > (nx - 1) * h ? (nx - 1) * h : x;
    y = y < h ? h : y > (ny - 1) * h ? (ny - 1) * h : y;
    for (let comp = 0; comp < 2; comp++) {
      const offX = comp === 0 ? 0 : h2, offY = comp === 0 ? h2 : 0;
      const f = comp === 0 ? u : v;
      const x0 = Math.min(Math.floor((x - offX) * invH), nx - 2);
      const tx = (x - offX - x0 * h) * invH;
      const y0 = Math.min(Math.floor((y - offY) * invH), ny - 2);
      const ty = (y - offY - y0 * h) * invH;
      out[comp] = (1 - tx) * (1 - ty) * f[x0 * ny + y0] + tx * (1 - ty) * f[(x0 + 1) * ny + y0] +
        tx * ty * f[(x0 + 1) * ny + y0 + 1] + (1 - tx) * ty * f[x0 * ny + y0 + 1];
    }
  }

  // Tank-frame (non-inertial) forces. In stage coords (y down) a positive angle
  // rotates +x toward +y, i.e. clockwise on screen, so the usual 2D formulas
  // hold with ẑ×(x, y) = (−y, x):
  //   Coriolis     −2ω ẑ×v      (applied as an exact rotation of v: energy-neutral)
  //   centrifugal  +ω² r
  //   Euler        −α ẑ×r = α (r_y, −r_x)
  _applyForces(dt, fx, fy, omega, alpha) {
    const vel = this.vel, pos = this.pos;
    const n = this.numParticles;
    const dvx = fx * dt, dvy = fy * dt;
    if (omega === 0 && alpha === 0) {
      for (let i = 0; i < n; i++) {
        vel[2 * i] += dvx;
        vel[2 * i + 1] += dvy;
      }
      return;
    }
    const cx = 0.5 * this.width, cy = 0.5 * this.height;
    const w2 = omega * omega * dt, ad = alpha * dt;
    const th = -2 * omega * dt; // Coriolis rotates v at rate −2ω
    const cs = Math.cos(th), sn = Math.sin(th);
    for (let i = 0; i < n; i++) {
      const rx = pos[2 * i] - cx, ry = pos[2 * i + 1] - cy;
      const vx = vel[2 * i], vy = vel[2 * i + 1];
      vel[2 * i] = cs * vx - sn * vy + dvx + w2 * rx + ad * ry;
      vel[2 * i + 1] = sn * vx + cs * vy + dvy + w2 * ry - ad * rx;
    }
  }

  _advect(dt) {
    const pos = this.pos, vel = this.vel;
    for (let i = 0, n = 2 * this.numParticles; i < n; i++) pos[i] += vel[i] * dt;
  }

  // Counting-sorts particles by separation-hash cell (pos/vel are permuted in
  // place via ping-pong buffers), so each cell's particles are contiguous and
  // neighbour loops stream through memory. Then pushes overlapping pairs apart.
  _pushApart(iters) {
    const np = this.numParticles;
    const pNumX = this.pNumX, pNumY = this.pNumY, inv = this.pInvSpacing;
    const counts = this.numCellParticles, first = this.firstCellParticle, cellOf = this.cellParticleIds;
    let pos = this.pos, vel = this.vel;
    counts.fill(0);
    for (let i = 0; i < np; i++) {
      let xi = Math.floor(pos[2 * i] * inv), yi = Math.floor(pos[2 * i + 1] * inv);
      xi = xi < 0 ? 0 : xi >= pNumX ? pNumX - 1 : xi;
      yi = yi < 0 ? 0 : yi >= pNumY ? pNumY - 1 : yi;
      const c = xi * pNumY + yi;
      cellOf[i] = c;
      counts[c]++;
    }
    const nc = pNumX * pNumY;
    let acc = 0;
    for (let c = 0; c < nc; c++) { first[c] = acc; acc += counts[c]; }
    first[nc] = acc;
    // Scatter into the spare buffers, then swap.
    const npos = this._pos2, nvel = this._vel2, nfoam = this._foam2, foam = this.foam;
    for (let c = 0; c < nc; c++) counts[c] = first[c];
    for (let i = 0; i < np; i++) {
      const k = counts[cellOf[i]]++;
      npos[2 * k] = pos[2 * i]; npos[2 * k + 1] = pos[2 * i + 1];
      nvel[2 * k] = vel[2 * i]; nvel[2 * k + 1] = vel[2 * i + 1];
      nfoam[k] = foam[i];
    }
    this._pos2 = pos; this._vel2 = vel; this._foam2 = foam;
    this.pos = pos = npos; this.vel = vel = nvel; this.foam = nfoam;

    // Each pair is visited once: the rest of this cell + the next cell in the
    // same column, and the three cells of the next column (all contiguous
    // ranges in the sorted order). Both particles move half the overlap.
    const minDist = 2 * this.r, minDist2 = minDist * minDist;
    for (let it = 0; it < iters; it++) {
      for (let cx = 0; cx < pNumX; cx++) {
        const nextCol = cx + 1 < pNumX;
        for (let cy = 0; cy < pNumY; cy++) {
          const c = cx * pNumY + cy;
          const b = first[c], e = first[c + 1];
          if (b === e) continue;
          const sameEnd = first[cy + 1 < pNumY ? c + 2 : c + 1];
          let nb = 0, ne = 0;
          if (nextCol) {
            const col = (cx + 1) * pNumY;
            nb = first[col + (cy > 0 ? cy - 1 : 0)];
            ne = first[col + (cy + 1 < pNumY ? cy + 2 : cy + 1)];
          }
          for (let i = b; i < e; i++) {
            let px = pos[2 * i], py = pos[2 * i + 1];
            for (let pass = 0; pass < 2; pass++) {
              const kb = pass === 0 ? i + 1 : nb, ke = pass === 0 ? sameEnd : ne;
              for (let k = kb; k < ke; k++) {
                let dx = pos[2 * k] - px;
                let dy = pos[2 * k + 1] - py;
                const d2 = dx * dx + dy * dy;
                if (d2 > minDist2 || d2 === 0) continue;
                const d = Math.sqrt(d2);
                const s = (0.5 * (minDist - d)) / d;
                dx *= s; dy *= s;
                px -= dx; py -= dy;
                pos[2 * k] += dx; pos[2 * k + 1] += dy;
              }
            }
            pos[2 * i] = px; pos[2 * i + 1] = py;
          }
        }
      }
    }
  }

  // Tank walls: clamp inside the solid border and kill the normal velocity
  // (free-slip). This is the hard guarantee that no water leaks.
  _collide() {
    const pos = this.pos, vel = this.vel, h = this.h, r = this.r;
    const minX = h + r, maxX = (this.nx - 1) * h - r;
    const minY = h + r, maxY = (this.ny - 1) * h - r;
    for (let i = 0, n = this.numParticles; i < n; i++) {
      let x = pos[2 * i], y = pos[2 * i + 1];
      if (!(x >= minX)) { x = minX; if (vel[2 * i] < 0 || vel[2 * i] !== vel[2 * i]) vel[2 * i] = 0; }
      if (x > maxX) { x = maxX; if (vel[2 * i] > 0) vel[2 * i] = 0; }
      if (!(y >= minY)) { y = minY; if (vel[2 * i + 1] < 0 || vel[2 * i + 1] !== vel[2 * i + 1]) vel[2 * i + 1] = 0; }
      if (y > maxY) { y = maxY; if (vel[2 * i + 1] > 0) vel[2 * i + 1] = 0; }
      pos[2 * i] = x; pos[2 * i + 1] = y;
    }
  }

  _toGrid() {
    const { nx, ny, h, invH, pos, vel, u, v, du, dv, cellType, s } = this;
    const np = this.numParticles;
    u.fill(0); v.fill(0); du.fill(0); dv.fill(0);
    for (let c = 0; c < this.numCells; c++) cellType[c] = s[c] === 0 ? SOLID : AIR;

    // One pass per particle: mark its cell FLUID and splat both velocity
    // components (u lives at (i, j+½), v at (i+½, j) in cell units).
    const xmax = nx - 1, ymax = ny - 1;
    for (let i = 0; i < np; i++) {
      let fx = pos[2 * i] * invH, fy = pos[2 * i + 1] * invH;
      fx = fx < 1 ? 1 : fx > xmax ? xmax : fx;
      fy = fy < 1 ? 1 : fy > ymax ? ymax : fy;
      const ci = Math.min(Math.floor(fx), nx - 1), cj = Math.min(Math.floor(fy), ny - 1);
      const cc = ci * ny + cj;
      if (cellType[cc] === AIR) cellType[cc] = FLUID;
      const vx = vel[2 * i], vy = vel[2 * i + 1];
      // u: x at face, y at centre.
      {
        const x0 = Math.min(Math.floor(fx), nx - 2), tx = fx - x0, x1 = Math.min(x0 + 1, nx - 1);
        const gy = fy - 0.5;
        const y0 = Math.min(Math.floor(gy), ny - 2), ty = gy - y0, y1 = Math.min(y0 + 1, ny - 1);
        const sx = 1 - tx, sy = 1 - ty;
        const d0 = sx * sy, d1 = tx * sy, d2 = tx * ty, d3 = sx * ty;
        const n0 = x0 * ny + y0, n1 = x1 * ny + y0, n2 = x1 * ny + y1, n3 = x0 * ny + y1;
        u[n0] += vx * d0; du[n0] += d0;
        u[n1] += vx * d1; du[n1] += d1;
        u[n2] += vx * d2; du[n2] += d2;
        u[n3] += vx * d3; du[n3] += d3;
      }
      // v: x at centre, y at face.
      {
        const gx = fx - 0.5;
        const x0 = Math.min(Math.floor(gx), nx - 2), tx = gx - x0, x1 = Math.min(x0 + 1, nx - 1);
        const y0 = Math.min(Math.floor(fy), ny - 2), ty = fy - y0, y1 = Math.min(y0 + 1, ny - 1);
        const sx = 1 - tx, sy = 1 - ty;
        const d0 = sx * sy, d1 = tx * sy, d2 = tx * ty, d3 = sx * ty;
        const n0 = x0 * ny + y0, n1 = x1 * ny + y0, n2 = x1 * ny + y1, n3 = x0 * ny + y1;
        v[n0] += vy * d0; dv[n0] += d0;
        v[n1] += vy * d1; dv[n1] += d1;
        v[n2] += vy * d2; dv[n2] += d2;
        v[n3] += vy * d3; dv[n3] += d3;
      }
    }
    for (let c = 0; c < this.numCells; c++) {
      if (du[c] > 0) u[c] /= du[c];
      if (dv[c] > 0) v[c] /= dv[c];
    }

    // Faces touching a solid cell keep zero normal velocity (walls are static in the tank frame).
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = i * ny + j;
        const solid = cellType[c] === SOLID;
        if (solid || (i > 0 && cellType[c - ny] === SOLID)) u[c] = 0;
        if (solid || (j > 0 && cellType[c - 1] === SOLID)) v[c] = 0;
      }
    }
  }

  _updateDensity() {
    const { nx, ny, h, invH, pos } = this;
    const d = this.particleDensity;
    d.fill(0);
    const h2 = 0.5 * h;
    for (let i = 0, np = this.numParticles; i < np; i++) {
      let x = pos[2 * i], y = pos[2 * i + 1];
      x = x < h ? h : x > (nx - 1) * h ? (nx - 1) * h : x;
      y = y < h ? h : y > (ny - 1) * h ? (ny - 1) * h : y;
      const x0 = Math.floor((x - h2) * invH);
      const tx = (x - h2 - x0 * h) * invH;
      const x1 = Math.min(x0 + 1, nx - 1);
      const y0 = Math.floor((y - h2) * invH);
      const ty = (y - h2 - y0 * h) * invH;
      const y1 = Math.min(y0 + 1, ny - 1);
      const sx = 1 - tx, sy = 1 - ty;
      if (x0 < nx && y0 < ny) d[x0 * ny + y0] += sx * sy;
      if (x1 < nx && y0 < ny) d[x1 * ny + y0] += tx * sy;
      if (x1 < nx && y1 < ny) d[x1 * ny + y1] += tx * ty;
      if (x0 < nx && y1 < ny) d[x0 * ny + y1] += sx * ty;
    }
    if (this.restDensity === 0) {
      // Rest density from interior cells only: surface/wall cells see fewer
      // particles and would bias it low, making the bulk look compressed forever.
      const ct = this.cellType;
      let sum = 0, cnt = 0;
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < ny - 1; j++) {
          const c = i * ny + j;
          if (ct[c] === FLUID && ct[c - ny] === FLUID && ct[c + ny] === FLUID &&
              ct[c - 1] === FLUID && ct[c + 1] === FLUID) { sum += d[c]; cnt++; }
        }
      }
      if (cnt > 0) this.restDensity = sum / cnt;
    }
  }

  // Explicit viscosity on fluid faces (one diffusion step). Neighbour faces that
  // touch a wall hold 0 (no-slip drag); faces in air are skipped (free surface).
  _viscosity(dt) {
    let k = (this.viscosity * dt) / (this.h * this.h);
    if (k <= 0) return;
    if (k > 0.2) k = 0.2;
    const { nx, ny, cellType } = this;
    for (let comp = 0; comp < 2; comp++) {
      const f = comp === 0 ? this.u : this.v;
      const tmp = comp === 0 ? this.du : this.dv; // weights no longer needed after P2G
      const off = comp === 0 ? ny : 1; // neighbour cell across this face
      tmp.set(f);
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < ny - 1; j++) {
          const c = i * ny + j;
          const ta = cellType[c], tb = cellType[c - off];
          if (ta === SOLID || tb === SOLID || (ta !== FLUID && tb !== FLUID)) continue;
          const fc = f[c];
          let lap = 0;
          for (let nb = 0; nb < 4; nb++) {
            const n = nb === 0 ? c - ny : nb === 1 ? c + ny : nb === 2 ? c - 1 : c + 1;
            const na = cellType[n], nbT = cellType[n - off];
            if (na === SOLID || nbT === SOLID) lap -= fc; // wall: value 0
            else if (na === FLUID || nbT === FLUID) lap += f[n] - fc;
          }
          tmp[c] = fc + k * lap;
        }
      }
      f.set(tmp);
    }
  }

  // Pressure projection. Solves  Σ_n (q_c − q_n) = −div_c  over fluid cells
  // (air neighbours q = 0, solid neighbours excluded) for the scaled pressure
  // q = p·dt/(ρh), with SOR warm-started from the previous step's q. The warm
  // start is what lets a deep column reach hydrostatic balance with a small,
  // fixed iteration budget. Then u −= ∇q on every face between non-solid cells.
  _solve(dt) {
    const { nx, ny, u, v, s, cellType, particleDensity } = this;
    const q = this.p;
    const rest = this.restDensity;
    // Drift compensation is a velocity: remove a fraction of the excess density
    // per step, so it scales with h/dt.
    const kDrift = this.driftK * this.h / dt;
    const rhs = this.rhs;
    const dens = this.smoothDensity;
    if (rest > 0) {
      // 3×3 box-filtered density: per-cell particle counts are too noisy to
      // correct with a tight tolerance, the neighbourhood average is not.
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < ny - 1; j++) {
          const c = i * ny + j;
          if (cellType[c] !== FLUID) continue;
          let sum = 0, cnt = 0;
          for (let di = -ny; di <= ny; di += ny) {
            for (let dj = -1; dj <= 1; dj++) {
              const k = c + di + dj;
              if (cellType[k] === FLUID) { sum += particleDensity[k]; cnt++; }
            }
          }
          dens[c] = sum / cnt;
        }
      }
    }
    let fluid = 0, fill = 0;
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < ny - 1; j++) {
        const c = i * ny + j;
        if (cellType[c] !== FLUID) { q[c] = 0; continue; }
        let div = u[c + ny] - u[c] + v[c + 1] - v[c];
        if (rest > 0) {
          // Dead-band: only correct real compression, not sampling noise.
          const compression = dens[c] - rest * (1 + this.driftBand);
          if (compression > 0) div -= kDrift * compression;
        }
        rhs[c] = -div;
        fluid++;
        const fr = particleDensity[c] / rest;
        fill += fr < 1 ? fr : 1;
      }
    }
    const st = this.surfaceTension > 0 && rest > 0;
    if (st) this._surfaceTensionGhost(dt);
    this.mg.solve(cellType, rhs, q, this.pressureCycles, this.pressureTol);
    // Air cells bordering fluid carry the Laplace pressure jump σκ (ghost fluid).
    if (st) {
      const ghost = this.ghost;
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < ny - 1; j++) {
          const c = i * ny + j;
          if (cellType[c] === AIR) q[c] = ghost[c];
        }
      }
    }
    // Apply the pressure gradient on faces between two non-solid cells.
    for (let i = 1; i < nx; i++) {
      for (let j = 1; j < ny; j++) {
        const c = i * ny + j;
        if (s[c] === 0) continue;
        if (s[c - ny] !== 0 && (cellType[c] === FLUID || cellType[c - ny] === FLUID)) u[c] -= q[c] - q[c - ny];
        if (s[c - 1] !== 0 && (cellType[c] === FLUID || cellType[c - 1] === FLUID)) v[c] -= q[c] - q[c - 1];
      }
    }
    this.fluidCells = fluid;
    // Grid fill in cell units: Σ min(ρ/ρ0, 1). Unlike a raw fluid-cell count it
    // does not over-count sparse surface/spray cells.
    this.fillVolume = rest > 0 ? fill : fluid;
  }

  // Surface tension via the ghost-fluid method: air cells next to the liquid get
  // Dirichlet pressure σκ instead of 0, and the fluid cells' rhs absorbs it.
  // κ comes from a blurred liquid-fraction field F = min(ρ/ρ0, 1):
  // n = −∇F/|∇F|, κ = ∇·n (positive for a convex blob). Walls copy the
  // neighbouring F (90° contact angle). Explicit surface tension is only stable
  // for dt < sqrt(ρh³/2πσ) ≈ 1 ms at real σ = 0.072 N/m on this grid, so σ is a
  // weaker effective value and κ is clamped to |κ| ≤ 1/h.
  _surfaceTensionGhost(dt) {
    const { nx, ny, cellType, particleDensity } = this;
    const F = this.stA, T = this.stB, nX = this.du, nY = this.dv, ghost = this.ghost, rhs = this.rhs;
    const inv = 1 / this.restDensity;
    const n = this.numCells;
    for (let c = 0; c < n; c++) {
      const f = particleDensity[c] * inv;
      F[c] = f < 1 ? f : 1;
    }
    for (let pass = 0; pass < 2; pass++) {
      this._copyWalls(F);
      // Separable [1 2 1]/4 blur: x into T, then y back into F.
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < ny - 1; j++) {
          const c = i * ny + j;
          T[c] = 0.25 * (F[c - ny] + 2 * F[c] + F[c + ny]);
        }
      }
      this._copyWalls(T);
      for (let i = 1; i < nx - 1; i++) {
        for (let j = 1; j < ny - 1; j++) {
          const c = i * ny + j;
          F[c] = 0.25 * (T[c - 1] + 2 * T[c] + T[c + 1]);
        }
      }
    }
    this._copyWalls(F);
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < ny - 1; j++) {
        const c = i * ny + j;
        const gx = F[c + ny] - F[c - ny], gy = F[c + 1] - F[c - 1];
        const g = Math.sqrt(gx * gx + gy * gy);
        if (g > 1e-3) { nX[c] = -gx / g; nY[c] = -gy / g; } else { nX[c] = 0; nY[c] = 0; }
      }
    }
    this._copyWalls(nX);
    this._copyWalls(nY);
    const scale = (this.surfaceTension * dt) / (this.density * this.h * this.h);
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < ny - 1; j++) {
        const c = i * ny + j;
        ghost[c] = 0;
        if (cellType[c] !== AIR) continue;
        let k = 0.5 * (nX[c + ny] - nX[c - ny] + nY[c + 1] - nY[c - 1]); // 1/h units
        k = k > 1 ? 1 : k < -1 ? -1 : k;
        ghost[c] = scale * k;
      }
    }
    // Move the known ghost values to the right-hand side of adjacent fluid cells.
    for (let i = 1; i < nx - 1; i++) {
      for (let j = 1; j < ny - 1; j++) {
        const c = i * ny + j;
        if (cellType[c] !== FLUID) continue;
        let add = 0;
        if (cellType[c - ny] === AIR) add += ghost[c - ny];
        if (cellType[c + ny] === AIR) add += ghost[c + ny];
        if (cellType[c - 1] === AIR) add += ghost[c - 1];
        if (cellType[c + 1] === AIR) add += ghost[c + 1];
        rhs[c] += add;
      }
    }
  }

  // Border cells take the value of their inward neighbour (zero normal gradient).
  _copyWalls(A) {
    const { nx, ny } = this;
    for (let j = 0; j < ny; j++) { A[j] = A[ny + j]; A[(nx - 1) * ny + j] = A[(nx - 2) * ny + j]; }
    for (let i = 0; i < nx; i++) { A[i * ny] = A[i * ny + 1]; A[i * ny + ny - 1] = A[i * ny + ny - 2]; }
  }

  _toParticles() {
    const { nx, ny, h, invH, pos, vel, u, v, prevU, prevV, cellType } = this;
    const np = this.numParticles;
    const flip = this.flipRatio;
    const h2 = 0.5 * h;
    for (let comp = 0; comp < 2; comp++) {
      const offX = comp === 0 ? 0 : h2, offY = comp === 0 ? h2 : 0;
      const f = comp === 0 ? u : v, pf = comp === 0 ? prevU : prevV;
      const off = comp === 0 ? ny : 1;
      for (let i = 0; i < np; i++) {
        let x = pos[2 * i], y = pos[2 * i + 1];
        x = x < h ? h : x > (nx - 1) * h ? (nx - 1) * h : x;
        y = y < h ? h : y > (ny - 1) * h ? (ny - 1) * h : y;
        const x0 = Math.min(Math.floor((x - offX) * invH), nx - 2);
        const tx = (x - offX - x0 * h) * invH;
        const x1 = Math.min(x0 + 1, nx - 1);
        const y0 = Math.min(Math.floor((y - offY) * invH), ny - 2);
        const ty = (y - offY - y0 * h) * invH;
        const y1 = Math.min(y0 + 1, ny - 1);
        const sx = 1 - tx, sy = 1 - ty;
        const d0 = sx * sy, d1 = tx * sy, d2 = tx * ty, d3 = sx * ty;
        const n0 = x0 * ny + y0, n1 = x1 * ny + y0, n2 = x1 * ny + y1, n3 = x0 * ny + y1;
        // A face is valid if either adjacent cell is not air.
        const v0 = cellType[n0] !== AIR || cellType[n0 - off] !== AIR ? 1 : 0;
        const v1 = cellType[n1] !== AIR || cellType[n1 - off] !== AIR ? 1 : 0;
        const v2 = cellType[n2] !== AIR || cellType[n2 - off] !== AIR ? 1 : 0;
        const v3 = cellType[n3] !== AIR || cellType[n3 - off] !== AIR ? 1 : 0;
        const w = v0 * d0 + v1 * d1 + v2 * d2 + v3 * d3;
        if (w > 0) {
          const pic = (v0 * d0 * f[n0] + v1 * d1 * f[n1] + v2 * d2 * f[n2] + v3 * d3 * f[n3]) / w;
          const corr = (v0 * d0 * (f[n0] - pf[n0]) + v1 * d1 * (f[n1] - pf[n1]) +
            v2 * d2 * (f[n2] - pf[n2]) + v3 * d3 * (f[n3] - pf[n3])) / w;
          const fl = vel[2 * i + comp] + corr;
          vel[2 * i + comp] = (1 - flip) * pic + flip * fl;
        }
      }
    }
    // Speed limit (CFL safety at the substep cap) + max speed for next step's substep count.
    const vmax = this.vmax;
    const vmax2 = vmax * vmax;
    const l1 = this.vlim * this.vlim, l2 = 4 * l1;
    let m2 = 0, f1 = 0, f2 = 0;
    for (let i = 0; i < np; i++) {
      const vx = vel[2 * i], vy = vel[2 * i + 1];
      let s2 = vx * vx + vy * vy;
      if (s2 > vmax2) {
        const k = vmax / Math.sqrt(s2);
        vel[2 * i] = vx * k; vel[2 * i + 1] = vy * k;
        s2 = vmax2;
      }
      if (s2 > m2) m2 = s2;
      if (s2 > l1) { f1++; if (s2 > l2) f2++; }
    }
    this.maxSpeed = Math.sqrt(m2);
    this.fast1 = f1;
    this.fast2 = f2;
  }

  // Rebuild the simulation at a different resolution without losing the water
  // (quality-level changes). The new sim is constructed with the same fill, so
  // its particle count matches the conserved water volume at the new spacing;
  // its particles are then resampled from the old ones (position mapped through
  // the tank interior, velocity and foam copied, sub-spacing jitter to break
  // duplicates; separation resolves overlaps within a few steps).
  static resampleFrom(old, opts) {
    const sim = new FlipSim(opts);
    const No = old.numParticles, Nn = sim.numParticles;
    const oiw = (old.nx - 2) * old.h, oih = (old.ny - 2) * old.h;
    const niw = (sim.nx - 2) * sim.h, nih = (sim.ny - 2) * sim.h;
    const r = sim.r;
    let seed = 987654321;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) - 0.5; };
    for (let k = 0; k < Nn; k++) {
      const i = Math.min(No - 1, Math.floor((k * No) / Nn));
      const up = Nn > No; // upsampling duplicates particles: jitter them apart
      sim.pos[2 * k] = sim.h + ((old.pos[2 * i] - old.h) / oiw) * niw + (up ? rnd() * 2 * r : 0);
      sim.pos[2 * k + 1] = sim.h + ((old.pos[2 * i + 1] - old.h) / oih) * nih + (up ? rnd() * 2 * r : 0);
      sim.vel[2 * k] = old.vel[2 * i];
      sim.vel[2 * k + 1] = old.vel[2 * i + 1];
      sim.foam[k] = old.foam[i];
    }
    sim._collide();
    // Rest density of the hex packing (spacing 2r × √3r, r = 0.3h): particles per
    // cell, the value the first step would measure on a fresh, undisturbed pool.
    sim.restDensity = (sim.h * sim.h) / (2 * r * Math.sqrt(3) * r);
    sim.maxSpeed = old.maxSpeed;
    return sim;
  }
}
