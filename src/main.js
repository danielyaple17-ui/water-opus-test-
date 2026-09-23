// Entry point: wires stage, input, renderer, debug overlay and the frame loop.

import { Renderer } from '../render/renderer.js';
import { MotionInput } from '../input/motion.js';
import { DebugOverlay } from '../ui/debug.js';
import { Stage, tryLockPortrait } from '../ui/stage.js';
import { Stats } from '../ui/stats.js';
import { SimClient } from '../sim/client.js';
import { HEADER } from '../sim/layout.js';
import { QualityController, LEVELS } from './quality.js';
import { TouchGestures } from '../ui/touch.js';
import { Bench } from '../ui/bench.js';

const $ = (id) => document.getElementById(id);
const stageEl = $('stage');
const canvas = $('gl');
const startEl = $('start');
const startSub = startEl.querySelector('.start-sub');

function fatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.hidden = false;
}

let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  fatal(err.message);
  throw err;
}

const stats = new Stats();
const motion = new MotionInput(stageEl);
const stage = new Stage(stageEl, (w, h) => renderer.resize(w, h));

const debug = new DebugOverlay($('debug'), stageEl, {
  renderer,
  motion,
  stats,
  extraToggles: {
    'invert sensor sign': { get: () => motion.sign < 0, set: (v) => motion.setSign(v ? -1 : 1) },
  },
});

const state = {
  started: false,
  paused: false,
};

// Physical tank: a phone-sized glass, 15 cm tall, width from the stage aspect.
const TANK_HEIGHT_M = 0.15;
// Quality: automatic by default (starts at High). `?q=low|med|high|ultra` pins a
// level; `?cells=N` pins the sim grid (testing / slow devices).
const params = new URLSearchParams(location.search);
const Q_NAMES = ['low', 'med', 'high', 'ultra'];
const forcedQ = Q_NAMES.indexOf((params.get('q') || '').toLowerCase());
const CELLS_OVERRIDE = (() => {
  const v = Number(params.get('cells'));
  return v >= 16 && v <= 256 ? Math.round(v) : 0;
})();
const cellsFor = (level) => CELLS_OVERRIDE || LEVELS[level].cells;

function applyQuality(level) {
  const L = LEVELS[level];
  renderer.renderScale = L.renderScale;
  renderer.surface.blurPasses = L.blurPasses;
  renderer.surface.depthPasses = L.depthPasses;
  renderer.resize(stage.width, stage.height);
  if (state.started) sim.resample(cellsFor(level));
  stats.quality = L.name;
}
const quality = new QualityController(applyQuality, { initial: forcedQ >= 0 ? forcedQ : 2, auto: forcedQ < 0 });

const sim = new SimClient((data, count, bubbles) => {
  stats.particles = count;
  if (renderer.lost) return; // nothing to upload into; the next frame after restore refills
  renderer.particles.upload(data, count, HEADER);
  renderer.bubbles.upload(data, HEADER + 4 * sim.count, bubbles);
});
debug.sim = sim;

function initSim() {
  const aspect = stage.width / stage.height;
  // The water pours in from the top and settles (`?pour=0` starts full: tests).
  sim.init({
    worldWidth: TANK_HEIGHT_M * aspect, worldHeight: TANK_HEIGHT_M, cellsX: cellsFor(quality.level), fill: 0.45,
    pour: params.get('pour') !== '0',
  });
}

let last = 0;
let bench = null; // ?bench=1: on-device benchmark (ui/bench.js)
function frame(now) {
  requestAnimationFrame(frame);
  if (state.paused) { last = now; return; }
  const frameMs = last ? now - last : 16.7;
  last = now;
  const t0 = performance.now();
  const dt = frameMs * 0.001;

  motion.update(dt);
  if (state.started && bench) bench.tick(dt);
  if (state.started) {
    sim.update(dt, motion);
    renderer.setGravity(motion.gx, motion.gy);
    renderer.setTime(now * 0.001, sim.stats ? sim.stats.activity : 0);
    quality.update(dt, sim.stats ? sim.stats.simTime : -1);
    renderer.particles.radius = sim.radius;
  }
  renderer.render();

  stats.push(frameMs, performance.now() - t0);
  debug.update();
}

// ---- start screen -------------------------------------------------------
async function start() {
  if (state.started) return;
  // requestPermission must be the first await inside the gesture handler on iOS.
  const perm = await motion.requestPermission();
  motion.attach();
  tryLockPortrait();
  const el = document.documentElement;
  if (el.requestFullscreen && navigator.maxTouchPoints > 0) el.requestFullscreen().catch(() => {});
  if (perm === 'denied') {
    startSub.textContent = 'Motion access denied — using touch & mouse';
  }
  initSim();
  if (params.get('bench') === '1') {
    bench = new Bench({ quality, sim, motion, overlay: debug, seconds: Number(params.get('benchSec')) || 8 });
  }
  state.started = true;
  startEl.classList.add('hide');
}
startEl.addEventListener('click', start);

// ---- lifecycle ----------------------------------------------------------
// Hidden tab / app switch / bfcache: stop simulating and drawing entirely (the
// worker idles because no step requests arrive); on return, drop the elapsed
// time so the water resumes where it was instead of fast-forwarding.
function setPaused(p) {
  if (state.paused === p) return;
  state.paused = p;
  if (!p) { sim.pendingDt = 0; last = 0; stats.reset(); }
}
document.addEventListener('visibilitychange', () => setPaused(document.hidden));
window.addEventListener('pagehide', () => setPaused(true));
window.addEventListener('pageshow', () => setPaused(document.hidden));

// Lost WebGL context: keep simulating; if it isn't back within 5 s, offer a reload.
let lostTimer = 0;
renderer.onContextState = (st) => {
  clearTimeout(lostTimer);
  if (st === 'lost') lostTimer = setTimeout(() => renderer.onContextState('failed'), 5000);
  else if (st === 'restored') $('fatal').hidden = true;
  else if (st === 'failed' && renderer.lost !== false) {
    fatal('Graphics were reset. Tap to reload.');
    $('fatal').addEventListener('click', () => location.reload(), { once: true });
  }
};

// Desktop testing: mouse input works before the start tap so tilting is visible.
if (navigator.maxTouchPoints === 0) motion.attach();

requestAnimationFrame(frame);

// Test / debugging hook (read-only use by verify scripts).
applyQuality(quality.level);
debug.quality = quality;

// Battery saver (Battery Status API: Chrome/Android; iOS Safari doesn't expose
// it, where the thermal guard in the quality controller is the only protection).
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const check = () => quality.setPowerCap(b.level < 0.2 && !b.charging ? 1 : LEVELS.length - 1);
    b.addEventListener('levelchange', check);
    b.addEventListener('chargingchange', check);
    check();
  }).catch(() => {});
}

// Tap = splash ripple, two-finger tap (or R) = empty and pour again.
new TouchGestures(stageEl, stage, {
  onTap: (x, y) => { if (state.started) sim.impulse(x, y); },
  onReset: () => { if (state.started) initSim(); },
  frames: () => stats.totalFrames,
});
window.addEventListener('keydown', (e) => {
  const k = '1234'.indexOf(e.key);
  if (k >= 0) quality.force(k);
  if (e.key === 'a' || e.key === 'A') quality.auto = true;
});

window.__water = { state, stats, motion, renderer, sim, debug, stage, quality };
