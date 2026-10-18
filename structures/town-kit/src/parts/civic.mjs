import {M} from '../materials.mjs';
/** Brick envelope with real window/door voids and inset glazing. */
export function brickWall(h,axis,at,lo,hi,bottom,top,openings=[]){
 h.wall(axis,at,lo,hi,bottom,top,openings,M.brick,'masonry-wall');
 for(const o of openings)if(o[2]>bottom+.1&&o[4]!==false)h.window(axis,at[0]<0?at[0]:at[1]-.12,...o);
}
/** Layered perimeter cornice, broken into short pieces, resting on the walls. */
export function cornice(h,[x0,x1,z0,z1],y,{projection=.12,height=.16,material=M.trim}={}){
 const {B}=h;
 for(const z of [z0-projection,z1-.2])B([x0-projection,y,z],[x1+projection,y+height,z+.2+projection],material,'cornice',[Math.ceil((x1-x0)/1.2),1,1]);
 for(const x of [x0-projection,x1-.2])B([x,y,z0+.2],[x+.2+projection,y+height,z1-.2],material,'cornice',[1,1,Math.ceil((z1-z0)/1.2)]);
}
/** Flat deck on the actual perimeter/interior support graph, with parapets. */
export function flatRoof(h,[x0,x1,z0,z1],y,{parapet=.5}={}){
 const start=h.b.s.nodes.length;h.slab(y);
 for(let i=start;i<h.b.s.nodes.length;i++)h.b.s.nodeTypes[i]='ceiling';
 // Roofing rests on the deck, instead of overlapping its finish layer.
 h.B([x0,y,z0],[x1,y+.045,z1],M.roof,'roof',[Math.ceil((x1-x0)/1.4),1,Math.ceil((z1-z0)/1.4)]);
 for(const z of [z0,z1-.2])h.B([x0,y+.045,z],[x1,y+parapet,z+.2],M.brick,'parapet',[Math.ceil((x1-x0)/1.2),1,1]);
 for(const x of [x0,x1-.2])h.B([x,y+.045,z0+.2],[x+.2,y+parapet,z1-.2],M.brick,'parapet',[1,1,Math.ceil((z1-z0)/1.2)]);
 cornice(h,[x0,x1,z0,z1],y+parapet,{height:.10});
}
export function fixShotGroups(asset){
 const {metadata:m,pack}=asset,groups=new Set(pack.scenario.nodeGroups);
 m.shotGroups=Object.fromEntries(Object.keys(m.shots).map(mode=>[mode,mode==='furniture'?[...groups].find(g=>/^(table|cinema-seat)-/.test(g)):'building']));
 return asset;
}
