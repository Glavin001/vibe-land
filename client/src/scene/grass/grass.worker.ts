import { GrassPaint } from './GrassPaint';
import { generateGrassPatch } from './grassPlacement';
import type { GrassPatchRequest } from './GrassPatchWorker';
import { generateCoreGrassPatch, loadCoreGrass } from './coreGrass';
const paint = new GrassPaint();
self.onmessage = async (event: MessageEvent<GrassPatchRequest>) => {
  const request = event.data;
  let data;
  if (request.core && await loadCoreGrass()) {
    data = generateCoreGrassPatch(request.x, request.z, request.quality, request.exclusions, request.paint);
  } else {
    paint.import(request.paint);
    data = generateGrassPatch(request.x, request.z, request.quality, request.exclusions, paint);
  }
  self.postMessage({ x: request.x, z: request.z, revision: request.revision, data },
    { transfer: [data.roots.buffer, data.shapes.buffer, data.colors.buffer, data.traits.buffer] });
};
