import * as THREE from 'three';

/** Reuse exact hulls stamped at quarter turns, preserving every collider vertex. */
export function canonicalHull(points: number[]) {
 let best='',vertices:number[]=[],turn=0;
 for(let t=0;t<4;t++){
  const cloud=new Map<string,number[]>();
  for(let i=0;i<points.length;i+=3){
   const [x,y,z]=points.slice(i,i+3),p=t===0?[x,y,z]:t===1?[z,y,-x]:t===2?[-x,y,-z]:[-z,y,x];
   const clean=p.map(v=>v||0);cloud.set(JSON.stringify(clean),clean);
  }
  const keys=[...cloud.keys()].sort(),key=keys.join(';');
  if(!best||key<best){best=key;vertices=keys.flatMap(k=>cloud.get(k)!);turn=t;}
 }
 return {key:best,points:vertices,rotation:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-turn*Math.PI/2)};
}
