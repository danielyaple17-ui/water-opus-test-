// Renderer: owns the GL context and the ordered list of render passes.
// Each pass can be toggled from the debug overlay via `renderer.passes[name]`.

import { createContext, program, FULLSCREEN_VS, drawFullscreen } from './gl.js';
import { ParticlePass } from './particles.js';
import { SurfacePass } from './surface.js';
import { BubblePass } from './bubbles.js';
import { FoamPass } from './foam.js';
import { LevelPass } from './level.js';
import { PostPass } from './post.js';

// Procedural dark backplate: fine frosted-glass grain over a subtly brushed,
// slightly blue-tinted dark panel. Computed in linear space, encoded to sRGB.
const BACKPLATE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform int uStyle; // 0 studio, 1 pool tiles, 2 pebbles, 3 graph paper

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
vec2 hash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
// Soft overhead light shared by the presets (linear space).
float light(vec2 p, float aspect) {
  return 0.55 + 0.45 * exp(-1.6 * length((p - vec2(0.5 * aspect, 1.05)) * vec2(1.3, 1.0)));
}
vec3 poolTiles(vec2 px, vec2 p, float aspect) {
  float cell = 34.0; // tile pitch in device px at 1× (scaled below by resolution)
  vec2 g = px / (cell * max(uRes.y / 900.0, 1.0));
  vec2 id = floor(g), f = fract(g);
  float grout = smoothstep(0.035, 0.07, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  float jitter = hash(id) * 0.12 - 0.06;
  vec3 tile = vec3(0.34, 0.52, 0.56) * (1.0 + jitter);
  vec3 col = mix(vec3(0.10, 0.13, 0.13), tile, grout);
  col *= 0.9 + 0.1 * vnoise(px * 0.08);
  return col * light(p, aspect) * 0.55;
}
vec3 pebbles(vec2 px, vec2 p, float aspect) {
  vec2 g = px / (42.0 * max(uRes.y / 900.0, 1.0));
  vec2 ip = floor(g), fp = fract(g);
  float f1 = 8.0, f2 = 8.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 c = o + 0.15 + 0.7 * hash2(ip + o) - fp;
    float d = length(c);
    if (d < f1) { f2 = f1; f1 = d; id = ip + o; } else if (d < f2) f2 = d;
  }
  float edge = smoothstep(0.02, 0.16, f2 - f1);
  vec2 h2 = hash2(id + 3.7);
  vec3 stone = mix(vec3(0.36, 0.32, 0.27), vec3(0.24, 0.26, 0.27), h2.x) * (0.8 + 0.4 * h2.y);
  stone *= 0.85 + 0.3 * (1.0 - f1); // rounded, lit tops
  vec3 col = mix(vec3(0.03, 0.03, 0.03), stone, edge);
  return col * light(p, aspect) * 0.5;
}
vec3 graphPaper(vec2 px, vec2 p, float aspect) {
  float s = max(uRes.y / 900.0, 1.0);
  vec2 g1 = px / (12.0 * s), g5 = px / (60.0 * s);
  vec2 f1 = abs(fract(g1) - 0.5), f5 = abs(fract(g5) - 0.5);
  float minor = 1.0 - smoothstep(0.44, 0.5, max(f1.x, f1.y));
  float major = 1.0 - smoothstep(0.47, 0.5, max(f5.x, f5.y));
  vec3 paper = vec3(0.78, 0.77, 0.72) * (0.96 + 0.04 * vnoise(px * 0.2));
  vec3 col = paper;
  col = mix(col, vec3(0.30, 0.52, 0.62), (1.0 - minor) * 0.35);
  col = mix(col, vec3(0.18, 0.40, 0.52), (1.0 - major) * 0.6);
  return col * light(p, aspect) * 0.5;
}

void main() {
  vec2 px = vUv * uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  if (uStyle != 0) {
    vec3 col = uStyle == 1 ? poolTiles(px, p, aspect) : uStyle == 2 ? pebbles(px, p, aspect) : graphPaper(px, p, aspect);
    vec2 q = vUv - 0.5;
    col *= 1.0 - 0.5 * dot(q, q) * 2.0;
    outColor = vec4(col, 1.0);
    return;
  }

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

// The player's own photo as the backplate: cover-fit, gently darkened and
// vignetted so the water's highlights and colour still read over it.
const PHOTO_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImg; // sRGB texture: sampled as linear
uniform vec2 uRes;
uniform vec2 uImgSize;
void main() {
  float a = uRes.x / uRes.y, ia = uImgSize.x / uImgSize.y;
  vec2 uv = vUv - 0.5;
  if (ia > a) uv.x *= a / ia; else uv.y *= ia / a;
  vec3 col = texture(uImg, uv + 0.5).rgb * 0.7;
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(q, q) * 2.0;
  outColor = vec4(col, 1.0);
}`;

export const BACKGROUNDS = ['Studio', 'Pool tiles', 'Pebbles', 'Graph paper'];

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
          this.level.restore();
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
    this.level = new LevelPass(this.gl);
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
    this.photoProg = program(gl, FULLSCREEN_VS, PHOTO_FS, 'photo');
    this._uploadPhoto();
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
    if (this.bgImage && this.photoTex) {
      const { p, u } = this.photoProg;
      gl.useProgram(p);
      gl.uniform2f(u.uRes, this.width, this.height);
      gl.uniform2f(u.uImgSize, this.bgImage.width, this.bgImage.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
      gl.uniform1i(u.uImg, 0);
    } else {
      const { p, u } = this.backplate;
      gl.useProgram(p);
      gl.uniform2f(u.uRes, this.width, this.height);
      gl.uniform1i(u.uStyle, this.bgStyle | 0);
    }
    drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bpDirty = false;
  }

  // Background: a preset index (BACKGROUNDS) or the player's photo (an
  // ImageBitmap / HTMLImageElement / canvas). Re-bakes the backplate.
  setBackground(style, image = null) {
    this.bgStyle = style | 0;
    this.bgImage = image;
    this._uploadPhoto();
    this.bpDirty = true;
  }

  _uploadPhoto() {
    const gl = this.gl;
    if (this.photoTex) { gl.deleteTexture(this.photoTex); this.photoTex = null; }
    if (!this.bgImage) return;
    this.photoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // image rows are top-down, GL uv is bottom-up
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, this.bgImage);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
    // Level obstacles sit in front of the water (it never enters them).
    this.level.draw(this.width, this.height, this.surface.dpr, this.up);
    if (this.passes.water && this.passes.bubbles) {
      this.bubbles.draw(this.width, this.particles.radius, this.width / this.height, this.up);
    }
    if (this.passes.particles) this.particles.draw(this.width);
    this.post.render(this.vao, this.width, this.height, this.passes, this.up, this.surface.dpr, this.time);
  }
}
