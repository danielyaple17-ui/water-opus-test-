// Plain particle dots (debug view). One interleaved VBO: x, y (tank-normalised,
// y down), foam (0..1), speed (m/s); bubbles follow in a second buffer. Uploaded with bufferSubData, never reallocated per frame.

import { program } from './gl.js';

const VS = `#version 300 es
layout(location = 0) in vec4 aParticle;
uniform float uPointSize;
out float vSpeed;
void main() {
  vec2 p = aParticle.xy;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
  vSpeed = fract(aParticle.z); // (x, y, seed + foam, freshness): debug dots show foam
}`;

const FS = `#version 300 es
precision mediump float;
in float vSpeed;
out vec4 outColor;
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  // Deep blue → pale cyan with foam (linear space).
  float s = clamp(vSpeed, 0.0, 1.0);
  vec3 c = mix(vec3(0.010, 0.080, 0.220), vec3(0.45, 0.80, 0.95), s);
  c *= 0.75 + 0.25 * (1.0 - r2);
  outColor = vec4(c, 1.0); // linear: drawn into the HDR scene buffer
}`;

export class ParticlePass {
  constructor(gl) {
    this.gl = gl;
    this.count = 0;
    this.capacity = 0;
    this.radius = 0; // fraction of tank width
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.prog = program(gl, VS, FS, 'particles');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);
    this.capacity = 0;
  }

  restore() { this._init(); this.count = 0; } // old VBO contents are gone

  // data: the worker buffer view; particles start at float `offset`.
  upload(data, count, offset = 0) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    if (count > this.capacity) {
      // Grow geometrically: during the pour-in the count rises every frame.
      this.capacity = Math.max(1024, count * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 16, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, offset, count * 4);
    this.count = count;
  }

  draw(width) {
    if (!this.count) return;
    const gl = this.gl;
    const { p, u } = this.prog;
    gl.useProgram(p);
    gl.uniform1f(u.uPointSize, Math.max(1.5, 2.4 * this.radius * width));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }
}
