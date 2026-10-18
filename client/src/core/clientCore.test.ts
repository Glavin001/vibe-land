import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../wasm/core-pkg/vibe_client_core_wasm.js';
import { buildHullGeometry, provideCoreHullTriangles } from '../city/chunkGeometry';
import { coreHullTriangles } from './clientCore';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signed volume of a non-indexed triangle soup (positive when wound outward). */
function volume(positions: ArrayLike<number>): number {
  let v6 = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from({ length: 9 }, (_, k) => positions[i + k]);
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v6 / 6;
}

/** Every edge in exactly two triangles, once each way: a closed, consistently wound surface. */
function closed(positions: ArrayLike<number>): boolean {
  const key = (i: number) => `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
  const edges = new Map<string, number>();
  for (let t = 0; t + 8 < positions.length; t += 9) {
    for (let e = 0; e < 3; e += 1) {
      const a = key(t + e * 3);
      const b = key(t + ((e + 1) % 3) * 3);
      edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const [edge, count] of edges) {
    const [a, b] = edge.split('|');
    if (count !== 1 || edges.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
}

/** Point clouds shaped like the packs' hulls (chunkGeometry.ts hullKey: Voronoi shards, prisms). */
function clouds(): Array<[string, Float32Array]> {
  const out: Array<[string, Float32Array]> = [];
  const next = rng(42);
  for (let i = 0; i < 40; i += 1) {
    // A shard: random points in a box of 5 cm to 3 m.
    const size = [0.05 + next() * 3, 0.05 + next() * 3, 0.05 + next() * 3];
    const n = 4 + Math.floor(next() * 20);
    const p: number[] = [];
    for (let k = 0; k < n; k += 1) p.push(...size.map((s) => (next() - 0.5) * s));
    out.push([`shard ${i}`, Float32Array.from(p)]);
  }
  for (let i = 0; i < 20; i += 1) {
    // A prism with every vertex stored three times (render positions reused as collider points).
    const sides = 3 + Math.floor(next() * 6);
    const [r, h] = [0.1 + next(), 0.05 + next() * 2];
    const p: number[] = [];
    for (let k = 0; k < sides; k += 1) {
      const a = (k / sides) * Math.PI * 2;
      for (const y of [-h / 2, h / 2]) for (let rep = 0; rep < 3; rep += 1) p.push(r * Math.cos(a), y, r * Math.sin(a));
    }
    out.push([`prism ${i}`, Float32Array.from(p)]);
  }
  for (let i = 0; i < 10; i += 1) {
    // Many points on a sphere: lots of hull faces.
    const p: number[] = [];
    for (let k = 0; k < 60; k += 1) {
      const [u, v] = [next() * 2 - 1, next() * Math.PI * 2];
      const s = Math.sqrt(1 - u * u);
      p.push(s * Math.cos(v), u, s * Math.sin(v));
    }
    out.push([`sphere ${i}`, Float32Array.from(p)]);
  }
  return out;
}

describe('core chunk hulls (the Unreal client\'s, via WASM)', () => {
  beforeAll(() => {
    const dir = dirname(fileURLToPath(import.meta.url));
    initSync({ module: readFileSync(join(dir, '../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
  });

  it.each(clouds())('%s: closed, outward, and the volume three\'s ConvexGeometry encloses', (_name, points) => {
    const core = coreHullTriangles(points);
    expect(core).toBeDefined();
    const vertices: THREE.Vector3[] = [];
    for (let i = 0; i < points.length; i += 3) vertices.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
    const three = new ConvexGeometry(vertices).getAttribute('position').array;
    expect(closed(core!)).toBe(true);
    const [vc, vt] = [volume(core!), volume(three)];
    expect(vc).toBeGreaterThan(0);
    // The hull of a point set is unique: equal volume to f32 rounding (relative 1e-4, the plan's gate).
    expect(Math.abs(vc - vt)).toBeLessThanOrEqual(1e-4 * vt);
  });

  it('gives no hull for points that span no volume', () => {
    expect(coreHullTriangles(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]))).toBeUndefined();
  });

  it('builds the batched geometry from it once provided', () => {
    const points = clouds()[0][1];
    provideCoreHullTriangles(coreHullTriangles);
    try {
      const geometry = buildHullGeometry(points);
      const position = geometry.getAttribute('position').array;
      expect(Array.from(position)).toStrictEqual(Array.from(coreHullTriangles(points)!));
      for (const name of ['normal', 'uv', 'cityAnchor']) expect(geometry.getAttribute(name)).toBeDefined();
      expect(geometry.getIndex()).not.toBeNull();
    } finally {
      provideCoreHullTriangles(null);
    }
  });
});
