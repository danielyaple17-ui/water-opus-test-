// Motion input: turns DeviceMotion (or the mouse / touch-drag fallback) into three
// signals in *stage* coordinates (device-portrait, x right, y down, m/s²):
//
//   gravity (gx, gy)  – low-passed, direction + strength of gravity
//   tank accel (ax, ay) – high-passed, clamped linear acceleration of the phone.
//                        The sim applies -a to the water (the tank moved, not the water).
//   spin               – rotation rate about the screen normal (rad/s, + = clockwise on screen)
//
// No allocation after construction: all state lives in plain numeric fields.

const G = 9.81;
const DEG = Math.PI / 180;

// Filter time constants (seconds).
const TAU_GRAVITY = 0.06; // light smoothing on fused gravity
const TAU_GRAVITY_RAW = 0.22; // heavier when we must separate gravity ourselves
const TAU_HP = 0.45; // high-pass corner for slosh (removes sensor bias / slow drift)
const TAU_SPIN = 0.05;
const MAX_TANK_ACCEL = 30; // m/s² cap for slosh push
const SIGN_KEY = 'water.sensorSign';

function lp(dt, tau) {
  return 1 - Math.exp(-dt / tau);
}

export class MotionInput {
  constructor(stageEl) {
    this.stage = stageEl;
    this.gx = 0;
    this.gy = G;
    this.ax = 0;
    this.ay = 0;
    this.spin = 0;
    this.source = 'none'; // 'none' | 'mouse' | 'motion'
    this.permission = 'unknown'; // 'unknown' | 'granted' | 'denied' | 'unsupported'
    this.motionEvents = 0;

    // Sensor sign: +1 follows the W3C spec (aIG = +9.81 on the "up" axis at rest).
    // Some older WebKit builds invert it; the debug overlay can flip this.
    this.sign = 1;
    try {
      const s = localStorage.getItem(SIGN_KEY);
      if (s === '-1') this.sign = -1;
    } catch (_) { /* storage unavailable */ }

    // Raw & filter state (stage coords).
    this._lastMotionT = 0;
    this._rawX = 0; this._rawY = 0; // aIG as gravity (stage)
    this._linX = 0; this._linY = 0; // linear accel (stage)
    this._linLpX = 0; this._linLpY = 0; // slow LP for high-pass
    this._hasLinear = false;

    // Mouse fallback state.
    this._mx = 0; this._my = 0; this._mDown = false;
    this._pmx = 0; this._pmy = 0; this._pvx = 0; this._pvy = 0;
    this._mouseMoved = false; this._mouseDt = 0;

    this._onMotion = this._onMotion.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    // Touch fallback (no motion sensor, or a frame that blocks it): drag a
    // finger to tilt — gravity points toward it — and flick to shake.
    this._touchId = -1; this._tx0 = 0; this._ty0 = 0; this._touchTilt = false; this._lastTouchT = -1e9;
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  // Must be invoked synchronously from a user gesture on iOS.
  async requestPermission() {
    const DME = window.DeviceMotionEvent;
    if (!DME) {
      this.permission = 'unsupported';
    } else if (typeof DME.requestPermission === 'function') {
      try {
        this.permission = (await DME.requestPermission()) === 'granted' ? 'granted' : 'denied';
      } catch (_) {
        this.permission = 'denied';
      }
    } else {
      this.permission = 'granted';
    }
    return this.permission;
  }

  attach() {
    window.addEventListener('devicemotion', this._onMotion);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
  }

  setSign(s) {
    this.sign = s < 0 ? -1 : 1;
    try { localStorage.setItem(SIGN_KEY, String(this.sign)); } catch (_) { /* ignore */ }
  }

  _onMotion(e) {
    const aig = e.accelerationIncludingGravity;
    if (!aig || aig.x === null || aig.y === null) return;
    this.motionEvents++;
    this.source = 'motion';

    const t = e.timeStamp * 0.001;
    let dt = this._lastMotionT ? t - this._lastMotionT : (e.interval ? e.interval * 0.001 : 1 / 60);
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60;
    this._lastMotionT = t;

    const s = this.sign;
    // Device frame: x right, y up, z out of screen. Gravity ≈ -aIG at rest.
    // Stage frame: x right, y down  →  g_stage = (-aig.x, +aig.y).
    const rgx = -s * aig.x;
    const rgy = s * aig.y;

    const lin = e.acceleration;
    this._hasLinear = !!(lin && lin.x !== null && lin.y !== null);
    if (this._hasLinear) {
      // Device acceleration a (device frame) → stage (x, -y). OS fusion already removed gravity.
      this._linX = s * lin.x;
      this._linY = -s * lin.y;
      // Pure gravity = aIG - a (device), mapped to stage.
      const k = lp(dt, TAU_GRAVITY);
      this.gx += (rgx + this._linX - this.gx) * k;
      this.gy += (rgy + this._linY - this.gy) * k;
    } else {
      // No fusion: gravity is the slow part of aIG, linear accel the fast remainder.
      const k = lp(dt, TAU_GRAVITY_RAW);
      this.gx += (rgx - this.gx) * k;
      this.gy += (rgy - this.gy) * k;
      // aIG = a - g  →  a = aIG + g ; in stage coords a_stage = -(rg - g_est)
      this._linX = -(rgx - this.gx);
      this._linY = -(rgy - this.gy);
    }
    this._rawX = rgx; this._rawY = rgy;

    // High-pass + clamp the tank acceleration.
    const kh = lp(dt, TAU_HP);
    this._linLpX += (this._linX - this._linLpX) * kh;
    this._linLpY += (this._linY - this._linLpY) * kh;
    this._setTankAccel(this._linX - this._linLpX, this._linY - this._linLpY);

    // rotationRate.alpha: deg/s about device z (out of screen), CCW positive.
    // On a y-down stage that is clockwise-negative, so flip to make + = clockwise on screen.
    const rr = e.rotationRate;
    if (rr && rr.alpha !== null) {
      const w = -s * rr.alpha * DEG;
      this.spin += (w - this.spin) * lp(dt, TAU_SPIN);
    }
  }

  _setTankAccel(x, y) {
    const m = Math.hypot(x, y);
    if (m > MAX_TANK_ACCEL) {
      const f = MAX_TANK_ACCEL / m;
      x *= f; y *= f;
    }
    this.ax = x;
    this.ay = y;
  }

  // ---- desktop fallback -------------------------------------------------
  _stagePoint(e) {
    const r = this.stage.getBoundingClientRect();
    this._mx = e.clientX - r.left;
    this._my = e.clientY - r.top;
  }

  // Browsers synthesise mouse events after a touch; those must not tilt the tank.
  _fromTouch(e) { return e.timeStamp - this._lastTouchT < 800; }

  _onPointerDown(e) {
    if (e.pointerType !== 'touch') return;
    this._lastTouchT = e.timeStamp;
    if (this.source === 'motion' || !e.isPrimary) return;
    this._touchId = e.pointerId;
    this._stagePoint(e);
    this._tx0 = this._mx; this._ty0 = this._my; this._touchTilt = false;
    this._pmx = this._mx; this._pmy = this._my; this._pvx = 0; this._pvy = 0;
    this._mDown = true;
    if (this.source === 'none') this.source = 'mouse';
  }

  _onPointerMove(e) {
    if (e.pointerType !== 'touch') return;
    this._lastTouchT = e.timeStamp;
    if (this.source === 'motion' || e.pointerId !== this._touchId) return;
    this._stagePoint(e);
    // A tap (still finger) is a splash, not a tilt: tilt only once it moves.
    if (!this._touchTilt && Math.hypot(this._mx - this._tx0, this._my - this._ty0) > 12) this._touchTilt = true;
    if (this._touchTilt) this._aimGravity();
  }

  _onPointerUp(e) {
    if (e.pointerType !== 'touch') return;
    this._lastTouchT = e.timeStamp;
    if (e.pointerId === this._touchId) { this._touchId = -1; this._mDown = false; }
  }

  // Gravity points from the stage centre toward the pointer (bottom = upright).
  _aimGravity() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const dx = this._mx - w * 0.5, dy = this._my - h * 0.5;
    const r = Math.hypot(dx, dy);
    if (r > Math.min(w, h) * 0.04) {
      this.gx = (dx / r) * G;
      this.gy = (dy / r) * G;
    }
  }

  _onMouseMove(e) {
    if (this.source === 'motion' || this._fromTouch(e)) return;
    this._stagePoint(e);
    this._mouseMoved = true;
    if (this.source === 'none') {
      this.source = 'mouse';
      this._pmx = this._mx; this._pmy = this._my;
    }
    if (!this._mDown) this._aimGravity();
  }

  _onMouseDown(e) {
    if (this.source === 'motion' || e.button !== 0 || this._fromTouch(e)) return;
    this._stagePoint(e);
    this._mDown = true;
    this._pmx = this._mx; this._pmy = this._my;
    this._pvx = 0; this._pvy = 0;
    if (this.source === 'none') this.source = 'mouse';
  }

  _onMouseUp(e) {
    if (this._fromTouch(e)) return;
    this._mDown = false;
  }

  // Called once per rendered frame with the real frame dt (seconds).
  update(dt) {
    if (this.source !== 'mouse' || !(dt > 0)) {
      if (this.source !== 'motion') { this.ax *= 0.8; this.ay *= 0.8; }
      return;
    }
    // Click-drag shakes the tank: the tank acceleration is the pointer's
    // acceleration, scaled so the stage height ≈ 0.15 m (a phone).
    const pxPerM = Math.max(1, this.stage.clientHeight) / 0.15;
    if (this._mDown) {
      const vx = (this._mx - this._pmx) / dt / pxPerM;
      const vy = (this._my - this._pmy) / dt / pxPerM;
      const k = lp(dt, 0.03);
      const axr = (vx - this._pvx) / dt;
      const ayr = (vy - this._pvy) / dt;
      this._pvx = vx; this._pvy = vy;
      this._setTankAccel(this.ax + (axr - this.ax) * k, this.ay + (ayr - this.ay) * k);
    } else {
      this._pvx = 0; this._pvy = 0;
      this.ax *= 0.8; this.ay *= 0.8;
    }
    this._pmx = this._mx; this._pmy = this._my;
  }
}
