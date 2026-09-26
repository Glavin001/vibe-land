import * as THREE from '../../../client/node_modules/three/build/three.module.js';
import {buildTree} from './tree.mjs';

/** Lightweight dressing follows physical roof, counter and planter chunks. */
export function dressTownProp(asset,type,index){
 // Outdoor cafe joinery releases before the whole table skates away.
 if(type==='table'){
  const materials=asset.pack.defaults.solver.materials,seams=new Map();
  for(const bond of asset.pack.scenario.bonds){
   if(!seams.has(bond.m)){const seam={...materials[bond.m],name:`cafe-${materials[bond.m].name}-seam`};
    for(const key of ['tensionElastic','tensionFatal','shearElastic','shearFatal'])seam[key]*=.02;
    seams.set(bond.m,materials.push(seam)-1);}
   bond.m=seams.get(bond.m);
  }
 }
 if(!['market-stall','planter','sandwich-board','billboard'].includes(type))return asset;
 const s=asset.pack.scenario,meshes={},attachments=[];
 const attach=(owner,ids,position=[0,0,0],scale=1)=>attachments.push({owner,position,rotation:[0,0,0,1],scale,levels:[0,35,85].map(distance=>({distance,meshes:ids}))});
 const quad=(id,points,color)=>{
  const a=new THREE.Vector3(...points[1]).sub(new THREE.Vector3(...points[0])),b=new THREE.Vector3(...points[2]).sub(new THREE.Vector3(...points[0]));const normal=a.cross(b).normalize().toArray();
  meshes[id]={positions:points.flat(),normals:[...normal,...normal,...normal,...normal],uvs:[0,0,0,1,1,1,1,0],indices:[0,1,2,0,2,3],material:{color}};
 };
 if(type==='market-stall'){
  for(let owner=0;owner<s.nodes.length;owner++){
   const n=s.nodes[owner],size=s.nodeSizes[owner];
   if(s.nodeTypes[owner]==='roof'){
    const ids=[],step=.245;
    for(let j=0,x=-size.x/2;x<size.x/2-.001;x+=step,j++){
     const hi=Math.min(x+step,size.x/2),id=`market-${index}-${owner}-stripe-${j}`;
     quad(id,[[x,size.y/2+.004,-size.z/2],[x,size.y/2+.004,size.z/2],[hi,size.y/2+.004,size.z/2],[hi,size.y/2+.004,-size.z/2]],j%2?'#f3e5c6':index%2?'#537a61':'#b6664d');ids.push(id);
    }
    attach(owner,ids);
   }
   if(s.nodeTypes[owner]==='counter'){
    for(let i=0;i<6;i++){
     const color=i%2?'#bd5034':'#bfaf52',id=`produce-${color}`;
     if(!meshes[id]){const g=new THREE.SphereGeometry(.065,6,4);meshes[id]={positions:Array.from(g.attributes.position.array),normals:Array.from(g.attributes.normal.array),uvs:Array.from(g.attributes.uv.array),indices:Array.from(g.index.array),material:{color}};g.dispose();}
     attach(owner,[id],[(i%3-1)*.16,size.y/2+.065,-.15+Math.floor(i/3)*.16]);
    }
   }
  }
 }else if(type==='planter'){
  const tree=buildTree({family:'ornamental',variant:1});Object.assign(meshes,tree.visuals.meshes);
  const owner=s.nodeTypes.indexOf('base'),n=s.nodes[owner];
  for(const x of [-.3,0,.3])for(const z of [-.2,.2])attachments.push({owner,position:[x,.53-n.centroid.y,z],rotation:[0,0,0,1],scale:.2,levels:tree.visuals.attachments[0].levels});
 }else{
  // Warm inset panels give signs a readable silhouette without detached decals.
  for(let owner=0;owner<s.nodes.length;owner++)if(['board','advertising-panel'].includes(s.nodeTypes[owner])){
   const size=s.nodeSizes[owner],id=`sign-${type}-${owner}`;
   quad(id,[[-size.x*.44,-size.y*.38,-size.z/2-.003],[-size.x*.44,size.y*.38,-size.z/2-.003],[size.x*.44,size.y*.38,-size.z/2-.003],[size.x*.44,-size.y*.38,-size.z/2-.003]],type==='billboard'?'#d7b778':'#e5d7b8');attach(owner,[id]);
  }
 }
 return {...asset,visuals:{version:1,meshes,attachments}};
}
