import {addSign} from './parts/sign.mjs';
import {building,shot,breachShots} from './parts/building.mjs';
import {createEnvelope} from './parts/envelope.mjs';
import {M} from './materials.mjs';
export function buildWorkshop(options={}){
 const h=building('workshop',[-7,7,-6,6],{palette:'ochre',storeys:2,...options}),{B,C}=h;if(options.palette===undefined)h.b.table[M.siding].color='#9b5144';h.b.table[M.dark].color='#414b4b';h.base();
 const up=3.38,top=5.78,st=h.stairs(-6.62,1.2,.18,up);createEnvelope(h.b,{floorBounds:[-7,7,-1.2,6]}).slab(up,st.void);h.guard(st,up);h.rail(-6.7,-1.1,6.7,-1.1,up);
 for(const x of [-3.7,1,6.55])for(const z of [-.65,4.4])B([x-.09,.18,z-.09],[x+.09,up-.18,z+.09],M.frame,'loft-post',[1,3,1]);
 h.facade('z',[-6,-5.82],-7,7,.18,top-.18,[[-5.9,-.5,.18,3.65],[4,5.3,.18,2.6],[3.7,5.6,3.5,5.1]]);
 h.facade('z',[5.82,6],-7,7,.18,top-.18,[[-2.8,-1.2,3.9,5.1],[.1,1.5,.18,2.6],[3.4,5,3.9,5.1],[-7,7,3.2,3.38,false]]);
 for(const x of [-7,6.82])h.facade('x',[x,x+.18],-5.82,5.82,.18,top-.18,[[-4.2,-2.2,3.9,5.1],[1.3,3.3,3.9,5.1],[-1.2,5.82,3.2,3.38,false]]);
 h.wall('x',[2.4,2.55],-5.82,-1.3,.18,3.2,[[-3.8,-2.4,.18,2.5]],M.plaster,'office-wall');h.wall('z',[-1.45,-1.3],2.55,6.82,.18,3.2,[],M.plaster,'office-wall');
 B([2.55,3.2,-5.82],[6.82,3.38,-1.3],M.trim,'office-ceiling',[4,1,4]);
 h.roof(top,2);B([-6.05,3.65,-6.12],[-.35,3.85,-6.03],M.dark,'vehicle-lintel',[6,1,1]);
 // The roll-up door is fully parked above the opening, not a hidden collider.
 for(let y=3.9;y<4.7;y+=.16)B([-5.8,y,-6.09],[-.6,y+.13,-6.03],M.metal,'open-shutter',[5,1,1]);
 B([-5.8,4.95,-6.15],[-.6,5.4,-6.03],M.dark,'workshop-sign',[5,1,1]);addSign(h.b,C.signText??'WORKS',{centerX:-3.2,y:5.02,faceZ:-6.15,mirrored:C.mirrored});
 if(C.furnished){h.prop('table',4.8,.18,-4.2);h.prop('chair',4.8,.18,-3.35);h.prop('cabinet',6.5,.18,-2.2,90);for(const x of [-2.5,-1.3])h.prop('counter',x,.18,5.5);h.prop('shelf',4.8,.18,5.5);h.prop('table',3.8,up,1);h.prop('chair',3.8,up,1.85);h.prop('shelf',3.5,up,5.5);h.prop('shelf',5.5,up,5.5);}
 h.entrances.push({name:'vehicle-bay',at:[-3.2,.18,-6],clearWidth:5.4},{name:'office',at:[4.65,.18,-6],clearWidth:1.3},{name:'rear',at:[.8,.18,6],clearWidth:1.4});
 h.room('vehicle-bay',0,[-6.82,.18,-5.82],[2.4,3.2,-1.3],[-5.8,1.83,-4.8],[-1,1.5,2]);h.room('office',0,[2.55,.18,-5.82],[6.82,3.2,-1.45],[2.9,1.83,-2],[5,1,-4]);h.room('workbench',0,[-3.6,.18,-1.2],[6.82,3.2,5.82],[1.8,1.83,1],[-2,1,5]);h.room('storage-loft',1,[-4,up,-1.2],[6.82,top-.18,5.82],[1,up+1.65,-.7],[4,up+.7,3]);
 h.cameras.bay={position:[-4,1.8,-9],target:[0,2,2]};h.cameras.loft={position:[2,up+1.65,4],target:[-4,up+.4,-.6]};
 h.point('street',-3.2,0,-8);h.point('vehicle-bay',-3.2,.18,-4);h.point('bay-centre',0,.18,-3);h.point('office',3.5,.18,-3);h.point('office-door',4.65,.18,-5.4);h.point('office-exit',4.65,0,-7);h.point('office-return',4.65,.18,-5.4);h.point('office-return-inside',3.5,.18,-3);h.point('bay-return',0,.18,-3);h.point('workbench',0,.18,2);h.point('rear-approach',.8,.18,3.6);h.point('rear-exit',.8,0,7);h.point('rear-return',.8,.18,3.6);h.point('workbench-return',0,.18,2);h.point('stair-aisle',-3,.18,.2);h.point('stair-approach',-5.935,.18,.2);h.route.push(...st.ascent);h.point('loft-entry',-4.685,up,.4);h.point('loft',0,up,.4);h.point('loft-aisle',1.5,up,3.5);h.point('storage-loft',4.5,up,3.5);
 return h.finish('Bayline · Foundry lane workshop',{glazing:[shot([4.4,4.4,-6.5],[4.4,4.4,-5.9],50000,.07,0,6)],wall:breachShots(-8,-6.9),furniture:[shot([3.8,up+1.5,1],[3.8,up+.77,1],40000,.3,0,30)],collapse:h.collapseShots()});
}
