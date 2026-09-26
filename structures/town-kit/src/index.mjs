export {buildVictorianCorner} from './victorian.mjs';
export {composeScene} from './geometry.mjs';
export {validate} from './validate.mjs';
export {buildProp,PROP_TYPES,buildTable,buildChair,buildFence} from './props.mjs';
import {buildProp} from './props.mjs';
export const buildCounter=(options={})=>buildProp(!options.variant||options.variant==='plain'?'counter':options.variant,options);
export const buildCabinet=options=>buildProp('cabinet',options);
export const buildShelf=options=>buildProp('shelf',options);
export const buildRefrigerator=options=>buildProp('refrigerator',options);
export const buildBed=options=>buildProp('bed',options);
export const buildSofa=options=>buildProp('sofa',options);
export const buildGate=options=>buildProp('gate',options);

export const buildToilet=options=>buildProp('toilet',options);
export const buildBathtub=options=>buildProp('bathtub',options);
export {buildPorchHouse} from './porch-house.mjs';
export {buildCornerGrocery} from './corner-grocery.mjs';
export {buildWorkshop} from './workshop.mjs';

export {buildBaylineTown} from './bayline-town.mjs';
export {buildBungalow} from './bungalow.mjs';
export {buildBaylineDistrict} from './bayline-district.mjs';
export {buildStripShop} from './strip-shop.mjs';
export {buildBaylineSmallTown} from './bayline-small-town.mjs';

export {buildNeighborhoodLibrary} from './neighborhood-library.mjs';
export {buildArtDecoCinema} from './art-deco-cinema.mjs';
export {buildFireStation} from './fire-station.mjs';
export {buildBookStack} from './book-stack.mjs';
export {buildCinemaSeat} from './cinema-seat.mjs';

export {buildBaylineCivicTown} from './bayline-civic-town.mjs';
export {buildOutdoorProp,OUTDOOR_PROP_TYPES} from './outdoor-props.mjs';
export {buildTree,TREE_FAMILIES} from './tree.mjs';
export {buildOutdoorGallery,buildOutdoorEncounter,buildDressedBayline,buildTreeReuseFixture} from './outdoor-scenes.mjs';
