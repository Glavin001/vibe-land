// `@render-backend/install` in the webgpu build (see vite.config.ts):
// registers the WebGPU implementations shared code asks for, so that code
// never imports three/webgpu itself.
import { registerSkyNodeMaterial } from '../SkyEnvironment';
import { registerGroundNodeMaterial } from '../../scene/cityMaterialShader';
import { registerSlotNodeMaterial } from '../../scene/citySlotMesh';
import { slotNodeMaterial } from '../../scene/citySlotNodes';
import { groundNodeMaterial } from '../../scene/groundNodes';
import { registerGrassNodeMaterials } from '../../scene/grass/grassMaterial';
import { grassNodeMaterials } from '../../scene/grass/grassNodes';
import { registerCanopyNodeMaterial } from '../../scene/grass/FoliageCanopy';
import { canopyNodeMaterial } from '../../scene/grass/canopyNodes';
import { registerDustSpriteNodeMaterial } from '../../vfx/DustSprites';
import { dustSpriteNodeMaterial } from '../../vfx/dustSpriteNodes';
import { skyNodeMaterial } from './skyNodes';

registerSlotNodeMaterial(slotNodeMaterial);
registerSkyNodeMaterial(skyNodeMaterial);
registerGroundNodeMaterial(groundNodeMaterial);
registerGrassNodeMaterials(grassNodeMaterials);
registerCanopyNodeMaterial(canopyNodeMaterial);
registerDustSpriteNodeMaterial(dustSpriteNodeMaterial);
