// Fixed-timestep driver: physics runs at a constant rate independent of the
// display refresh (60 / 120 Hz), so the water behaves identically everywhere.

export class FixedStep {
  constructor(hz = 120, maxSteps = 4) {
    this.dt = 1 / hz;
    this.maxSteps = maxSteps;
    this.acc = 0;
    this.steps = 0; // total steps taken
    this.alpha = 0; // interpolation factor for rendering between steps
  }

  // Advances the accumulator by `frameDt` seconds and calls `step(dt)` a whole
  // number of times. Excess time beyond maxSteps is dropped (slow-motion rather
  // than a spiral of death on a slow device). Returns steps taken this frame.
  advance(frameDt, step) {
    this.acc += Math.min(frameDt, 0.1);
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      step(this.dt);
      this.acc -= this.dt;
      n++;
    }
    if (n === this.maxSteps && this.acc > this.dt) this.acc = 0;
    this.steps += n;
    this.alpha = this.acc / this.dt;
    return n;
  }

  reset() {
    this.acc = 0;
  }
}
