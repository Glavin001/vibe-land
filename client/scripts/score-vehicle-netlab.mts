/** Analyze either a UI export or events.clientK.jsonl. --check fails incomplete/red runs. */
import {readFileSync} from 'node:fs';
import {scoreVehicleLab} from '../src/netlab/vehicleLab';
import type {RecorderEvent} from '../src/netlab/recorder';
const file=process.argv[2];
if(!file)throw Error('Usage: node --import tsx scripts/score-vehicle-netlab.mts <export.json|events.jsonl> [--check]');
const raw=readFileSync(file,'utf8');
const artifact=file.endsWith('.jsonl')?{events:raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) as RecorderEvent[],lostEvents:0}:JSON.parse(raw);
const scores=scoreVehicleLab(artifact.events);
const incomplete=(artifact.lostEvents??0)>0 || (artifact.frames?.lostFrames??0)>0;
console.log(JSON.stringify({incomplete,scores},null,2));
if(process.argv.includes('--check') && (incomplete || !scores.length || scores.some(s=>s.verdict!=='within-targets')))process.exitCode=1;
