import type { WorldDocument } from './worldDocument';
import { serializeWorldDocument } from './worldDocument';

export type CloudConfig = {
  enabled: boolean;
};

export type GalleryWorldSummary = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  size: number;
  hasScreenshot?: boolean;
};

export type PublishResult = {
  id: string;
  createdAt: number;
};

export async function fetchCloudConfig(): Promise<CloudConfig> {
  const response = await fetch('/api/worlds/config');
  if (!response.ok) {
    throw new Error(`Failed to load cloud config (HTTP ${response.status})`);
  }
  const data = (await response.json()) as Partial<CloudConfig>;
  return { enabled: Boolean(data.enabled) };
}

export async function publishWorld(world: WorldDocument): Promise<PublishResult> {
  const json = serializeWorldDocument(world);
  const gzipped = await gzipString(json);
  // Wrap in a Blob so TS recognises it as BodyInit. Copy into a fresh
  // ArrayBuffer so the BlobPart parameter type (which expects
  // Uint8Array<ArrayBuffer>, not Uint8Array<ArrayBufferLike>) is satisfied on
  // newer TypeScript lib versions.
  const bodyBuffer = gzipped.buffer.slice(
    gzipped.byteOffset,
    gzipped.byteOffset + gzipped.byteLength,
  ) as ArrayBuffer;
  const body = new Blob([bodyBuffer], { type: 'application/octet-stream' });
  const response = await fetch('/api/worlds/publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'publish world'));
  }
  const data = (await response.json()) as Partial<PublishResult>;
  if (!data.id || typeof data.id !== 'string') {
    throw new Error('Publish response did not include an id.');
  }
  return {
    id: data.id,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
  };
}

export async function uploadWorldScreenshot(id: string, image: Blob): Promise<void> {
  const response = await fetch(`/api/worlds/${encodeURIComponent(id)}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': image.type || 'image/jpeg' },
    body: image,
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'upload screenshot'));
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
