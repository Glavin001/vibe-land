"""Parse a VLTAPE02 city encoder tape (destruction/src/netlab/tape.rs) from stdin (decompressed)."""
import struct, sys

class R:
    def __init__(self, f): self.f=f
    def b(self,n):
        d=self.f.read(n)
        if len(d)<n: raise EOFError
        return d
    def u32(self): return struct.unpack('<I', self.b(4))[0]

ROW=struct.Struct('<I3f4f3f3fHB')  # 4+12+16+12+12+2+1 = 59

def ticks(f):
    r=R(f)
    assert r.b(8)==b'VLTAPE02'
    r.b(4+32+12+12+4)
    while True:
        try: tick=r.u32()
        except EOFError: return
        n=r.u32()
        raw=r.b(n*ROW.size)
        rows=[ROW.unpack_from(raw,i*ROW.size) for i in range(n)]
        nb=r.u32(); batches=[]
        for _ in range(nb):
            sid=r.u32(); k=r.u32(); broken=r.b(4*k); 
            m=r.u32(); r.b(12*m)
            p=r.u32(); promos=[]
            for _ in range(p):
                s2,isl=struct.unpack('<II',r.b(8)); c=r.u32(); chunks=struct.unpack('<%dI'%c, r.b(4*c))
                vals=struct.unpack('<f3f3f3f4f3f3f3f', r.b(4*(1+3+3+3+4+3+3+3)))
                promos.append((s2,isl,chunks,vals))
            q=r.u32(); retired=struct.unpack('<%dI'%q, r.b(4*q))
            batches.append((sid,k,m,promos,retired))
        s=r.u32(); settles=[struct.unpack('<II3f4f', r.b(8+28)) for _ in range(s)]
        w=r.u32(); wakes=[struct.unpack('<II', r.b(8)) for _ in range(w)]
        yield tick, rows, batches, settles, wakes
