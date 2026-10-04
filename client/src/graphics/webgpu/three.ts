// What bare `three` resolves to in the webgpu build (see vite.config.ts).
//
// The webgpu build uses its own three, `three-webgpu` (an npm alias of the
// three release mystralnative is tested against), so the WebGL client keeps
// its version untouched. three/webgpu is all of three plus the node renderer,
// minus the WebGL renderer's own modules; drei and three-stdlib import some of
// those by name (UniformsUtils, ShaderChunk, ...) from code the simple WebGPU
// path never runs, and a missing named export fails the build. They come from
// the classic build, which shares three.core.js with three/webgpu, so there is
// still one copy of every core class. (By relative path: three's package
// exports hide build/.)
export * from 'three-webgpu/webgpu';
export {
  ShaderChunk,
  ShaderLib,
  UniformsLib,
  UniformsUtils,
  WebGLRenderer,
  WebGLUtils,
  // @ts-expect-error -- the classic build ships no typings of its own; these
  // names are typed through `three` everywhere they are used.
} from '../../../node_modules/three-webgpu/build/three.module.js';
