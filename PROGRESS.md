# PROGRESS

Phone-as-a-water-tank: real-time 2D FLIP water in WebGL2, driven by DeviceMotion.

## Milestones
- [x] M1: Project setup, HTTPS dev server, full-screen WebGL2 canvas, start screen, motion permission, gravity vector shown on the debug overlay
- [x] M2: Basic particle water (CPU/worker), walls, gravity from tilt, drawn as plain dots
- [x] M3: Sloshing from shakes + swirl from spinning, tuned so it feels physically right
- [x] M4: Surface drawing (thickness, blur, normals) + refraction + Fresnel reflection
- [ ] M5: Color that deepens with thickness, glow through thin water, highlights, waterline
- [ ] M6: Foam, bubbles, caustics
- [ ] M7: Move the sim to the GPU (or optimize the worker until the budget is met); automatic quality levels
- [ ] M8: Polish: tone mapping, bloom, glass feel, pour-in animation, tap ripples
- [ ] M9: Hardening: context loss, pausing in the background, heat management, testing on real devices
- [ ] M10: Final realism pass: side-by-side critique against reference footage, then fix the 3 weakest visual problems

## Architecture (as of M4)
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
  - Tank-frame forces (M3): body accel = g − a_tank (worker); spin ω (+ = clockwise on screen) adds Coriolis as an exact velocity rotation by −2ω·dt (energy-neutral), centrifugal ω²r and Euler α(r_y, −r_x) about the tank centre; α = smoothed dω/dt in the worker.
  - Surface tension (M3): ghost-fluid Laplace jump. κ from a twice-[1 2 1]-blurred liquid fraction min(ρ/ρ0,1), n = −∇F/|∇F|, κ = ∇·n clamped to 1/h; air cells next to fluid get q = σκ·dt/(ρh²) (moved into the fluid rhs), walls copy F (90° contact). σ_eff = 0.003 N/m: explicit ST is only stable for dt < ≈1 ms at the real 0.072 at this grid; 0.02+ ejects spray instead of rounding.
  - Diagnostics: `fluidCells`, `fillVolume` = Σ min(ρ/ρ0, 1) (the volume metric used for pass/fail).
- `sim/worker.js` + `sim/client.js` – worker also reports water centre of mass and angular momentum (verification). module worker owns sim + clock; main posts {dt, g, a, spin, free buffer}, worker returns x,y (tank-normalised), vx,vy as a transferred Float32Array. Two ArrayBuffers ping-pong; one request in flight.
- `src/main.js`: `?cells=N` overrides the grid resolution (16–256; default 84).
- `render/particles.js` – GL_POINTS dots coloured by speed (debug view, `particles` pass; its VBO feeds the surface splat).
- `render/surface.js` (M4) – screen-space water:
  1. Thickness: Gaussian point splats (radius 4.4 r), additive into an R16F target at 0.5× canvas (RGBA8 fallback if float targets are unavailable), normalised by the analytic hex-lattice kernel sum so bulk ≈ 1. Particle domain [r, 1−r] is stretched onto the screen, and near-wall particles are also splatted mirrored across each wall (5 instances) so the water meets the glass.
  2. Bilateral blur: separable, σs = 5 texels, σr = 0.4, 2 H+V passes (`sigmaS`, `sigmaR`, `blurPasses`).
  3. Composite: **level-set edge**. The blurred field's 0.5 iso-line is the liquid boundary. Signed distance d = (T − 0.5)/|∇T| (T saturated at 1 so bulk density variation can't tilt normals) drives a crisp AA mask and a circular edge profile of width `rimCss` = 5 CSS px for the normal. Refraction of the backplate along n.xy × thickness with ±3% per-channel dispersion, Beer–Lambert transmittance, Schlick Fresnel (F0 0.02) reflection of a procedural studio (overhead softbox, side strips, key) that stays aligned to real-world up from gravity. Separate cheap blit when water is off.
- `render/renderer.js` – backplate redesigned in M4 (out-of-focus softbox spill from above, dim warm bokeh glow, mottled frosted texture + grain) so refraction is readable. Passes: backplate, water, blur, refraction, reflection, particles.
- `render/` – WebGL2 context (context-loss listeners), shader helpers with cached uniform locations, backplate baked once per resize into an SRGB8_ALPHA8 texture (future refraction source), linear→sRGB composite.
- `ui/debug.js` – triple-tap any corner (or `D`): fps, frame avg/max, CPU ms, particles, quality, render px, input source/permission, gravity, tank accel, spin, gravity compass, per-pass toggles, sensor-sign toggle.
- `ui/stats.js` – ring-buffer frame stats (no per-frame allocation).
- `verify/` – `lib.mjs` (Playwright + server + synthetic DeviceMotion streaming), `m1.mjs`…`m4.mjs`, `tune-surface.mjs` (renders a frozen scene under several surface parameter sets into `verify/tune/`, git-ignored), `make-icons.mjs`.

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

### M3 (2026-09-22) – headless Chromium + SwiftShader, 390×844 @1x, `?cells=48` (6,952 particles)
- Why 48 cells / 1×: sensor events are wall-clock, so the sim must keep ~real time for slosh timing to mean anything; at 84 cells @2x it ran at 0.27× real time here (4 steps per SwiftShader frame). At 48 cells @1x: real-time ratio 0.55–0.80.
- `node verify/m3.mjs` → pass, 0 console errors. Screenshots `verify/M3/` (jerk peak, after jerk, hard shake, resettle, tilt L/R, upside-down, upright, CCW twist, after twist, final, desktop drag).
- Jerk right (+25 m/s² 100 ms, −25 m/s² 100 ms): water centre of mass x 0.500 → **0.372** (piles on the far/left wall, climbs it to the top), then thrown right to 0.560 on the stop. 4 Hz ±22 m/s² shake: CoM x swings over 0.288 of the width, breaking waves + spray. Tilt ±34°: CoM x 0.431 / 0.569. Flip: CoM y 0.219. CCW twist 180°/s upright: mean angular momentum +8.2e-3 (water lags → clockwise relative swirl ✓), curling wave pours around the tank. Desktop drag right: CoM x 0.497 → 0.389 (water sloshes left ✓).
- Volume: 6,952 particles constant, 0 outside in every phase; grid fill settled 2140.0 → 2141.1 (**+0.05%**), worst transient −3.7% mid-shake (spray cells count partially).
- Frame: avg 21–23 ms, worst 83 ms (SwiftShader @1x). Worker step at 48 cells: 5.3–6.6 ms avg, 10 ms while shaking (3 substeps), worst 47 ms.
- Node, 84 cells: tilt-release slosh period 0.31 s vs linear theory 2π/√(gk·tanh(kd)) = 0.30 s for this 6.9 cm × 6.8 cm-deep tank; envelope decays ≈3× in 5 s (ν = 2e-5). Jerk at 84 cells: 53% of the water in the left quarter at 0.1 s, left wall run-up to the ceiling, settles in ≈0.7 s (wave breaking). Flat spin to 2π rad/s: relative angular momentum −46% of rigid counter-rotation during spin-up, then centrifugal pinning into the corners makes it co-rotate (correct for a partly-filled rectangular box). Zero-g square blob rounds to a disk in ≈1 s at σ_eff = 0.002–0.005 (max/mean radius 1.83 → 1.55; disk = 1.5); stable up to 0.072 but ≥0.02 throws spray.
- Visual (honest): motion is convincing and energetic: overturning waves, run-up, lagging swirl. Still dots, so no realism judgement until M4. The surface stays ragged by ~1 particle at rest, and the airborne spray is sparse single dots.

### M4 (2026-09-23) – headless Chromium + SwiftShader, 390×844 @2x, 84 cells (21,684 particles)
- `node verify/m4.mjs` → pass, 0 console errors. Screenshots `verify/M4/`: poses 01–07 with the surface on, plus 09 dots-only, 10 no-blur, 11 no-refraction, 12 no-reflection, 13 overlay. Render target: R16F float, 390×844 thickness buffer.
- Volume: 21,684 particles constant, 0 outside in every phase; grid fill settled 6635.0 → 6659.5 (**+0.37%**), worst transient 2.2% (mid-shake).
- Frame time: **not measurable here**: SwiftShader takes 480–650 ms/frame with the surface pipeline at 780×1688 (and jumps around by ±100 ms between runs). To keep the sim meaningful, the test simulates with the water pass off and switches it on only for screenshots. Analytic GPU load at iPhone-13 native res (1170×2532, thickness at 585×1266): splat ≈ 21.7k × ~450 px, blur 4 × 21 taps × 0.74 M texels ≈ 62 M fetches, composite 2.96 M px × 8 fetches ≈ 24 M. That's well inside an A15's budget (estimate ~1.5–3 ms), but it **must be measured on a device** (M7/M9).
- Sim fix found via rendering: P2G/density/G2P clamped the upper interpolation index to n−2, so right-wall cells got the wall's weight and left-wall cells lost it. That left a sparse, fizzy strip only at the left wall (visible in M2 dots, and as edge marks once surface-rendered). Now clamped to n−1: wall strips 148/133 particles vs ~130 interior, calm rms 0.015 m/s. Deterministic jerk test unchanged (54% of water in left quarter at 0.1 s). `verify/m3.mjs` re-run: pass (jerk CoM 0.362, fill +0.18%); it now renders dots so SwiftShader keeps ~0.7× real time.
- Iterations: (1) thickness-as-height normals with light blur gave a wobbly "pencil line" surface; (2) heavy blur smoothed the shape but flattened the edge slope (no rim, fuzzy edge); (3) the level-set edge decouples shape smoothing from edge sharpness and fixed both; (4) saturating T before the gradient removed dashes along the walls.
- Visual (honest, vs the macro-photo benchmark): now reads as *liquid*, with smooth, rounded, lens-rimmed tongues and drops, a crisp antialiased silhouette, and a softbox glint on edges facing world-up. **Not** photoreal yet: the body is a flat dark teal barely separated from the backplate, the rim is a thin grey line that breaks into dashes where the reflection misses the lights, the waterline shows a small stair-step ripple (~20 px) from particle-scale noise, and there's no depth colour, glow, foam or caustics (M5/M6).

## Known Issues (priority order)
1. **Sim step cost ≈ 11–15 ms on this VM (budget 8.3 ms/step at 120 Hz, one worker core).** Needs a real-device measurement; M7 owns the fix (GPU port or worker optimisation + quality levels picking cellsX/particle count from measured step time). Cheap wins already identified: separation every other step, 2 V-cycles when calm, SIMD-friendly SoA loops.
2. Waterline stair-step ripple (~20 CSS px wavelength, 1–2 px amplitude) from particle-scale surface noise survives the σs=5 blur. Options: stronger surface tension, surface-aligned (anisotropic) smoothing of the level set, or ellipsoid splats (Yu & Turk).
3. Rim/meniscus is a thin dashed grey line (reflection only catches lights on part of the edge). M5 "bright edge line along the waterline" should replace it with a proper meniscus highlight.
4. Fluffy/ragged free surface (~1 particle) remains after adding surface tension (σ_eff is capped by explicit stability). The M4 level-set blur hides most of it (see 2b).
5. Residual particle noise ≈0.02–0.07 m/s at rest (FLIP sampling noise), plus a thin fizzy layer against the loaded wall. Invisible once surface-rendered; check again in M4.
6. `verify/m3.mjs` jerk check is timing-sensitive (CoM min 0.36–0.43 across runs vs threshold 0.42) because the 100 ms pulse is wall-clock and the headless event loop is loaded. Drive the pulse in sim time.
7. Sim speed at 84 cells can't be exercised in real time headlessly; dynamic checks run at 48 cells. Re-check the feel at 84+ cells on a device (M9).
8. Sensor sign convention is unverified on real iOS/Android hardware (older WebKit inverted `accelerationIncludingGravity`). Debug overlay has an "invert sensor sign" toggle (persisted). Confirm on device in M9.
9. Headless frame timings are software-GL bound; need a real-GPU metric (device test, or `EXT_disjoint_timer_query_webgl2` where available) before perf budgets can be trusted.
10. Self-signed cert: iOS Safari shows a warning page; for PWA install on iOS a trusted cert (mkcert root installed on the phone, or a tunnel) is needed.
11. Per-frame `postMessage` structured-clones a small stats object in the worker (tiny allocation per frame). Move to SharedArrayBuffer stats when crossOriginIsolated (M7).
12. (Fixed in M4 render) Wall gap: surface splat stretches [r, 1−r] to the screen and mirrors near-wall particles; the dot view still shows the gap (debug only). M8 adds the meniscus curve.

NEXT: M5 – water colour: thickness/depth-based blue-green absorption + in-scatter, faint glow through thin sheets and crests, bright specular highlights, and a proper bright waterline/meniscus line (fixes Known Issue 2c); verify poses + pass toggles + volume.
