"""Summarize the city qualification without treating interrupted tests as passes."""
import csv,gzip,json,re,statistics,sys
from pathlib import Path
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent

def read(path):
 return path.read_text() if path.exists() else gzip.open(path.with_suffix(path.suffix+'.gz'),'rt').read()

def rows(path):
 import io
 return list(csv.DictReader(io.StringIO(read(path))))

def tests(name):
 values=re.findall(r'test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored',read(root/(name+'.log')))
 result={k:sum(int(v[i]) for v in values) for i,k in enumerate(('passed','failed','ignored'))}
 result['exit_code']=json.loads(read(root/(name+'.json')))['exit_code']
 return result

def collapse(path):
 data=[r for r in rows(path) if int(r['tick'])>0]
 awake=[float(r['awake']) for r in data];peak=max(awake);tail=statistics.median(awake[-300:])
 return {'ticks':len(data),'peak_awake':peak,'tail_median_awake':tail,'tail_over_peak':tail/peak,'retirement_gate_passed':tail/peak<=.1,'final_awake':awake[-1],'final_broken_bonds':int(data[-1]['bonds']),'mean_sim_ms':statistics.mean(float(r['sim']) for r in data)}

summary={'direct_bridge':tests('direct-bridge'),'direct_destruction_debug':tests('direct-destruction'),'direct_authored_release':tests('direct-authored-release'),'debug_authored_target_interrupted':True,'direct_idle':json.loads(read(root/'direct-idle.json'))['exit_code']==0,'direct_gpu_deployed':False}
log=read(root/'direct-audit.log');data=rows(root/'direct-audit.csv')
summary['audit']={'ticks':len(data),'last_tick':int(data[-1]['tick'])}
for key,pattern in {'captures':r'resim: (\d+) captures','full_replays':r'captures, (\d+) re-passes','membership_mismatches':r'membership mismatches (\d+)','capture_errors':r'not_needed=\d+ errors=(\d+)'}.items():summary['audit'][key]=int(re.findall(pattern,log)[-1])
for key in ('MISMATCHES','removeOrder','mask','OVERSET_MISMATCH','IMPULSE','big','node','normal','disp','centroid'):
 values=re.findall(r'\b'+re.escape(key)+r'=(\d+)',log)
 if values:summary['audit'][key+'_max']=max(map(int,values))
for key in ('node_mm','bs_par_mm','bl_mm','escaped'):summary['audit'][key+'_max']=max(float(r[key]) for r in data)
summary['initial_scenario_exit_code']=json.loads(read(root/'direct-scenario.json'))['exit_code']
summary['collapse']={'direct_initial':collapse(root/'direct-scenario-data/t3.csv'),'native_control':collapse(root/'native-collapse.csv'),'direct_repeat':collapse(root/'direct-collapse.csv')}
summary['performance_interpretation']='Exploratory scenario means with differing fracture trajectories; not a matched-awake multi-trial speedup claim. Native and Direct controls use one identical release trace and SDK. The initial Direct scenario also passed the existing p95 guard (54.5 ms <= 91.4 ms, 571 samples). This guard measures physx_step + stress_solve, not whole-tick streaming p99.'
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
