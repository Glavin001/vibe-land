from pathlib import Path
import gzip,hashlib,json,statistics
b=Path(__file__).resolve().parent
s=json.loads((b/'summary.json').read_text());a=[]
for name,digest in s['sample_sha256'].items():
 p=b/name;assert hashlib.sha256(p.read_bytes()).hexdigest()==digest
 a.append(json.loads(gzip.decompress(p.read_bytes())))
assert len(a)==s['samples']==10
elapsed=a[-1]['monotonic']-a[0]['monotonic']
assert s['tick_rate']==(a[-1]['tick']-a[0]['tick'])/elapsed
assert s['mean_tick_ms_range']==[min(x['timings']['avg'] for x in a),max(x['timings']['avg'] for x in a)]
assert s['p95_tick_ms_range']==[min(x['timings']['p95'] for x in a),max(x['timings']['p95'] for x in a)]
assert s['contact_host_point_mean_ms']==statistics.mean(sum(x['contact'][k] for k in ['ownership','validate','sort','reduce','route']) for x in a)
for k,delta in s['network_counter_deltas'].items():assert delta==a[-1]['network'][k]-a[0]['network'][k]
assert s['network_counter_deltas']['dropped_outbound_packets']==0
assert all(x['players']==1 and x['pending_inputs']==[0] for x in a)
assert s['exe_sha256']=='7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee'
print('PASS: ten late live samples, unchanged deployed executable, wall-time rates and point-sample limits')
