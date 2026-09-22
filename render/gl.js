// WebGL2 helpers: context creation, shader compilation, fullscreen triangle.

export function createContext(canvas, onLost, onRestored) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: true,
  });
  if (!gl) return null;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // allow restore
    onLost && onLost();
  });
  canvas.addEventListener('webglcontextrestored', () => onRestored && onRestored());
  return gl;
}

export function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`[${label}] shader compile failed:\n${log}`);
  }
  return sh;
}

export function program(gl, vsSrc, fsSrc, label = 'program') {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vs');
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.fs');
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`[${label}] link failed:\n${gl.getProgramInfoLog(p)}`);
  }
  // Cache uniform locations once so the frame loop never queries by name.
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

// Vertex shader for a single oversized triangle covering the viewport.
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function drawFullscreen(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
