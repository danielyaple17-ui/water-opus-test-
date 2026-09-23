// Deterministic tests of the quality controller (no browser): feeds synthetic
// frame times / sim progress and checks downgrade, hysteresis, no oscillation,
// fall-back memory, the thermal guard and the battery cap.
import { QualityController, LEVELS } from '../src/quality.js';
import { outDir, logResult } from './lib.mjs';

const results = {};
function run(scenario, { seconds, frame, simRatio = () => 1, init = 2, setup }) {
  const log = [];
  let t = 0, sim = 0;
  const q = new QualityController((lvl, why) => log.push({ t: +t.toFixed(1), to: LEVELS[lvl].name, why }), { initial: init });
  if (setup) setup(q);
  while (t < seconds) {
    const dt = frame(t, q.level);
    t += dt;
    sim += dt * simRatio(t, q.level);
    q.update(dt, sim);
  }
  results[scenario] = { final: q.name, changes: q.changes, log };
  return q;
}
const P = 1 / 60;

// 1. Fast device at 60 Hz: stays High, then climbs to Ultra after headroom, never back.
run('fast60', { seconds: 60, frame: () => P });
// 2. GPU too slow for High and Ultra (needs Med): settles at Med, no oscillation.
run('gpuBound', { seconds: 120, frame: (t, l) => (l >= 2 ? P * 1.6 : P) });
// 3. Borderline: Ultra overloads, High is fine → must not ping-pong High↔Ultra.
run('borderline', { seconds: 300, frame: (t, l) => (l === 3 ? P * 1.3 : P) });
// 4. Sim-bound: worker can't keep 120 Hz at High (ratio 0.8) → Med.
run('simBound', { seconds: 60, frame: () => P, simRatio: (t, l) => (l >= 2 ? 0.8 : 1) });
// 5. Thermal: High fine for 60 s, then frame time creeps +20 % (below the
//    1.25× overload threshold) → the thermal guard drops a level and caps.
run('thermal', { seconds: 200, init: 2, frame: (t, l) => (l === 2 && t > 60 ? P * 1.2 : P), setup: (q) => { q.maxLevel = 2; } });
// 6. 120 Hz display, fast: period detected as 1/120 and no false overload.
run('fast120', { seconds: 40, frame: () => 1 / 120 });
// 7. Battery cap while at Ultra.
run('battery', { seconds: 40, init: 3, frame: () => P, setup: (q) => q.setPowerCap(1) });

const osc = (log) => { let n = 0; for (let i = 2; i < log.length; i++) if (log[i].to === log[i - 2].to) n++; return n; };
const checks = {
  fast60: results.fast60.final === 'Ultra' && osc(results.fast60.log) === 0,
  gpuBound: results.gpuBound.final === 'Med' && results.gpuBound.changes <= 3,
  // One retry per back-off window, then never again: at most 3 failed tries in 5 min.
  borderline: results.borderline.final === 'High' && results.borderline.changes <= 6,
  simBound: results.simBound.final === 'Med',
  thermal: results.thermal.log.some((e) => e.why.startsWith('thermal')) && results.thermal.final === 'Med',
  fast120: results.fast120.log.every((e) => !e.why.startsWith('overload')),
  battery: results.battery.final === 'Med',
};
const dir = outDir('M9');
const out = { results, checks, pass: Object.values(checks).every(Boolean) };
logResult(dir, out);
for (const [k, v] of Object.entries(results)) console.log(k.padEnd(11), checks[k] ? 'PASS' : 'FAIL', v.final, JSON.stringify(v.log));
process.exit(out.pass ? 0 : 1);
