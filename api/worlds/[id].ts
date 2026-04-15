import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { getWorldStorage, isValidWorldId } from '../_lib/storage.js';
import { sendError } from '../_lib/http.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  const storage = getWorldStorage();
  if (!storage) {
    sendError(res, 503, 'World storage is not configured on this deployment.');
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

  let content;
  try {
    content = await storage.getWorld(id);
  } catch (err) {
    console.error('[worlds/id] Failed to fetch world', err);
    sendError(res, 502, 'Failed to fetch world.');
    return;
  }
  if (!content) {
    sendError(res, 404, 'World not found.');
    return;
  }

  // Storage implementations always hand us gzipped bytes (R2 stores them
  // with ContentEncoding: gzip, the filesystem backend never decompresses
  // on write). Decompress here so clients always see plain JSON, regardless
  // of transport layer behaviour.
  let plain: Buffer;
  if (content.contentEncoding === 'gzip') {
    try {
      plain = gunzipSync(content.bytes);
    } catch (err) {
      console.error('[worlds/id] Failed to decompress stored world', err);
      sendError(res, 502, 'Failed to decompress stored world.');
      return;
    }
  } else {
    plain = content.bytes;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(plain);
}
