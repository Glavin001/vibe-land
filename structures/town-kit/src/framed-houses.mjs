/** Experimental builders, deployed for user-directed town testing. Full native
 * damage, traversal and reuse qualification remains open; see repros/house-cannonball.
 */
import {buildPorchHouse} from './porch-house.mjs';
import {buildBungalow} from './bungalow.mjs';
const describe=asset=>{
 asset.metadata.structure={
  system:'timber-frame',qualification:'experimental',
  loadPath:['buried perimeter and internal footings','structural timber decks','storey posts and headers','ceiling deck','seated rafters, king posts and ridge','roof covering'],
  structuralTypes:['foundation','floor','ceiling','frame-post','frame-beam','roof-post','roof-rafter','roof-ridge','stair'],
  cosmeticTypes:['wall-infill','gable-infill','siding','glazing','sash','sill','window-frame','window-head','cornice'],
  infillVerticalClearanceM:.006,
  note:'Cosmetic panels attach laterally. Bare-frame gravity tests retain floors, roof covering, stairs and furnishings. The roof covering remains destructible.'
 };
 if(['residential-v1','residential-v2'].includes(asset.metadata.options.impactProfile))Object.assign(asset.metadata.structure,{
  roofSystem:'joisted-ceiling',roofCoverThicknessM:.03,ceilingPanelThicknessM:.025,
  frameBondMaterial:'timber-joint',roofAttachmentMaterial:'cladding-fastener',
  loadPath:['buried perimeter and internal footings','structural timber floors','storey posts and headers','ceiling plates and joists','seated rafters, king posts and ridge','30 mm slate/sheathing covering'],
  structuralTypes:[...asset.metadata.structure.structuralTypes.filter(t=>t!=='ceiling'),'ceiling-joist'],
  cosmeticTypes:[...asset.metadata.structure.cosmeticTypes,'ceiling-panel']
 });
 if(asset.metadata.options.impactProfile==='residential-v2')asset.metadata.structure.wallConstruction='Single-skin painted timber boarding attached to the frame; separate boards are not welded to each other. Experimental, not yet destruction-qualified.';
 return asset;
};
export const buildFramedPorchHouse=options=>describe(buildPorchHouse({...options,structuralSystem:'timber-frame'}));
export const buildFramedBungalow=options=>describe(buildBungalow({...options,structuralSystem:'timber-frame'}));
