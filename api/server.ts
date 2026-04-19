// Self-hosted entry point for the /api/worlds/* handlers.
//
// Each file under api/worlds/ exports a plain
// `(req: IncomingMessage, res: ServerResponse) => Promise<void>` handler
// — the same shape Vercel invokes in production. This file is the
// equivalent of `next start` for that folder: a long-running Node HTTP
// server that mounts every handler on its URL path and does nothing else.
//
// Run it with `npm run api:start` (or `api:dev` for watch mode). Put nginx
// in front of it and it replaces Vercel entirely for the API surface.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { sendError } from './_lib/http.js';

import configHandler from './worlds/config.js';
import indexHandler from './worlds/index.js';
import publishHandler from './worlds/publish.js';
import worldHandler from './worlds/[id].js';
import screenshotHandler from './worlds/[id]/screenshot.js';
import uploadHandler from './worlds/[id]/upload.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

interface Route {
  methods: readonly string[];
  pattern: RegExp;
  handler: Handler;
}

// The handlers parse their own dynamic segments from req.url, so the
// router's only job is to match method + shape and dispatch. The URL
// surface mirrors the Vercel file-based routes exactly:
//
//   GET    /api/worlds/config
//   GET    /api/worlds
//   POST   /api/worlds/publish
//   GET    /api/worlds/:id
//   GET    /api/worlds/:id/screenshot
//   PUT    /api/worlds/:id/upload
//   POST   /api/worlds/:id/upload
//
// The order here matters: more specific paths come first so `/config`
// and `/publish` don't get swallowed by the `:id` route.
const ROUTES: readonly Route[] = [
  { methods: ['GET'], pattern: /^\/api\/worlds\/config\/?$/, handler: configHandler },
  { methods: ['POST'], pattern: /^\/api\/worlds\/publish\/?$/, handler: publishHandler },
  { methods: ['GET'], pattern: /^\/api\/worlds\/?$/, handler: indexHandler },
  { methods: ['GET'], pattern: /^\/api\/worlds\/[^/]+\/screenshot\/?$/, handler: screenshotHandler },
  { methods: ['PUT', 'POST'], pattern: /^\/api\/worlds\/[^/]+\/upload\/?$/, handler: uploadHandler },
  { methods: ['GET'], pattern: /^\/api\/worlds\/[^/]+\/?$/, handler: worldHandler },
];

const PORT = Number.parseInt(process.env.API_PORT ?? '3000', 10);
const HOST = process.env.API_HOST ?? '127.0.0.1';

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '', 'http://localhost').pathname;

  // Healthcheck for load balancers and uptime probes. Separate from the
  // Rust server's /healthz so nginx can point each at its own backend.
  if (method === 'GET' && path === '/api/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const matched = ROUTES.find((r) => r.pattern.test(path));
  if (!matched) {
    sendError(res, 404, 'Not found.');
    return;
  }
  if (!matched.methods.includes(method)) {
    res.setHeader('Allow', matched.methods.join(', '));
    sendError(res, 405, 'Method not allowed.');
    return;
  }

  try {
    await matched.handler(req, res);
  } catch (err) {
    console.error(`[api] handler for ${method} ${path} threw`, err);
    if (!res.headersSent) {
      sendError(res, 500, 'Internal server error.');
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on http://${HOST}:${PORT}`);
});

// Graceful shutdown so systemd / docker stop signals don't drop in-flight
// uploads.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[api] received ${signal}, closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
