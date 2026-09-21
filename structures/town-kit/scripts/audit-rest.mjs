import {readArtifact} from './artifacts.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT} from '../src/dependencies.mjs';
import {sha} from './provenance.mjs';
const read=p=>readArtifact(path.join(KIT,p));
const town=process.argv.includes('--town'),civic=process.argv.includes('--civic');
const matrix=town||civic?null:JSON.parse(await read('out/reviews/matrix.json'));
const assets=civic?['neighborhood-library','art-deco-cinema','fire-station'].flatMap(n=>[n,n+'-mirror']).concat(['book-stack','cinema-seat']):town?['porch-house','corner-grocery','workshop'].flatMap(name=>[name,`${name}-mirror`,`${name}-reuse`]):[...new Set(['victorian-corner',...matrix.results.filter(r=>r.mode==='stability').map(r=>r.asset)])];
const results=[];
for(const asset of assets){
 try{
  const data=await read(`out/${asset}.json`),pack=JSON.parse(data),r=JSON.parse(await read(`out/reviews/${asset}-stability/report.json`)),bytes=await read(`out/reviews/${asset}-stability/recording.json`),recording=JSON.parse(bytes);
  if(!r.passed||r.packSha256!==sha(data)||recording.packHash!==sha(data))throw Error('Missing, failed or stale intact recording');
  const poses=new Map();for(const f of recording.frames)for(const [i,p]of f.poses)poses.set(i,p);
  if(poses.size!==pack.scenario.nodes.length)throw Error('Incomplete observed chunk poses');
  let maximumDisplacement=0,maximumRotationRadians=0;
  for(const [i,p]of poses){const n=pack.scenario.nodes[i];if(!p.every(Number.isFinite))throw Error('Non-finite observed pose');maximumDisplacement=Math.max(maximumDisplacement,Math.hypot(p[0]-n.centroid.x,p[1]-n.centroid.y,p[2]-n.centroid.z));maximumRotationRadians=Math.max(maximumRotationRadians,2*Math.acos(Math.min(1,Math.abs(p[6]))));}
  results.push({asset,passed:maximumDisplacement<=.035&&maximumRotationRadians<=.03,maximumDisplacement,maximumRotationRadians,assetSha256:sha(data),recordingSha256:sha(bytes)});
 }catch(e){results.push({asset,passed:false,error:String(e)});}
}
const report={passed:results.every(r=>r.passed),limits:{displacementMetres:.035,rotationRadians:.03},results};
await writeFile(path.join(KIT,`out/reviews/${civic?'civic-':town?'town-':''}rest-audit.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,cases:results.length,failures:results.filter(r=>!r.passed)},null,2));if(!report.passed)process.exitCode=1;
