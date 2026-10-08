"""A stage capture (.impc, PhysX PX_DESTRUCTION_IMPACT_CAPTURE[_STATIC]) read on the CPU.

The capture is the impact solve's Inputs as raw structs (PhysX
physx/source/gpudestruction/src/PxgDestructionImpactCapture.cuh writeCapture, version 2):

    header   'IMPC', version, n chunks, m bonds, materials, rows, sizeof(Settings), flags
    Settings (raw; only its leading, layout-stable fields are read: dt .. sectionRotation)
    chunks   PxDestructionStressChunk[n]   position, mass, inertia, cluster, contactIndex, volume, material
    bonds    PxDestructionStressBond[m]    chunk0, chunk1, centroid, normal, area, health, complianceScale, material
    materials PxDestructionMaterial[k]     limits, crush properties, ductileSlip, impactStiffness, impactImpedance
    ductileSlip[k], stiffness[k] (flags 1, 2), health[m], nodeBegin[n+1], refs, nodeRefs[refs],
    nodeIslands[n], bondIslands[m], accelerations[n], elastic[m], base[m] (vector pairs),
    elasticBase[m] (4), crushed[n] (PxDestructionCrushState, 8), sections[m]
    (PxDestructionBondSection, 16), rows (ContactRow, 32), carried[m] (64), slipBefore[m] (128),
    rowRouted[rows] (256)

prepare_bond() is impact::prepareBond (PxgDestructionImpact.cuh) on the CPU: the bond's frame,
its wrench points, capacities (9 terms, explicit-step.util_vec's order) and stiffness per
component. The read is checked by the file's size: every array must end exactly at its end.
"""
import pathlib, struct
import numpy as np

F4, U4 = '<f4', '<u4'
CHUNK = np.dtype([('position', F4, 3), ('mass', F4), ('inertia', F4), ('cluster', U4), ('contactIndex', U4),
                  ('volume', F4), ('material', U4)])
BOND = np.dtype([('chunk0', U4), ('chunk1', U4), ('centroid', F4, 3), ('normal', F4, 3), ('area', F4), ('health', F4),
                 ('complianceScale', F4), ('material', U4)])
MATERIAL = np.dtype([('compressionElasticLimit', F4), ('compressionFatalLimit', F4), ('tensionElasticLimit', F4),
                     ('tensionFatalLimit', F4), ('shearElasticLimit', F4), ('shearFatalLimit', F4), ('residualAreaFraction', F4),
                     ('capPressure', F4), ('cohesion', F4), ('frictionSlope', F4), ('crushEnergy', F4), ('crushViscosity', F4),
                     ('strainRateExponent', F4), ('referenceStrainRate', F4), ('debrisMassFraction', F4), ('debrisFragmentCount', U4),
                     ('ductileSlip', F4), ('impactStiffness', F4), ('impactImpedance', F4)])
PAIR = np.dtype([('linear', F4, 3), ('angular', F4, 3)])
CRUSH = np.dtype([('damage', F4), ('pressure', F4), ('deviator', F4), ('utilisation', F4), ('crushed', U4)])
SECTION = np.dtype([('axis', F4, 3), ('bendModulus0', F4), ('bendModulus1', F4), ('twistModulus', F4), ('gyration0', F4),
                    ('gyration1', F4), ('polarGyration', F4), ('bearingDepth0', F4), ('bearingDepth1', F4)])
ROW = np.dtype([('chunk', U4), ('body', U4), ('points', U4), ('friction', F4), ('point', F4, 3), ('normal', F4, 3),
                ('load', F4, 3), ('torque', F4, 3), ('com', F4, 3), ('velocity', F4, 3), ('spin', F4, 3), ('dv', F4, 3),
                ('dw', F4, 3), ('im', F4), ('ii', F4, 6), ('resting', U4)])
assert CHUNK.itemsize == 36 and BOND.itemsize == 48 and MATERIAL.itemsize == 76 and ROW.itemsize == 156 and SECTION.itemsize == 44


class Capture:
    def __init__(self, path):
        b = pathlib.Path(path).read_bytes(); self.path = str(path)
        if b[:4] != b'IMPC': raise ValueError(f'{path}: not a capture')
        ver, n, m, k, rows, sb, fl = struct.unpack_from('<7I', b, 4)
        if ver < 2: raise ValueError(f'{path}: version {ver} (rows without `resting`): not read')
        self.version, self.n, self.m, self.flags = ver, n, m, fl
        s = b[32:32 + sb]
        self.settings = dict(dt=struct.unpack_from('<f', s, 0)[0], bendGainMax=struct.unpack_from('<f', s, 4)[0],
                             stiffness=struct.unpack_from('<f', s, 8)[0], lengthScale=struct.unpack_from('<f', s, 12)[0],
                             stiffnessScale=struct.unpack_from('<f', s, 16)[0], momentAtCentroid=bool(s[20]),
                             solverAtCentroid=bool(s[21]), sectionBending=bool(s[22]), sectionRotation=bool(s[23]))
        o = 32 + sb
        def take(dt, count):
            nonlocal o
            a = np.frombuffer(b, dt, count, o).copy(); o += dt.itemsize * count if isinstance(dt, np.dtype) else np.dtype(dt).itemsize * count
            return a
        self.chunks = take(CHUNK, n); self.bonds = take(BOND, m); self.materials = take(MATERIAL, k)
        self.ductileSlip = take(np.dtype(F4), k) if fl & 1 else np.zeros(k, np.float32)
        self.stiffness = take(np.dtype(F4), k) if fl & 2 else None
        self.health = take(np.dtype(F4), m)
        self.nodeBegin = take(np.dtype(U4), n + 1)
        refs = take(np.dtype(U4), 1)[0]; self.nodeRefs = take(np.dtype(U4), refs)
        self.nodeIslands = take(np.dtype(U4), n); self.bondIslands = take(np.dtype(U4), m)
        self.accelerations = take(PAIR, n); self.elastic = take(PAIR, m); self.base = take(PAIR, m)
        self.elasticBase = take(PAIR, m) if fl & 4 else None
        self.crushed = take(CRUSH, n) if fl & 8 else None
        self.sections = take(SECTION, m) if fl & 16 else None
        self.rows = take(ROW, rows) if fl & 32 else np.zeros(0, ROW)
        self.carried = take(np.dtype(U4), m) if fl & 64 else None
        self.slipBefore = take(np.dtype(F4), m) if fl & 128 else None
        self.rowRouted = take(np.dtype(U4), rows) if (fl & 256 and rows) else None
        if o != len(b): raise ValueError(f'{path}: read {o} of {len(b)} bytes (a struct layout differs from this build)')

    # ---------------------------------------------------------------- impact.cuh's predicates
    def gone(self, c):
        return self.crushed is not None and bool(self.crushed['crushed'][c])

    def member(self, i):
        """bondMember: live area above float's resolution of the authored area, neither chunk crushed."""
        bd = self.bonds[i]
        if not self.health[i] > 8.0 * np.finfo(np.float32).eps * bd['area']: return False
        return not self.gone(bd['chunk0']) and not self.gone(bd['chunk1'])

    def chunk_bonds(self, c):
        return [int(i) for i in self.nodeRefs[self.nodeBegin[c]:self.nodeBegin[c + 1]]]

    def modulus(self, c):
        """exModulus (PxgDestructionImpactExplicit.cuh): the mean over the chunk's member joints of k L / A
        (k the joint's axial stiffness, L its length along the normal, at least sqrt A)."""
        s = self.settings; tot, cnt = 0.0, 0
        for i in self.chunk_bonds(c):
            if not self.member(i): continue
            bd = self.bonds[i]; A = float(bd['area'])
            if not A > 0: continue
            k = s['stiffnessScale'] * (self.stiffness[bd['material']] if self.stiffness is not None else s['stiffness']) * bd['complianceScale'] ** 2
            nrm = bd['normal'] / max(np.linalg.norm(bd['normal']), 1e-30)
            d = self.chunks[bd['chunk1']]['position'] - self.chunks[bd['chunk0']]['position']
            L = max(abs(float(d @ nrm)), np.sqrt(A))
            if 0 < k < 1e30: tot += k * L / A; cnt += 1
        return tot / cnt if cnt else 0.0

    def prepare_bond(self, i):
        """impact::prepareBond. Returns None for a bond with no live area, else a dict: c0, c1, n/t1/t2
        (rows of R), o0, o1 (the wrench point from each chunk), F (capC, capT, capS, gb, gt, g0, g1, h0,
        h1: util_vec's order), k (6: N, V1, V2 on forces; twist, M1, M2), slip (ultimate, 0 brittle)."""
        s = self.settings; bd = self.bonds[i]; area = float(self.health[i])
        if not (area > 0 and area < 0.5 * np.finfo(np.float32).max): return None
        c0, c1 = int(bd['chunk0']), int(bd['chunk1']); C0, C1 = self.chunks[c0], self.chunks[c1]
        p0, p1 = C0['position'].astype(float), C1['position'].astype(float); disp = p1 - p0
        nrm = bd['normal'].astype(float) * np.copysign(1.0, float(bd['normal'] @ disp))
        l = np.linalg.norm(nrm); nrm = nrm / l if l > 0 else np.array([1.0, 0, 0])
        mat = self.materials[bd['material']]
        slip = float(self.ductileSlip[bd['material']]) if self.ductileSlip[bd['material']] > 0 else 0.0
        sec = self.sections[i] if (s['sectionBending'] and self.sections is not None) else None
        if sec is not None and sec['bendModulus0'] > 0:
            ax = sec['axis'].astype(float); ax = ax - nrm * (ax @ nrm); ax /= np.linalg.norm(ax)
            R = np.array([nrm, ax, np.cross(nrm, ax)])
        else:
            e = np.array([1.0, 0, 0]) if abs(nrm[0]) < 0.9 else np.array([0, 1.0, 0])
            t1 = np.cross(nrm, e); t1 /= np.linalg.norm(t1); R = np.array([nrm, t1, np.cross(nrm, t1)])
        both = C0['mass'] > 0 and C1['mass'] > 0
        P = p0 + disp * 0.5 if (not s['solverAtCentroid'] and both) else bd['centroid'].astype(float)
        point = bd['centroid'].astype(float) if (s['momentAtCentroid'] or s['sectionBending']) else P
        capC, capT, capS = mat['compressionFatalLimit'] * area, mat['tensionFatalLimit'] * area, mat['shearFatalLimit'] * area
        root = np.sqrt(max(area, 1e-6)); g0 = g1 = h0 = h1 = 0.0
        if not s['sectionBending']:
            gb = min(6.0 / root, s['bendGainMax']); gt = min(4.81 / root, s['bendGainMax'])
        elif sec is not None and sec['bendModulus0'] > 0 and sec['bendModulus1'] > 0 and sec['twistModulus'] > 0 and bd['area'] > 0:
            live = area / float(bd['area'])
            g0 = area / (sec['bendModulus0'] * live); g1 = area / (sec['bendModulus1'] * live); gt = area / (sec['twistModulus'] * live); gb = g0
            h0, h1 = g0, g1
            if sec['bearingDepth0'] > 0 and sec['bearingDepth1'] > 0: h0, h1 = 1.0 / sec['bearingDepth0'], 1.0 / sec['bearingDepth1']
        else:
            gb = 6.0 / root; gt = 4.2426407 / root
        k = s['stiffnessScale'] * (self.stiffness[bd['material']] if self.stiffness is not None else s['stiffness']) * bd['complianceScale'] ** 2
        kr = k * s['lengthScale'] ** 2; kt = k0 = k1 = kr
        if s['sectionRotation']:
            r0, r1, rp = (float(sec['gyration0']), float(sec['gyration1']), float(sec['polarGyration'])) if sec is not None else (0, 0, 0)
            if not r0 > 0: r0 = r1 = np.sqrt(bd['area'] / 12.0); rp = r0 * 1.41421356
            k0, k1, kt = k * r0 * r0, k * r1 * r1, k * rp * rp
        return dict(bond=i, c0=c0, c1=c1, R=R, o0=point - p0, o1=point - p1, area=area, material=int(bd['material']),
                    F=np.array([capC, capT, capS, gb, gt, g0, g1, h0, h1], float), k=np.array([k, k, k, kt, k0, k1], float),
                    slip=slip, centroid=bd['centroid'].astype(float))

    def summary(self):
        live = sum(1 for i in range(self.m) if self.member(i))
        crushed = int(self.crushed['crushed'].sum()) if self.crushed is not None else 0
        return (f"{self.path}: {self.n} chunks ({crushed} crushed), {self.m} bonds ({live} members), {len(self.materials)} materials, "
                f"{len(self.rows)} rows; settings {self.settings}")
