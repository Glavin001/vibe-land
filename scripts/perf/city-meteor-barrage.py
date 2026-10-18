#!/usr/bin/env python3
"""City meteor barrage timing: the server's own tick stats around a fixed meteor barrage.

Needs a server on 127.0.0.1:4001 with a player joined to /city (the city match
exists only once someone joins; a browser tab at http://localhost:3003/city
clicked to join is enough). Fires 8 meteors at the first 8 buildings, one every
2 s, polling /match-stats/city-default (a rolling 3 s window of tick times)
before, during and for 20 s after. Same targets every run, so configurations
compare (cap, force tolerance, fleet on/off: restart the server between runs).

  python3 scripts/perf/city-meteor-barrage.py LABEL OUT.json
"""
import json, sys, time, urllib.request, statistics as st
BASE = 'http://127.0.0.1:4001'
def get(p): return json.loads(urllib.request.urlopen(BASE + p, timeout=5).read())
def post(p, body):
    r = urllib.request.Request(BASE + p, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    return urllib.request.urlopen(r, timeout=5).read().decode()
label = sys.argv[1]
b = get('/city-buildings')
bs = b if isinstance(b, list) else b.get('buildings', [])
def centre(x):
    for k in ('centre', 'center', 'position', 'centroid'):
        if k in x: return x[k]
    return [x['x'], x.get('y', 0), x['z']]
targets = [centre(x) for x in bs[:12]]
samples = []
def poll(phase):
    s = get('/match-stats/city-default')['timings']['total_ms']
    samples.append((phase, time.time(), s['avg'], s['p95'], s['max']))
for _ in range(3): poll('idle'); time.sleep(1)
t0 = time.time()
for i, t in enumerate(targets[:8]):          # 8 meteors, one every 2 s
    post('/city-meteor/city-default', {'targets': [[t[0], t[1] if len(t) > 2 else 0, t[2] if len(t) > 2 else t[1]]]})
    for _ in range(2): poll('barrage'); time.sleep(1)
for _ in range(20): poll('after'); time.sleep(1)
def summ(ph):
    r = [x for x in samples if x[0] == ph]
    return dict(n=len(r), avg=round(st.mean(x[2] for x in r), 1), p95_median=round(st.median(x[3] for x in r), 1), worst=round(max(x[4] for x in r), 1),
                windows_p95_over_16_7=sum(1 for x in r if x[3] > 16.7))
out = {'label': label, 'targets': len(targets), **{ph: summ(ph) for ph in ('idle', 'barrage', 'after')}}
print(json.dumps(out))
open(sys.argv[2], 'w').write(json.dumps({'summary': out, 'samples': samples}))
