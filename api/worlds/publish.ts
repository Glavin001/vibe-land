import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AllocationError,
  getWorldStorage,
  MAX_PUBLISH_BYTES,
  MAX_SCREENSHOT_BYTES,
  WriteConflictError,
} from '../_lib/storage.js';
import {
  readJsonBody,
  sendJson,
  sendError,
  BadRequestError,
  PayloadTooLargeError,
} from '../_lib/http.js';

// POST /api/worlds/publish
//
// Request body (JSON):
//   {
//     "name":                   string,   // arbitrary length, UTF-8 OK
//     "description":            string,   // same, may be empty
//     "version":                number,   // WorldDocument version
//     "worldContentLength":     number,   // bytes of the gzipped world JSON
//     "screenshotContentLength":number,   // bytes of the JPEG screenshot
//   }
//
// Response (201 Created):
//   {
//     "id":        "<uuid>",
//     "createdAt": 1776283086502,
//     "expiresAt": 1776283146502,
//     "mode":      "presigned" | "direct",
//     "world":       { url, method, contentLength, headers },
//     "screenshot":  { url, method, contentLength, headers },
//   }
//
// The client then PUTs the gzipped world bytes to `world.url` with the
// exact `world.headers` map and in parallel PUTs the JPEG bytes to
// `screenshot.url`. Both upload URLs expire in 60 seconds.

const MAX_METADATA_BYTES = 16 * 1024; // 16 KiB of JSON is more than enough

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  const storage = getWorldStorage();
  if (!storage) {
    sendError(res, 503, 'World storage is not configured on this deployment.');
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req, MAX_METADATA_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendError(res, 413, err.message);
      return;
    }
    if (err instanceof BadRequestError) {
      sendError(res, 400, err.message);
      return;
    }
    sendError(res, 400, 'Failed to read request body.');
    return;
  }

  if (!rawBody || typeof rawBody !== 'object') {
    sendError(res, 400, 'Request body must be a JSON object.');
    return;
  }
  const body = rawBody as Record<string, unknown>;

  const name = typeof body.name === 'string' && body.name.trim().length > 0
    ? body.name.trim()
    : 'Untitled World';
  const description = typeof body.description === 'string' ? body.description : '';
  const version = typeof body.version === 'number' && Number.isFinite(body.version) ? body.version : 2;
  const worldContentLength = asInt(body.worldContentLength);
  const screenshotContentLength = asInt(body.screenshotContentLength);

  if (worldContentLength === null || worldContentLength <= 0) {
    sendError(res, 400, 'worldContentLength must be a positive integer.');
    return;
  }
  if (screenshotContentLength === null || screenshotContentLength <= 0) {
    sendError(res, 400, 'screenshotContentLength must be a positive integer.');
    return;
  }
  if (worldContentLength > MAX_PUBLISH_BYTES) {
    sendError(res, 413, `worldContentLength exceeds the ${MAX_PUBLISH_BYTES} byte cap.`);
    return;
  }
  if (screenshotContentLength > MAX_SCREENSHOT_BYTES) {
    sendError(res, 413, `screenshotContentLength exceeds the ${MAX_SCREENSHOT_BYTES} byte cap.`);
    return;
  }

  try {
    const reservation = await storage.reserveUpload({
      name,
      description,
      version,
      worldContentLength,
      screenshotContentLength,
    });
    sendJson(res, 201, {
      id: reservation.id,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      mode: reservation.instructions.mode,
      world: reservation.instructions.world,
      screenshot: reservation.instructions.screenshot,
    });
  } catch (err) {
    if (err instanceof WriteConflictError) {
      sendError(res, 409, 'Id collision detected; retry the publish.');
      return;
    }
    if (err instanceof AllocationError) {
      sendError(res, 503, err.message);
      return;
    }
    console.error('[worlds/publish] reserveUpload failed', err);
    sendError(res, 502, 'Failed to reserve upload.');
  }
}

function asInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value !== Math.floor(value)) return null;
  return value;
}
