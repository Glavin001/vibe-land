import type { IncomingMessage, ServerResponse } from 'node:http';
import { isStorageEnabled, getWorldStorage, getPublicBaseUrl } from '../_lib/storage.js';
import { sendJson, sendError } from '../_lib/http.js';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }
  const storage = getWorldStorage();
  sendJson(res, 200, {
    enabled: isStorageEnabled(),
    // Purely informational; the client only checks `enabled`, but surfacing
    // the active backend helps when debugging which env vars took effect.
    storage: storage?.kind ?? null,
    // When set, the client should read world JSON and screenshots directly
    // from this CDN origin instead of going through /api/worlds/<id> and
    // /api/worlds/<id>/screenshot. Null means "use the function endpoints".
    publicUrl: getPublicBaseUrl(),
  });
}
