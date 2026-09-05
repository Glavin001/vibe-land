"""Independent sampled geometry check of the documented rotational envelope."""
import itertools,json,math

def norm(v): return math.sqrt(sum(x*x for x in v))
def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def rotate(p,u,t):
 c,s=math.cos(t),math.sin(t); dot=sum(x*y for x,y in zip(p,u)); q=cross(u,p)
 return tuple(c*x+s*y+(1-c)*dot*z for x,y,z in zip(p,q,u))
count=0; old_misses=0; worst=0
for center,extents,axis,angle in itertools.product([(0,0,0),(3,-5,.2),(-.55,0,0)],[(.5,.5,.5),(.1,.7,2)],[(0,0,1),(1,2,3),(-2,1,.1)],[0,1e-6,.3,1.9,2.1,math.pi,8.333333,1000]):
 axis=tuple(x/norm(axis) for x in axis)
 radius=norm(tuple(abs(c)+e for c,e in zip(center,extents)))
 bound=min(angle,2)*radius
 old_bound=angle*norm(extents)
 for signs in itertools.product((-1,1),repeat=3):
  p=tuple(c+s*e for c,s,e in zip(center,signs,extents))
  for i in range(65):
   q=rotate(p,axis,angle*i/64)
   distance=norm(tuple(a-b for a,b in zip(q,p)))
   assert distance<=bound+1e-10, (center,extents,axis,angle,i,distance,bound)
   count+=1;old_misses+=distance>old_bound+1e-10
   if bound:worst=max(worst,distance/bound)
print(json.dumps(dict(sampled_points=count,violations=0,old_offset_radius_violations=old_misses,max_bound_fraction=worst),indent=2))
