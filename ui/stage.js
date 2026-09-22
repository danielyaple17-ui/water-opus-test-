// Keeps #stage in device-portrait orientation. Android (installed / fullscreen)
// can lock orientation; iOS Safari cannot, so when the browser rotates the
// viewport we counter-rotate the stage so the "tank" stays glued to the glass
// and sensor axes map 1:1 onto stage axes.

export function screenAngle() {
  const so = window.screen && window.screen.orientation;
  if (so && typeof so.angle === 'number') return ((so.angle % 360) + 360) % 360;
  if (typeof window.orientation === 'number') return ((window.orientation % 360) + 360) % 360;
  return 0;
}

export function tryLockPortrait() {
  const so = window.screen && window.screen.orientation;
  if (so && so.lock) so.lock('portrait-primary').catch(() => { /* unsupported: counter-rotate instead */ });
}

export class Stage {
  constructor(el, onResize) {
    this.el = el;
    this.onResize = onResize;
    this.width = 1; // stage CSS size (portrait)
    this.height = 1;
    this.angle = 0;
    this._apply = this._apply.bind(this);
    window.addEventListener('resize', this._apply);
    window.addEventListener('orientationchange', () => setTimeout(this._apply, 50));
    if (window.screen && window.screen.orientation) {
      window.screen.orientation.addEventListener('change', this._apply);
    }
    this._apply();
  }

  _apply() {
    const vw = window.innerWidth, vh = window.innerHeight;
    // Only counter-rotate on touch devices; a desktop landscape window is just a wide tank.
    const touch = navigator.maxTouchPoints > 0;
    const a = touch ? screenAngle() : 0;
    this.angle = a;
    const s = this.el.style;
    if (a === 90) {
      this.width = vh; this.height = vw;
      s.transform = `translateY(${vh}px) rotate(-90deg)`;
    } else if (a === 270) {
      this.width = vh; this.height = vw;
      s.transform = `translateX(${vw}px) rotate(90deg)`;
    } else if (a === 180) {
      this.width = vw; this.height = vh;
      s.transform = `translate(${vw}px, ${vh}px) rotate(180deg)`;
    } else {
      this.width = vw; this.height = vh;
      s.transform = '';
    }
    s.width = this.width + 'px';
    s.height = this.height + 'px';
    this.onResize(this.width, this.height);
  }
}
