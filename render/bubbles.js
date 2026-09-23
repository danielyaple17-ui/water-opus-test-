// Air bubbles drawn as sprites over the water composite. A bubble in water
// reads as a thin bright rim (light refracted/reflected at the grazing edge),
// a slightly darker, clear interior and a small specular dot toward the
// light. Colours are linear and premultiplied, alpha-blended over
// the composite in the linear HDR scene buffer.

import { program } from './gl.js';

const VS = `#version 300 es
layout(location = 0) in vec4 aBubble; // x, y (tank-normalised, y down), radius (fraction of width), alpha
uniform float uWidthPx;
uniform vec2 uRadiusN;
out float vA;
out float vR;
void main() {
  vec2 p = (aBubble.xy - uRadiusN) / (1.0 - 2.0 * uRadiusN);
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  vR = aBubble.z * uWidthPx;
  gl_PointSize = max(2.0, 2.0 * vR + 2.0);
  vA = aBubble.w;
}`;

const FS = `#version 300 es
precision mediump float;
in float vA;
in float vR;
uniform vec2 uUp; // world-up in GL screen space
out vec4 outColor;
void main() {
  // gl_PointCoord has y down; flip to GL orientation.
  vec2 pc = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) * 2.0 - 1.0;
  float s = (vR + 1.0) / max(vR, 0.5); // sprite has 1 px of AA margin
  float d = length(pc) * s;
  if (d > 1.12) discard;
  float aa = 1.5 / max(vR, 1.0);
  float disk = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float rim = smoothstep(0.62, 0.95, d) * disk;
  vec2 hl = uUp * 0.42 + vec2(-uUp.y, uUp.x) * 0.25;
  float spec = exp(-dot(pc * s - hl, pc * s - hl) * 38.0);
  // Linear HDR (tone mapped later): the rim is a mid-grey sheen, the glint is hot.
  vec3 rimCol = vec3(0.30, 0.42, 0.45);
  float a = vA * (0.10 * disk + 0.55 * rim + 0.9 * spec);
  vec3 c = rimCol * (0.55 * rim) + vec3(2.2) * spec;
  outColor = vec4(c * vA, clamp(a, 0.0, 1.0)); // premultiplied
}`;

export class BubblePass {
  constructor(gl, maxBubbles = 256) {
    this.gl = gl;
    this.max = maxBubbles;
    this.count = 0;
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.prog = program(gl, VS, FS, 'bubbles');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.max * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);
  }

  restore() { this._init(); }

  // data: the worker's Float32Array; bubbles start at float offset `offset`.
  upload(data, offset, count) {
    const gl = this.gl;
    this.count = Math.min(count, this.max);
    if (!this.count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, offset, this.count * 4);
  }

  draw(widthPx, radiusN, aspect, up) {
    if (!this.count) return;
    const gl = this.gl;
    const { p, u } = this.prog;
    gl.useProgram(p);
    gl.uniform1f(u.uWidthPx, widthPx);
    gl.uniform2f(u.uRadiusN, radiusN, radiusN * aspect);
    gl.uniform2f(u.uUp, up[0], up[1]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
