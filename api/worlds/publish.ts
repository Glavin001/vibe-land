import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getR2Client, buildPublishedKey, MAX_PUBLISH_BYTES } from '../_lib/r2.js';
import { validateWorldShape, ValidationError } from '../_lib/validate.js';
import {
  readJsonBody,
  sendJson,
  sendError,
  BadRequestError,
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

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_PUBLISH_BYTES);
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

  let shape;
  try {
    shape = validateWorldShape(body);
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
  const payload = JSON.stringify(shape.raw);
  const createdAt = Date.now();

  try {
    await r2.client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: key,
        Body: payload,
        ContentType: 'application/json',
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
