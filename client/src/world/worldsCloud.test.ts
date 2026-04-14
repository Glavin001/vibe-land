import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCloudConfig,
  fetchPublishedWorld,
  listPublishedWorlds,
  publishWorld,
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

describe('worldsCloud', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchCloudConfig returns enabled flag', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true }));
    await expect(fetchCloudConfig()).resolves.toEqual({ enabled: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/worlds/config');
  });

  it('fetchCloudConfig coerces missing enabled to false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(fetchCloudConfig()).resolves.toEqual({ enabled: false });
  });

  it('publishWorld POSTs serialized JSON and returns id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'abc', createdAt: 123 }));
    const result = await publishWorld(minimalWorld);
    expect(result).toEqual({ id: 'abc', createdAt: 123 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worlds/publish');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init?.body as string);
    expect(body.meta.name).toBe('Test World');
  });

  it('publishWorld raises when the server returns an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(413, { error: 'too big' }));
    await expect(publishWorld(minimalWorld)).rejects.toThrow(/too big/);
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
});
