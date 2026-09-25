#!/usr/bin/env python3
"""Approximate contact islands of the city bodies awake through ticks T0..T1 of a city-bench
capture (bounding spheres from the manifest's chunk boxes), and which members actually move.
usage: islands.py <run>/debug-reports/*/server/city/encoder.tape <.../manifest.json> T0 T1"""
import sys, json, math, subprocess
from collections import defaultdict
from tape import ticks
tp, man, a, b = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
m=json.load(open(man)); S={s['structureId']:s for s in m['structures']}
members={}; track=defaultdict(list)
p=subprocess.Popen(['zstd','-dc',tp],stdout=subprocess.PIPE)
for tick, rows, batches, settles, wakes in ticks(p.stdout):
    if tick>b: break
    for sid,k,mg,promos,retired in batches:
        for s2,isl,chunks,vals in promos: members[0x80000000|(s2<<20)|isl]=chunks
    if tick>=a:
        for r in rows: track[r[0]].append(r[1:4])
p.kill()
full=[e for e,t in track.items() if len(t)>=(b-a)*0.95]
def radius(e):
    ch=members.get(e,())
    if not ch: return 1.0
    pts=[S[c>>16]['chunks'][c&0xffff] for c in ch]
    cx=[sum(q['centroid'][i] for q in pts)/len(pts) for i in range(3)]
    return max(math.dist(q['centroid'],cx)+math.sqrt(sum(h*h for h in q['geometry']['halfExtents'])) for q in pts)
info={}
for e in full:
    t=track[e]; path=sum(math.dist(t[i],t[i-1]) for i in range(1,len(t))); net=math.dist(t[0],t[-1])
    info[e]=dict(p=t[-1],r=radius(e),path=path,net=net)
par={e:e for e in full}
def f(x):
    while par[x]!=x: par[x]=par[par[x]]; x=par[x]
    return x
L=sorted(full,key=lambda e:info[e]['p'][0])
for i,e in enumerate(L):
    for g in L[i+1:]:
        if info[g]['p'][0]-info[e]['p'][0] > info[e]['r']+6: break
        if math.dist(info[e]['p'],info[g]['p'])<info[e]['r']+info[g]['r']+0.05: par[f(e)]=f(g)
cl=defaultdict(list)
for e in full: cl[f(e)].append(e)
rows=[]
for root,es in cl.items():
    moving=[e for e in es if info[e]['path']>0.005]
    still=[e for e in es if info[e]['path']<=0.001]
    rows.append((len(es),len(moving),len(still),max((info[e]['net'] for e in es),default=0), [ (hex(e),round(info[e]['path'],3),round(info[e]['net'],4)) for e in sorted(moving,key=lambda e:-info[e]['path'])[:3]]))
rows.sort(reverse=True)
print('awake through window:',len(full),' clusters:',len(rows))
print('cluster sizes:',[r[0] for r in rows])
print('clusters with no body moving >5 mm path:',sum(1 for r in rows if r[1]==0), 'bodies in them', sum(r[0] for r in rows if r[1]==0))
for r in rows[:12]: print(' size %d moving %d still %d max_net %.3f m  movers %s'%r)
