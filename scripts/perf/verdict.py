"""Equivalence-guarded A/B verdicts over run dirs.

Born from a confounded measurement: an arm that disabled contact reports
"saved ~6 ms" — but it also removed stress injection, broke 21% fewer bonds,
and was therefore simulating a different, smaller city. Bucket-matching
cannot rescue arms whose physics diverged, so this module REFUSES the cost
comparison unless the arms are equivalent, and attributes any allowed delta
per phase so "where" comes with "how much".
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass

from . import runs as runs_mod

#: GPU damage is not bit-reproducible; identical configs measured up to ~15%
#: bond swing run-to-run, and the suite's own T3 notes worse on shape metrics.
BOND_BAND_LIMIT = 0.25
#: Minimum per-bucket samples in BOTH arms before the bucket contributes.
MIN_BUCKET_N = 20
#: Bucket edges: joint (awake, frozen) in 500-body steps.
BUCKET = 500

#: Phases attributed in the delta breakdown when present in rows.
PHASE_KEYS = ("physx", "stress", "solve", "support", "settle", "topo", "enc", "stats")


@dataclass
class Verdict:
    comparable: bool
    reasons: list[str]
    weighted_delta_ms: float | None
    per_bucket: list[tuple]
    phase_deltas: dict[str, float]
    caveats: list[str]

    def render(self) -> str:
        lines = []
        if not self.comparable:
            lines.append("ARMS NOT COMPARABLE — no perf verdict:")
            lines.extend(f"  - {reason}" for reason in self.reasons)
            return "\n".join(lines)
        lines.append(
            f"{'awake':>7} {'frozen':>7} {'n_a':>5} {'n_b':>5} "
            f"{'a_med':>8} {'b_med':>8} {'delta':>7}"
        )
        for awake, frozen, n_a, n_b, med_a, med_b in self.per_bucket:
            lines.append(
                f"{awake:>7} {frozen:>7} {n_a:>5} {n_b:>5} "
                f"{med_a:>8.2f} {med_b:>8.2f} {med_a - med_b:>7.2f}"
            )
        lines.append(f"weighted mean delta (A - B): {self.weighted_delta_ms:+.2f} ms")
        if self.phase_deltas:
            attributed = ", ".join(
                f"{key} {value:+.2f}"
                for key, value in sorted(
                    self.phase_deltas.items(), key=lambda item: -abs(item[1])
                )
                if abs(value) >= 0.05
            )
            lines.append(f"phase attribution (bucket-weighted): {attributed or 'all < 0.05 ms'}")
        for caveat in self.caveats:
            lines.append(f"CAVEAT: {caveat}")
        return "\n".join(lines)


def _buckets(rows: list[dict], key: str) -> dict[tuple[int, int], list[float]]:
    out: dict[tuple[int, int], list[float]] = {}
    for row in rows:
        bucket = (row.get("awake", 0) // BUCKET, row.get("frozen", 0) // BUCKET)
        out.setdefault(bucket, []).append(float(row.get(key, 0.0)))
    return out


def compare(arm_a: list[runs_mod.Run], arm_b: list[runs_mod.Run], key: str = "sim") -> Verdict:
    """Compare pooled runs of arm A against arm B on per-tick `key`."""
    reasons: list[str] = []
    caveats: list[str] = []

    # 1. Fingerprint guard: measurement-only knobs may differ; physics may not
    #    (beyond the single knob an experiment intentionally varies, which
    #    should be measurement-gated via an env DEFAULTING to off — if you are
    #    varying a physics knob, you are not measuring cost, you are changing
    #    the game).
    env_a = arm_a[0].physics_env() if arm_a else {}
    for run in arm_a[1:]:
        if run.physics_env() != env_a:
            reasons.append(f"arm A runs disagree on physics env ({run.label})")
    env_b = arm_b[0].physics_env() if arm_b else {}
    for run in arm_b[1:]:
        if run.physics_env() != env_b:
            reasons.append(f"arm B runs disagree on physics env ({run.label})")
    diff_keys = {
        key_
        for key_ in set(env_a) | set(env_b)
        if env_a.get(key_) != env_b.get(key_)
    }
    if diff_keys:
        reasons.append(
            "arms differ on physics env keys: " + ", ".join(sorted(diff_keys))
        )

    # 1b. Solver guard: a run whose binary lacked `cuda-stress` measured the
    #     CPU CG solve, whose residual reads as real stress — its city
    #     destroys itself at rest (~30,000 bonds in 90 s vs 0). Such a run is
    #     not a slower version of the same physics; it is different physics.
    for arm_name, arm in (("A", arm_a), ("B", arm_b)):
        for run in arm:
            if run.cuda_stress() is False:
                reasons.append(
                    f"arm {arm_name} run {run.label} was built WITHOUT cuda-stress "
                    "(CPU stress solver) — its physics is not the shipped physics"
                )

    # 2. Same-city guard: final broken-bond totals inside the noise band.
    bonds_a = [run.final("bonds") for run in arm_a]
    bonds_b = [run.final("bonds") for run in arm_b]
    if bonds_a and bonds_b:
        mean_a = statistics.mean(bonds_a)
        mean_b = statistics.mean(bonds_b)
        band = abs(mean_a - mean_b) / max(mean_a, mean_b, 1.0)
        if band > BOND_BAND_LIMIT:
            reasons.append(
                f"bond totals diverge {band:.0%} (A {mean_a:.0f} vs B {mean_b:.0f}, "
                f"limit {BOND_BAND_LIMIT:.0%}) — the arms simulated different cities"
            )

    if reasons:
        return Verdict(False, reasons, None, [], {}, caveats)

    if len(arm_a) < 2 or len(arm_b) < 2:
        caveats.append(
            "single-run arm(s): GPU damage swings run-to-run; treat the delta "
            "as provisional until n>=2 per arm"
        )

    rows_a = [row for run in arm_a for row in run.rows]
    rows_b = [row for run in arm_b for row in run.rows]
    buckets_a = _buckets(rows_a, key)
    buckets_b = _buckets(rows_b, key)
    common = [
        bucket
        for bucket in sorted(set(buckets_a) & set(buckets_b))
        if len(buckets_a[bucket]) >= MIN_BUCKET_N and len(buckets_b[bucket]) >= MIN_BUCKET_N
    ]
    if not common:
        return Verdict(
            False,
            ["no joint (awake, frozen) bucket has enough samples in both arms"],
            None,
            [],
            {},
            caveats,
        )
    # Population-overlap guard: comparable arms should spend their ticks in
    # broadly the same regimes.
    covered_a = sum(len(buckets_a[bucket]) for bucket in common) / max(len(rows_a), 1)
    covered_b = sum(len(buckets_b[bucket]) for bucket in common) / max(len(rows_b), 1)
    if min(covered_a, covered_b) < 0.5:
        return Verdict(
            False,
            [
                f"shared buckets cover only {covered_a:.0%} of A / {covered_b:.0%} of B "
                "ticks — the arms lived in different regimes"
            ],
            None,
            [],
            {},
            caveats,
        )

    per_bucket = []
    weighted = 0.0
    weight_sum = 0
    for bucket in common:
        med_a = statistics.median(buckets_a[bucket])
        med_b = statistics.median(buckets_b[bucket])
        n = min(len(buckets_a[bucket]), len(buckets_b[bucket]))
        weighted += (med_a - med_b) * n
        weight_sum += n
        per_bucket.append(
            (bucket[0] * BUCKET, bucket[1] * BUCKET, len(buckets_a[bucket]), len(buckets_b[bucket]), med_a, med_b)
        )

    phase_deltas: dict[str, float] = {}
    for phase in PHASE_KEYS:
        if not any(phase in row for row in rows_a[:5]):
            continue
        pa = _buckets(rows_a, phase)
        pb = _buckets(rows_b, phase)
        acc = 0.0
        for bucket in common:
            if bucket in pa and bucket in pb:
                acc += (statistics.median(pa[bucket]) - statistics.median(pb[bucket])) * min(
                    len(pa[bucket]), len(pb[bucket])
                )
        phase_deltas[phase] = acc / max(weight_sum, 1)

    return Verdict(True, [], weighted / max(weight_sum, 1), per_bucket, phase_deltas, caveats)
