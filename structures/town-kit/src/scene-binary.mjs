/** VLSP v1: uncompressed, instanced ScenePack. See BINARY-SCENES.md. */
import {createHash} from 'node:crypto';
export const NODE_BYTES=112,BOND_BYTES=72,HEADER_BYTES=64;
const digest=b=>createHash('sha256').update(b).digest();
const round=n=>Math.round(n*1e6)/1e6||0;
const xyz=v=>[v.x,v.y,v.z],vec=a=>({x:round(a[0]),y:round(a[1]),z:round(a[2])});
const u32=(n,label)=>{if(!Number.isSafeInteger(n)||n<0||n>0xffffffff)throw Error(`Invalid ${label}`);return n;};
const finite=(n,label)=>{if(!Number.isFinite(n))throw Error(`Non-finite ${label}`);return n;};
function rotation(yaw,mirror=false){if(![0,90,180,270].includes(yaw))throw Error('Expected quarter turn');const c=[1,0,-1,0][yaw/90],s=[0,1,0,-1][yaw/90];return ([x,y,z])=>{x*=mirror?-1:1;return [c*x+s*z,y,-s*x+c*z];};}
function put3(b,o,v){xyz(v).forEach((n,k)=>b.writeDoubleLE(finite(n,'coordinate'),o+k*8));}
const get3=(b,o)=>[b.readDoubleLE(o),b.readDoubleLE(o+8),b.readDoubleLE(o+16)].map(n=>finite(n,'vector'));
export function encodeSceneBundle(placements,{key='scene',title=key,metadata={},provenance={}}={}){
 const materials=[],materialMap=new Map(),strings=[],stringMap=new Map(),shapes=[],shapeMap=new Map(),templates=[],templateMap=new Map(),instances=[],nodeBuffers=[],bondBuffers=[],shapeBuffers=[];
 let nodes=0,bonds=0,shapeBytes=0,expandedNodes=0,expandedBonds=0;
 const intern=(v,table,map)=>{const key=JSON.stringify(v);if(!map.has(key)){map.set(key,table.length);table.push(v);}return map.get(key);};
 for(const {pack,position=[0,0,0],yaw=0,mirror=false,groupSuffix='',group=null}of placements){
  if(pack.version!==2)throw Error('Binary exporter requires ScenePack v2');rotation(yaw,mirror);if(position.length!==3)throw Error('Invalid position');position.forEach(n=>finite(n,'position'));
  const table=pack.defaults.solver.materials,remap=table.map(m=>intern(m,materials,materialMap)),s=pack.scenario;
  const n=s.nodes.length,b=s.bonds.length;for(const field of ['nodeColliders','nodeSizes','nodePieces','nodeTypes','nodeGroups'])if(s[field]?.length!==n)throw Error(`${field} count mismatch`);
  const nb=Buffer.alloc(n*NODE_BYTES),bb=Buffer.alloc(b*BOND_BYTES);let span=0;
  s.nodes.forEach((node,i)=>{
   const o=i*NODE_BYTES,c0=s.nodeColliders[i],c=c0.kind==='shape'?s.shapeLibrary?.[c0.shape]:c0;
   if(!c||!['cuboid','convex_hull'].includes(c.kind))throw Error('Invalid collider');
   put3(nb,o,node.centroid);nb.writeDoubleLE(finite(node.mass,'mass'),o+24);nb.writeDoubleLE(finite(node.volume,'volume'),o+32);put3(nb,o+40,s.nodeSizes[i]);
   if(node.mass<0||node.volume<=0||node.m>=table.length)throw Error('Invalid node');
   let shape=0xffffffff;
   if(c.kind==='cuboid'){if(xyz(c.halfExtents).some(x=>x<=0))throw Error('Invalid box');put3(nb,o+64,c.halfExtents);}else{
    if(c.points.length<12||c.points.length>192||c.points.length%3)throw Error('Invalid hull');c.points.forEach(x=>finite(x,'hull'));
    const key=JSON.stringify(c.points);if(!shapeMap.has(key)){shapeMap.set(key,shapes.length);shapes.push({offset:shapeBytes,count:c.points.length});const sb=Buffer.alloc(c.points.length*8);c.points.forEach((x,k)=>sb.writeDoubleLE(x,k*8));shapeBuffers.push(sb);shapeBytes+=sb.length;}shape=shapeMap.get(key);
   }
   const piece=u32(s.nodePieces[i],'piece');span=Math.max(span,piece+1);
   [node.m??0,piece,intern(s.nodeTypes[i],strings,stringMap),intern(s.nodeGroups[i],strings,stringMap),shape,c.kind==='cuboid'?0:1].forEach((x,k)=>nb.writeUInt32LE(u32(x,'node reference'),o+88+4*k));
  });
  s.bonds.forEach((bond,i)=>{if(bond.node0>=n||bond.node1>=n||bond.m>=table.length||!(bond.area>0))throw Error('Invalid bond');const o=i*BOND_BYTES;put3(bb,o,bond.centroid);put3(bb,o+24,bond.normal);if(Math.abs(Math.hypot(...xyz(bond.normal))-1)>1e-4)throw Error('Invalid normal');bb.writeDoubleLE(finite(bond.area,'area'),o+48);[bond.node0,bond.node1,bond.m??0].forEach((x,k)=>bb.writeUInt32LE(u32(x,'bond reference'),o+56+k*4));});
  // Materials are instance remaps: recoloring never duplicates identical geometry.
  const identity=createHash('sha256').update(String(table.length)).update(nb).update(bb).digest('hex');let template=templateMap.get(identity);
  if(template===undefined){template=templates.length;templateMap.set(identity,template);templates.push({nodeStart:nodes,nodeCount:n,bondStart:bonds,bondCount:b,pieceSpan:span,materialSlots:table.length});nodeBuffers.push(nb);bondBuffers.push(bb);nodes+=n;bonds+=b;}
  instances.push({template,position,yaw,mirror,materials:remap,groupSuffix,group});expandedNodes+=n;expandedBonds+=b;
 }
 const sections={nodes:{offset:0,bytes:nodes*NODE_BYTES},bonds:{offset:nodes*NODE_BYTES,bytes:bonds*BOND_BYTES},shapes:{offset:nodes*NODE_BYTES+bonds*BOND_BYTES,bytes:shapeBytes}};
 const header={key,title,materials,strings,shapes,templates,instances,sections,metadata,provenance};
 const json=Buffer.from(JSON.stringify(header)),padding=Buffer.alloc((8-json.length%8)%8),payload=Buffer.concat([...nodeBuffers,...bondBuffers,...shapeBuffers]),prefix=Buffer.alloc(HEADER_BYTES);
 prefix.write('VLSP');[1,json.length,NODE_BYTES,BOND_BYTES,payload.length,expandedNodes,expandedBonds].forEach((n,i)=>prefix.writeUInt32LE(u32(n,'header'),4+i*4));
 const body=Buffer.concat([json,padding,payload]);digest(body).copy(prefix,32);
 return Buffer.concat([prefix,body]);
}
export function inspectSceneBundle(input){
 const b=Buffer.from(input.buffer??input,input.byteOffset??0,input.byteLength??input.length);
 if(b.length<64||b.toString('ascii',0,4)!=='VLSP'||b.readUInt32LE(4)!==1)throw Error('Unsupported VLSP header');
 const len=b.readUInt32LE(8),start=64+Math.ceil(len/8)*8,payloadBytes=b.readUInt32LE(20),expandedNodes=b.readUInt32LE(24),expandedBonds=b.readUInt32LE(28);
 if(len>16*1024*1024||start+payloadBytes!==b.length||b.readUInt32LE(12)!==NODE_BYTES||b.readUInt32LE(16)!==BOND_BYTES)throw Error('Invalid VLSP length/stride');
 if(expandedNodes>2000000||expandedBonds>8000000)throw Error('VLSP expansion limit');
 if(!digest(b.subarray(64)).equals(b.subarray(32,64)))throw Error('VLSP checksum mismatch');
 const header=JSON.parse(b.toString('utf8',64,64+len));let at=0;
 for(const name of ['nodes','bonds','shapes']){const section=header.sections[name];if(section.offset!==at||!Number.isSafeInteger(section.bytes)||section.bytes<0)throw Error('Invalid section');at+=section.bytes;}
 if(at!==payloadBytes)throw Error('Invalid payload sections');
 return {header,payload:b.subarray(start),expandedNodes,expandedBonds};
}
export function decodeSceneBundle(bytes){
 const {header:h,payload:p,expandedNodes,expandedBonds}=inspectSceneBundle(bytes),s={nodes:[],bonds:[],nodeSizes:[],nodeColliders:[],nodeTypes:[],nodeMaterials:[],nodePieces:[],nodeGroups:[]},library=[],shapeMap=new Map();let pieceBase=0;
 const strings=h.strings,templates=h.templates,point=(p,rotate,pos)=>vec(rotate(p).map((x,k)=>round(x+pos[k])));
 let totalNodes=0,totalBonds=0;
 for(const inst of h.instances){const t=templates[inst.template];if(!t)throw Error('Invalid template');totalNodes+=t.nodeCount;totalBonds+=t.bondCount;}
 if(totalNodes!==expandedNodes||totalBonds!==expandedBonds)throw Error('Expansion count mismatch');
 for(const inst of h.instances){
  const t=templates[inst.template],rotate=rotation(inst.yaw,inst.mirror),offset=s.nodes.length;
  if(!Array.isArray(inst.position)||inst.position.length!==3||!inst.position.every(Number.isFinite))throw Error('Invalid instance position');
  if(inst.materials.length!==t.materialSlots||inst.materials.some(x=>!Number.isInteger(x)||!h.materials[x]))throw Error('Invalid material remap');
  if((t.nodeStart+t.nodeCount)*NODE_BYTES>h.sections.nodes.bytes||(t.bondStart+t.bondCount)*BOND_BYTES>h.sections.bonds.bytes)throw Error('Template range');
  const mat=x=>{if(x>=inst.materials.length)throw Error('Invalid material slot');return inst.materials[x];};
  for(let i=0;i<t.nodeCount;i++){
   const o=h.sections.nodes.offset+(t.nodeStart+i)*NODE_BYTES,m=mat(p.readUInt32LE(o+88)),piece=p.readUInt32LE(o+92),role=p.readUInt32LE(o+96),group=p.readUInt32LE(o+100),shape=p.readUInt32LE(o+104),kind=p.readUInt32LE(o+108);
   if(piece>=t.pieceSpan||typeof strings[role]!=='string'||typeof strings[group]!=='string')throw Error('Invalid node identity');
   if(!(p.readDoubleLE(o+24)>=0)||!(p.readDoubleLE(o+32)>0)||get3(p,o+40).some(x=>x<=0))throw Error('Invalid node data');
   s.nodes.push({centroid:point(get3(p,o),rotate,inst.position),mass:finite(p.readDoubleLE(o+24),'mass'),volume:finite(p.readDoubleLE(o+32),'volume'),m});s.nodeSizes.push(vec(rotate(get3(p,o+40)).map(Math.abs)));s.nodeTypes.push(strings[role]);s.nodeGroups.push(inst.group??(strings[group]+inst.groupSuffix));s.nodeMaterials.push(h.materials[m].name);s.nodePieces.push(pieceBase+piece);
   if(kind===0){const half=get3(p,o+64);if(half.some(x=>x<=0))throw Error('Invalid cuboid');s.nodeColliders.push({kind:'cuboid',halfExtents:vec(rotate(half).map(Math.abs))});}else if(kind===1){
    const sh=h.shapes[shape];if(!sh||sh.count<12||sh.count>192||sh.count%3||sh.offset+sh.count*8>h.sections.shapes.bytes)throw Error('Invalid shape');
    const pts=[];for(let j=0;j<sh.count;j+=3)pts.push(...rotate(get3(p,h.sections.shapes.offset+sh.offset+j*8)).map(round));const key=JSON.stringify(pts);if(!shapeMap.has(key)){shapeMap.set(key,library.length);library.push({kind:'convex_hull',points:pts});}s.nodeColliders.push({kind:'shape',shape:shapeMap.get(key)});
   }else throw Error('Invalid collider kind');
  }
  for(let i=0;i<t.bondCount;i++){const o=h.sections.bonds.offset+(t.bondStart+i)*BOND_BYTES,a=p.readUInt32LE(o+56),b=p.readUInt32LE(o+60);if(a>=t.nodeCount||b>=t.nodeCount)throw Error('Invalid bond reference');const area=finite(p.readDoubleLE(o+48),'area'),normal=vec(rotate(get3(p,o+24)));if(area<=0||Math.abs(Math.hypot(...xyz(normal))-1)>1e-4||p.readUInt32LE(o+68)!==0)throw Error('Invalid bond data');s.bonds.push({node0:a+offset,node1:b+offset,centroid:point(get3(p,o),rotate,inst.position),normal,area,m:mat(p.readUInt32LE(o+64))});}
  pieceBase+=t.pieceSpan;
 }
 if(library.length)s.shapeLibrary=library;
 return {pack:{version:2,key:h.key,title:h.title,defaults:{solver:{gravity:-9.81,materials:h.materials}},scenario:s},metadata:h.metadata,provenance:h.provenance};
}
