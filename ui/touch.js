// Touch gestures on the water: a quick single tap splashes, a quick two-finger
// tap resets (pour-in again). A tap is still (< 12 px) and short: < 350 ms, OR
// at most 3 rendered frames. Event timestamps are delivery times, so a janky
// main thread stretches a quick tap (measured 555–1188 ms for a 60 ms tap
// under software GL); counting frames keeps taps working under jank while a
// real long press on a smooth device is still rejected.
// Mouse clicks count as single taps on desktop (click-drag stays a shake, see
// input/motion.js); `R` resets. No allocation per event besides the browser's.

const TAP_MS = 350;
const TAP_FRAMES = 3;
const TAP_MOVE = 12;

export class TouchGestures {
  constructor(stageEl, stage, { onTap, onReset, frames }) {
    this.stage = stage;
    this.frames = frames; // () => rendered frame counter
    this.onTap = onTap;
    this.onReset = onReset;
    this.down = new Map(); // pointerId → [t, x, y]
    this.maxDown = 0;
    this.moved = false;
    this.t0 = 0;
    this.f0 = 0;
    this._p = [0, 0];
    stageEl.addEventListener('pointerdown', (e) => this._down(e));
    stageEl.addEventListener('pointermove', (e) => this._move(e));
    stageEl.addEventListener('pointerup', (e) => this._up(e));
    stageEl.addEventListener('pointercancel', (e) => { this.down.delete(e.pointerId); this.moved = true; });
    window.addEventListener('keydown', (e) => { if (e.key === 'r' || e.key === 'R') this.onReset(); });
  }

  _down(e) {
    if (this.down.size === 0) { this.maxDown = 0; this.moved = false; this.t0 = e.timeStamp; this.f0 = this.frames(); }
    this.down.set(e.pointerId, [e.timeStamp, e.clientX, e.clientY]);
    if (this.down.size > this.maxDown) this.maxDown = this.down.size;
  }

  _move(e) {
    const d = this.down.get(e.pointerId);
    if (d && Math.hypot(e.clientX - d[1], e.clientY - d[2]) > TAP_MOVE) this.moved = true;
  }

  _up(e) {
    const d = this.down.get(e.pointerId);
    if (!d) return;
    this.down.delete(e.pointerId);
    if (this.down.size > 0) return; // wait for the last finger
    const quick = e.timeStamp - this.t0 <= TAP_MS || this.frames() - this.f0 <= TAP_FRAMES;
    if (this.moved || !quick) return;
    if (this.maxDown >= 2) { this.onReset(); return; }
    const p = this.stage.toStage(e.clientX, e.clientY, this._p);
    this.onTap(p[0] / this.stage.width, p[1] / this.stage.height);
  }
}
