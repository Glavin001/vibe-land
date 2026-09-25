// Local Vite preview required. Usage: node scripts/grass-smoke.mjs [origin] [output-dir]
// GL timings are isolated grass-pass costs, not multiplayer frame-rate promises.
import { chromium } from '../client/node_modules/playwright-core/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const origin = process.argv[2] ?? 'http://127.0.0.1:5197';
const output = process.argv[3] ?? '/tmp/vibe-grass';
const width = Number(process.env.GRASS_BENCH_WIDTH) || 1280;
const height = Math.round(width*9/16);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=vulkan', '--enable-features=Vulkan'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  await page.goto(`${origin}/grass`);
  await page.getByRole('heading', { name: 'A little more alive.' }).waitFor();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${output}/near.png` });
  await page.getByRole('button', { name: 'City edge', exact: true }).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${output}/city-edge.png` });
  await page.getByRole('button', { name: 'Drive through', exact: true }).click();
  await page.waitForTimeout(3300);
  assert.ok(parseFloat(await page.getByTestId('grass-pressed-area').textContent()) > 1, 'Car should leave tracks');
  await page.screenshot({ path: `${output}/wheel-tracks.png` });
  await page.getByRole('button', { name: 'Stop car', exact: true }).click();
  await page.getByRole('button', { name: 'Clear tracks & rubble', exact: true }).click();
  await page.getByRole('button', { name: 'Drop rubble', exact: true }).click();
  await page.waitForTimeout(3500);
  assert.ok(parseFloat(await page.getByTestId('grass-pressed-area').textContent()) > 1, 'Resting rubble should hold grass down');
  await page.screenshot({ path: `${output}/resting-rubble.png` });
  await page.getByRole('button', { name: 'Clear tracks & rubble', exact: true }).click();
  await page.waitForTimeout(700);
  assert.equal(parseFloat(await page.getByTestId('grass-pressed-area').textContent()), 0);
  await page.getByRole('button', { name: 'Paint grass', exact: true }).click();
  for (const [preset, x, y] of [['tall', 600, 660], ['dry', 420, 750], ['bare', 820, 750]]) {
    await page.getByRole('button', { name: preset, exact: true }).click();
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x+60, y+15, { steps: 5 }); await page.mouse.up();
  }
  const layout = await page.evaluate(() => localStorage.getItem('vibe.city.grassPaint.v1'));
  assert.ok(layout && JSON.parse(layout).tiles.length > 0, 'Painting should save a sparse layout');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${output}/painted.png` });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.notEqual(await page.evaluate(() => localStorage.getItem('vibe.city.grassPaint.v1')), layout);
  await page.locator('input[type=file]').setInputFiles({ name: 'grass.json', mimeType: 'application/json', buffer: Buffer.from(layout) });
  await page.waitForFunction(expected => localStorage.getItem('vibe.city.grassPaint.v1') === expected, layout);
  await page.reload();
  await page.getByRole('button', { name: 'Paint grass', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('vibe.city.grassPaint.v1')), layout);
  await page.getByRole('button', { name: 'Reset paint', exact: true }).click();
  await page.getByRole('button', { name: 'Finish painting', exact: true }).click();
  await page.getByRole('button', { name: 'Performance', exact: true }).click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${output}/fast.png` });
  await page.getByRole('button', { name: 'Grass on', exact: true }).click();
  await page.screenshot({ path: `${output}/off.png` });
  await page.getByRole('button', { name: 'Grass off', exact: true }).click();
  await page.getByRole('button', { name: 'Above the field', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${output}/aerial.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Among the blades', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${output}/mobile.png` });
  await page.getByRole('button', { name: 'Grass controls', exact: true }).click();
  await page.screenshot({ path: `${output}/mobile-controls.png` });
  await page.getByRole('button', { name: 'Close controls', exact: true }).click();
  assert.equal(errors.length, 0, errors.join('\n'));

  // Same renderer in an isolated canvas for stable A/B measurements. No second
  // app renderer competing for the GPU, no physics, no synthetic blade shader.
  await page.route('**/grass-benchmark-harness', route => route.fulfill({
    contentType: 'text/html', body: '<html><body style="margin:0"></body></html>',
  }));
  await page.goto(`${origin}/grass-benchmark-harness`);
  const report = await page.evaluate(async ({ width, height }) => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { GrassField } = await import('/src/scene/grass/GrassField.ts');
    const { GrassBodyContacts } = await import('/src/scene/grass/GrassBodyContacts.ts');
    const { CityTopology } = await import('/src/city/topology.ts');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#bacad2');
    scene.fog = new THREE.FogExp2('#bacad2', 0.004);
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.06, 450);
    camera.position.set(6, 1.4, 8);
    camera.lookAt(0, 0.45, -3);
    camera.updateMatrixWorld();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(renderer.domElement);
    const sun = new THREE.DirectionalLight('#fff4e2', 2.8);
    sun.position.set(48, 42, 18);
    sun.castShadow = true;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -48;
    sun.shadow.camera.right = sun.shadow.camera.top = 48;
    scene.add(sun, new THREE.HemisphereLight('#90afd0', '#555039', 1.15));
    const gl = renderer.getContext();
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const median = values => values.length ? values.sort((a,b) => a-b)[Math.floor(values.length / 2)] : null;
    const percentile = (values, p) => values.length ? values.slice().sort((a,b) => a-b)[Math.floor((values.length-1)*p)] : null;
    const results = [];
    for (const quality of ['pretty', 'fast']) {
      const field = new GrassField(quality);
      field.setWind(5, 65);
      scene.add(field.group);
      for (let i = 0; i < 150; i++) { field.update(camera, i / 30); renderer.render(scene, camera); await frame(); }
      const stats = { ...field.stats };
      // Saturate the 192-stamp budget with a player and dense object contacts:
      // rasterization, recovery and quantization, independent of display pacing.
      const manifest = { version: 1, structures: [] };
      const topology = new CityTopology(manifest);
      const contacts = new GrassBodyContacts({ manifest: { manifest }, topology });
      const contactCpuMs = [];
      for (let tick = 0; tick < 120; tick++) {
        const start = performance.now();
        field.interaction.begin(tick*0.06, 6, 8);
        contacts.update(field.interaction, tick*0.06, 6, 8, null, [tick*0.03,1,0]);
        for (let body = 0; body < 192; body++) field.interaction.stamp({
          x: (body%16)*3-18, z: Math.floor(body/16)*3-14,
          radiusX: 0.7, radiusZ: 1.2, pressure: 1, hold: 0.5,
        });
        field.interaction.commit();
        contactCpuMs.push(performance.now()-start);
      }
      // Pair on/off in the same frame, reversing order each frame to reduce
      // clock/thermal/other-app bias. Query results are read asynchronously.
      const cpu = { on: [], off: [] }, gpuMs = { on: [], off: [] }, queries = [], pairs = [];
      const updateMs = [];
      for (let i = 0; i < 120; i++) {
        await frame();
        const startUpdate = performance.now();
        field.update(camera, 6 + i / 60);
        updateMs.push(performance.now() - startUpdate);
        const pair = {};
        pairs.push(pair);
        for (const enabled of i % 2 ? [false, true] : [true, false]) {
          field.group.visible = enabled;
          const key = enabled ? 'on' : 'off';
          const q = timer ? gl.createQuery() : null;
          if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
          const start = performance.now();
          renderer.render(scene, camera);
          cpu[key].push(performance.now() - start);
          if (q) { gl.endQuery(timer.TIME_ELAPSED_EXT); queries.push({ q, key, pair }); }
        }
        while (queries.length && gl.getQueryParameter(queries[0].q, gl.QUERY_RESULT_AVAILABLE)) {
          const { q, key, pair: measured } = queries.shift();
          if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
            measured[key] = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
            gpuMs[key].push(measured[key]);
          }
          gl.deleteQuery(q);
        }
      }
      for (const { q } of queries) gl.deleteQuery(q);
      const timings = Object.fromEntries(['off', 'on'].map(key => [key, {
        cpuMedianMs: median(cpu[key]), gpuMedianMs: median(gpuMs[key]), gpuSamples: gpuMs[key].length,
      }]));
      timings.updateCpuMedianMs = median(updateMs);
      timings.updateCpuP95Ms = percentile(updateMs, 0.95);
      timings.contactTickCpuMedianMs = median(contactCpuMs);
      timings.contactTickCpuP95Ms = percentile(contactCpuMs, 0.95);
      timings.pairedGpuDeltaMedianMs = median(pairs.filter(p => p.on != null && p.off != null).map(p => p.on - p.off));
      // Distant cameras must submit no grass at all.
      camera.position.y = 100;
      camera.updateMatrixWorld();
      field.update(camera, 10);
      const aerialBlades = field.stats.blades;
      camera.position.y = 1.4;
      camera.updateMatrixWorld();
      scene.remove(field.group);
      field.dispose();
      renderer.render(scene, camera);
      results.push({ quality, stats, timings, aerialBlades, geometriesAfterDisposal: renderer.info.memory.geometries });
    }
    const shaderErrors = (renderer.info.programs ?? []).filter(p => p.diagnostics && !p.diagnostics.runnable).length;
    renderer.dispose();
    return { gpu, resolution: `${width}x${height}, DPR 1, MSAA`, results, shaderErrors };
  }, { width, height });
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(report.shaderErrors, 0);
  for (const result of report.results) {
    assert.ok(result.stats.blades > 1000);
    assert.equal(result.aerialBlades, 0);
    assert.equal(result.geometriesAfterDisposal, 0);
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Screenshots and report: ${output}`);
} finally {
  await browser.close();
}
