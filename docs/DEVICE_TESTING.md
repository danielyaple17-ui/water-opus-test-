# Device testing

Everything in `verify/` runs headless on software GL (SwiftShader), which can
check correctness but not real-device performance or sensor behaviour. This is
the checklist for a real iPhone / Android phone.

## 1. Serve it over HTTPS on the LAN

```
npm run dev            # prints https://<lan-ip>:8443/
```

The dev server's certificate is self-signed. Safari shows a warning page;
choose *Show Details → visit this website*. For a warning-free setup (needed
for Add to Home Screen on iOS), either:

- install an mkcert root on the phone (`mkcert -install`, AirDrop
  `rootCA.pem`, then *Settings → General → About → Certificate Trust Settings*),
  and point the server at the mkcert cert/key in `.cert/`, or
- tunnel: `npx cloudflared tunnel --url http://localhost:<HTTP_PORT>` (start the
  dev server with `HTTP_PORT=8080` as well).

## 2. Benchmark (numbers the project is waiting on)

Open `https://<host>/?bench=1` → *Tap to fill* → leave the phone flat on a
table for ~90 s. The app pins each level (Ultra → High → Med → Low), measures
a calm and a shaken phase, then opens the debug overlay with a JSON report and
a **Copy benchmark** button. Paste it into `PROGRESS.md` (M9 section).

Budget (from the spec): 60 fps steady at High on iPhone 13+ → `frameAvgMs ≈
16.7`, `frameP95Ms ≤ 20`, `simRatio ≥ 0.98`, and `stepMs ≤ 8.3` (one 120 Hz
fixed step must fit its slot on one core).

## 3. Sensors

1. Upright portrait: the water sits at the bottom. Tilt left: the surface stays
   level with the real horizon. If the water goes the *wrong* way, open the
   overlay (triple-tap a corner) and enable **invert sensor sign** (persisted).
   Please record which device and browser needed it.
2. Rotate the phone to landscape and upside down: the water must always fall
   toward the real floor (the stage counter-rotates if Safari rotates the page).
3. Quick jerk to the right: water slams into the left wall.
4. Spin the phone flat on the table: the water lags and swirls.
5. Overlay → `gravity` ≈ 9.8 at rest, `tank accel` ≈ 0 at rest.

## 4. Lifecycle / robustness

- Switch apps for 30 s and come back: the water resumes where it was (no
  fast-forward, no burst).
- Lock the screen for a minute, unlock: same.
- Leave it running 10 minutes with occasional shakes: no water lost (overlay
  `outside / fill` stays at `0 / ~constant`), quality may drop a level if the
  phone heats up (overlay shows `thermal: …` as the reason).
- Two-finger tap: pours again. Single tap: splash.

## 5. Remote debugging

- iPhone: *Settings → Safari → Advanced → Web Inspector* on the phone, then
  Safari on a Mac → *Develop → <phone> → page*. Timelines → *JavaScript &
  Events* and *Rendering Frames* give real CPU/GPU frame times.
- Android: `chrome://inspect` on desktop Chrome with USB debugging enabled;
  the Performance panel records GPU time per frame.

## 6. What to write back

Device, OS and browser version, the benchmark JSON, whether the sensor sign
needed inverting, and anything that looked wrong (screenshots welcome).
