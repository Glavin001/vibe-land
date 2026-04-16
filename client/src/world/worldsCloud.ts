import type { WorldDocument } from './worldDocument';
import { serializeWorldDocument } from './worldDocument';

export type CloudConfig = {
  enabled: boolean;
  storage?: 'r2' | 'local' | null;
  // When set, read world JSON + screenshots directly from this CDN origin
  // instead of going through the /api/worlds/<id> function. The URL maps
  // 1:1 to the R2 bucket key space, e.g.:
  //   https://vibe-land-worlds.example.com/published/<id>.world.json
  publicUrl?: string | null;
  // When set, the deployment requires Cloudflare Turnstile verification for
  // publishing and gallery listing. The client renders a Turnstile widget
  // with this key and sends the resulting token with requests.
  turnstileSiteKey?: string | null;
};

export type GalleryWorldSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  size: number;
  parentId?: string | null;
};

type UploadTarget = {
  url: string;
  method: 'PUT';
  contentLength: number;
  headers: Record<string, string>;
};

type ReservationResponse = {
  id: string;
  createdAt: number;
  expiresAt: number;
  mode: 'presigned' | 'direct';
  world: UploadTarget;
  screenshot: UploadTarget;
};

export type PublishResult = {
  id: string;
  createdAt: number;
  mode: 'presigned' | 'direct';
};

export async function fetchCloudConfig(): Promise<CloudConfig> {
  const response = await fetch('/api/worlds/config');
  if (!response.ok) {
    throw new Error(`Failed to load cloud config (HTTP ${response.status})`);
  }
  const data = (await response.json()) as Partial<CloudConfig>;
  const publicUrl = typeof data.publicUrl === 'string' && data.publicUrl.length > 0
    ? data.publicUrl
    : null;
  const turnstileSiteKey = typeof data.turnstileSiteKey === 'string' && data.turnstileSiteKey.length > 0
    ? data.turnstileSiteKey
    : null;
  return { enabled: Boolean(data.enabled), storage: data.storage ?? null, publicUrl, turnstileSiteKey };
}

/**
 * Publish a world + its screenshot preview to the configured storage
 * backend. Uses a two-phase protocol:
 *
 *  1. POST /api/worlds/publish with metadata + both byte lengths so the
 *     server can reserve a fresh id and return upload URLs (presigned R2
 *     PUTs when running against R2, or direct-upload URLs when running
 *     against the filesystem backend).
 *  2. PUT the gzipped world bytes and the JPEG screenshot bytes to the
 *     returned URLs in parallel. For R2 this means the blobs flow
 *     straight from the browser to R2 — they never pass through the
 *     serverless function.
 *
 * Throws if either upload fails. The caller is responsible for any retry
 * logic; a second publish simply allocates a new id.
 */
export type PublishWorldOptions = {
  world: WorldDocument;
  screenshot: Blob;
  // If this world was loaded from a published world (e.g. opened from
  // the gallery), pass the source id so the new publication records its
  // parentage. Null for original creations.
  parentId?: string | null;
  // Cloudflare Turnstile token. Required when the deployment has Turnstile
  // configured; omit for local dev without Turnstile keys.
  turnstileToken?: string | null;
};

export async function publishWorld(opts: PublishWorldOptions): Promise<PublishResult> {
  const { world, screenshot, parentId, turnstileToken } = opts;
  const json = serializeWorldDocument(world);
  const gzippedWorld = await gzipString(json);
  const worldBlob = new Blob([toAsciiArrayBuffer(gzippedWorld)], {
    type: 'application/json',
  });

  const reservation = await reserveUpload({
    name: world.meta.name,
    description: world.meta.description,
    version: world.version,
    worldContentLength: worldBlob.size,
    screenshotContentLength: screenshot.size,
    parentId: parentId ?? null,
    turnstileToken: turnstileToken ?? null,
  });

  // Fire the two uploads in parallel. Fail the whole publish if either PUT
  // returns non-2xx. Because the id is freshly reserved, a retry just
  // allocates a new id – we never need to clean up half-uploaded state.
  await Promise.all([
    putTo(reservation.world, worldBlob, 'world'),
    putTo(reservation.screenshot, screenshot, 'screenshot'),
  ]);

  return {
    id: reservation.id,
    createdAt: reservation.createdAt,
    mode: reservation.mode,
  };
}

async function reserveUpload(body: {
  name: string;
  description: string;
  version: number;
  worldContentLength: number;
  screenshotContentLength: number;
  parentId: string | null;
  turnstileToken: string | null;
}): Promise<ReservationResponse> {
  const response = await fetch('/api/worlds/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'reserve upload'));
  }
  const data = (await response.json()) as Partial<ReservationResponse>;
  if (
    !data.id
    || typeof data.id !== 'string'
    || typeof data.createdAt !== 'number'
    || typeof data.expiresAt !== 'number'
    || !data.world
    || !data.screenshot
    || (data.mode !== 'presigned' && data.mode !== 'direct')
  ) {
    throw new Error('Malformed publish response.');
  }
  return {
    id: data.id,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    mode: data.mode,
    world: data.world,
    screenshot: data.screenshot,
  };
}

async function putTo(target: UploadTarget, body: Blob, label: string): Promise<void> {
  if (body.size !== target.contentLength) {
    throw new Error(
      `Refusing to upload ${label}: size ${body.size} doesn't match reserved ${target.contentLength}`,
    );
  }
  const response = await fetch(target.url, {
    method: target.method,
    headers: target.headers,
    body,
  });
  if (!response.ok) {
    const status = response.status;
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 400);
    } catch {
      // ignore
    }
    throw new Error(`Failed to upload ${label} (HTTP ${status})${detail ? `: ${detail}` : ''}`);
  }
}

export async function listPublishedWorlds(limit?: number, turnstileToken?: string | null): Promise<GalleryWorldSummary[]> {
  const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  const headers: Record<string, string> = {};
  if (turnstileToken) {
    headers['X-Turnstile-Token'] = turnstileToken;
  }
  const response = await fetch(`/api/worlds${query}`, { headers });
  if (!response.ok) {
    throw new Error(await describeError(response, 'list worlds'));
  }
  const data = (await response.json()) as { worlds?: GalleryWorldSummary[] };
  return Array.isArray(data.worlds) ? data.worlds : [];
}

export async function fetchPublishedWorld(id: string, publicUrl?: string | null): Promise<unknown> {
  const url = publicUrl
    ? `${publicUrl}/published/${encodeURIComponent(id)}.world.json`
    : `/api/worlds/${encodeURIComponent(id)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await describeError(response, 'fetch world'));
  }
  return response.json();
}

export function screenshotUrlForWorld(id: string, publicUrl?: string | null): string {
  if (publicUrl) {
    return `${publicUrl}/published/${encodeURIComponent(id)}.screenshot.jpg`;
  }
  return `/api/worlds/${encodeURIComponent(id)}/screenshot`;
}

async function describeError(response: Response, action: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error) {
      return `Failed to ${action}: ${data.error}`;
    }
  } catch {
    // ignore – fall through to the generic message below
  }
  return `Failed to ${action} (HTTP ${response.status})`;
}

// Compress a UTF-8 string with gzip using the browser's CompressionStream API.
// Returns the raw gzip bytes ready for upload. CompressionStream is supported
// in all modern evergreen browsers.
export async function gzipString(input: string): Promise<Uint8Array> {
  const blob = new Blob([input]);
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// Copy a Uint8Array into a fresh ArrayBuffer. This is needed because
// `new Blob([uint8array])` works at runtime but TypeScript's BlobPart
// parameter wants Uint8Array<ArrayBuffer> (not SharedArrayBuffer-backed).
function toAsciiArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
