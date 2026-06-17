// Self-hosted entry point for the /api/worlds/* handlers.
//
// Each file under api/worlds/ exports a plain
// `(req: IncomingMessage, res: ServerResponse) => Promise<void>` handler
// — the same shape Vercel invokes in production. This file is the
// equivalent of `next start` for that folder: a long-running Node HTTP
// server that mounts every handler on its URL path.
//
// When SERVE_STATIC is set (a path or `1` for `client/dist`), the same
// server also serves the SPA bundle with correct cache headers + SPA
// fallback. That makes it possible to run the entire web surface
// (static + API) from a single process — useful for simple single-box
// deployments or for `vite preview`-style local production checks.
// Put nginx in front for TLS and compression; otherwise expose directly.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Mirror the Vercel file-based routes exactly. Order matters — `/config`
// and `/publish` must come before the `:id` route so they aren't caught
// by the catch-all.
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

// SERVE_STATIC:
//   unset / "0" / ""  -> API only (default; nginx serves the SPA)
//   "1" / "true"      -> serve ../client/dist relative to this file
//   "/some/path"      -> serve that directory
// The client/dist fallback is resolved from the compiled file location so
// it works whether you run `tsx api/server.ts` or a bundled build.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_STATIC_DIR = resolve(HERE, '..', 'client', 'dist');
const staticDir = resolveStaticDir(process.env.SERVE_STATIC);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveStaticDir(raw: string | undefined): string | null {
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return null;
  if (raw === '1' || raw.toLowerCase() === 'true') return DEFAULT_STATIC_DIR;
  return resolve(raw);
}

// Safely resolve a URL path inside `root`. Returns `null` for traversal
// attempts. Trailing-slash paths map to `index.html` inside that dir.
function resolveWithinRoot(root: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null) return null;
  if (decoded.includes('\0')) return null;
  const trimmed = decoded.replace(/^\/+/, '');
  const target = resolve(root, trimmed || 'index.html');
  // Ensure the resolved path is actually inside root. Compare against
  // root + separator so `/var/www/dist-evil` can't match `/var/www/dist`.
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const urlPath = new URL(req.url ?? '', 'http://localhost').pathname;

  let filePath = resolveWithinRoot(root, urlPath);
  if (!filePath) {
    sendError(res, 400, 'Invalid path.');
    return true;
  }

  let stats = await safeStat(filePath);
  if (stats?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    stats = await safeStat(filePath);
  }

  // SPA fallback: route requests that don't map to a real file back to
  // index.html so client-side routing (/, /play, /gallery, /builder/...)
  // works. /api/* is matched earlier and never reaches here.
  if (!stats) {
    filePath = join(root, 'index.html');
    stats = await safeStat(filePath);
    if (!stats) return false; // no bundle present; let the router 404 it
  }

  const ext = extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stats.size));
  // Mirror vercel.json: immutable hashed assets, revalidated HTML.
  if (urlPath.startsWith('/assets/') && ext !== '.html') {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(filePath);
  stream.on('error', (err) => {
    console.error(`[static] read error for ${filePath}`, err);
    if (!res.headersSent) sendError(res, 500, 'Static read error.');
    else res.end();
  });
  stream.pipe(res);
  return true;
}

async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '', 'http://localhost').pathname;

  // Healthcheck for load balancers and uptime probes. Distinct from the
  // Rust server's /healthz so each backend can be monitored independently.
  if (method === 'GET' && path === '/api/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API routes always take precedence over static serving.
  if (path.startsWith('/api/')) {
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
      if (!res.headersSent) sendError(res, 500, 'Internal server error.');
      else res.end();
    }
    return;
  }

  if (staticDir) {
    const served = await serveStatic(req, res, staticDir);
    if (served) return;
  }

  sendError(res, 404, 'Not found.');
});

server.listen(PORT, HOST, () => {
  const mode = staticDir ? `+ static(${staticDir})` : 'API only';
  console.log(`[api] listening on http://${HOST}:${PORT} ${mode}`);
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
