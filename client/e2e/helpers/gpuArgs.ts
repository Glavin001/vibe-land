// Real GPU rendering. Without `--use-angle=vulkan` Chromium silently picks
// SwiftShader even on a machine with a discrete GPU, and every frame-time
// number then measures software rasterisation instead of the product: a city
// collapse read 133 ms/frame under SwiftShader and 16.7 ms on the same box
// through ANGLE/Vulkan. Hosts without a GPU still fall back automatically.
// Shared by the e2e Playwright config and the netlab runner so the two can
// never drift apart.
export const GPU_ARGS = [
  '--enable-quic',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--ignore-certificate-errors',
  '--allow-insecure-localhost',
  '--use-gl=angle',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
];
