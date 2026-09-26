import {sampleTerrainHeightAtWorldPosition, type WorldDocument} from '../../src/world/worldDocument';
import type {NativeTrace} from './replay';
import {QUALITY_VERSION, type QualityEvidence} from './contracts';
import {heightfieldCoverage} from './heightfield';
import {LINK_CASES, type LinkCase} from './schedule';

/** Uses the same triangle-sampled serialized terrain as the client world, not a
 * fitted curve or the predictor's support result. Does not infer wheel contact. */
export function garageHeightfieldReference(trace:NativeTrace,terrainSha256:string) {
  const world=trace.world as WorldDocument,t=world?.terrain;
  if(world?.meta?.name!=='Garage proving ground'||!t||!Number.isInteger(t.tileGridSize)||t.tileGridSize<2
    ||!Number.isFinite(t.tileHalfExtentM)||t.tileHalfExtentM<=0||!Array.isArray(t.tiles)||!t.tiles.length
    ||t.tiles.some(tile=>!Number.isInteger(tile.tileX)||!Number.isInteger(tile.tileZ)||!Array.isArray(tile.heights)
      ||tile.heights.length!==t.tileGridSize**2||!tile.heights.every(Number.isFinite)))throw Error('Invalid embedded garage heightfield');
  const samples=trace.frames.map(({sample},tick)=>{
    const [x,,z]=sample.position,half=t.tileHalfExtentM;
    if(!sample.position.every(Number.isFinite)||!sample.linearVelocity.every(Number.isFinite))throw Error(`Invalid source motion at ${tick}`);
    if(!t.tiles.some(tile=>Math.abs(x-tile.tileX*2*half)<=half&&Math.abs(z-tile.tileZ*2*half)<=half))throw Error(`Source outside actual terrain tiles at ${tick}`);
    return {speedMps:Math.hypot(sample.linearVelocity[0],sample.linearVelocity[2]),surfaceHeightM:sampleTerrainHeightAtWorldPosition(world,x,z)};
  });
  const source={worldName:world.meta.name,terrainSha256};
  const attach=(e:QualityEvidence):QualityEvidence=>({...e,scenario:'garage-fast-heightfield',heightfieldSource:source,
    frames:e.frames.map(f=>({...f,heightfield:{...samples[f.tick-e.observerDelayTicks]}}))});
  // Null presentation is intentional: this is course selection, never a scored successful candidate.
  const reference=attach({version:QUALITY_VERSION,scenario:'garage-fast-heightfield',role:'driver',startTick:12,endTick:trace.frames.length-1,
    observerDelayTicks:0,lostRecords:0,source:'pinned-native-vehicle2-tape',corrections:[],triggers:[],
    frames:trace.frames.slice(12).map((f,i)=>({tick:i+12,sourceTick:i+12,reference:f.sample,actual:null,frozen:false}))});
  const coverage=heightfieldCoverage(reference);
  if(coverage.problems.length)throw Error(`Garage fast course is not covered: ${coverage.problems.join('; ')}`);
  const crest=coverage.summary!.crestTick!;
  const lane=coverage.segments.find(s=>s.id==='washboard')!.frames;
  const laneMiddle=lane[Math.floor(lane.length/2)].tick;
  // Deliberately impair arrivals over measured terrain features, not the initial spawn drop.
  const burst=(id:string,center:number):LinkCase=>({id,delayTicks:6,jitterTicks:2,loss:.03,duplicate:0,stride:2,observerDelayTicks:9,blackout:[center-6,center+12]});
  const links=[...LINK_CASES,burst('washboard-burst',laneMiddle),burst('fast-crest-burst',crest)];
  return {attach,coverage:coverage.summary,links,source};
}
