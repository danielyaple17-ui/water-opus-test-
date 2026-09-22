// Renderer: owns the GL context and the ordered list of render passes.
// Each pass can be toggled from the debug overlay via `renderer.passes[name]`.

import { createContext, program, FULLSCREEN_VS, drawFullscreen } from './gl.js';
import { ParticlePass } from './particles.js';

// Procedural dark backplate: fine frosted-glass grain over a subtly brushed,
// slightly blue-tinted dark panel. Computed in linear space, encoded to sRGB.
const BACKPLATE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
void main() {
  vec2 px = vUv * uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);

  // Soft studio falloff from above.
  float light = 0.004 + 0.010 * smoothstep(1.1, -0.2, length(p - vec2(0.5 * aspect, 0.95)));
  // Frosted grain (screen-resolution) + larger cloudy variation + faint fine
  // vertical brushing (high frequency so it never reads as banding).
  float grain = hash(px) - 0.5;
  float cloud = fbm(p * 5.0);
  float brushed = vnoise(vec2(px.x * 0.9, px.y * 0.012));
  vec3 base = vec3(0.0045, 0.0058, 0.0070) * (0.75 + 0.5 * cloud) + light * vec3(0.8, 0.9, 1.0);
  base *= 0.95 + 0.07 * brushed;
  base *= 1.0 + grain * 0.10;
  // Vignette.
  vec2 q = vUv - 0.5;
  base *= 1.0 - 0.55 * dot(q, q) * 2.0;
  outColor = vec4(max(base, 0.0), 1.0);
}`;

// Composite: samples linear textures and encodes to sRGB for the default framebuffer.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBackplate;
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec3 c = texture(uBackplate, vUv).rgb;
  outColor = vec4(toSrgb(c), 1.0);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.lost = false;
    this.renderScale = 1; // fraction of devicePixelRatio (quality levels change this)
    this.width = 1;
    this.height = 1;
    this.passes = { backplate: true, particles: true };
    this.gl = createContext(
      canvas,
      () => { this.lost = true; },
      () => { this.lost = false; this._init(); this.bpDirty = true; this.particles.restore(); },
    );
    if (!this.gl) throw new Error('WebGL2 is not available on this device.');
    this._init();
    this.particles = new ParticlePass(this.gl);
  }

  _init() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    this.backplate = program(gl, FULLSCREEN_VS, BACKPLATE_FS, 'backplate');
    this.composite = program(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
    this.bpTex = null;
    this.bpFbo = null;
    this.bpDirty = true;
  }

  // The backplate is static, so it is baked once per resize into an sRGB
  // texture (also the refraction source for the water later).
  _bakeBackplate() {
    const gl = this.gl;
    if (this.bpTex) gl.deleteTexture(this.bpTex);
    if (this.bpFbo) gl.deleteFramebuffer(this.bpFbo);
    this.bpTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bpTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, this.width, this.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.bpFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bpFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bpTex, 0);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.vao);
    const { p, u } = this.backplate;
    gl.useProgram(p);
    gl.uniform2f(u.uRes, this.width, this.height);
    drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bpDirty = false;
  }

  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3) * this.renderScale;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.bpDirty = true;
    }
  }

  render() {
    if (this.lost) return;
    const gl = this.gl;
    if (this.bpDirty) this._bakeBackplate();
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.vao);
    if (this.passes.backplate) {
      const { p, u } = this.composite;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bpTex);
      gl.uniform1i(u.uBackplate, 0);
      drawFullscreen(gl);
    } else {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (this.passes.particles) this.particles.draw(this.width);
  }
}
