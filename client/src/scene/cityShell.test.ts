// The shell's whole claim is "pixel-identical to the instances it replaces",
// and every part of that claim is arithmetic that can be checked without a
// GPU: merged positions equal what the instance matrix would produce, the
// triplanar anchor is copied verbatim, the layout matches the batch, and
// retiring a range degenerates exactly that range and nothing else.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildBoxGeometry, buildHullGeometry } from '../city/chunkGeometry';
import { bakeRestAnchors } from './cityTexAnchor';
import { ShellBuilder, retireShellRange } from './cityShell';

const TETRA = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** anchors/scales arrays for two chunks: a scaled box and a unit hull. */
function twoChunks() {
  return {
    anchors: Float32Array.from([10, 20, 30, 7, -4, 1, 9, 3]),
    scales: Float32Array.from([2, 4, 6, 1, 1, 1]),
  };
}

describe('ShellBuilder', () => {
  it('bakes positions the instance matrix would have produced', () => {
    const { anchors, scales } = twoChunks();
    const box = buildBoxGeometry();
    bakeRestAnchors(box, 0, anchors, scales);
    const shell = new ShellBuilder();
    shell.append(box);
    const merged = shell.build();

    // What the instanced path draws: compose(restPosition, identity, scale)
    // applied to the local vertex. The shell must land every vertex there.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(10, 20, 30),
      new THREE.Quaternion(),
      new THREE.Vector3(2, 4, 6),
    );
    const local = box.getAttribute('position');
    const baked = merged.getAttribute('position');
    const probe = new THREE.Vector3();
    for (let i = 0; i < local.count; i += 1) {
      probe.set(local.getX(i), local.getY(i), local.getZ(i)).applyMatrix4(matrix);
      expect(baked.getX(i)).toBeCloseTo(probe.x, 5);
      expect(baked.getY(i)).toBeCloseTo(probe.y, 5);
      expect(baked.getZ(i)).toBeCloseTo(probe.z, 5);
    }
  });

  it('copies the triplanar anchor verbatim, so the concrete cannot shift', () => {
    const { anchors, scales } = twoChunks();
    const hull = buildHullGeometry(TETRA);
    bakeRestAnchors(hull, 1, anchors, scales);
    const source = hull.getAttribute('cityAnchor');
    const shell = new ShellBuilder();
    shell.append(hull);
    const copied = shell.build().getAttribute('cityAnchor');
    for (let i = 0; i < source.count; i += 1) {
      expect(copied.getX(i)).toBe(source.getX(i));
      expect(copied.getW(i)).toBe(source.getW(i));
    }
  });

  it('matches the batch attribute layout, which is a hard error to miss', () => {
    const { anchors, scales } = twoChunks();
    const box = buildBoxGeometry();
    bakeRestAnchors(box, 0, anchors, scales);
    const shell = new ShellBuilder();
    shell.append(box);
    const merged = shell.build();
    expect(Object.keys(merged.attributes).sort()).toEqual(Object.keys(box.attributes).sort());
    // The proof that matters: a real BatchedMesh accepts the shell alongside
    // an ordinary member.
    const mesh = new THREE.BatchedMesh(
      2,
      merged.attributes.position.count + box.attributes.position.count,
      (merged.getIndex()?.count ?? 0) + (box.getIndex()?.count ?? 0),
      new THREE.MeshStandardMaterial(),
    );
    expect(() => {
      mesh.addInstance(mesh.addGeometry(merged));
      mesh.addInstance(mesh.addGeometry(box));
    }).not.toThrow();
  });

  it('records ranges that tile the index buffer with no gaps', () => {
    const { anchors, scales } = twoChunks();
    const shell = new ShellBuilder();
    const box = buildBoxGeometry();
    bakeRestAnchors(box, 0, anchors, scales);
    const first = shell.append(box);
    const hull = buildHullGeometry(TETRA);
    bakeRestAnchors(hull, 1, anchors, scales);
    const second = shell.append(hull);
    expect(first.start).toBe(0);
    expect(second.start).toBe(first.count);
    expect(shell.indexCount).toBe(first.count + second.count);
  });
});

describe('retireShellRange', () => {
  it('degenerates exactly the slot range, leaving neighbours untouched', () => {
    const { anchors, scales } = twoChunks();
    const shell = new ShellBuilder();
    const box = buildBoxGeometry();
    bakeRestAnchors(box, 0, anchors, scales);
    const boxRange = shell.append(box);
    const hull = buildHullGeometry(TETRA);
    bakeRestAnchors(hull, 1, anchors, scales);
    const hullRange = shell.append(hull);
    const merged = shell.build();

    // Shell added FIRST, exactly as buildCellHullBatch does: that is what pins
    // the recorded ranges to absolute index 0.
    const mesh = new THREE.BatchedMesh(
      2,
      merged.attributes.position.count * 2,
      (merged.getIndex()?.count ?? 0) * 2,
      new THREE.MeshStandardMaterial(),
    );
    mesh.addInstance(mesh.addGeometry(merged));

    const index = mesh.geometry.getIndex()!;
    const before = Array.from(index.array.slice(0, shell.indexCount));

    retireShellRange(mesh, boxRange);

    const after = index.array;
    // The box's triangles all collapse onto one vertex...
    const collapsed = after[boxRange.start];
    for (let i = 0; i < boxRange.count; i += 1) {
      expect(after[boxRange.start + i]).toBe(collapsed);
    }
    // ...and the hull's are bit-identical to before.
    for (let i = 0; i < hullRange.count; i += 1) {
      expect(after[hullRange.start + i]).toBe(before[hullRange.start + i]);
    }
  });
});
