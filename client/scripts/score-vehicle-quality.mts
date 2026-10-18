/** Score a harness-authored canonical evidence file; never infer missing physical data. */
import {readFileSync} from 'node:fs';
import {evaluateVehicleQuality} from '../netlab/vehicle/evaluate';
import {VEHICLE_QUALITY_SCENARIOS} from '../netlab/vehicle/scenarios';
import type {QualityEvidence} from '../netlab/vehicle/contracts';
const file=process.argv[2];if(!file)throw Error('Usage: node --import tsx scripts/score-vehicle-quality.mts <evidence.json> [--check]');
const data=JSON.parse(readFileSync(file,'utf8'));
const evidence:QualityEvidence[]=data.driver&&data.observer?[data.driver,data.observer]:[data];
const reports=evidence.map(e=>{
 const contract=VEHICLE_QUALITY_SCENARIOS.find(s=>s.id===e.scenario);
 if(!contract)throw Error(`Unknown scenario ${e.scenario}`);
 return evaluateVehicleQuality(e,contract);
});
console.log(JSON.stringify(reports,null,2));
if(process.argv.includes('--check')&&reports.some(r=>r.verdict!=='pass'))process.exitCode=1;
