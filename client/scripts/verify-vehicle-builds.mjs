// Prepares real assemblies and exports inputs for the native GPU driving check.
// node scripts/verify-vehicle-builds.mjs /cache /tmp/vehicle-build-fixtures.json
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {garageBuilds} from '../src/vehicles/builds.mjs';
import {serializeConfiguration,resolveDrivingSetup} from '../src/vehicles/configuration.mjs';
const cache=resolve(process.argv[2]??'../.cache/vehicle-assets');
const worker=fileURLToPath(new URL('../src/vehicles/prepare-asset.mjs',import.meta.url));
const fixtures=[];
for(const {id,configuration} of garageBuilds.filter(b=>b.configuration.model!=='semi')) {
  const result=spawnSync(process.execPath,[worker,cache],{input:JSON.stringify({configuration}),encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,`${id}: ${result.stdout}\n${result.stderr}`);
  const vehicle=JSON.parse(result.stdout),metadataPath=resolve(cache,vehicle.geometryHash,'metadata.json');
  const metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
  assert.equal(serializeConfiguration(vehicle.configuration),serializeConfiguration(configuration));
  assert.deepEqual(vehicle.driving,resolveDrivingSetup(configuration,metadata.mass));
  assert.equal(metadata.colliderFidelity,'simple');
  fixtures.push({name:id,metadataPath,driving:vehicle.driving});
  console.log(`${id}: ${metadata.partCount} groups, ${vehicle.driving.rearWheelDrive?'RWD':'AWD'}, ${vehicle.driving.acceleration.toFixed(2)} m/s²`);
}
writeFileSync(resolve(process.argv[3]??'/tmp/vehicle-build-fixtures.json'),JSON.stringify(fixtures));
