// Automatic quality levels (Low / Med / High / Ultra).
//
// Each level sets the simulation grid (particle count scales with cells²),
// the render resolution (fraction of devicePixelRatio) and the blur passes.
// The controller watches two loads, each averaged over 2 s windows:
//   • frame time vs. the display period (GPU + main thread), and
//   • the sim's real-time ratio: simulated seconds delivered per wall second
//     (< 1 means the worker can't keep its fixed 120 Hz clock).
// Hysteresis: downgrade after a window of overload; upgrade only after 8 s of
// clear headroom; 5 s cooldown after any change. A level that failed is not
// retried for 60 s, doubling each further failure (120, 240 … s), and never
// again after 3 failures, so a borderline device can't hitch every minute.
// Thermal guard: once a level has run for 30 s its frame time is the
// baseline; if the ~20 s average drifts 15 % above it (throttling creeping in
// below the overload threshold), drop a level and cap the ceiling for 5 min.
// No allocation per frame: all state is numeric fields.

export const LEVELS = [
  // Ultra: 104 cells (≈33k particles). It was noisy at rest until the sim's
  // FLIP ratio / drift band were made resolution-dependent (PROGRESS.md).
  { name: 'Low', cells: 48, renderScale: 0.5, blurPasses: 1, depthPasses: 2 },
  { name: 'Med', cells: 64, renderScale: 0.7, blurPasses: 2, depthPasses: 2 },
  { name: 'High', cells: 84, renderScale: 0.85, blurPasses: 2, depthPasses: 3 },
  { name: 'Ultra', cells: 104, renderScale: 1.0, blurPasses: 3, depthPasses: 3 },
];

const WINDOW = 2.0; // s
const UP_HOLD = 8.0; // s of headroom before upgrading
const COOLDOWN = 5.0; // s after any change
const FALLBACK_MEMORY = 60.0; // s, first back-off (doubles per failure)
const MAX_FAILS = 3;
const THERMAL_BASELINE_AT = 30.0; // s at a level before the baseline is taken
const THERMAL_LOCK = 300.0; // s

export class QualityController {
  constructor(apply, { initial = 2, auto = true } = {}) {
    this.apply = apply; // (levelIndex, reason) => void
    this.level = initial;
    this.auto = auto;
    this.maxLevel = LEVELS.length - 1;
    this.period = 1 / 60; // display period estimate (s)
    this._periodMin = 1;
    this._periodSamples = 0;
    // window accumulators
    this._wT = 0; this._wFrames = 0; this._wSim0 = -1; this._wSimT = 0;
    this.frameAvg = 0; this.simRatio = 1;
    this._headroom = 0; this._sinceChange = 0; this._atLevel = 0;
    this._fails = new Int32Array(LEVELS.length); // overload failures per level
    this._retryAt = new Float64Array(LEVELS.length); // clock time a level may be retried
    this._baseline = 0; this._longAvg = 0; this._capUntil = 0; this._clock = 0;
    this.changes = 0;
    this.lastReason = 'initial';
    this.powerCap = LEVELS.length - 1; // lowered on low battery
  }

  // Battery saver: cap the level (e.g. Med when < 20 % and not charging).
  setPowerCap(level, reason = 'low battery') {
    this.powerCap = level;
    if (this.auto && this.level > level) this._set(level, reason);
  }

  // Called once per rendered frame. dt: frame time (s); simTime: worker's
  // cumulative simulated time (s) or -1 if unknown.
  update(dt, simTime) {
    // Real pauses (hidden tab) are handled by the visibility pause; a multi-second
    // stall is ignored, but slow frames (even 0.5–2 s on a very weak GPU) are
    // exactly what this controller must see, so they are clamped, not dropped.
    if (!(dt > 0) || dt > 2) return;
    if (dt > 1) dt = 1;
    this._clock += dt;
    this._sinceChange += dt;
    this._atLevel += dt;
    // Display period: the fastest sustained frame interval seen (60/90/120 Hz).
    if (this._periodSamples < 240) {
      this._periodSamples++;
      if (dt < this._periodMin) this._periodMin = dt;
      if (this._periodSamples === 240) this.period = Math.max(1 / 144, Math.min(1 / 50, this._periodMin * 1.02));
    }
    this._wT += dt;
    this._wFrames++;
    if (simTime >= 0) {
      if (this._wSim0 < 0) this._wSim0 = simTime;
      this._wSimT = simTime;
    }
    if (this._wT < WINDOW) return;

    // Close the window.
    this.frameAvg = this._wT / this._wFrames;
    this.simRatio = this._wSim0 >= 0 ? (this._wSimT - this._wSim0) / this._wT : 1;
    this._wT = 0; this._wFrames = 0; this._wSim0 = -1;
    if (!this.auto) return;

    // Thermal guard.
    this._longAvg = this._longAvg ? this._longAvg * 0.9 + this.frameAvg * 0.1 : this.frameAvg;
    if (!this._baseline && this._atLevel >= THERMAL_BASELINE_AT) this._baseline = this._longAvg;
    if (this._capUntil && this._clock > this._capUntil) { this._capUntil = 0; this.maxLevel = LEVELS.length - 1; }

    const overloaded = this.frameAvg > this.period * 1.25 || this.simRatio < 0.9;
    const roomy = this.frameAvg < this.period * 1.08 && this.simRatio > 0.98;
    if (this._sinceChange < COOLDOWN) { this._headroom = 0; return; }

    if (this._baseline && this._longAvg > this._baseline * 1.15 && this.level > 0) {
      this.maxLevel = this.level - 1;
      this._capUntil = this._clock + THERMAL_LOCK;
      this._set(this.level - 1, 'thermal: frame time drifted +15%');
      return;
    }
    if (overloaded && this.level > 0) {
      const f = ++this._fails[this.level];
      this._retryAt[this.level] = f >= MAX_FAILS ? Infinity : this._clock + FALLBACK_MEMORY * 2 ** (f - 1);
      this._set(this.level - 1, `overload: frame ${(this.frameAvg * 1000).toFixed(1)} ms, sim ×${this.simRatio.toFixed(2)}`);
      return;
    }
    this._headroom = roomy ? this._headroom + WINDOW : 0;
    const target = this.level + 1;
    if (this._headroom >= UP_HOLD && target <= Math.min(this.maxLevel, this.powerCap) &&
        this._clock >= this._retryAt[target]) {
      this._set(target, 'headroom');
    }
  }

  force(level) {
    this.auto = false;
    this._set(level, 'forced');
  }

  _set(level, reason) {
    level = Math.max(0, Math.min(LEVELS.length - 1, level));
    if (level === this.level && reason !== 'forced') return;
    this.level = level;
    this._sinceChange = 0;
    this._atLevel = 0;
    this._headroom = 0;
    this._baseline = 0;
    this.changes++;
    this.lastReason = reason;
    this.apply(level, reason);
  }

  get name() { return LEVELS[this.level].name; }
}
