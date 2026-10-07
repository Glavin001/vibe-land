#!/usr/bin/env node
// Scenes for the brick-veneer houses' film (client/native/films/veneer-houses.mjs,
// scripts/veneer-reel.sh), from the packs qualify-veneer-houses.mjs qualifies
// (build-veneer-houses.mjs variants):
//
//   out/veneer-houses/veneer-reel-standing.json            as built and frame only, each storey
//                                                          count, and two more bungalows for the
//                                                          cannonball and the meteor
//   out/veneer-houses/veneer-reel-collapse-bungalow.json   the bungalow, front-wall studs out
//   out/veneer-houses/veneer-reel-collapse-house.json      the two-storey, ground-floor front studs out
//   out/veneer-houses/veneer-reel.meta.json                where each house is, its chunks and bonds
//
// A house whose studs are out starts coming down on its first tick, so each
// of those is a scene of its own, filmed from tick 0. Houses face -z, 30 m apart.
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {composeScene} from '../src/geometry.mjs';
import {variants,OUT} from './build-veneer-houses.mjs';

const byName=Object.fromEntries([1,2].flatMap(n=>variants(n)).map(v=>[v.name,v.pack]));
const scenes={
 standing:[['bungalow','veneer-bungalow',-60],['bungalow-frame','veneer-bungalow--frame',-30],['house','veneer-house',0],['house-frame','veneer-house--frame',30],
  ['bungalow-cannonball','veneer-bungalow',60],['bungalow-meteor','veneer-bungalow',90]],
 'collapse-bungalow':[['bungalow-no-front-studs','veneer-bungalow--no-front-studs',0]],
 'collapse-house':[['house-no-front-studs','veneer-house--no-front-studs',0]],
};
mkdirSync(OUT,{recursive:true});
const meta={};
for(const [scene,houses] of Object.entries(scenes)){
 const pack=composeScene(houses.map(([id,name,x])=>({pack:byName[name],position:[x,0,0],yaw:0,group:`building@${id}`})),{key:`veneer-reel-${scene}`,title:`Brick-veneer houses: ${scene}`});
 writeFileSync(path.join(OUT,`veneer-reel-${scene}.json`),JSON.stringify(pack));
 meta[scene]=houses.map(([id,name,x])=>({id,variant:name,position:[x,0,0],chunks:byName[name].scenario.nodes.length,bonds:byName[name].scenario.bonds.length,
  top:Math.max(...byName[name].scenario.nodes.map((n,i)=>n.centroid.y+byName[name].scenario.nodeSizes[i].y/2))}));
 console.log(`veneer-reel-${scene}: ${pack.scenario.nodes.length} chunks, ${pack.scenario.bonds.length} bonds; ${houses.map(h=>h[0]).join(', ')}`);
}
writeFileSync(path.join(OUT,'veneer-reel.meta.json'),JSON.stringify(meta,null,1));
