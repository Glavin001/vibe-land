import { clamp, distance, type SoundEvent, type Vec3 } from './model';
export interface DirectorStats { received:number; grouped:number; dropped:number; stale:number; selected:number; }
interface PendingSound {
  key:string;
  event:SoundEvent;
  score:number;
  index:number;
  order:number;
}
/** Bounded event reduction before allocating any Web Audio nodes. The indexed
 * min-heap makes overload replacement O(log capacity), even when every new
 * event outranks the preceding one. Listener movement rebuilds it once. */
export class AudioDirector {
  readonly stats:DirectorStats={received:0,grouped:0,dropped:0,stale:0,selected:0};
  private pending=new Map<string,PendingSound>();
  private heap:PendingSound[]=[];
  private recent=new Map<string,number>();
  private listenerPosition:Vec3=[0,0,0];
  private prioritiesDirty=false;
  private order=0;
  constructor(readonly capacity=256,readonly perFrame=12){}
  get listener():Vec3 {return this.listenerPosition;}
  set listener(value:Vec3) {
    if(value.some((coordinate,i)=>coordinate!==this.listenerPosition[i])){
      this.listenerPosition=[...value];this.prioritiesDirty=true;
    }
  }
  score(e:SoundEvent):number {
    const d=distance(e.position,this.listenerPosition);
    return (e.protected?12:0)+(e.kind==='flyby'?8:0)+(e.kind==='collapse'?2:0)+e.intensity*4-Math.log1p(d)*1.4;
  }
  private weaker(a:PendingSound,b:PendingSound):boolean {
    // Equal priorities evict the earliest insertion, matching Map iteration
    // in the former scan. Stable ordering makes repeated replays comparable.
    return a.score<b.score||(a.score===b.score&&a.order<b.order);
  }
  private swap(a:number,b:number):void {
    const first=this.heap[a];this.heap[a]=this.heap[b];this.heap[b]=first;
    this.heap[a].index=a;this.heap[b].index=b;
  }
  private up(index:number):number {
    while(index>0){const parent=(index-1)>>>1;if(!this.weaker(this.heap[index],this.heap[parent]))break;this.swap(index,parent);index=parent;}
    return index;
  }
  private down(index:number):void {
    while(true){
      const left=index*2+1;if(left>=this.heap.length)return;
      const right=left+1,child=right<this.heap.length&&this.weaker(this.heap[right],this.heap[left])?right:left;
      if(!this.weaker(this.heap[child],this.heap[index]))return;
      this.swap(index,child);index=child;
    }
  }
  private refreshPriorities():void {
    if(!this.prioritiesDirty)return;
    for(const entry of this.heap)entry.score=this.score(entry.event);
    for(let i=(this.heap.length>>>1)-1;i>=0;i--)this.down(i);
    this.prioritiesDirty=false;
  }
  private remove(entry:PendingSound):void {
    this.pending.delete(entry.key);
    const index=entry.index,last=this.heap.pop()!;
    if(last!==entry){this.heap[index]=last;last.index=index;this.down(this.up(index));}
    entry.index=-1;
  }
  enqueue(e:SoundEvent):void {
    this.stats.received++;
    if(!Number.isFinite(e.atMs)||!e.position.every(Number.isFinite)||!Number.isFinite(e.intensity)) {this.stats.dropped++;return;}
    if(this.recent.has(e.id)){this.stats.grouped++;return;}
    this.refreshPriorities();
    const cell=e.protected||e.kind==='flyby'||e.kind==='shot'?e.id:`${e.kind}:${e.material}:${Math.floor(e.position[0]/5)}:${Math.floor(e.position[1]/5)}:${Math.floor(e.position[2]/5)}:${Math.floor(e.atMs/65)}`;
    const old=this.pending.get(cell);
    if(old){
      this.stats.grouped++;
      if(e.intensity>old.event.intensity){
        old.event={...e,position:[...e.position],intensity:clamp(e.intensity+.035)};
        old.score=this.score(old.event);this.down(this.up(old.index));
      }
      return;
    }
    const score=this.score(e);
    if(this.pending.size>=this.capacity){
      this.stats.dropped++;
      const weakest=this.heap[0];
      if(!weakest||score<=weakest.score)return;
      this.remove(weakest);
    }
    const entry:PendingSound={key:cell,event:{...e,position:[...e.position]},score,index:this.heap.length,order:this.order++};
    this.pending.set(cell,entry);this.heap.push(entry);this.up(entry.index);
  }
  drain(nowMs:number,play:(e:SoundEvent)=>void):void {
    this.refreshPriorities();
    const due:PendingSound[]=[];
    for(const entry of this.pending.values()){
      const e=entry.event;
      if(e.atMs>nowMs+35)continue;
      this.remove(entry);
      if(nowMs-e.atMs>300){this.stats.stale++;continue;}
      if(distance(e.position,this.listenerPosition)>450&&!e.protected){this.stats.dropped++;continue;}
      due.push(entry);
    }
    due.sort((a,b)=>b.score-a.score||a.event.seed-b.event.seed||a.order-b.order);
    due.forEach(({event:e},i)=>{if(i>=this.perFrame){this.stats.dropped++;return;}this.recent.set(e.id,nowMs);this.stats.selected++;play(e);});
    for(const [key,t] of this.recent)if(nowMs-t>2500)this.recent.delete(key);
    while(this.recent.size>1024)this.recent.delete(this.recent.keys().next().value!);
  }
  clear():void {this.pending.clear();this.heap=[];this.recent.clear();this.prioritiesDirty=false;this.order=0;}
  get queued():number{return this.pending.size;}
}
