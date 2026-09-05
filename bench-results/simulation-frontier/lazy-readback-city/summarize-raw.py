import csv,json,math,statistics,sys,gzip
from pathlib import Path
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent
manifest=json.loads((root/'manifest.json').read_text())
keys=['sim','stress_solve','solve','gpu_solve','gpu_host_work','gpu_host_blocked','st_copy','physx_step','resim','resim_restore','resim_tick','awake','bodies','pairs']
summary={'scope':'offline simulation (capture + physics + destruction + replay); excludes encoder and network scheduling','warmup_ticks':600,'awake_band':[3000,6000],'runs':[]}
def quantile(values,q):
 values=sorted(values);return values[math.ceil(q*len(values))-1]
for record in manifest['results']:
 if record['exit_code']: raise RuntimeError(f'failed run: {record}')
 path=root/f"{record['trial']}-{record['mode']}"/'demolition.csv'
 with (path.open() if path.exists() else gzip.open(path.with_suffix('.csv.gz'),'rt')) as f: rows=[{k:float(v) for k,v in row.items()} for row in csv.DictReader(f)]
 if len(rows)!=2700 or [r['tick'] for r in rows]!=list(range(1,2701)):
  # Verify the recorder's actual tick convention, accepting zero-based only
  # when every expected index exists exactly once.
  if len(rows)!=2700 or [r['tick'] for r in rows]!=list(range(2700)):
   raise RuntimeError('incomplete/duplicate tick series: '+str(path))
 if not all(math.isfinite(r[k]) and r[k]>=0 for r in rows for k in keys): raise RuntimeError('invalid measurement')
 matched=[r for r in rows if r['tick']>=600 and 3000<=r['awake']<=6000]
 if not matched: raise RuntimeError('target awake regime was not reached')
 item=dict(record,samples=len(matched),final_broken_bonds=rows[-1]['bonds'],mean={k:statistics.mean(r[k] for r in matched) for k in keys},simulation_p99_ms=quantile([r['sim'] for r in matched],.99),split_fraction=statistics.mean(r['resim_passes']>0 for r in matched))
 item['strata']={}
 for low in range(3000,6000,500):
  for split in (False,True):
   subset=[r for r in matched if low<=r['awake']<(low+500 if low<5500 else 6001) and bool(r['resim_passes']>0)==split]
   if subset: item['strata'][f'{low}-{low+500}/split={split}']={'n':len(subset),'mean':{k:statistics.mean(r[k] for r in subset) for k in keys},'simulation_p99_ms':quantile([r['sim'] for r in subset],.99)}
 summary['runs'].append(item)
summary['complete']=len(summary['runs'])==6
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
for item in summary['runs']:
 print(item['trial'],item['mode'],'samples',item['samples'],'mean', {k:round(item['mean'][k],3) for k in ['awake','st_copy','gpu_host_work','solve','stress_solve','sim']},'sim_p99',round(item['simulation_p99_ms'],3),'split_fraction',round(item['split_fraction'],3),'broken',item['final_broken_bonds'])
print('complete:',summary['complete'])
