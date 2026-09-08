#!/usr/bin/env python3
"""Summarize live browser/server evidence; this is not an isolated timing gate."""
import argparse,collections,datetime,gzip,hashlib,json,re,statistics
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('session',type=Path);p.add_argument('server_log',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
complete=json.loads((a.session/'complete.json').read_text());assert complete['passed']
rows=[json.loads(s) for s in (a.session/'server.jsonl').read_text().splitlines()]
assert rows and all(not r['stats']['city']['degraded'] for r in rows)
ring={};groups=collections.defaultdict(dict)
for r in rows:
 s=r['stats'];groups[r['phase']][s['server_tick']]=s
 for tick in s['tick_ring']:
  if tick['t'] in ring:assert ring[tick['t']]==tick,'conflicting historical tick'
  ring[tick['t']]=tick
lo,hi=rows[0]['wall'],rows[-1]['wall'];launches=[]
for line in a.server_log.read_text().splitlines():
 if 'native demolition projectile launched' not in line:continue
 ms=datetime.datetime.fromisoformat(line.split()[0].replace('Z','+00:00')).timestamp()*1000
 if lo<=ms<=hi:launches.append(line)
peak=max(rows,key=lambda r:r['stats']['physics_last_step_ms'])['stats'];city=peak['city'];native=lambda s,k:s['spans']['destruction/native_'+k]['v']
assert native(peak,'chunks')==24105 and native(peak,'bonds')==74543
assert complete['final']['city']['hashMismatches']==0 and complete['final']['city']['orphanedChunks']==0
q=a.output;q.mkdir(parents=True,exist_ok=False)
summary=dict(duration_wall_seconds=(hi-lo)/1000,trigger_actions=complete['actions'],client_predicted_shots=complete['final']['shotsFired'],accepted_projectiles=len(launches),peak_sample=peak,final_server=rows[-1]['stats'],unique_ring_ticks=len(ring),ring_gaps=max(ring)-min(ring)+1-len(ring),launches=launches,source_sha256=hashlib.sha256((a.session/'server.jsonl').read_bytes()).hexdigest())
(q/'summary.json').write_text(json.dumps(summary,indent=2));(q/'server.jsonl.gz').write_bytes(gzip.compress((a.session/'server.jsonl').read_bytes(),mtime=0))
(q/'ticks.json.gz').write_bytes(gzip.compress(json.dumps([ring[k] for k in sorted(ring)]).encode(),mtime=0))
for name in ['complete.json','actions.json','idle.json','two-shots.json','five-shots.json','settled.json','errors.json']:(q/(name+'.gz')).write_bytes(gzip.compress((a.session/name).read_bytes(),mtime=0))
lines=['# Live browser reproduction after a few shots','',
 'Deployed PhysX embedded destruction: **27 buildings, 24,105 chunks, 74,543 bonds**, Direct GPU off, sleeping on, correction limit one. This used the playable client and actual accepted projectile commands.', '',
 f"{complete['actions']} trigger actions produced **{len(launches)} server-accepted physical projectiles** during {(hi-lo)/1000:.1f} seconds of observation. The software-rendered browser predicted {complete['final']['shotsFired']} shots; client trigger counts are not authoritative projectile counts.", '',
 'The existing scene was reset before shooting. Previously spawned ordinary bodies remained, so this is a reset-structure idle observation, not a pristine isolated-world benchmark. The first aborted attempt aimed incorrectly from a different spawn and is not used as successful evidence.', '',
 '| Observed phase | Unique cached server samples | Physics min ms | Physics median ms | Physics max ms | Max fragments / awake | Max stress iterations |',
 '|---|---:|---:|---:|---:|---:|---:|']
for phase in ['intact-idle','two-shots','two-shot-aftermath','five-shots','settling']:
 samples=list(groups[phase].values());v=[s['physics_last_step_ms'] for s in samples]
 lines.append(f"| {phase} | {len(v)} | {min(v):.3f} | {statistics.median(v):.3f} | {max(v):.3f} | {max(s['city']['chunk_bodies'] for s in samples)} / {max(s['city']['awake_bodies'] for s in samples)} | {int(max(native(s,'stress_iterations') for s in samples))} |")
lines+=['',
 'Phase names mark browser actions, not exact server command application. Slow software rendering delays input delivery. Server status is cached periodically: physics samples can miss peaks and are not independent repeated trials. The archived tick ring preserves the full server tick timings separately.', '',
 f"The worst sampled physics step is **{peak['physics_last_step_ms']:.3f} ms**, tick {peak['server_tick']}: {city['chunk_bodies']} fragments / {city['awake_bodies']} awake, {city['broken_bonds']} broken bonds, {peak['dynamic_body_count']} ordinary dynamic bodies; {int(native(peak,'stress_iterations'))} maximum stress iterations, {int(native(peak,'stress_passes'))} stress evaluations and {int(native(peak,'correction_passes'))} correction.", '',
 f"Archived {len(ring):,} unique server ticks, {summary['ring_gaps']} gaps and no conflicting duplicate values. Total-tick peak over the entire captured ring (including reset/history) is {max(t['total'] for t in ring.values()):.3f} ms; it must not be conflated with the sampled physics peak.", '',
 '## Findings','',
 '- A small local break is sufficient to reproduce a large simulation hitch.',
 '- Quiet simulation returns near its improved idle cost after settling. The problem is active destruction/impact peaks, not uniformly slow quiet simulation.',
 '- Rendering membership remained valid: no hash mismatches or orphaned chunks. All captured server statuses remained non-degraded.',
 '- This live evidence does not attribute the hitch among stress, hierarchy rebuild and correction; use the separate native phase replay for that.', '',
 '[Machine-readable summary](summary.json). Raw server observations, deduplicated tick history, browser actions and accepted projectile launch logs are archived alongside this report.', '']
(q/'report.md').write_text('\n'.join(lines));print(q/'report.md')
