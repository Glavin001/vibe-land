"""Equalize awake/replay populations across the six complete paired trials."""
import csv
import gzip
import json
from pathlib import Path
import statistics
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
summary = json.loads((root / 'summary.json').read_text())
assert summary['complete'] and len(summary['runs']) == 6
runs = summary['runs']
common = sorted(set.intersection(*[
    {key for key, value in run['strata'].items() if value['n'] >= 20}
    for run in runs
]))
assert common, 'No common awake/replay stratum has sufficient samples'
weights = {
    key: statistics.mean(
        run['strata'][key]['n'] / sum(run['strata'][k]['n'] for k in common)
        for run in runs
    ) for key in common
}
result = {'minimum_samples_per_run_per_stratum': 20, 'weights': weights, 'runs': []}
for run in runs:
    means = {key: sum(weights[k] * run['strata'][k]['mean'][key] for k in common)
             for key in run['mean']}
    path = root / f"{run['trial']}-{run['mode']}" / 'demolition.csv'
    observations = []
    with (path.open() if path.exists() else gzip.open(path.with_suffix('.csv.gz'), 'rt')) as stream:
        for row in csv.DictReader(stream):
            tick, awake = int(row['tick']), int(row['awake'])
            if tick < 600 or not 3000 <= awake <= 6000:
                continue
            low = min(5500, (awake // 500) * 500)
            key = f"{low}-{low+500}/split={float(row['resim_passes']) > 0}"
            if key in weights:
                observations.append((float(row['sim']), weights[key] / run['strata'][key]['n']))
    cumulative = 0.0
    p99 = None
    for value, weight in sorted(observations):
        cumulative += weight
        if cumulative >= .99:
            p99 = value
            break
    assert p99 is not None
    result['runs'].append({'trial': run['trial'], 'mode': run['mode'],
                          'mean': means, 'simulation_p99_ms': p99})
summary['standardization'] = result
(root / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(result, indent=2))
