import {building,shot,breachShots} from './parts/building.mjs';
import {brickWall,flatRoof,fixShotGroups} from './parts/civic.mjs';
import {addSign} from './parts/sign.mjs';
import {M} from './materials.mjs';
/** Two-storey brick firehouse with two open apparatus bays and crew rooms. */
export function buildFireStation(options={}){
 const h=building('fire-station',[-7,7,-7,7],{storeys:2,palette:'rose',brickColor:'#a15d46',...options}),{B,C}=h;
 h.b.table[M.brick].color=C.brickColor;h.b.table[M.dark].color='#8a3830';h.base();
 const up=3.58,top=6.78,st=h.stairs(3.98,-5.1,.18,up);h.slab(up,st.void);h.guard(st,up);
 const upperWindows=[[-5.9,-4.3,4.38,6.28],[-2.4,-.8,4.38,6.28],[.5,2.1,4.38,6.28],[4.6,6.2,4.38,6.28]];
 brickWall(h,'z',[-7,-6.8],-7,7,.18,3.4,[[-6.2,-2.4,.18,2.96],[-1.5,1.7,.18,2.96],[4.65,5.95,.18,2.7]]);
 brickWall(h,'z',[-7,-6.8],-7,7,up,6.6,upperWindows);
 for(const [y,t]of [[.18,3.4],[up,6.6]]){
  brickWall(h,'z',[6.8,7],-7,7,y,t,[[-5.8,-4.2,y+.7,y+2.45],[-2.5,-1,y+.7,y+2.45],[.6,2.1,y+.7,y+2.45],...(y<1?[[4.65,5.95,y,y+2.5]]:[[4.65,5.95,y+.7,y+2.45]])]);
  for(const x of [-7,6.8])brickWall(h,'x',[x,x+.2],-6.8,6.8,y,t,[[-4.7,-3.1,y+.85,y+2.45],[2.6,4.2,y+.85,y+2.45]]);
 }
 // Ground-floor bay/lobby separation supports the upper floor and keeps stairs clear.
 h.wall('x',[2.0,2.18],-6.8,6.8,.18,3.4,[[2.2,3.6,.18,2.65]],M.brick,'bay-bearing-wall');
 for(const z of [-2,3.7]){
  B([-2.22,.18,z-.12],[-1.98,3.22,z+.12],M.frame,'apparatus-post',[1,3,1]);
  B([-6.8,3.22,z-.12],[2.0,3.4,z+.12],M.frame,'floor-beam',[8,1,1]);
 }
 // Crew dormitory, mess room, washroom and stair lobby on the upper floor.
 h.wall('x',[2.0,2.18],-6.8,6.8,up,6.6,[[-6.5,-5.2,up,up+2.5],[2.2,3.6,up,up+2.5]],M.plaster,'crew-hall-wall');
 h.wall('z',[.8,.96],-6.8,2.0,up,6.6,[[-.75,.75,up,up+2.5]],M.plaster,'dormitory-wall');
 h.wall('x',[-3.5,-3.34],.96,6.8,up,6.6,[[2.2,3.6,up,up+2.5]],M.plaster,'washroom-wall');
 flatRoof(h,[-7,7,-7,7],top,{parapet:.52});
 // Front piers, pale lintels and a name tablet give the bays a distinct civic facade.
 for(const x of [-6.7,-2.12,2.7,6.55])B([x-.12,.18,-7.14],[x+.12,3.22,-7],M.brick,'facade-pier',[1,3,1]);
 for(const [a,b]of [[-6.35,-2.25],[-1.65,1.85]]){
  B([a,2.96,-7.16],[b,3.16,-7],M.trim,'bay-lintel',[4,1,1]);
  B([a+.15,3.16,-7.10],[b-.15,3.30,-7],M.metal,'parked-shutter',[4,1,1]);
 }
 B([-6.2,3.65,-7.13],[2.3,4.1,-7],M.trim,'station-name-board',[8,1,1]);
 addSign(h.b,'FIRESTATION',{centerX:-1.95,y:3.73,faceZ:-7.13,pixelX:.13,pixelY:.055,material:M.dark,mirrored:C.mirrored});
 // Raised central parapet is still below three storeys and remains destructible.
 B([-2.6,7.40,-7],[2.6,8.05,-6.8],M.brick,'station-pediment',[5,1,1]);
 B([-2.7,8.05,-7.12],[2.7,8.18,-6.76],M.trim,'pediment-cap',[5,1,1]);
 h.door(5.3,-6.8,.18);
 if(C.furnished){
  for(const x of [-5.8,-4.6,-3.4])h.prop('cabinet',x,.18,6.48);
  h.prop('counter',.7,.18,6.48);h.prop('shelf',1.5,.18,5.5,90);
  for(const x of [-2.3,.1])h.prop('bed',x,up,4.9);
  h.prop('sink',-6.45,up,4.7,270);h.prop('toilet',-4.8,up,5.8);h.prop('bathtub',-5.4,up,2.3,90);
  h.prop('table',-3.7,up,-2);h.prop('chair',-3.7,up,-1.15);h.prop('chair',-3.7,up,-2.85,180);
  h.prop('sofa',-5.5,up,-5.9,180);h.prop('sink',-.2,up,-6.48,180);h.prop('hob',-1.4,up,-6.48,180);h.prop('refrigerator',-6.45,up,-4.5,270);
 }
 h.entrances.push({name:'west-engine-bay',at:[-4.3,.18,-7],clearWidth:3.8},{name:'east-engine-bay',at:[.1,.18,-7],clearWidth:3.2},{name:'lobby',at:[5.3,.18,-7],clearWidth:1.3},{name:'rear',at:[5.3,.18,7],clearWidth:1.3});
 h.room('engine-bays',0,[-6.8,.18,-6.8],[2.0,3.4,3.6],[-5.8,1.83,-5.5],[.4,1,4]);h.room('equipment',0,[-6.8,.18,3.6],[2.0,3.4,6.8],[-4,1.83,4.1],[-3,1,6.5]);h.room('lobby',0,[2.18,.18,-6.8],[6.8,3.4,6.8],[3,1.83,2],[3,1.5,-5.8]);
 h.room('crew-mess',1,[-6.8,up,-6.8],[2.0,6.6,.8],[1.2,up+1.65,-4.8],[-3.7,up+.8,-2]);h.room('dormitory',1,[-3.34,up,.96],[2.0,6.6,6.8],[2,up+1.65,1.5],[-1.7,up+.8,4.9]);h.room('washroom',1,[-6.8,up,.96],[-3.5,6.6,6.8],[-3.9,up+1.65,3.5],[-5.5,up+.8,5]);
 h.point('street',-4.3,0,-9);h.point('west-bay',-4.3,.18,-4.4);h.point('bay-crossing',.4,.18,-4.4);h.point('east-exit',.4,0,-8);h.point('east-return',.4,.18,-4.4);h.point('equipment',.4,.18,4.8);h.point('rear-aisle',.4,.18,2.9);h.point('lobby',5.3,.18,2.9);h.point('rear-exit',5.3,0,8);h.point('rear-return',5.3,.18,2.9);h.point('lobby-return',3,.18,2.9);h.point('stair-side-aisle',3,.18,-5.65);h.point('front-lobby',5.3,.18,-5.65);h.point('lobby-exit',5.3,0,-8);h.point('lobby-return-front',5.3,.18,-5.65);h.point('stair-start-align',4.685,.18,-5.65);h.route.push(...st.ascent);h.point('upper-lobby',5.935,up,-6.3);h.point('mess-entry',1.2,up,-5.9);h.point('crew-mess',1.4,up,-2);h.point('dormitory-approach',0,up,.1);h.point('dormitory',0,up,2.9);h.point('washroom',-4.1,up,2.9);
 return fixShotGroups(h.finish('Bayline · Brick fire station',{glazing:[shot([-5,5.1,-7.5],[-5,5.1,-6.9],30000,.07,0,6)],wall:breachShots(-8,-6.9,{z:.5,momentum:600000,radius:.45}),...(C.furnished?{furniture:[shot([-3.7,up+1.5,-2],[-3.7,up+.8,-2],40000,.3,0,30)]}:{}),collapse:h.collapseShots()}));
}
