import {building,shot,breachShots} from './parts/building.mjs';
import {brickWall,fixShotGroups} from './parts/civic.mjs';
import {addSign} from './parts/sign.mjs';
import {M} from './materials.mjs';
import {buildBookStack} from './book-stack.mjs';
/** One-storey civic library, tall windows, supported entrance portico. */
export function buildNeighborhoodLibrary(options={}){
 const h=building('neighborhood-library',[-7,7,-7,7],{storeys:1,palette:'sage',books:true,brickColor:'#a27b5d',...options},[1]),{B,C}=h;
 h.b.table[M.brick].color=C.brickColor;h.base();
 const top=3.6;
 const tall=(a,b)=>[a,b,.75,3.12];
 brickWall(h,'z',[-7,-6.8],-7,7,.18,top,[tall(-5.8,-3.7),[-.8,.8,.18,2.75],tall(3.7,5.8)]);
 brickWall(h,'z',[6.8,7],-7,7,.18,top,[tall(-5.8,-3.7),[-.75,.75,.18,2.75],tall(3.7,5.8)]);
 for(const x of [-7,6.8])brickWall(h,'x',[x,x+.2],-6.8,6.8,.18,top,[tall(-5.3,-3.7),tall(-.9,.9),tall(3.7,5.3)]);
 // Side rooms leave a generous central reading hall and two connected aisles.
 for(const x of [-3.2,3.04])h.wall('x',[x,x+.16],-1.8,6.8,.18,top,[[-1.5,0,.18,2.6]],M.plaster,'reading-room-wall');
 h.roof(3.78,2.05);
 // Portico has its own buried footings, deck, four real columns and pitched pediment.
 h.b.box({min:[-3,-.35,-9.4],max:[3,0,-7],material:M.footing,type:'foundation',fixed:true,split:[4,1,2]});
 B([-3,0,-9.4],[3,.18,-7],M.trim,'portico-deck',[6,1,3]);
 for(const x of [-2.65,-1.25,1.25,2.65]){
  B([x-.18,.18,-9.05],[x+.18,.36,-8.69],M.trim,'column-base');
  B([x-.105,.36,-8.975],[x+.105,2.92,-8.765],M.trim,'portico-column',[1,3,1]);
  B([x-.18,2.92,-9.05],[x+.18,3.08,-8.69],M.trim,'column-capital');
 }
 B([-3.12,3.08,-9.2],[3.12,3.3,-7],M.trim,'portico-entablature',[6,1,2]);
 for(const z of [-9.2,-7.15])h.b.piece({axis:'z',lo:z,hi:z+.15,poly:[[-3.12,3.3],[3.12,3.3],[0,4.38]],material:M.trim,type:'pediment'});
 for(const [a,b]of [[-3.2,0],[0,3.2]])h.b.piece({axis:'z',lo:-9.3,hi:-7,poly:[[a,4.38-Math.abs(a)*1.08/3.12],[b,4.38-Math.abs(b)*1.08/3.12],[b,4.48-Math.abs(b)*1.08/3.12],[a,4.48-Math.abs(a)*1.08/3.12]],material:M.roof,type:'portico-roof'});
 // Name board below the eaves, facing the street.
 B([-2.4,3.08,-9.24],[2.4,3.3,-9.2],M.dark,'library-sign',[4,1,1]);
 addSign(h.b,'LIBRARY',{centerX:0,y:3.11,faceZ:-9.24,pixelX:.115,pixelY:.032,mirrored:C.mirrored});h.door(0,-6.8,.18,1.6);
 if(C.furnished){
  for(const x of [-5.8,5.8])for(const z of [-.5,2,4.7]){h.prop('shelf',x,.18,z,x<0?270:90);if(C.books)for(const y of [.20,.71,1.22])for(const side of [-1,1])h.placeProp(buildBookStack({palette:C.palette}),[x,.18+y,z+side*.26],90);}
  for(const x of [-1.75,1.75])for(const z of [1,4.4]){h.prop('table',x,.18,z,90);h.prop('chair',x-.85,.18,z,270);h.prop('chair',x+.85,.18,z,90);}
  h.prop('counter',-4.6,.18,-5.8,180);h.prop('cabinet',5.8,.18,-5.2,90);
 }
 h.entrances.push({name:'portico',at:[0,.18,-7],clearWidth:1.6},{name:'garden-exit',at:[0,.18,7],clearWidth:1.5});
 h.room('reception',0,[-6.8,.18,-6.8],[6.8,top,-1.8],[-.9,1.83,-4.9],[-4.5,1,-5.5]);
 h.room('reading-hall',0,[-3.04,.18,-1.8],[3.04,top,6.8],[0,1.83,-1.5],[1.5,1,4]);
 h.room('west-stacks',0,[-6.8,.18,-1.8],[-3.2,top,6.8],[-3.8,1.83,.9],[-5.8,1,4.7]);
 h.room('east-stacks',0,[3.2,.18,-1.8],[6.8,top,6.8],[3.8,1.83,.9],[5.8,1,4.7]);
 h.point('street',0,0,-11);h.point('portico',0,.18,-8);h.point('reception',0,.18,-4);h.point('reading-hall',0,.18,-.75);h.point('west-stacks',-4.2,.18,-.75);h.point('west-return',0,.18,-.75);h.point('east-stacks',4.2,.18,-.75);h.point('east-return',0,.18,-.75);h.point('reading-aisle',0,.18,5.8);h.point('garden-exit',0,0,8);
 const a=h.finish('Bayline · Neighborhood library',{glazing:[shot([-4.5,1.6,-7.5],[-4.5,1.6,-6.9],30000,.07,0,6)],wall:breachShots(-8,-6.9,{z:3.3,momentum:2000000,radius:.45}),...(C.furnished?{furniture:[shot([-1.75,1.75,1],[-1.75,.95,1],40000,.3,0,30)]}:{}),collapse:h.collapseShots()});
 a.metadata.cameras.portico={position:[-8,3,-13],target:[0,2.1,-7.8]};return fixShotGroups(a);
}
