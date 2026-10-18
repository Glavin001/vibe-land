// Offline geometry qualification; does not certify native driving/destruction.
// Usage: node scripts/verify-vehicle-assets.mjs /absolute/cache/directory
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defaultConfiguration, vehicles } from '../src/vehicles/configuration.mjs';
import { requireConnectedAssembly } from '../src/vehicles/strength-profile.mjs';
const cache=resolve(process.argv[2]??'../.cache/vehicle-assets');
const worker=fileURLToPath(new URL('../src/vehicles/prepare-asset.mjs',import.meta.url));
for(const model of vehicles.map(v=>v.id).concat('custom-buggy')) {
 const configuration=defaultConfiguration(model==='custom-buggy'?'buggy':model);
 if(model==='custom-buggy'){configuration.dimensions.wheelbase=2.8;configuration.finish='#e7ad21';}
 const asset=await new Promise((resolve,reject)=>{
  let output='';const child=spawn(process.execPath,[worker,cache],{stdio:['pipe','pipe','inherit']});
  child.stdout.on('data',v=>output+=v);child.on('error',reject);
  child.on('exit',code=>{try {assert.equal(code,0);resolve(JSON.parse(output));}catch(error){reject(error);}});
  child.stdin.end(JSON.stringify({configuration}));
 });
 const metadata=JSON.parse(await readFile(`${cache}/${asset.geometryHash}/metadata.json`,'utf8'));
 assert.equal(metadata.colliderFidelity,'simple');
 assert.equal(metadata.validation.penetratingPairs,0);
 assert.equal(metadata.validation.nativePrimitiveAudit.primitivePenetratingPairs,0);
 const ids=metadata.parts.flatMap(p=>p.visualIds);
 assert.equal(new Set(ids).size,metadata.visualPartCount);
 assert.equal(ids.length,metadata.visualPartCount);
 assert.ok(Math.abs(metadata.massProperties.mass-metadata.mass)<1e-8);
 requireConnectedAssembly(metadata.parts,metadata.bonds);
 assert.equal(metadata.parts[0].functionality,'chassis');
 assert.equal(metadata.parts.filter(p=>p.functionality==='engine').length,1);
 assert.equal(metadata.parts.filter(p=>p.motion?.role==='wheel').length,4);
 for(const part of metadata.parts) {
  for(const shape of part.shapes)assert.ok(shape.vertices.length<=64);
  if(part.motion?.role==='wheel'&&part.name.endsWith('wheel assembly')) {
   const tire=part.shapes.find(s=>s.type==='cylinder');
   assert.ok(tire);
   assert.equal(tire.vertices.length,64);
   assert.ok(part.sourcePartIds.length>=1);
  }
 }
 console.log(JSON.stringify({model,visuals:metadata.visualPartCount,groups:metadata.partCount,shapes:metadata.shapeCount,bonds:metadata.bondCount,geometryHash:asset.geometryHash}));
}
