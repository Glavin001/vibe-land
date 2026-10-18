// Find what makes Dawn reject WriteBuffer ("Size (N) is not a multiple of 4")
// in the native app (scripts/native-mac.sh trace-writes). WebGPU requires
// buffer writes in multiples of 4 bytes; three's full-buffer upload writes the
// whole typed array, so any attribute or index whose byte length is not a
// multiple of 4 is rejected and that buffer silently keeps stale data.
//
// Counts the rejected writes by size while the city fractures, and names every
// scene attribute with such a byte length (object, parent chain, attribute).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => console.log(`[trace] ${text}`);

async function waitFor(what, predicate, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const unaligned = new Map();
function watchWrites() {
  const gpu = navigator.gpu;
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await requestDevice(descriptor);
      const queue = device.queue;
      const writeBuffer = queue.writeBuffer.bind(queue);
      queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size) => {
        const bytesPer = data.BYTES_PER_ELEMENT ?? 1;
        const bytes = size !== undefined ? size * bytesPer : data.byteLength - dataOffset * bytesPer;
        if (bytes % 4 !== 0) unaligned.set(bytes, (unaligned.get(bytes) ?? 0) + 1);
        return writeBuffer(buffer, offset, data, dataOffset, size);
      };
      return device;
    };
    return adapter;
  };
}

const chain = (object) => {
  const names = [];
  for (let o = object; o; o = o.parent) names.push(`${o.type}${o.name ? ` "${o.name}"` : ''}`);
  return names.slice(0, 5).join(' < ');
};

/** Every attribute or index in the scene whose byte length is not a multiple of 4. */
function oddAttributes(scene) {
  const found = new Map();
  scene.traverse((object) => {
    const geometry = object.geometry;
    if (!geometry?.attributes) return;
    const entries = Object.entries(geometry.attributes);
    if (geometry.index) entries.push(['(index)', geometry.index]);
    for (const [name, attribute] of entries) {
      const array = attribute.array ?? attribute.data?.array;
      if (!array || array.byteLength % 4 === 0) continue;
      const key = `${chain(object)} :: ${name} ${array.constructor.name}[${attribute.itemSize}]`;
      const entry = found.get(key) ?? { n: 0, lengths: new Set(), version: 0 };
      entry.n += 1;
      entry.lengths.add(array.length);
      entry.version = Math.max(entry.version, attribute.version ?? 0);
      found.set(key, entry);
    }
  });
  return found;
}

async function run() {
  watchWrites();
  const source = await (await fetch('file://./game-iife.js')).text();
  (0, eval)(source);
  const e2e = await waitFor('the test bridge', () => globalThis.__VIBE_E2E__);
  const session = await waitFor('the in-process session', () => globalThis.__VIBE_NATIVE_SESSION__);
  const store = await waitFor('the scene store', () => globalThis.__VIBE_NATIVE_STORE__);
  await waitFor('the city', () => (e2e.snapshot()?.city?.chunksTotal ?? 0) > 0 && e2e.cityStructures().length > 0);
  await waitFor('the shader warmup', () => e2e.shaderBuilds().playing, 90_000);
  await sleep(2000);
  log(`unaligned writes before destruction: ${[...unaligned.values()].reduce((a, b) => a + b, 0)}`);

  const structures = [...e2e.cityStructures()].sort((a, b) => b.top - a.top);
  const seen = new Map();
  for (const target of structures.slice(0, 3)) {
    session.meteor(target.position[0], target.top ?? target.position[1], target.position[2]);
    for (let i = 0; i < 8; i += 1) {
      await sleep(1000);
      for (const [key, entry] of oddAttributes(store.getState().scene)) {
        const all = seen.get(key) ?? { n: 0, lengths: new Set(), version: 0 };
        all.n = Math.max(all.n, entry.n);
        for (const length of entry.lengths) all.lengths.add(length);
        all.version = Math.max(all.version, entry.version);
        seen.set(key, all);
      }
    }
  }
  const sizes = [...unaligned.entries()].sort((a, b) => b[1] - a[1]);
  log(`unaligned writes: ${sizes.reduce((sum, [, n]) => sum + n, 0)} (by size: ${sizes.slice(0, 12).map(([size, n]) => `${size}B x${n}`).join(', ')})`);
  log(`attributes with a byte length not a multiple of 4: ${seen.size}`);
  for (const [key, entry] of seen) {
    log(`  ${key}  objects ${entry.n}  lengths ${[...entry.lengths].slice(0, 8).join(',')}  version ${entry.version}`);
  }
  log('done');
  setTimeout(() => process.exit(0), 300);
}

run().catch((error) => {
  log(`failed: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
});
