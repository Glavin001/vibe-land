import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCloudConfig,
  fetchPublishedWorld,
  listPublishedWorlds,
  publishWorld,
  screenshotUrlForWorld,
} from './worldsCloud';
import type { WorldDocument } from './worldDocument';

const minimalWorld: WorldDocument = {
  version: 2,
  meta: { name: 'Test World', description: 'desc' },
  terrain: { tileGridSize: 5, tileHalfExtentM: 10, tiles: [] },
  staticProps: [],
  dynamicEntities: [],
};

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe('worldsCloud', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchCloudConfig returns enabled flag + storage kind', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true, storage: 'r2' }));
    await expect(fetchCloudConfig()).resolves.toEqual({ enabled: true, storage: 'r2' });
    expect(fetchMock).toHaveBeenCalledWith('/api/worlds/config');
  });

  it('fetchCloudConfig coerces missing enabled to false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(fetchCloudConfig()).resolves.toEqual({ enabled: false, storage: null });
  });

  it('publishWorld reserves an upload then PUTs both blobs in parallel', async () => {
    const screenshotBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30]);
    const screenshot = new Blob([screenshotBytes], { type: 'image/jpeg' });

    // First call → publish reservation. Using fixed sentinel URLs we can
    // assert against below. contentLength fields must match what the
    // client computes or publishWorld refuses to upload.
    fetchMock.mockImplementationOnce(async (url, init) => {
      expect(url).toBe('/api/worlds/publish');
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.name).toBe('Test World');
      expect(body.description).toBe('desc');
      expect(body.version).toBe(2);
      expect(typeof body.worldContentLength).toBe('number');
      expect(body.worldContentLength).toBeGreaterThan(0);
      expect(body.screenshotContentLength).toBe(screenshot.size);
      return jsonResponse(201, {
        id: 'abc',
        createdAt: 123,
        expiresAt: 183,
        mode: 'presigned',
        world: {
          url: 'https://r2.example/bucket/published/abc.world.json?sig=1',
          method: 'PUT',
          contentLength: body.worldContentLength,
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'If-None-Match': '*',
            'x-amz-meta-name': 'base64-name',
          },
        },
        screenshot: {
          url: 'https://r2.example/bucket/published/abc.screenshot.jpg?sig=2',
          method: 'PUT',
          contentLength: screenshot.size,
          headers: {
            'Content-Type': 'image/jpeg',
            'If-None-Match': '*',
          },
        },
      });
    });
    // Both upload PUTs succeed.
    fetchMock.mockImplementationOnce(async () => emptyResponse(200));
    fetchMock.mockImplementationOnce(async () => emptyResponse(200));

    const result = await publishWorld(minimalWorld, screenshot);
    expect(result).toEqual({ id: 'abc', createdAt: 123, mode: 'presigned' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Inspect the world PUT: body should be a gzipped blob whose plain JSON
    // round-trips back to our original WorldDocument.
    const worldCall = fetchMock.mock.calls[1];
    expect(worldCall[0]).toBe('https://r2.example/bucket/published/abc.world.json?sig=1');
    const worldInit = worldCall[1] as RequestInit;
    expect(worldInit.method).toBe('PUT');
    expect((worldInit.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
    expect((worldInit.headers as Record<string, string>)['If-None-Match']).toBe('*');
    const worldBlob = worldInit.body as Blob;
    const gzippedBytes = new Uint8Array(await worldBlob.arrayBuffer());
    const plain = gunzipSync(Buffer.from(gzippedBytes)).toString('utf-8');
    expect(JSON.parse(plain).meta.name).toBe('Test World');

    // Inspect the screenshot PUT.
    const screenshotCall = fetchMock.mock.calls[2];
    expect(screenshotCall[0]).toBe('https://r2.example/bucket/published/abc.screenshot.jpg?sig=2');
    expect((screenshotCall[1] as RequestInit).body).toBe(screenshot);
  });

  it('publishWorld propagates upload failures', async () => {
    const screenshot = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        id: 'abc',
        createdAt: 1,
        expiresAt: 2,
        mode: 'presigned',
        world: {
          url: 'https://r2.example/world',
          method: 'PUT',
          contentLength: 0, // placeholder – overwritten below
          headers: {},
        },
        screenshot: {
          url: 'https://r2.example/shot',
          method: 'PUT',
          contentLength: screenshot.size,
          headers: {},
        },
      }),
    );
    // Even though we claimed the world would be 0 bytes in the response,
    // the client never trusts that – it refuses to upload when its own
    // computed size doesn't match. That guards against a server lying.
    await expect(publishWorld(minimalWorld, screenshot)).rejects.toThrow(
      /Refusing to upload world/,
    );
  });

  it('publishWorld raises on publish reservation error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'Id collision detected' }));
    const screenshot = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    await expect(publishWorld(minimalWorld, screenshot)).rejects.toThrow(/Id collision/);
  });

  it('listPublishedWorlds returns the worlds array', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        worlds: [{ id: 'a', name: 'Alpha', description: '', createdAt: 1, size: 100 }],
      }),
    );
    const worlds = await listPublishedWorlds();
    expect(worlds).toHaveLength(1);
    expect(worlds[0].id).toBe('a');
    expect(fetchMock).toHaveBeenCalledWith('/api/worlds');
  });

  it('listPublishedWorlds passes the limit query parameter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { worlds: [] }));
    await listPublishedWorlds(25);
    expect(fetchMock).toHaveBeenCalledWith('/api/worlds?limit=25');
  });

  it('fetchPublishedWorld GETs by id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: 2, meta: { name: 'X' } }));
    const doc = (await fetchPublishedWorld('abc')) as { version: number };
    expect(doc.version).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/worlds/abc');
  });

  it('fetchPublishedWorld throws on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }));
    await expect(fetchPublishedWorld('missing')).rejects.toThrow(/not found/);
  });

  it('screenshotUrlForWorld returns the per-id endpoint URL', () => {
    expect(screenshotUrlForWorld('abc')).toBe('/api/worlds/abc/screenshot');
    expect(screenshotUrlForWorld('foo bar')).toBe('/api/worlds/foo%20bar/screenshot');
  });
});
