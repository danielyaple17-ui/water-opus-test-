// Entry point: wires stage, input, renderer, debug overlay and the frame loop.

import { Renderer } from '../render/renderer.js';
import { MotionInput } from '../input/motion.js';
import { DebugOverlay } from '../ui/debug.js';
import { Stage, tryLockPortrait } from '../ui/stage.js';
import { Stats } from '../ui/stats.js';
import { FixedStep } from '../sim/fixed-step.js';

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
const clock = new FixedStep(120, 4);
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
  simTime: 0,
};

// Placeholder physics step (M2 plugs the particle sim in here).
function simStep(dt) {
  state.simTime += dt;
}

let last = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (state.paused) { last = now; return; }
  const frameMs = last ? now - last : 16.7;
  last = now;
  const t0 = performance.now();
  const dt = frameMs * 0.001;

  motion.update(dt);
  if (state.started) clock.advance(dt, simStep);
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
  state.started = true;
  startEl.classList.add('hide');
}
startEl.addEventListener('click', start);

// ---- lifecycle ----------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  state.paused = document.hidden;
  if (!state.paused) { clock.reset(); stats.reset(); }
});

// Desktop testing: mouse input works before the start tap so tilting is visible.
if (navigator.maxTouchPoints === 0) motion.attach();

requestAnimationFrame(frame);

// Test / debugging hook (read-only use by verify scripts).
window.__water = { state, stats, motion, renderer, clock, debug, stage };
