import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';
import { GrassLayoutSync, fetchSharedGrass, publishSharedGrass, type GrassSyncStatus } from './GrassLayoutSync';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('shared grass layouts', () => {
  it('replaces private paint on two clients, skips unchanged revisions, and propagates later edits', async () => {
    vi.useFakeTimers();
    const author = new GrassPaint(); author.paint(0,55,18,GRASS_BRUSHES.vehicle);
    let revision = 'a'.repeat(64), layout = author.export();
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      const etag = (options?.headers as Record<string,string> | undefined)?.['If-None-Match'];
      return etag === `"${revision}"` ? new Response(null,{status:304}) : Response.json({revision,layout});
    });
    vi.stubGlobal('fetch', fetcher);
    const a = new GrassPaint(), b = new GrassPaint();
    a.paint(50,0,5,GRASS_BRUSHES.bare); b.paint(-50,0,5,GRASS_BRUSHES.person);
    const states: GrassSyncStatus[] = [];
    const first = new GrassLayoutSync(a,'http://city.test/match-stats/city-default/grass',s=>states.push(s));
    const second = new GrassLayoutSync(b,'http://city.test/match-stats/city-default/grass',()=>{});
    first.start(); second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.export()).toEqual(b.export()); expect(a.export()).toEqual(layout);
    expect(a.heightAt(0,55)).toBe(4);
    const localRevision = a.revision;
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.revision).toBe(localRevision); // A 304 must not regenerate any patches.
    author.paint(0,55,18,GRASS_BRUSHES.lawn); layout = author.export(); revision = 'b'.repeat(64);
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.export()).toEqual(layout); expect(b.export()).toEqual(layout);
    expect(states.at(-1)?.revision).toBe(revision);
    first.dispose(); second.dispose(); author.dispose(); a.dispose(); b.dispose();
  });

  it('keeps the last shared layout during an outage and rejects malformed updates atomically', async () => {
    vi.useFakeTimers();
    const paint = new GrassPaint(); const draft = new GrassPaint(); draft.paint(4,4,8,GRASS_BRUSHES.vehicle);
    const statuses: GrassSyncStatus[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({revision:'c'.repeat(64),layout:draft.export()}))
      .mockResolvedValueOnce(Response.json({revision:'d'.repeat(64),layout:{version:2,tiles:[{x:0,z:0,data:[255]}]}}))
      .mockRejectedValue(new Error('offline')));
    const sync = new GrassLayoutSync(paint,'http://city.test/grass',s=>statuses.push(s)); sync.start();
    await vi.advanceTimersByTimeAsync(0); const good = paint.export();
    await vi.advanceTimersByTimeAsync(4000);
    expect(paint.export()).toEqual(good); expect(statuses.at(-1)?.state).toBe('error');
    expect(statuses.at(-1)?.revision).toBe('c'.repeat(64));
    sync.dispose(); paint.dispose(); draft.dispose();
  });

  it('does not apply a late response after leaving the match', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>(r=>{resolve=r;}));
    const paint = new GrassPaint(), author = new GrassPaint(); author.paint(0,0,8,GRASS_BRUSHES.vehicle);
    const sync = new GrassLayoutSync(paint,'http://city.test/grass',()=>{}); sync.start(); sync.dispose();
    resolve(Response.json({revision:'a'.repeat(64),layout:author.export()}));
    await vi.advanceTimersByTimeAsync(0);
    expect(paint.export().tiles).toHaveLength(0);
    paint.dispose(); author.dispose();
  });

  it('publishes with an editor key and revision, without silently retrying a conflict', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('changed',{status:409}));
    vi.stubGlobal('fetch',fetcher);
    await expect(publishSharedGrass('http://city.test/grass','a'.repeat(64),{version:2,tiles:[]},'key')).rejects.toThrow('Someone updated');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({Authorization:'Bearer key','If-Match':`"${'a'.repeat(64)}"`});
    fetcher.mockResolvedValue(new Response('html',{status:404}));
    await expect(fetchSharedGrass('http://city.test/grass')).rejects.toThrow('404');
  });
});
