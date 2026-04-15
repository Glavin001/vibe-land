import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getWorldStorage,
  isValidWorldId,
  MAX_SCREENSHOT_BYTES,
} from '../../_lib/storage.js';
import { readRawBody, sendError, sendJson, PayloadTooLargeError } from '../../_lib/http.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const storage = getWorldStorage();
  if (!storage) {
    sendError(res, 503, 'World storage is not configured on this deployment.');
    return;
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  // /api/worlds/<id>/screenshot — id is the second-to-last segment.
  const segments = url.pathname.split('/').filter(Boolean);
  const idSegment = segments[segments.length - 2] ?? '';
  const id = decodeURIComponent(idSegment);
  if (!id || !isValidWorldId(id)) {
    sendError(res, 400, 'Invalid world id.');
    return;
  }

  if (req.method === 'GET') {
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
    // Screenshots are immutable for the life of a published world, so cache
    // aggressively to reduce storage egress on gallery paint.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.end(content.bytes);
    return;
  }

  if (req.method !== 'POST' && req.method !== 'PUT') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  // Require the world to already exist before we store a screenshot so
  // random ids can't litter storage with orphaned images.
  let worldExists = false;
  try {
    worldExists = await storage.hasWorld(id);
  } catch (err) {
    console.error('[worlds/id/screenshot] Failed to verify world', err);
    sendError(res, 502, 'Failed to verify world.');
    return;
  }
  if (!worldExists) {
    sendError(res, 404, 'World not found; publish it first.');
    return;
  }

  const contentType = (req.headers['content-type'] ?? '').toString().toLowerCase();
  if (!contentType.startsWith('image/')) {
    sendError(res, 415, 'Request must have an image/* Content-Type.');
    return;
  }

  let body: Buffer;
  try {
    body = await readRawBody(req, MAX_SCREENSHOT_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendError(res, 413, err.message);
      return;
    }
    sendError(res, 400, 'Failed to read request body.');
    return;
  }

  if (body.length === 0) {
    sendError(res, 400, 'Screenshot body was empty.');
    return;
  }

  try {
    await storage.putScreenshot(id, body, contentType);
  } catch (err) {
    console.error('[worlds/id/screenshot] Failed to upload screenshot', err);
    sendError(res, 502, 'Failed to upload screenshot.');
    return;
  }

  sendJson(res, 201, { ok: true, size: body.length });
}
