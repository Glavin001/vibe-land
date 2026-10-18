import {readFileSync} from 'node:fs';
import {compareVehicleQuality} from '../netlab/vehicle/compare';
const [before,after]=process.argv.slice(2);if(!before||!after)throw Error('Usage: node --import tsx scripts/compare-vehicle-quality.mts <baseline/quality.json> <candidate/quality.json> [--check]');
const result=compareVehicleQuality(JSON.parse(readFileSync(before,'utf8')),JSON.parse(readFileSync(after,'utf8')));
console.log(JSON.stringify(result,null,2));
if(process.argv.includes('--check')&&!result.noRegressions)process.exitCode=1;
