// The material showcase (scripts/native-mac.sh --scene materials): a kitchen
// run, a dining set and a shelf on open ground, and a furnished porch house
// behind them -- every Matter look the town kit wears (marble worktops, a
// brushed-steel fridge and fittings, oak furniture, pine framing, cast
// concrete footings, glass) where a camera can see it close
// (client/e2e/helpers/matterPoses.mjs).
//
//   node structures/town-kit/scripts/build-material-showcase.mjs
//   -> structures/town-kit/out/material-showcase/material-showcase.json
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {buildProp} from '../src/props.mjs';
import {buildPorchHouse} from '../src/porch-house.mjs';
import {composeScene} from '../src/geometry.mjs';
import {validate} from '../src/validate.mjs';

const at=(type,x,z,yaw=0)=>({...buildProp(type),position:[x,0,z],yaw,group:`${type}@showcase-${x}-${z}`});
const kitchen=['counter','sink','hob','refrigerator','counter','cabinet'].map((type,i)=>at(type,(i-2.5)*1.3,0));
const placements=[
 ...kitchen,
 at('table',-1.5,-4),at('chair',-2.6,-4,90),at('chair',-0.4,-4,270),
 at('shelf',2.5,-4),
 {...buildPorchHouse(),position:[0,0,16],group:'porch-house@showcase'},
];
const pack=composeScene(placements,{key:'material-showcase',title:'Town kit · material showcase'});
const validation=validate(pack);if(!validation.passed)throw Error(validation.errors.join('\n'));
const out=path.join(KIT,'out/material-showcase');await mkdir(out,{recursive:true});
await writeFile(path.join(out,'material-showcase.json'),JSON.stringify(pack));
console.log(JSON.stringify({out,chunks:pack.scenario.nodes.length,bonds:pack.scenario.bonds.length,materials:pack.defaults.solver.materials.map(m=>m.name)}));
