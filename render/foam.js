// Foam as bubbles that ride on the particles. Every foamy particle may carry
// one small bubble; its size, sub-particle offset and presence threshold come
// from the particle's stable seed (packed into the foam float by the worker),
// so a bubble keeps its identity while the water carries it. Denser foam
// switches on more of the seeds, so foam thins out into scattered bubbles as
// it decays instead of fading as a uniform glaze. Drawn from the particle VBO,
// premultiplied alpha over the composite in the linear HDR scene buffer.

import { program } from './gl.js';

const VS = `#version 300 es
layout(location = 0) in vec4 aParticle; // x, y, seed + foam, speed
uniform vec2 uRadiusN;   // particle radius as a fraction of the tank (x, y)
uniform float uDpr;
uniform sampler2D uThick; // final (blurred) thickness: sprites only inside the liquid
uniform float uTScale;
out float vA;
out float vR;
out float vSeed;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float seed = floor(aParticle.z);
  float foam = fract(aParticle.z);
  // Presence: seed rank below the foam level → this particle shows a bubble.
  float rank = h1(seed + 0.5);
  float on = smoothstep(rank * 0.7 + 0.25, rank * 0.7 + 0.38, foam);
  if (on <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vR = 0.0; vSeed = 0.0; return; }
  vec2 p = (aParticle.xy - uRadiusN) / (1.0 - 2.0 * uRadiusN);
  // Spray outside the liquid surface is drawn by the surface pass (as drops) or
  // not at all; a bubble there would hang in the air like a snowflake.
  float T = textureLod(uThick, vec2(p.x, 1.0 - p.y), 0.0).r * uTScale;
  on *= smoothstep(0.6, 0.9, T);
  if (on <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vR = 0.0; vSeed = 0.0; return; }
  // Offset within ~a particle spacing so bubbles don't sit on the particle lattice.
  vec2 j = vec2(h1(seed + 1.7), h1(seed + 3.1)) - 0.5;
  p += j * 3.0 * uRadiusN;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  // Mostly small bubbles, a few larger ones (CSS px radius 1.3 .. 3.8).
  float sz = h1(seed + 5.3);
  vR = (1.3 + 2.5 * sz * sz * sz) * uDpr;
  on *= 0.55 + 0.45 * sz; // the smallest are the faintest
  gl_PointSize = 2.0 * vR + 2.0;
  vA = on;
  vSeed = seed;
}`;

const FS = `#version 300 es
precision mediump float;
in float vA;
in float vR;
in float vSeed;
uniform vec2 uUp;
out vec4 outColor;
void main() {
  vec2 pc = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) * 2.0 - 1.0;
  float s = (vR + 1.0) / max(vR, 0.5);
  float d = length(pc) * s;
  if (d > 1.1) discard;
  float aa = 1.2 / max(vR, 1.0);
  float disk = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  // Small bubbles read as bright dots, larger ones as rings with a clear middle.
  float ringness = smoothstep(1.5, 3.5, vR);
  float rim = mix(disk, smoothstep(0.55, 0.92, d) * disk, ringness);
  vec2 hl = uUp * 0.38 + vec2(-uUp.y, uUp.x) * 0.22;
  float spec = exp(-dot(pc * s - hl, pc * s - hl) * 30.0) * disk;
  vec3 c = vec3(0.34, 0.42, 0.44) * rim + vec3(1.4) * spec;
  float a = vA * clamp(0.08 * disk + 0.55 * rim + 0.6 * spec, 0.0, 1.0);
  outColor = vec4(c * vA, a);
}`;

export class FoamPass {
  constructor(gl) {
    this.gl = gl;
    this._init();
  }

  _init() { this.prog = program(this.gl, VS, FS, 'foam'); }

  restore() { this._init(); }

  // particles: the ParticlePass (its VBO holds this frame's particle data).
  draw(particles, thickTex, tScale, widthPx, heightPx, dpr, up) {
    if (!particles.count || !thickTex) return;
    const gl = this.gl;
    const { p, u } = this.prog;
    gl.useProgram(p);
    const rn = particles.radius;
    gl.uniform2f(u.uRadiusN, rn, rn * widthPx / heightPx);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform2f(u.uUp, up[0], up[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, thickTex);
    gl.uniform1i(u.uThick, 0);
    gl.uniform1f(u.uTScale, tScale);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(particles.vao);
    gl.drawArrays(gl.POINTS, 0, particles.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
