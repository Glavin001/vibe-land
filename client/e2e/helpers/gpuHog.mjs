// A GPU hog for the frame-hitch harnesses: a second headless browser (its own
// GPU process, as the city server is its own Metal client) drawing a
// fullscreen quad whose fragment shader loops `iterations` times, every frame.
//
// The city client's frames wait on a GPU shared with the server's physics,
// and that is what makes the render governor trim; a replay alone on the GPU
// never does, and a live run's share of contention varies from run to run.
// With the hog, both reproduce the shared-GPU condition on demand. Only ever
// run it under scripts/perf/gpu-run.sh.

/** A second browser that keeps the GPU busy: `iterations` of ALU per pixel, every frame. */
export async function startGpuHog(chromium, iterations) {
  const hogBrowser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
  const hogPage = await hogBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
  await hogPage.setContent('<canvas id="c" width="1920" height="1080"></canvas>');
  await hogPage.evaluate((n) => {
    const gl = document.getElementById('c').getContext('webgl2');
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float; uniform float t; out vec4 o;
      void main(){ vec2 v = gl_FragCoord.xy * 0.001 + t; for (int i = 0; i < ${n}; i++) v = vec2(sin(v.x * 1.3 + v.y), cos(v.y * 0.7 - v.x)); o = vec4(v, 0.0, 1.0); }`));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const t = gl.getUniformLocation(program, 't');
    const loop = (ms) => { gl.uniform1f(t, ms * 0.001); gl.drawArrays(gl.TRIANGLES, 0, 3); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }, iterations);
  return hogBrowser;
}

