/** Pass your initialized Rapier namespace and World. Connected bonds start as
 * compound rigid bodies; every collider retains its individual visual part ID.
 * On destruction, regroup the surviving bond graph and recreate affected bodies.
 * No triangle-mesh colliders or collision-group exclusions are used.
 */
export function createBuggyPhysics(RAPIER,world,bundle,{bodyType='dynamic',bodyGrouping='bonded',density=1000,translation=[0,0,0],unitsPerMeter=1}={}){
 if(!bundle||bundle.format!=='dune-buggy-physics')throw Error('Expected a dune-buggy-physics package');
 if(bundle.report.penetratingPairs||bundle.report.components!==1)throw Error('Physics package did not pass geometry validation');
 if(!['dynamic','fixed','kinematic'].includes(bodyType)||!['bonded','parts'].includes(bodyGrouping))throw Error('Unsupported body setup');
 if(!Number.isFinite(unitsPerMeter)||unitsPerMeter<=0)throw Error('unitsPerMeter must be positive');
 const byId=new Map(bundle.parts.map(p=>[p.id,p])),adjacent=new Map(bundle.parts.map(p=>[p.id,new Set()]));
 if(bodyGrouping==='bonded')for(const bond of bundle.bonds){adjacent.get(bond.a)?.add(bond.b);adjacent.get(bond.b)?.add(bond.a)}
 const groups=[],seen=new Set();for(const part of bundle.parts)if(!seen.has(part.id)){const ids=[part.id];seen.add(part.id);for(let i=0;i<ids.length;i++)for(const id of adjacent.get(ids[i]))if(!seen.has(id)){seen.add(id);ids.push(id)}groups.push(ids)}
 const bodies=new Map(),partBodies=new Map(),colliders=new Map(),colliderParts=new Map(),visualTransforms=new Map();
 try{
  for(let groupIndex=0;groupIndex<groups.length;groupIndex++){
   const ids=groups[groupIndex],origin=ids.length===1?byId.get(ids[0]).position:[0,0,0];
   const desc=bodyType==='fixed'?RAPIER.RigidBodyDesc.fixed():bodyType==='kinematic'?RAPIER.RigidBodyDesc.kinematicPositionBased():RAPIER.RigidBodyDesc.dynamic();
   desc.setTranslation(...origin.map((v,k)=>(v+translation[k])*unitsPerMeter));const body=world.createRigidBody(desc);body.userData={partIds:ids};bodies.set(`cluster-${groupIndex}`,body);
   for(const id of ids){
    const part=byId.get(id),children=[];partBodies.set(id,body);colliders.set(id,children);
    for(const visual of part.visuals??[part.visual??{partId:id,localTranslation:[0,0,0]}])visualTransforms.set(visual.partId,{body,collisionPartId:id,localTranslation:part.position.map((x,k)=>x-origin[k]+visual.localTranslation[k]),localRotation:[0,0,0,1]});
    for(let index=0;index<part.shapes.length;index++){
     const shape=part.shapes[index];let collider;
     if(shape.type==='cylinder')collider=RAPIER.ColliderDesc.cylinder(shape.halfHeight*unitsPerMeter,shape.radius*unitsPerMeter);
     else if(shape.type==='cuboid')collider=RAPIER.ColliderDesc.cuboid(...shape.halfExtents.map(x=>x*unitsPerMeter));
     else if(shape.type==='convex')collider=RAPIER.ColliderDesc.convexHull(Float32Array.from(shape.vertices.flat().map(x=>x*unitsPerMeter)));
     else throw Error(`Unsupported collider ${id}:${index}`);
     if(shape.type!=='convex'){const [x,y,z,w]=shape.rotation;collider.setRotation({x,y,z,w})}if(!collider)throw Error(`Rapier could not cook ${id}:${index}`);
     collider.setTranslation(...shape.position.map((x,k)=>(x+part.position[k]-origin[k])*unitsPerMeter)).setContactSkin(0).setDensity((typeof density==='function'?density(part):density)/(unitsPerMeter**3));
     const instance=world.createCollider(collider,body);children.push(instance);colliderParts.set(instance.handle,{partId:id,shapeIndex:index,visualPartIds:part.visualIds??[id]});
    }
   }
  }
 }catch(error){for(const body of bodies.values())world.removeRigidBody(body);throw error;}
 return {bodies,partBodies,colliders,colliderParts,visualTransforms,bonds:bundle.bonds,unitsPerMeter,
  dispose(){for(const body of bodies.values())if(body.isValid())world.removeRigidBody(body);bodies.clear();partBodies.clear();colliders.clear();colliderParts.clear();visualTransforms.clear()}};
}
/** Example world. In an existing game, keep one consistent unit scale for the
 * entire physics world. The asset and visual transforms remain in metres.
 * bodyGrouping:'parts' is a diagnostic option, not a stable bonded-assembly setup.
 */
export function createBuggyWorld(RAPIER,bundle,{unitsPerMeter=1,gravity=[0,-9.81,0],...options}={}){
 const world=new RAPIER.World({x:gravity[0]*unitsPerMeter,y:gravity[1]*unitsPerMeter,z:gravity[2]*unitsPerMeter});world.lengthUnit=unitsPerMeter;
 const assembly=createBuggyPhysics(RAPIER,world,bundle,{...options,unitsPerMeter});
 return {world,...assembly,dispose(){assembly.dispose();world.free()}};
}
