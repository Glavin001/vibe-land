import { GrassPaint } from './GrassPaint';
import { generateGrassPatch } from './grassPlacement';
import type { GrassPatchRequest } from './GrassPatchWorker';
const paint = new GrassPaint();
self.onmessage = (event: MessageEvent<GrassPatchRequest>) => {
  const request = event.data;
  paint.import(request.paint);
  const data = generateGrassPatch(request.x, request.z, request.quality, request.exclusions, paint);
  self.postMessage({ x: request.x, z: request.z, revision: request.revision, data },
    { transfer: [data.roots.buffer, data.shapes.buffer, data.colors.buffer, data.traits.buffer] });
};
