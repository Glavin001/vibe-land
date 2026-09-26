import { BufferAttribute, BufferGeometry, Mesh, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { attachFoliageTemplate } from './foliageBuffers';
import { GrassField } from './GrassField';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';

describe('streamed foliage resources', () => {
  it('evicting a patch cannot release buffers used by its live neighbor', () => {
    const template = new BufferGeometry();
    template.setIndex([0, 1, 2]);
    template.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    const a = new BufferGeometry(), b = new BufferGeometry();
    attachFoliageTemplate(a, template); attachFoliageTemplate(b, template);
    // Model Three's attribute cache: geometry disposal removes every attached
    // index/attribute by object identity, with no shared-owner reference count.
    const buffers = new Set([a.index, b.index, ...Object.values(a.attributes), ...Object.values(b.attributes)]);
    a.addEventListener('dispose', () => {
      buffers.delete(a.index);
      for (const attribute of Object.values(a.attributes)) buffers.delete(attribute);
    });
    a.dispose();
    expect(buffers.has(b.index)).toBe(true);
    expect(buffers.has(b.getAttribute('position'))).toBe(true);
    expect(b.index!.array).toBe(template.index!.array);
    expect(b.getAttribute('position').array).toBe(template.getAttribute('position').array);
    b.dispose(); template.dispose();
  });

  it('newly streamed and repainted plants inherit disabled shadows until toggled', () => {
    const paint = new GrassPaint(); paint.paint(4, 4, 12, GRASS_BRUSHES.corn);
    const field = new GrassField('fast', [], paint);
    const camera = new PerspectiveCamera(60, 1.6, .1, 300);
    camera.position.set(4, 2, 12); camera.lookAt(4, 1, 0); camera.updateMatrixWorld();
    const meshes = () => { const result: Mesh[] = []; field.group.traverse(o => { if (o instanceof Mesh) result.push(o); }); return result; };
    try {
      field.setShadows(false);
      for (let i = 0; i < 60; i++) field.update(camera, i / 60);
      expect(meshes().length).toBeGreaterThan(10);
      expect(meshes().every(m => !m.receiveShadow)).toBe(true);
      paint.paint(4, 4, 12, GRASS_BRUSHES.vehicle);
      for (let i = 60; i < 120; i++) field.update(camera, i / 60);
      expect(meshes().every(m => !m.receiveShadow)).toBe(true);
      field.setShadows(true);
      expect(meshes().every(m => m.receiveShadow)).toBe(true);
    } finally { field.dispose(); paint.dispose(); }
  });
});
