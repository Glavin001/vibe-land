import * as T from 'three';
import { GrassField } from '../src/scene/grass/GrassField';
import { GrassPaint, GRASS_BRUSHES } from '../src/scene/grass/GrassPaint';
import { GRASS_DENSITY_SHADER, GRASS_WIDTH_SHADER } from '../src/scene/grass/grassMaterial';
import { createBenchmarkSky } from './foliage-sky';

const button = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector('#status')!, output = document.querySelector('#report')!;
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? { median: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], samples: sorted.length } : null;
};

button.onclick = async () => {
  button.disabled = true; output.textContent = '';
  const renderer = new T.WebGLRenderer({ antialias: true });
  const shadows = new URLSearchParams(location.search).has('shadows');
  renderer.shadowMap.enabled = shadows; renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = shadows;
  renderer.setSize(1920, 1080); output.before(renderer.domElement);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const sky = createBenchmarkSky(renderer), scene = new T.Scene();
  scene.environment = sky.texture; scene.background = new T.Color('#a8b5ba');
  scene.add(new T.HemisphereLight('#ffffff', '#526141', 2));
  const sun = new T.DirectionalLight('#fff5d7', 2); sun.position.set(30, 50, 20); scene.add(sun);
  sun.castShadow = shadows; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: .1, far: 200 });
  sun.shadow.camera.updateProjectionMatrix(); sun.shadow.normalBias = .04;
  const blocker = new T.Mesh(new T.BoxGeometry(6, 10, 6), new T.MeshStandardMaterial({ color: '#99978b' }));
  blocker.position.set(4, 5, 0); blocker.castShadow = true; if (shadows) scene.add(blocker);
  const camera = new T.PerspectiveCamera(55, 16 / 9, .1, 600), report: unknown[] = [];
  const target = new T.WebGLRenderTarget(960, 540);
  const beforePixels = new Uint8Array(960 * 540 * 4), afterPixels = new Uint8Array(beforePixels.length);
  let field: GrassField | undefined, paint: GrassPaint | undefined, reference: T.MeshStandardMaterial | undefined;
  const cases = [
    ['vehicle', 3], ['vehicle', 12], ['vehicle', 35], ['corn', 12], ['corn', 35],
    ['ferns', 12], ['wheat', 12], ['lawn', 12], ['vehicle', -12], ['corn', -12],
  ] as const;
  try {
    if (!timer) throw new Error('GPU timer queries unavailable');
    for (const [preset, distance] of cases) {
      paint = new GrassPaint(); if (preset !== 'lawn') paint.paint(0, 0, distance === 3 ? 3 : 24, GRASS_BRUSHES[preset]);
      field = new GrassField('pretty', [], paint); scene.add(field.group); field.setShadows(shadows);
      camera.position.set(0, 1.4, distance); camera.lookAt(0, 1.4, 0); camera.updateMatrixWorld();
      for (let i = 0; i < 600; i++) {
        field.update(camera, performance.now() / 1000); renderer.render(scene, camera); await frame();
        if (i >= 120 && !field.stats.pendingPatches) break;
      }
      const time = performance.now() / 1000 + 1; field.update(camera, time);
      const optimized = field.shading.material;
      reference = optimized.clone();
      reference.onBeforeCompile = (shader, renderer) => {
        optimized.onBeforeCompile(shader, renderer);
        for (const [chunk, original] of [[GRASS_DENSITY_SHADER, 'density = vGrassCanopy > 0.5 ? 1.0 : density;'], [GRASS_WIDTH_SHADER, '']]) {
          if (!shader.vertexShader.includes(chunk)) throw new Error('Reference shader no longer matches production');
          shader.vertexShader = shader.vertexShader.replace(chunk, original);
        }
      };
      reference.customProgramCacheKey = () => `${optimized.customProgramCacheKey()}-budget-reference`;
      const near: T.Mesh<T.InstancedBufferGeometry>[] = [];
      field.group.traverse(o => { if (o instanceof T.Mesh && o.geometry.hasAttribute('grassRoot')) near.push(o as T.Mesh<T.InstancedBufferGeometry>); });
      const originalMaterials = new Map(near.map(mesh => [mesh, mesh.material]));
      const counts = new Map(near.map(mesh => [mesh, mesh.geometry.instanceCount]));
      const variants = ['reference', 'optimized', 'referenceRepeat'] as const;
      type Variant = typeof variants[number];
      const select = (variant: Variant) => {
        for (const mesh of near) {
          mesh.material = variant === 'optimized' ? originalMaterials.get(mesh)! : reference!;
          mesh.geometry.instanceCount = variant !== 'optimized' && mesh.geometry.getAttribute('grassBirth').getY(0) > .5
            ? mesh.geometry.getAttribute('grassRoot').count : counts.get(mesh)!;
        }
      };
      // Warm both shader programs before queries. One variant per display frame
      // avoids a many-pass synthetic GPU queue that does not resemble game use.
      for (let i = 0; i < 12; i++) { select(variants[i % variants.length]); renderer.render(scene, camera); await frame(); }
      const queries: { q: WebGLQuery; key: string }[] = [], results = new Map<string, number>();
      const drain = () => {
        while (queries.length && gl.getQueryParameter(queries[0].q, gl.QUERY_RESULT_AVAILABLE)) {
          const { q, key } = queries.shift()!;
          if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) results.set(key, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(q);
        }
      };
      status.textContent = `Measuring ${preset} / ${distance} m`;
      for (let turn = 0; turn < 96 * variants.length; turn++) {
        const i = Math.floor(turn / variants.length), variant = variants[(turn % variants.length + i) % variants.length];
        select(variant);
        for (const on of i % 2 ? [true, false] : [false, true]) {
          field.group.visible = on;
          const q = gl.createQuery()!; gl.beginQuery(timer.TIME_ELAPSED_EXT, q); renderer.render(scene, camera); gl.endQuery(timer.TIME_ELAPSED_EXT);
          queries.push({ q, key: `${variant}/${i}/${on}` });
        }
        drain(); await frame();
      }
      for (let i = 0; queries.length && i < 120; i++) { await frame(); drain(); }
      for (const { q } of queries) gl.deleteQuery(q);
      const costs = Object.fromEntries(variants.map(variant => {
        const values: number[] = [];
        for (let i = 0; i < 96; i++) {
          const on = results.get(`${variant}/${i}/true`), off = results.get(`${variant}/${i}/false`);
          if (on !== undefined && off !== undefined) values.push(on - off);
        }
        return [variant, summary(values)];
      }));
      // Same camera, time, roots, light and contact state. Test visibility and
      // color directly, including a stressed wind/compaction configuration.
      field.group.visible = true;
      const parity = [];
      for (const pressed of [false, true]) {
        if (pressed) {
          field.setWind(40, 65); field.interaction.begin(time, 0, 0);
          field.interaction.stamp({ x: 0, z: 8, radiusX: 8, radiusZ: 8, shape: 'box', pressure: 1, damage: .8 });
          field.interaction.canopy(2, 2, 10, 3); field.interaction.impulse(0, 10, time, 1);
          field.shading.uniforms.grassViewer.value.set(0, 1.4, 10);
          field.interaction.commit(); field.update(camera, time + .1);
        }
        renderer.setRenderTarget(target);
        field.group.visible = false; renderer.render(scene, camera);
        const empty = new Uint8Array(beforePixels.length); renderer.readRenderTargetPixels(target, 0, 0, 960, 540, empty); field.group.visible = true;
        select('reference'); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 960, 540, beforePixels);
        select('optimized'); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 960, 540, afterPixels);
        renderer.setRenderTarget(null);
        let changedPixels = 0, totalDifference = 0, referenceCoverage = 0, optimizedCoverage = 0, referenceLuma = 0, optimizedLuma = 0;
        for (let at = 0; at < beforePixels.length; at += 4) {
          let difference = 0;
          for (let c = 0; c < 3; c++) difference = Math.max(difference, Math.abs(beforePixels[at + c] - afterPixels[at + c]));
          if (difference > 2) changedPixels++; totalDifference += difference;
          const coveredBefore = Math.max(Math.abs(beforePixels[at]-empty[at]),Math.abs(beforePixels[at+1]-empty[at+1]),Math.abs(beforePixels[at+2]-empty[at+2])) > 3;
          const coveredAfter = Math.max(Math.abs(afterPixels[at]-empty[at]),Math.abs(afterPixels[at+1]-empty[at+1]),Math.abs(afterPixels[at+2]-empty[at+2])) > 3;
          if (coveredBefore) { referenceCoverage++; referenceLuma += beforePixels[at]*.2126+beforePixels[at+1]*.7152+beforePixels[at+2]*.0722; }
          if (coveredAfter) { optimizedCoverage++; optimizedLuma += afterPixels[at]*.2126+afterPixels[at+1]*.7152+afterPixels[at+2]*.0722; }
        }
        const coverageRatio = optimizedCoverage / referenceCoverage;
        const luminanceRatio = (optimizedLuma / optimizedCoverage) / (referenceLuma / referenceCoverage);
        parity.push({ pressed, changedPixels, totalPixels: 960 * 540, coverageRatio, luminanceRatio, meanMaxChannelDifference: totalDifference / (960 * 540) });
        if (distance === 3 && changedPixels > 960 * 540 * .001) throw new Error('Close detail changed');
        if (coverageRatio < .98 || Math.abs(luminanceRatio-1) > .05) throw new Error(`Canopy mass/color changed: ${preset}/${distance}: ${coverageRatio}/${luminanceRatio}`);

      }
      report.push({ preset, distance, shadows, costs, parity, ...field.stats }); output.textContent = JSON.stringify(report, null, 2);
      scene.remove(field.group); field.dispose(); field = undefined;
      reference.dispose(); reference = undefined; paint.dispose(); paint = undefined;
    }
    status.textContent = 'Complete';
  } catch (error) { status.textContent = `Failed: ${String(error)}`; }
  finally { field?.dispose(); reference?.dispose(); paint?.dispose(); blocker.geometry.dispose(); blocker.material.dispose(); sun.shadow.dispose(); target.dispose(); sky.dispose(); renderer.dispose(); renderer.domElement.remove(); button.disabled = false; }
};
