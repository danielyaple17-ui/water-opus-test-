// Main-thread handle to the simulation worker. Keeps at most one step request
// in flight; frame time accumulates while the worker is busy and is sent with
// the next request (the worker's fixed-step clock caps catch-up). Requests and
// frames are bare transferred ArrayBuffers; inputs and stats travel in the
// buffer header (sim/layout.js), parsed into the preallocated `stats` object.

import * as LY from './layout.js';

export class SimClient {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.ready = false;
    this.busy = false;
    this.pendingDt = 0;
    this.count = 0;
    this.radius = 0;
    this.cellsX = 0;
    this.cellsY = 0;
    this.maxBubbles = 0;
    this.stats = null; // set on the first frame
    this._stats = {
      count: 0, bubbles: 0, simTime: 0, stepMs: 0, stepMsMax: 0, substeps: 1, fluidCells: 0, fillVolume: 0,
      outside: 0, comX: 0.5, comY: 0.5, angMom: 0, activity: 0, foamSum: 0, maxSpeed: 0, pourRemaining: 0, steps: 0,
    };
    this.gen = -1;
    this.free = []; // ArrayBuffers available to send
    this._xfer = [null];
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => console.error('sim worker error', e.message || e);
  }

  init(opts) {
    this.ready = false;
    this.opts = opts;
    this.worker.postMessage({ type: 'init', opts });
  }

  // Tap splash at tank-normalised coordinates.
  impulse(x, y) {
    if (this.ready) this.worker.postMessage({ type: 'impulse', x, y });
  }

  // Change grid resolution, keeping the current water (see FlipSim.resampleFrom).
  resample(cellsX) {
    if (!this.opts || this.opts.cellsX === cellsX) return;
    this.opts = { ...this.opts, cellsX };
    this.ready = false;
    this.worker.postMessage({ type: 'resample', opts: this.opts });
  }

  _onMessage(m) {
    if (m instanceof ArrayBuffer) { this._onFrame(m); return; }
    if (m.type === 'ready') {
      this.gen = m.gen;
      this.count = m.count;
      this.radius = m.radius;
      this.cellsX = m.cellsX;
      this.cellsY = m.cellsY;
      this.maxBubbles = m.maxBubbles;
      const bytes = LY.bufferFloats(m.count, m.maxBubbles) * 4;
      this.free.length = 0;
      this.free.push(new ArrayBuffer(bytes), new ArrayBuffer(bytes));
      this.ready = true;
      this.busy = false;
      return;
    }
  }

  _onFrame(buf) {
    this.busy = false;
    const io = new Float32Array(buf); // (a view per frame is unavoidable: transfers detach)
    if (io.length !== LY.bufferFloats(this.count, this.maxBubbles) || io[LY.S_GEN] !== this.gen) return; // stale
    const s = this._stats;
    s.count = io[LY.S_COUNT]; s.bubbles = io[LY.S_BUBBLES]; s.simTime = io[LY.S_SIMTIME];
    s.stepMs = io[LY.S_STEPMS]; s.stepMsMax = io[LY.S_STEPMSMAX]; s.substeps = io[LY.S_SUBSTEPS];
    s.fluidCells = io[LY.S_FLUID]; s.fillVolume = io[LY.S_FILL]; s.outside = io[LY.S_OUTSIDE];
    s.comX = io[LY.S_COMX]; s.comY = io[LY.S_COMY]; s.angMom = io[LY.S_ANGMOM]; s.activity = io[LY.S_ACTIVITY];
    s.foamSum = io[LY.S_FOAMSUM]; s.maxSpeed = io[LY.S_MAXSPEED]; s.pourRemaining = io[LY.S_POUR]; s.steps = io[LY.S_STEPS];
    this.stats = s;
    this.onFrame(io, s.count, s.bubbles);
    this.free.push(buf);
  }

  // Called every rendered frame.
  update(dt, motion) {
    if (!this.ready) return;
    this.pendingDt += dt;
    if (this.busy || this.free.length === 0) return;
    const buf = this.free.pop();
    const io = new Float32Array(buf, 0, LY.HEADER);
    io[LY.I_DT] = this.pendingDt;
    io[LY.I_GX] = motion.gx; io[LY.I_GY] = motion.gy;
    io[LY.I_AX] = motion.ax; io[LY.I_AY] = motion.ay; io[LY.I_SPIN] = motion.spin;
    this.pendingDt = 0;
    this.busy = true;
    this._xfer[0] = buf;
    this.worker.postMessage(buf, this._xfer);
    this._xfer[0] = null;
  }
}
