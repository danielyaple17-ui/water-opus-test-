// Post-processing (M8): the scene is rendered linear/HDR into an RGBA16F target;
// this pass adds highlight-only bloom, the glass-container look and tone maps.
//
//   bright-pass (luminance above a soft knee) → 4-level downsample chain →
//   tent upsample-add → final: scene + bloom · k, exposure, ACES filmic
//   (Narkowicz fit), vignette, faint front-glass reflections that stay
//   aligned with real-world up, thin bright glass edges, sRGB encode, dither.

import { program, FULLSCREEN_VS, drawFullscreen } from './gl.js';

const COMMON = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
${COMMON}
void main() {
  // 4-tap box downsample + soft-knee threshold: only highlights feed the bloom.
  vec3 c = 0.25 * (texture(uSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture(uSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb +
                   texture(uSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture(uSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb);
  float l = luma(c);
  float knee = uThreshold * 0.5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  o = vec4(c * w, 1.0);
}`;

const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.5;
  c += 0.125 * (texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb +
                texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  o = vec4(c, 1.0);
}`;

const UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  // 9-tap tent, additively blended onto the next larger level.
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += 2.0 * (texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb +
              texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb);
  c += texture(uSrc, vUv + uTexel).rgb + texture(uSrc, vUv - uTexel).rgb +
       texture(uSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture(uSrc, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
  o = vec4(c / 16.0, 1.0);
}`;

const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomK;
uniform float uExposure;
uniform float uUseBloom;
uniform float uUseGlass;
uniform float uUseTonemap;
uniform vec2 uUp;
uniform vec2 uCanvas;
uniform float uDpr;
uniform float uTime;
${COMMON}
vec3 aces(vec3 x) {
  // Narkowicz 2015 ACES filmic fit (input is linear, exposure applied before).
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  if (uUseBloom > 0.5) c += texture(uBloom, vUv).rgb * uBloomK;

  if (uUseGlass > 0.5) {
    vec2 px = vUv * uCanvas / uDpr;             // CSS px
    vec2 size = uCanvas / uDpr;
    // Faint reflections on the front glass: a broad soft band and a thin streak
    // from the studio's overhead light, oriented to world-up so they stay put
    // in the room while the phone turns (they slide over the screen).
    vec2 side = vec2(uUp.y, -uUp.x);
    vec2 p = (vUv - 0.5) * vec2(size.x / size.y, 1.0);
    float along = dot(p, normalize(uUp + 0.55 * side));
    float zb = (along - 0.22) / 0.14, zs = (along - 0.34) / 0.03; // (no pow of negatives)
    float band = exp(-zb * zb);
    float streak = exp(-zs * zs);
    c += vec3(0.0045, 0.0050, 0.0055) * band + vec3(0.0050, 0.0055, 0.0060) * streak;
    // Glass edges: the tank walls catch a thin bright line, darker just inside.
    float dEdge = min(min(px.x, size.x - px.x), min(px.y, size.y - px.y));
    c += vec3(0.05, 0.055, 0.06) * exp(-dEdge / 0.8);
    c *= 1.0 - 0.18 * exp(-dEdge / 6.0);
  }

  vec3 m = c * uExposure;
  vec3 t = uUseTonemap > 0.5 ? aces(m) : clamp(m, 0.0, 1.0);
  if (uUseGlass > 0.5) {
    // Lens vignette (after tone mapping so it behaves like the camera, not the scene).
    vec2 q = vUv - 0.5;
    t *= 1.0 - 0.32 * smoothstep(0.18, 0.75, dot(q, q) * 2.2);
  }
  vec3 s = toSrgb(t);
  // ±0.5 LSB dither kills banding in the dark gradients.
  s += (hash(gl_FragCoord.xy + fract(uTime) * 71.0) - 0.5) / 255.0;
  o = vec4(s, 1.0);
}`;

function target(gl, w, h, internal) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
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

export class PostPass {
  constructor(gl) {
    this.gl = gl;
    this.exposure = 1.1;
    this.bloomThreshold = 0.9;
    this.bloomK = 0.35;
    this.levels = 4;
    this._init();
  }

  _init() {
    const gl = this.gl;
    const f = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    this.float = !!f;
    // Without float targets the scene is stored in RGBA8 (LDR); bloom then only sees
    // clipped highlights, but everything still works.
    this.internal = f ? gl.RGBA16F : gl.RGBA8;
    this.bright = program(gl, FULLSCREEN_VS, BRIGHT_FS, 'bloom-bright');
    this.down = program(gl, FULLSCREEN_VS, DOWN_FS, 'bloom-down');
    this.up = program(gl, FULLSCREEN_VS, UP_FS, 'bloom-up');
    this.final = program(gl, FULLSCREEN_VS, FINAL_FS, 'post-final');
    this.scene = null;
    this.chain = [];
  }

  restore() { this._init(); }

  // Ensures the HDR scene target matches the canvas; returns its framebuffer.
  sceneTarget(w, h) {
    const gl = this.gl;
    if (!this.scene || this.scene.w !== w || this.scene.h !== h) {
      if (this.scene) { gl.deleteTexture(this.scene.tex); gl.deleteFramebuffer(this.scene.fbo); }
      for (const t of this.chain) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      this.scene = target(gl, w, h, this.internal);
      if (!this.scene.ok && this.float) {
        gl.deleteTexture(this.scene.tex); gl.deleteFramebuffer(this.scene.fbo);
        this.float = false; this.internal = gl.RGBA8;
        this.scene = target(gl, w, h, this.internal);
      }
      this.chain = [];
      let cw = w, ch = h;
      for (let i = 0; i < this.levels; i++) {
        cw = Math.max(1, cw >> 1); ch = Math.max(1, ch >> 1);
        this.chain.push(target(gl, cw, ch, this.internal));
      }
    }
    return this.scene.fbo;
  }

  render(vao, w, h, passes, up, dpr, time) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    const bloomOn = passes.bloom;
    if (bloomOn) {
      const C = this.chain;
      // Bright-pass into level 0 (½ res), then downsample.
      gl.bindFramebuffer(gl.FRAMEBUFFER, C[0].fbo);
      gl.viewport(0, 0, C[0].w, C[0].h);
      gl.useProgram(this.bright.p);
      gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
      gl.uniform1i(this.bright.u.uSrc, 0);
      gl.uniform2f(this.bright.u.uTexel, 1 / w, 1 / h);
      gl.uniform1f(this.bright.u.uThreshold, this.bloomThreshold);
      drawFullscreen(gl);
      gl.useProgram(this.down.p);
      gl.uniform1i(this.down.u.uSrc, 0);
      for (let i = 1; i < C.length; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, C[i].fbo);
        gl.viewport(0, 0, C[i].w, C[i].h);
        gl.bindTexture(gl.TEXTURE_2D, C[i - 1].tex);
        gl.uniform2f(this.down.u.uTexel, 1 / C[i - 1].w, 1 / C[i - 1].h);
        drawFullscreen(gl);
      }
      // Upsample-add back to level 0.
      gl.useProgram(this.up.p);
      gl.uniform1i(this.up.u.uSrc, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = C.length - 1; i > 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, C[i - 1].fbo);
        gl.viewport(0, 0, C[i - 1].w, C[i - 1].h);
        gl.bindTexture(gl.TEXTURE_2D, C[i].tex);
        gl.uniform2f(this.up.u.uTexel, 1 / C[i].w, 1 / C[i].h);
        drawFullscreen(gl);
      }
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const f = this.final;
    gl.useProgram(f.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(f.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.chain[0].tex);
    gl.uniform1i(f.u.uBloom, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(f.u.uBloomK, this.bloomK);
    gl.uniform1f(f.u.uExposure, this.exposure);
    gl.uniform1f(f.u.uUseBloom, bloomOn ? 1 : 0);
    gl.uniform1f(f.u.uUseGlass, passes.glass ? 1 : 0);
    gl.uniform1f(f.u.uUseTonemap, passes.tonemap ? 1 : 0);
    gl.uniform2f(f.u.uUp, up[0], up[1]);
    gl.uniform2f(f.u.uCanvas, w, h);
    gl.uniform1f(f.u.uDpr, dpr);
    gl.uniform1f(f.u.uTime, time);
    drawFullscreen(gl);
  }
}
