import {building,shot} from './parts/building.mjs';
import {M} from './materials.mjs';
export function buildPorchHouse(options={}){
 const h=building('porch-house',[-5,5,-6,6],{palette:'blue',fence:true,storeys:2,...options}),{B,C}=h;h.base();
 if(!['classic','paired'].includes(C.windowStyle??'classic'))throw Error('Unknown house window style');
 const up=3.38,top=6.58,st=h.stairs(2,-4.15,.18,up);h.slab(up,st.void);h.guard(st,up);
 for(const y of [.18,up]){
  const front=y<1?[[-3.9,-1.8,y+.7,y+2.35],[-.65,.65,y,y+2.4],[2.3,4.2,y+.7,y+2.35]]:[[-3.9,-2.2,y+.7,y+2.4],[-.7,1,y+.7,y+2.4],[2.7,4.2,y+.7,y+2.4]];
  if(C.windowStyle==='paired'){front.splice(0,1,[-4.2,-3,y+.7,y+2.35],[-2.8,-1.6,y+.7,y+2.35]);}
  h.facade('z',[-6,-5.82],-5,5,y,y+3.02,front);h.facade('z',[5.82,6],-5,5,y,y+3.02,[[-4,-2.4,y+.7,y+2.35],[-.65,.65,y,y+2.4],[2.8,4.3,y+.7,y+2.35]].filter((o,i)=>y<1||i!==1));
  for(const x of [-5,4.82])h.facade('x',[x,x+.18],-5.82,5.82,y,y+3.02,[[-4,-2.5,y+.7,y+2.35],[2.7,4.2,y+.7,y+2.35]]);
  for(const z of [-6.11,6.03])B([-5,y+2.9,z],[5,y+3.02,z+.08],M.trim,'cornice',[10,1,1]);
  h.wall('z',[1,1.14],-4.82,4.82,y,y+3.02,[[-.65,.65,y,y+2.3]],M.plaster,'interior-wall');
 }
 h.wall('x',[1.1,1.24],1.14,5.82,up,top-.18,[[2.2,3.5,up,up+2.3]],M.plaster,'interior-wall');
 h.roof(top,1.8);h.door(0,-5.82,.18);
 // Covered veranda: actual posts, deck and supported roof, with a clear central entrance.
 B([-5,.06,-8.1],[5,.18,-6],M.oak,'porch-deck',[10,1,3]);
 for(const x of [-4.65,-1.2,1.2,4.65])B([x-.075,.18,-7.95],[x+.075,2.95,-7.8],M.trim,'porch-post',[1,3,1]);
 B([-5,2.95,-8.15],[5,3.07,-6.11],M.trim,'porch-ceiling',[10,1,2]);
 for(let x=-5;x<5;x+=1)h.b.piece({axis:'x',lo:x,hi:x+1,poly:[[3.07,-8.15],[3.07,-6.11],[3.4,-6.11],[3.17,-8.15]],material:M.roof,type:'porch-roof'});
 h.rail(-4.5,-7.94,-1.5,-7.94,.18);h.rail(1.5,-7.94,4.5,-7.94,.18);
 if(C.furnished){h.prop('sofa',-4.25,.18,-3.3,90);h.prop('table',-.3,.18,-1.1);h.prop('chair',-.3,.18,-.25);h.prop('chair',-.3,.18,-1.95,180);h.prop('sink',-3.8,.18,5.5);h.prop('hob',-2.6,.18,5.5);h.prop('refrigerator',-4.5,.18,3.8,270);h.prop('cabinet',3.6,.18,5.5);h.prop('bed',-3.3,up,4.1);h.prop('cabinet',-.1,up,5.5);h.prop('sink',3.8,up,5.5);h.prop('toilet',2,up,4.9);h.prop('bathtub',3.9,up,2.5);h.prop('table',-.6,up,-2.5);h.prop('chair',-.6,up,-1.65);}
 if(C.fence){for(const x of [-3.6,-1.2,3.6])h.prop('fence',x,0,-10.8);h.prop('gate',1.2,0,-10.8);for(const x of [-4.8,4.8])h.prop('fence',x,0,-9.6,90,{omitLeftPost:true});}
 h.entrances.push({name:'front',at:[0,.18,-6],clearWidth:1.3},{name:'garden',at:[0,.18,6],clearWidth:1.3});
 h.room('living-dining',0,[-4.82,.18,-5.82],[1.9,3.2,1],[1.3,1.83,-4.9],[-3,1,-1.8]);h.room('kitchen',0,[-4.82,.18,1.14],[4.82,3.2,5.82],[2,1.83,2],[-2,1,5.4]);
 h.room('study',1,[-4.82,up,-5.82],[1.9,6.4,1],[1.2,up+1.65,-4.5],[-2,up+.8,-2]);h.room('bedroom',1,[-4.82,up,1.14],[1.1,6.4,5.82],[.4,up+1.65,1.8],[-3,up+.7,4]);h.room('bathroom',1,[1.24,up,1.14],[4.82,6.4,5.82],[1.8,up+1.65,1.7],[3.6,up+.7,4.5]);
 h.cameras.porch={position:[-8,2,-10],target:[0,1.6,-6.7]};h.cameras.garden={position:[9,2,10],target:[0,2,4]};
 h.point('street',1.2,0,-12);h.point('gate',1.2,0,-9.2);h.point('porch',0,.18,-7);h.point('living',0,.18,-4.8);h.point('hall',1.1,.18,-3);h.point('kitchen-approach',1.1,.18,.2);h.point('kitchen-door',0,.18,.3);h.point('kitchen',0,.18,2);h.point('rear-door',0,.18,5.3);h.point('garden',0,0,7);h.point('rear-return',0,.18,5.3);h.point('kitchen-return',0,.18,2);h.point('hall-return',0,.18,.3);h.point('dining-clear-aisle',1.2,.18,.3);h.point('stair-approach',1.2,.18,-5.2);h.point('stair-lobby',2.685,.18,-5.2);h.route.push(...st.ascent);h.point('upper-hall',3.935,up,-5.25);h.point('study-entry',1.2,up,-5.25);h.point('study',1.2,up,-3);h.point('study-rear',1.2,up,.3);h.point('bedroom-door',0,up,.3);h.point('bedroom',0,up,2.8);h.point('bathroom',2,up,2.8);
 const shots={glazing:[shot([-3,1.6,-6.5],[-3,1.6,-5.9],200000,.07,0,6)],wall:[shot([-6,1.3,0],[-4.9,1.3,0],2000000,.25,0,20)],furniture:[shot([-.3,1.75,-1.1],[-.3,.95,-1.1],40000,.3,0,30)],collapse:h.collapseShots()};if(C.fence)shots.fence=[shot([-3.3,.7,-11.4],[-3.3,.7,-10.8],20000,.13,0,8)];
 return h.finish('Bayline · Juniper porch house',shots);
}
