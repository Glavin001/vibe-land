#!/usr/bin/env python3
"""Check report and live-observation claims against retained evidence."""
from pathlib import Path
import gzip,hashlib,json,statistics
base=Path(__file__).resolve().parent
root=base.parents[2]
s=json.loads((base/'summary.json').read_text())
for name,expected in s['evidence_sha256'].items():
 assert hashlib.sha256((base/name).read_bytes()).hexdigest()==expected,name
reports=json.loads((base/'reports.json').read_text())['reports']
assert len(reports)==6
for report in reports:
 original=root/'debug-reports'/report['report']
 for name,expected in report['source_sha256'].items():
  assert hashlib.sha256((original/name).read_bytes()).hexdigest()==expected
 raw=json.loads((original/'server.json').read_text())
 assert raw['timings']['total_ms']==report['server_rolling_180_ticks_ms']['total_ms']
 assert raw['city']['awake_bodies']==report['awake_bodies']
 assert report['release_artifact']==s['release_artifact']
 assert report['client_transport']=='webtransport'
 assert report['client_topology_counters']['chunksTotal']==96420
 for k in ['topoSeqGaps','orphanedChunks','orphanedByRetire','settleRejects','hashMismatches','structureRepairs']:
  assert report['client_topology_counters'][k]==0
 assert all(v==0 for v in report['server_network_counters'].values())
 assert report['gpu_warning_count']==0 and report['server_counters']['contacts_dropped']==0
assert [r['awake_bodies'] for r in reports]==[1579,2148,4066,4599,7126,7887]
assert reports[-1]['pending_input_frames']==[112]
assert round(reports[-1]['first_physics_pass_point_sample']['contact_host_work_ms'],2)==92.68
assert reports[-1]['first_physics_pass_point_sample']['direct_contact_count']==491861
assert round(reports[-1]['replay_point_sample']['resim_restore_ms'],2)==137.07
assert reports[-1]['client_geometry_point_sample']['chunksBelowGround']==164
assert reports[-1]['client_geometry_point_sample']['deepest'] is None
samples=[json.loads(gzip.decompress(p.read_bytes())) for p in sorted((base/'live').glob('*.gz'))]
assert len(samples)==10
first,last=samples[0],samples[-1]
duration=last['monotonic']-first['monotonic']
assert duration==s['duration_seconds']
assert (last['stats']['server_tick']-first['stats']['server_tick'])/duration==s['observed_tick_rate']
assert round(s['observed_tick_rate'],2)==12
assert abs(statistics.mean(x['stats']['timings']['total_ms']['avg'] for x in samples)-s['rolling_tick_mean_ms']['mean'])<1e-9
assert all(x['stats']['player_count']==1 for x in samples)
assert all(p['pending_inputs']==0 for x in samples for p in x['stats']['players'])
assert all('identity' not in p and 'pos_m' not in p for x in samples for p in x['stats']['players'])
assert statistics.mean(float(x['gpu'].split(',')[0]) for x in samples)==9.2
for k,expected in s['network_delta'].items():
 assert last['stats']['network'][k]-first['stats']['network'][k]==expected
assert s['network_delta']['total_inbound_packets']==9
assert s['network_delta']['dropped_outbound_packets']==0
assert abs(s['observed_outbound_mbps']-s['network_delta']['total_outbound_bytes']*8/duration/1e6)<1e-12
unique={}
for sample in samples:
 for row in sample['stats']['tick_ring']:
  assert row['t'] not in unique or unique[row['t']]==row
  unique[row['t']]=row
assert len(unique)==s['live_deduplicated_ring']['ticks']==840
assert max(unique.values(),key=lambda r:r['total'])==s['live_deduplicated_ring']['worst_tick']
latest=json.loads((base/'latest.json').read_text())
assert latest['players']==1 and latest['awake_bodies']==5431
assert round(latest['tick_ms']['avg'],2)==56.38
assert latest['pending_inputs']==[0] and latest['dropped_outbound_packets']==0
print('PASS: six source-hashed reports, ten live samples, deduplicated timing rings, healthy recorded streaming, CPU/contact bottleneck and geometry limits retained')
