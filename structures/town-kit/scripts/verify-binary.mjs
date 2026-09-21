import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,unlinkSync,statSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {KIT} from '../src/dependencies.mjs';
import {buildBaylineCivicTown} from '../src/bayline-civic-town.mjs';
import {prepareNativeCache} from './native-cache.mjs';
import {sha} from './provenance.mjs';
process.chdir(KIT);mkdirSync('out/binary-tests',{recursive:true});mkdirSync('out/reviews',{recursive:true});
const run=(bin,args,env={})=>{const r=spawnSync(bin,args,{cwd:KIT,env:{...process.env,...env},encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw Error(`${bin} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);return r.stdout;};
const build=JSON.parse(run(process.execPath,['scripts/build-binary.mjs']));console.log('Binary scene generated');
console.log(run(process.execPath,['--test','tests/scene-binary.test.mjs']));
const cargoHome=await prepareNativeCache({workspace:'binary-review',cacheDirectory:'binary-cargo-home'});
run('cargo',['build','--offline','--locked','--release','--manifest-path','binary-review/Cargo.toml'],{CARGO_HOME:cargoHome,CARGO_TARGET_DIR:path.join(KIT,'out/binary-target')});
const reviewer=path.join(KIT,'out/binary-target/release/town-kit-binary-review');
const fixture=JSON.parse(run(reviewer,['compare','out/binary-tests/fixture.json','out/binary-tests/fixture.vlsp']));
for(const kind of ['truncated','version','checksum','node-reference','shape-reference','nan'])run(reviewer,['reject',`out/binary-tests/${kind}.vlsp`]);
// The independent legacy assembly path supplies the baseline; it is never
// reconstructed from the binary being tested. Temporary large JSON is removed.
const baseline='out/binary-tests/fresh-baseline.json',report={fixture,malformedCases:6,build};
try{
 writeFileSync(baseline,JSON.stringify(buildBaylineCivicTown().pack));
 report.equivalence=JSON.parse(run(reviewer,['compare',baseline,build.output]));
 report.json=JSON.parse(run(reviewer,['measure',baseline]));report.binary=JSON.parse(run(reviewer,['measure',build.output]));
 assert.equal(report.json.fingerprint,report.binary.fingerprint);
}finally{try{unlinkSync(baseline);}catch(e){if(e.code!=='ENOENT')throw e;}}
const before=readFileSync(build.output),mtime=statSync(build.output).mtimeMs;
report.warmBuild=JSON.parse(run(process.execPath,['scripts/build-binary.mjs']));assert(report.warmBuild.unchanged);assert.equal(statSync(build.output).mtimeMs,mtime);
report.cachedRebuild=JSON.parse(run(process.execPath,['scripts/build-binary.mjs','--force']));assert.equal(report.cachedRebuild.cacheMisses,0);assert.equal(sha(readFileSync(build.output)),sha(before));
report.passed=true;report.benchmarkNote='Single process per load on a shared machine; operating-system cache is not flushed. CPU asset loading only, not physics or rendering.';
writeFileSync('out/reviews/binary-scene-review.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
