import { BufferAttribute, type BufferGeometry } from 'three';

/** Share immutable CPU arrays, but give each disposable patch its own GPU buffers.
 * Three removes every attribute's GPU buffer on geometry.dispose(); it does not
 * reference-count attributes shared by other live geometries. Sharing wrappers
 * made patch eviction delete buffers still used by neighboring patches' VAOs.
 */
export function attachFoliageTemplate(target: BufferGeometry, template: BufferGeometry): void {
  if (template.index) target.setIndex(new BufferAttribute(template.index.array, 1));
  for (const name of Object.keys(template.attributes)) {
    const source = template.getAttribute(name) as BufferAttribute;
    target.setAttribute(name, new BufferAttribute(source.array, source.itemSize, source.normalized));
  }
}
