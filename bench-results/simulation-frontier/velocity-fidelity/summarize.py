"""Recompute the qualification summary from raw or archived evidence."""
import csv,gzip,io,json,re,statistics,sys
from pathlib import Path
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent
base=root/'qualification'
def read(p): return p.read_text() if p.exists() else gzip.decompress(Path(str(p)+'.gz').read_bytes()).decode()
summary={'integration':{},'scenarios':{},'direct_collapse_repeats':[]}
for mode in ('native','direct'):
 parts=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored',read(base/(mode+'-full-tests-release.log')))
 assert parts, 'Missing integration results'
 summary['integration'][mode]=dict(zip(('passed','failed','ignored'),[sum(int(p[i]) for p in parts) for i in range(3)]))
 log=read(base/(mode+'-scenario-release.log'))
 summary['scenarios'][mode]=json.loads(next(l[len('measured: '):] for l in log.splitlines() if l.startswith('measured: ')))
 summary['scenarios'][mode]['exit_code']=json.loads(read(base/(mode+'-scenario-release.json')))['exit_code']
 summary['scenarios'][mode]['idle_bonds']=int(re.search(r'bonds broken total:\s*(\d+)',log)[1])
for number in (1,2):
 name=f'direct-collapse-release-repeat{number}'
 rows=list(csv.DictReader(io.StringIO(read(base/(name+'.csv')))))
 peak=max(int(x['awake']) for x in rows);tail=statistics.median(int(x['awake']) for x in rows[-300:])
 summary['direct_collapse_repeats'].append(dict(run=name,ticks=len(rows),peak_awake=peak,tail_median=tail,tail_ratio=tail/peak,final_awake=int(rows[-1]['awake']),settling_band_pass=tail/peak<=.1))
log=read(base/'direct-audit-release.log')
a=re.search(r'resim: (\d+) captures, (\d+) re-passes',log);b=re.search(r'resim diag: captures=(\d+) zero=(\d+) not_needed=(\d+) errors=(\d+)',log)
summary['direct_audit']=dict(captures=int(a[1]),replays=int(a[2]),capture_errors=int(b[4]),membership_mismatches=int(re.search(r'membership mismatches (\d+)',log)[1]),max_threshold_mismatches=max(map(int,re.findall(r'\bMISMATCHES=(\d+)',log))),max_large_stress_mismatches=max(map(int,re.findall(r' big=(\d+)',log))),max_reported_stress_error=max(map(float,re.findall(r' maxRel=([0-9.eE+-]+)',log))))
print(json.dumps(summary,indent=2))
