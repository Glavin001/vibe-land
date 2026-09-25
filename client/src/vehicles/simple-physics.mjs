import { Quaternion, Vector3 } from 'three';
import { sourceToActorPoint } from './configuration.mjs';

/** Every detailed visual belongs to exactly one Simple collision group. */
export function visualOwners(parts, visuals) {
  const known=new Set(visuals.map(p=>p.id)), owners=new Map();
  for(const part of parts) for(const id of part.visualIds??[part.id]) {
    if(!known.has(id)||owners.has(id))throw Error(`Invalid collision ownership: ${id}`);
    owners.set(id,part.id);
  }
  if(owners.size!==known.size)throw Error('Simple colliders omit visual parts');
  return owners;
}

/** Retain measured material interfaces, discarding interfaces inside one group.
 * Several physical joints may connect the same two groups; do not merge away
 * their distinct locations, normals, areas or material strengths.
 */
export function groupJoints(joints,owners) {
  return joints.flatMap(joint=>{
    const a=owners.get(joint.a),b=owners.get(joint.b);
    if(!a||!b)throw Error('Joint references an unmapped visual');
    return a===b?[]:[{...joint,a,b,visualA:joint.a,visualB:joint.b}];
  });
}

/** PhysX GPU has no analytic cylinder. Use one inscribed 32-sided convex
 * (64 vertices), rather than the source's 128-vertex inspection envelope.
 * Radial approximation is <=0.482%; no tread geometry enters the solver.
 * Box and clipped convex inspection vertices already include local rotation.
 */
export function simplePhysicsShape(shape) {
  let vertices=shape.vertices;
  if(shape.type==='cylinder') {
    if(!(shape.radius>0&&shape.halfHeight>0))throw Error('Invalid cylinder');
    const q=new Quaternion(...shape.rotation);
    vertices=[];
    for(const y of [-shape.halfHeight,shape.halfHeight])for(let i=0;i<32;i++) {
      const angle=i*2*Math.PI/32;
      vertices.push(new Vector3(shape.radius*Math.cos(angle),y,shape.radius*Math.sin(angle)).applyQuaternion(q).toArray());
    }
  }
  if(vertices.length<4||vertices.length>64||!vertices.flat().every(Number.isFinite))throw Error('Simple shape exceeds GPU convex limits');
  return {type:shape.type,position:sourceToActorPoint(shape.position),vertices:vertices.map(v=>sourceToActorPoint(v))};
}
