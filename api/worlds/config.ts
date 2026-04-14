import type { IncomingMessage, ServerResponse } from 'node:http';
import { isR2Enabled } from '../_lib/r2.js';
import { sendJson, sendError } from '../_lib/http.js';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendError(res, 405, 'Method not allowed.');
    return;
  }
  sendJson(res, 200, { enabled: isR2Enabled() });
}
