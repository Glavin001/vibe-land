// What bare `three` resolves to in the webgpu build (see vite.config.ts).
//
// The webgpu build uses its own three, `three-webgpu` (an npm alias of the
// three release mystralnative is tested against), so the WebGL client keeps
// its version untouched. three/webgpu is all of three plus the node renderer,
// minus the WebGL renderer's own modules; drei and three-stdlib import some of
// those by name (UniformsUtils, ShaderChunk, ...) from code the simple WebGPU
// path never runs, and a missing named export fails the build. They come from
// three's src/ modules by bare specifier, so the dev server's dependency
// pre-bundles leave them external (three-webgpu is excluded there) instead of
// inlining a second copy of three into drei's chunk.
export * from 'three-webgpu/webgpu';
export { ShaderChunk } from 'three-webgpu/src/renderers/shaders/ShaderChunk.js';
export { ShaderLib } from 'three-webgpu/src/renderers/shaders/ShaderLib.js';
export { UniformsLib } from 'three-webgpu/src/renderers/shaders/UniformsLib.js';
export { UniformsUtils } from 'three-webgpu/src/renderers/shaders/UniformsUtils.js';
export { WebGLRenderer } from 'three-webgpu/src/renderers/WebGLRenderer.js';
export { WebGLUtils } from 'three-webgpu/src/renderers/webgl/WebGLUtils.js';
