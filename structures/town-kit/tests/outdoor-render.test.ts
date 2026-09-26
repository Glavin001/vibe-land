import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {OutdoorAttachments,type OutdoorVisuals} from '../preview/outdoorAttachments';
import {canonicalHull} from '../preview/hullReuse';
const triangle={positions:[0,0,0,1,0,0,0,1,0],normals:[0,0,1,0,0,1,0,0,1],uvs:[0,0,1,0,0,1],indices:[0,1,2],material:{color:'#ffffff'}};
const data=():OutdoorVisuals=>({version:1,physicsSha256:'fixture',meshes:{near:triangle,mid:triangle,far:triangle},attachments:[0,1].map(owner=>({owner,matrix:new THREE.Matrix4().makeTranslation(0,2,0).toArray(),levels:[{distance:0,meshes:['near']},{distance:35,meshes:['mid']},{distance:85,meshes:['far']}]}))});
test('foliage follows only its owning chunk through translation, rotation and detail changes',async()=>{
 const scene=new THREE.Scene(),layer=new OutdoorAttachments(scene),camera=new THREE.PerspectiveCamera();await layer.load(data(),'fixture',2);
 layer.setPose(0,[0,0,0,0,0,0,1]);layer.setPose(1,[8,0,0,0,0,0,1]);layer.update(camera,0,0);
 const meshes=scene.children.filter(x=>x instanceof THREE.InstancedMesh) as THREE.InstancedMesh[],matrix=new THREE.Matrix4();assert.equal(meshes.length,3);
 const position=(mesh:THREE.InstancedMesh,index:number)=>{mesh.getMatrixAt(index,matrix);return new THREE.Vector3().setFromMatrixPosition(matrix).toArray();};
 assert.deepEqual(position(meshes[0],0),[0,2,0]);assert.deepEqual(position(meshes[0],1),[8,2,0]);
 const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2);layer.setPose(0,[5,1,3,...q.toArray()]);layer.update(camera,1,1);
 assert.deepEqual(position(meshes[0],0).map(x=>Math.round(x*1e5)/1e5),[3,1,3]);assert.deepEqual(position(meshes[0],1),[8,2,0]);
 const bounds=new THREE.Box3();layer.expandBounds(bounds);assert(bounds.distanceToPoint(new THREE.Vector3(3,1,3))<1e-6);assert(bounds.distanceToPoint(new THREE.Vector3(8,2,0))<1e-6);
 camera.position.set(0,0,150);layer.update(camera,2,2);assert.deepEqual(layer.stats().lods,[0,0,2]);assert.equal(meshes[0].count,0);assert.equal(meshes[2].count,2);
 assert.deepEqual(position(meshes[2],0).map(x=>Math.round(x*1e5)/1e5),[3,1,3]);
 for(let i=0;i<40;i++)layer.broken(0,2);assert(layer.stats().activeParticles<=256);layer.update(camera,5,5);assert.equal(layer.stats().activeParticles,0);
 layer.dispose();assert.equal(scene.children.length,0);
});
test('a visual sidecar cannot be paired with a different physics revision',async()=>{
 const layer=new OutdoorAttachments(new THREE.Scene());await assert.rejects(layer.load(data(),'wrong',2),/different physics/);layer.dispose();
});
test('spatial batches share mesh buffers and refit culling bounds when a limb flies out of its cell',async()=>{
 const fixture=data();fixture.attachments[0].cell=[0,0];fixture.attachments[1].cell=[4,0];
 const scene=new THREE.Scene(),layer=new OutdoorAttachments(scene),camera=new THREE.PerspectiveCamera();
 await layer.load(fixture,'fixture',2);layer.setPose(0,[0,0,0,0,0,0,1]);layer.setPose(1,[130,0,0,0,0,0,1]);layer.update(camera,0,0);
 const active=()=>scene.children.filter((x):x is THREE.InstancedMesh=>x instanceof THREE.InstancedMesh&&x.count>0);
 assert.equal(layer.stats().meshBatches,6);assert.equal(layer.stats().uniqueGeometries,3);assert.equal(layer.stats().activeTriangles,2);
 assert(active().every(m=>m.frustumCulled));
 const original=active().find(m=>m.boundingSphere!.center.x<5)!;
 assert(original.boundingSphere!.containsPoint(new THREE.Vector3(0,2,0)));
 layer.setPose(0,[230,1,4,0,0,0,1]);layer.update(camera,1,1);
 assert.equal(original.count,0); // The detached crown also switches to far detail.
 const flying=active().find(m=>m.boundingSphere!.center.x>200)!;
 assert(flying.boundingSphere!.containsPoint(new THREE.Vector3(230,3,4)));
 assert.equal(active()[0].geometry,active()[1].geometry);
 layer.dispose();assert.equal(scene.children.length,0);
});
test('rotated hull instances reuse geometry and recover exact rest and damaged positions',()=>{
 const points=[-.3,0,.2,.6,.2,-.1,0,1,.4,.1,.3,.8],base=canonicalHull(points);
 const damaged=new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,.8,-.4));
 for(let t=0;t<4;t++){
  const yaw=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),t*Math.PI/2);
  const turned=Array.from({length:4},(_,i)=>new THREE.Vector3().fromArray(points,i*3).applyQuaternion(yaw).toArray().map(v=>Math.round(v*1e6)/1e6)).flat();
  const shape=canonicalHull(turned);assert.equal(shape.key,base.key);
  for(let i=0;i<shape.points.length;i+=3){
   const restored=new THREE.Vector3().fromArray(shape.points,i).applyQuaternion(shape.rotation);
   assert(Array.from({length:4},(_,j)=>new THREE.Vector3().fromArray(turned,j*3)).some(p=>p.distanceTo(restored)<1e-6));
   const actual=new THREE.Vector3().fromArray(shape.points,i).applyQuaternion(damaged.clone().multiply(shape.rotation));
   assert(actual.distanceTo(restored.applyQuaternion(damaged))<1e-6);
  }
 }
});
