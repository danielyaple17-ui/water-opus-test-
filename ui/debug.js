// Hidden debug overlay. Opened by triple-tapping any screen corner (or 'D' on desktop).
// Text is written into pre-created nodes at ~4 Hz so the frame loop stays cheap.

const CORNER = 72; // px hot-zone in each corner
const TAP_WINDOW = 650; // ms for three taps

export class DebugOverlay {
  constructor(el, stage, { renderer, motion, stats, sim, extraToggles }) {
    this.sim = sim;
    this.el = el;
    this.stage = stage;
    this.renderer = renderer;
    this.motion = motion;
    this.stats = stats;
    this.visible = false;
    this._taps = [0, 0, 0];
    this._tapIdx = 0;
    this._lastText = 0;
    this._build(extraToggles || {});

    stage.addEventListener('pointerdown', (e) => this._onPointer(e), { capture: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'd' || e.key === 'D') this.toggle();
    });
  }

  _row(label) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.textContent = '-';
    row.append(k, v);
    this.el.append(row);
    return v;
  }

  _build(extraToggles) {
    this.v = {
      fps: this._row('fps'),
      frame: this._row('frame avg/max'),
      cpu: this._row('cpu avg'),
      particles: this._row('particles'),
      sim: this._row('sim step'),
      leak: this._row('outside / fill'),
      quality: this._row('quality'),
      res: this._row('render px'),
      source: this._row('input'),
      g: this._row('gravity'),
      a: this._row('tank accel'),
      spin: this._row('spin'),
    };
    // Gravity compass.
    this.compass = document.createElement('canvas');
    this.compass.width = this.compass.height = 96;
    this.compass.style.width = this.compass.style.height = '96px';
    this.el.append(this.compass);
    this.ctx = this.compass.getContext('2d');

    const toggles = document.createElement('div');
    toggles.className = 'toggles';
    const addToggle = (label, get, set) => {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = get();
      c.addEventListener('change', () => set(c.checked));
      l.append(c, document.createTextNode(label));
      toggles.append(l);
    };
    for (const name of Object.keys(this.renderer.passes)) {
      addToggle(name, () => this.renderer.passes[name], (v) => { this.renderer.passes[name] = v; });
    }
    for (const [name, t] of Object.entries(extraToggles)) addToggle(name, t.get, t.set);
    this.el.append(toggles);
  }

  _onPointer(e) {
    const r = this.stage.getBoundingClientRect();
    // Hit test in stage-local coordinates (the stage may be counter-rotated).
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const w = r.width, h = r.height;
    const inCorner = (x < CORNER || x > w - CORNER) && (y < CORNER || y > h - CORNER);
    if (!inCorner) return;
    const now = performance.now();
    this._taps[this._tapIdx] = now;
    this._tapIdx = (this._tapIdx + 1) % 3;
    const oldest = this._taps[this._tapIdx];
    if (oldest && now - oldest < TAP_WINDOW) {
      this._taps[0] = this._taps[1] = this._taps[2] = 0;
      this.toggle();
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    if (this.visible) this.update(true);
  }

  update(force = false) {
    if (!this.visible) return;
    const now = performance.now();
    if (!force && now - this._lastText < 250) return;
    this._lastText = now;
    const s = this.stats, m = this.motion, v = this.v;
    v.fps.textContent = s.fps.toFixed(0);
    v.frame.textContent = `${s.frameAvg.toFixed(1)} / ${s.frameMax.toFixed(1)} ms`;
    v.cpu.textContent = `${s.cpuAvg.toFixed(2)} ms`;
    v.particles.textContent = String(s.particles);
    const ss = this.sim && this.sim.stats;
    if (ss) {
      v.sim.textContent = `${ss.stepMs.toFixed(2)} ms ×${ss.substeps}`;
      v.leak.textContent = `${ss.outside} / ${ss.fillVolume.toFixed(0)}`;
    }
    v.quality.textContent = s.quality;
    v.res.textContent = `${this.renderer.width}×${this.renderer.height}`;
    v.source.textContent = `${m.source} (${m.permission})`;
    v.g.textContent = `${m.gx.toFixed(2)}, ${m.gy.toFixed(2)}  |${Math.hypot(m.gx, m.gy).toFixed(2)}|`;
    v.a.textContent = `${m.ax.toFixed(2)}, ${m.ay.toFixed(2)}`;
    v.spin.textContent = `${m.spin.toFixed(2)} rad/s`;
    this._drawCompass();
  }

  _drawCompass() {
    const c = this.ctx, m = this.motion;
    const S = 96, R = 40, cx = S / 2, cy = S / 2;
    c.clearRect(0, 0, S, S);
    c.strokeStyle = 'rgba(255,255,255,.25)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    const arrow = (x, y, color) => {
      c.strokeStyle = color; c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + x, cy + y); c.stroke();
      c.fillStyle = color;
      c.beginPath(); c.arc(cx + x, cy + y, 3, 0, Math.PI * 2); c.fill();
    };
    const gs = R / 9.81;
    arrow(m.gx * gs, m.gy * gs, '#5fd4ff');
    const as = R / 30;
    arrow(-m.ax * as, -m.ay * as, '#ffb347'); // slosh push on the water
  }
}
