import {boundsFor} from './geometry.mjs';
import {ballisticRound} from '../scripts/cannon.mjs';

/** Find a clear swept-ball approach, excluding only the intended target. */
export function clearTourSightlines(pack,chapters){
 const s=pack.scenario,bounds=s.nodes.map((n,i)=>boundsFor(n,s.nodeColliders[i].kind==='shape'?s.shapeLibrary[s.nodeColliders[i].shape]:s.nodeColliders[i]));
 const obstructed=(shot,c)=>{
  const {muzzle, to, direction, speed,radius}=shot;
  const duration=Math.hypot(to[0]-muzzle[0],to[2]-muzzle[2])/(speed*Math.hypot(direction[0],direction[2]));
  const samples=Array.from({length:61},(_,j)=>{const t=duration*j/60;return muzzle.map((v,k)=>v+direction[k]*speed*t-(k===1?4.905*t*t:0));});
  for(let i=0;i<bounds.length;i++){
   if(i>=c.nodeStart&&i<c.nodeStart+c.nodeCount)continue;
   const b=bounds[i];
   if([0,2].some(k=>Math.max(muzzle[k],to[k])+radius<b[0][k]||Math.min(muzzle[k],to[k])-radius>b[1][k]))continue;
   if(samples.some(p=>p.every((v,k)=>v>=b[0][k]-radius&&v<=b[1][k]+radius)))return true;
  }
  return false;
 };
 for(const c of chapters){
  const original=c.shot,candidates=[original];
  for(const distance of [6,4,3])for(let i=0;i<8;i++){
   const angle=i*Math.PI/4,to=original.to;
   candidates.push(ballisticRound({from:[to[0]+Math.sin(angle)*distance,Math.max(1.65,to[1]),to[2]+Math.cos(angle)*distance],to,mass:original.mass,speed:original.speed}));
  }
  const shot=candidates.find(shot=>!obstructed(shot,c));if(!shot)throw Error(`No clear cannon sightline for ${c.title}`);
  c.shot=shot;
  const [x,y,z]=shot.muzzle,direction=shot.direction;
  c.camera={position:[x+direction[2]*1.6,y+1.3,z-direction[0]*1.6],target:[shot.to[0],shot.to[1]+(['shade','street','ornamental'].includes(c.type)?1.2:0),shot.to[2]]};
 }
}
