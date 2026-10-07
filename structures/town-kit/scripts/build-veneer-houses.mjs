#!/usr/bin/env node
// Brick-veneer timber-frame houses (src/veneer-houses.mjs) and the variants
// their structural qualification needs:
//   <key>.json                 as built
//   <key>--frame.json          brick veneer and gypsum board removed
//   <key>--no-front-studs.json the front wall's studs (studs, king, jack, cripple) removed, every storey's
// written to out/veneer-houses/, each validated, with the authored graph's
// numbers (stress-convergence checklist: bond areas, stiffness spread, mass
// contrast across a bond).
//   node structures/town-kit/scripts/build-veneer-houses.mjs [--storeys 1,2]
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {buildVeneerHouse,withoutSkin,withoutStuds} from '../src/veneer-houses.mjs';
import {validate} from '../src/validate.mjs';

export const OUT=path.join(KIT,'out/veneer-houses');
const arg=process.argv.indexOf('--storeys');
const storeys=arg>0?process.argv[arg+1].split(',').map(Number):[1,2];

/** The numbers the stress-convergence skill asks for, from the pack itself. */
export function graphStats(pack){
 const s=pack.scenario,t=pack.defaults.solver.materials,areas=s.bonds.map(b=>b.area).sort((a,b)=>a-b);
 const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
 const w=s.bonds.map(b=>{const E=(t[b.m].elasticModulus||30e9)/30e9,L=Math.max(.05,dist(s.nodes[b.node0].centroid,s.nodes[b.node1].centroid));return Math.sqrt(E*Math.max(b.area,1e-4)/L);});
 let ratio=1,worst=null;
 for(const b of s.bonds){const m0=s.nodes[b.node0].mass,m1=s.nodes[b.node1].mass;if(!(m0>0&&m1>0))continue;const r=Math.max(m0,m1)/Math.min(m0,m1);if(r>ratio){ratio=r;worst=`${s.nodeTypes[b.node0]} ${m0.toFixed(1)} kg - ${s.nodeTypes[b.node1]} ${m1.toFixed(1)} kg`;}}
 const byMaterial={};for(const b of s.bonds){const n=t[b.m].name;byMaterial[n]=(byMaterial[n]??0)+1;}
 const mass=s.nodes.reduce((q,n)=>q+n.mass,0),masses=s.nodes.filter(n=>n.mass>0).map(n=>n.mass).sort((a,b)=>a-b);
 return {nodes:s.nodes.length,bonds:s.bonds.length,massKg:Math.round(mass),chunkMassKg:{min:+masses[0].toFixed(2),median:+masses[masses.length>>1].toFixed(1),max:+masses.at(-1).toFixed(0)},
  areaM2:{min:areas[0],p10:areas[Math.floor(areas.length*.1)],median:areas[areas.length>>1]},slivers:areas.filter(a=>a<1e-4).length,
  stiffnessSpread:+((Math.max(...w)/Math.min(...w))**2).toFixed(1),maxMassRatio:+ratio.toFixed(1),worstMassRatio:worst,byMaterial};
}

export function variants(storeysCount){
 const {pack,metadata}=buildVeneerHouse({storeys:storeysCount}),key=pack.key;
 return [[key,pack],[`${key}--frame`,withoutSkin(pack)],[`${key}--no-front-studs`,withoutStuds(pack,metadata,storeysCount>1?['front-0','front-1']:'front')]].map(([name,p])=>({name,pack:p,metadata}));
}

if(import.meta.url===`file://${process.argv[1]}`){
 mkdirSync(OUT,{recursive:true});let failed=false;
 for(const n of storeys)for(const {name,pack,metadata} of variants(n)){
  const check=validate(pack),stats=graphStats(pack);
  writeFileSync(path.join(OUT,`${name}.json`),JSON.stringify(pack));
  if(!name.includes('--'))writeFileSync(path.join(OUT,`${name}.meta.json`),JSON.stringify(metadata,null,1));
  // A variant with a wall's studs gone may leave pieces hanging free: that is the point of it.
  const ok=check.passed||name.endsWith('--no-front-studs')&&check.errors.every(e=>e.startsWith('unanchored'));
  if(!ok)failed=true;
  console.log(`${ok?'ok  ':'FAIL'} ${name}: ${JSON.stringify(stats)}${check.passed?'':`\n     ${check.errors.slice(0,6).join('\n     ')}`}`);
 }
 process.exitCode=failed?1:0;
}
