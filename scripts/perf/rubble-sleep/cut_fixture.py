#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
"""Cut a rubble neighbourhood out of a city session's encoder tape into a
physx-bridge rubble fixture (physx-bridge/tests/fixtures/rubble/*.txt).

  cut_fixture.py <encoder.tape> <manifest.json> --tick T --at X Z --radius R [--out FILE]

Every free body whose centre lies within R metres (horizontally) of (X, Z) at
tick T becomes a `body` with its chunks, at its pose then (asleep or awake);
the anchored remnant's chunks in that circle (and a margin) become `static`
boxes. The body nearest (X, Z) is the keeper.

Wire conventions (destruction/src/native_runtime.rs, client topology.ts): a
body's pose is centre-of-mass frame, `chunk_world = pose * (rest - com)` with
`rest` the chunk centroid in its structure's frame and `com` the mass-weighted
mean of the member chunks' rests. Chunk ids are `structure << 16 | node`. The
tape must start with the city intact (a fresh server), because membership is
rebuilt from the promotions it carries."""
import argparse, json, math, struct, subprocess, sys
import numpy as np

ROW = np.dtype([('id', '<u4'), ('p', '<f4', 3), ('q', '<f4', 4), ('v', '<f4', 3), ('w', '<f4', 3),
                ('nodes', '<u2'), ('flags', 'u1')])


def ticks(stream):
    read = stream.read

    def b(n):
        d = read(n)
        if len(d) < n:
            raise EOFError
        return d

    def u32():
        return struct.unpack('<I', b(4))[0]

    if b(8) != b'VLTAPE02':
        raise SystemExit('not a VLTAPE02 encoder tape')
    b(4 + 32 + 12 + 12 + 4)
    while True:
        try:
            tick = u32()
            rows = np.frombuffer(b(u32() * ROW.itemsize), dtype=ROW)
            batches = []
            for _ in range(u32()):
                sid = u32(); k = u32(); b(4 * k); m = u32(); b(12 * m)
                promos = []
                for _ in range(u32()):
                    s2, isl = struct.unpack('<II', b(8)); c = u32()
                    chunks = struct.unpack('<%dI' % c, b(4 * c))
                    vals = struct.unpack('<23f', b(4 * 23))
                    promos.append((s2, isl, chunks, vals))
                q = u32(); retired = struct.unpack('<%dI' % q, b(4 * q))
                batches.append((sid, promos, retired))
            settles = [struct.unpack('<II3f4f', b(36)) for _ in range(u32())]
            b(8 * u32())
        except EOFError:
            return
        yield tick, rows, batches, settles


def ent(sid, isl):
    return 0x80000000 | (sid << 20) | isl


def rotate(q, v):
    x, y, z, w = q
    u = np.array([x, y, z]); v = np.asarray(v, dtype=float)
    return v + 2.0 * np.cross(u, np.cross(u, v) + w * v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tape'); ap.add_argument('manifest')
    ap.add_argument('--tick', type=int, required=True)
    ap.add_argument('--at', type=float, nargs=2, required=True, metavar=('X', 'Z'))
    ap.add_argument('--radius', type=float, default=6.0)
    ap.add_argument('--margin', type=float, default=3.0, help='extra radius for static remnant chunks')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    manifest = json.load(open(a.manifest))
    structures = {s['structureId']: s for s in manifest['structures']}

    members = {}   # entity -> chunk ids
    owner = {}     # chunk id -> entity (absent: still in the anchored remnant)
    pose = {}      # entity -> (p, q)
    source = None
    proc = subprocess.Popen(['zstd', '-dcq', a.tape], stdout=subprocess.PIPE, bufsize=1 << 24)
    last = None
    for tick, rows, batches, settles in ticks(proc.stdout):
        if tick > a.tick:
            break
        last = tick
        for sid, promos, retired in batches:
            for s2, isl, chunks, vals in promos:
                e = ent(s2, isl)
                for c in members.get(e, ()):
                    if owner.get(c) == e:
                        del owner[c]
                members[e] = chunks
                for c in chunks:
                    owner[c] = e
                pose[e] = (vals[7:10], vals[10:14])
            for isl in retired:
                e = ent(sid, isl)
                for c in members.pop(e, ()):
                    if owner.get(c) == e:
                        del owner[c]
                pose.pop(e, None)
        for r in rows:
            e = int(r['id'])
            if e in members:
                pose[e] = (tuple(r['p']), tuple(r['q']))
        for s in settles:
            e = ent(s[0], s[1])
            if e in members:
                pose[e] = (s[2:5], s[5:9])
    proc.kill()
    if last is None:
        raise SystemExit('no ticks')

    def chunk(c):
        return structures[c >> 16]['chunks'][c & 0xFFFF]

    cx, cz = a.at
    lines = []
    bodies = []
    for e, chunks in members.items():
        if e not in pose or not chunks:
            continue
        p, q = pose[e]
        if math.hypot(p[0] - cx, p[2] - cz) > a.radius:
            continue
        rest = [chunk(c) for c in chunks]
        if any(c.get('support') for c in rest):
            continue  # an anchored island: not a free body
        mass = sum(c['mass'] for c in rest)
        if mass <= 0:
            continue
        com = np.sum([np.array(c['centroid']) * c['mass'] for c in rest], axis=0) / mass
        bodies.append((math.hypot(p[0] - cx, p[2] - cz), e, p, q, rest, com))
    if not bodies:
        raise SystemExit('no free bodies in that circle')
    bodies.sort(key=lambda x: x[0])
    keeper = bodies[0][1]
    lines.append(f'# rubble neighbourhood around ({cx:.1f}, {cz:.1f}) r {a.radius} m at tick {last}, '
                 f'cut from {a.tape} by scripts/perf/rubble-sleep/cut_fixture.py')
    lines.append(f'keeper {keeper:#010x}')
    for _, e, p, q, rest, com in bodies:
        lines.append(f'body {e:#010x} {p[0]:.6f} {p[1]:.6f} {p[2]:.6f} {q[0]:.7f} {q[1]:.7f} {q[2]:.7f} {q[3]:.7f}')
        for c in rest:
            l = np.array(c['centroid']) - com
            h = c['geometry']['halfExtents']
            lines.append(f'chunk {l[0]:.6f} {l[1]:.6f} {l[2]:.6f} {h[0]:.5f} {h[1]:.5f} {h[2]:.5f} '
                         f'{c["mass"]:.3f} {c["volume"]:.6f}')
    statics = 0
    for sid, s in structures.items():
        sp, sq = s['worldPosition'], s['worldRotation']
        for node, c in enumerate(s['chunks']):
            if (sid << 16 | node) in owner or c.get('geometry', {}).get('kind') != 'cuboid':
                continue
            w = np.array(sp) + rotate(sq, c['centroid'])
            if math.hypot(w[0] - cx, w[2] - cz) > a.radius + a.margin:
                continue
            h = c['geometry']['halfExtents']
            lines.append(f'static {w[0]:.6f} {w[1]:.6f} {w[2]:.6f} {sq[0]:.7f} {sq[1]:.7f} {sq[2]:.7f} {sq[3]:.7f} '
                         f'{h[0]:.5f} {h[1]:.5f} {h[2]:.5f}')
            statics += 1
    text = '\n'.join(lines) + '\n'
    if a.out:
        open(a.out, 'w').write(text)
    else:
        sys.stdout.write(text)
    print(f'{len(bodies)} bodies, {statics} static remnant chunks, keeper {keeper:#010x}, tick {last}',
          file=sys.stderr)


if __name__ == '__main__':
    main()
