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
import { requireChunkMotion } from './dune/pose-deltas.mjs';
import { mergeLightChunks, MIN_CHUNK_KG } from './chunk-merge.mjs';
import { admitBonds, trueBondStiffness } from './bond-admission.mjs';
import { massBudget, budgetScales, bondScale, MASS_BUDGET_VERSION } from './mass-budget.mjs';
import { ROAD_WHEEL } from './reality.mjs';
import { realJointCapacitiesEnabled, applySectionBound, REAL_JOINT_CAPACITY_VERSION } from './real-joint-capacity.mjs';

let submittedConfiguration;
async function main() {
const input=[];
for await (const chunk of process.stdin) input.push(chunk);
const request = JSON.parse(Buffer.concat(input).toString('utf8'));
submittedConfiguration = request.configuration;
const configuration = normalizeConfiguration(request.configuration);
const root = resolve(process.argv[2]);
// A budgeted build's masses are part of its asset; unbudgeted builds keep
// their cached hashes (an absent key does not change the JSON).
const budget = massBudget(configuration.model);
// Under the bridge's true bond stiffness every measured contact is a bond
// (bond-admission.mjs); such an asset is a different asset.
const trueStiffness = trueBondStiffness();
// VIBE_REAL_CAPACITIES=1: each joint bounded by its members' sections
// (real-joint-capacity.mjs); such an asset is a different asset.
const realJoints = realJointCapacitiesEnabled();
const geometryHash = createHash('sha256').update(JSON.stringify({recipe:'vehicle-physics-interface-14',strength:STRENGTH_PROFILE_VERSION,geometry:geometryKey(configuration),...(budget&&{massBudget:{version:MASS_BUDGET_VERSION,...budget}}),...(trueStiffness&&{bondArea:'measured'}),...(realJoints&&{jointCapacity:REAL_JOINT_CAPACITY_VERSION})})).digest('hex');
const directory = join(root, geometryHash);
let metadata;
try { metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')); }
catch (error) {
 if (error.code !== 'ENOENT') throw error;
 const progress = (phase, percent) => process.stderr.write(`${percent}% ${phase}\n`);
 const { geometry, collision, surfaces, bonds, excludedContacts } = await validateVehicleAssembly(configuration, progress);
 const wasm = await Module(); wasm.setup();
 const visual = buildBuggy(wasm, geometry.parameters, progress);
 const bundle = physicsBundle(collision, visual);
 visualOwners(bundle.parts, visual.parts);
 const visuals = new Map(visual.parts.map(p => [p.id, p]));
 // Coplanar faces of simplified hulls miss curved and angled contacts (tube
 // nodes, panels on tubes), leaving 1e-8..1e-5 m² slivers. Use the exact shared
 // surface of the two solids where it is larger; a measured face is never shrunk
 // (a bolt's exact surface patch is smaller than its bearing face).
 const interfaceArea = new Map((visual.joints ?? []).map(j => [[j.a, j.b].sort().join('|'), j.interfaceAreaM2]));
 for (const bond of bonds) {
   const exact = interfaceArea.get([bond.visualA, bond.visualB].sort().join('|')) ?? 0;
   bond.colliderFaceAreaM2 = bond.area;
   bond.solidInterfaceAreaM2 = exact;
   if (exact > bond.area) { bond.area = exact; bond.areaSource = 'solid-interface'; } else bond.areaSource = 'collider-face';
 }
 // Which contacts are bonds, at what area: bond-admission.mjs.
 const { excluded, mounts: mountList } = admitBonds(bonds, { trueStiffness });
 const mounts = new Set(mountList);
 excludedContacts.push(...excluded.map(b => ({ a: b.visualA, b: b.visualB, reason: 'sub-solver-area-graze' })));
 if (mounts.size) process.stderr.write(`minimum mounts (geometry barely meets its mount): ${[...mounts].map(b => `${b.visualA}/${b.visualB}`).join(', ')}\n`);
 // Stress chunks lighter than MIN_CHUNK_KG join their best-bonded same-motion
 // neighbour (chunk-merge.mjs: light chunks on stiff bonds stall the solve).
 const chunkMass = part => (part.visualIds ?? [part.id]).reduce((n, id) => n + visuals.get(id).mass, 0);
 const chunkMerges = mergeLightChunks(bundle.parts, bonds, chunkMass, MIN_CHUNK_KG);
 if (chunkMerges.unmerged.length) process.stderr.write(`chunks under ${MIN_CHUNK_KG} kg with no same-motion neighbour: ${chunkMerges.unmerged.map(u => `${u.name} ${u.kg.toFixed(2)} kg`).join(', ')}\n`);
 // The build's mass budget (mass-budget.mjs), on the merged chunks: each
 // chunk's visual parts by its factor, each bond's area by the mass it joins.
 let massBudgetReport = null;
 if (budget) {
   const authored = new Map(bundle.parts.map(part => [part.id, chunkMass(part)]));
   const scales = budgetScales(bundle.parts, part => authored.get(part.id), budget);
   for (const bond of bonds) {
     bond.massScale = bondScale(bond, id => authored.get(id), id => scales.get(id));
     bond.area *= bond.massScale;
   }
   for (const part of bundle.parts) for (const id of part.visualIds) visuals.get(id).mass *= scales.get(part.id);
   const wheel = bundle.parts.find(p => ROAD_WHEEL.test(p.name)), rest = bundle.parts.find(p => !ROAD_WHEEL.test(p.name));
   massBudgetReport = { version: MASS_BUDGET_VERSION, ...budget, authoredKg: [...authored.values()].reduce((n, m) => n + m, 0),
     authoredWheelKg: authored.get(wheel.id), wheelScale: scales.get(wheel.id), restScale: scales.get(rest.id) };
 }
 const massProperties = new Map(visual.parts.map(part => [part.id,
   massPropertiesToActor(meshMassProperties(part.position, part.indices, part.mass), geometry.originHeight)]));
 for (const part of bundle.parts) requireChunkMotion(part, part.visualIds.map(id => visuals.get(id).motion));
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
 if (realJoints) {
   const changed = applySectionBound(parts, bonds);
   process.stderr.write(`real joint capacities: ${changed.length} of ${bonds.length} joints bounded by their members' sections\n`);
 }
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
   jointTopology: 'rig-anchored-joints-3',
   excludedContacts: excludedContacts.map(({a,b,reason})=>({a,b,reason})),
   shapeCount: parts.reduce((n,p)=>n+p.shapes.length,0), bondCount: bonds.length, contactCount: surfaces.length,
   minChunkKg: MIN_CHUNK_KG, mergedChunks: chunkMerges.merged, unmergedLightChunks: chunkMerges.unmerged, massBudget: massBudgetReport,
   strengthProfileVersion: STRENGTH_PROFILE_VERSION, strengthQualification: 'pending-native-tests',
   mass: parts.reduce((n,p)=>n+p.mass,0), bounds,
   massProperties: combineMassProperties(parts.map(p=>p.massProperties)),
   rig: geometry.rig, parts, bonds: bonds.map(b => ({...b,anchor:sourceToActorPoint(b.anchor,geometry.originHeight),centroid:sourceToActorPoint(b.centroid,geometry.originHeight),...(b.measuredCentroid&&{measuredCentroid:sourceToActorPoint(b.measuredCentroid,geometry.originHeight)}),normal:b.normal?sourceToActorPoint(b.normal):null})),
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
