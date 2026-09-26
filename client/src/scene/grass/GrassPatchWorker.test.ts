import { PerspectiveCamera } from 'three';
import { GrassField } from './GrassField';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';
import { generateGrassPatch } from './grassPlacement';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrassPatchWorker, type GrassPatchRequest } from './GrassPatchWorker';

const request: GrassPatchRequest = { x: 0, z: 0, revision: 1, quality: 'fast', exclusions: [], paint: { version: 3, tiles: [] } };
afterEach(() => vi.unstubAllGlobals());
describe('bounded foliage worker', () => {
  it('allows only one job and terminates on failure so the renderer can fall back', () => {
    const sent: unknown[] = [];
    let fake: FakeWorker;
    class FakeWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = vi.fn();
      constructor() { fake = this; }
      postMessage(value: unknown) { sent.push(value); }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const worker = new GrassPatchWorker();
    worker.request(request); worker.request(request);
    expect(sent).toHaveLength(1);
    expect(worker.busy).toBe(true);
    fake!.onmessage!({ data: { revision: 1, x: 0, z: 0 } });
    worker.request(request); expect(sent).toHaveLength(1); // Completed result also owns the slot.
    expect(worker.take()?.revision).toBe(1);
    worker.request(request); expect(sent).toHaveLength(2);
    fake!.onerror!();
    expect(fake!.terminate).toHaveBeenCalledOnce();
    expect(worker.available).toBe(false);
    expect(worker.busy).toBe(false);
  });
  it('discards a patch generated before the user painted over it', () => {
    let job: GrassPatchRequest;
    let fake: FakeWorker;
    class FakeWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { fake = this; }
      postMessage(value: GrassPatchRequest) { job = value; }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const paint = new GrassPaint(), field = new GrassField('fast', [], paint);
    const camera = new PerspectiveCamera(60,1.6,0.1,300);
    camera.position.set(4,2,12); camera.lookAt(4,0,0); camera.updateMatrixWorld();
    field.update(camera,0);
    const old = job!;
    const data = generateGrassPatch(old.x,old.z,old.quality,[],paint);
    expect(data.count).toBeGreaterThan(0);
    paint.paint(old.x*8+4,old.z*8+4,12,GRASS_BRUSHES.bare);
    fake!.onmessage!({data:{x:old.x,z:old.z,revision:old.revision,data}});
    field.update(camera,0.1);
    expect(field.group.children.filter(child=>child.name.startsWith('Grass patch'))).toHaveLength(0);
    field.dispose(); paint.dispose();
  });

  it('falls back when worker construction is rejected', () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('CSP'); } });
    const worker = new GrassPatchWorker();
    expect(worker.available).toBe(false);
    expect(worker.take()).toBeNull(); worker.dispose();
  });

  it('drains successful work without losing or repeatedly requesting patches', () => {
    let job: GrassPatchRequest | undefined;
    let fake: FakeWorker;
    class FakeWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor() { fake = this; }
      postMessage(value: GrassPatchRequest) { job = value; }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const paint = new GrassPaint(), field = new GrassField('fast', [], paint);
    const camera = new PerspectiveCamera(60, 1.6, .1, 300);
    camera.position.set(4, 2, 12); camera.lookAt(4, 0, 0); camera.updateMatrixWorld();
    const requested = new Set<string>();
    try {
      field.update(camera, 0);
      for (let i = 1; job && i < 200; i++) {
        const current = job; job = undefined;
        const key = `${current.x},${current.z}`;
        expect(requested.has(key)).toBe(false); requested.add(key);
        fake!.onmessage!({ data: { ...current, data: generateGrassPatch(current.x, current.z, 'fast', [], paint) } });
        field.update(camera, i / 120);
      }
      expect(requested.size).toBeGreaterThan(30);
      expect(field.stats.patches).toBe(requested.size);
      expect(field.stats.pendingPatches).toBe(0);
    } finally { field.dispose(); paint.dispose(); }
  });
});
