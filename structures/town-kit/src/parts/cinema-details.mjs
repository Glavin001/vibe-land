import {M} from '../materials.mjs';
import {addSign} from './sign.mjs';
/** Shallow framed poster attached through its backing, with coarse physical art. */
function poster(h,{x,bottom=.66,width=1.22,height=1.88,faceZ=-9,theme='sunset'}){
 const {B,b}=h,lo=x-width/2,hi=x+width/2,top=bottom+height;
 const paint=(name,color)=>b.table.push({...b.table[M.trim],name,color,roughness:.75})-1;
 const paper=paint('poster-paper','#e3c891'),ink=paint('poster-ink',theme==='sunset'?'#8c4536':'#344f61');
 B([lo,bottom,faceZ-.07],[hi,top,faceZ],M.dark,'poster-backing',[1,2,1]);
 for(const xx of [lo,hi-.065])B([xx,bottom,faceZ-.125],[xx+.065,top,faceZ-.07],M.metal,'poster-frame',[1,2,1]);
 for(const y of [bottom,top-.065])B([lo+.065,y,faceZ-.125],[hi-.065,y+.065,faceZ-.07],M.metal,'poster-frame');
 B([lo+.065,bottom+.065,faceZ-.082],[hi-.065,top-.065,faceZ-.07],paper,'poster-paper',[1,2,1]);
 const c=bottom+1.15;
 // Large geometric motifs keep a readable silhouette and modest fragmentation.
 b.piece({axis:'z',lo:faceZ-.095,hi:faceZ-.082,poly:[[x-.28,c-.12],[x-.12,c-.28],[x+.12,c-.28],[x+.28,c-.12],[x+.28,c+.12],[x+.12,c+.28],[x-.12,c+.28],[x-.28,c+.12]],material:ink,type:'poster-art'});
 for(const [a,z]of [[lo+.13,x],[x,hi-.13]])b.piece({axis:'z',lo:faceZ-.095,hi:faceZ-.082,poly:[[a,bottom+.4],[z,bottom+.4],[(a+z)/2,bottom+.85]],material:ink,type:'poster-art'});
 B([lo+.14,bottom+.19,faceZ-.095],[hi-.14,bottom+.25,faceZ-.082],ink,'poster-caption');
 B([lo+.24,top-.27,faceZ-.095],[hi-.24,top-.20,faceZ-.082],ink,'poster-caption');
}
/** Details remain attached by physical contacts; exits and marquee headroom stay clear. */
export function addCinemaDetails(h){
 const {B,C}=h;
 for(const [x,theme]of [[-1.93,'sunset'],[1.93,'nocturne']])poster(h,{x,theme});
 B([-2.1,3.68,-9.115],[2.1,4.24,-9],M.dark,'cinema-name-board',[4,1,1]);
 addSign(h.b,'RIALTO',{centerX:0,y:3.79,faceZ:-9.115,pixelX:.145,pixelY:.065,mirrored:C.mirrored});
 for(const side of [-1,1])for(const z of [-3.7,-.6,2.5,7.9]){
  const x=side<0?-6.115:6;
  B([x,.18,z],[x+.115,4.4,z+.20],M.trim,'cinema-pilaster',[1,4,1]);
 }
}
