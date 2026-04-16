import type { IncomingMessage, ServerResponse } from 'node:http';
import { getWorldStorage } from '../_lib/storage.js';
import { sendJson, sendError } from '../_lib/http.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  const storage = getWorldStorage();
  if (!storage) {
    sendError(res, 503, 'World storage is not configured on this deployment.');
    return;
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  let summaries;
  try {
    summaries = await storage.listWorlds(limit);
  } catch (err) {
    console.error('[worlds] Failed to list worlds', err);
    sendError(res, 502, 'Failed to list published worlds.');
    return;
  }

  const worlds = summaries.map(({ id, name, description, createdAt, size, parentId }) => ({
    id,
    name,
    description,
    createdAt,
    size,
    parentId: parentId ?? null,
  }));

  res.setHeader('Cache-Control', 'public, max-age=10');
  sendJson(res, 200, { worlds });
}
