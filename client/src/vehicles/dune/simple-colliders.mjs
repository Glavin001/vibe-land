import {tireWidthScale} from './vehicle-catalog.mjs';
import * as T from 'three';
import {ColliderPrimitives} from './collider-primitives.mjs';
import {hull} from './convex.mjs';
const vec=p=>new T.Vector3(...p);
/** A circumscribed polygon protects the true cylinder during contact cutting.
 * The exported primitive stays analytic; the polygon is its conservative audit
 * envelope and its inspection mesh, never a trimesh collision shape. */
function cylinder(radius,halfHeight,position,rotation){
 const n=64,r=radius/Math.cos(Math.PI/n)+1e-7,q=new T.Quaternion(...rotation),c=vec(position),points=[];
 for(const y of [-halfHeight,halfHeight])for(let i=0;i<n;i++){const a=(i+.5)*2*Math.PI/n;points.push(new T.Vector3(r*Math.cos(a),y,r*Math.sin(a)).applyQuaternion(q).add(c).toArray())}
 return {pieces:[hull(points)],primitive:{type:'cylinder',radius,halfHeight,position,rotation},protectedPrimitive:true,source:'cylinder'};
}
class SimpleRecipe extends ColliderPrimitives{
 ring=(outer,inner,length,c,rot=[0,90,0])=>this.cyl(outer,length,c,rot);
 revolve(profile){return this.cyl(Math.max(...profile.map(p=>p[0])),Math.max(...profile.map(p=>p[1]))-Math.min(...profile.map(p=>p[1])),[0,0,0],[0,0,0])}
 spring(top,bottom){const d=vec(bottom).sub(vec(top)),L=d.length(),axis=d.normalize(),start=vec(top).addScaledVector(axis,-.009),end=vec(top).addScaledVector(axis,L*.68+.012);return this.beam(start.toArray(),end.toArray(),.071)}
}
function center(part){const points=part.pieces.flatMap(s=>s.vertices);return [0,1,2].map(k=>(Math.min(...points.map(v=>v[k]))+Math.max(...points.map(v=>v[k])))/2)}
export function simpleRecipe(parameters){
 const raw=new SimpleRecipe({segments:8,ringSegments:8,springSegments:8}).build(parameters),groups=new Map(),owner=new Map();
 const create=(id,parts,shape,name)=>{const root=raw.parts.find(p=>p.id===id);const g={...root,...shape,name:name??root.name,visualIds:parts.flatMap(p=>p.visualIds??[p.id])};groups.set(id,g);for(const p of parts)owner.set(p.id,id);return g};
 const combine=(parts,name)=>{if(!parts.length)return;return create(parts[0].id,parts,{pieces:[hull(parts.flatMap(p=>p.pieces.flatMap(s=>s.vertices)))],primitive:null},name)};
 for(const label of ['Front left','Front right','Rear left','Rear right']){
  const wheel=raw.parts.filter(p=>p.name.startsWith(label+' ')&&p.system==='Wheels'&&!/ hub$| brake rotor$| brake caliper$/.test(p.name));
  const x=(label.endsWith('left')?-1:1)*raw.parameters.track/2,y=raw.parameters.tireRadius,z=(label.startsWith('Front')?-1:1)*raw.parameters.wheelbase/2;
  const points=wheel.flatMap(p=>p.pieces.flatMap(s=>s.vertices));
  const lo=x-.183*tireWidthScale(raw.parameters),hi=x+.183*tireWidthScale(raw.parameters),radius=Math.max(...points.map(v=>Math.hypot(v[1]-y,v[2]-z)));
  create(wheel.find(p=>p.name.endsWith('tire carcass')).id,wheel,cylinder(radius,(hi-lo)/2,[(lo+hi)/2,y,z],new T.Quaternion().setFromUnitVectors(vec([0,1,0]),vec([1,0,0])).toArray()),label+' wheel assembly');
  const spring=raw.parts.find(p=>p.name===label+' coil spring'),coil=raw.parts.filter(p=>p.name.startsWith(label+' ')&&/coil spring|damper body|spring seat/.test(p.name));
  const sp=spring.primitive,axis=vec([0,1,0]).applyQuaternion(new T.Quaternion(...sp.rotation));
  const radialX=Math.sqrt(1-axis.x*axis.x),inner=Math.abs(x)-.183*tireWidthScale(raw.parameters),maxCenterX=Math.abs(sp.position[0])+Math.abs(axis.x)*sp.halfHeight;
  const radiusLimit=((inner-maxCenterX-2e-6)/radialX-1e-7)*Math.cos(Math.PI/64),springRadius=Math.min(sp.radius,radiusLimit);
  if(springRadius<.039)throw Error('Spring clearance is too small for the simple collision model');
  create(spring.id,coil,cylinder(springRadius,sp.halfHeight,sp.position,sp.rotation),label+' spring and damper');
  combine(raw.parts.filter(p=>p.name.startsWith(label+' CV boot rib')),label+' CV boot');
 }
 for(const label of ['Trailer left','Trailer right']){
  const wheel=raw.parts.filter(p=>p.system==='Wheels'&&p.name.startsWith(label+' '));if(!wheel.length)continue;
  const tire=wheel.find(p=>p.name===label+' tire'),c=tire.primitive.position,points=wheel.flatMap(p=>p.pieces.flatMap(s=>s.vertices));
  const radius=Math.max(...points.map(v=>Math.hypot(v[1]-c[1],v[2]-c[2]))),halfHeight=Math.max(...points.map(v=>Math.abs(v[0]-c[0])));
  create(tire.id,wheel,cylinder(radius,halfHeight,c,new T.Quaternion().setFromUnitVectors(vec([0,1,0]),vec([1,0,0])).toArray()),label+' wheel assembly');
 }
 const steer=raw.parts.filter(p=>/^Steering wheel|^Steering center$/.test(p.name)),grip=steer[0],sp=grip.primitive;
 create(grip.id,steer,cylinder(.18,.035,sp.position,sp.rotation),'Steering wheel assembly');
 combine(raw.parts.filter(p=>/^Engine crankcase|^Cylinder barrel|^Cooling fin|^Cylinder head|^Valve cover/.test(p.name)),'Engine core');
 const bundleNearest=(pattern,targetPattern)=>{
  const targets=raw.parts.filter(p=>targetPattern.test(p.name)&&!owner.has(p.id));
  for(const target of targets){const tc=center(target),details=raw.parts.filter(p=>pattern.test(p.name)&&!owner.has(p.id)&&targets.every(other=>{const pc=center(p);return vec(pc).distanceToSquared(vec(tc))<=vec(pc).distanceToSquared(vec(center(other)))}));combine([target,...details]);}
 };
 bundleNearest(/^Filter pleat$/,/^Air filter$/);
 bundleNearest(/^Tank strap$|^Fuel cap$/,/^Fuel tank$/);
 bundleNearest(/^Hood accent stripe$|^Hood fastener$/,/^Nose panel$/);
 bundleNearest(/^Instrument bezel$|^Gauge face$|^Gauge needle$|^Dashboard toggle$|^Dashboard cross support$/,/^Dashboard$/);
 bundleNearest(/^Seat base side bolster$|^Lap harness$|^Harness buckle$/,/^Seat pan$/);
 bundleNearest(/^Seat shoulder bolster$|^Shoulder harness$/,/^Seat back$/);
 bundleNearest(/^Headlight lens$/,/^Headlight housing$/);
 bundleNearest(/^Mirror glass$/,/^Mirror housing$/);
 bundleNearest(/^Rear lamp lens$/,/^Rear lamp mount$/);
 bundleNearest(/^Extinguisher neck$|^Extinguisher handle$/,/^Fire extinguisher$/);
 for(const p of raw.parts)if(!owner.has(p.id))create(p.id,[p],{});
 return {...raw,visualPartCount:raw.parts.length,parts:[...groups.values()]};
}

/** Recover native boxes from axis-orthogonal convex fragments after clipping. */
export function promoteBox(shape){
 if(shape.type!=='convex'||shape.vertices.length!==8||shape.faces.length!==6)return shape;
 const neighbors=new Set();for(const face of shape.faces){const i=face.indexOf(0);if(i>=0){neighbors.add(face[(i+1)%face.length]);neighbors.add(face[(i+face.length-1)%face.length])}}
 if(neighbors.size!==3)return shape;
 const first=vec(shape.vertices[0]),axes=[...neighbors].map(i=>vec(shape.vertices[i]).sub(first)),lengths=axes.map(a=>a.length());if(lengths.some(l=>l<1e-6))return shape;
 axes.forEach(a=>a.normalize());if(axes.some((a,i)=>axes.some((b,j)=>i!==j&&Math.abs(a.dot(b))>1e-6)))return shape;
 for(const v of shape.vertices){const d=vec(v).sub(first);for(let k=0;k<3;k++)if(Math.min(Math.abs(d.dot(axes[k])),Math.abs(d.dot(axes[k])-lengths[k]))>2e-7)return shape;}
 const center=shape.vertices.reduce((c,p)=>c.add(vec(p)),new T.Vector3()).multiplyScalar(1/8);
 if(axes[0].clone().cross(axes[1]).dot(axes[2])<0)axes[2].negate();const matrix=new T.Matrix4().makeBasis(...axes),rotation=new T.Quaternion().setFromRotationMatrix(matrix).normalize().toArray();
 return {...shape,type:'cuboid',position:shape.position.map((v,k)=>Math.fround(v+center.getComponent(k))),rotation,halfExtents:lengths.map(l=>l/2),vertices:shape.vertices.map(v=>v.map((x,k)=>Math.fround(x-center.getComponent(k))))};
}
