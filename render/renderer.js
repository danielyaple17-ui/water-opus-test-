// Renderer: owns the GL context and the ordered list of render passes.
// Each pass can be toggled from the debug overlay via `renderer.passes[name]`.

import { createContext, program, FULLSCREEN_VS, drawFullscreen } from './gl.js';
import { ParticlePass } from './particles.js';
import { SurfacePass } from './surface.js';
import { BubblePass } from './bubbles.js';
import { FoamPass } from './foam.js';
import { PostPass } from './post.js';

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

  // Out-of-focus studio back wall: light spilling from a softbox above the tank,
  // a dim warm bokeh glow low on one side, and a mottled frosted-glass texture
  // (medium-scale cloudiness + fine grain) that the water visibly bends.
  vec2 c = vec2(0.5 * aspect, 1.05);
  float spill = exp(-2.2 * length((p - c) * vec2(1.3, 1.0)));
  float glow = exp(-9.0 * length(p - vec2(0.18 * aspect, 0.22)));
  vec3 base = vec3(0.0035, 0.0045, 0.0055);
  base += spill * vec3(0.050, 0.056, 0.062);
  base += glow * vec3(0.020, 0.013, 0.008);
  float cloud = fbm(p * vec2(9.0, 7.0));
  float fine = fbm(p * 60.0);
  float grain = hash(px) - 0.5;
  base *= 0.72 + 0.42 * cloud + 0.18 * (fine - 0.5);
  base *= 1.0 + grain * 0.10;
  // Vignette.
  vec2 q = vUv - 0.5;
  base *= 1.0 - 0.45 * dot(q, q) * 2.0;
  outColor = vec4(max(base, 0.0), 1.0);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.lost = false;
    this.renderScale = 1; // fraction of devicePixelRatio (quality levels change this)
    this.width = 1;
    this.height = 1;
    // Render-pass switches (debug overlay toggles these).
    this.passes = {
      backplate: true, water: true, blur: true, refraction: true, reflection: true,
      color: true, glow: true, highlights: true, foam: true, caustics: true, bubbles: true,
      bloom: true, tonemap: true, glass: true, smoothSurface: true,
      particles: false,
    };
    this.up = [0, 1]; // real-world up in GL screen space (from gravity)
    // Context loss (GPU reset, backgrounded tab on iOS, driver update …): stop
    // drawing, keep the sim running; on restore every GL object is rebuilt
    // (programs, VAOs/VBOs, textures, render targets). If the context never
    // comes back, `onContextState('failed')` lets the UI offer a reload.
    this.lostCount = 0;
    this.restoredCount = 0;
    this.onContextState = null;
    this.gl = createContext(
      canvas,
      () => {
        this.lost = true;
        this.lostCount++;
        if (this.onContextState) this.onContextState('lost');
      },
      () => {
        try {
          this._init();
          this.bpDirty = true;
          this.particles.restore();
          this.surface.restore();
          this.bubbles.restore();
          this.foam.restore();
          this.post.restore();
          this.lost = false;
          this.restoredCount++;
          if (this.onContextState) this.onContextState('restored');
        } catch (err) {
          console.error('WebGL restore failed', err);
          if (this.onContextState) this.onContextState('failed');
        }
      },
    );
    if (!this.gl) throw new Error('WebGL2 is not available on this device.');
    this._init();
    this.particles = new ParticlePass(this.gl);
    this.surface = new SurfacePass(this.gl);
    this.bubbles = new BubblePass(this.gl);
    this.foam = new FoamPass(this.gl);
    this.post = new PostPass(this.gl);
    this.time = 0;
  }

  // Per-frame scene inputs for animated effects (caustics / foam).
  setTime(t, activity) {
    this.time = t;
    this.surface.time = t;
    this.surface.activity = activity;
  }

  // Gravity in stage coords (y down) → world-up in GL screen coords (y up).
  setGravity(gx, gy) {
    const m = Math.hypot(gx, gy);
    if (m > 0.5) { this.up[0] = -gx / m; this.up[1] = gy / m; }
  }

  _init() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    this.backplate = program(gl, FULLSCREEN_VS, BACKPLATE_FS, 'backplate');
    // 1×1 black stand-in when the backplate pass is toggled off.
    this.blackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
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
      this.surface.dpr = dpr;
    }
  }

  render() {
    if (this.lost) return;
    const gl = this.gl;
    if (this.bpDirty) this._bakeBackplate();
    // The water composite also draws the backplate (without water: a plain blit).
    const back = this.passes.backplate ? this.bpTex : this.blackTex;
    // Scene (linear HDR) → post (bloom, glass, tone map, sRGB) → canvas.
    const scene = this.post.sceneTarget(this.width, this.height);
    this.surface.render(this.particles, this.vao, back, this.width, this.height, this.up, this.passes, scene);
    if (this.passes.water && this.passes.foam) {
      this.foam.draw(this.particles, this.surface.thickTex, this.surface.fmt.float ? 1 : 4, this.width, this.height, this.surface.dpr, this.up);
    }
    if (this.passes.water && this.passes.bubbles) {
      this.bubbles.draw(this.width, this.particles.radius, this.width / this.height, this.up);
    }
    if (this.passes.particles) this.particles.draw(this.width);
    this.post.render(this.vao, this.width, this.height, this.passes, this.up, this.surface.dpr, this.time);
  }
}
