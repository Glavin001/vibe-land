/** CPU-only, fixed-tick qualification. No browser, server, GPU, or timers. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import init,{WasmSimWorld} from '../src/wasm/pkg/vibe_land_shared.js';
import {vehicleProxy,type Sweep} from '../src/physics/vehiclePresentation';
import {LINK_CASES,type LinkCase} from '../netlab/vehicle/schedule';
import {VEHICLE_QUALITY_SCENARIOS} from '../netlab/vehicle/scenarios';
import {evaluateVehicleQuality} from '../netlab/vehicle/evaluate';
import {replayVehicleTrace,type NativeTrace} from '../netlab/vehicle/replay';
import {QUALITY_VERSION,LIMITS,type QualityResult} from '../netlab/vehicle/contracts';
import {HEIGHTFIELD_LIMITS} from '../netlab/vehicle/heightfield';
import {garageHeightfieldReference} from '../netlab/vehicle/heightfieldReplay';
const args=process.argv.slice(2);
const option=(key:string,fallback:string)=>{const at=args.indexOf(key);if(at<0)return fallback;if(!args[at+1]||args[at+1].startsWith('--'))throw Error(`Missing ${key} value`);return args[at+1];};
const out=resolve(option('--out','netlab/results/vehicle-quality'));
const seeds=option('--seeds','7,42,1337').split(',').map(Number);
if(!seeds.length||seeds.some(s=>!Number.isSafeInteger(s)))throw Error('Seeds must be integers');
const sha=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const fixture=readFileSync(new URL('../netlab/vehicle/fixtures/native-course.json.gz',import.meta.url));
const provenance=JSON.parse(readFileSync(new URL('../netlab/vehicle/fixtures/native-course.provenance.json',import.meta.url),'utf8'));
const raw=gunzipSync(fixture);if(sha(raw)!==provenance.sourceSha256 || sha(fixture)!==provenance.compressedSha256)throw Error('Pinned fixture hash mismatch');
const trace=JSON.parse(raw.toString()) as NativeTrace;
const scenario=option('--scenario','recorded-course');
if(!['recorded-course','garage-fast-heightfield'].includes(scenario))throw Error('This replay supports recorded-course or garage-fast-heightfield');
const terrainRun=scenario==='garage-fast-heightfield'?garageHeightfieldReference(trace,sha(JSON.stringify((trace.world as {terrain:unknown}).terrain))):null;
const wasm=readFileSync(new URL('../src/wasm/pkg/vibe_land_shared_bg.wasm',import.meta.url));
await init({module_or_path:wasm});
const sim=new WasmSimWorld();sim.loadWorldDocument(JSON.stringify(trace.world));sim.rebuildBroadPhase();
const sweep:Sweep=(p,q,d,h,r=0)=>{
 const hit=sim.sweepVehicleStatic(...[...p,...q,...d,...h,r] as [number,number,number,number,number,number,number,number,number,number,number,number,number,number]);
 return hit.length?{fraction:hit[0],normal:[hit[1],hit[2],hit[3]]}:null;
};
const proxy=vehicleProxy({...trace.frames[0].sample,id:7,driverId:10,vehicleType:0});
const contract=VEHICLE_QUALITY_SCENARIOS.find(s=>s.id===scenario)!;
const cases:{link:LinkCase;seed:number;evidenceFile:string;evidenceSha256:string;scheduleSha256:string;scores:QualityResult[]}[]=[];mkdirSync(out,{recursive:true});
const started=performance.now();
try {
 for(const link of terrainRun?.links??LINK_CASES)for(const seed of seeds) {
  const run=()=>{
   const evidence=replayVehicleTrace(trace,proxy,sweep,link,seed,link.id==='reorder-duplicates'?65500:0);
   if(!terrainRun)return evidence;
   const recovered=link.blackout?evidence.packets.find(p=>!p.dropped&&p.arrivalTick>=link.blackout![1]):undefined;
   if(link.blackout&&!recovered)throw Error('Receive outage never recovered in this tape');
   const snapshotRecoveries=recovered?[{tick:recovered.arrivalTick,sourceTick:recovered.sourceTick}]:[];
   return {...evidence,driver:{...terrainRun.attach(evidence.driver),snapshotRecoveries},observer:{...terrainRun.attach(evidence.observer),snapshotRecoveries}};
  };
  const a=run(),b=run(); // Repeatability covers output poses as well as packet schedules and scores.
  const data=JSON.stringify(a);if(data!==JSON.stringify(b))throw Error(`Non-repeatable ${link.id}/${seed}`);
  const scores=[evaluateVehicleQuality(a.driver,contract),evaluateVehicleQuality(a.observer,contract)];
  const evidenceFile=`${link.id}-${seed}.json`;
  writeFileSync(resolve(out,evidenceFile),data);
  cases.push({link,seed,evidenceFile,evidenceSha256:sha(data),scheduleSha256:sha(JSON.stringify(a.packets)),scores});
  console.log(`${link.id}/${seed}: ${scores.map(s=>`${s.role}=${s.verdict}`).join(' ')}`);
 }
} finally {sim.free();}
const report={version:QUALITY_VERSION,scope:'pinned authority trace / receive-channel presentation, not closed-loop two-way simulation',
 sourceSha256:provenance.sourceSha256,wasmSha256:sha(wasm),proxy,limits:terrainRun?{...LIMITS,heightfield:HEIGHTFIELD_LIMITS}:LIMITS,
 scenario,terrainCoverage:terrainRun?{...terrainRun.coverage,...terrainRun.source}:undefined,
 seeds,cases,coverage:VEHICLE_QUALITY_SCENARIOS.map(s=>({id:s.id,status:s.status,measured:s.id===scenario,required:s.required,capture:s.capture})),
 withinMeasuredTargets:cases.every(c=>c.scores.every(s=>s.verdict==='pass')),
 fullyQualified:cases.every(c=>c.scores.every(s=>s.verdict==='pass'))&&VEHICLE_QUALITY_SCENARIOS.every(s=>cases.some(c=>c.scores.some(score=>score.scenario===s.id)))};
writeFileSync(resolve(out,'quality.json'),JSON.stringify(report,null,2)+'\n');
writeFileSync(resolve(out,'provenance.json'),JSON.stringify({sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),node:process.version,platform:process.platform,
 candidateSourcesSha256:sha(['../src/physics/vehiclePresentation.ts','../src/net/interpolation.ts','../netlab/vehicle/evaluate.ts','../netlab/vehicle/replay.ts','../netlab/vehicle/schedule.ts','../netlab/vehicle/contracts.ts','../netlab/vehicle/scenarios.ts','../netlab/vehicle/heightfield.ts','../netlab/vehicle/heightfieldReplay.ts','../src/world/worldDocument.ts','../src/loadtest/scenario.ts'].map(p=>readFileSync(new URL(p,import.meta.url),'utf8')).join('\n'))},null,2)+'\n');
// Runtime timing is opt-in, separate and deliberately excluded from quality/check/repeatability.
if(args.includes('--timing'))writeFileSync(resolve(out,'timing.json'),JSON.stringify({totalRuntimeMs:performance.now()-started,note:'Diagnostic only; not a quality gate.'})+'\n');
console.log(`Repeatable evidence and quality report: ${out}/quality.json`);
if(args.includes('--check')&&!report.fullyQualified || args.includes('--check-measured')&&!report.withinMeasuredTargets)process.exitCode=1;
