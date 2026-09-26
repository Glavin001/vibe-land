import {it,expect,describe,beforeAll} from 'vitest';
import {BoxGeometry,Matrix4,Quaternion,Vector3} from 'three';
import Module from 'manifold-3d';
// @ts-expect-error Server worker module is dependency-free JS.
import {meshMassProperties,combineMassProperties,massPropertiesToActor,transformMassProperties} from './mass-properties.mjs';
// @ts-expect-error Shared geometry authoring module.
import {buildBuggy} from './dune/buggy.mjs';
import {defaultConfiguration,modelParameters} from './configuration.mjs';
function box(size:number[],center=[0,0,0],angle=0) {
 const g=new BoxGeometry(...size as [number,number,number]);g.rotateZ(angle);g.translate(...center as [number,number,number]);
 const result={positions:g.attributes.position.array,indices:g.index!.array};g.dispose();return result;
}
function properties(size:number[],mass:number,center=[0,0,0],angle=0){const b=box(size,center,angle);return meshMassProperties(b.positions,b.indices,mass);}
it('matches an analytic cuboid away from the origin',()=>{
 const p=properties([2,4,6],12,[100,-30,42]);expect(p.volume).toBeCloseTo(48,8);expect(p.center).toEqual([100,-30,42]);
 [52,40,20].forEach((v,i)=>expect(p.inertia[i][i]).toBeCloseTo(v,8));expect(p.inertia[0][1]).toBeCloseTo(0,8);
});
it('retains products of inertia for a rotated part',()=>{
 const p=properties([2,4,6],12,[3,2,-1],Math.PI/4);
 expect(p.inertia[0][0]).toBeCloseTo(46,4);expect(p.inertia[1][1]).toBeCloseTo(46,4);expect(p.inertia[0][1]).toBeCloseTo(6,4);
});
it('subtracts cavities and combines parts with the parallel-axis theorem',()=>{
 const outer=box([4,4,4]),inner=box([2,2,2]);const positions=[...outer.positions,...inner.positions],indices=[...outer.indices];
 for(let i=0;i<inner.indices.length;i+=3)indices.push(...[2,1,0].map(k=>inner.indices[i+k]+outer.positions.length/3));
 const shell=meshMassProperties(positions,indices,56);expect(shell.volume).toBeCloseTo(56,8);expect(shell.inertia[0][0]).toBeCloseTo(496/3,7);
 const combined=combineMassProperties([properties([2,2,2],3,[-2,0,0]),properties([2,2,2],3,[2,0,0])]);
 combined.center.forEach((v:number)=>expect(v).toBeCloseTo(0,10));expect(combined.mass).toBe(6);expect(combined.inertia[0][0]).toBeCloseTo(4,8);expect(combined.inertia[1][1]).toBeCloseTo(28,8);
});
it('transforms COM and tensor into the collider actor frame',()=>{
 const p={mass:2,volume:1,center:[2,3,4],inertia:[[4,1,2],[1,5,3],[2,3,6]]};const actor=massPropertiesToActor(p,.65);
 expect(actor.center).toEqual([-2,2.35,-4]);expect(actor.inertia).toEqual([[4,-1,2],[-1,5,-3],[2,-3,6]]);
});
it('rejects invalid data instead of inventing mass',()=>{
 expect(()=>meshMassProperties([0,0,0],[0,0,0],1)).toThrow();expect(()=>meshMassProperties([0,0,0],[0,1,2],1)).toThrow();expect(()=>properties([1,1,1],NaN)).toThrow();
});

type Mesh={name:string;position:ArrayLike<number>;indices:ArrayLike<number>;mass:number};
const linearOf=(m:Matrix4)=>{const e=m.elements;return [[e[0],e[4],e[8]],[e[1],e[5],e[9]],[e[2],e[6],e[10]]];};
const moved=(part:Mesh,m:Matrix4)=>{const out:number[]=[],p=new Vector3();for(let i=0;i<part.position.length;i+=3){p.set(part.position[i],part.position[i+1],part.position[i+2]).applyMatrix4(m);out.push(p.x,p.y,p.z);}return out;};
/** Compare the tensor map with an independent integration of the moved mesh. */
function expectMatchesIntegratedMesh(part:Mesh,m:Matrix4) {
 const predicted=transformMassProperties(meshMassProperties(part.position,part.indices,part.mass),linearOf(m),[m.elements[12],m.elements[13],m.elements[14]]);
 const measured=meshMassProperties(moved(part,m),part.indices,part.mass);
 const scale=Math.hypot(...measured.inertia.flat());
 expect(predicted.mass).toBe(part.mass);
 expect(Math.abs(predicted.volume-measured.volume)/measured.volume,part.name).toBeLessThan(1e-9);
 expect(Math.hypot(...predicted.center.map((v:number,i:number)=>v-measured.center[i])),part.name).toBeLessThan(1e-9);
 expect(Math.hypot(...predicted.inertia.flat().map((v:number,i:number)=>v-measured.inertia.flat()[i]))/scale,part.name).toBeLessThan(1e-9);
}
describe('mass-preserving pose transforms of prepared suspension solids',()=>{
 let parts:Mesh[]=[];
 beforeAll(async()=>{
  const wasm=await Module();wasm.setup();
  const model=buildBuggy(wasm,modelParameters(defaultConfiguration()),()=>{},false,{preview:true});
  parts=['lowerArm','upperArm','upright','piston','spring','hub','knuckle','wheel','cvBoot'].map(role=>model.parts.find((p:any)=>p.motion?.corner==='fl'&&p.motion.role===role));
  expect(parts.every(Boolean)).toBe(true);
 });
 it('matches integrated meshes under rigid rotation and translation',()=>{
  const m=new Matrix4().compose(new Vector3(.31,-.12,.8),new Quaternion().setFromAxisAngle(new Vector3(.3,-.8,.52).normalize(),1.1),new Vector3(1,1,1));
  for(const part of parts)expectMatchesIntegratedMesh(part,m);
 });
 it('conserves mass while a part compresses or extends along its own axis',()=>{
  for(const part of parts)for(const s of [.7,.93,1.3]){
   const c=meshMassProperties(part.position,part.indices,part.mass).center;
   const q=new Quaternion().setFromUnitVectors(new Vector3(0,0,1),new Vector3(.2,-.9,.35).normalize());
   const m=new Matrix4().makeTranslation(c[0],c[1],c[2]).multiply(new Matrix4().makeRotationFromQuaternion(q)).multiply(new Matrix4().makeScale(1,1,s))
    .multiply(new Matrix4().makeRotationFromQuaternion(q.clone().invert())).multiply(new Matrix4().makeTranslation(-c[0],-c[1],-c[2]));
   expectMatchesIntegratedMesh(part,m);
  }
 });
 it('is exact for a general sheared affine map',()=>{
  const m=new Matrix4().set(1.1,.2,-.1,.4, .05,.9,.3,-.2, -.15,.1,1.2,.7, 0,0,0,1);
  for(const part of parts)expectMatchesIntegratedMesh(part,m);
 });
 it('reproduces the fixed source-to-actor half-turn',()=>{
  const source=meshMassProperties(parts[0].position,parts[0].indices,parts[0].mass);
  const expected=massPropertiesToActor(source,.65),actual=transformMassProperties(source,[[-1,0,0],[0,1,0],[0,0,-1]],[0,-.65,0]);
  actual.center.forEach((v:number,i:number)=>expect(v).toBeCloseTo(expected.center[i],12));
  actual.inertia.flat().forEach((v:number,i:number)=>expect(v).toBeCloseTo(expected.inertia.flat()[i],12));
 });
 it('rejects reflections, degenerate maps and non-finite input',()=>{
  const p=meshMassProperties(parts[0].position,parts[0].indices,parts[0].mass),I=[[1,0,0],[0,1,0],[0,0,1]];
  expect(()=>transformMassProperties(p,[[-1,0,0],[0,1,0],[0,0,1]],[0,0,0])).toThrow();
  expect(()=>transformMassProperties(p,[[1,0,0],[0,1,0],[0,0,0]],[0,0,0])).toThrow();
  expect(()=>transformMassProperties(p,I,[0,NaN,0])).toThrow();
  expect(()=>transformMassProperties({...p,mass:0},I,[0,0,0])).toThrow();
 });
});
