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
 };return asset;
};
export const buildFramedPorchHouse=options=>describe(buildPorchHouse({...options,structuralSystem:'timber-frame'}));
export const buildFramedBungalow=options=>describe(buildBungalow({...options,structuralSystem:'timber-frame'}));
