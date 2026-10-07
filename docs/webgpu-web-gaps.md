# WebGPU on the web: known gaps

The web client builds for three's WebGPURenderer by default (the same path as
the native macOS app). `VITE_RENDER_BACKEND=webgl` (`npm run dev:webgl`,
`npm run build:webgl`) builds the legacy WebGLRenderer client. It is a
build-time flag: rolling back means a rebuild and a redeploy.

These were found while porting the Matter materials (docs/matter-materials.md).
None of them blocks /city. They are listed here to be filled in later.

## Rendering

- **WebGL-only post-processing.** `CityEnvironment.tsx` gates the frame
  pipeline (SSAO, volumetric dust) and `WeatherParticles` behind
  `!__WEBGPU__`. On WebGPU the city has neither.
- **No GPU timing on the web.** `renderStats.gpuFrameMs` comes from
  `EXT_disjoint_timer_query_webgl2`, which exists only on WebGL. The web
  WebGPU renderer is created with `trackTimestamp: false`. The native app
  reads WebGPU timestamps in `NativeFpsCounter.tsx`. Frame-cost specs such as
  `city-render-cost.spec.ts` therefore see no GPU numbers on the WebGPU build.
- **Image-based lighting is sky only.** The city's environment map is the
  baked sky (`SkyEnvironment.tsx`), with a dim ground hemisphere. Metals
  reflect that and nothing else, so a vertical steel panel (a fridge side)
  mostly reflects the dim ground half and reads dark. Local reflection probes
  (a PMREM `fromScene` near the player, as the Matter lab's architecture
  scenes do) would fix it.
- **three r182 quirks** (worked around in `graphics/matter/specimens.ts`):
  - three's automatic PMREM of a `DataTexture` equirect leaves its glossy
    levels black, so the texture is prefiltered explicitly.
  - r182's WebGPU equirect lookup reads a DataTexture's first row as straight
    down, where r185 reads it as up.

## Pages

Smoke-tested on the WebGPU build: `/`, `/practice`, `/garage`, `/materials`
and `/city` load and draw without errors. One page does not:

- **`/grass` (the grass lab) crashes:** "this._renderer.hasInitialized is not
  a function" in `<SkyEnvironment>`. Its `<Canvas>` does not go through
  `withRenderBackend`, so it creates a WebGLRenderer, and the WebGPU build's
  sky bake runs three/webgpu's PMREMGenerator against it.

## Tests

- **Unit tests run on the WebGL modules.** Vitest keeps the WebGL build's
  modules (`mode === 'test'`, see `vite.config.ts`). Under
  `VITE_RENDER_BACKEND=webgpu`, 10 grass tests fail that pass on WebGL:
  - `GrassPatchWorker`
  - `foliageBuffers`
  - `foliageLod`
  - `grassPaint`
  - `grassPlacement`
- **Already failing on this branch's base, on both backends:**
  `vehicleLiveTuning.test.ts`, "retains vehicle meshes and instance buffers…".

## Server and native

- **Free props on open ground.** The server's destruction stage rejects every
  step (error bits 4128) for the material showcase scene, which has free
  props on open ground (`structures/town-kit/scripts/build-material-showcase.mjs`).
  The in-process native sim runs the same pack cleanly. Because no poses
  stream, the web client draws only anchored structures in that scene.
- **mystralnative quirks:**
  - It has no `structuredClone`; recipes are cloned through JSON.
  - A screenshot readback that times out (GPU busy) leaves the buffer mapped,
    so every later `__mystralSaveScreenshot` in that run fails with "already
    mapped".
  - The FPS counter's `resolveTimestampsAsync` readbacks
    (`__VIBE_NATIVE_GPU_MS__`) stop arriving partway through a long headless
    run, with or without Matter. Native GPU timings from
    `native-mac.sh matter-look` are trustworthy only for poses that report
    readbacks.
