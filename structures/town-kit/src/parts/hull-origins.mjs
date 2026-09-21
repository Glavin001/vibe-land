/** Use an AABB-corner reference for convex collision shapes. World-space
 * vertices, mass, bond surfaces and material strengths are unchanged.
 * PhysX computes each hull's actual COM. Centered symmetric hulls can produce
 * tiny COM roundoff, which currently fails the native motion forest's
 * exact-addition check when combined with metre-scale bond offsets.
 * Keep this representation local to the experimental frame builders.
 */
export function cornerReferencedHulls(pack){
 const s=pack.scenario,library=[],known=new Map();
 s.nodeColliders=s.nodeColliders.map((ref,i)=>{
  const c=ref.kind==='shape'?s.shapeLibrary[ref.shape]:ref;if(c.kind!=='convex_hull')return c;
  const origin=[0,1,2].map(k=>Math.min(...c.points.filter((_,j)=>j%3===k)));
  for(let k=0;k<3;k++)s.nodes[i].centroid['xyz'[k]]+=origin[k];
  const hull={kind:'convex_hull',points:c.points.map((v,j)=>v-origin[j%3])},key=JSON.stringify(hull.points);
  if(!known.has(key)){known.set(key,library.length);library.push(hull);}return {kind:'shape',shape:known.get(key)};
 });s.shapeLibrary=library;return pack;
}
