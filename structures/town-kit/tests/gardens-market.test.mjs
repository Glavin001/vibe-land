import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildBaylineGardensMarket} from '../src/bayline-gardens-market.mjs';
import {buildBaylineTown} from '../src/bayline-town.mjs';
import {OUTDOOR_PROP_TYPES} from '../src/outdoor-props.mjs';
import {assetHash,validateVisuals} from '../src/outdoor-visuals.mjs';
import {validate} from '../src/validate.mjs';
test('the furnished fork preserves Bayline and covers the outdoor kit with independent cannon targets',()=>{
 const base=buildBaylineTown(),town=buildBaylineGardensMarket(),m=town.metadata;
 assert.equal(m.sourceScene.sha256,assetHash(base.pack));
 assert.notEqual(town.pack.key,base.pack.key);
 assert.deepEqual(town.pack.scenario.nodes.slice(0,base.pack.scenario.nodes.length),base.pack.scenario.nodes);
 assert.equal(m.instances.length,6);
 const included=new Set(m.dressing.map(p=>p.type)),targets=new Set(m.cannonTour.chapters.map(c=>c.type));
 for(const type of OUTDOOR_PROP_TYPES){assert(included.has(type),type);assert(targets.has(type),`unfilmed ${type}`);}
 assert.equal(m.cannonTour.chapters.length,26);
 assert(m.shots.cannon.every((s,i,a)=>((s.mass===500&&s.speed===25)||(s.mass===2000&&s.speed===35))&&(!i||s.tick>a[i-1].tick)));
 assert(validate(town.pack).passed);assert(validateVisuals(town.visuals,town.pack));
});
