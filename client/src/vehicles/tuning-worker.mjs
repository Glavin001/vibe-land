// Long-lived scalar-only worker. Reuses the browser's validation and physical
// math; never builds meshes, audits contacts, cooks hulls or touches asset files.
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {normalizeConfiguration, resolveDrivingSetup} from './configuration.mjs';

for await (const line of createInterface({input:process.stdin})) {
  try {
    const request=JSON.parse(line);
    const configuration=normalizeConfiguration({...request.configuration,driving:request.driving});
    const driving=resolveDrivingSetup(configuration,request.mass);
    const geometryHash=request.geometryHash;
    const assetHash=createHash('sha256').update(JSON.stringify({configuration,geometryHash,driving})).digest('hex');
    process.stdout.write(JSON.stringify({configuration,driving,assetHash})+'\n');
  } catch(error) {
    process.stdout.write(JSON.stringify({error:error instanceof Error?error.message:String(error)})+'\n');
  }
}
