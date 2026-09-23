# PROGRESS

Phone-as-a-water-tank: real-time 2D FLIP water in WebGL2, driven by DeviceMotion.

## Milestones
- [x] M1: Project setup, HTTPS dev server, full-screen WebGL2 canvas, start screen, motion permission, gravity vector shown on the debug overlay
- [x] M2: Basic particle water (CPU/worker), walls, gravity from tilt, drawn as plain dots
- [x] M3: Sloshing from shakes + swirl from spinning, tuned so it feels physically right
- [x] M4: Surface drawing (thickness, blur, normals) + refraction + Fresnel reflection
- [x] M5: Color that deepens with thickness, glow through thin water, highlights, waterline
- [x] M6: Foam, bubbles, caustics
- [x] M7: Move the sim to the GPU (or optimize the worker until the budget is met); automatic quality levels
- [ ] M8: Polish: tone mapping, bloom, glass feel, pour-in animation, tap ripples
- [ ] M9: Hardening: context loss, pausing in the background, heat management, testing on real devices
- [ ] M10: Final realism pass: side-by-side critique against reference footage, then fix the 3 weakest visual problems

## Architecture (as of M7)
- `server/dev-server.mjs` – zero-dep HTTPS static server, self-signed cert (SANs: localhost + LAN IPs) auto-generated into `.cert/`. Sends COOP/COEP so SharedArrayBuffer is available for the sim worker.
- `index.html`, `manifest.webmanifest`, `icons/` – full-screen PWA meta (apple-mobile-web-app-capable, viewport-fit=cover, display: fullscreen, orientation: portrait).
- `ui/stage.js` – `#stage` is always device-portrait. Android locks orientation; on iOS the stage is CSS counter-rotated when the viewport rotates, so sensor axes map 1:1 to stage axes.
- `input/motion.js` – DeviceMotion → stage coords (x right, y down, m/s²).
  - gravity: fused `aIG − acceleration`, low-pass τ=60 ms (fallback without `acceleration`: LP τ=220 ms on aIG).
  - tank accel: high-pass (τ=450 ms) linear acceleration, clamped to 30 m/s². Sim must apply **−a** to the water.
  - spin: `rotationRate.alpha` → rad/s, + = clockwise on screen, LP τ=50 ms.
  - Desktop fallback: gravity points from stage centre to the cursor; click-drag = pointer acceleration as tank accel (stage height ≈ 0.15 m).
- Performance (M7): the multigrid is restricted to the fluid bounding box on every level and stops early once max|r| ≤ 2% of max|rhs| (1–3 V-cycles). Substeps come from how many particles exceed the 1- and 2-substep travel limits (tolerating 0.2% outliers), not from the single fastest particle. P2G is a single pass for u and v plus cell marking, and redundant prevU copies were removed. A CPU worker was kept over a GPU port: stable, measured, and the quality levels guarantee the budget.
- `FlipSim.resampleFrom(old, opts)` (M7): rebuilds the sim at a new grid resolution from the old particles (position mapped through the interior, velocity and foam copied, jitter when upsampling), with an analytic hex rest density, so quality changes keep the water.
- `src/quality.js` (M7): Low / Med / High / Ultra = 48 / 64 / 84 / 84 cells (≈7k / 12.5k / 21.7k / 21.7k particles), render scale 0.5 / 0.7 / 0.85 / 1.0 × DPR, blur passes 1 / 2 / 2 / 3, depth-field passes 2 / 2 / 3 / 3. The controller uses 2 s windows of frame time vs the measured display period (60/90/120 Hz) and of the sim's real-time ratio. It downgrades on frame > 1.25 × period or sim < 0.9× real time, upgrades after 8 s of headroom (frame < 1.08 × period and sim > 0.98×), has a 5 s cooldown, won't retry a level it fell from for 60 s, and has a thermal guard (frame EMA +25% over the level's 30 s baseline → drop and cap for 5 min). Slow frames are clamped to 1 s, not discarded. `?q=low|med|high|ultra` pins a level, keys 1–4 force one, `A` or the overlay toggle restores auto; the overlay shows the level and the reason for the last change.
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
- Foam (M6, `sim/flip.js`): per-particle foam ∈ [0,1], permuted with the spatial sort. Generated by the particle's actual acceleration |dv/dt| above max(60, 1.5·|body force|) m/s² (gain 1/220) and by fast spray (speed > 0.3 m/s in cells < 35% of rest density), decaying with τ = 0.9 s. Water that is only resting or sloshing under the body force stays clear. (Using |dv/dt − f| was wrong: resting water scores |g|.)
- `sim/bubbles.js` (M6): ≤256 bubbles in a fixed pool. They spawn from random particles with impact > 45 m/s² whose cell and the cell two cells "above" (against the body force) are liquid, ≤6 per step. Radius 0.25–1.15 mm, carried by the bilinear grid velocity plus a terminal rise min(0.25, 180·r) m/s against the body force. They pop on reaching air or after 8 s.
- `sim/worker.js` + `sim/client.js` – output per particle is now (x, y, foam, speed), followed by 256 × (x, y, r, alpha) bubbles; stats add bubbles, activity (rms speed) and foamSum. worker also reports water centre of mass and angular momentum (verification). module worker owns sim + clock; main posts {dt, g, a, spin, free buffer}, worker returns x,y (tank-normalised), vx,vy as a transferred Float32Array. Two ArrayBuffers ping-pong; one request in flight.
- `src/main.js`: `?cells=N` overrides the grid resolution (16–256; default 84).
- `render/particles.js` – GL_POINTS dots coloured by speed (debug view, `particles` pass; its VBO feeds the surface splat).
- `render/surface.js` (M4) – screen-space water:
  1. Thickness: Gaussian point splats (radius 4.4 r), additive into an R16F target at 0.5× canvas (RGBA8 fallback if float targets are unavailable), normalised by the analytic hex-lattice kernel sum so bulk ≈ 1. Particle domain [r, 1−r] is stretched onto the screen, and near-wall particles are also splatted mirrored across each wall (5 instances) so the water meets the glass.
  2. Bilateral blur: separable, σs = 5 texels, σr = 0.4, 2 H+V passes (`sigmaS`, `sigmaR`, `blurPasses`).
  3. Composite: **level-set edge**. The blurred field's 0.5 iso-line is the liquid boundary. Signed distance d = (T − 0.5)/|∇T| (T saturated at 1 so bulk density variation can't tilt normals) drives a crisp AA mask and a circular edge profile of width `rimCss` = 5 CSS px for the normal. Refraction of the backplate along n.xy × thickness with ±3% per-channel dispersion, Beer–Lambert transmittance, Schlick Fresnel (F0 0.02) reflection of a procedural studio (overhead softbox, side strips, key) that stays aligned to real-world up from gravity. Separate cheap blit when water is off.
  4. (M5) Depth field: thickness → 4-tap downsample to 1/8 canvas (coverage, saturated at 1) → 3 passes of wide Gaussian (σ 6 texels ≈ 48 canvas px/pass). B ≈ 0.5 at the surface, → 1 deep in the bulk, < 0.5 in drops/tongues/sheets. It drives: Beer–Lambert transmittance of the refracted backplate over a path of 0.5–3.1 units (σa = 0.62/0.20/0.11, so deep water goes blue-green); in-scatter of the overhead light, aqua (0.009, 0.040, 0.046) just under the surface → dark teal (0.0008, 0.0075, 0.0125) deep, cut 65% in thin water so sheets stay clear; glow through thin water, brightest just inside the edge. Highlights: Blinn key glint (power 380, ×7), a waterline hairline ~0.9 CSS px inside the edge plus a silvery TIR band (0–9 px), strongest on edges whose outward normal faces world-up. Passes: `color`, `glow`, `highlights`.
  5. (M6) Foam: the splat target is RG16F (R thickness, G foam-weighted thickness, both blurred). Foam value = G/R. Rendered as a milky haze plus cellular bubble clusters (7 and 4 CSS-px cells, presence ∝ foam), lit from above.
  6. (M6) Caustics: for each water pixel, march up to 24 × 10 CSS px against gravity through the depth field to the surface, with the crossing interpolated so the distance is continuous. The surface slope there shears, and the distance h sets and fades (e^(−h/90), zero before the march limit), a division-free animated Voronoi-edge caustic in world-aligned coordinates. Its speed scales with the water's activity. The caustic light is *added* to the refracted back wall. Pass `caustics`.
  7. (M6) `render/bubbles.js`: bubble sprites (thin bright rim, clear interior, specular dot toward world-up) alpha-blended after the composite, in display space until the M8 HDR buffer. Pass `bubbles`.
  - Shader hygiene (M5 bugs): GLSL `smoothstep(e0 > e1)` and `pow(negative, y)` are undefined (SwiftShader returned garbage, i.e. black specks in spray), and far-outside pixels overflowed exp(): inf·0 = NaN in mix. Fixed: ordered edges, explicit squares, clamp d ≥ 0, early-out when mask = 0.
- `render/renderer.js` – backplate redesigned in M4 (out-of-focus softbox spill from above, dim warm bokeh glow, mottled frosted texture + grain) so refraction is readable. Passes: backplate, water, blur, refraction, reflection, particles.
- `render/` – WebGL2 context (context-loss listeners), shader helpers with cached uniform locations, backplate baked once per resize into an SRGB8_ALPHA8 texture (future refraction source), linear→sRGB composite.
- `ui/debug.js` – triple-tap any corner (or `D`): fps, frame avg/max, CPU ms, particles, quality, render px, input source/permission, gravity, tank accel, spin, gravity compass, per-pass toggles, sensor-sign toggle.
- `ui/stats.js` – ring-buffer frame stats (no per-frame allocation).
- `verify/` – `lib.mjs` (Playwright + server + synthetic DeviceMotion streaming), `m1.mjs`…`m7.mjs`, `tune-surface.mjs` (renders a frozen scene under several surface parameter sets into `verify/tune/`, git-ignored), `make-icons.mjs`.

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

### M5 (2026-09-23) – headless Chromium + SwiftShader, 390×844 @2x, 84 cells
- `node verify/m5.mjs` → pass, 0 console errors. Screenshots `verify/M5/`: poses 01–07, plus 09 no-colour, 10 no-glow, 11 no-highlights, 12 M4 look (all three off), 13 overlay.
- Volume: 21,684 particles constant, 0 outside; grid fill settled 6635.0 → 6651.1 (**+0.24%**), worst transient 6.1% (mid-shake: spray cells count partially, recovers).
- Frame time: SwiftShader 520–660 ms/frame (not representative, see M4). The extra GPU work is small: depth field at 1/8 res ≈ 49×106 texels × (4 + 6 passes × 21 taps) ≈ 0.7 M fetches, plus 1 extra texture fetch and ~40 ALU ops per composite pixel.
- Visual (honest): biggest jump so far. The calm pose reads as a lit tank of water: a bright meniscus hairline over a silvery band, aqua just below the surface deepening to dark teal, and a clear surface-to-depth gradient that follows world-up (correct when inverted). Splashes read as liquid: rounded rim-lit tongues, an air pocket inside a curling crest, clearer thin sheets. Against the macro-photo benchmark it still looks CG: (a) every edge gets the same glossy, slightly *jelly-like* rim, where real water edges vary (sharp dark refraction lines, blown-out specular, thin bright lines); (b) the interior is smooth and flat with no internal light structure (caustics, M6); (c) the waterline still shows the small stair-step ripple; (d) no bubbles/foam in the splash (M6).

### M6 (2026-09-23) – headless Chromium + SwiftShader, 390×844 @2x, 84 cells
- `node verify/m6.mjs` → pass, 0 console errors. Screenshots `verify/M6/`: poses 01–07 plus 06b (0.4 s after the shake), 09 no-caustics, 10 no-foam, 11 no-bubbles, 12 M5 look, 13 overlay.
- Volume: 21,684 particles constant, 0 outside; grid fill settled 6635.0 → 6669.0 (**+0.51%**), worst transient 4.4% mid-shake.
- Foam/bubbles (browser run): at rest mean foam 0.0004 and 0 bubbles; hard shake mean foam 0.187 and 15 bubbles; 0.4 s after, 0.085 and 6; resettled 0.0005 and 0. Node 4 Hz ±22 m/s² shake: ≈30–45 bubbles alive, 70% of particles foamy at the peak, clear ≈2 s after stopping.
- Cost: foam update 0.26 ms/step, bubbles 0.014 ms/step (Node, this VM). Worker step during violent shaking is ≈28 ms here (3 substeps, Known Issue 1), unchanged by M6. SwiftShader frame 880 ms with everything on (not representative). GPU additions: RG instead of R targets, and at most 24 depth-field fetches plus 2×9 Voronoi cells per water pixel for caustics, plus foam cells only where foam > 0.
- Iterations: foam as thin cell walls looked like a crackle glaze; tiny bubbles read as dust; ring-heavy bubbles read as bubble-wrap. Settled on a milky haze with sparse, soft bubble clusters. Caustics: multiplying a dark backplate was invisible → additive light; 14 px march quantisation and a hard cut-off made visible steps → an interpolated crossing plus a smooth fade; the classic iterated-sin caustic produced 0/0 NaN streaks → a division-free Voronoi network.
- Visual (honest): the splash now reads as aerated water (milky froth with small bubbles over clear water), bubbles rise and pop, and light shafts/caustics play under the surface and follow its tilt. Weak points vs a photo: (a) the caustics look like fibrous strands or light shafts rather than the webbed network a real back wall shows; (b) dense foam is grey and flat rather than bright white, and its texture is screen-space, so it doesn't move with the water; (c) the edge-rim and stair-step issues from M4/M5 remain.

### M7 (2026-09-23)
- Worker step, Node on this VM (≈3× slower than a phone-class core), calm / 4 Hz ±22 m/s² shake:
  - before M7 at 84 cells: 14.0 / 29.3 ms (calm used 1.47 substeps because of outliers; MG 4.0 ms per solve)
  - after M7: **48 cells 3.3 / 7.5 ms, 64 cells 5.9 / 14.6 ms, 84 cells 10.7 / 27.0 ms** (calm substeps 1.04, MG 2.3 ms). 104 cells: 32 / 43 ms, and noisy at rest (rms 0.15 m/s), so it's not used.
  - Tried and reverted: CFL 6 cells / max 2 substeps. Shaking dropped to 22 ms, but the calm pool got noisier (1.63 substeps) and volume drifted −1.56%.
  - Budget reading: a 120 Hz fixed step needs ≤ 8.3 ms/step on one core. On this VM that holds for Low (calm and shaking) and Med (calm). Scaling by ~2.5–3× for an A15, High calm ≈ 4 ms and High violent shake ≈ 9–11 ms (brief slow-motion during the hardest shakes). The controller drops to Med if the sim can't keep real time. **Needs device confirmation (M9).**
- `node verify/m7.mjs` → pass, 0 console errors. Screenshots `verify/M7/`: auto-settled, poses 02–07 at the settled level, and each forced level (10-level-*-settled, 11-level-*-shake).
  - Auto controller on SwiftShader (300–500 ms frames): High → Med at 6 s → Low at 15 s, then held (floor) for 55 s. 2 changes, 0 oscillations.
  - Volume across resampling: High → Low → High, settled fill averaged over 1 s of sim: 6619.7 → 6625.2 (**+0.08%**); Low fills 2.2% less of the tank by the grid metric (partial surface cells at the coarser grid, not lost water). Node round trip 84 → 48 → 104 → 64 → 84: −0.25%, 0 leaks.
  - Poses at the pinned level (Low): 6,952 particles constant, 0 outside, fill 2114.4 → 2116.3 (**+0.09%**).
  - Per level in browser (SwiftShader, worker contends with software GL): step calm/shake Low 5.5/10.6, Med 8.5/17.6, High 17.0/40.2, Ultra 17.4/34.0 ms; render px 390×844 / 546×1182 / 663×1435 / 780×1688. Frame 144–405 ms (software GL, not meaningful).
- Visual: Low is noticeably softer (coarser shapes, fewer small drops) but still clearly water; Ultra and High show air pockets, thin sheets and detached drops.

## Known Issues (priority order)
1. **Device performance unmeasured.** This VM runs High at 10.7 ms calm / 27 ms violent shake per step. The quality controller keeps the budget by downgrading, but whether an iPhone 13 holds High needs a real device (M9). Remaining sim hot spots: separation 3.6 ms (2 passes), MG 2.3 ms/solve, G2P 1.2 ms. Next levers: separation once per step when calm, SIMD/WASM for P2G/G2P, or a GPU port.
2. Waterline stair-step ripple (~20 CSS px wavelength, 1–2 px amplitude) from particle-scale surface noise survives the σs=5 blur. Options: stronger surface tension, surface-aligned (anisotropic) smoothing of the level set, or ellipsoid splats (Yu & Turk).
3. 104-cell grid is noisy at rest (rms 0.15 m/s vs 0.03 at 84), probably viscosity/drift/CFL constants tuned for 84. Until fixed, Ultra uses 84 cells.
4. Edge look is uniform and slightly jelly-like: the same glossy rim everywhere. Needs variation, e.g. dark refraction band just inside the edge (backplate magnified/inverted), rim strength tied to curvature, sharper and rarer speculars. M10 candidate.
5. Fluffy/ragged free surface (~1 particle) remains after adding surface tension (σ_eff is capped by explicit stability). The M4 level-set blur hides most of it (see 2b).
6. Foam texture is screen-space: its bubble cells don't travel with the water (they only drift in place). Fix: advect a foam UV/offset field, or splat per-particle bubble sprites for dense foam. Caustics look like strands, not a network. Both M10 candidates.
7. Residual particle noise ≈0.02–0.07 m/s at rest (FLIP sampling noise), plus a thin fizzy layer against the loaded wall. Invisible once surface-rendered; check again in M4.
8. `verify/m3.mjs` jerk check is timing-sensitive (CoM min 0.36–0.43 across runs vs threshold 0.42) because the 100 ms pulse is wall-clock and the headless event loop is loaded. Drive the pulse in sim time.
9. Sim speed at 84 cells can't be exercised in real time headlessly; dynamic checks run at 48 cells. Re-check the feel at 84+ cells on a device (M9).
10. Sensor sign convention is unverified on real iOS/Android hardware (older WebKit inverted `accelerationIncludingGravity`). Debug overlay has an "invert sensor sign" toggle (persisted). Confirm on device in M9.
11. Headless frame timings are software-GL bound; need a real-GPU metric (device test, or `EXT_disjoint_timer_query_webgl2` where available) before perf budgets can be trusted.
12. Self-signed cert: iOS Safari shows a warning page; for PWA install on iOS a trusted cert (mkcert root installed on the phone, or a tunnel) is needed.
13. Per-frame `postMessage` structured-clones a small stats object in the worker (tiny allocation per frame). Move to SharedArrayBuffer stats when crossOriginIsolated (M7).
14. (Fixed in M4 render) Wall gap: surface splat stretches [r, 1−r] to the screen and mirrors near-wall particles; the dot view still shows the gap (debug only). M8 adds the meniscus curve.

NEXT: M8 – polish: move composite + bubbles into a linear HDR buffer, ACES/AgX tone mapping, highlight-only bloom, glass feel (vignette, faint glass reflections, meniscus curving up at the walls), pour-in start animation, tap-to-splash ripple and two-finger reset; verify poses + pour-in + tap + volume.
