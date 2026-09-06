#!/usr/bin/env python3
"""Verify retained exact-input evidence, without claiming deterministic physics."""
from pathlib import Path
import csv, gzip, hashlib, io, json
base=Path(__file__).resolve().parent
summary=json.loads((base/'summary.json').read_text())
for name,expected in summary['evidence_sha256'].items():
 assert hashlib.sha256((base/name).read_bytes()).hexdigest()==expected,name

def load(name):return json.loads((base/name).read_text())
def rows(name):return list(csv.DictReader(io.StringIO(gzip.decompress((base/name).read_bytes()).decode())))
def log(name):return gzip.decompress((base/name).read_bytes()).decode()
assert 'test result: ok. 9 passed; 0 failed' in log('tests.log.gz')
assert 'Finished `release` profile' in log('build.log.gz')
record_bytes=(base/'record/shots.json').read_bytes()
assert record_bytes==(base/'replay/shots.json').read_bytes()
record=json.loads(record_bytes)
assert record['version']==1 and record['metadata']['hz']==60 and record['metadata']['ticks']==1200
assert len(record['shots'])==200
metrics={}
for case,expected in summary['cases'].items():
 run=load(f'{case}/run.json');assert run['exit_code']==0
 tape=load(f'{case}/shots.json');sidecar=load(f'{case}/metrics.sidecar.json')
 data=rows(f'{case}/metrics.csv.gz');metrics[case]=data
 assert len(data)==expected['ticks']==tape['metadata']['ticks']
 assert [int(row['tick']) for row in data]==list(range(len(data)))
 assert len(tape['shots'])==expected['attempted']==sidecar['shotInputs']
 assert sidecar['shotHits']==expected['hits']
 assert expected['misses']==expected['attempted']-expected['hits']
 assert max(int(row['awake']) for row in data)==expected['max_awake']
 assert sum(float(row['resim_passes'])>0 for row in data)==expected['replay_ticks']
 assert int(data[-1]['bonds'])==expected['final_broken_bonds']
 assert sidecar['membershipMismatchTicks']==0
 assert sidecar['chunks']==86966
 assert 'CUDA stress solver active' in log(f'{case}/native.log.gz')
 assert hashlib.sha256((base/f'{case}/shots.json').read_bytes()).hexdigest()==expected['input_sha256']
fixture=load('dispatch-fixture.json')
assert load('dispatch/shots.json')==fixture
assert [shot['tick'] for shot in fixture['shots']]==[60,60,119]
assert summary['cases']['dispatch']['hits']==1 and summary['cases']['dispatch']['misses']==2
first=None
for a,b in zip(metrics['record'],metrics['replay']):
 keys=[k for k in ['bodies','awake','bonds'] if a[k]!=b[k]]
 if keys:
  first={'tick':int(a['tick']),'record':{k:a[k] for k in keys},'replay':{k:b[k] for k in keys}}
  break
assert first==summary['first_counter_divergence'] and first is not None
assert summary['awake_target_5000_reached']==False
assert max(summary['cases'][c]['max_awake'] for c in ['record','replay'])<5000
for negative in summary['negative_cases']:
 assert negative['exit_code']!=0 and not negative['output_created']
 assert 'metadata differs' in log(f"negative-{negative['case']}/native.log.gz")
 assert not (base/f"negative-{negative['case']}/must-not-exist.trace").exists()
provenance=load('provenance.json')
assert provenance['simulation_env']['VIBE_PHYSX_DIRECT_GPU']=='1'
assert provenance['simulation_env']['BLAST_BOND_STRESS_GPU']=='1'
live=load('live-state.json')
assert live['sha256']=='7c5d04267217f6993ca6da0464de8a3ea8ebf8bfe3283f089521f003841aa5ee'
assert live['health']['status']=='ok'
assert live['simulation_env']['VIBE_PHYSX_DIRECT_GPU']=='1'
assert 'Original city deployment restored and healthy' in log('exclusive.log.gz')
assert summary['city_simulation_changed']==False and summary['full_multiplayer_performance_gate']==False
print('PASS: 200 identical external inputs, same-tick/miss coverage, negative metadata cases, restored city; wrong authored-height setting retained; no live-scene or performance claim')
