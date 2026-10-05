// `three-webgpu` is an npm alias of a newer three release, used only by the
// webgpu build. It is typed as the repo's three: the simple WebGPU path only
// uses APIs both releases share.
declare module 'three-webgpu/webgpu' {
  export * from 'three/webgpu';
}
declare module 'three-webgpu/tsl' {
  export * from 'three/tsl';
}
declare module 'three-webgpu/src/renderers/shaders/ShaderChunk.js' {
  export { ShaderChunk } from 'three';
}
declare module 'three-webgpu/src/renderers/shaders/ShaderLib.js' {
  export { ShaderLib } from 'three';
}
declare module 'three-webgpu/src/renderers/shaders/UniformsLib.js' {
  export { UniformsLib } from 'three';
}
declare module 'three-webgpu/src/renderers/shaders/UniformsUtils.js' {
  export { UniformsUtils } from 'three';
}
declare module 'three-webgpu/src/renderers/WebGLRenderer.js' {
  export { WebGLRenderer } from 'three';
}
declare module 'three-webgpu/src/renderers/webgl/WebGLUtils.js' {
  export { WebGLUtils } from 'three';
}
