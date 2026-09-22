import {M} from '../materials.mjs';

/** Real roof load path: covering -> rafters/ridge -> heel seats/king posts ->
 * structural ceiling deck -> storey frame. Gables have clearance under rafters.
 */
export function framedRoof(b,envelope,bounds,y,height,{coverThickness=.1,coverMaterial=M.roof}={}){
 const [x0,x1,z0,z1]=bounds,mid=(x0+x1)/2,half=(x1-x0)/2;
 const slope=x=>y+height*(1-Math.abs(x-mid)/half);
 const start=b.s.nodes.length;envelope.slab(y);for(let i=start;i<b.s.nodes.length;i++)if(b.s.nodeTypes[i]==='floor')b.s.nodeTypes[i]='ceiling';
 const B=(min,max,type,split=[1,1,1])=>b.box({min,max,material:M.frame,type,split});
 const ridgeHalf=.08;
 B([mid-ridgeHalf,y+height-.12,z0+.12],[mid+ridgeHalf,y+height+.12-height*ridgeHalf/half,z1-.12],'roof-ridge',[1,1,2]);
 for(const z of [z0+.12,z1-.30])B([mid-ridgeHalf,y,z],[mid+ridgeHalf,y+height-.12,z+.18],'roof-post',[1,2,1]);
 const count=Math.ceil((z1-z0-.4)/1.25);
 for(let k=0;k<=count;k++){
  const z=z0+.20+(z1-z0-.40)*k/count;
  for(const side of [-1,1]){
   const a=side<0?x0:mid+ridgeHalf,c=side<0?mid-ridgeHalf:x1,n=2,pieceId=b.pieceId++;
   for(let j=0;j<n;j++){
    const left=a+(c-a)*j/n,right=a+(c-a)*(j+1)/n,heel=side<0?x0+.12*half/height:x1-.12*half/height;
    const bottom=x=>Math.max(y,slope(x)-.12);
    const poly=[[left,bottom(left)],...(heel>left&&heel<right?[[heel,y]]:[]),[right,bottom(right)],[right,slope(right)+.12],[left,slope(left)+.12]];
    b.piece({axis:'z',lo:z-.08,hi:z+.08,poly,material:M.frame,type:'roof-rafter',pieceId});
   }
  }
 }
 // Eave blocking fills the physical seat below the overhanging covering.
 for(const x of [x0-.08,x1])B([x,y,z0],[x+.08,y+.08,z1],'roof-fascia',[1,1,Math.ceil((z1-z0)/1.5)]);
 // Recessed gable infill is carried laterally by the end rafters/king posts.
 for(const z of [z0,z1-.12])for(const side of [-1,1]){
  const clearance=.132*half/height+.02;
  const a=side<0?x0+clearance:mid+ridgeHalf,c=side<0?mid-ridgeHalf:x1-clearance;
  const low=y+.006,high=x=>slope(x)-.126;
  const railZ=z===z0?z+.12:z-.08;
  B([Math.max(a,x0+.16*half/height),y+.012,railZ],[Math.min(c,x1-.16*half/height),y+.035,railZ+.08],'gable-batten',[Math.ceil((c-a)/1.5),1,1]);
  b.piece({axis:'z',lo:z,hi:z+.12,poly:[[a,low],[c,low],[c,high(c)],[a,high(a)]],material:M.siding,type:'gable-infill'});
 }
 const xs=[x0-.25,...Array.from({length:Math.ceil(half/1.4)-1},(_,i)=>x0+(i+1)*half/Math.ceil(half/1.4)),mid,...Array.from({length:Math.ceil(half/1.4)-1},(_,i)=>mid+(i+1)*half/Math.ceil(half/1.4)),x1+.25];
 for(let i=0;i<xs.length-1;i++)for(let z=z0-.25;z<z1+.249;z+=1.25){const a=xs[i],c=xs[i+1];b.piece({axis:'z',lo:z,hi:Math.min(z+1.25,z1+.25),poly:[[a,slope(a)+.12],[c,slope(c)+.12],[c,slope(c)+.12+coverThickness],[a,slope(a)+.12+coverThickness]],material:coverMaterial,type:'roof'});}
}
