// End-to-end smoke test for the world-publishing API. Works against either
// storage backend:
//
//   * Filesystem backend: set WORLDS_STORAGE_DIR=/some/path before running.
//     No external services required.
//   * R2/S3 backend: leave WORLDS_STORAGE_DIR unset. Defaults point at MinIO
//     on localhost:9000 (brought up with `npm run r2:up`), but any
//     S3-compatible endpoint with the usual R2_* env vars will work too.
//
// Either way, the script spins up an in-process http.Server that routes to
// the actual /api handlers exported from api/worlds/*.ts and exercises:
//
//   GET  /api/worlds/config              -> { enabled: true, storage }
//   POST /api/worlds/publish             -> generates id, stores gzipped JSON
//   POST /api/worlds/<id>/screenshot     -> stores JPEG
//   GET  /api/worlds                     -> lists both worlds
//   GET  /api/worlds/<id>                -> returns plain JSON (decompressed)
//   GET  /api/worlds/<id>/screenshot     -> returns the JPEG bytes
//   POST /api/worlds/publish (collision) -> still succeeds (HEAD probe path)
//
// Run via: client/node_modules/.bin/tsx scripts/test-r2-e2e.mts
//          or `npm run r2:test` from the repo root.

import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { AddressInfo } from 'node:net';

const usingFilesystem = Boolean(process.env.WORLDS_STORAGE_DIR?.trim());
if (!usingFilesystem) {
  // Configure env BEFORE importing api modules so the cached S3 client picks
  // up the endpoint. Only defaults kick in – explicitly-set R2_* env vars
  // win, so the same script works for MinIO, real R2, or LocalStack.
  process.env.R2_ENDPOINT = process.env.R2_ENDPOINT ?? 'http://localhost:9000';
  process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? 'minioadmin';
  process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? 'minioadmin';
  process.env.R2_BUCKET = process.env.R2_BUCKET ?? 'vibe-land-dev';
  process.env.R2_REGION = process.env.R2_REGION ?? 'us-east-1';
  process.env.R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE ?? '1';
}
const expectedStorageKind = usingFilesystem ? 'local' : 'r2';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const config = (await import('../api/worlds/config.js')).default as Handler;
const publish = (await import('../api/worlds/publish.js')).default as Handler;
const list = (await import('../api/worlds/index.js')).default as Handler;
const getOne = (await import('../api/worlds/[id].js')).default as Handler;
const screenshot = (await import('../api/worlds/[id]/screenshot.js')).default as Handler;

const SCREENSHOT_RE = /^\/api\/worlds\/([^/]+)\/screenshot\/?$/;
const ID_RE = /^\/api\/worlds\/([^/]+)\/?$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/api/worlds/config') return await config(req, res);
    if (path === '/api/worlds' || path === '/api/worlds/') return await list(req, res);
    if (path === '/api/worlds/publish') return await publish(req, res);
    if (SCREENSHOT_RE.test(path)) return await screenshot(req, res);
    if (ID_RE.test(path)) return await getOne(req, res);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'route not found', path }));
  } catch (err) {
    console.error('handler error', err);
    res.statusCode = 500;
    res.end(String(err));
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const addr = server.address() as AddressInfo;
const base = `http://127.0.0.1:${addr.port}`;
console.log(`test server listening on ${base}`);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const minimalWorld = {
  version: 2,
  meta: { name: 'E2E Smoke World', description: 'Created by scripts/test-r2-e2e.mts' },
  terrain: { tileGridSize: 5, tileHalfExtentM: 10, tiles: [] },
  staticProps: [],
  dynamicEntities: [],
};

try {
  // 1. config
  console.log(`GET /api/worlds/config (backend: ${expectedStorageKind})`);
  const configRes = await fetch(`${base}/api/worlds/config`);
  check('200 OK', configRes.status === 200, `got ${configRes.status}`);
  const configJson = (await configRes.json()) as { enabled: boolean; storage?: string };
  check('enabled is true', configJson.enabled === true, JSON.stringify(configJson));
  check(`storage is ${expectedStorageKind}`, configJson.storage === expectedStorageKind, JSON.stringify(configJson));

  // 2. publish a world
  console.log('POST /api/worlds/publish (gzipped)');
  const json = JSON.stringify(minimalWorld);
  const gzipped = gzipSync(Buffer.from(json, 'utf-8'));
  const publishRes = await fetch(`${base}/api/worlds/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: gzipped,
  });
  check('201 Created', publishRes.status === 201, `got ${publishRes.status}`);
  const publishJson = (await publishRes.json()) as { id: string; createdAt: number };
  check('id present', typeof publishJson.id === 'string' && publishJson.id.length >= 8);
  check('createdAt present', typeof publishJson.createdAt === 'number');
  const id = publishJson.id;
  console.log(`    -> id ${id}`);

  // 3. publish another to verify collision-safe path tolerates back-to-back PUTs
  console.log('POST /api/worlds/publish (second world)');
  const second = await fetch(`${base}/api/worlds/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: gzipSync(Buffer.from(JSON.stringify({
      ...minimalWorld,
      meta: { name: 'Second world', description: '' },
    }), 'utf-8')),
  });
  check('second 201', second.status === 201);
  const secondJson = (await second.json()) as { id: string };
  check('second id differs', secondJson.id !== id);

  // 4. upload a screenshot
  console.log(`POST /api/worlds/${id}/screenshot`);
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const ssRes = await fetch(`${base}/api/worlds/${id}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: fakeJpeg,
  });
  check('201 Created', ssRes.status === 201, `got ${ssRes.status}`);
  const ssJson = (await ssRes.json()) as { ok: boolean; size: number };
  check('size matches', ssJson.size === fakeJpeg.length);

  // 5. screenshot for an unknown id should 404
  console.log('POST /api/worlds/nonexistent-1234/screenshot');
  const ssBad = await fetch(`${base}/api/worlds/nonexistent-1234/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: fakeJpeg,
  });
  check('404 for missing world', ssBad.status === 404, `got ${ssBad.status}`);

  // 6. list worlds
  console.log('GET /api/worlds');
  const listRes = await fetch(`${base}/api/worlds`);
  check('200 OK', listRes.status === 200);
  const listJson = (await listRes.json()) as { worlds: Array<{ id: string; name: string }> };
  check('list contains both ids', listJson.worlds.some((w) => w.id === id) && listJson.worlds.some((w) => w.id === secondJson.id), JSON.stringify(listJson.worlds.map((w) => w.id)));
  const target = listJson.worlds.find((w) => w.id === id);
  check('list metadata.name decoded', target?.name === 'E2E Smoke World', target?.name);

  // 7. get the world back as plain JSON
  console.log(`GET /api/worlds/${id}`);
  const getRes = await fetch(`${base}/api/worlds/${id}`);
  check('200 OK', getRes.status === 200);
  check('Content-Type application/json', (getRes.headers.get('content-type') ?? '').includes('application/json'));
  const got = (await getRes.json()) as typeof minimalWorld;
  check('round-trip name', got.meta.name === minimalWorld.meta.name);
  check('round-trip version', got.version === 2);
  check('round-trip arrays', Array.isArray(got.staticProps) && Array.isArray(got.dynamicEntities));

  // 8. get the screenshot back
  console.log(`GET /api/worlds/${id}/screenshot`);
  const ssGet = await fetch(`${base}/api/worlds/${id}/screenshot`);
  check('200 OK', ssGet.status === 200);
  check('Content-Type image/jpeg', (ssGet.headers.get('content-type') ?? '').startsWith('image/'));
  const bytes = new Uint8Array(await ssGet.arrayBuffer());
  check('byte length matches', bytes.length === fakeJpeg.length);
  check('byte content matches', Buffer.from(bytes).equals(fakeJpeg));

  // 9. unknown id 404
  console.log('GET /api/worlds/missing-id');
  const missing = await fetch(`${base}/api/worlds/missing-id`);
  check('404', missing.status === 404);
} catch (err) {
  failures += 1;
  console.error('test threw', err);
}

server.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
