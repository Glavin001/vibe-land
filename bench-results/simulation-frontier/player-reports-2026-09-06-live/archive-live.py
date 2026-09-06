from pathlib import Path
import copy,csv,gzip,hashlib,importlib.util,json,statistics
root=Path('/root/workspace/vibe-land-4')
source=Path('/tmp/city-live-player-sep6')
out=root/'bench-results/simulation-frontier/player-reports-2026-09-06-live'
out.mkdir(parents=True,exist_ok=False)
spec=importlib.util.spec_from_file_location('analyzer',root/'scripts/analyze-city-reports.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
paths=[p for p in sorted((root/'debug-reports').glob('report-*')) if 'report-1788669900'<=p.name<'report-1788670100']
reports=[m.load_report(p) for p in paths]
(out/'reports.json').write_text(json.dumps({'schema':3,'reports':reports},indent=2)+'\n')
# Preserve the timing/counter evidence, excluding player identity and position.
player_fields=['transport','one_way_ms','pending_inputs','last_received_input_seq','last_ack_input_seq','input_jitter_ms','correction_m','physics_ms','has_debug_stats']
source_hashes={}
def retain(path,name):
 raw=path.read_bytes();source_hashes[name]=hashlib.sha256(raw).hexdigest()
 value=json.loads(raw)
 stats=value.get('stats',value)
 stats['players']=[{key:p.get(key) for key in player_fields} for p in stats['players']]
 target=out/name;target.parent.mkdir(parents=True,exist_ok=True)
 target.write_bytes(gzip.compress((json.dumps(value,indent=2)+'\n').encode(),mtime=0))
 return value
initial=retain(source/'city-default.json','initial-stats.json.gz')
samples=[retain(p,'live/'+p.name+'.gz') for p in sorted((source/'live-samples').glob('*.json'))]
a,b=samples[0],samples[-1];duration=b['monotonic']-a['monotonic']
# Merge overlapping tick rings by tick identity; never count the same tick twice.
unique={}
for sample in samples:
 for row in sample['stats']['tick_ring']:
  if row['t'] in unique: assert unique[row['t']]==row
  unique[row['t']]=row
ring=sorted(unique.values(),key=lambda r:r['t'])
def spread(values):
 values=list(values);return {'min':min(values),'mean':statistics.mean(values),'max':max(values)}
host_phases=['ownership','validate','sort','reduce','route']
summary={
 'scope':'Six human reports plus read-only observation of the running server; no restart, build, benchmark, or settings change during capture',
 'reports':len(reports),'live_samples':len(samples),'start_utc':a['utc'],'end_utc':b['utc'],'duration_seconds':duration,
 'release_artifact':reports[-1]['release_artifact'],
 'rolling_tick_mean_ms':spread(s['stats']['timings']['total_ms']['avg'] for s in samples),
 'rolling_tick_p95_ms':spread(s['stats']['timings']['total_ms']['p95'] for s in samples),
 'observed_tick_rate':(b['stats']['server_tick']-a['stats']['server_tick'])/duration,
 'simulation_seconds_advanced':(b['stats']['server_tick']-a['stats']['server_tick'])/60,
 'gpu_utilization_percent':spread(float(s['gpu'].split(',')[0]) for s in samples),
 'process_cpu_cores':spread(s['process_cpu_cores'] for s in samples if 'process_cpu_cores' in s),
 'awake_bodies':spread(s['stats']['city']['awake_bodies'] for s in samples),
 'contact_host_ms_point_samples':spread(sum(s['stats']['spans']['physics/direct_contact_'+p+'_ms']['v'] for p in host_phases) for s in samples),
 'contact_phases_ms_point_samples':{p:spread(s['stats']['spans']['physics/direct_contact_'+p+'_ms']['v'] for s in samples) for p in host_phases+['copy']},
 'city_ms_point_samples':{p:spread(s['stats']['city'][p] for s in samples) for p in ['gpu_stress_solve_ms','encode_shared_ms','client_datagrams_ms','publish_ms','fan_out_ms']},
 'network_delta':{k:b['stats']['network'][k]-a['stats']['network'][k] for k in ['total_inbound_bytes','total_outbound_bytes','total_inbound_packets','total_outbound_packets','reliable_packets_sent','datagram_packets_sent','dropped_outbound_packets','dropped_outbound_snapshots','malformed_packets']},
 'live_deduplicated_ring':{'ticks':len(ring),'first':ring[0]['t'],'last':ring[-1]['t'],'total_ms':spread(row['total'] for row in ring),'worst_tick':max(ring,key=lambda r:r['total'])},
 'original_live_source_sha256':source_hashes,
 'limitations':['Stats snapshots publish every 60 simulation ticks; observed wall tick rate is approximate.','Live input traffic was low; empty backlog is not proof of active-input responsiveness.','GPU utilization is sampled engine duty cycle, not SM occupancy or a kernel profile.','Phase fields are point samples and may refer to different substeps; nested timings must not be added to their parents.','publish_ms is stats publication; encode_shared_ms and client_datagrams_ms describe stream encoding.','City bytes/packets per second cover 60 simulation ticks and overstate wall rates when the simulation is slow.','Client geometry and body origins are different, asynchronous measurements.','Geometry sweep enable/time and shallow deepest provenance are absent.','No same-input before/after performance comparison is claimed.']}
summary['observed_outbound_mbps']=summary['network_delta']['total_outbound_bytes']*8/duration/1e6
summary['evidence_sha256']={str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.rglob('*')) if p.is_file()}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
(out/'capture-live.py').write_text(Path('/tmp/sample-city-live-player.py').read_text())
(out/'archive-live.py').write_text(Path(__file__).read_text())
print(json.dumps({k:summary[k] for k in ['reports','live_samples','start_utc','end_utc','observed_tick_rate','gpu_utilization_percent','process_cpu_cores','observed_outbound_mbps','network_delta','live_deduplicated_ring']},indent=2))
