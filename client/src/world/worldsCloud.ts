import type { WorldDocument } from './worldDocument';
import { serializeWorldDocument } from './worldDocument';

export type CloudConfig = {
  enabled: boolean;
  storage?: 'r2' | 'local' | null;
};

export type GalleryWorldSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  size: number;
  hasScreenshot?: boolean;
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
  return { enabled: Boolean(data.enabled), storage: data.storage ?? null };
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
export async function publishWorld(
  world: WorldDocument,
  screenshot: Blob,
): Promise<PublishResult> {
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

export async function listPublishedWorlds(limit?: number): Promise<GalleryWorldSummary[]> {
  const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  const response = await fetch(`/api/worlds${query}`);
  if (!response.ok) {
    throw new Error(await describeError(response, 'list worlds'));
  }
  const data = (await response.json()) as { worlds?: GalleryWorldSummary[] };
  return Array.isArray(data.worlds) ? data.worlds : [];
}

export async function fetchPublishedWorld(id: string): Promise<unknown> {
  const response = await fetch(`/api/worlds/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(await describeError(response, 'fetch world'));
  }
  return response.json();
}

export function screenshotUrlForWorld(id: string): string {
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
