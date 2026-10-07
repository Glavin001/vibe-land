import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../../client/node_modules/three/build/three.module.js';
import {ConvexGeometry} from '../../../client/node_modules/three/examples/jsm/geometries/ConvexGeometry.js';
import {buildVeneerHouse} from '../src/veneer-houses.mjs';

// A hull's volume centroid relative to its node centroid: where its mass is
// against where it is drawn from. PhysX centres each body on the former.
function massOffset(points){
 const pts=[];for(let j=0;j<points.length;j+=3)pts.push(new THREE.Vector3(points[j],points[j+1],points[j+2]));
 const g=new ConvexGeometry(pts),p=g.attributes.position;let volume=0;const centre=new THREE.Vector3();
 for(let k=0;k<p.count;k+=3){const a=new THREE.Vector3().fromBufferAttribute(p,k),b=new THREE.Vector3().fromBufferAttribute(p,k+1),c=new THREE.Vector3().fromBufferAttribute(p,k+2);const q=a.dot(b.clone().cross(c))/6;volume+=q;centre.addScaledVector(a.add(b).add(c),q/4);}
 g.dispose();return centre.divideScalar(volume).length();
}
const hulls=pack=>{const s=pack.scenario;return s.nodeColliders.map((r,i)=>[i,r.kind==='shape'?s.shapeLibrary[r.shape]:r]).filter(([,c])=>c.kind==='convex_hull');};
const world=(pack,i,c)=>{const o=pack.scenario.nodes[i].centroid;return Array.from({length:c.points.length/3},(_,j)=>[o.x+c.points[3*j],o.y+c.points[3*j+1],o.z+c.points[3*j+2]]);};

// The corner reference (the default) puts a veneer gable's mass metres from
// its centroid; TOWN_KIT_HULL_ORIGIN=centroid keeps it there, with every
// world-space vertex where it was.
test('TOWN_KIT_HULL_ORIGIN=centroid keeps hulls on their centres of mass, geometry unchanged',()=>{
 const corner=buildVeneerHouse({storeys:2}).pack;
 const before=process.env.TOWN_KIT_HULL_ORIGIN;process.env.TOWN_KIT_HULL_ORIGIN='centroid';
 let centred;try{centred=buildVeneerHouse({storeys:2}).pack;}finally{if(before===undefined)delete process.env.TOWN_KIT_HULL_ORIGIN;else process.env.TOWN_KIT_HULL_ORIGIN=before;}
 const a=hulls(corner),b=hulls(centred);assert.equal(a.length,b.length);assert(a.length>0);
 assert(Math.max(...a.map(([,c])=>massOffset(c.points)))>1,'the corner reference is off-centre by metres');
 assert(Math.max(...b.map(([,c])=>massOffset(c.points)))<1e-3,'centred hulls carry their mass at their centroid');
 for(let k=0;k<a.length;k++){
  const [i,ca]=a[k],[j,cb]=b[k];assert.equal(i,j);
  const wa=world(corner,i,ca),wb=world(centred,j,cb);
  for(let v=0;v<wa.length;v++)for(let x=0;x<3;x++)assert(Math.abs(wa[v][x]-wb[v][x])<1e-6,`node ${i} vertex ${v}`);
 }
 // Everything but the hull reference is identical.
 assert.deepEqual(centred.scenario.bonds,corner.scenario.bonds);
 assert.deepEqual(centred.scenario.nodes.map(n=>n.mass),corner.scenario.nodes.map(n=>n.mass));
});
