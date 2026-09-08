#!/usr/bin/env python3
"""Validate and archive completed embedded game-consumer screens, then report peaks."""
import argparse
import gzip
import json
import math
from pathlib import Path

PHASES = [
    ('commands_and_pre_step_ms', '📥 Commands / preparation', 'CPU → PhysX'),
    ('native_physics_and_destruction_ms', '⚙️ Native physics + destruction + correction', 'CPU tasks + CUDA'),
    ('game_observation_events_ms', '📤 Accepted events / game snapshots', 'CPU + GPU observations'),
    ('accepted_status_and_snapshots_ms', '👁️ Staged status / snapshot access', 'CPU'),
]


def generate(capture, output):
    cases = []
    for path in sorted(capture.glob('*/report.json')):
        report = json.loads(path.read_text())
        if report.get('backend') != 'physx_embedded_cuda':
            continue
        assert report['status'] == 'complete', f'incomplete: {path}'
        assert not report.get('instrumented', False), 'instrumented replay cannot enter untraced performance report'
        rows = json.loads((path.parent / 'steps.json').read_text())
        assert len(rows) == report['steps']
        for tick, row in enumerate(rows):
            assert row['tick'] == tick
            total = row['complete_step_ms']
            assert math.isfinite(total) and total >= 0
            parts = [row[field] for field, _, _ in PHASES]
            assert all(math.isfinite(v) and v >= 0 for v in parts)
            assert math.isclose(sum(parts), total, rel_tol=1e-10, abs_tol=1e-8)
            assert row['native_corrections'] <= 1
            assert row['native_counts']['native_stress_passes'] == 1 + row['native_corrections']
        peak = max(rows, key=lambda r: r['complete_step_ms'])
        assert peak == report['peak_step']
        assert report['gate_8ms_misses'] == sum(r['complete_step_ms'] > 8 for r in rows)
        assert report['gate_60hz_misses'] == sum(r['complete_step_ms'] > 1000/60 for r in rows)
        fracture = [row for i, row in enumerate(rows)
                    if row['broken_bonds'] > (rows[i-1]['broken_bonds'] if i else 0)]
        cases.append((report, rows, max(fracture, key=lambda r: r['complete_step_ms']) if fracture else None, path))
    assert cases, 'no completed benchmark reports'
    cases.sort(key=lambda c: c[0]['buildings'])
    output.mkdir(parents=True, exist_ok=False)
    durations = ', '.join(f"{steps} steps / {seconds:g} simulated seconds" for steps, seconds in sorted({(r['steps'], r['seconds']) for r, _, _, _ in cases}))
    waves = ', '.join(str(n) for n in sorted({r['waves'] for r, _, _, _ in cases}))
    text = ['# Embedded Vibe-land destruction: scale screen', '',
        f'One run per size; durations: **{durations}**, fixed timestep 1/60 s. '
        f'Wave counts per run: **{waves}**. Simultaneous waves start at tick 30, then every 150 ticks; each building gets '
        'one 18,000 kg, radius 0.5 m round at 40 m/s per wave. The normal game sphere damping applies. '
        'Direct GPU API **off**, native sleep **on**, correction limit **one**, stress passes **at most two**.', '',
        'The timer begins before projectile insertion and ends with accepted game events/status/snapshots ready. '
        'It includes first-step native setup and runtime allocations. Asset/world creation is reported separately. '
        'Rendering, network encoding, test audits and report generation are excluded. These are short isolated '
        'simulation/integration screens, **not** whole-game or endurance qualification.', '',
        '| Buildings | Chunks | Bonds | Rounds | Mean ms | Peak ms | Peak on a fracture tick, ms | >16.67 ms steps |',
        '|---:|---:|---:|---:|---:|---:|---:|---:|']
    for report, rows, fracture, path in cases:
        name = path.parent.name
        (output / f'{name}.json.gz').write_bytes(gzip.compress(json.dumps(
            {'report': report, 'steps': rows}, separators=(',', ':')).encode(), mtime=0))
        (output / f'{name}-commands.json').write_bytes((path.parent / 'commands.json').read_bytes())
        mean = report['phases_ms']['complete_step_ms']['mean']
        peak = report['peak_step']['complete_step_ms']
        fpeak = f"{fracture['complete_step_ms']:.3f}" if fracture else '—'
        text.append(f"| {report['buildings']} | {report['chunks']:,} | {report['bonds']:,} | "
                    f"{report['projectiles']} | {mean:.3f} | {peak:.3f} | {fpeak} | {report['gate_60hz_misses']} / {report['steps']} |")
    for report, rows, fracture, path in cases:
        peak = report['peak_step']
        text += ['', f"## {report['buildings']} buildings: the actual worst step", '',
            f"Tick **{peak['tick']}**: **{peak['complete_step_ms']:.3f} ms**, "
            f"{peak['projectiles']} projectiles present, {peak['fragment_bodies']:,} fragment bodies "
            f"({peak['awake_fragment_bodies']:,} awake), {int(peak['native_counts']['native_clusters']):,} "
            f"total destruction clusters, {peak['normal_contacts']:,} native normal-contact count, "
            f"{peak['broken_bonds']:,} cumulative broken bonds, {peak['native_corrections']} correction(s).", '',
            '| Operation | Owner | Time on this peak, ms | Share |', '|---|---|---:|---:|']
        for field, label, owner in PHASES:
            value = peak[field]
            text.append(f"| {label} | {owner} | {value:.6f} | {100*value/peak['complete_step_ms']:.2f}% |")
        text += ['', f"Initialization: **{report['initialization_ms']:.1f} ms** separately. "
            f"Final unique broken bonds: **{report['unique_broken_bonds']:,}**. "
            f"Misses over 8 ms: **{report['gate_8ms_misses']} / {report['steps']}**.", '',
            f"[All samples and summary]({path.parent.name}.json.gz) · "
            f"[Recorded command tape]({path.parent.name}-commands.json)"]
    text += ['', '## Interpretation and limits', '',
        '- ❌ These results do not pass the 8 ms or every-step 60 Hz target.',
        '- 🔎 Native advance includes both CPU tasks and GPU execution/waits. This coarse boundary does '
        'not establish a compute, bandwidth or synchronization bottleneck inside it.',
        '- 📤 Game observation cost includes accepted topology/event processing. Eliminating it entirely '
        'would still leave the large native peak far above the deadline.',
        '- 🛡️ All measured rows are retained. The per-peak tables are disjoint and sum to that peak; '
        'independent phase maxima are not added together.',
        '- ⚖️ The 17.96 m city spacing, game sphere damping and input tape differ from standalone native '
        'and historical external-adapter captures. No matched speedup or superiority is claimed.',
        '- ✅ Each run checks pre-impact stability, finite observed positions, unique committed bond events, '
        'event/state count agreement, correction/stress-pass limits and final shape ownership. '
        'These checks do not establish projectile clearance, full physical parity or endurance.', '']
    (output / 'report.md').write_text('\n'.join(text))
    print(output / 'report.md')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    generate(args.capture, args.output)
