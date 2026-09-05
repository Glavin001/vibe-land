import csv,json,re,gzip,sys
from pathlib import Path
out=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent
summary={}
for arm in ('lazy','eager'):
 path=out/(arm+'-audit.log')
 if not path.exists() and not path.with_suffix('.log.gz').exists():continue
 data=path.read_text() if path.exists() else gzip.decompress(path.with_suffix('.log.gz').read_bytes()).decode()
 lines=[line for line in data.splitlines() if line.startswith('[bond-stress-gpu]')]
 fields=('MISMATCHES','STRESS_MISMATCH','BEND_MISMATCH','OVERSET_MISMATCH','IMPULSE')
 values={key:[int(value) for line in lines for value in re.findall(r'\b'+key+r'=(\d+)',line)] for key in fields}
 csv_path=out/(arm+'-audit.csv')
 with (csv_path.open() if csv_path.exists() else gzip.open(csv_path.with_suffix('.csv.gz'),'rt')) as source:
  rows=list(csv.DictReader(source))
 captures=re.findall(r'resim diag: captures=(\d+) zero=(\d+) not_needed=(\d+) errors=(\d+)',data)
 summary[arm]={'ticks':len(rows),'reported_max_per_solver_counters':{k:max(v,default=None) for k,v in values.items()},'csv_max_mismatches':{k:max(float(r[k]) for r in rows) for k in ('node_mm','bs_par_mm','bl_mm')},'resim_captures':captures[-1] if captures else None,'replay_passes':sum(float(r['resim_passes']) for r in rows),'membership':re.findall(r'membership mismatches (\d+)',data),'last_gpu_reports':lines[-4:]}
 idle=out/(arm+'-idle.json')
 if idle.exists():summary[arm]['idle']=json.loads(idle.read_text()).get('idle_check')
(out/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:{kk:vv for kk,vv in v.items() if kk!='last_gpu_reports'} for k,v in summary.items()},indent=2))
