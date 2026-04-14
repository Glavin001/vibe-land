import type { IncomingMessage, ServerResponse } from 'node:http';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getR2Client, PUBLISHED_PREFIX, extractIdFromKey } from '../_lib/r2.js';
import { sendJson, sendError } from '../_lib/http.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type GallerySummary = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  size: number;
};

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
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  let listResponse;
  try {
    listResponse = await r2.client.send(
      new ListObjectsV2Command({
        Bucket: r2.bucket,
        Prefix: PUBLISHED_PREFIX,
        MaxKeys: limit,
      }),
    );
  } catch (err) {
    console.error('[worlds] Failed to list objects', err);
    sendError(res, 502, 'Failed to list published worlds.');
    return;
  }

  const entries = (listResponse.Contents ?? [])
    .filter((item) => item.Key && item.Size !== undefined)
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

  const summaries: GallerySummary[] = await Promise.all(
    entries.map(async (item) => {
      const id = extractIdFromKey(item.Key!);
      if (!id) {
        return null;
      }
      let name = 'Untitled World';
      let description = '';
      let createdAt = item.LastModified?.getTime() ?? Date.now();
      try {
        const head = await r2.client.send(
          new HeadObjectCommand({ Bucket: r2.bucket, Key: item.Key! }),
        );
        const meta = head.Metadata ?? {};
        if (meta.name) {
          name = decodeMetaValue(meta.name) || name;
        }
        if (meta.description !== undefined) {
          description = decodeMetaValue(meta.description);
        }
        if (meta.createdat) {
          const parsed = Number.parseInt(meta.createdat, 10);
          if (Number.isFinite(parsed)) {
            createdAt = parsed;
          }
        }
      } catch (err) {
        console.warn('[worlds] Failed to HEAD object', item.Key, err);
      }
      return {
        id,
        name,
        description,
        createdAt,
        size: item.Size ?? 0,
      } satisfies GallerySummary;
    }),
  ).then((results) => results.filter((item): item is GallerySummary => item !== null));

  res.setHeader('Cache-Control', 'public, max-age=10');
  sendJson(res, 200, { worlds: summaries });
}

function decodeMetaValue(value: string): string {
  // Values are base64-encoded UTF-8 on write. Fall back to the raw value if
  // decoding fails so worlds uploaded through other tools still list.
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    // If base64 decode yields garbage, prefer the original string.
    if (/\uFFFD/.test(decoded)) {
      return value;
    }
    return decoded;
  } catch {
    return value;
  }
}
