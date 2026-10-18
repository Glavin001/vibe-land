import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {encodeSceneBundle,decodeSceneBundle,inspectSceneBundle} from '../src/scene-binary.mjs';
import {composeScene} from '../src/geometry.mjs';
const v=(x,y,z)=>({x,y,z});
const material={name:'test-wood',color:'#aabbcc',textureKey:'aged-timber',density:600,compressionElastic:1e6,compressionFatal:2e6,tensionElastic:1e5,tensionFatal:2e5,shearElastic:1e5,shearFatal:2e5,elasticModulus:1e9,residualAreaFraction:0,roughness:.7,metalness:.1};
function fixture(){return {version:2,key:'fixture',title:'Fixture',defaults:{solver:{gravity:-9.81,materials:[material]}},scenario:{nodes:[{centroid:v(-.345678,.123456,1.234567),mass:0,volume:.125,m:0},{centroid:v(-.345678,1.123456,1.234567),mass:3.14159265,volume:.006,m:0}],nodeSizes:[v(.5,.5,.5),v(.4,.6,.8)],nodeColliders:[{kind:'cuboid',halfExtents:v(.25,.25,.25)},{kind:'shape',shape:0}],shapeLibrary:[{kind:'convex_hull',points:[0,0,0,.4,0,0,0,.6,0,0,0,.8]}],bonds:[{node0:0,node1:1,centroid:v(-.345678,.623456,1.234567),normal:v(.6,.8,0),area:.03,m:0}],nodePieces:[0,1],nodeTypes:['foundation','wall'],nodeMaterials:['test-wood','test-wood'],nodeGroups:['building','building']}};}
const asset=fixture(),recolored=structuredClone(asset);recolored.defaults.solver.materials[0].color='#ccbbaa';
const placements=[{pack:asset},{pack:recolored,position:[12.345678,0,-3.456789],yaw:90},{pack:asset,position:[-20.000001,2,7],yaw:180,mirror:true},{pack:asset,position:[30,0,0],yaw:270}];
const bytes=encodeSceneBundle(placements,{key:'fixture',title:'Fixture',provenance:{seed:42}});
const expected=composeScene(placements,{key:'fixture',title:'Fixture'});
test('binary round trip preserves all data, transforms, palette remaps and independent IDs',()=>{
 assert.deepEqual(decodeSceneBundle(bytes).pack,expected);
 assert.deepEqual(bytes,encodeSceneBundle(placements,{key:'fixture',title:'Fixture',provenance:{seed:42}}));
 const {header}=inspectSceneBundle(bytes);assert.equal(header.templates.length,1);assert.equal(header.materials.length,2);assert.equal(header.instances.length,4);
 const s=decodeSceneBundle(bytes).pack.scenario;for(const b of s.bonds)assert.equal(Math.floor(b.node0/2),Math.floor(b.node1/2));assert.equal(new Set(s.nodePieces).size,8);
});
test('export rejects invalid transforms, non-finite geometry and broken references',()=>{
 assert.throws(()=>encodeSceneBundle([{pack:asset,yaw:45}]));
 const bad=fixture();bad.scenario.bonds[0].node1=99;assert.throws(()=>encodeSceneBundle([{pack:bad}]));
 bad.scenario.bonds=[];bad.scenario.nodes[0].centroid.x=NaN;assert.throws(()=>encodeSceneBundle([{pack:bad}]));
});
function corrupted(kind){let b=Buffer.from(bytes);if(kind==='truncated')return b.subarray(0,b.length-1);if(kind==='version'){b.writeUInt32LE(99,4);return b;}if(kind==='checksum'){b[b.length-1]^=1;return b;}const {header}=inspectSceneBundle(b),offset=64+Math.ceil(b.readUInt32LE(8)/8)*8;if(kind==='node-reference')b.writeUInt32LE(99,offset+header.sections.bonds.offset+60);if(kind==='shape-reference')b.writeUInt32LE(99,offset+112+104);if(kind==='nan')b.writeDoubleLE(NaN,offset);createHash('sha256').update(b.subarray(64)).digest().copy(b,32);return b;}
test('truncation, version, checksum and dangling references fail',()=>{for(const kind of ['truncated','version','checksum','node-reference','shape-reference','nan'])assert.throws(()=>decodeSceneBundle(corrupted(kind)),kind);});
// Tiny generated cross-language fixtures are review outputs, not another source of truth.
const out=new URL('../out/binary-tests/',import.meta.url);mkdirSync(out,{recursive:true});writeFileSync(new URL('fixture.vlsp',out),bytes);writeFileSync(new URL('fixture.json',out),JSON.stringify(expected));
for(const kind of ['truncated','version','checksum','node-reference','shape-reference','nan'])writeFileSync(new URL(kind+'.vlsp',out),corrupted(kind));
test('current full-town binary expands to the exact saved JSON scene',{skip:!existsSync(new URL('../out/bayline-civic-town.json.gz',import.meta.url))},async()=>{
 const {gunzipSync}=await import('node:zlib');const expected=JSON.parse(gunzipSync(readFileSync(new URL('../out/bayline-civic-town.json.gz',import.meta.url))));const decoded=decodeSceneBundle(readFileSync(new URL('../out/bayline-civic-town.vlsp',import.meta.url))).pack;assert.deepEqual(decoded,expected);
});
