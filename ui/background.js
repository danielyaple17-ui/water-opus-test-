// Background picker: the built-in backdrops plus the player's own photo.
// The choice (and a downscaled copy of the photo) is kept in localStorage so
// it survives a reload; everything still works when storage is unavailable.

import { BACKGROUNDS } from '../render/renderer.js';

const STYLE_KEY = 'water.bg';
const PHOTO_KEY = 'water.bgPhoto';
const MAX_SIDE = 1600; // px: plenty for a phone screen, small enough to store

// CSS previews of the presets (the real ones are shaders).
const SWATCH_CSS = [
  'radial-gradient(120% 90% at 50% 100%, #2b3036, #0b0d10 70%)',
  'repeating-linear-gradient(0deg, #16292c 0 1px, transparent 1px 12px), repeating-linear-gradient(90deg, #16292c 0 1px, #3d6970 1px 12px)',
  'radial-gradient(circle at 30% 30%, #6d6557 0 22%, transparent 24%), radial-gradient(circle at 72% 62%, #4f5659 0 26%, transparent 28%), radial-gradient(circle at 25% 80%, #5c554c 0 18%, transparent 20%), #111',
  'repeating-linear-gradient(0deg, #9fb7c0 0 1px, transparent 1px 8px), repeating-linear-gradient(90deg, #9fb7c0 0 1px, #c9c6bb 1px 8px)',
];

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// Downscale to MAX_SIDE on a canvas (respects EXIF orientation in current
// browsers when drawn from an <img>).
async function toCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class BackgroundPicker {
  constructor(sheet, renderer) {
    this.sheet = sheet;
    this.renderer = renderer;
    this.body = sheet.querySelector('.bg-options');
    this.file = sheet.querySelector('#bg-file');
    this.status = sheet.querySelector('.bg-status');
    this.style = 0;
    this.photo = null;
    const stop = (e) => e.stopPropagation();
    sheet.addEventListener('pointerdown', stop);
    sheet.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === sheet) this.show(false); });
    sheet.querySelector('.bg-close').addEventListener('click', () => this.show(false));
    this.file.addEventListener('change', () => this._pick());
    this._build();
    this._restore();
  }

  _build() {
    BACKGROUNDS.forEach((name, i) => this._option(name, SWATCH_CSS[i], () => this.set(i)));
    this.photoBtn = this._option('Your photo', 'linear-gradient(135deg, #34505a, #1a242a)', () => this.file.click());
    this.photoBtn.querySelector('.bg-swatch').textContent = '+';
  }

  _option(label, css, onClick) {
    const b = document.createElement('button');
    b.className = 'bg-opt';
    b.innerHTML = '<span class="bg-swatch"></span><span class="bg-name"></span>';
    b.querySelector('.bg-swatch').style.background = css;
    b.querySelector('.bg-name').textContent = label;
    b.addEventListener('click', onClick);
    this.body.appendChild(b);
    return b;
  }

  show(on) {
    this.sheet.hidden = !on;
    if (on) this._mark();
  }

  _mark() {
    [...this.body.children].forEach((b, i) => b.classList.toggle('cur', this.photo ? i === BACKGROUNDS.length : i === this.style));
  }

  set(style) {
    this.style = style;
    this.photo = null;
    this.renderer.setBackground(style, null);
    try { localStorage.setItem(STYLE_KEY, String(style)); localStorage.removeItem(PHOTO_KEY); } catch (_) { /* ignore */ }
    this.status.textContent = '';
    this._mark();
  }

  async _pick() {
    const f = this.file.files && this.file.files[0];
    this.file.value = '';
    if (!f) return;
    this.status.textContent = 'Loading photo…';
    try {
      const c = await toCanvas(f);
      this.photo = c;
      this.renderer.setBackground(0, c);
      let saved = true;
      try {
        localStorage.setItem(PHOTO_KEY, c.toDataURL('image/jpeg', 0.85));
        localStorage.setItem(STYLE_KEY, 'photo');
      } catch (_) { saved = false; }
      this.status.textContent = saved ? 'Photo set' : 'Photo set for this visit (the browser would not store it)';
      this._mark();
      // The photo swatch previews the chosen image.
      this.photoBtn.querySelector('.bg-swatch').style.background = `center/cover url(${c.toDataURL('image/jpeg', 0.6)})`;
      this.photoBtn.querySelector('.bg-swatch').textContent = '';
    } catch (_) {
      this.status.textContent = 'That file could not be opened as an image. Try a JPEG or PNG.';
    }
  }

  async _restore() {
    let style = 0, photo = null;
    try {
      const s = localStorage.getItem(STYLE_KEY);
      if (s === 'photo') photo = localStorage.getItem(PHOTO_KEY);
      else if (s !== null) style = Math.max(0, Math.min(BACKGROUNDS.length - 1, s | 0));
    } catch (_) { /* ignore */ }
    if (photo) {
      try {
        const img = await loadImage(photo);
        this.photo = img;
        this.renderer.setBackground(0, img);
        this.photoBtn.querySelector('.bg-swatch').style.background = `center/cover url(${photo})`;
        this.photoBtn.querySelector('.bg-swatch').textContent = '';
        return;
      } catch (_) { /* fall back to a preset */ }
    }
    this.style = style;
    this.renderer.setBackground(style, null);
  }
}
