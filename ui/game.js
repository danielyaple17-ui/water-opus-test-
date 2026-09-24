// Game flow: level HUD (name, fill meter with the target tick, hint), win
// card with stars, and the level list. Progress (unlocked level, best stars)
// is kept in localStorage; everything works without it.

import { markerFor } from '../src/levels.js';

const SAVE_KEY = 'water.game';
const HOLD_S = 1.5; // seconds the cup must stay at the target

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    return { unlocked: v.unlocked | 0, stars: Array.isArray(v.stars) ? v.stars : [] };
  } catch (_) { return { unlocked: 0, stars: [] }; }
}
function save(p) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(p)); } catch (_) { /* storage unavailable */ }
}

export class Game {
  // els: { hud, level, name, fill, target, hint, win, winTitle, winStars, winTime, next, replay, menu, list, listBody }
  constructor(levels, els, { onLoad }) {
    this.levels = levels;
    this.els = els;
    this.onLoad = onLoad;
    this.progress = load();
    this.index = Math.min(this.progress.unlocked, levels.length - 1);
    this.level = null;
    this.t = 0;
    this.held = 0;
    this.done = false;
    this.ready = false; // sim has loaded this level
    const stop = (e) => e.stopPropagation(); // HUD taps are not splashes
    for (const el of [els.hud, els.win, els.list]) {
      el.addEventListener('pointerdown', stop);
      el.addEventListener('click', stop);
    }
    els.next.addEventListener('click', () => this.start(Math.min(this.index + 1, this.levels.length - 1)));
    els.replay.addEventListener('click', () => this.start(this.index));
    els.menu.addEventListener('click', () => this.showList(true));
    els.listClose.addEventListener('click', () => this.showList(false));
  }

  get current() { return this.levels[this.index]; }

  start(index) {
    this.index = index;
    this.level = this.levels[index];
    this.level.marker = markerFor(this.level);
    this.t = 0; this.held = 0; this.done = false; this.ready = false;
    const e = this.els;
    e.win.hidden = true;
    e.list.hidden = true;
    e.hud.hidden = false;
    e.level.textContent = String(index + 1);
    e.name.textContent = this.level.name;
    e.hint.textContent = this.level.hint;
    e.hint.classList.remove('hold');
    e.target.style.left = `${this.level.target * 100}%`;
    e.fill.style.width = '0%';
    this.onLoad(this.level);
  }

  restart() { this.start(this.index); }

  // Each frame: goal = particles in the cup, total = all particles.
  update(dt, goal, total) {
    if (!this.level || this.done || !this.ready || !(total > 0)) return;
    this.t += dt;
    const f = goal / total, L = this.level, e = this.els;
    e.fill.style.width = `${Math.min(100, f * 100).toFixed(1)}%`;
    const over = f >= L.target;
    e.fill.classList.toggle('ok', over);
    if (over) {
      this.held += dt;
      e.hint.textContent = `Hold it… ${Math.max(0, HOLD_S - this.held).toFixed(1)} s`;
      e.hint.classList.add('hold');
      if (this.held >= HOLD_S) this._win();
    } else if (this.held > 0) {
      this.held = 0;
      e.hint.textContent = L.hint;
      e.hint.classList.remove('hold');
    }
  }

  _win() {
    this.done = true;
    const L = this.level, t = this.t;
    const stars = t <= L.par ? 3 : t <= L.par * 2 ? 2 : 1;
    const p = this.progress;
    p.stars[this.index] = Math.max(p.stars[this.index] | 0, stars);
    p.unlocked = Math.max(p.unlocked, Math.min(this.index + 1, this.levels.length - 1));
    save(p);
    const e = this.els;
    const last = this.index === this.levels.length - 1;
    e.winTitle.textContent = last ? 'All levels cleared' : `${L.name} — filled`;
    e.winStars.textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
    e.winStars.setAttribute('aria-label', `${stars} of 3 stars`);
    e.winTime.textContent = `${t.toFixed(1)} s · three stars under ${L.par} s`;
    e.next.hidden = last;
    e.win.hidden = false;
  }

  showList(on) {
    const e = this.els;
    if (!on) { e.list.hidden = true; return; }
    e.listBody.textContent = '';
    this.levels.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'lvl';
      const locked = i > this.progress.unlocked;
      b.disabled = locked;
      const s = this.progress.stars[i] | 0;
      b.innerHTML = `<span class="lvl-n">${i + 1}</span><span class="lvl-name"></span><span class="lvl-stars">${locked ? 'locked' : '★'.repeat(s) + '☆'.repeat(3 - s)}</span>`;
      b.querySelector('.lvl-name').textContent = L.name;
      if (i === this.index) b.classList.add('cur');
      b.addEventListener('click', () => this.start(i));
      e.listBody.appendChild(b);
    });
    e.list.hidden = false;
  }

  hide() {
    this.level = null;
    const e = this.els;
    e.hud.hidden = true; e.win.hidden = true; e.list.hidden = true;
  }
}
