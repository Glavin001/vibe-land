/** Server asset worker. One JSON request on stdin, one JSON result on stdout.
 * The browser and this worker import the same generators and configuration rules.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Module from 'manifold-3d';
import { normalizeConfiguration, geometryKey, sourceToActorPoint, resolveDrivingSetup } from './configuration.mjs';
import { buildBuggy } from './dune/buggy.mjs';
import { visualOwners, simplePhysicsShape } from './simple-physics.mjs';
import { physicsBundle } from './dune/physics-export.mjs';
import { validateVehicleAssembly, preparationIssue } from './validation.mjs';
import { requireConnectedAssembly, STRENGTH_PROFILE_VERSION } from './strength-profile.mjs';
import { meshMassProperties, massPropertiesToActor, combineMassProperties } from './mass-properties.mjs';
import { encodeModel } from './dune/model-codec.mjs';

let submittedConfiguration;
async function main() {
const input=[];
for await (const chunk of process.stdin) input.push(chunk);
const request = JSON.parse(Buffer.concat(input).toString('utf8'));
submittedConfiguration = request.configuration;
const configuration = normalizeConfiguration(request.configuration);
const root = resolve(process.argv[2]);
const geometryHash = createHash('sha256').update(JSON.stringify({recipe:'vehicle-physics-functional-1',strength:STRENGTH_PROFILE_VERSION,geometry:geometryKey(configuration)})).digest('hex');
const directory = join(root, geometryHash);
let metadata;
try { metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')); }
catch (error) {
 if (error.code !== 'ENOENT') throw error;
 const progress = (phase, percent) => process.stderr.write(`${percent}% ${phase}\n`);
 const { geometry, collision, surfaces, bonds } = await validateVehicleAssembly(configuration, progress);
 const wasm = await Module(); wasm.setup();
 const visual = buildBuggy(wasm, geometry.parameters, progress);
 const bundle = physicsBundle(collision, visual);
 visualOwners(bundle.parts, visual.parts);
 const visuals = new Map(visual.parts.map(p => [p.id, p]));
 const massProperties = new Map(visual.parts.map(part => [part.id,
   massPropertiesToActor(meshMassProperties(part.position, part.indices, part.mass), geometry.originHeight)]));
 const parts = bundle.parts.map(part => ({
   id: part.id, visualIds: part.visualIds, name: part.name, system: part.system, material: part.material, motion: part.motion, functionality: part.functionality, sourcePartIds: part.sourcePartIds,
   // Collision proxies have larger volumes than the rendered solids. Inertia
   // and gravitational load must use the actual authored material mass.
   mass: part.visualIds.reduce((n,id)=>n+visuals.get(id).mass,0),
   volume: part.visualIds.reduce((n,id)=>n+visuals.get(id).volume,0),
   massProperties: combineMassProperties(part.visualIds.map(id=>massProperties.get(id))),
   collisionVolume: part.volumeM3,
   position: sourceToActorPoint(part.position, geometry.originHeight),
   shapes: part.shapes.map(simplePhysicsShape),
 }));
 requireConnectedAssembly(parts, bonds);
 const bounds = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
 // The driving body excludes rig-moved shapes; those have their own bindings.
 for (const part of parts.filter(p => !p.motion)) for (const shape of part.shapes) for (const v of shape.vertices) {
   for (let i=0;i<3;i++) { const x=part.position[i]+shape.position[i]+v[i];bounds.min[i]=Math.min(bounds.min[i],x);bounds.max[i]=Math.max(bounds.max[i],x); }
 }
 metadata = { version: 1, geometryHash, model: configuration.model, dimensions: configuration.dimensions,
   originHeight: geometry.originHeight, wheelCenters: geometry.wheelCenters,
   suspensionTravel: geometry.suspensionTravel, neutralJounce: geometry.neutralJounce,
   suspensionAttachmentY: geometry.suspensionAttachmentY, wheelHalfWidth: geometry.wheelHalfWidth,
   maxSteerRadians: geometry.maxSteerRadians, partCount: parts.length,
   visualPartCount: visual.parts.length, colliderFidelity: 'simple',
   cylinderSegments: 32, jointSurfaceSource: 'individual-authored-interfaces',
   shapeCount: parts.reduce((n,p)=>n+p.shapes.length,0), bondCount: bonds.length, contactCount: surfaces.length,
   strengthProfileVersion: STRENGTH_PROFILE_VERSION, strengthQualification: 'pending-native-tests',
   mass: parts.reduce((n,p)=>n+p.mass,0), bounds,
   massProperties: combineMassProperties(parts.map(p=>p.massProperties)),
   rig: geometry.rig, parts, bonds: bonds.map(b => ({...b,anchor:sourceToActorPoint(b.anchor,geometry.originHeight),centroid:sourceToActorPoint(b.centroid,geometry.originHeight),normal:b.normal?sourceToActorPoint(b.normal):null})),
   unresolvedContactCount: surfaces.filter(b => !b.validatedSurface).length,
   validation: { ...collision.report, buildMs: undefined },
 };
 const staging = directory + '.' + randomUUID();
 await mkdir(root, { recursive: true }); await mkdir(staging);
 try {
   await writeFile(join(staging, 'model.bin'), encodeModel(visual));
   await writeFile(join(staging, 'physics.json'), JSON.stringify(bundle));
   await writeFile(join(staging, 'metadata.json'), JSON.stringify(metadata));
   await rename(staging, directory);
 } catch(error) { await rm(staging, {recursive:true,force:true});throw error; }
}
requireConnectedAssembly(metadata.parts, metadata.bonds);
const driving = resolveDrivingSetup(configuration, metadata.mass);
const assetHash = createHash('sha256').update(JSON.stringify({configuration,geometryHash,driving})).digest('hex');
process.stdout.write(JSON.stringify({ configuration, assetHash, geometryHash, driving,
  partCount: metadata.partCount, shapeCount: metadata.shapeCount, bondCount: metadata.bondCount }));

}
main().catch(error => {
 process.stderr.write(`${error.stack ?? error}\n`);
 process.stdout.write(JSON.stringify({error: preparationIssue(error, submittedConfiguration)}));
 process.exitCode = 1;
});
