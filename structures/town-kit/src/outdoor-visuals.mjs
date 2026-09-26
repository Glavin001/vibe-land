import * as THREE from '../../../client/node_modules/three/build/three.module.js';
import {createHash} from 'node:crypto';
export const assetHash=pack=>createHash('sha256').update(JSON.stringify(pack)).digest('hex');

/** Match composeScene's node ordering and quarter-turn/mirror convention. */
export function composeVisuals(placements,pack) {
 const meshes={},attachments=[];let offset=0;
 for(const {pack:source,visuals,yaw=0,mirror=false}of placements){
  if(visuals){
   const rotation=new THREE.Matrix4().makeRotationY(yaw*Math.PI/180).multiply(new THREE.Matrix4().makeScale(mirror?-1:1,1,1));
   for(const [id,mesh]of Object.entries(visuals.meshes)){
    if(meshes[id]&&JSON.stringify(meshes[id])!==JSON.stringify(mesh))throw Error(`Conflicting visual mesh ${id}`);
    meshes[id]=mesh;
   }
   for(const a of visuals.attachments){
    const local=a.matrix?new THREE.Matrix4().fromArray(a.matrix):new THREE.Matrix4().compose(new THREE.Vector3(...a.position),new THREE.Quaternion(...a.rotation),new THREE.Vector3().setScalar(a.scale));
    const owner=a.owner+offset,matrix=rotation.clone().multiply(local);
    const node=pack.scenario.nodes[owner].centroid;
    const anchor=new THREE.Vector3().setFromMatrixPosition(matrix).add(new THREE.Vector3(node.x,node.y,node.z));
    // Cull a street-sized group, rather than one forest-wide bounding sphere.
    // This is only a rendering partition; detached wood retains its owner.
    attachments.push({owner,matrix:matrix.toArray(),cell:[Math.floor(anchor.x/32),Math.floor(anchor.z/32)],levels:a.levels});
   }
  }
  offset+=source.scenario.nodes.length;
 }
 const result={version:1,physicsSha256:assetHash(pack),meshes,attachments};validateVisuals(result,pack);return result;
}

export function validateVisuals(visuals,pack) {
 if(visuals.version!==1||visuals.physicsSha256!==assetHash(pack))throw Error('Visual sidecar does not match the physics asset');
 for(const [id,m]of Object.entries(visuals.meshes)){
  if(!m.positions.length||m.positions.length%3||m.normals.length!==m.positions.length||m.uvs.length!==m.positions.length/3*2||m.indices.length%3)throw Error(`Invalid visual geometry ${id}`);
  if(![...m.positions,...m.normals,...m.uvs].every(Number.isFinite)||!m.indices.every(i=>Number.isInteger(i)&&i>=0&&i<m.positions.length/3))throw Error(`Invalid visual buffers ${id}`);
 }
 for(const a of visuals.attachments){
  if(!Number.isInteger(a.owner)||a.owner<0||a.owner>=pack.scenario.nodes.length||pack.scenario.nodes[a.owner].mass===0)throw Error('Invalid visual owner');
  if(a.matrix.length!==16||!a.matrix.every(Number.isFinite))throw Error('Invalid visual transform');
  if(a.cell&&(a.cell.length!==2||!a.cell.every(Number.isSafeInteger)))throw Error('Invalid visual cell');
  if(a.levels.length!==3||a.levels[0].distance!==0||a.levels.some((l,i)=>!Number.isFinite(l.distance)||(i>0&&l.distance<=a.levels[i-1].distance)||l.meshes.some(id=>!visuals.meshes[id])))throw Error('Invalid visual detail levels');
 }
 return true;
}
