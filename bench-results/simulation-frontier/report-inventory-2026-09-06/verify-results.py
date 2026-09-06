#!/usr/bin/env python3
"""Verify capture classification and preserve every previous reported measurement."""
from pathlib import Path
import json
root=Path(__file__).resolve().parent
old=json.loads((root.parent/'player-reports-2026-09-05'/'summary.json').read_text())
new=json.loads((root/'player-captures-v2.json').read_text())
assert len(old['reports'])==len(new['reports'])==6
for a,b in zip(old['reports'],new['reports']):
    assert a=={k:v for k,v in b.items() if k not in ('release_artifact','capture_context')}
    assert not b['capture_context']['loopback_url']
    assert not b['capture_context']['headless_browser']
    assert b['capture_context']['client_city_telemetry_present']
local=json.loads((root/'local-captures.json').read_text())
assert new['schema']==local['schema']==2
assert len(local['reports'])==2
for report in local['reports']:
    context=report['capture_context']
    assert context['origin_hint']=='local_headless'
    assert not context['client_city_telemetry_present']
    assert not context['client_frame_telemetry_present']
    assert context['server_players_at_snapshot']==0
    assert all(v is None for v in report['client_topology_counters'].values())
    assert report['release_artifact']['game_revision']=='ed9c2ad'
    assert report['release_artifact']['binary_sha256']=='9b405a0199afba106b248666b551dabb9e8dea110274fbb861a48f72d051e8d1'
print('PASS: all six player measurements preserved; two local captures retain absent telemetry and release provenance.')
