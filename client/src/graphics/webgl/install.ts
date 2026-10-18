// `@render-backend/install` in the WebGL client: nothing to install. The
// webgpu build resolves the same specifier to graphics/webgpu/install.ts
// (see vite.config.ts), so WebGPU-only modules are never loaded here.
export {};
