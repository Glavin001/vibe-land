/** Fence runs share their end posts, rather than occupying the same space. */
export function weldFencePosts(pack) {
 const s=pack.scenario,map=[],keep=[],seen=new Map();
 for(let i=0;i<s.nodes.length;i++){
  const shared=/fence|gate/.test(s.nodeGroups[i])&&['foundation','fence-post','post-cap'].includes(s.nodeTypes[i]);
  const c=s.nodeColliders[i],shape=c.kind==='shape'?s.shapeLibrary[c.shape]:c;
  const key=shared?JSON.stringify([s.nodes[i],shape,s.nodeTypes[i]]):null;
  if(key&&seen.has(key))map[i]=seen.get(key);else {map[i]=keep.length;keep.push(i);if(key)seen.set(key,map[i]);}
 }
 for(const k of ['nodes','nodeSizes','nodeColliders','nodeTypes','nodePieces','nodeGroups','nodeMaterials'])s[k]=keep.map(i=>s[k][i]);
 const unique=new Set();s.bonds=s.bonds.map(b=>({...b,node0:map[b.node0],node1:map[b.node1]})).filter(b=>{const key=[Math.min(b.node0,b.node1),Math.max(b.node0,b.node1)].join(':');if(b.node0===b.node1||unique.has(key))return false;unique.add(key);return true;});
 return pack;
}

/** Built-ins attach only across measured, touching box faces. */
export function attachBuiltins(pack) {
 const s=pack.scenario,table=pack.defaults.solver.materials;
 const resolved=s.nodeColliders.map(c=>c.kind==='shape'?s.shapeLibrary[c.shape]:c);
 const bounds=s.nodes.map((n,i)=>{const c=resolved[i];if(c.kind!=='cuboid')return null;return [['x','y','z'].map(k=>n.centroid[k]-c.halfExtents[k]),['x','y','z'].map(k=>n.centroid[k]+c.halfExtents[k])];});
 const hosts=s.nodes.map((_,i)=>i).filter(i=>s.nodeGroups[i]==='building'&&bounds[i]);
 for(let i=0;i<s.nodes.length;i++){
  if(!/^(counter|sink|hob|cabinet|shelf|toilet|bathtub)-/.test(s.nodeGroups[i])||!bounds[i])continue;
  const [lo,hi]=bounds[i];
  for(const j of hosts){
   const [a,b]=bounds[j],overlap=lo.map((x,k)=>Math.min(hi[k],b[k])-Math.max(x,a[k]));
   if(overlap.some(x=>x<-.00001)||overlap.filter(x=>Math.abs(x)<.00001).length!==1)continue;
   const k=overlap.findIndex(x=>Math.abs(x)<.00001),area=overlap.filter((_,i)=>i!==k).reduce((x,y)=>x*y,1);if(area<1e-6)continue;
   const axes=['x','y','z'],centroid=Object.fromEntries(axes.map((v,k)=>[v,(Math.max(lo[k],a[k])+Math.min(hi[k],b[k]))/2]));
   const normal={x:0,y:0,z:0};normal[axes[k]]=Math.sign(s.nodes[j].centroid[axes[k]]-s.nodes[i].centroid[axes[k]]);
   const m=table[s.nodes[i].m].tensionFatal<table[s.nodes[j].m].tensionFatal?s.nodes[i].m:s.nodes[j].m;
   s.bonds.push({node0:i,node1:j,area,normal,centroid,m});
  }
 }
 return pack;
}
