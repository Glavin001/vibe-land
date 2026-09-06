#!/usr/bin/env python3
"""Reproduce source-hashed reports and independently check the new findings."""
import hashlib
import importlib.util
import json
from pathlib import Path

here = Path(__file__).resolve().parent
repo = here.parents[2]
spec = importlib.util.spec_from_file_location('report_analyzer', repo/'scripts/analyze-city-reports.py')
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)
data = json.loads((here/'summary.json').read_text())
assert data['schema'] == 3
assert len(data['reports']) == 3
added = {'client_geometry_point_sample', 'server_body_point_sample'}
for name in ('player-captures-v2.json', 'local-captures.json'):
    prior = json.loads((here.parent/'report-inventory-2026-09-06'/name).read_text())
    for old in prior['reports']:
        current = json.loads(json.dumps(analyzer.load_report(repo/'debug-reports'/old['report'])))
        assert old == {k:v for k,v in current.items() if k not in added}
        if not old['capture_context']['client_city_telemetry_present']:
            assert all(v is None for v in current['client_geometry_point_sample'].values())

for report, ground_count in zip(data['reports'], (0,221,145)):
    path = repo/'debug-reports'/report['report']
    assert analyzer.load_report(path) == report
    for filename, expected_hash in report['source_sha256'].items():
        assert hashlib.sha256((path/filename).read_bytes()).hexdigest() == expected_hash
    c = json.loads((path/'client.json').read_text())
    s = json.loads((path/'server.json').read_text())
    assert c['url'] == 'https://209.121.195.117:40617/city'
    assert 'HeadlessChrome' not in c['userAgent']
    assert c['snapshot']['city']['chunksBelowGround'] == ground_count
    assert report['client_geometry_point_sample']['chunksBelowGround'] == ground_count
    assert c['snapshot']['city']['deepest'] is None
    assert report['client_topology_counters']['structureRepairs'] == 0
    assert report['client_topology_counters']['hashMismatches'] == 0
    assert len([e for e in c['events']['client'] if e['kind']=='bootstrap']) == 2
    assert s['network']['dropped_outbound_packets'] == 565
    assert s['network']['dropped_outbound_snapshots'] == 273
    assert report['release_artifact']['game_revision'] == 'ed9c2ad'
    host = sum(s['spans']['physics/direct_contact_'+p+'_ms']['v'] for p in ('ownership','validate','sort','reduce','route'))
    assert abs(host-report['first_physics_pass_point_sample']['contact_host_work_ms']) < 1e-10
    assert max(s['tick_ring'],key=lambda row:row['total']) == report['server_tick_ring']['worst_tick']
last = data['reports'][-1]
assert last['pending_input_frames'] == [109]
assert last['awake_bodies'] == 5435
assert last['server_rolling_180_ticks_ms']['total_ms']['avg'] == 115.48052
assert last['server_tick_ring']['worst_tick']['t'] == 5410
assert abs(sum(data['reports'][1]['replay_point_sample'][k] for k in ('resim_restore_ms','resim_step_ms','resim_tick_ms'))-78.581152) < 1e-6

# The untracked append-only server log can be checked without retaining raw
# player addresses. The recorded interval ends before later idle telemetry.
log = repo/'.certs/vast-city/server.log'
session = json.loads((here/'session-events.json').read_text())
lines = log.read_bytes().splitlines(keepends=True)
start = next(i for i,l in enumerate(lines) if l.startswith(session['log_window_start'].encode()))
end = next(i for i in range(start,len(lines)) if lines[i].startswith(session['log_window_end_exclusive'].encode()))
assert hashlib.sha256(b''.join(lines[start:end])).hexdigest() == session['raw_window_sha256']
assert sum(session['non_droppable_drop_warning_counts_by_packet_kind'].values()) == 287
assert any('bootstrap re-sent after a dropped reliable packet' in e for e in session['events'])
print('PASS: three public reports reproduced; eight prior summaries unchanged; startup overflow, geometry readings and tick costs verified.')
