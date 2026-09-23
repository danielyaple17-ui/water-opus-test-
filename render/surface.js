// Screen-space water surface (M4).
//
//  1. Thickness: every particle is splatted as a Gaussian blob (additive) into a
//     reduced-resolution float target. The field is normalised so bulk water ≈ 1.
//     Particles near a wall are also splatted mirrored across it (instanced), so
//     the water reaches the glass instead of fading out one blob-radius early.
//  2. Edge-aware blur: separable bilateral filter (spatial Gaussian × range
//     weight on thickness), ping-ponged; the range term keeps separate drops and
//     the air/water edge from smearing into each other.
//  3. Composite: normals from the blurred thickness treated as a height field,
//     refraction of the backplate (with slight dispersion), Beer–Lambert
//     transmittance, Schlick Fresnel reflection of a procedural studio
//     environment whose lights stay aligned with real-world up (from gravity).

import { program, FULLSCREEN_VS, drawFullscreen } from './gl.js';

const SPLAT_VS = `#version 300 es
layout(location = 0) in vec4 aParticle;   // x, y, foam, speed
uniform float uPointSize;   // blob diameter in target pixels
uniform vec2 uRadiusN;      // particle radius as fraction of tank (x, y)
out float vW;
out float vFoam;
void main() {
  // Particles live in [r, 1-r]; stretch that onto [0, 1] so water touches the glass.
  vec2 p = (aParticle.xy - uRadiusN) / (1.0 - 2.0 * uRadiusN);
  // Instance 0 = the particle, 1..4 = mirror images across left/right/top/bottom.
  int m = gl_InstanceID;
  vW = 1.0;
  vFoam = aParticle.z;
  if (m == 1) p.x = -p.x;
  else if (m == 2) p.x = 2.0 - p.x;
  else if (m == 3) p.y = -p.y;
  else if (m == 4) p.y = 2.0 - p.y;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  // Mirror images only matter within a blob radius of the wall.
  if (m > 0) {
    vec2 q = abs(gl_Position.xy);
    if (max(q.x, q.y) > 1.0 + 0.12) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
  gl_PointSize = uPointSize;
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in float vW;
in float vFoam;
uniform float uScale;
out vec4 outT;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  // Gaussian, ~0 at the sprite edge. R = thickness, G = foam-weighted thickness.
  float w = (exp(-4.0 * r2) - 0.0183) * uScale * vW;
  outT = vec4(w, w * vFoam, 0.0, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outT;
uniform sampler2D uSrc;
uniform vec2 uDir;       // texel step (one axis)
uniform float uSigmaR;   // range sigma in thickness units
uniform float uSigmaS;   // spatial sigma in texels (taps reach 2.5σ, max 10)
void main() {
  vec2 c2 = texture(uSrc, vUv).rg;
  float c = c2.r;
  vec2 sum = c2;
  float wsum = 1.0;
  int R = int(min(10.0, ceil(2.5 * uSigmaS)));
  for (int i = 1; i <= 10; i++) {
    if (i > R) break;
    float ws = exp(-float(i * i) / (2.0 * uSigmaS * uSigmaS));
    for (int s = -1; s <= 1; s += 2) {
      vec2 t = texture(uSrc, vUv + uDir * float(i * s)).rg;
      float dr = (t.r - c) / uSigmaR;   // range weight from thickness only
      float w = ws * exp(-0.5 * dr * dr);
      sum += t * w;
      wsum += w;
    }
  }
  outT = vec4(sum / wsum, 0.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBack;    // linear (sRGB texture)
uniform sampler2D uThick;   // blurred thickness
uniform vec2 uTexel;        // thickness texel size
uniform vec2 uUp;           // real-world up in screen space (GL, y up)
uniform float uAspect;      // width / height
uniform float uRefract;     // refraction strength
uniform float uNormalK;     // height-field slope scale
uniform float uWater;       // 1 = draw water
uniform float uUseRefract;
uniform float uUseReflect;
uniform float uTScale;     // 1 for float targets, 4 for the RGBA8 fallback
uniform float uPxPerTexel; // canvas px per thickness texel
uniform float uRim;        // rounded edge width (canvas px)
uniform sampler2D uDepth;  // blurred coverage (depth / thinness proxy)
uniform float uDpr;
uniform float uUseColor;
uniform float uUseGlow;
uniform float uUseHighlights;
uniform float uUseFoam;
uniform float uUseCaustics;
uniform float uTime;
uniform float uActivity;   // rms particle speed (m/s)
uniform vec2 uCanvas;      // canvas size in px

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Procedural studio: dark room, a large overhead softbox, two tall strip
// lights at the sides and a faint key behind the camera. d is a view-space
// direction (x right, y up, z toward the viewer); lights follow world-up.
vec3 studio(vec3 d) {
  vec2 side2 = vec2(uUp.y, -uUp.x);
  float up = dot(d.xy, uUp);
  float side = dot(d.xy, side2);
  vec3 c = mix(vec3(0.004, 0.005, 0.006), vec3(0.020, 0.024, 0.028), smoothstep(-0.6, 0.9, up));
  // Overhead softbox (rounded rectangle toward world up, slightly in front).
  float box = smoothstep(0.62, 0.70, up) * (1.0 - smoothstep(0.42, 0.55, abs(side))) * smoothstep(-0.35, 0.1, d.z);
  c += box * vec3(5.0, 5.1, 5.3);
  // Side strips.
  float strip = smoothstep(0.80, 0.86, abs(side)) * (1.0 - smoothstep(0.35, 0.5, abs(up))) * step(0.0, d.z);
  c += strip * vec3(1.6, 1.7, 1.9);
  // Faint key light behind the camera, upper-left of the viewer.
  float key = pow(max(dot(d, normalize(vec3(-0.35 * side2 + 0.45 * uUp, 0.82))), 0.0), 40.0);
  c += key * vec3(0.9, 0.85, 0.8);
  return c;
}

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Caustic network: animated Voronoi edges (F2 − F1 small) on a domain-warped
// plane look like the bright focal lines on a pool floor. Division-free (the
// classic iterated-sin caustic produced 0/0 NaNs here).
float causticLayer(vec2 p, float t) {
  p += 0.35 * vec2(sin(p.y * 1.3 + t), cos(p.x * 1.1 - t * 0.8));
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.4 * sin(t + 6.2831 * hash2(ip + g));
      float d = length(g + o - fp);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  float l = 1.0 - smoothstep(0.0, 0.22, f2 - f1);
  return l * l;
}
float causticPattern(vec2 p, float t) {
  return 0.65 * causticLayer(p, t) + 0.45 * causticLayer(p * 1.7 + 11.0, t * 1.3);
}
// Foam texture: clusters of small bubbles. Cellular noise where each cell is
// a bubble: bright rounded cap near its centre, dark gaps between; each cell
// randomly present or not, so foam breaks up into clumps instead of a glaze.
float foamBubbles(vec2 p, float t, float density) {
  vec2 ip = floor(p), fp = fract(p);
  float v = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 h = hash2(ip + g);
      if (h.x > density) continue;                 // this bubble isn't there
      vec2 o = 0.5 + 0.35 * sin(t * 0.6 + 6.2831 * h);
      float r = 0.28 + 0.30 * h.y;                  // mixed bubble sizes
      float d = length(g + o - fp) / r;
      // Bubble: bright thin rim + soft highlight cap, transparent middle.
      float rim = smoothstep(0.70, 0.95, d) * (1.0 - smoothstep(0.95, 1.08, d));
      float cap = exp(-dot(g + o - fp + vec2(0.12, -0.12) * r, g + o - fp + vec2(0.12, -0.12) * r) / (r * r * 0.08));
      v = max(v, rim * 0.45 + cap * 0.55 + (1.0 - smoothstep(0.0, 1.0, d)) * 0.3);
    }
  }
  return v;
}

void main() {
  vec3 bg = texture(uBack, vUv).rgb;
  float T = texture(uThick, vUv).r * uTScale;
  if (uWater < 0.5 || T < 0.02) { outColor = vec4(toSrgb(bg), 1.0); return; }

  // Level-set surface. The blurred thickness gives a smooth *shape*; the liquid
  // boundary is its 0.5 iso-line. Signed distance to it (canvas px):
  // d ≈ (T − 0.5) / |∇T|. The edge is given a rounded (circular) profile of
  // width uRim, so the normal turns from facing the viewer inside the water to
  // pointing outward at the silhouette, independent of how much blur was used.
  float e = 2.0;
  // Thickness is saturated at 1 for the slope: density variation inside the bulk
  // (e.g. the packed layer at a wall) must not tilt normals; only the edge does.
  float tl = min(texture(uThick, vUv - vec2(uTexel.x * e, 0.0)).r * uTScale, 1.0);
  float tr = min(texture(uThick, vUv + vec2(uTexel.x * e, 0.0)).r * uTScale, 1.0);
  float td = min(texture(uThick, vUv - vec2(0.0, uTexel.y * e)).r * uTScale, 1.0);
  float tu = min(texture(uThick, vUv + vec2(0.0, uTexel.y * e)).r * uTScale, 1.0);
  vec2 g = vec2(tr - tl, tu - td) / (2.0 * e);       // per thickness texel
  float gl = length(g);
  float d = (T - 0.5) / max(gl, 1e-4) * uPxPerTexel; // canvas px, + inside
  vec2 outward = gl > 1e-5 ? -g / gl : vec2(0.0);
  float t = clamp(d / uRim, 0.0, 1.0);
  float ct = 1.0 - t;
  vec3 n = normalize(vec3(outward * ct, sqrt(max(1.0 - ct * ct, 0.0)) + 1e-3));
  // Faint interior undulation from the thickness field so bulk water isn't a flat sheet.
  n = normalize(n + vec3(-g * uNormalK * 0.15 * t, 0.0));

  float Tc = clamp(T, 0.0, 1.4);
  // Crisp, antialiased silhouette at the iso-line.
  float mask = smoothstep(-0.75, 0.75, d);
  // Outside the liquid (faint spray below the iso-level) there is nothing to shade.
  // (Also keeps far-negative d from overflowing exp() below: inf·0 = NaN in mix.)
  if (mask <= 0.0) { outColor = vec4(toSrgb(bg), 1.0); return; }

  // Refraction: shift the backplate lookup along the surface slope, scaled by
  // thickness; tiny per-channel spread gives dispersion at strong edges.
  vec3 refr = bg;
  if (uUseRefract > 0.5) {
    vec2 off = -n.xy * uRefract * Tc * vec2(1.0, uAspect);
    refr.r = texture(uBack, vUv + off * 0.97).r;
    refr.g = texture(uBack, vUv + off).g;
    refr.b = texture(uBack, vUv + off * 1.03).b;
  }
  // --- M6 caustics ------------------------------------------------------------
  // Light from the overhead studio is focused by the wavy free surface into a
  // moving network on the back wall. March up (against gravity) through the
  // depth field to find the surface above this pixel: its distance h sets the
  // focal depth / fade and its slope shears the pattern, so the caustics follow
  // the actual surface shape and die out deep down or under a ceiling of water.
  vec2 side2c = vec2(uUp.y, -uUp.x);
  if (uUseCaustics > 0.5) {
    const float stepCss = 10.0;
    const float maxH = 24.0 * stepCss;
    vec2 stepUv = uUp * (stepCss * uDpr) / uCanvas;
    float hS = -1.0;
    vec2 q = vUv;
    float prevB = texture(uDepth, vUv).r;
    for (int k = 1; k <= 24; k++) {
      q = vUv + stepUv * float(k);
      if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) break;
      float bk = texture(uDepth, q).r;
      if (bk < 0.5) {
        // Interpolate the crossing between samples: continuous h, no banding.
        float fr = clamp((prevB - 0.5) / max(prevB - bk, 1e-4), 0.0, 1.0);
        hS = (float(k - 1) + fr) * stepCss;
        q = vUv + stepUv * (float(k - 1) + fr);
        break;
      }
      prevB = bk;
    }
    if (hS > 0.0) {
      vec2 dUv = uDpr * 16.0 / uCanvas;
      float bx = texture(uDepth, q + vec2(dUv.x, 0.0)).r - texture(uDepth, q - vec2(dUv.x, 0.0)).r;
      float by = texture(uDepth, q + vec2(0.0, dUv.y)).r - texture(uDepth, q - vec2(0.0, dUv.y)).r;
      vec2 gb = vec2(bx, by);
      float gl2 = length(gb);
      // Surface tilt along the tank (0 for a level surface), smoothly limited.
      float slope = gl2 > 1e-4 ? dot(gb / gl2, side2c) * smoothstep(0.0, 0.05, gl2) : 0.0;
      vec2 pcss = vUv * uCanvas / uDpr;
      float X = dot(pcss, side2c), Y = dot(pcss, uUp);
      vec2 cp = vec2(X + slope * hS * 0.5, Y * 0.5 + hS * 0.35) / 18.0;
      float act = clamp(uActivity / 0.12, 0.0, 1.0);
      float cst = causticPattern(cp, uTime * (0.35 + 1.4 * act));
      // Sharpest just below the surface, fading with depth and to 0 before the
      // march limit (no visible cut-off).
      float fade = exp(-hS / 90.0) * (1.0 - smoothstep(0.6 * maxH, maxH, hS)) * (0.4 + 0.6 * act);
      refr += vec3(0.050, 0.080, 0.078) * cst * fade;
    }
  }

  // --- M5 water colour -------------------------------------------------------
  // B: heavily blurred liquid coverage (1/8 res). ≈0.5 at the surface, → 1 deep
  // in the bulk, < 0.5 for drops, tongues and thin sheets. It is the smooth
  // "how far below the surface / how thick" proxy the level set can't give.
  float B = texture(uDepth, vUv).r;
  float depthF = uUseColor > 0.5 ? smoothstep(0.52, 0.985, B) : 0.5;
  float thin = 1.0 - smoothstep(0.30, 0.72, B);
  float dcss = max(d, 0.0) / uDpr;

  // Transmission of the backplate: longer optical path the deeper we look,
  // red absorbed first (Beer–Lambert), so deep water turns blue-green.
  vec3 sigmaA = vec3(0.62, 0.20, 0.11);
  vec3 trans = exp(-sigmaA * (0.5 + 2.6 * depthF));
  // In-scatter of the overhead studio light: bright aqua just under the
  // surface, fading to a dark teal-blue in the depths.
  vec3 shallow = vec3(0.009, 0.040, 0.046);
  vec3 deep = vec3(0.0008, 0.0075, 0.0125);
  // Thin water has little volume to scatter from: keep it clear, not opaque teal.
  vec3 scatter = mix(shallow, deep, depthF) * (1.0 - 0.65 * thin);
  vec3 body = refr * trans + scatter;
  // Faint glow where light passes through thin water (drops, crests, sheets).
  // Brightest right inside the edge of thin water, where light is funnelled through.
  if (uUseGlow > 0.5) body += vec3(0.018, 0.060, 0.058) * thin * (0.3 + 0.7 * exp(-dcss / 10.0));

  // Fresnel (Schlick, water F0 = 0.02) and reflection of the studio.
  float cosT = clamp(n.z, 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 refl = uUseReflect > 0.5 ? studio(reflect(vec3(0.0, 0.0, -1.0), n)) : vec3(0.0);
  vec3 water = body * (1.0 - F) + refl * F;

  if (uUseHighlights > 0.5) {
    vec2 side2 = vec2(uUp.y, -uUp.x);
    // Sharp specular glints from the key light (upper-left, in front).
    vec3 L = normalize(vec3(-0.35 * side2 + 0.62 * uUp, 0.70));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    water += vec3(1.0, 0.97, 0.92) * 7.0 * pow(max(dot(n, H), 0.0), 380.0);
    // Waterline: the meniscus seen edge-on is a bright hairline just inside the
    // edge, over a silvery band where the underside of the surface totally
    // internally reflects. Strongest on edges facing world-up (the free surface).
    float facing = smoothstep(0.15, 0.85, dot(outward, uUp));
    float edgeW = 0.35 + 0.65 * facing;
    float lz = (dcss - 0.9) / 0.65; // (pow() is undefined for negative bases in GLSL)
    float line = exp(-lz * lz);
    float tir = (1.0 - smoothstep(1.0, 9.0, dcss)) * step(0.0, dcss);
    water += vec3(0.85, 0.93, 0.95) * line * 0.55 * edgeW;
    water += vec3(0.10, 0.14, 0.15) * tir * facing;
  }

  // --- M6 foam -----------------------------------------------------------------
  // G/R of the blurred splat = the local average particle foam value. Denser
  // foam = more bubbles present and a whiter, more opaque layer; sparse foam
  // breaks into scattered clumps.
  if (uUseFoam > 0.5) {
    vec2 tf = texture(uThick, vUv).rg * uTScale;
    float fv = clamp(tf.g / max(tf.r, 0.35), 0.0, 1.0);
    float fm = smoothstep(0.08, 0.6, fv);
    if (fm > 0.0) {
      vec2 pcss = vUv * uCanvas / uDpr;
      float dens = 0.12 + 0.5 * fv;
      float b = max(foamBubbles(pcss / 7.0, uTime, dens), 0.75 * foamBubbles(pcss / 4.0 + 31.0, uTime * 1.3, dens * 0.8));
      float lit = 0.6 + 0.4 * (1.0 - depthF);          // lit from above
      vec3 foamCol = vec3(0.60, 0.66, 0.68) * lit;
      // Milky haze: aerated water scatters light, whiter where denser …
      water = mix(water, foamCol * 0.55, fm * (0.30 + 0.50 * fv));
      // … with individual bubbles readable on top.
      water = mix(water, foamCol, fm * clamp(b * (0.35 + 0.4 * fv), 0.0, 1.0));
    }
  }

  vec3 col = mix(bg, water, mask);
  // Until M8's tone mapper: soft shoulder so highlights don't clip hard.
  col = col / (1.0 + max(col - 0.6, 0.0));
  outColor = vec4(toSrgb(col), 1.0);
}`;

// 4-tap box downsample of the thickness field, saturated to liquid coverage [0,1].
const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outT;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uTScale;
void main() {
  float a = min(texture(uSrc, vUv + uSrcTexel * vec2(-1.0, -1.0)).r * uTScale, 1.0);
  float b = min(texture(uSrc, vUv + uSrcTexel * vec2( 1.0, -1.0)).r * uTScale, 1.0);
  float c = min(texture(uSrc, vUv + uSrcTexel * vec2(-1.0,  1.0)).r * uTScale, 1.0);
  float d = min(texture(uSrc, vUv + uSrcTexel * vec2( 1.0,  1.0)).r * uTScale, 1.0);
  outT = vec4(0.25 * (a + b + c + d), 0.0, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBack;
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() { outColor = vec4(toSrgb(texture(uBack, vUv).rgb), 1.0); }`;

function makeTarget(gl, w, h, fmt) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h, ok };
}

export class SurfacePass {
  constructor(gl) {
    this.gl = gl;
    this.scale = 0.5; // thickness buffer resolution relative to the canvas
    this.blurPasses = 2; // bilateral H+V iterations (quality levels tune this)
    this.refract = 0.035;
    this.normalK = 7.0;
    this.sigmaR = 0.4;
    this.sigmaS = 5.0;
    this.rimCss = 5; // meniscus/edge rounding width in CSS px
    this.dpr = 1;
    this.depthSigma = 6; // texels at 1/8 canvas res
    this.depthPasses = 3;
    this.time = 0;
    this.activity = 0;
    this.targets = null;
    this._init();
  }

  _init() {
    const gl = this.gl;
    // Float render targets: EXT_color_buffer_float (RG16F: thickness, foam) where available, else RGBA8.
    const f = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    this.fmt = f ? { internal: gl.RG16F, float: true } : { internal: gl.RGBA8, float: false };
    this.splat = program(gl, SPLAT_VS, SPLAT_FS, 'splat');
    this.blur = program(gl, FULLSCREEN_VS, BLUR_FS, 'blur');
    this.comp = program(gl, FULLSCREEN_VS, COMPOSITE_FS, 'water');
    this.blit = program(gl, FULLSCREEN_VS, BLIT_FS, 'blit');
    this.down = program(gl, FULLSCREEN_VS, DOWN_FS, 'down');
    this.depthTargets = null;
    this.targets = null;
  }

  restore() { this._init(); }

  _ensureTargets(cw, ch) {
    const gl = this.gl;
    const w = Math.max(1, Math.round(cw * this.scale));
    const h = Math.max(1, Math.round(ch * this.scale));
    if (this.targets && this.targets[0].w === w && this.targets[0].h === h) return;
    if (this.targets) for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    this.targets = [makeTarget(gl, w, h, this.fmt), makeTarget(gl, w, h, this.fmt)];
    if (!this.targets[0].ok && this.fmt.float) {
      // Some drivers advertise the extension but refuse RG16F: fall back to RGBA8.
      for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      this.fmt = { internal: gl.RGBA8, float: false };
      this.targets = [makeTarget(gl, w, h, this.fmt), makeTarget(gl, w, h, this.fmt)];
    }
    // Depth/thinness field at 1/4 of the thickness resolution.
    if (this.depthTargets) for (const t of this.depthTargets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    const dw = Math.max(1, Math.round(w / 4)), dh = Math.max(1, Math.round(h / 4));
    this.depthTargets = [makeTarget(gl, dw, dh, this.fmt), makeTarget(gl, dw, dh, this.fmt)];
  }

  // particles: ParticlePass (owns the VBO); fsVao: empty VAO for fullscreen draws.
  render(particles, fsVao, backTex, canvasW, canvasH, up, passes) {
    const gl = this.gl;
    this._ensureTargets(canvasW, canvasH);
    const [A, B] = this.targets;
    const water = passes.water && particles.count > 0 && particles.radius > 0;

    if (water) {
      // 1. Thickness splat.
      gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
      gl.viewport(0, 0, A.w, A.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const rx = particles.radius; // fraction of tank width
      const ry = rx * (canvasW / canvasH);
      const rPx = rx * A.w; // particle radius in target pixels
      const blobR = 4.4 * rPx; // splat radius
      // Normalise: bulk hex packing (spacing 2r × √3r) under a Gaussian kernel
      // of radius R sums to (π R²/4) / (2√3 r²) ≈ 1 / uScale.
      // ∫disk (e^{-4r²/R²} − e^{-4}) dA = πR²(¼(1 − e^{-4}) − e^{-4}).
      const ksum = (Math.PI * blobR * blobR * (0.25 * (1 - 0.0183) - 0.0183)) / (2 * Math.sqrt(3) * rPx * rPx);
      const { p, u } = this.splat;
      gl.useProgram(p);
      gl.uniform1f(u.uPointSize, 2 * blobR);
      gl.uniform2f(u.uRadiusN, rx, ry);
      gl.uniform1f(u.uScale, (this.fmt.float ? 1 : 0.25) / ksum);
      gl.bindVertexArray(particles.vao);
      gl.drawArraysInstanced(gl.POINTS, 0, particles.count, 5);
      gl.disable(gl.BLEND);

      // 2. Bilateral blur, ping-pong A→B→A.
      const b = this.blur;
      gl.useProgram(b.p);
      gl.bindVertexArray(fsVao);
      gl.uniform1i(b.u.uSrc, 0);
      gl.uniform1f(b.u.uSigmaR, this.fmt.float ? this.sigmaR : this.sigmaR * 0.25);
      gl.uniform1f(b.u.uSigmaS, this.sigmaS);
      gl.activeTexture(gl.TEXTURE0);
      const blurOn = passes.blur;
      for (let i = 0; blurOn && i < this.blurPasses; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo);
        gl.bindTexture(gl.TEXTURE_2D, A.tex);
        gl.uniform2f(b.u.uDir, 1 / A.w, 0);
        drawFullscreen(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
        gl.bindTexture(gl.TEXTURE_2D, B.tex);
        gl.uniform2f(b.u.uDir, 0, 1 / A.h);
        drawFullscreen(gl);
      }

      // 2b. Depth field: downsample coverage ×4, then wide Gaussian blur
      // (the bilateral shader with a huge range sigma is a plain Gaussian).
      const [C, D] = this.depthTargets;
      gl.bindFramebuffer(gl.FRAMEBUFFER, C.fbo);
      gl.viewport(0, 0, C.w, C.h);
      gl.useProgram(this.down.p);
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform1i(this.down.u.uSrc, 0);
      gl.uniform2f(this.down.u.uSrcTexel, 1 / A.w, 1 / A.h);
      gl.uniform1f(this.down.u.uTScale, this.fmt.float ? 1 : 4);
      drawFullscreen(gl);
      gl.useProgram(b.p);
      gl.uniform1f(b.u.uSigmaR, 1e4);
      gl.uniform1f(b.u.uSigmaS, this.depthSigma);
      for (let i = 0; i < this.depthPasses; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, D.fbo);
        gl.bindTexture(gl.TEXTURE_2D, C.tex);
        gl.uniform2f(b.u.uDir, 1 / C.w, 0);
        drawFullscreen(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, C.fbo);
        gl.bindTexture(gl.TEXTURE_2D, D.tex);
        gl.uniform2f(b.u.uDir, 0, 1 / C.h);
        drawFullscreen(gl);
      }
    }

    // 3. Composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.bindVertexArray(fsVao);
    if (!water) {
      gl.useProgram(this.blit.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, backTex);
      gl.uniform1i(this.blit.u.uBack, 0);
      drawFullscreen(gl);
      return;
    }
    const c = this.comp;
    gl.useProgram(c.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backTex);
    gl.uniform1i(c.u.uBack, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(c.u.uThick, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTargets[0].tex);
    gl.uniform1i(c.u.uDepth, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(c.u.uTexel, 1 / A.w, 1 / A.h);
    gl.uniform2f(c.u.uUp, up[0], up[1]);
    gl.uniform1f(c.u.uAspect, canvasW / canvasH);
    gl.uniform1f(c.u.uRefract, this.refract);
    gl.uniform1f(c.u.uNormalK, this.normalK);
    gl.uniform1f(c.u.uTScale, this.fmt.float ? 1 : 4);
    gl.uniform1f(c.u.uPxPerTexel, canvasW / A.w);
    gl.uniform1f(c.u.uRim, this.rimCss * this.dpr);
    gl.uniform1f(c.u.uWater, water ? 1 : 0);
    gl.uniform1f(c.u.uUseRefract, passes.refraction ? 1 : 0);
    gl.uniform1f(c.u.uUseReflect, passes.reflection ? 1 : 0);
    gl.uniform1f(c.u.uUseColor, passes.color ? 1 : 0);
    gl.uniform1f(c.u.uUseGlow, passes.glow ? 1 : 0);
    gl.uniform1f(c.u.uUseHighlights, passes.highlights ? 1 : 0);
    gl.uniform1f(c.u.uDpr, this.dpr);
    gl.uniform1f(c.u.uUseFoam, passes.foam ? 1 : 0);
    gl.uniform1f(c.u.uUseCaustics, passes.caustics ? 1 : 0);
    gl.uniform1f(c.u.uTime, this.time);
    gl.uniform1f(c.u.uActivity, this.activity);
    gl.uniform2f(c.u.uCanvas, canvasW, canvasH);
    drawFullscreen(gl);
  }
}
