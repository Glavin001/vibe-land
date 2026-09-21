import test from 'node:test';
import assert from 'node:assert/strict';
import {Builder,nativeColliders,boundsFor} from '../src/geometry.mjs';
import {buildPropRaw,buildProp} from '../src/props.mjs';
import {validate} from '../src/validate.mjs';
const resolve=(s,c)=>c.kind==='shape'?s.shapeLibrary[c.shape]:c;

test('native hull export preserves actual surfaces, loads, fragmentation and bonds',()=>{
 for(const type of ['counter','bathtub']){
  const original=buildPropRaw(type).pack,converted=buildProp(type).pack;
  for(const key of ['nodes','bonds','nodeSizes','nodePieces','nodeGroups','nodeMaterials','nodeTypes'])assert.deepEqual(converted.scenario[key],original.scenario[key],`${type}: ${key}`);
  assert.deepEqual(converted.defaults,original.defaults);
  for(let i=0;i<original.scenario.nodes.length;i++){
   const n=original.scenario.nodes[i],before=original.scenario.nodeColliders[i],after=resolve(converted.scenario,converted.scenario.nodeColliders[i]);
   assert.deepEqual(boundsFor(n,after),boundsFor(n,before));
   assert.equal(after.kind,'convex_hull');assert.equal(new Set(after.points.map((_,j)=>j%3?null:after.points.slice(j,j+3).join(',')).filter(Boolean)).size,8);
  }
  assert(validate(converted).passed);
 }
});

test('slender panels retain GPU-compatible primitives and conversion is idempotent',()=>{
 const b=new Builder('test',{group:'prop-counter'});
 b.box({min:[0,0,0],max:[1,.006,1]});
 b.box({min:[2,0,0],max:[3,1,1]});
 const converted=nativeColliders(b.build());
 assert.equal(converted.scenario.nodeColliders[0].kind,'cuboid');
 assert.equal(resolve(converted.scenario,converted.scenario.nodeColliders[1]).kind,'convex_hull');
 assert.deepEqual(nativeColliders(structuredClone(converted)),converted);
 const architecture=new Builder('test');architecture.box({min:[0,0,0],max:[1,1,1]});
 assert.equal(nativeColliders(architecture.build()).scenario.nodeColliders[0].kind,'cuboid');
});
