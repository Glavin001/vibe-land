import {M} from '../materials.mjs';
import {framedRoof} from './framed-roof.mjs';

/** A joisted ceiling occupying the same 180 mm zone as the old solid deck.
 * Perimeter plates and joists carry rafters directly. Thin infill panels span
 * between joists, so plaster does not sit in the roof's vertical load path.
 */
export function residentialCeiling(b,bounds,y) {
 const [x0,x1,z0,z1]=bounds,width=.16;
 const box=(lo,hi,type,material,split=[1,1,1])=>b.box({min:lo,max:hi,type,material,split});
 // End plates support the two ridge posts, with continuous contact to wall headers.
 for(const z of [z0,z1-.30])box([x0,y-.18,z],[x1,y,z+.30],'ceiling-joist',M.frame,[4,1,1]);
 for(const x of [x0,x1-.18])box([x,y-.18,z0+.30],[x+.18,y,z1-.30],'ceiling-joist',M.frame,[1,1,8]);
 const count=Math.ceil((z1-z0-.4)/1.25),spans=[];
 for(let k=1;k<count;k++){
  const z=z0+.20+(z1-z0-.40)*k/count;
  spans.push([z-width/2,z+width/2]);
  box([x0+.18,y-.18,z-width/2],[x1-.18,y,z+width/2],'ceiling-joist',M.frame,[4,1,1]);
 }
 const edges=[z0+.30,...spans.flat(),z1-.30];
 for(let i=0;i<edges.length-1;i+=2){
  box([x0+.18,y-.025,edges[i]],[x1-.18,y,edges[i+1]],'ceiling-panel',M.plaster,[8,1,1]);
 }
}

/** Experimental lighter roof; original rendering and native collision interfaces. */
export function residentialRoof(b,bounds,y,height) {
 const coverMaterial=b.table.length;
 b.table.push({...b.table[M.roof],name:'slate-on-sheathing',density:1000,
  compressionElastic:6e6,compressionFatal:12e6,tensionElastic:6e5,tensionFatal:1.2e6,
  shearElastic:1e6,shearFatal:2e6,elasticModulus:2e9});
 return framedRoof(b,{slab:level=>residentialCeiling(b,bounds,level)},bounds,y,height,
  {coverThickness:.03,coverMaterial});
}
