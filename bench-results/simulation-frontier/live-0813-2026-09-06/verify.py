from pathlib import Path
import gzip,hashlib,json,statistics
b=Path(__file__).resolve().parent;s=json.loads((b/'summary.json').read_text());samples=[]
for name,digest in sorted(s['sample_sha256'].items()):
 data=(b/name).read_bytes();assert hashlib.sha256(data).hexdigest()==digest
 samples.append(json.loads(gzip.decompress(data)))
assert len(samples)==s['samples']==10
assert hashlib.sha256((b/'report-classification.json').read_bytes()).hexdigest()==s['report_classification_sha256']
a,z=samples[0],samples[-1];elapsed=z['monotonic']-a['monotonic'];assert elapsed==s['wall_seconds']
assert (z['tick']-a['tick'])/elapsed==s['tick_rate']
assert (z['cpu_seconds']-a['cpu_seconds'])/elapsed==s['cpu_core_equivalents']
assert s['unique_published_snapshots']==len(set(x['tick'] for x in samples))
def spread(v):
 v=list(v);return {'min':min(v),'mean':statistics.mean(v),'max':max(v)}
assert s['rolling_tick_mean_ms']==spread(x['timings']['total_ms']['avg'] for x in samples)
assert s['rolling_tick_p95_ms']==spread(x['timings']['total_ms']['p95'] for x in samples)
for p,v in s['contact_phases_ms'].items():assert v==spread(x['spans']['physics/direct_contact_'+p+'_ms']['v'] for x in samples)
assert s['contact_host_ms']==spread(sum(x['spans']['physics/direct_contact_'+p+'_ms']['v'] for p in ['ownership','validate','sort','reduce','route']) for x in samples)
for p,v in s['city_point_samples'].items():assert v==spread(x['city'][p] for x in samples)
for p,v in s['network_delta'].items():assert v==z['network'][p]-a['network'][p]
for p,v in s['city_counter_delta'].items():assert v==z['city'][p]-a['city'][p]
assert s['outbound_mbps']==s['network_delta']['total_outbound_bytes']*8/elapsed/1e6
unique={}
for x in samples:
 for r in x['tick_ring']:
  if r['t'] in unique:assert unique[r['t']]==r
  unique[r['t']]=r
v=sorted(r['total'] for r in unique.values());summary=spread(v);summary['p95']=v[int((len(v)-1)*.95+.5)]
r=s['deduplicated_ring'];assert r['count']==len(v) and r['total_ms']==summary
assert r['first_tick']==min(unique) and r['last_tick']==max(unique)
assert r['missing_ticks']==max(unique)-min(unique)+1-len(unique)==0
assert r['worst_tick']==max(unique.values(),key=lambda x:x['total'])
assert all(x['players']==1 and x['pending_inputs']==[0] for x in samples)
assert all(x['city']['contacts_dropped']==0 and x['physics']['physics_gpu_warning_count']==0 for x in samples)
assert s['exe_sha256']=='7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee'
print('PASS: artifact checksums, ten sanitized live samples, six distinct published snapshots, 600 unique ticks, wall-time rates and counter deltas')
