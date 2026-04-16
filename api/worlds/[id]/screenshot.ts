import type { IncomingMessage, ServerResponse } from 'node:http';
import { getWorldStorage, isValidWorldId } from '../../_lib/storage.js';
import { sendError } from '../../_lib/http.js';

// GET /api/worlds/<id>/screenshot
//
// Streams a published world's screenshot back to the browser. Write
// requests are NOT supported here — the publish handler returns an upload
// URL for the screenshot as part of `POST /api/worlds/publish`. For R2
// that URL points directly at R2; for the filesystem backend it points at
// `/api/worlds/<id>/upload?target=screenshot`.

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed. Screenshots are uploaded via /api/worlds/publish.');
    return;
  }

  const storage = getWorldStorage();
  if (!storage) {
    sendError(res, 503, 'World storage is not configured on this deployment.');
    return;
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  // /api/worlds/<id>/screenshot — id is the second-to-last path segment.
  const segments = url.pathname.split('/').filter(Boolean);
  const idSegment = segments[segments.length - 2] ?? '';
  const id = decodeURIComponent(idSegment);
  if (!id || !isValidWorldId(id)) {
    sendError(res, 400, 'Invalid world id.');
    return;
  }

  let content;
  try {
    content = await storage.getScreenshot(id);
  } catch (err) {
    console.error('[worlds/id/screenshot] Failed to fetch screenshot', err);
    sendError(res, 502, 'Failed to fetch screenshot.');
    return;
  }
  if (!content) {
    sendError(res, 404, 'Screenshot not found.');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', content.contentType);
  // Screenshots are immutable for the life of a published world.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.end(content.bytes);
}
