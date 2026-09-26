import type {QualityResult} from './contracts';
import type {LinkCase} from './schedule';
export interface ComparableReport {
  version:string;sourceSha256:string;proxy:unknown;limits:unknown;seeds:number[];
  cases:{link:LinkCase;seed:number;scheduleSha256?:string;scores:QualityResult[]}[];
}
/** Lower is better for every gated scalar. Do not average away a bad role/seed. */
export function compareVehicleQuality(baseline:ComparableReport,candidate:ComparableReport) {
  const problems:string[]=[],regressions:{case:string;metric:string;before:number;after:number;witnessTick:number}[]=[];
  if(baseline.version!==candidate.version || baseline.sourceSha256!==candidate.sourceSha256
    ||JSON.stringify(baseline.proxy)!==JSON.stringify(candidate.proxy)||JSON.stringify(baseline.limits)!==JSON.stringify(candidate.limits)
    ||JSON.stringify([...baseline.seeds].sort())!==JSON.stringify([...candidate.seeds].sort()))problems.push('Incompatible reference, proxy, threshold version or seed set');
  const flatten=(report:ComparableReport)=>{
    const out=new Map<string,{result:QualityResult;link:LinkCase;scheduleSha256?:string}>();
    for(const c of report.cases)for(const s of c.scores) {
      const key=`${c.link.id}/${c.seed}/${s.role}`;
      if(out.has(key))problems.push(`Duplicate case ${key}`);
      out.set(key,{result:s,link:c.link,scheduleSha256:c.scheduleSha256});
    }
    return out;
  };
  const before=flatten(baseline),after=flatten(candidate);
  if(!before.size||!after.size)problems.push('Empty case coverage');
  if(before.size!==after.size)problems.push('Changed case coverage');
  for(const [key,a] of before) {
    const b=after.get(key);if(!b){problems.push(`Missing case ${key}`);continue;}
    if(a.scheduleSha256!==b.scheduleSha256)problems.push(`Changed packet decisions ${key}`);
    if(JSON.stringify(a.link)!==JSON.stringify(b.link))problems.push(`Changed receive schedule ${key}`);
    if(a.result.scenario!==b.result.scenario || b.result.verdict==='blocked')problems.push(`Blocked or changed scenario ${key}`);
    const next=new Map(b.result.metrics.map(m=>[m.id,m]));
    if(next.size!==a.result.metrics.length || next.size!==b.result.metrics.length)problems.push(`Changed or duplicate metrics ${key}`);
    for(const m of a.result.metrics) {
      const n=next.get(m.id);
      if(!n||n.limit!==m.limit||n.unit!==m.unit||!Number.isFinite(n.value)||!Number.isFinite(m.value)) {problems.push(`Invalid or missing metric ${key}/${m.id}`);continue;}
      if(n.value>m.value+1e-6)regressions.push({case:key,metric:m.id,before:m.value,after:n.value,witnessTick:n.witnessTick});
    }
  }
  return {compatible:!problems.length,problems,regressions,noRegressions:!problems.length&&!regressions.length};
}
