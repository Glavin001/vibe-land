// `@render-backend/install` in the webgpu build (see vite.config.ts):
// registers the WebGPU implementations shared code asks for, so that code
// never imports three/webgpu itself.
import { registerSkyNodeMaterial } from '../SkyEnvironment';
import { registerSlotNodeMaterial } from '../../scene/citySlotMesh';
import { slotNodeMaterial } from '../../scene/citySlotNodes';
import { skyNodeMaterial } from './skyNodes';

registerSlotNodeMaterial(slotNodeMaterial);
registerSkyNodeMaterial(skyNodeMaterial);
