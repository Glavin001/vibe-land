#!/usr/bin/env python3
"""Summarize actual authored-vehicle bond verdicts without changing qualification.

Use --fixtures with verify-vehicle-builds.mjs output and --report with a completed
cannon.json or cannon-heavy.json (gzip is accepted). This explains which physical
interfaces were loaded and damaged; verify-vehicle-bridge-fracture.py remains the
qualification gate. Missing verdicts stay explicitly unobserved, never zero stress.
"""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path


def read_json(path):
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rt') as stream:
        return json.load(stream)


def inspect_impact(report, asset):
    parts, bonds = asset['parts'], asset['bonds']
    if len(parts) != report['chunks'] or len(bonds) != report['bonds']:
        raise ValueError('Report and asset chunk/bond counts differ')
    target = report['target']
    if not isinstance(target, int) or not 0 <= target < len(parts):
        raise ValueError('Invalid target chunk')
    observations = {}
    ticks = set()
    fields = ('compressionPa', 'tensionPa', 'shearPa', 'utilisation', 'damageArea')
    for frame in report['impactVerdicts']:
        if frame['tick'] in ticks:
            raise ValueError('Repeated verdict tick')
        ticks.add(frame['tick'])
        seen = set()
        for row in frame['bonds']:
            index = row['bond']
            if not isinstance(index, int) or not 0 <= index < len(bonds) or index in seen:
                raise ValueError('Invalid or duplicate bond index')
            seen.add(index)
            bond = bonds[index]
            if {row['part0'], row['part1']} != {bond['a'], bond['b']}:
                raise ValueError('Report bond does not match authored endpoints')
            if not math.isclose(row['area'], bond['area'], rel_tol=1e-6, abs_tol=1e-10):
                raise ValueError('Report bond does not match authored area')
            values = {field: row[field] for field in fields}
            if any(not math.isfinite(v) or v < 0 for v in values.values()):
                raise ValueError('Invalid native verdict value')
            if not isinstance(row['broken'], bool):
                raise ValueError('Invalid broken state')
            entry = observations.setdefault(index, {'samples': 0, 'stressSamples': 0,
                'postBreakSamples': 0, 'peaks': dict.fromkeys(fields, 0.)})
            entry['samples'] += 1
            # Reports sample the accepted solve after correction. A bond cut in
            # the intact trial may already have zeroed stress rows by then. Its
            # fracture event is evidence, but zero is NOT its fracture load.
            if row['broken']:
                entry['postBreakSamples'] += 1
                continue
            entry['stressSamples'] += 1
            for field, value in values.items():
                entry['peaks'][field] = max(entry['peaks'][field], value)
    broken = set()
    for packed in report['brokenBonds']:
        index = packed & ((1 << 20) - 1)
        if packed >> 20 != 200 or not 0 <= index < len(bonds) or index in broken:
            raise ValueError('Invalid packed broken-bond identity')
        broken.add(index)
    names = {p['id']: p['name'] for p in parts}
    target_id = parts[target]['id']
    interfaces, attachment_counts = [], {}
    for index, bond in enumerate(bonds):
        attachment = bond.get('attachment', 'unspecified')
        counts = attachment_counts.setdefault(attachment, {'total': 0, 'broken': 0, 'observed': 0})
        counts['total'] += 1
        counts['broken'] += index in broken
        counts['observed'] += index in observations
        if target_id not in (bond['a'], bond['b']):
            continue
        strength = bond['strength']
        thresholds = [strength[k] for k in ('compressionElastic', 'tensionElastic', 'shearElastic')]
        entry = observations.get(index)
        ratios = None
        if entry and entry['stressSamples']:
            if any(not math.isfinite(v) or v <= 0 for v in thresholds):
                raise ValueError('Invalid authored elastic strength')
            ratios = [entry['peaks'][k] / limit for k, limit in zip(fields[:3], thresholds)]
        interfaces.append(dict(bond=index, parts=[names[bond['a']], names[bond['b']]],
            attachment=attachment, areaM2=bond['area'], broken=index in broken,
            samples=entry['samples'] if entry else 0,
            stressSamples=entry['stressSamples'] if entry else 0,
            postBreakSamples=entry['postBreakSamples'] if entry else 0,
            peaks=entry['peaks'] if entry and entry['stressSamples'] else None,
            peakToElasticRatio=ratios, elasticPa=thresholds))
    frames = report['frames']
    return dict(model=report['model'], target=parts[target]['name'],
        stressScope='accepted, unbroken snapshots only; initial-trial fracture peaks are unavailable',
        projectileMassKg=report['projectileMassKg'], speedMps=report['speedMps'],
        error=report['error'], recordedTicks=len(frames),
        rejectedTicks=[f['tick'] for f in frames if f['error'] or not f['converged']],
        firstDetachedTick=next((f['tick'] for f in frames if not f['targetAttached']), None),
        brokenBonds=len(broken), verdictTicks=len(ticks), observedBonds=len(observations),
        totalBonds=len(bonds), targetInterfaces=interfaces, attachments=attachment_counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    fixtures = {row['name']: row for row in read_json(args.fixtures)}
    rows = read_json(args.report)
    if len({row['model'] for row in rows}) != len(rows):
        parser.error('duplicate report models')
    result = {'scope': 'diagnostic only; does not change the fracture qualification gate',
        'reportPath': str(args.report.resolve()),
        'reportSha256': hashlib.sha256(args.report.read_bytes()).hexdigest(),
        'models': []}
    for row in rows:
        path = Path(fixtures[row['model']]['metadataPath'])
        result['models'].append({**inspect_impact(row, read_json(path)),
            'metadataPath': str(path.resolve()), 'metadataSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    with args.output.open('x') as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write('\n')


if __name__ == '__main__':
    main()
