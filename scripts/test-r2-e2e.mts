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
// the actual /api handlers exported from api/worlds/*.ts and exercises the
// full two-phase publish protocol:
//
//   1. POST /api/worlds/publish            -> reserves id, returns upload URLs
//   2. PUT  <returned world url>           -> uploads gzipped world bytes
//   3. PUT  <returned screenshot url>      -> uploads jpeg bytes
//   4. GET  /api/worlds/config             -> { enabled, storage }
//   5. GET  /api/worlds                    -> list sees both worlds
//   6. GET  /api/worlds/<id>               -> returns plain JSON
//   7. GET  /api/worlds/<id>/screenshot    -> returns jpeg bytes
//   8. POST /api/worlds/<id>/screenshot    -> must return 405 (removed)
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
const expectedMode = usingFilesystem ? 'direct' : 'presigned';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const config = (await import('../api/worlds/config.js')).default as Handler;
const publish = (await import('../api/worlds/publish.js')).default as Handler;
const list = (await import('../api/worlds/index.js')).default as Handler;
const getOne = (await import('../api/worlds/[id].js')).default as Handler;
const screenshot = (await import('../api/worlds/[id]/screenshot.js')).default as Handler;
const upload = (await import('../api/worlds/[id]/upload.js')).default as Handler;

const SCREENSHOT_RE = /^\/api\/worlds\/([^/]+)\/screenshot\/?$/;
const UPLOAD_RE = /^\/api\/worlds\/([^/]+)\/upload\/?$/;
const ID_RE = /^\/api\/worlds\/([^/]+)\/?$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/api/worlds/config') return await config(req, res);
    if (path === '/api/worlds' || path === '/api/worlds/') return await list(req, res);
    if (path === '/api/worlds/publish') return await publish(req, res);
    if (SCREENSHOT_RE.test(path)) return await screenshot(req, res);
    if (UPLOAD_RE.test(path)) return await upload(req, res);
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
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

// Direct-upload URLs returned by the filesystem backend are relative and
// need to be resolved against our test server. Presigned URLs come back
// absolute so fetch() picks the right host.
function resolveUploadUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${base}${url}`;
}

type Reservation = {
  id: string;
  createdAt: number;
  expiresAt: number;
  mode: 'presigned' | 'direct';
  world: { url: string; method: 'PUT'; contentLength: number; headers: Record<string, string> };
  screenshot: { url: string; method: 'PUT'; contentLength: number; headers: Record<string, string> };
};

async function runPublish(opts: { name: string; description: string; gzippedWorld: Buffer; jpeg: Buffer }): Promise<Reservation> {
  const reserveRes = await fetch(`${base}/api/worlds/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: opts.name,
      description: opts.description,
      version: 2,
      worldContentLength: opts.gzippedWorld.length,
      screenshotContentLength: opts.jpeg.length,
    }),
  });
  if (reserveRes.status !== 201) {
    throw new Error(`publish reservation failed: ${reserveRes.status} ${await reserveRes.text()}`);
  }
  const reservation = (await reserveRes.json()) as Reservation;

  const worldUpload = await fetch(resolveUploadUrl(reservation.world.url), {
    method: 'PUT',
    headers: reservation.world.headers,
    body: opts.gzippedWorld,
  });
  if (!worldUpload.ok) {
    throw new Error(`world upload failed: ${worldUpload.status} ${await worldUpload.text()}`);
  }

  const screenshotUpload = await fetch(resolveUploadUrl(reservation.screenshot.url), {
    method: 'PUT',
    headers: reservation.screenshot.headers,
    body: opts.jpeg,
  });
  if (!screenshotUpload.ok) {
    throw new Error(`screenshot upload failed: ${screenshotUpload.status} ${await screenshotUpload.text()}`);
  }

  return reservation;
}

try {
  // 1. config
  console.log(`GET /api/worlds/config (backend: ${expectedStorageKind})`);
  const configRes = await fetch(`${base}/api/worlds/config`);
  check('200 OK', configRes.status === 200, `got ${configRes.status}`);
  const configJson = (await configRes.json()) as { enabled: boolean; storage?: string };
  check('enabled is true', configJson.enabled === true, JSON.stringify(configJson));
  check(`storage is ${expectedStorageKind}`, configJson.storage === expectedStorageKind, JSON.stringify(configJson));

  // 2. publish (two-phase) — first world
  console.log('POST /api/worlds/publish + PUT world + PUT screenshot');
  const worldJson = JSON.stringify(minimalWorld);
  const gzippedWorld = gzipSync(Buffer.from(worldJson, 'utf-8'));
  const first = await runPublish({
    name: minimalWorld.meta.name,
    description: minimalWorld.meta.description,
    gzippedWorld,
    jpeg: fakeJpeg,
  });
  check(`mode is ${expectedMode}`, first.mode === expectedMode, first.mode);
  check('id present', typeof first.id === 'string' && first.id.length >= 8);
  check('expiresAt > createdAt', first.expiresAt > first.createdAt);
  check('expiresAt within ~60s', first.expiresAt - first.createdAt <= 61_000);
  check('world contentLength echoes our upload size', first.world.contentLength === gzippedWorld.length);
  check('screenshot contentLength echoes our upload size', first.screenshot.contentLength === fakeJpeg.length);
  console.log(`    -> id ${first.id}`);

  // 3. publish a second world so list has two entries
  console.log('POST /api/worlds/publish (second world)');
  const secondJson = JSON.stringify({ ...minimalWorld, meta: { name: 'Second world', description: '' } });
  const secondGzipped = gzipSync(Buffer.from(secondJson, 'utf-8'));
  const second = await runPublish({
    name: 'Second world',
    description: '',
    gzippedWorld: secondGzipped,
    jpeg: fakeJpeg,
  });
  check('second id differs', second.id !== first.id);

  // 4. publish with a size that lies → should be caught either at upload
  //    (presigned signature mismatch / fs size mismatch). We don't check the
  //    specific error class here because R2 and filesystem report different
  //    status codes – we just assert non-2xx.
  console.log('POST /api/worlds/publish + lying about sizes');
  const lyingReserve = await fetch(`${base}/api/worlds/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'liar',
      description: '',
      version: 2,
      worldContentLength: 10,
      screenshotContentLength: 10,
    }),
  });
  check('reservation itself still OK', lyingReserve.status === 201);
  if (lyingReserve.status === 201) {
    const lyingRes = (await lyingReserve.json()) as Reservation;
    const wrongUpload = await fetch(resolveUploadUrl(lyingRes.world.url), {
      method: 'PUT',
      headers: lyingRes.world.headers,
      // 42 bytes, not the 10 we reserved
      body: Buffer.alloc(42, 0xaa),
    });
    check('upload with wrong size rejected', !wrongUpload.ok, `got ${wrongUpload.status}`);
  }

  // 5. POST /api/worlds/<id>/screenshot is removed → must be 405
  console.log('POST /api/worlds/<id>/screenshot (removed endpoint)');
  const legacyPost = await fetch(`${base}/api/worlds/${first.id}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: fakeJpeg,
  });
  check('legacy POST returns 405', legacyPost.status === 405, `got ${legacyPost.status}`);

  // 6. list
  console.log('GET /api/worlds');
  const listRes = await fetch(`${base}/api/worlds`);
  check('200 OK', listRes.status === 200);
  const listJson = (await listRes.json()) as { worlds: Array<{ id: string; name: string }> };
  check(
    'list contains both ids',
    listJson.worlds.some((w) => w.id === first.id) && listJson.worlds.some((w) => w.id === second.id),
    JSON.stringify(listJson.worlds.map((w) => w.id)),
  );
  const target = listJson.worlds.find((w) => w.id === first.id);
  check('list metadata.name decoded', target?.name === 'E2E Smoke World', target?.name);

  // 7. get world back as plain JSON
  console.log(`GET /api/worlds/${first.id}`);
  const getRes = await fetch(`${base}/api/worlds/${first.id}`);
  check('200 OK', getRes.status === 200);
  check('Content-Type application/json', (getRes.headers.get('content-type') ?? '').includes('application/json'));
  const got = (await getRes.json()) as typeof minimalWorld;
  check('round-trip name', got.meta.name === minimalWorld.meta.name);
  check('round-trip version', got.version === 2);
  check('round-trip arrays', Array.isArray(got.staticProps) && Array.isArray(got.dynamicEntities));

  // 8. get screenshot back
  console.log(`GET /api/worlds/${first.id}/screenshot`);
  const ssGet = await fetch(`${base}/api/worlds/${first.id}/screenshot`);
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
