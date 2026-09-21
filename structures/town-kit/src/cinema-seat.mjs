import {Builder} from './geometry.mjs';
import {M} from './materials.mjs';
/** Freestanding upholstered cinema chair; no invisible floor anchors. */
export function buildCinemaSeat({palette='rose'}={}){
 const b=new Builder('cinema-seat',{palette,group:'prop-cinema-seat'});b.table[M.fabric].color='#842f36';b.table[M.dark].color='#3e4541';
 const box=(min,max,m,type,split=[1,1,1])=>b.box({min,max,material:m,type,split});
 for(const x of [-.235,.19])for(const z of [-.23,.185])box([x,0,z],[x+.045,.42,z+.045],M.dark,'seat-leg',[1,2,1]);
 box([-.28,.42,-.27],[.28,.47,.25],M.dark,'seat-frame',[2,1,1]);
 box([-.25,.47,-.25],[.25,.55,.21],M.fabric,'seat-cushion',[2,1,1]);
 box([-.28,.47,.21],[.28,1,.27],M.dark,'back-frame',[2,1,1]);
 box([-.25,.58,.16],[.25,.96,.21],M.fabric,'back-cushion',[2,1,1]);
 for(const x of [-.30,.26]){box([x,.47,-.18],[x+.04,.67,-.14],M.dark,'arm-post');box([x,.67,-.23],[x+.04,.72,.21],M.dark,'armrest');}
 return {pack:b.build(),metadata:{kind:'prop',type:'cinema-seat',route:[],shots:{furniture:[{from:[0,1.52,0],to:[0,.5,0],momentum:40000,radius:.25,speed:20,tick:0}]},shotGroups:{furniture:'prop-cinema-seat'}}};
}
