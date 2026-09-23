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
layout(location = 0) in vec4 aParticle;
uniform float uPointSize;   // blob diameter in target pixels
uniform vec2 uRadiusN;      // particle radius as fraction of tank (x, y)
out float vW;
void main() {
  // Particles live in [r, 1-r]; stretch that onto [0, 1] so water touches the glass.
  vec2 p = (aParticle.xy - uRadiusN) / (1.0 - 2.0 * uRadiusN);
  // Instance 0 = the particle, 1..4 = mirror images across left/right/top/bottom.
  int m = gl_InstanceID;
  vW = 1.0;
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
uniform float uScale;
out vec4 outT;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  // Gaussian, ~0 at the sprite edge.
  float w = exp(-4.0 * r2) - 0.0183;
  outT = vec4(w * uScale * vW, 0.0, 0.0, 1.0);
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
  float c = texture(uSrc, vUv).r;
  float sum = c, wsum = 1.0;
  int R = int(min(10.0, ceil(2.5 * uSigmaS)));
  for (int i = 1; i <= 10; i++) {
    if (i > R) break;
    float ws = exp(-float(i * i) / (2.0 * uSigmaS * uSigmaS));
    for (int s = -1; s <= 1; s += 2) {
      float t = texture(uSrc, vUv + uDir * float(i * s)).r;
      float dr = (t - c) / uSigmaR;
      float w = ws * exp(-0.5 * dr * dr);
      sum += t * w;
      wsum += w;
    }
  }
  outT = vec4(sum / wsum, 0.0, 0.0, 1.0);
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

  // Refraction: shift the backplate lookup along the surface slope, scaled by
  // thickness; tiny per-channel spread gives dispersion at strong edges.
  vec3 refr = bg;
  if (uUseRefract > 0.5) {
    vec2 off = -n.xy * uRefract * Tc * vec2(1.0, uAspect);
    refr.r = texture(uBack, vUv + off * 0.97).r;
    refr.g = texture(uBack, vUv + off).g;
    refr.b = texture(uBack, vUv + off * 1.03).b;
  }
  // Beer–Lambert through the (pseudo) water depth: red absorbed first.
  vec3 sigma = vec3(0.55, 0.16, 0.08);
  vec3 trans = exp(-sigma * Tc * 1.6);
  // A little in-scattered ambient so thick water isn't just darker backplate.
  vec3 scatter = vec3(0.006, 0.020, 0.028) * (1.0 - trans);
  vec3 body = refr * trans + scatter;

  // Fresnel (Schlick, water F0 = 0.02) and reflection of the studio.
  float cosT = clamp(n.z, 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 refl = uUseReflect > 0.5 ? studio(reflect(vec3(0.0, 0.0, -1.0), n)) : vec3(0.0);
  vec3 water = body * (1.0 - F) + refl * F;

  vec3 col = mix(bg, water, mask);
  // Until M8's tone mapper: soft shoulder so highlights don't clip hard.
  col = col / (1.0 + max(col - 0.6, 0.0));
  outColor = vec4(toSrgb(col), 1.0);
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
    this.targets = null;
    this._init();
  }

  _init() {
    const gl = this.gl;
    // Float render targets: EXT_color_buffer_float (R16F) where available, else RGBA8.
    const f = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    this.fmt = f ? { internal: gl.R16F, float: true } : { internal: gl.RGBA8, float: false };
    this.splat = program(gl, SPLAT_VS, SPLAT_FS, 'splat');
    this.blur = program(gl, FULLSCREEN_VS, BLUR_FS, 'blur');
    this.comp = program(gl, FULLSCREEN_VS, COMPOSITE_FS, 'water');
    this.blit = program(gl, FULLSCREEN_VS, BLIT_FS, 'blit');
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
      // Some drivers advertise the extension but refuse R16F: fall back to RGBA8.
      for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      this.fmt = { internal: gl.RGBA8, float: false };
      this.targets = [makeTarget(gl, w, h, this.fmt), makeTarget(gl, w, h, this.fmt)];
    }
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
    drawFullscreen(gl);
  }
}
