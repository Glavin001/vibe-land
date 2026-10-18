import { distance, type Vec3 } from './model';
export type AcousticRaycast=(origin:[number,number,number],direction:[number,number,number],maxDistance:number)=>{toi:number}|null;
/** Short-lived cache follows destroyed geometry without adding a ray per body. */
export class AcousticOcclusion {
  private cache=new Map<string,{at:number;value:number}>();
  private window=-Infinity;
  private queries=0;
  constructor(private readonly raycast:AcousticRaycast){}
  sample(listener:Vec3,source:Vec3,now:number):number{
    if(now-this.window>100){this.window=now;this.queries=0;}
    const key=[...listener,...source].map(v=>Math.floor(v/3)).join(':');
    const old=this.cache.get(key);if(old&&now-old.at<250)return old.value;
    if(this.queries>=6)return old?.value??0;
    const d=distance(source,listener);if(d<1)return 0;
    this.queries++;
    const dir=source.map((v,i)=>(v-listener[i])/d) as [number,number,number];
    const hit=this.raycast([...listener],dir,d-.7);
    const value=hit&&hit.toi<d-.7?.7:0;
    this.cache.set(key,{at:now,value});
    if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
  clear():void{this.cache.clear();}
}
