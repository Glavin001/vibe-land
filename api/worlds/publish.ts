import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getR2Client, buildPublishedKey, MAX_PUBLISH_BYTES } from '../_lib/r2.js';
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

  const r2 = getR2Client();
  if (!r2) {
    sendError(res, 503, 'Cloudflare R2 is not configured on this deployment.');
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
  // validate the shape, then persist the ORIGINAL compressed bytes to R2
  // (with ContentEncoding metadata) to keep storage small too.
  const contentEncoding = (req.headers['content-encoding'] ?? '').toString().toLowerCase();
  const isGzipped = contentEncoding.includes('gzip');
  let decompressed: Buffer;
  if (isGzipped) {
    try {
      decompressed = gunzipSync(rawBody);
    } catch (err) {
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

  const id = randomUUID();
  const key = buildPublishedKey(id);
  const createdAt = Date.now();

  // Always store gzipped bytes so both new uploads and any older plain
  // requests normalize to a single on-disk format.
  const storedBody = isGzipped ? rawBody : gzipSync(decompressed);

  try {
    await r2.client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: key,
        Body: storedBody,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
        Metadata: {
          name: encodeMetaValue(shape.name),
          description: encodeMetaValue(shape.description),
          createdat: createdAt.toString(),
          version: shape.version.toString(),
        },
      }),
    );
  } catch (err) {
    console.error('[worlds/publish] Failed to upload to R2', err);
    sendError(res, 502, 'Failed to upload world to R2.');
    return;
  }

  sendJson(res, 201, { id, createdAt });
}

// S3 metadata values must be ASCII. Base64-encode UTF-8 strings so unicode
// names and descriptions round-trip cleanly through `x-amz-meta-*` headers.
function encodeMetaValue(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}
