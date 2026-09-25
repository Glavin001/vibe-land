#!/usr/bin/env python3
"""Rest-pose statistics from a city-bench run's encoder tape: final pose of every live chunk body,
and the motion over the 10 ticks before each settle (sleep) edge. usage: bench_rest.py <city-bench run dir> <out.csv>; compare two CSVs with rest_compare.py"""
import sys, math, glob, subprocess, json
from collections import deque
from tape import ticks
R=sys.argv[1]; out=sys.argv[2]
tp=glob.glob(R+'/debug-reports/*/server/city/encoder.tape')[0]
pose={}; nodes={}; alive=set(); hist={}; sleeping=set()
edges=[]; last_tick=0
proc=subprocess.Popen(['zstd','-dc',tp],stdout=subprocess.PIPE)
for tick, rows, batches, settles, wakes in ticks(proc.stdout):
    last_tick=tick
    for sid,k,mg,promos,retired in batches:
        for s2,isl,chunks,vals in promos:
            e=0x80000000|(s2<<20)|isl; alive.add(e); nodes[e]=len(chunks); pose[e]=(vals[7:10],vals[10:14])
        for isl in retired:
            e=0x80000000|(sid<<20)|isl; alive.discard(e)
    for r in rows:
        e=r[0]; pose[e]=(r[1:4],r[4:8]); sleeping.discard(e)
        h=hist.setdefault(e,deque(maxlen=11)); h.append((tick,r[1:4],r[4:8]))
    for s in settles:
        e=0x80000000|(s[0]<<20)|s[1]; p,q=s[2:5],s[5:9]; pose[e]=(p,q); sleeping.add(e)
        h=hist.get(e)
        if h and len(h)==11 and tick-h[0][0]<=12:
            d=math.dist(p,h[0][1]); a=math.degrees(2*math.acos(min(1,abs(sum(x*y for x,y in zip(q,h[0][2]))))))
            edges.append((d,a))
    for w in wakes:
        sleeping.discard(0x80000000|(w[0]<<20)|w[1])
def tilt(q):
    x,y,z,w=q; n=math.sqrt(x*x+y*y+z*z+w*w); x,y,z,w=x/n,y/n,z/n,w/n
    # world-up components of the body's x,y,z axes (row 2 of rotation matrix)
    ups=[2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x)]
    return min(math.degrees(math.acos(min(1,abs(u)))) for u in ups)
f=open(out,'w'); f.write('entity,nodes,sleeping,x,y,z,tilt_deg\n')
for e in alive:
    if e not in pose: continue
    p,q=pose[e]
    if not all(map(math.isfinite,p)) or p[1]<-3 or p[1]>200: continue
    f.write('%d,%d,%d,%.4f,%.4f,%.4f,%.3f\n'%(e,nodes.get(e,1),int(e in sleeping),p[0],p[1],p[2],tilt(q)))
f.close()
ds=sorted(d for d,a in edges); as_=sorted(a for d,a in edges)
q=lambda v,p: v[min(len(v)-1,int(round(p/100*(len(v)-1))))] if v else 0
moving=sum(1 for d,a in edges if d>0.01 or a>1.0)
print(json.dumps(dict(run=R.split('/')[-1],last_tick=last_tick,sleep_edges=len(edges),stopped_while_moving_1cm_1deg=moving,
  edge_disp_p50=round(q(ds,50),4),edge_disp_p99=round(q(ds,99),4),edge_disp_max=round(q(ds,100),4),edge_turn_p99=round(q(as_,99),2),edge_turn_max=round(q(as_,100),2))))
