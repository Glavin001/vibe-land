import {building,shot} from './parts/building.mjs';
import {M} from './materials.mjs';
/** One-storey home sharing real envelope, room, furniture and porch parts. */
export function buildBungalow(options={}){
 const h=building('bungalow',[-5,5,-6,6],{palette:'ochre',storeys:1,fence:true,porch:'full',windowStyle:'paired',...options},[1]),{B,C}=h;
 if(!['full','entry'].includes(C.porch)||!['paired','wide'].includes(C.windowStyle))throw Error('Invalid bungalow façade option');
 h.base();const y=.18,top=3.38;
 const front=C.windowStyle==='paired'?[[-4.25,-2.95,.9,2.62],[-2.75,-1.45,.9,2.62],[2,4.15,.9,2.62]]:[[-4.2,-1.5,.85,2.62],[2,4.1,.85,2.62]];
 h.facade('z',[-6,-5.82],-5,5,y,3.2,[...front,[-.65,.65,y,2.58]]);
 h.facade('z',[5.82,6],-5,5,y,3.2,[[-4,-2.4,.9,2.6],[-.65,.65,y,2.58],[2.8,4.3,.9,2.6]]);
 for(const x of [-5,4.82])h.facade('x',[x,x+.18],-5.82,5.82,y,3.2,[[-4,-2.5,.9,2.6],[2.7,4.2,.9,2.6]]);
 for(const z of [-6.11,6.03])B([-5,3.08,z],[5,3.2,z+.08],M.trim,'cornice',[10,1,1]);
 h.wall('z',[1,1.14],-4.82,4.82,y,3.2,[[-.65,.65,y,2.48]],M.plaster,'interior-wall');
 h.wall('x',[1.1,1.24],1.14,5.82,y,3.2,[[2.2,3.5,y,2.48]],M.plaster,'interior-wall');
 h.wall('x',[1.66,1.8],-1.5,1,y,3.2,[[-.9,.4,y,2.48]],M.plaster,'bathroom-wall');
 h.wall('z',[-1.64,-1.5],1.66,4.82,y,3.2,[],M.plaster,'bathroom-wall');
 h.roof(top,C.windowStyle==='paired'?1.65:1.3);h.door(0,-5.82,y);
 const half=C.porch==='full'?5:2.5;
 B([-half,.06,-8.1],[half,.18,-6],M.oak,'porch-deck',[Math.ceil(half*2),1,3]);
 for(const x of C.porch==='full'?[-4.65,-1.2,1.2,4.65]:[-2.15,2.15])B([x-.075,y,-7.95],[x+.075,2.95,-7.8],M.trim,'porch-post',[1,3,1]);
 B([-half,2.95,-8.15],[half,3.07,-6.11],M.trim,'porch-ceiling',[Math.ceil(half*2),1,2]);
 for(let x=-half;x<half;x+=1)h.b.piece({axis:'x',lo:x,hi:Math.min(x+1,half),poly:[[3.07,-8.15],[3.07,-6.11],[3.24,-6.11],[3.17,-8.15]],material:M.roof,type:'porch-roof'});
 h.rail(-half+.5,-7.94,-1.5,-7.94,y);h.rail(1.5,-7.94,half-.5,-7.94,y);
 if(C.furnished){h.prop('sofa',-4.25,y,-3.3,90);h.prop('table',-.3,y,-1.1);h.prop('chair',-.3,y,-.25);h.prop('chair',-.3,y,-1.95,180);h.prop('bed',-3.3,y,4.1);h.prop('cabinet',-4.5,y,1.9,270);h.prop('sink',2.4,y,5.5);h.prop('hob',3.6,y,5.5);h.prop('refrigerator',4.5,y,3.8,90);h.prop('sink',4.5,y,-.8,90);h.prop('toilet',3.1,y,.55);}
 if(C.fence){for(const x of [-3.6,-1.2,3.6])h.prop('fence',x,0,-10.8);h.prop('gate',1.2,0,-10.8);for(const x of [-4.8,4.8])h.prop('fence',x,0,-9.6,90,{omitLeftPost:true});}
 h.entrances.push({name:'front',at:[0,y,-6],clearWidth:1.3},{name:'garden',at:[0,y,6],clearWidth:1.3});
 h.room('living-dining',0,[-4.82,y,-5.82],[1.66,3.2,1],[1.25,1.83,-4.9],[-3,1,-1.8]);
 h.room('bedroom',0,[-4.82,y,1.14],[1.1,3.2,5.82],[.4,1.83,1.8],[-3,.9,4]);
 h.room('kitchen',0,[1.24,y,1.14],[4.82,3.2,5.82],[1.8,1.83,1.7],[3.5,1,5.4]);
 h.room('bathroom',0,[1.8,y,-1.5],[4.82,3.2,1],[2.05,1.83,-1.1],[4,.8,.4]);
 h.point('street',1.2,0,-12);h.point('gate',1.2,0,-9.2);h.point('porch',0,y,-7);h.point('living',0,y,-4.8);h.point('hall',1.1,y,-3);h.point('bath-approach',1.1,y,-.5);h.point('bathroom',2.5,y,-.5);h.point('bath-return',1.1,y,-.5);h.point('hall-rear',1.1,y,.3);h.point('bed-door',0,y,.3);h.point('bedroom',0,y,2.8);h.point('kitchen',2,y,2.8);h.point('kitchen-return',0,y,2.8);h.point('rear-door',0,y,5.3);h.point('garden',0,0,7);
 return h.finish(`Bayline · ${C.porch==='full'?'Veranda':'Garden'} bungalow`,{glazing:[shot([-3.5,1.6,-6.5],[-3.5,1.6,-5.9],200000,.07,0,6)],wall:[shot([-6,1.3,0],[-4.9,1.3,0],2000000,.25,0,20)],furniture:[shot([-.3,1.75,-1.1],[-.3,.95,-1.1],40000,.3,0,30)],collapse:h.collapseShots()});
}
