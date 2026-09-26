import * as T from 'three';
import {buildBuggy} from './buggy.mjs';
import {hull} from './convex.mjs';
const v=p=>new T.Vector3(...p),Z=new T.Vector3(0,0,1);
const pose=(c,rot=[0,0,0])=>new T.Matrix4().compose(v(c),new T.Quaternion().setFromEuler(new T.Euler(...rot.map(T.MathUtils.degToRad),'ZYX')),new T.Vector3(1,1,1));
export class Solid{
 constructor(pieces,matrix=new T.Matrix4(),source='convex',primitive=null){Object.assign(this,{pieces,matrix,source,primitive})}
 transform(elements){return new Solid(this.pieces,new T.Matrix4().fromArray(elements).multiply(this.matrix),this.source,this.primitive)}
 rotate(rot){return new Solid(this.pieces,pose([0,0,0],rot).multiply(this.matrix),this.source,this.primitive)}
 translate(c){return new Solid(this.pieces,new T.Matrix4().makeTranslation(...c).multiply(this.matrix),this.source,this.primitive)}
 delete(){}
}
/** Coarse primitives are authored directly from recipe dimensions, independently
 * of render triangles. Ring sectors and spring sections retain their openings. */
export class ColliderPrimitives{
 constructor(options={}){this.segments=options.segments??12;this.ringSegments=options.ringSegments??16;this.springSegments=options.springSegments??80}
 begin(){this.parts=[]}
 cube=(size,c,rot=[0,0,0],radius=0)=>{
  radius=0;
  const h=size.map(x=>x/2),r=Math.min(radius,...h.map(x=>x*.45)),points=[];
  for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){if(!radius)points.push([x*h[0],y*h[1],z*h[2]]);else for(let k=0;k<3;k++)points.push([x*(h[0]-(k===0?0:r)),y*(h[1]-(k===1?0:r)),z*(h[2]-(k===2?0:r))])}
  return new Solid([points],pose(c,rot),radius?'beveled-box':'box',{type:'cuboid',halfExtents:h});
 };
 poly=points=>new Solid([points]);
 cyl=(radius,length,c,rot=[90,0,0],n=32)=>{
  const points=[],count=Math.min(n,this.segments);for(const z of [-length/2,length/2])for(let k=0;k<count;k++){const a=k*Math.PI*2/count;points.push([radius*Math.cos(a),radius*Math.sin(a),z])}return new Solid([points],pose(c,rot),'cylinder',{type:'cylinder',radius,halfHeight:length/2});
 };
 ring=(outer,inner,length,c,rot=[0,90,0])=>{
  const pieces=[];for(let i=0;i<this.ringSegments;i++){const points=[];for(const k of [i,i+1])for(const r of [inner,outer])for(const z of [-length/2,length/2]){const a=k*Math.PI*2/this.ringSegments;points.push([r*Math.cos(a),r*Math.sin(a),z])}pieces.push(points)}return new Solid(pieces,pose(c,rot),'ring');
 };
 beam=(a,b,radius=.026)=>{
  const A=v(a),B=v(b),d=B.clone().sub(A),solid=this.cyl(radius,d.length(),[0,0,0],[0,0,0]);
  solid.matrix=new T.Matrix4().compose(A.add(B).multiplyScalar(.5),new T.Quaternion().setFromUnitVectors(Z,d.normalize()),new T.Vector3(1,1,1));return solid;
 };
 sphere(radius){const g=new T.IcosahedronGeometry(radius,1),points=[];for(let i=0;i<g.attributes.position.count;i++)points.push([g.attributes.position.getX(i),g.attributes.position.getY(i),g.attributes.position.getZ(i)]);g.dispose();return new Solid([points],undefined,'sphere')}
 revolve(profile){
  const pieces=[];for(let i=0;i<this.ringSegments;i++){const points=[];for(const k of [i,i+1])for(const [r,z]of profile){const a=k*Math.PI*2/this.ringSegments;points.push([r*Math.cos(a),r*Math.sin(a),z])}pieces.push(points)}return new Solid(pieces,undefined,'tire');
 }
 spring(top,bottom){
  const delta=v(bottom).sub(v(top)),length=delta.length(),orientation=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize()),points=[];
  for(let k=0;k<=240;k++){const t=k/240,a=t*Math.PI*20;points.push(new T.Vector3(Math.cos(a)*.059,t*length*.68,Math.sin(a)*.059))}
  const g=new T.TubeGeometry(new T.CatmullRomCurve3(points),this.springSegments,.009,6,false),position=g.attributes.position,pieces=[];
  for(let i=0;i<this.springSegments;i++){const points=[];for(const ring of [i,i+1])for(let j=0;j<6;j++){const index=ring*7+j;points.push([position.getX(index),position.getY(index),position.getZ(index)])}pieces.push(points)}g.dispose();
  return new Solid(pieces,new T.Matrix4().compose(v(top),orientation,new T.Vector3(1,1,1)),'spring');
 }
 add(name,system,material,solid,motion=null,functionality=null){
  const id=`${system.toLowerCase()}-${String(this.parts.length).padStart(4,'0')}`,pieces=solid.pieces.map(points=>hull(points.map(p=>v(p).applyMatrix4(solid.matrix).toArray()))).filter(Boolean);
  let primitive=null;if(solid.primitive){const position=new T.Vector3(),rotation=new T.Quaternion(),scale=new T.Vector3();solid.matrix.decompose(position,rotation,scale);if(solid.primitive.type==='cylinder')rotation.multiply(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),Z));primitive={...solid.primitive,position:position.toArray(),rotation:rotation.toArray()};}this.parts.push({id,name,system,material,motion,functionality,source:solid.source,pieces,primitive});return id;
 }
 finish(parameters){return {parameters,parts:this.parts}}
 build(parameters){return buildBuggy(null,parameters,undefined,false,{live:this})}
}
