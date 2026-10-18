import { SeededRandom } from '../../src/loadtest/scenario';
export interface LinkCase {
  id: string; delayTicks: number; jitterTicks: number; loss: number; duplicate: number;
  stride: number; observerDelayTicks: number;
  blackout?: [number,number]; stragglerEvery?: number; stragglerTicks?: number;
}
/** Snapshot receive-channel tests. NOT an RTT model; upstream is frozen in the source trace. */
export const LINK_CASES: LinkCase[] = [
  {id:'clean-60hz',delayTicks:0,jitterTicks:0,loss:0,duplicate:0,stride:1,observerDelayTicks:6},
  {id:'wifi-30hz',delayTicks:3,jitterTicks:1,loss:.01,duplicate:0,stride:2,observerDelayTicks:6},
  {id:'mobile-30hz',delayTicks:6,jitterTicks:2,loss:.03,duplicate:0,stride:2,observerDelayTicks:9},
  {id:'long-haul',delayTicks:12,jitterTicks:3,loss:.03,duplicate:0,stride:2,observerDelayTicks:12},
  {id:'reorder-duplicates',delayTicks:3,jitterTicks:2,loss:.01,duplicate:.2,stride:2,observerDelayTicks:6,stragglerEvery:7,stragglerTicks:15},
  {id:'landing-burst-loss',delayTicks:3,jitterTicks:0,loss:0,duplicate:0,stride:2,observerDelayTicks:6,blackout:[24,48]},
  {id:'turn-blackout',delayTicks:3,jitterTicks:1,loss:0,duplicate:0,stride:2,observerDelayTicks:6,blackout:[360,408]},
  {id:'sparse-10hz',delayTicks:3,jitterTicks:1,loss:.05,duplicate:0,stride:6,observerDelayTicks:9},
];
export interface ScheduledPacket { sourceTick:number; arrivalTick:number; copy:number; dropped:boolean; }
export function packetSchedule(ticks:number, link:LinkCase, seed:number):ScheduledPacket[] {
  if(!Number.isInteger(ticks)||ticks<2||!Number.isInteger(seed)||!Number.isInteger(link.stride)||link.stride<1
    || !Number.isInteger(link.delayTicks)||link.delayTicks<0||!Number.isInteger(link.jitterTicks)||link.jitterTicks<0
    || !Number.isFinite(link.loss)||link.loss<0||link.loss>1||!Number.isFinite(link.duplicate)||link.duplicate<0||link.duplicate>1)throw Error('Invalid link schedule');
  const rng=new SeededRandom(seed),packets:ScheduledPacket[]=[];
  for(let tick=link.stride;tick<ticks;tick+=link.stride) {
    // Consume a fixed number of RNG values per packet so toggling loss does not change jitter draws.
    const loss=rng.next(),jitter=rng.next(),duplicate=rng.next();
    const arrivalTick=tick+Math.max(0,link.delayTicks+Math.round((jitter*2-1)*link.jitterTicks))
      +(link.stragglerEvery && tick/link.stride%link.stragglerEvery===0?(link.stragglerTicks??0):0);
    const dropped=loss<link.loss || !!link.blackout && arrivalTick>=link.blackout[0] && arrivalTick<link.blackout[1];
    packets.push({sourceTick:tick,arrivalTick,copy:0,dropped});
    if(duplicate<link.duplicate)packets.push({sourceTick:tick,arrivalTick:arrivalTick+1,copy:1,dropped});
  }
  return packets.sort((a,b)=>a.arrivalTick-b.arrivalTick||a.sourceTick-b.sourceTick||a.copy-b.copy);
}
