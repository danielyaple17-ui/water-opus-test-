// Game level geometry drawn over the water composite: obstacles as slabs of
// smoked acrylic (dark body, a bright bevel on the edge facing the light, a
// faint inner glow), and the cup's fill line as a thin dashed marker. Rects
// come in tank-interior coords [0,1] (x right, y down) and are snapped to the
// simulation's cells, so the drawn edge is exactly where the water stops.

import { program } from './gl.js';

const VS = `#version 300 es
layout(location = 0) in vec2 aPos; // unit quad corner (0..1)
uniform vec4 uRect;  // screen rect in [0,1], y down: x0, y0, x1, y1
uniform vec2 uCanvas;
out vec2 vLocal;     // position inside the rect in screen px from its min corner
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, aPos);
  vLocal = (p - uRect.xy) * uCanvas;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vLocal;
uniform vec4 uRect;
uniform vec2 uCanvas;
uniform vec2 uUp;     // world-up in GL screen space (x right, y up)
uniform float uDpr;
uniform float uKind;  // 0 slab, 1 fill-line marker
out vec4 outColor;
void main() {
  vec2 size = (uRect.zw - uRect.xy) * uCanvas;
  // Signed distance to the rect edge in px (negative inside), rounded corners.
  vec2 c = vLocal - 0.5 * size;
  float rad = 3.0 * uDpr;
  vec2 q = abs(c) - (0.5 * size - rad);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  float aa = 0.8;
  float cover = 1.0 - smoothstep(-aa, aa, d);
  if (cover <= 0.0) discard;
  if (uKind > 0.5) {
    // Dashed marker line.
    float dash = step(0.5, fract(vLocal.x / (10.0 * uDpr)));
    outColor = vec4(vec3(0.55, 0.85, 0.95) * 0.9 * dash, 0.9 * dash) * cover;
    return;
  }
  // Edge normal (screen, y down) → which edge faces world-up.
  vec2 n = normalize(vec2(c.x, c.y) / max(size, vec2(1.0)) + 1e-5);
  vec2 upScreen = vec2(uUp.x, -uUp.y);
  float inner = -d;                                   // px inside the edge
  float bevel = exp(-inner / (2.2 * uDpr));           // thin bright rim
  float lit = clamp(dot(n, upScreen) * 0.5 + 0.5, 0.0, 1.0);
  vec3 body = vec3(0.020, 0.028, 0.032);
  // Soft gradient: lighter toward world-up, like light falling on the slab.
  vec2 uv = vLocal / max(size, vec2(1.0));
  float grad = dot(uv - 0.5, upScreen) * 0.5 + 0.5;
  body *= 0.8 + 0.5 * grad;
  vec3 rim = vec3(0.55, 0.66, 0.70) * (0.25 + 1.2 * lit * lit);
  vec3 col = body + rim * bevel * 0.55 + vec3(0.03, 0.05, 0.055) * exp(-inner / (10.0 * uDpr));
  outColor = vec4(col, 1.0) * cover; // premultiplied
}`;

export class LevelPass {
  constructor(gl) {
    this.gl = gl;
    this.slabs = [];   // screen rects [x0, y0, x1, y1] in [0,1], y down
    this.markers = [];
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.prog = program(gl, VS, FS, 'level');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
  }

  restore() { this._init(); }

  // level: { solids: [[u0,v0,u1,v1]...], marker: [u0, v, u1] | null } in
  // interior coords; cellsX/cellsY: the sim's interior grid; radiusN: particle
  // radius as a fraction of the interior (x, y) — the same stretch the water uses.
  set(level, cellsX, cellsY, radiusN, aspect) {
    this.slabs = [];
    this.markers = [];
    if (!level || !cellsX) return;
    const rx = radiusN, ry = radiusN * aspect;
    const sx = (u) => (u - rx) / (1 - 2 * rx), sy = (v) => (v - ry) / (1 - 2 * ry);
    for (const q of level.solids || []) {
      // Solid cells are those whose centre lies in the rect: snap to their faces.
      const k0 = Math.ceil(q[0] * cellsX - 0.5), k1 = Math.floor(q[2] * cellsX - 0.5);
      const m0 = Math.ceil(q[1] * cellsY - 0.5), m1 = Math.floor(q[3] * cellsY - 0.5);
      if (k1 < k0 || m1 < m0) continue;
      let u0 = k0 / cellsX, u1 = (k1 + 1) / cellsX, v0 = m0 / cellsY, v1 = (m1 + 1) / cellsY;
      // Slabs touching the tank wall extend to the screen edge.
      const x0 = k0 <= 0 ? -0.01 : sx(u0), x1 = k1 >= cellsX - 1 ? 1.01 : sx(u1);
      const y0 = m0 <= 0 ? -0.01 : sy(v0), y1 = m1 >= cellsY - 1 ? 1.01 : sy(v1);
      this.slabs.push([x0, y0, x1, y1]);
    }
    if (level.marker) {
      const [u0, v, u1] = level.marker;
      const y = sy(v);
      this.markers.push([sx(u0), y - 0.0015, sx(u1), y + 0.0015]);
    }
  }

  draw(widthPx, heightPx, dpr, up) {
    if (!this.slabs.length && !this.markers.length) return;
    const gl = this.gl;
    const { p, u } = this.prog;
    gl.useProgram(p);
    gl.uniform2f(u.uCanvas, widthPx, heightPx);
    gl.uniform2f(u.uUp, up[0], up[1]);
    gl.uniform1f(u.uDpr, dpr);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    const pad = 1.5 * dpr;
    gl.uniform1f(u.uKind, 0);
    for (const r of this.slabs) {
      // Grow by ~1.5 px so the water's anti-aliased edge tucks under the slab.
      gl.uniform4f(u.uRect, r[0] - pad / widthPx, r[1] - pad / heightPx, r[2] + pad / widthPx, r[3] + pad / heightPx);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.uniform1f(u.uKind, 1);
    for (const r of this.markers) {
      gl.uniform4f(u.uRect, r[0], r[1], r[2], r[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
