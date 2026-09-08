#!/usr/bin/env python3
"""Read submitted client/server reports without conflating their timing scopes."""
import argparse, hashlib, json, statistics
from pathlib import Path


def summarize(folder):
    server = json.loads((folder / 'server.json').read_text())
    client = json.loads((folder / 'client.json').read_text())
    spans, city = server['spans'], server['city']
    native = lambda key: spans['destruction/native_' + key]['v']
    assert native('embedded') == 1, 'requires native embedded report'
    assert int(native('chunks')) == client['snapshot']['city']['chunksTotal']
    ring = server['tick_ring']
    assert len({row['t'] for row in ring}) == len(ring)
    quiet = [row for row in ring if row['awake'] == 0]
    return dict(folder=str(folder.resolve()),
        hashes={name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
                for name in ['client.json', 'server.json']},
        chunks=int(native('chunks')), bonds=int(native('bonds')),
        projectiles=server['dynamic_body_count'], broken_bonds=city['broken_bonds'],
        fragment_bodies=city['chunk_bodies'], awake_fragments=city['awake_bodies'],
        active_physics_bodies=server['physics_active_dynamic_bodies'],
        stress_iterations=int(native('stress_iterations')),
        correction_passes=int(native('correction_passes')),
        server_tick_rolling_ms=server['timings']['total_ms'],
        physics_step_ms=server['physics_last_step_ms'],
        client_gpu_ms=client['frameProfile']['gpuFrameMs'],
        client_cpu_frame_ms=client['frameProfile']['cpuFrameMs'],
        client_frame_ms=client['frameProfile']['frameTotalMs'],
        ring_samples=len(ring), zero_awake_fragment_samples=len(quiet),
        zero_awake_fragment_tick_ms=None if not quiet else dict(
            min=min(r['total'] for r in quiet), median=statistics.median(r['total'] for r in quiet),
            max=max(r['total'] for r in quiet)),
        ring=ring)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args=parser.parse_args()
    rows=[summarize(path) for path in args.reports]
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output/'summary.json').write_text(json.dumps(rows,indent=2)+'\n')
    lines=['# Submitted embedded-city reports', '',
        'These are live user-session observations, not isolated benchmark runs. '
        'Each report preserves a rolling server tick history plus a later client snapshot. '
        'Server/client snapshots and smoothed GPU-wait counters are not aligned enough to sum into a phase breakdown.', '',
        '| Report | Chunks / bonds | Ordinary dynamic bodies | Fragments / awake | Broken bonds | Server rolling avg / peak ms | Client GPU ms |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        t=r['server_tick_rolling_ms']
        lines.append(f"| {Path(r['folder']).name} | {r['chunks']:,} / {r['bonds']:,} | {r['projectiles']} | {r['fragment_bodies']} / {r['awake_fragments']} | {r['broken_bonds']} | {t['avg']:.3f} / {t['max']:.3f} | {r['client_gpu_ms']:.3f} |")
    lines+=['','## What the evidence establishes','',
        '- Client GPU rendering is much cheaper than the server simulation. Moving fewer render instances is not the principal fix for these reports.',
        '- Both reports were submitted after firing. Their zero-awake-fragment rows do not prove that ordinary bodies were asleep, or that the entire world was intact.',
        '- Total chunks must come from native telemetry/client manifest. The historical top-level `chunk_count` field is zero here and is not the destruction size.',
        '- The physics fetch interval includes native stress and other required GPU/CPU work. A smoothed `physics_gpu_wait_ms` value must not be subtracted from a different current-step value.', '',
        '## Zero-awake-fragment observations','']
    for r in rows:
        q=r['zero_awake_fragment_tick_ms']
        if q:
            lines.append(f"- {Path(r['folder']).name}: {r['zero_awake_fragment_samples']} of {r['ring_samples']} recorded ticks have zero awake fragments; total tick min / median / max = {q['min']:.3f} / {q['median']:.3f} / {q['max']:.3f} ms.")
    lines+=['', 'Overlapping tick histories are reported separately, not counted as independent repeats.', '',
        '## Source-confirmed work to remove', '',
        '1. `StressResidentAPI.inl::solveDeviceAsync` rejects the old settled-island skipping flags. Native warm starts reuse a guess, then re-run the solve. Sleeping rigid bodies do not currently certify that a structural solve can be reused.',
        '2. Components above 1,024 nodes use the cooperative multilevel path. Downtown includes several such components; the 444-chunk building benchmark does not.',
        '3. The deployed cooperative loop enters its preconditioner after all components have converged. A candidate now exits at that already-verified boundary and preserves final status/scratch writes. It is not deployed or timed yet.',
        '4. Exact unchanged-input reuse still needs an operator/load/convergence certificate, with support, contact, topology and damage invalidation. This must preserve the material evaluation and never reuse an unconverged output.', '',
        'These findings identify unnecessary work; the submitted reports do not quantify each item\'s milliseconds. Attribute that with a separate internal phase capture before claiming a speedup.', '',
        'Raw report paths and content hashes, timing scopes and retained ring rows are in [summary.json](summary.json).', '']
    (args.output/'report.md').write_text('\n'.join(lines))
    print(args.output/'report.md')

if __name__=='__main__':
    main()
