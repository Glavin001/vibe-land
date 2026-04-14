import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  buildPublishedKey,
  buildScreenshotKey,
  getR2Client,
  isValidWorldId,
  MAX_SCREENSHOT_BYTES,
} from '../../_lib/r2.js';
import { readRawBody, sendError, sendJson, PayloadTooLargeError } from '../../_lib/http.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const r2 = getR2Client();
  if (!r2) {
    sendError(res, 503, 'Cloudflare R2 is not configured on this deployment.');
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
    return handleGet(r2, id, res);
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    return handlePost(r2, id, req, res);
  }
  sendError(res, 405, 'Method not allowed.');
}

async function handleGet(
  r2: NonNullable<ReturnType<typeof getR2Client>>,
  id: string,
  res: ServerResponse,
): Promise<void> {
  let object;
  try {
    object = await r2.client.send(
      new GetObjectCommand({ Bucket: r2.bucket, Key: buildScreenshotKey(id) }),
    );
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') {
      sendError(res, 404, 'Screenshot not found.');
      return;
    }
    console.error('[worlds/id/screenshot] Failed to fetch object', err);
    sendError(res, 502, 'Failed to fetch screenshot.');
    return;
  }

  const body = object.Body;
  if (!body) {
    sendError(res, 502, 'Screenshot body missing.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', object.ContentType || 'image/jpeg');
  // Screenshots are immutable for the life of a published world, so cache
  // aggressively to reduce R2 egress on gallery paint.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

  const anyBody = body as unknown as NodeJS.ReadableStream & { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof anyBody.pipe === 'function') {
    anyBody.pipe(res);
    return;
  }
  if (typeof anyBody.transformToByteArray === 'function') {
    const bytes = await anyBody.transformToByteArray();
    res.end(Buffer.from(bytes));
    return;
  }
  sendError(res, 502, 'Unsupported screenshot body type.');
}

async function handlePost(
  r2: NonNullable<ReturnType<typeof getR2Client>>,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Require the world to already exist before we store a screenshot so
  // random keys can't litter the bucket with orphaned images. Anyone can
  // still overwrite an existing screenshot — that matches the current
  // publish auth model (feature-flag only, no per-user auth).
  try {
    await r2.client.send(
      new HeadObjectCommand({ Bucket: r2.bucket, Key: buildPublishedKey(id) }),
    );
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') {
      sendError(res, 404, 'World not found; publish it first.');
      return;
    }
    console.error('[worlds/id/screenshot] Failed to HEAD world', err);
    sendError(res, 502, 'Failed to verify world.');
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
    await r2.client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: buildScreenshotKey(id),
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=86400, immutable',
      }),
    );
  } catch (err) {
    console.error('[worlds/id/screenshot] Failed to upload screenshot', err);
    sendError(res, 502, 'Failed to upload screenshot.');
    return;
  }

  sendJson(res, 201, { ok: true, size: body.length });
}
