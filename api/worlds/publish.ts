import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  getWorldStorage,
  MAX_PUBLISH_BYTES,
  WriteConflictError,
} from '../_lib/storage.js';
import { validateWorldShape, ValidationError } from '../_lib/validate.js';
import {
  readRawBody,
  sendJson,
  sendError,
  PayloadTooLargeError,
} from '../_lib/http.js';

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

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_PUBLISH_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendError(res, 413, err.message);
      return;
    }
    sendError(res, 400, 'Failed to read request body.');
    return;
  }

  if (rawBody.length === 0) {
    sendError(res, 400, 'Request body was empty.');
    return;
  }

  // Clients upload the world as gzipped JSON with a Content-Encoding: gzip
  // header so the upload itself stays small. We decompress server-side to
  // validate the shape, then persist the ORIGINAL compressed bytes so
  // storage stays small too.
  const contentEncoding = (req.headers['content-encoding'] ?? '').toString().toLowerCase();
  const isGzipped = contentEncoding.includes('gzip');
  let decompressed: Buffer;
  if (isGzipped) {
    try {
      decompressed = gunzipSync(rawBody);
    } catch {
      sendError(res, 400, 'Failed to decompress gzipped request body.');
      return;
    }
  } else {
    decompressed = rawBody;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decompressed.toString('utf-8'));
  } catch {
    sendError(res, 400, 'Request body is not valid JSON.');
    return;
  }

  let shape;
  try {
    shape = validateWorldShape(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      sendError(res, 400, err.message);
      return;
    }
    sendError(res, 400, 'Invalid world document.');
    return;
  }

  // Normalize to a gzipped buffer so both code paths hit a single write.
  const storedBody = isGzipped ? rawBody : gzipSync(decompressed);
  const createdAt = Date.now();

  // Server owns id assignment. Generate a UUID, verify nothing is already
  // stored there via hasWorld(), and retry on the astronomically-unlikely
  // collision. The actual putWorld is defensive and throws WriteConflictError
  // if something raced it between hasWorld() and putWorld(), so a concurrent
  // publish at the same key still can't overwrite an existing world.
  let id: string | null = null;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateId = randomUUID();
    let collision: boolean;
    try {
      collision = await storage.hasWorld(candidateId);
    } catch (err) {
      console.error('[worlds/publish] hasWorld failed', err);
      sendError(res, 502, 'Failed to reserve world id.');
      return;
    }
    if (!collision) {
      id = candidateId;
      break;
    }
  }
  if (!id) {
    sendError(res, 503, 'Failed to allocate a unique world id; please retry.');
    return;
  }

  try {
    await storage.putWorld(id, storedBody, {
      name: shape.name,
      description: shape.description,
      version: shape.version,
      createdAt,
    });
  } catch (err) {
    if (err instanceof WriteConflictError) {
      sendError(res, 409, 'Id collision detected; retry the publish.');
      return;
    }
    console.error('[worlds/publish] Failed to store world', err);
    sendError(res, 502, 'Failed to store world.');
    return;
  }

  sendJson(res, 201, { id, createdAt });
}
