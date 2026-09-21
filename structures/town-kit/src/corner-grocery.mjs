import {addSign} from './parts/sign.mjs';
import {building,shot} from './parts/building.mjs';
import {M} from './materials.mjs';
export function buildCornerGrocery(options={}){
 const h=building('corner-grocery',[-6,6,-5,5],{palette:'ochre',storeys:2,...options}),{B,C}=h;if(C.brickColor)h.b.table[M.brick].color=C.brickColor;if(C.joineryColor)h.b.table[M.dark].color=C.joineryColor;h.base();
 const up=3.78,top=6.98,st=h.stairs(3,-.5,.18,up);h.slab(up,st.void);h.guard(st,up);
 for(const y of [.18,up]){
  const height=y<1?3.42:3.02,front=y<1?[[-5.4,-3.9,y+.45,y+2.6],[-3.6,-2.3,y,y+2.5],[-2,.2,y+.45,y+2.6],[3.8,5.2,y,y+2.5]]:[[-5,-3.4,y+.7,y+2.4],[-1.8,-.2,y+.7,y+2.4],[2.8,4.4,y+.7,y+2.4]];
  h.windowWall('z',[-5,-4.82],-6,6,y,y+height,front,M.brick);h.windowWall('z',[4.82,5],-6,6,y,y+height,[[-4.7,-3.1,y+.8,y+2.35],[-.7,.7,y,y+2.4]].filter((o,i)=>y<1||i===0),M.brick);
  for(const x of [-6,5.82])h.windowWall('x',[x,x+.18],-4.82,4.82,y,y+height,[[-3.5,-1.5,y+.8,y+2.35],[1.5,3.2,y+.8,y+2.35]],M.brick);
  for(const z of [-5.1,5])B([-6,y+height-.12,z],[6,y+height,z+.1],M.trim,'stone-band',[12,1,1]);
 }
 h.wall('z',[2,2.16],-5.82,2.8,.18,3.6,[[-.7,.7,.18,2.6]],M.plaster,'stockroom-wall');
 h.wall('z',[1,1.14],-5.82,2.8,up,top-.18,[[-3.5,-2.2,up,up+2.3],[.65,1.95,up,up+2.3]],M.plaster,'apartment-wall');
 h.wall('x',[-.15,0],1.14,4.82,up,top-.18,[],M.plaster,'bedroom-wall');
 h.wall('x',[2.25,2.4],-4.82,-2.25,up,top-.18,[[-3.6,-2.3,up,up+2.3]],M.plaster,'bathroom-wall');
 h.wall('z',[-2.25,-2.1],2.4,5.82,up,top-.18,[],M.plaster,'bathroom-wall');
 const roofStart=h.b.s.nodes.length;h.slab(top);for(let i=roofStart;i<h.b.s.nodes.length;i++)h.b.s.nodeTypes[i]='ceiling';for(const x of [-6,5.82])B([x,top,-5],[x+.18,top+.6,5],M.brick,'parapet',[1,2,8]);for(const z of [-5,4.82])B([-5.82,top,z],[5.82,top+.6,z+.18],M.brick,'parapet',[10,2,1]);
 for(const z of [-5.05,4.82])B([-6.05,top+.6,z],[6.05,top+.69,z+.23],M.trim,'parapet-cap',[10,1,1]);for(const x of [-6.05,5.82])B([x,top+.6,-4.82],[x+.23,top+.69,4.82],M.trim,'parapet-cap',[1,1,8]);
 // Deep storefront fascia and striped fixed awning, all bonded construction.
 B([-5.8,2.95,-5.12],[2,3.35,-5],M.dark,'shop-fascia',[8,1,1]);
 for(let x=-5.8;x<2-.001;x+=.39)B([x,2.78,-5.85],[Math.min(x+.39,2),2.85,-5],Math.round((x+5.8)/.39)%2?M.trim:M.dark,'awning',[1,1,2]);
 B([-5.8,2.78,-5.94],[2,2.93,-5.85],M.dark,'awning-valance',[10,1,1]);
 for(const x of [-5.8,1.9])B([x,2.85,-5.12],[x+.1,2.95,-5],M.metal,'awning-bracket');
 addSign(h.b,C.signText??'GROCER',{centerX:-1.9,y:2.99,faceZ:-5.12,mirrored:C.mirrored});
 if(C.furnished){for(const z of [-2.6,-.8,.9])h.prop('shelf',-4.8,.18,z,90);for(const z of [-1.7,.4])h.prop('shelf',-.7,.18,z,90);h.prop('counter',1.35,.18,-2.6);h.prop('shelf',-4.1,.18,4.5);h.prop('shelf',1.5,.18,4.5);h.prop('refrigerator',-2,.18,4.5);h.prop('sofa',-5.25,up,-2.5,90);h.prop('table',-.5,up,-2.5);h.prop('chair',-.5,up,-1.65);h.prop('bed',-4,up,3.5);h.prop('cabinet',-1,up,4.5);h.prop('sink',.6,up,4.5);h.prop('hob',1.8,up,4.5);h.prop('sink',5.5,up,-3.8,90);h.prop('toilet',3.3,up,-4.1);}
 h.entrances.push({name:'shop',at:[-2.95,.18,-5],clearWidth:1.3},{name:'flat-stair',at:[4.5,.18,-5],clearWidth:1.4},{name:'delivery',at:[0,.18,5],clearWidth:1.4});
 h.room('sales-floor',0,[-5.82,.18,-4.82],[2.8,3.6,2],[-2.9,1.83,-4.3],[-.7,1,.5]);h.room('stockroom',0,[-5.82,.18,2.16],[2.8,3.6,4.82],[.2,1.83,2.6],[-3,1,4]);h.room('flat-living',1,[-5.82,up,-4.82],[2.25,6.8,1],[1.5,up+1.65,-3.9],[-3,up+.9,-2]);h.room('flat-bedroom',1,[-5.82,up,1.14],[-.15,6.8,4.82],[-1,up+1.65,1.8],[-4,up+.8,3.5]);h.room('flat-kitchen',1,[0,up,1.14],[2.8,6.8,4.82],[2.2,up+1.65,1.6],[1,up+.9,4.4]);h.room('flat-bathroom',1,[2.4,up,-4.82],[5.82,6.8,-2.25],[2.8,up+1.65,-2.5],[4.7,up+.8,-3.8]);
 h.cameras.storefront={position:[-8,1.8,-10],target:[-1.8,1.9,-4.8]};
 h.point('street',-2.95,0,-7);h.point('shop-entry',-2.95,.18,-4);h.point('sales-aisle',-2.95,.18,.7);h.point('stock-approach',0,.18,1.3);h.point('stockroom',0,.18,3.2);h.point('delivery',0,0,6);h.point('stock-return',0,.18,3.2);h.point('shop-return',0,.18,1.3);h.point('checkout',1.8,.18,1.3);h.point('stair-hall',2.5,.18,-3.8);h.point('flat-entry',4.5,.18,-3.8);h.point('flat-exit',4.5,0,-6);h.point('flat-return',4.5,.18,-3.8);h.point('stair-approach',3.685,.18,-1.4);h.route.push(...st.ascent);h.point('flat-hall',4.935,up,-1.5);h.point('flat-hall-left',1.7,up,-1.5);h.point('bathroom-door',1.7,up,-2.9);h.point('flat-bathroom',3.9,up,-2.9);h.point('bathroom-return',1.7,up,-2.9);h.point('living-entry',1.7,up,-.1);h.point('living',-2.8,up,-.1);h.point('flat-bedroom',-2.8,up,2.1);h.point('bedroom-return',-2.8,up,-.1);h.point('kitchen-door',1.3,up,-.1);h.point('flat-kitchen',1.3,up,2.6);
 return h.finish('Bayline · Redbrick corner grocery',{glazing:[shot([-4.6,1.7,-5.5],[-4.6,1.7,-4.9],20000,.07,0,6)],wall:[shot([-7,1.3,0],[-5.9,1.3,0],2000000,.25,0,20)],furniture:[shot([-.5,up+1.5,-2.5],[-.5,up+.77,-2.5],40000,.3,0,30)],collapse:h.collapseShots()});
}
