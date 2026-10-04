// `three-webgpu` is an npm alias of a newer three release, used only by the
// webgpu build. It is typed as the repo's three: the simple WebGPU path only
// uses APIs both releases share.
declare module 'three-webgpu/webgpu' {
  export * from 'three/webgpu';
}
declare module 'three-webgpu/tsl' {
  export * from 'three/tsl';
}
