import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getR2Client, buildPublishedKey, isValidWorldId } from '../_lib/r2.js';
import { sendError } from '../_lib/http.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  const r2 = getR2Client();
  if (!r2) {
    sendError(res, 503, 'Cloudflare R2 is not configured on this deployment.');
    return;
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  // On Vercel the dynamic id is exposed via the last path segment. Parse it
  // from the URL so we work in both `vercel dev` and deployed environments
  // without relying on framework-specific request augmentations.
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const id = decodeURIComponent(last);
  if (!id || !isValidWorldId(id)) {
    sendError(res, 400, 'Invalid world id.');
    return;
  }

  let object;
  try {
    object = await r2.client.send(
      new GetObjectCommand({ Bucket: r2.bucket, Key: buildPublishedKey(id) }),
    );
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') {
      sendError(res, 404, 'World not found.');
      return;
    }
    console.error('[worlds/id] Failed to fetch object', err);
    sendError(res, 502, 'Failed to fetch world.');
    return;
  }

  const body = object.Body;
  if (!body) {
    sendError(res, 502, 'World body missing.');
    return;
  }

  // Objects are stored gzipped (ContentEncoding: gzip on the S3 object).
  // Decompress here so clients always see plain JSON, regardless of which
  // transport layer gzips/ungzips for them. Vercel's edge will re-gzip the
  // response based on Accept-Encoding automatically.
  let stored: Buffer;
  try {
    stored = Buffer.from(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  } catch (err) {
    console.error('[worlds/id] Failed to buffer body', err);
    sendError(res, 502, 'Failed to read world body.');
    return;
  }

  let plain: Buffer;
  const encoding = (object.ContentEncoding ?? '').toLowerCase();
  if (encoding.includes('gzip')) {
    try {
      plain = gunzipSync(stored);
    } catch (err) {
      console.error('[worlds/id] Failed to decompress stored world', err);
      sendError(res, 502, 'Failed to decompress stored world.');
      return;
    }
  } else {
    plain = stored;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(plain);
}
