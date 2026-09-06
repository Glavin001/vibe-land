from pathlib import Path
import gzip,hashlib,json,os,statistics,subprocess,time,urllib.request
base=Path('/tmp/city-live-0815-sep6');base.mkdir(exist_ok=False)
pid=166548;proc=Path(f'/proc/{pid}');ticks=os.sysconf('SC_CLK_TCK')
exe=str((proc/'exe').resolve());exe_sha=hashlib.sha256((proc/'exe').read_bytes()).hexdigest()
identity=(proc/'stat').read_text().rsplit(')',1)[1].split()[19]
samples=[]
for i in range(10):
 started=time.monotonic()
 with urllib.request.urlopen('http://127.0.0.1:4005/match-stats/city-default',timeout=10) as response: raw=json.load(response)
 stat=(proc/'stat').read_text().rsplit(')',1)[1].split();assert stat[19]==identity
 gpu=subprocess.check_output(['nvidia-smi','--query-gpu=utilization.gpu,utilization.memory,memory.used,power.draw','--format=csv,noheader,nounits'],text=True).strip()
 s={'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'monotonic':started,
 'tick':raw['server_tick'],'players':raw['player_count'],'pending_inputs':[p['pending_inputs'] for p in raw['players']],
 'timings':raw['timings'],'city':raw['city'],'spans':raw['spans'],'tick_ring':raw['tick_ring'],
 'network':{k:v for k,v in raw['network'].items() if isinstance(v,(int,float))},
 'physics':{k:v for k,v in raw.items() if k.startswith('physics_')},
 'gpu':gpu,'cpu_seconds':(int(stat[11])+int(stat[12]))/ticks}
 samples.append(s);(base/f'{i:02d}.json.gz').write_bytes(gzip.compress((json.dumps(s,indent=2)+'\n').encode(),mtime=0))
 print(json.dumps({'sample':i,'utc':s['utc'],'tick':s['tick'],'mean_ms':s['timings']['total_ms']['avg'],'p95_ms':s['timings']['total_ms']['p95'],'awake':s['city']['awake_bodies'],'bonds':s['city']['broken_bonds'],'gpu':gpu}),flush=True)
 if i<9:time.sleep(max(0,5-(time.monotonic()-started)))
assert hashlib.sha256((proc/'exe').read_bytes()).hexdigest()==exe_sha
unique={}
for s in samples:
 for row in s['tick_ring']:
  if row['t'] in unique: assert unique[row['t']]==row
  unique[row['t']]=row
ring=sorted(unique.values(),key=lambda row:row['t'])
def spread(a):
 a=list(a);return {'min':min(a),'mean':statistics.mean(a),'max':max(a)}
a,b=samples[0],samples[-1];elapsed=b['monotonic']-a['monotonic'];phases=['ownership','validate','sort','reduce','route']
summary={'start_utc':a['utc'],'end_utc':b['utc'],'wall_seconds':elapsed,'samples':len(samples),'server_pid':pid,'exe':exe,'exe_sha256':exe_sha,
 'tick_rate':(b['tick']-a['tick'])/elapsed,'simulated_seconds':(b['tick']-a['tick'])/60,
 'rolling_tick_mean_ms':spread(s['timings']['total_ms']['avg'] for s in samples),'rolling_tick_p95_ms':spread(s['timings']['total_ms']['p95'] for s in samples),
 'contact_host_ms':spread(sum(s['spans']['physics/direct_contact_'+p+'_ms']['v'] for p in phases) for s in samples),
 'contact_phases_ms':{p:spread(s['spans']['physics/direct_contact_'+p+'_ms']['v'] for s in samples) for p in phases+['copy']},
 'contact_records':spread(s['spans']['physics/direct_contact_count']['v'] for s in samples),
 'city_point_samples':{p:spread(s['city'][p] for s in samples) for p in ['gpu_stress_solve_ms','stress_solve_ms','encode_shared_ms','client_datagrams_ms','resim_capture_ms','resim_restore_ms','resim_step_ms','resim_tick_ms']},
 'gpu_utilization_percent':spread(float(s['gpu'].split(',')[0]) for s in samples),'cpu_core_equivalents':(b['cpu_seconds']-a['cpu_seconds'])/elapsed,
 'awake':spread(s['city']['awake_bodies'] for s in samples),'frozen':spread(s['city']['frozen_bodies'] for s in samples),'bonds_start_end':[a['city']['broken_bonds'],b['city']['broken_bonds']],
 'network_delta':{k:b['network'][k]-a['network'][k] for k in a['network'] if k.startswith('total_') or k in ['reliable_packets_sent','datagram_packets_sent','datagram_fallbacks','malformed_packets','dropped_outbound_packets','dropped_outbound_snapshots']},
 'players':[s['players'] for s in samples],'pending_inputs':[s['pending_inputs'] for s in samples],
 'deduplicated_ring':{'count':len(ring),'first_tick':ring[0]['t'],'last_tick':ring[-1]['t'],'missing_ticks':ring[-1]['t']-ring[0]['t']+1-len(ring),'total_ms':spread(r['total'] for r in ring),'worst_tick':max(ring,key=lambda r:r['total'])},
 'sample_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(base.glob('*.json.gz'))}}
summary['outbound_mbps']=summary['network_delta']['total_outbound_bytes']*8/elapsed/1e6
(base/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2),flush=True)
