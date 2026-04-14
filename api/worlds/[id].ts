import type { IncomingMessage, ServerResponse } from 'node:http';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getR2Client, buildPublishedKey } from '../_lib/r2.js';
import { sendError } from '../_lib/http.js';

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

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
  if (!id || !ID_PATTERN.test(id)) {
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

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');

  // `Body` is a Node stream in Vercel's Node runtime. Pipe it through.
  const anyBody = body as unknown as NodeJS.ReadableStream;
  if (typeof anyBody.pipe === 'function') {
    anyBody.pipe(res);
    return;
  }

  // Fallback: buffer the response.
  const text = await (body as { transformToString(): Promise<string> }).transformToString();
  res.end(text);
}
