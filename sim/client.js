// Main-thread handle to the simulation worker. Keeps at most one step request
// in flight; frame time accumulates while the worker is busy and is sent with
// the next request (the worker's fixed-step clock caps catch-up).

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
    this.stats = null;
    this.free = []; // ArrayBuffers available to send
    this._msg = { type: 'step', dt: 0, gx: 0, gy: 0, ax: 0, ay: 0, spin: 0, buf: null };
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => console.error('sim worker error', e.message || e);
  }

  init(opts) {
    this.ready = false;
    this.opts = opts;
    this.worker.postMessage({ type: 'init', opts });
  }

  // Change grid resolution, keeping the current water (see FlipSim.resampleFrom).
  resample(cellsX) {
    if (!this.opts || this.opts.cellsX === cellsX) return;
    this.opts = { ...this.opts, cellsX };
    this.ready = false;
    this.worker.postMessage({ type: 'resample', opts: this.opts });
  }

  _onMessage(m) {
    if (m.type === 'ready') {
      this.count = m.count;
      this.radius = m.radius;
      this.cellsX = m.cellsX;
      this.cellsY = m.cellsY;
      this.maxBubbles = m.maxBubbles;
      const bytes = (m.count + m.maxBubbles) * 4 * 4;
      this.free.length = 0;
      this.free.push(new ArrayBuffer(bytes), new ArrayBuffer(bytes));
      this.ready = true;
      this.busy = false;
      return;
    }
    if (m.type === 'frame') {
      this.busy = false;
      this.stats = m;
      if (m.buf.byteLength === (this.count + this.maxBubbles) * 16) {
        this.onFrame(new Float32Array(m.buf), m.count, m.bubbles);
        this.free.push(m.buf);
      }
    }
  }

  // Called every rendered frame.
  update(dt, motion) {
    if (!this.ready) return;
    this.pendingDt += dt;
    if (this.busy || this.free.length === 0) return;
    const msg = this._msg;
    msg.dt = this.pendingDt;
    msg.gx = motion.gx; msg.gy = motion.gy;
    msg.ax = motion.ax; msg.ay = motion.ay; msg.spin = motion.spin;
    msg.buf = this.free.pop();
    this.pendingDt = 0;
    this.busy = true;
    this.worker.postMessage(msg, [msg.buf]);
    msg.buf = null;
  }
}
