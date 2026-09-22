# PROGRESS

Phone-as-a-water-tank: real-time 2D FLIP water in WebGL2, driven by DeviceMotion.

## Milestones
- [x] M1: Project setup, HTTPS dev server, full-screen WebGL2 canvas, start screen, motion permission, gravity vector shown on the debug overlay
- [ ] M2: Basic particle water (CPU/worker), walls, gravity from tilt, drawn as plain dots
- [ ] M3: Sloshing from shakes + swirl from spinning, tuned so it feels physically right
- [ ] M4: Surface drawing (thickness, blur, normals) + refraction + Fresnel reflection
- [ ] M5: Color that deepens with thickness, glow through thin water, highlights, waterline
- [ ] M6: Foam, bubbles, caustics
- [ ] M7: Move the sim to the GPU (or optimize the worker until the budget is met); automatic quality levels
- [ ] M8: Polish: tone mapping, bloom, glass feel, pour-in animation, tap ripples
- [ ] M9: Hardening: context loss, pausing in the background, heat management, testing on real devices
- [ ] M10: Final realism pass: side-by-side critique against reference footage, then fix the 3 weakest visual problems

## Architecture (as of M1)
- `server/dev-server.mjs` – zero-dep HTTPS static server, self-signed cert (SANs: localhost + LAN IPs) auto-generated into `.cert/`. Sends COOP/COEP so SharedArrayBuffer is available for the sim worker.
- `index.html`, `manifest.webmanifest`, `icons/` – full-screen PWA meta (apple-mobile-web-app-capable, viewport-fit=cover, display: fullscreen, orientation: portrait).
- `ui/stage.js` – `#stage` is always device-portrait. Android locks orientation; on iOS the stage is CSS counter-rotated when the viewport rotates, so sensor axes map 1:1 to stage axes.
- `input/motion.js` – DeviceMotion → stage coords (x right, y down, m/s²).
  - gravity: fused `aIG − acceleration`, low-pass τ=60 ms (fallback without `acceleration`: LP τ=220 ms on aIG).
  - tank accel: high-pass (τ=450 ms) linear acceleration, clamped to 30 m/s². Sim must apply **−a** to the water.
  - spin: `rotationRate.alpha` → rad/s, + = clockwise on screen, LP τ=50 ms.
  - Desktop fallback: gravity points from stage centre to the cursor; click-drag = pointer acceleration as tank accel (stage height ≈ 0.15 m).
- `sim/fixed-step.js` – 120 Hz fixed-step accumulator, max 4 steps/frame (drops time rather than spiralling).
- `render/` – WebGL2 context (context-loss listeners), shader helpers with cached uniform locations, backplate baked once per resize into an SRGB8_ALPHA8 texture (future refraction source), linear→sRGB composite.
- `ui/debug.js` – triple-tap any corner (or `D`): fps, frame avg/max, CPU ms, particles, quality, render px, input source/permission, gravity, tank accel, spin, gravity compass, per-pass toggles, sensor-sign toggle.
- `ui/stats.js` – ring-buffer frame stats (no per-frame allocation).
- `verify/` – `lib.mjs` (Playwright + server + synthetic DeviceMotion streaming), `m1.mjs`, `make-icons.mjs`.

## Measurements
### M1 (2026-09-22) – headless Chromium, SwiftShader (software GL), 390×844 @2x
- Console errors: 0. `node verify/m1.mjs` → pass. Screenshots: `verify/M1/`.
- Gravity mapping (synthetic events): upright (0, 9.81); tilt-left 34° (−5.54, 8.10); tilt-right (5.54, 8.10); upside-down (0, −9.81); flat (0, 0). Shake 6 Hz ±20 m/s²: gravity stays (0, 9.81), tank accel peaks 20.2 (cap 30), spin −1.57 rad/s for alpha=+90°/s.
- Desktop: mouse at left edge → g=(−9.81, 0); drag-shake → |a|=11.5 m/s².
- Frame time: avg ~44–51 ms, worst ~183 ms. **Not representative**: an empty clear in this headless SwiftShader env already costs ~23 ms/frame at 780×1688. App CPU time per frame: 0.04 ms.
- Volume: n/a (no water yet).

## Known Issues (priority order)
1. Sensor sign convention is unverified on real iOS/Android hardware (older WebKit inverted `accelerationIncludingGravity`). Debug overlay has an "invert sensor sign" toggle (persisted). Confirm on device in M9.
2. Headless frame timings are software-GL bound; need a real-GPU metric (device test, or `EXT_disjoint_timer_query_webgl2` where available) before perf budgets can be trusted.
3. Self-signed cert: iOS Safari shows a warning page; for PWA install on iOS a trusted cert (mkcert root installed on the phone, or a tunnel) is needed.

NEXT: M2 – FLIP/PIC (95% FLIP) particle sim in a Web Worker with SharedArrayBuffer, solid walls, gravity from `motion.gx/gy`, drawn as plain GL points; add volume-conservation check to verify.
