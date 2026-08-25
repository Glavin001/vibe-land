import { chromium } from 'playwright-core';
const GPU_ARGS = ['--no-sandbox','--disable-gpu-sandbox','--ignore-certificate-errors','--allow-insecure-localhost',
  '--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist','--enable-gpu-rasterization',
  '--disable-gpu-vsync','--disable-frame-rate-limit'];
const b = await chromium.launch({ headless: true, args: GPU_ARGS });
const p = await b.newPage({ ignoreHTTPSErrors: true });
await p.goto('about:blank');
console.log(await p.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
    renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
    version: gl.getParameter(gl.VERSION),
    multiDraw: !!gl.getExtension('WEBGL_multi_draw'),
    maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
}));
await b.close();
