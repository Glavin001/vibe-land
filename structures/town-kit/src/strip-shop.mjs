import {building,shot} from './parts/building.mjs';
import {addSign} from './parts/sign.mjs';
import {M} from './materials.mjs';
/** Independent shop module: shared outdoor promenade, separate structure. */
export function buildStripShop(options={}){
 const h=building('strip-shop',[-3,3,-5,5],{storeys:1,palette:'cream',signText:'BOOKS',furnished:true,...options},[1]),{B,C}=h;
 h.base();
 h.facade('z',[-5,-4.82],-3,3,.18,3.38,[[-2.55,-.7,.73,2.73],[.55,1.85,.18,2.63]]);
 h.facade('z',[4.82,5],-3,3,.18,3.38,[[-.65,.65,.18,2.63],[1.35,2.45,1.13,2.53]]);
 for(const x of [-3,2.82])h.wall('x',[x,x+.18],-4.82,4.82,.18,3.38,[],M.wall,'party-wall');
 h.wall('z',[1.7,1.84],-2.82,2.82,.18,3.38,[[-.65,.65,.18,2.63]],M.plaster,'stockroom-wall');
 const roofStart=h.b.s.nodes.length;h.slab(3.56);for(let i=roofStart;i<h.b.s.nodes.length;i++)h.b.s.nodeTypes[i]='ceiling';
 for(const x of [-3,2.85])B([x,3.56,-5],[x+.15,3.96,5],M.siding,'parapet',[1,1,8]);
 for(const z of [-5,4.85])B([-2.85,3.56,z],[2.85,3.96,z+.15],M.siding,'parapet',[5,1,1]);
 for(const z of [-5.04,4.85])B([-3.04,3.96,z],[3.04,4.03,z+.19],M.trim,'parapet-cap',[6,1,1]);
 for(const x of [-3.04,2.85])B([x,3.96,-4.85],[x+.19,4.03,4.85],M.trim,'parapet-cap',[1,1,8]);
 B([-2.85,2.96,-5.15],[2.85,3.36,-5.03],M.dark,'shop-fascia',[6,1,1]);
 addSign(h.b,C.signText,{centerX:0,y:3.01,faceZ:-5.15,mirrored:C.mirrored,pixelX:.12});
 for(let x=-2.9;x<2.89;x+=.4)B([x,2.78,-6.2],[Math.min(x+.4,2.9),2.86,-5.03],Math.round((x+2.9)/.4)%2?M.trim:M.dark,'awning',[1,1,2]);
 for(const x of [-2.8,2.7])B([x,2.86,-5.15],[x+.1,2.96,-5.03],M.metal,'awning-bracket');
 h.door(1.2,-4.82,.18);
 if(C.furnished){
  if(['CAFE','BAKERY','DELI'].includes(C.signText)){h.prop('table',-1.6,.18,-2.4);h.prop('chair',-1.6,.18,-1.55);h.prop('chair',-1.6,.18,-3.25,180);h.prop('sink',-1.8,.18,4.5);}
  else{h.prop('shelf',-2.45,.18,-2.8,90);h.prop('shelf',-2.45,.18,-.5,90);h.prop('shelf',-1.8,.18,4.5);}
  h.prop('counter',1.9,.18,.7);h.prop('shelf',1.8,.18,4.5);
 }
 h.entrances.push({name:'shopfront',at:[1.2,.18,-5],clearWidth:1.3},{name:'delivery',at:[0,.18,5],clearWidth:1.3});
 h.room('shop',0,[-2.82,.18,-4.82],[2.82,3.38,1.7],[1.4,1.83,-3.9],[-1.5,1,-.6]);
 h.room('stockroom',0,[-2.82,.18,1.84],[2.82,3.38,4.82],[.6,1.83,2.2],[-1.8,1,4]);
 h.point('street',1.2,0,-7);h.point('entry',1.2,.18,-3.9);h.point('sales-floor',.8,.18,-.7);h.point('stock-approach',0,.18,.9);h.point('stockroom',0,.18,3);h.point('rear-door',0,.18,4.4);h.point('delivery',0,0,6.3);
 return h.finish(`Bayline · ${C.signText.toLowerCase()} shop`,{glazing:[shot([-1.6,1.5,-5.5],[-1.6,1.5,-4.9],20000,.07,0,6)],wall:[shot([-4,1.3,0],[-2.9,1.3,0],2000000,.25,0,20)],collapse:h.collapseShots()});
}
