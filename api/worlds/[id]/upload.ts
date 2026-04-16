import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getWorldStorage,
  isValidWorldId,
  MAX_PUBLISH_BYTES,
  MAX_SCREENSHOT_BYTES,
  WriteConflictError,
} from '../../_lib/storage.js';
import {
  readRawBody,
  sendError,
  sendJson,
  PayloadTooLargeError,
} from '../../_lib/http.js';
import type { FsWorldStorage } from '../../_lib/fsStorage.js';

// PUT /api/worlds/<id>/upload?target=world|screenshot
//
// Direct upload endpoint used exclusively by the filesystem backend. The
// R2 backend returns presigned R2 URLs from /api/worlds/publish and never
// routes through this handler. Requests that arrive while the R2 backend
// is active get a 404 so the endpoint looks absent.
//
// The reservation written by `reserveUpload` is the auth boundary: the
// handler refuses uploads for ids that don't have a live (non-expired)
// reservation sidecar, and refuses to overwrite any world/screenshot that
// already exists.

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'PUT' && req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  const storage = getWorldStorage();
  if (!storage) {
    sendError(res, 503, 'World storage is not configured on this deployment.');
    return;
  }
  if (storage.kind !== 'local') {
    // Not hiding its existence – surfacing the reason so debugging is easy.
    sendError(res, 404, 'Direct upload is only available for the filesystem backend.');
    return;
  }
  const fsStorage = storage as unknown as FsWorldStorage;

  const url = new URL(req.url ?? '', 'http://localhost');
  // /api/worlds/<id>/upload — id is the second-to-last path segment.
  const segments = url.pathname.split('/').filter(Boolean);
  const idSegment = segments[segments.length - 2] ?? '';
  const id = decodeURIComponent(idSegment);
  if (!id || !isValidWorldId(id)) {
    sendError(res, 400, 'Invalid world id.');
    return;
  }

  const target = url.searchParams.get('target');
  if (target !== 'world' && target !== 'screenshot') {
    sendError(res, 400, "target query param must be 'world' or 'screenshot'.");
    return;
  }

  const maxBytes = target === 'world' ? MAX_PUBLISH_BYTES : MAX_SCREENSHOT_BYTES;
  const contentType = (req.headers['content-type'] ?? '').toString().toLowerCase();
  if (target === 'world' && !contentType.startsWith('application/json')) {
    sendError(res, 415, 'world upload must have Content-Type: application/json.');
    return;
  }
  if (target === 'screenshot' && !contentType.startsWith('image/')) {
    sendError(res, 415, 'screenshot upload must have an image/* Content-Type.');
    return;
  }

  let body: Buffer;
  try {
    body = await readRawBody(req, maxBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendError(res, 413, err.message);
      return;
    }
    sendError(res, 400, 'Failed to read request body.');
    return;
  }

  if (body.length === 0) {
    sendError(res, 400, 'Upload body was empty.');
    return;
  }

  try {
    if (target === 'world') {
      await fsStorage.commitWorldUpload(id, body);
    } else {
      await fsStorage.commitScreenshotUpload(id, body);
    }
  } catch (err) {
    if (err instanceof WriteConflictError) {
      sendError(res, 409, err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('expired') || message.includes('No active reservation')) {
      sendError(res, 410, message);
      return;
    }
    if (message.includes('does not match reserved')) {
      sendError(res, 400, message);
      return;
    }
    console.error('[worlds/upload] commit failed', err);
    sendError(res, 502, 'Failed to persist upload.');
    return;
  }

  sendJson(res, 201, { ok: true, size: body.length });
}
