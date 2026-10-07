// `@render-backend/install` in the webgpu build (see vite.config.ts):
// registers the WebGPU implementations shared code asks for, so that code
// never imports three/webgpu itself.
import { registerSkyNodeMaterial } from '../SkyEnvironment';
import { registerGroundNodeMaterial } from '../../scene/cityMaterialShader';
import { registerMatterAvailability, registerSlotNodeMaterial } from '../../scene/citySlotMesh';
import { matterSlotMaterial } from '../../scene/cityMatterNodes';
import { registerMatterSlotMaterial, slotNodeMaterial } from '../../scene/citySlotNodes';
import { groundNodeMaterial } from '../../scene/groundNodes';
import { registerGrassNodeMaterials } from '../../scene/grass/grassMaterial';
import { grassNodeMaterials } from '../../scene/grass/grassNodes';
import { registerCanopyNodeMaterial } from '../../scene/grass/FoliageCanopy';
import { canopyNodeMaterial } from '../../scene/grass/canopyNodes';
import { registerOutdoorLeafMaterial } from '../../scene/outdoorAttachments';
import { outdoorLeafNodeMaterial } from '../../scene/outdoorLeafNodes';
import { registerDustSpriteNodeMaterial } from '../../vfx/DustSprites';
import { dustSpriteNodeMaterial } from '../../vfx/dustSpriteNodes';
import { registerMeteorFireNodes } from '../../vfx/MeteorFireStage';
import { registerMeteorNodeMaterials } from '../../vfx/meteorRock';
import { meteorEmberNodes, meteorFireNodeMaterial, meteorRockNodeMaterial } from '../../vfx/meteorNodes';
import { setPartBatchFactory } from '../../vehicles/dune/live-geometry.mjs';
import { createPartBatch } from '../../vehicles/partBatchNodes';
import { webgpuBackendActive } from './rendererBackend';
import { skyNodeMaterial } from './skyNodes';

registerSlotNodeMaterial(slotNodeMaterial);
registerMatterSlotMaterial(matterSlotMaterial);
registerMatterAvailability(webgpuBackendActive);
registerSkyNodeMaterial(skyNodeMaterial);
registerGroundNodeMaterial(groundNodeMaterial);
registerGrassNodeMaterials(grassNodeMaterials);
registerCanopyNodeMaterial(canopyNodeMaterial);
registerDustSpriteNodeMaterial(dustSpriteNodeMaterial);
registerOutdoorLeafMaterial(outdoorLeafNodeMaterial);
registerMeteorNodeMaterials({ rock: meteorRockNodeMaterial, embers: meteorEmberNodes });
registerMeteorFireNodes(meteorFireNodeMaterial);
setPartBatchFactory(createPartBatch);
