# PROGRESS

Phone-as-a-water-tank: real-time 2D FLIP water in WebGL2, driven by DeviceMotion.

## Milestones
- [x] M1: Project setup, HTTPS dev server, full-screen WebGL2 canvas, start screen, motion permission, gravity vector shown on the debug overlay
- [x] M2: Basic particle water (CPU/worker), walls, gravity from tilt, drawn as plain dots
- [ ] M3: Sloshing from shakes + swirl from spinning, tuned so it feels physically right
- [ ] M4: Surface drawing (thickness, blur, normals) + refraction + Fresnel reflection
- [ ] M5: Color that deepens with thickness, glow through thin water, highlights, waterline
- [ ] M6: Foam, bubbles, caustics
- [ ] M7: Move the sim to the GPU (or optimize the worker until the budget is met); automatic quality levels
- [ ] M8: Polish: tone mapping, bloom, glass feel, pour-in animation, tap ripples
- [ ] M9: Hardening: context loss, pausing in the background, heat management, testing on real devices
- [ ] M10: Final realism pass: side-by-side critique against reference footage, then fix the 3 weakest visual problems

## Architecture (as of M2)
- `server/dev-server.mjs` – zero-dep HTTPS static server, self-signed cert (SANs: localhost + LAN IPs) auto-generated into `.cert/`. Sends COOP/COEP so SharedArrayBuffer is available for the sim worker.
- `index.html`, `manifest.webmanifest`, `icons/` – full-screen PWA meta (apple-mobile-web-app-capable, viewport-fit=cover, display: fullscreen, orientation: portrait).
- `ui/stage.js` – `#stage` is always device-portrait. Android locks orientation; on iOS the stage is CSS counter-rotated when the viewport rotates, so sensor axes map 1:1 to stage axes.
- `input/motion.js` – DeviceMotion → stage coords (x right, y down, m/s²).
  - gravity: fused `aIG − acceleration`, low-pass τ=60 ms (fallback without `acceleration`: LP τ=220 ms on aIG).
  - tank accel: high-pass (τ=450 ms) linear acceleration, clamped to 30 m/s². Sim must apply **−a** to the water.
  - spin: `rotationRate.alpha` → rad/s, + = clockwise on screen, LP τ=50 ms.
  - Desktop fallback: gravity points from stage centre to the cursor; click-drag = pointer acceleration as tank accel (stage height ≈ 0.15 m).
- `sim/fixed-step.js` – 120 Hz fixed-step accumulator, max 4 steps/frame (drops time rather than spiralling). Runs inside the worker.
- `sim/flip.js` – 2D FLIP/PIC (95% FLIP) on a MAC grid with a 1-cell solid border, metres, stage frame (y down). Tank 15 cm tall, width from aspect, 84 cells across (86×182 incl. walls), 21,684 particles, hex-packed bottom 45%.
  - Step order: separation (spatially sorted counting-sort hash, 2 single-visit passes) → [forces → P2G → density → viscosity → pressure → G2P → advect → wall clamp] × 1–3 CFL substeps (≤ 4 cells/substep, speed cap ≈ 1.2 m/s).
  - Walls: particles clamped inside the border every substep + zero normal velocity → leaks impossible; particles never created/destroyed.
  - Pressure: `sim/multigrid.js` geometric multigrid, red-black GS smoother (3 pre / 3 post), 3 V-cycles per solve, warm-started from last step's pressure. Coarse cells: AIR if any child air (FLUID-if-any diverged).
  - Drift compensation on 3×3-smoothed density, k=0.1·h/dt, 2% dead-band; rest density from fully-interior cells only.
  - Viscosity: explicit grid diffusion, ν=2e-5 m²/s (clamped k≤0.2), no-slip drag at walls, free surface skipped.
  - Diagnostics: `fluidCells`, `fillVolume` = Σ min(ρ/ρ0, 1) (the volume metric used for pass/fail).
- `sim/worker.js` + `sim/client.js` – module worker owns sim + clock; main posts {dt, g, a, spin, free buffer}, worker returns x,y (tank-normalised), vx,vy as a transferred Float32Array. Two ArrayBuffers ping-pong; one request in flight.
- `render/particles.js` – plain GL_POINTS dots coloured by speed (M2 debug view; replaced by surface rendering in M4).
- `render/` – WebGL2 context (context-loss listeners), shader helpers with cached uniform locations, backplate baked once per resize into an SRGB8_ALPHA8 texture (future refraction source), linear→sRGB composite.
- `ui/debug.js` – triple-tap any corner (or `D`): fps, frame avg/max, CPU ms, particles, quality, render px, input source/permission, gravity, tank accel, spin, gravity compass, per-pass toggles, sensor-sign toggle.
- `ui/stats.js` – ring-buffer frame stats (no per-frame allocation).
- `verify/` – `lib.mjs` (Playwright + server + synthetic DeviceMotion streaming), `m1.mjs`, `m2.mjs`, `make-icons.mjs`.

## Measurements
### M1 (2026-09-22) – headless Chromium, SwiftShader (software GL), 390×844 @2x
- Console errors: 0. `node verify/m1.mjs` → pass. Screenshots: `verify/M1/`.
- Gravity mapping (synthetic events): upright (0, 9.81); tilt-left 34° (−5.54, 8.10); tilt-right (5.54, 8.10); upside-down (0, −9.81); flat (0, 0). Shake 6 Hz ±20 m/s²: gravity stays (0, 9.81), tank accel peaks 20.2 (cap 30), spin −1.57 rad/s for alpha=+90°/s.
- Desktop: mouse at left edge → g=(−9.81, 0); drag-shake → |a|=11.5 m/s².
- Frame time: avg ~44–51 ms, worst ~183 ms. **Not representative**: an empty clear in this headless SwiftShader env already costs ~23 ms/frame at 780×1688. App CPU time per frame: 0.04 ms.
- Volume: n/a (no water yet).

### M2 (2026-09-22) – headless Chromium + SwiftShader, 390×844 @2x
- `node verify/m2.mjs` → pass, 0 console errors. Screenshots: `verify/M2/` (settled, tilt ±34°, upside-down, upright, shake, resettled, overlay).
- Volume: particles 21,684 constant in every phase; particles outside tank: 0 in every phase. Grid fill (Σ min(ρ/ρ0,1)) settled start 6693.2 → settled end 6723.5 = **+0.45%**; worst mid-run deviation 1.08% (right after the upside-down flip). Raw fluid-cell count +2.8% (fluffy surface, see issues).
- Node (no browser): 20 s of 3 Hz ±20 m/s² lateral + 1.7 Hz ±8 m/s² vertical shaking → settled fill −0.43% .. +0.45%, 0 leaks, 0 NaN.
- Sim step (worker, in browser while SwiftShader renders on the same 4 vCPUs): avg 18–20 ms, worst 72 ms → the sim ran at ≈0.25× real time here. Standalone Node on this VM: ≈11–15 ms/step (separation ≈4–5, pressure ≈3–5, P2G+G2P ≈3). This VM does a trivial dependent float op in 6.6 ns (roughly 3× slower than a phone-class core), but even scaled it is at or over the 8.3 ms/step budget.
- Main-thread frame: avg 73–76 ms, worst 300 ms (software GL; M1 showed an empty clear alone costs 23 ms here). Main CPU per frame 0.05 ms.
- Visual (honest): reads correctly as a tank of water: surfaces level to gravity, the tilt slope matches the tilt angle, water slams to the top when inverted and resettles flat. As expected for M2 it looks like blue sand, not water. Minor artifacts: a particle-radius gap and a sparse strip along the walls; a thin fizzy layer against the wall gravity presses into; slightly ragged surface.
- Debugging record (why the sim looks the way it does):
  1. Müller's drift term subtracts unitless density error from a velocity divergence; at 0.83 mm cells it kicked 2.5 cells/substep → scaled by h/dt.
  2. Advecting with v+g·dt *before* projection compresses the pool 0.8 cells/step at this scale → reordered to forces→project→advect.
  3. 30 SOR sweeps cannot carry hydrostatic pressure through an 80-cell column; FLIP retained the error and the pool boiled (median 0.25 m/s at rest) → warm-started multigrid.
  4. Inviscid 2D FLIP keeps shake-induced vortices forever (0.1 m/s rms after 40 s) → grid viscosity; now settles in ≈5 s.
  5. Rest density averaged over surface cells biased it low → interior cells only.

## Known Issues (priority order)
1. **Sim step cost ≈ 11–15 ms on this VM (budget 8.3 ms/step at 120 Hz, one worker core).** Needs a real-device measurement; M7 owns the fix (GPU port or worker optimisation + quality levels picking cellsX/particle count from measured step time). Cheap wins already identified: separation every other step, 2 V-cycles when calm, SIMD-friendly SoA loops.
2. Fluffy free surface: raw fluid-cell count grows ≈3% over a session while grid fill is conserved; surface is ragged by ~1 cell. Surface tension (M3) + the thickness blur (M4) should hide/fix it.
3. Residual particle noise ≈0.02–0.07 m/s at rest (FLIP sampling noise), plus a thin fizzy layer against the loaded wall. Invisible once surface-rendered; check again in M4.
4. Wall gap: particles are clamped one radius (0.25 mm) off the walls, so the dot view shows a thin strip. The M4 surface renderer must extend the fluid to the glass (and M8 adds the meniscus).
5. Sensor sign convention is unverified on real iOS/Android hardware (older WebKit inverted `accelerationIncludingGravity`). Debug overlay has an "invert sensor sign" toggle (persisted). Confirm on device in M9.
6. Headless frame timings are software-GL bound; need a real-GPU metric (device test, or `EXT_disjoint_timer_query_webgl2` where available) before perf budgets can be trusted.
7. Self-signed cert: iOS Safari shows a warning page; for PWA install on iOS a trusted cert (mkcert root installed on the phone, or a tunnel) is needed.
8. Per-frame `postMessage` structured-clones a small stats object in the worker (tiny allocation per frame). Move to SharedArrayBuffer stats when crossOriginIsolated (M7).

NEXT: M3 – apply −(tank accel) as a body force and a spin (Euler + centrifugal) force in the worker (inputs are already plumbed), add surface tension, tune so a hard shake throws water to the far wall; verify with shake/spin screenshots + fill volume.
