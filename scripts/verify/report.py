#!/usr/bin/env python3
"""One table from a correctness run: scripts/verify/report.py OUTDIR

Formatting only (no physics): reads OUTDIR/textbook-*.jsonl, regressions.jsonl
and acceptance-*/acceptance.jsonl written by scripts/verify/correctness.sh and
prints Markdown: per textbook check, the textbook value and per engine
configuration the simulated value, its error and its status.
"""
import glob
import json
import os
import sys

out = sys.argv[1]
ORDER = ['runtime', 'section-bending', 'high-fidelity', 'high-fidelity+impact', 'high-fidelity(no-rotation)', 'runtime+impact']


def load(pattern):
    rows = []
    for f in sorted(glob.glob(os.path.join(out, pattern))):
        rows += [json.loads(line) for line in open(f) if line.strip()]
    return rows


def num(x, unit):
    if x is None:
        return '-'
    if unit == '1=yes':
        return 'yes' if x >= 0.5 else 'no'
    return f'{x:.4g}'


rows = load('textbook-*.jsonl')
configs = sorted({r['config'] for r in rows}, key=lambda c: ORDER.index(c) if c in ORDER else 99)
print(f'# Correctness report ({os.path.basename(out)})\n')
if rows:
    print('## Textbook verification\n')
    print('Error is |simulated - textbook| / |textbook| (or / the case\'s reference magnitude where the textbook value is 0). '
          'Tolerance 1%. KNOWN-GAP: listed in physx-bridge/tests/textbook/expected.tsv with its measured error.\n')
    header = '| case | check | unit | textbook | ' + ' | '.join(f'{c}' for c in configs) + ' |'
    print(header)
    print('|' + '---|' * (4 + len(configs)))
    keys = []
    for r in rows:
        k = (r['case'], r['check'])
        if k not in keys:
            keys.append(k)
    by = {(r['case'], r['check'], r['config']): r for r in rows}
    for case, check in keys:
        first = next(r for r in rows if (r['case'], r['check']) == (case, check))
        cells = []
        for c in configs:
            r = by.get((case, check, c))
            if not r:
                cells.append('')
                continue
            err = '-' if r.get('error') is None else f"{100 * r['error']:.2f}%"
            cells.append(f"{num(r.get('stage'), r.get('unit'))} ({err}) **{r['status']}**")
        print(f"| {case} | {check} | {first.get('unit', '')} | {num(first.get('textbook'), first.get('unit'))} | " + ' | '.join(cells) + ' |')
    print()
    for c in configs:
        rs = [r for r in rows if r['config'] == c]
        n = {s: sum(1 for r in rs if r['status'] == s) for s in ('PASS', 'KNOWN-GAP', 'FIXED', 'FAIL', 'GAP-WORSE')}
        print(f"- **{c}**: {len(rs)} checks, {n['PASS']} pass, {n['KNOWN-GAP']} known gaps, {n['FIXED']} fixed, {n['FAIL'] + n['GAP-WORSE']} failing")
    print()

regs = load('regressions.jsonl')
if regs:
    print('## Regression tests\n')
    print('| test | fix | status | seconds |')
    print('|---|---|---|---|')
    for r in regs:
        print(f"| {r['id']} | {r['what']} | **{r['status']}** | {r['seconds']} |")
    print()

acc = load('acceptance-*/acceptance.jsonl')
if acc:
    print('## Acceptance scenarios\n')
    profiles = sorted({r['profile'] for r in acc})
    print('| scenario | check | threshold | ' + ' | '.join(profiles) + ' |')
    print('|' + '---|' * (3 + len(profiles)))
    keys = []
    for r in acc:
        k = (r['scenario'], r['check'])
        if k not in keys:
            keys.append(k)
    by = {(r['scenario'], r['check'], r['profile']): r for r in acc}
    for sc, check in keys:
        first = next(r for r in acc if (r['scenario'], r['check']) == (sc, check))
        cells = [f"{by[(sc, check, p)]['measured']} **{by[(sc, check, p)]['status']}**" if (sc, check, p) in by else '' for p in profiles]
        print(f"| {sc} | {check} | {first['threshold']} | " + ' | '.join(cells) + ' |')
    print()

fm = load('flag-matrix/flag-matrix.jsonl')
if fm:
    print('## Flag-interaction matrix at rest\n')
    print('Bonds broken at rest (from tick 0) per structure, each arm in its own run. Any broken bond is a failure.\n')
    arms = []
    for r in fm:
        if r['arm'] not in arms:
            arms.append(r['arm'])
    structs = []
    for r in fm:
        if r['structure'] not in structs:
            structs.append(r['structure'])
    by = {(r['arm'], r['structure']): r for r in fm}
    print('| arm | ' + ' | '.join(structs) + ' |')
    print('|' + '---|' * (1 + len(structs)))
    for a in arms:
        cells = []
        for st in structs:
            r = by.get((a, st))
            cells.append('' if not r else (r['verdict'] if r['broken_pct'] is None else f"{r['broken_pct']:.2f}%"))
        print(f'| {a} | ' + ' | '.join(cells) + ' |')
    print()
