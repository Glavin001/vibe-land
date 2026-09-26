import * as THREE from '../../../client/node_modules/three/build/three.module.js';
import {ConvexGeometry} from '../../../client/node_modules/three/examples/jsm/geometries/ConvexGeometry.js';
import {TreeSkeleton} from '../vendor/ez-tree/skeleton.mjs';
import {Builder,v,round} from './geometry.mjs';
import {M} from './materials.mjs';

export const TREE_FAMILIES=['shade','street','conifer','ornamental','sapling'];
const profiles={
 shade:{height:6.8,radius:.30,spread:2.1,rise:1.6,limbs:9,leaf:'#bdc899',size:.42},
 street:{height:7.5,radius:.22,spread:1.2,rise:2.0,limbs:6,leaf:'#c5d3ae',size:.38},
 conifer:{height:8.4,radius:.25,spread:2.6,rise:.4,limbs:9,leaf:'#a1bba1',size:.7},
 ornamental:{height:3.8,radius:.15,spread:1.4,rise:.7,limbs:5,leaf:'#e6b6a3',size:.4},
 sapling:{height:2.7,radius:.065,spread:.6,rise:.5,limbs:2,leaf:'#cadcab',size:.32},
};
const V=p=>new THREE.Vector3(...p),xyz=p=>p.toArray();

/** Closed convex pieces with volume and centroid integrated from hull triangles. */
function hull(builder,points,material,type,fixed=false) {
 const geo=new ConvexGeometry(points.map(V)),p=geo.attributes.position;
 let volume=0;const center=new THREE.Vector3();
 for(let i=0;i<p.count;i+=3){const a=new THREE.Vector3().fromBufferAttribute(p,i),b=new THREE.Vector3().fromBufferAttribute(p,i+1),c=new THREE.Vector3().fromBufferAttribute(p,i+2);const q=a.dot(b.clone().cross(c))/6;volume+=q;center.addScaledVector(a.add(b).add(c),q/4);}
 center.divideScalar(volume);volume=Math.abs(volume);geo.dispose();
 if(!(volume>1e-8))throw Error('Degenerate tree chunk');
 const lo=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),hi=[0,1,2].map(k=>Math.max(...points.map(p=>p[k]))),s=builder.s,id=s.nodes.length;
 s.nodes.push({centroid:v(xyz(center)),mass:fixed?0:round(volume*builder.table[material].density),volume:round(volume),m:material});
 s.nodeSizes.push(v(hi.map((p,k)=>p-lo[k])));s.nodeColliders.push({kind:'convex_hull',points:points.flatMap(p=>p.map((n,k)=>round(n-center.getComponent(k))))});
 s.nodeTypes.push(type);s.nodePieces.push(id);s.nodeGroups.push(builder.group);s.nodeMaterials.push(builder.table[material].name);
 return id;
}
const ring=(r,y)=>Array.from({length:8},(_,i)=>[r*Math.cos(i*Math.PI/4),y,r*Math.sin(i*Math.PI/4)]);
const twigCache=new Map();
function twigs(family,variant) {
 const key=`${family}-${variant}`;if(twigCache.has(key))return twigCache.get(key);
 const p=profiles[family],pine=family==='conifer',tree=new TreeSkeleton({seed:900+variant,type:pine?'evergreen':'deciduous',
  bark:{textureScale:{x:1,y:1}},branch:{levels:2,length:[pine?1.6:1.1,.9,.48],radius:[.038,.55,.5],sections:[5,4,3],segments:[5,4,3],
   children:[5,4,0],start:[0,.1,.1],angle:[0,50,55],taper:[.8,.8,1],twist:[0,0,0],gnarliness:[.012,.02,.025],force:{direction:{x:0,y:1,z:0},strength:.00015}},
  leaves:{count:pine?12:14,start:.12,size:p.size,sizeVariance:.3,angle:55,roundedNormals:true}});
 tree.generate();
 const levels=[{},{sectionStride:2,segmentFactor:.65,leafStride:2,leafScale:1.15,billboard:'single'},{sectionStride:3,segmentFactor:.5,leafStride:4,leafScale:1.35,billboard:'single'}].map(detail=>tree.mesh(detail));
 const result={key,levels};twigCache.set(key,result);return result;
}

export function buildTree({family='shade',variant=0,seed=20260925,trunkSections=4,branchSections=3}={}) {
 if(!TREE_FAMILIES.includes(family)||!Number.isInteger(variant)||variant<0||variant>2||!Number.isSafeInteger(seed))throw Error('Invalid tree family, variant or seed');
 const p=profiles[family],b=new Builder(`tree-${family}-${variant}`,{seed:seed+variant*101,group:`tree-${family}`});
 const h=p.height*(.92+b.rng()*.16),radius=p.radius*(.92+b.rng()*.16);
 const wood=b.table.push({...b.table[M.frame],name:`living-wood-${family}`,color:family==='street'?'#968a70':'#78664e',density:650,textureKey:'aged-timber',
  tensionElastic:4e4,tensionFatal:8e4,shearElastic:6e4,shearFatal:1.2e5,compressionElastic:8e6,compressionFatal:16e6,elasticModulus:2e9})-1;
 const rootWood=b.table.push({...b.table[wood],name:`root-wood-${family}`,tensionElastic:3e6,tensionFatal:6e6,shearElastic:4e6,shearFatal:8e6})-1;
 const branchWood=b.table.push({...b.table[wood],name:`branch-fibre-${family}`,tensionElastic:4e3,tensionFatal:8e3,shearElastic:6e3,shearFatal:1.2e4})-1;
 const bond=(a,c,center,normal,area,material=wood)=>b.s.bonds.push({node0:a,node1:c,centroid:v(center),normal:v(normal),area:round(area),m:material});
 // Separate cross-sections let the solver fracture the main stem at different
 // heights while the rooted lower section stays supported.
 if(![4,6].includes(trunkSections)||![2,3].includes(branchSections))throw Error('Unsupported tree segmentation');
 const trunk=[],levels=family==='sapling'?[0,.3,h*.52,h]:trunkSections===4?[0,h*.25,h*.5,h*.75,h]:[0,.55,h*.24,h*.42,h*.62,h*.82,h],count=levels.length-1;
 // Linear taper keeps all eight trunk faces planar, including across cuts.
 const trunkRadius=y=>radius*(1-.78*y/h);
 const root=hull(b,[...ring(radius,-.45),...ring(radius,0)],M.footing,'foundation',true);
 for(let i=0;i<count;i++){
  const node=hull(b,[...ring(trunkRadius(levels[i]),levels[i]),...ring(trunkRadius(levels[i+1]),levels[i+1])],wood,'trunk');trunk.push(node);
  bond(i?trunk[i-1]:root,node,[0,levels[i],0],[0,1,0],2*Math.sqrt(2)*trunkRadius(levels[i])**2,i?wood:rootWood);
 }
 const meshes={},attachments=[],bud=twigs(family,variant);
 const windHeight=Math.max(...bud.levels[0].leaves.verts.filter((_,i)=>i%3===1),...bud.levels[0].branches.verts.filter((_,i)=>i%3===1));
 for(const [lod,geometry]of bud.levels.entries())for(const kind of ['branches','leaves']){
  const raw=geometry[kind],id=`${bud.key}-${kind}-${lod}`;
  meshes[id]={positions:raw.verts.map(round),normals:raw.normals.map(round),uvs:raw.uvs.map(round),indices:raw.indices,
   material:kind==='leaves'?{color:p.leaf,texture:family==='conifer'?'pine':'oak',foliage:true,wind:true,windHeight}:{color:'#78664e',wind:true,windHeight}};
 }
 function graft(owner,at,direction,scale=1){
  const n=b.s.nodes[owner].centroid,q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),V(direction).normalize());
  // Rotate reused twig templates around their graft axis without altering the
  // physical skeleton or consuming its seeded RNG stream.
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),(owner+variant*7)*2.399963));
  attachments.push({owner,position:at.map((x,k)=>round(x-[n.x,n.y,n.z][k])),rotation:q.toArray().map(round),scale,
   levels:[0,1,2].map(lod=>({distance:[0,35,85][lod],meshes:[`${bud.key}-branches-${lod}`,`${bud.key}-leaves-${lod}`]}))});
  // Aggregate leaf/twig mass; detail never contributes collision or separate bodies.
  b.s.nodes[owner].mass=round(b.s.nodes[owner].mass+2.5*scale**3);
 }
 for(let j=0;j<p.limbs;j++){
  const rawY=h*(.36+.52*(j+.35)/p.limbs),parentSegment=levels.findIndex((y,i)=>i<count&&rawY>=y&&rawY<levels[i+1]);
  const r=Math.min(trunkRadius(rawY)*.29,.10),y=Math.max(levels[parentSegment]+r+.01,Math.min(levels[parentSegment+1]-r-.01,rawY));
  const face=(j*3+variant*2)%8,angle=(face+.5)*Math.PI/4;
  const radial=[Math.cos(angle),0,Math.sin(angle)],tangent=[-radial[2],0,radial[0]],apothem=trunkRadius(y)*Math.cos(Math.PI/8);
  const slope=radius*.78/h*Math.cos(Math.PI/8),normal=xyz(V([radial[0],slope,radial[2]]).normalize());
  const start=[radial[0]*apothem,y,radial[2]*apothem];
  const length=p.spread*(family==='conifer'?1.35-j/p.limbs:.8+b.rng()*.4);
  const end=[radial[0]*(apothem+length),y+p.rise*(.8+b.rng()*.4),radial[2]*(apothem+length)];
  // The vertical section axis follows the sloping trunk face exactly.
  const vertical=xyz(V([-radial[0]*slope,1,-radial[2]*slope]).normalize());
  const corners=(p,r)=>Array.from({length:8},(_,i)=>p.map((x,k)=>x+tangent[k]*Math.cos(i*Math.PI/4)*r+vertical[k]*Math.sin(i*Math.PI/4)*r));
  // Branch collars and two limb sections can break independently under bending.
  const splits=family==='sapling'?2:branchSections,ids=[];
  for(let k=0;k<splits;k++){
   const point=t=>start.map((x,i)=>x+(end[i]-x)*t),ra=r*(1-.7*k/splits),rb=r*(1-.7*(k+1)/splits);
   const id=hull(b,[...corners(point(k/splits),ra),...corners(point((k+1)/splits),rb)],wood,'major-limb');ids.push(id);
   const parent=k?ids[k-1]:trunk[parentSegment];
   bond(parent,id,point(k/splits),normal,2*Math.sqrt(2)*ra*ra,branchWood);
  }
  const tip=ids.at(-1);graft(tip,end,[normal[0]*.65,1,normal[2]*.65],family==='shade'?1.65:family==='sapling'?.65:1);
  if(family!=='sapling'){
   const middle=start.map((x,i)=>x+(end[i]-x)*.58);graft(ids[Math.floor(splits*.58)],middle,[normal[0],.6,normal[2]],family==='shade'?1.1:.8);
  }
 }
 graft(trunk.at(-1),[0,h,0],[0,1,0],family==='sapling'?.7:family==='shade'?1.6:1);
 const pack={version:2,key:b.key,title:`Bayline · ${family} tree ${variant+1}`,defaults:{solver:{gravity:-9.81,materials:b.table}},scenario:b.s};
 const cutY=levels[1],limb=b.s.nodeTypes.indexOf('major-limb')+(family==='sapling'?1:branchSections-1),lp=b.s.nodes[limb].centroid;
 // Short, resolved contact approach: a fast tiny sphere can tunnel through a
 // thin limb between 60 Hz steps. Momentum alone does not prove a collision.
 const shot=(to,momentum,radius=.14)=>({from:[to[0],to[1],to[2]-.3],to,momentum,radius,speed:6,tick:0});
 return {pack,visuals:{version:1,meshes,attachments},metadata:{kind:'tree',type:family,options:{family,variant,seed,trunkSections,branchSections},route:[],
  shots:{furniture:[shot([lp.x,lp.y,lp.z],80)],collapse:[shot([0,cutY+.8,0],40000,.35)]},shotGroups:{furniture:b.group,collapse:b.group},
  fractureReview:{requireBranchBreak:true,requireTrunkBreak:true,rootNode:root},
  strengthCalibration:'Effective gameplay fracture thresholds; not engineering wood strengths.',
  collapseNodes:trunk.slice(1),cameras:{hero:{position:[11,h*.8,-12],target:[0,h*.52,0]},front:{position:[0,h*.6,-15],target:[0,h*.5,0]}},
  gameplay:{resistance:family==='sapling'?'light':family==='shade'?'heavy':'medium',physicalChunks:b.s.nodes.length,leafPhysics:false}}};
}
