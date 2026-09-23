// Rolling frame statistics in a preallocated ring buffer (no per-frame allocation).

const N = 120;

export class Stats {
  constructor() {
    this.frames = new Float32Array(N);
    this.cpu = new Float32Array(N);
    this.i = 0;
    this.count = 0;
    this.fps = 0;
    this.frameAvg = 0;
    this.frameMax = 0;
    this.cpuAvg = 0;
    this.particles = 0;
    this.quality = 'High';
    this.totalFrames = 0;
  }

  push(frameMs, cpuMs) {
    this.frames[this.i] = frameMs;
    this.cpu[this.i] = cpuMs;
    this.i = (this.i + 1) % N;
    if (this.count < N) this.count++;
    this.totalFrames++;
    let s = 0, mx = 0, c = 0;
    for (let k = 0; k < this.count; k++) {
      const f = this.frames[k];
      s += f;
      if (f > mx) mx = f;
      c += this.cpu[k];
    }
    this.frameAvg = s / this.count;
    this.frameMax = mx;
    this.cpuAvg = c / this.count;
    this.fps = this.frameAvg > 0 ? 1000 / this.frameAvg : 0;
  }

  reset() {
    this.i = 0;
    this.count = 0;
  }
}
