import { clamp, distance, type AcousticMaterial, type SoundEvent, type Vec3 } from './model';
import { sourceAttenuation } from './destructionMix';

export interface ActivityEmitter {id:string;position:Vec3;material:AcousticMaterial;intensity:number;occlusion:number;}
interface Region {
  key:string;position:Vec3;material:AcousticMaterial;energy:number;occlusion:number;
  time:number;lastEvent:number;strength:number;pending:Float32Array;due:Float64Array;
}
const SLOTS=64, BINS=32, BIN_MS=32, DECAY_MS=1050;
function hash(key:string):number {let n=2166136261;for(let i=0;i<key.length;i++)n=Math.imul(n^key.charCodeAt(i),16777619);return n>>>0;}

/** Energy from the original facts survives event/voice reduction as at most
 * four material textures. Fixed two-choice spatial storage bounds insertion
 * cost even for a burst spanning thousands of distinct regions. */
export class DestructionActivity {
  private regions:(Region|undefined)[]=new Array(SLOTS);
  private recent=new Map<string,number>();
  private history:({id:string;time:number}|undefined)[]=new Array(2048);
  private historyIndex=0;
  private selected=new Set<string>();
  add(e:SoundEvent,listener:Vec3,nowMs:number):void {
    if(e.kind!=='impact'&&e.kind!=='fracture'&&e.kind!=='collapse')return;
    if(!Number.isFinite(e.atMs)||!Number.isFinite(e.size)||!Number.isFinite(e.intensity)||!e.position.every(Number.isFinite))return;
    const previous=this.recent.get(e.id);
    if(e.atMs<nowMs-300||e.atMs>nowMs+750||distance(e.position,listener)>120||e.intensity<.2||(previous!==undefined&&nowMs-previous<3000))return;
    const old=this.history[this.historyIndex];
    if(old&&this.recent.get(old.id)===old.time)this.recent.delete(old.id);
    this.recent.set(e.id,e.atMs);
    this.history[this.historyIndex]={id:e.id,time:e.atMs};this.historyIndex=(this.historyIndex+1)%2048;
    const contribution=clamp(e.intensity)**2*Math.min(2.5,.2+Math.sqrt(Math.max(0,e.size))*.7)*(e.kind==='collapse'?1.7:e.kind==='fracture'?1.25:1);
    const key=`${e.material}:${Math.floor(e.position[0]/10)}:${Math.floor(e.position[1]/10)}:${Math.floor(e.position[2]/10)}`;
    const h=hash(key),a=h%SLOTS,b=(a+1+((h>>>8)%(SLOTS-1)))%SLOTS;
    const strength=contribution*sourceAttenuation(distance(e.position,listener),4);
    let index=this.regions[a]?.key===key?a:this.regions[b]?.key===key?b:-1;
    if(index<0){
      const rank=(r:Region|undefined)=>r?r.strength*Math.exp(-Math.max(0,nowMs-r.lastEvent)/DECAY_MS):0;
      index=rank(this.regions[a])<=rank(this.regions[b])?a:b;
      if(rank(this.regions[index])>strength)return;
      this.regions[index]={key,position:[...e.position],material:e.material,energy:0,occlusion:clamp(e.occlusion??0),time:nowMs,lastEvent:e.atMs,strength,pending:new Float32Array(BINS),due:new Float64Array(BINS)};
    }
    const region=this.regions[index]!;
    // Never pull a region to another cell; a gentle weighted centroid keeps
    // simultaneous debris on opposite sides of the listener separate.
    const blend=Math.min(.25,contribution/(region.energy+contribution+1));
    region.position=region.position.map((v,i)=>v+(e.position[i]-v)*blend) as [number,number,number];
    region.occlusion+=(clamp(e.occlusion??0)-region.occlusion)*blend;
    region.strength=Math.max(region.strength*Math.exp(-Math.max(0,e.atMs-region.lastEvent)/DECAY_MS),strength);
    region.lastEvent=Math.max(region.lastEvent,e.atMs);
    const due=e.atMs,slot=((Math.floor(due/BIN_MS)%BINS)+BINS)%BINS;
    if(region.due[slot]!==0&&Math.abs(region.due[slot]-due)>BIN_MS)region.pending[slot]=0;
    region.pending[slot]=Math.min(20,region.pending[slot]+contribution);
    region.due[slot]=Math.max(region.due[slot],due);
  }
  sample(nowMs:number,listener:Vec3):ActivityEmitter[] {
    const candidates:(ActivityEmitter&{score:number})[]=[];
    for(let index=0;index<this.regions.length;index++){
      const r=this.regions[index];if(!r)continue;
      r.energy*=Math.exp(-Math.max(0,nowMs-r.time)/DECAY_MS);r.time=nowMs;
      for(let i=0;i<BINS;i++)if(r.pending[i]>0&&r.due[i]<=nowMs){
        r.energy=Math.min(20,r.energy+r.pending[i]*Math.exp(-Math.max(0,nowMs-r.due[i])/DECAY_MS));r.pending[i]=0;r.due[i]=0;
      }
      if(nowMs-r.lastEvent>6000){this.regions[index]=undefined;continue;}
      const intensity=1-Math.exp(-Math.max(0,r.energy-.35)*.35);
      if(intensity<.035||distance(r.position,listener)>150)continue;
      candidates.push({id:`debris-bed:${r.key}`,position:r.position,material:r.material,intensity,occlusion:r.occlusion,
        score:intensity*sourceAttenuation(distance(r.position,listener),5)*(this.selected.has(r.key)?1.2:1)});
    }
    candidates.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
    const result=candidates.slice(0,4);
    this.selected=new Set(result.map(r=>r.id.slice('debris-bed:'.length)));
    return result;
  }
  clear():void {this.regions=new Array(SLOTS);this.recent.clear();this.history=new Array(2048);this.historyIndex=0;this.selected.clear();}
  get regionCount():number {return this.regions.filter(Boolean).length;}
}
