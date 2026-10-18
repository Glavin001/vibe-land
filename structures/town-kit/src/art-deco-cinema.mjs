import {building,shot,breachShots} from './parts/building.mjs';
import {brickWall,flatRoof,fixShotGroups} from './parts/civic.mjs';
import {addSign} from './parts/sign.mjs';
import {M} from './materials.mjs';
import {buildCinemaSeat} from './cinema-seat.mjs';
import {addCinemaDetails} from './parts/cinema-details.mjs';
/** Level-entry neighborhood picture house, with a raised Art Deco street front. */
export function buildArtDecoCinema(options={}){
 const h=building('art-deco-cinema',[-6,6,-9,9],{storeys:1,palette:'cream',facadeColor:'#b6a68c',accentColor:'#496e6c',...options},[1]),{B,C}=h;
 h.b.table[M.brick].color=C.facadeColor;h.b.table[M.brick].textureKey='white-concrete';h.b.table[M.dark].color=C.accentColor;h.base();
 brickWall(h,'z',[-9,-8.8],-6,6,.18,4.4,[[-4.8,-2.8,.8,2.65],[-1,1,.18,2.65],[2.8,4.8,.8,2.65]]);
 brickWall(h,'z',[8.8,9],-6,6,.18,4.4,[[3.85,5.35,.18,2.65]]);
 for(const x of [-6,5.8])brickWall(h,'x',[x,x+.2],-8.8,8.8,.18,4.4,[[-7.5,-5.8,1.2,3],[5.3,6.7,.18,2.65]]);
 h.wall('z',[-4.6,-4.44],-5.8,5.8,.18,4.4,[[-1,1,.18,2.65]],M.plaster,'auditorium-wall');
 flatRoof(h,[-6,6,-9,9],4.58,{parapet:.5});
 // Stepped parapet silhouette. These walls are supported by the front parapet.
 B([-4.4,5.18,-9],[4.4,5.8,-8.8],M.brick,'stepped-front',[8,1,1]);
 B([-2.8,5.8,-9],[2.8,6.35,-8.8],M.brick,'stepped-front',[5,1,1]);
 B([-1.3,6.35,-9],[1.3,6.8,-8.8],M.brick,'stepped-front',[3,1,1]);
 for(const [x0,x1,y]of [[-4.4,4.4,5.8],[-2.8,2.8,6.35],[-1.3,1.3,6.8]]){
  // Caps occupy exposed shoulders only; the next tier bears directly below.
  const inside=y===5.8?2.8:y===6.35?1.3:0;
  for(const [a,b]of inside?[[x0,-inside],[inside,x1]]:[[x0,x1]])B([a,y,-9.08],[b,y+.08,-8.76],M.trim,'deco-cap',[Math.ceil(b-a),1,1]);
 }
 // Front fins stop below the stepped cap and stand clear of the marquee.
 for(const x of [-5.6,-5.25,5.15,5.5])B([x,.18,-9.12],[x+.10,4.4,-9],M.dark,'deco-flute',[1,4,1]);
 for(const x of [-1.05,-.65,.55,.95])for(const [a,b]of [[4.58,5.08],[5.18,6.7]])B([x,a,-9.10],[x+.10,b,-9],M.trim,'deco-crown-flute',[1,Math.ceil(b-a),1]);
 // Shallow supported entrance canopy with physical ticket-board lettering.
 for(const x of [-2.55,2.55]){
  h.b.box({min:[x-.12,-.35,-10.62],max:[x+.12,0,-10.38],material:M.footing,type:'foundation',fixed:true});
  B([x-.055,0,-10.555],[x+.055,2.8,-10.445],M.metal,'marquee-post',[1,3,1]);
 }
 B([-2.8,2.8,-10.8],[2.8,2.98,-9],M.trim,'marquee-ceiling',[6,1,2]);
 B([-2.8,2.98,-10.8],[2.8,3.48,-10.66],M.dark,'marquee-front',[6,1,1]);
 for(const x of [-2.8,2.66])B([x,2.98,-10.66],[x+.14,3.48,-9],M.dark,'marquee-side',[1,1,2]);
 B([-2.8,3.48,-10.8],[2.8,3.56,-9],M.trim,'marquee-roof',[6,1,2]);
 addSign(h.b,'CINEMA',{centerX:0,y:3.08,faceZ:-10.8,pixelX:.16,pixelY:.055,mirrored:C.mirrored});h.door(0,-8.8,.18,2);
 addCinemaDetails(h);
 // Screen frame attaches to the rear masonry, clear of the right-hand exit.
 for(const x of [-3.4,3.22])B([x,1.2,8.72],[x+.18,3.7,8.8],M.dark,'screen-frame',[1,2,1]);
 for(const y of [1.2,3.52])B([-3.22,y,8.72],[3.22,y+.18,8.8],M.dark,'screen-frame',[6,1,1]);
 B([-3.22,1.38,8.74],[3.22,3.52,8.752],M.trim,'projection-screen',[6,2,1]);
 if(C.furnished){
  for(const z of [-2.8,-1.55,-.3,.95,2.2,3.45])for(const x of [-3.9,-2.9,-1.9,1.9,2.9,3.9])h.placeProp(buildCinemaSeat({palette:C.palette}),[x,.18,z],180);
  h.prop('counter',-3.8,.18,-7.1);h.prop('shelf',-5.5,.18,-6,270);h.prop('sofa',3.8,.18,-7.7,180);
 }
 h.entrances.push({name:'main',at:[0,.18,-9],clearWidth:2},{name:'rear-exit',at:[4.6,.18,9],clearWidth:1.5},{name:'west-exit',at:[-6,.18,6],clearWidth:1.4},{name:'east-exit',at:[6,.18,6],clearWidth:1.4});
 h.room('foyer',0,[-5.8,.18,-8.8],[5.8,4.4,-4.6],[1.3,1.83,-5.2],[-3.8,1,-7]);h.room('auditorium',0,[-5.8,.18,-4.44],[5.8,4.4,8.8],[0,1.83,-3.6],[0,2.6,8.7]);
 h.point('street',0,0,-12);h.point('foyer',0,.18,-6.5);h.point('auditorium',0,.18,-3.4);h.point('center-aisle',0,.18,4.8);h.point('exit-cross-aisle',0,.18,6);h.point('west-exit',-7,0,6);h.point('west-return',0,.18,6);h.point('east-exit',7,0,6);h.point('east-return',0,.18,6);h.point('rear-approach',4.6,.18,6);h.point('rear-exit',4.6,0,10);
 h.cameras['seat-detail']={position:[-5.05,1.3,-3.85],target:[-3.9,.65,-2.8]};
 const a=h.finish('Bayline · Rialto picture house',{glazing:[shot([-3.8,1.6,-9.5],[-3.8,1.6,-8.9],30000,.07,0,6)],wall:breachShots(-7,-5.9,{momentum:2000000,radius:.45}),...(C.furnished?{furniture:[shot([-3.9,1.7,-2.8],[-3.9,.68,-2.8],40000,.25,0,20)]}:{}),collapse:h.collapseShots()});
 a.metadata.cameras.posters={position:[-4.2,2.1,-13.2],target:[-.9,1.8,-9]};a.metadata.cameras.marquee={position:[-8,3.2,-16],target:[0,3,-9.7]};a.metadata.cameras.screen={position:[4.8,1.83,6.8],target:[0,1.3,-1.8]};return fixShotGroups(a);
}
