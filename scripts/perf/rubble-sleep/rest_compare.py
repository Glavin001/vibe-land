#!/usr/bin/env python3
"""Compare rest-pose distributions from perf_bench rubble_sleep CSVs: rest_compare.py A.csv[,A2.csv] B.csv[,B2.csv]"""
import csv, sys, math
def load(spec):
    rows=[]
    for f in spec.split(','):
        rows+= [dict(nodes=int(r['nodes']),sleeping=int(r['sleeping']),y=float(r['y']),tilt=float(r['tilt_deg'])) for r in csv.DictReader(open(f))]
    return rows
def q(v,p):
    v=sorted(v); return v[min(len(v)-1,int(round(p/100*(len(v)-1))))]
def ks(a,b):
    import bisect
    a=sorted(a); b=sorted(b); d=0
    for v in set(a)|set(b):
        d=max(d,abs(bisect.bisect_right(a,v)/len(a)-bisect.bisect_right(b,v)/len(b)))
    n=len(a)*len(b)/(len(a)+len(b)); crit=1.36/math.sqrt(n)
    return d,crit
def summary(name,rows):
    ys=[r['y'] for r in rows]; ts=[r['tilt'] for r in rows]; n=len(rows)
    print(f"{name}: bodies {n} asleep {sum(r['sleeping'] for r in rows)/n:.3f} | y p10/50/90/99 {q(ys,10):.3f}/{q(ys,50):.3f}/{q(ys,90):.3f}/{q(ys,99):.3f} mean {sum(ys)/n:.3f} | tilt p50/90/99 {q(ts,50):.2f}/{q(ts,90):.2f}/{q(ts,99):.2f} | flat<2 {sum(t<2 for t in ts)/n:.3f} lean>5 {sum(t>5 for t in ts)/n:.3f} lean>15 {sum(t>15 for t in ts)/n:.3f}")
    return ys,ts
A=load(sys.argv[1]); B=load(sys.argv[2])
ya,ta=summary('A',A); yb,tb=summary('B',B)
for k,a,b in (('y',ya,yb),('tilt',ta,tb)):
    d,c=ks(a,b); print(f"KS {k}: D={d:.4f} (5% critical {c:.4f}) -> {'differ' if d>c else 'no significant difference'}")
# single-chunk bodies only
a1=[r for r in A if r['nodes']==1]; b1=[r for r in B if r['nodes']==1]
if a1 and b1:
    for k in ('y','tilt'):
        d,c=ks([r[k] for r in a1],[r[k] for r in b1]); print(f"KS {k} (single-chunk): D={d:.4f} crit {c:.4f}")
