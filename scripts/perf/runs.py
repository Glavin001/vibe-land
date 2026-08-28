"""Load fingerprinted run directories (bench-results/runs/<stamp>-<label>-<git>/).

The run dir is the unit of measurement in this project: self-contained,
uniquely named, carrying its own env/build fingerprint. Tools pass run dirs
(or labels resolved via `latest`), never hand-copied numbers.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

RUNS_ROOT = os.path.join("bench-results", "runs")

#: Env keys that change the SIMULATION, not just measurement detail. Two runs
#: differing on any of these are different physics and must not be cost-compared.
#: VIBE_PHYSX_ was missing here, so every VIBE_PHYSX_* knob — including real
#: ones like the GPU buffer capacities — slipped past the equivalence check.
#: The contact-path A/Bs passed the guard by accident rather than by design.
PHYSICS_ENV_PREFIXES = ("VIBE_CITY_", "VIBE_WORLD_", "BLAST_", "VIBE_PHYSX_")
#: Measurement-only knobs excluded from the physics-equivalence check.
MEASUREMENT_ONLY_KEYS = {
    "VIBE_PHYSX_PROFILE_FETCH",
    "VIBE_PHYSX_PROFILE_CALLBACK",
    "VIBE_PHYSX_GPU_SAMPLE_TICKS",
    "BLAST_VALIDATE_INTERVAL",
    "BLAST_SINGLE_NODE_CENSUS_INTERVAL",
    "VIBE_CITY_POSE_CENSUS",
    "VIBE_CITY_POSE_CENSUS_DUMP",
}
#: Switches that select between implementations of the SAME behaviour.
#:
#: Distinct from measurement-only knobs: these do change what code runs, so
#: they must be excluded from the env check for their own A/B to be possible
#: at all — while every other guard (bond band, regime overlap, cuda_stress)
#: still applies, which is what actually tests the identity claim. Adding a
#: key here is asserting "these two paths produce the same simulation"; the
#: bond band is what calls the bluff.
IMPLEMENTATION_AB_KEYS = {
    "VIBE_PHYSX_CONTACT_CSE",
    "VIBE_PHYSX_CONTACT_FASTPATH",
    "VIBE_PHYSX_CONTACT_PERSISTS",
    "BLAST_CONTACTED_ACTOR_HOIST",
    "BLAST_SKIP_BONDLESS_CONTACTS",
    "BLAST_GPU_GATHER",
    "BLAST_FRACTURE_NODE_SKIP",
    "BLAST_APPLY_INDEX_INCREMENTAL",
    "BLAST_FRACTURE_REUSE_BUFFERS",
    "BLAST_INCREMENTAL_LOOKUP",
}


@dataclass
class Run:
    path: str
    meta: dict
    rows: list[dict] = field(default_factory=list)

    @property
    def label(self) -> str:
        return os.path.basename(self.path)

    def physics_env(self) -> dict[str, str]:
        env = (self.meta.get("fingerprint") or {}).get("env") or {}
        return {
            key: value
            for key, value in env.items()
            if key.startswith(PHYSICS_ENV_PREFIXES)
            and key not in MEASUREMENT_ONLY_KEYS
            and key not in IMPLEMENTATION_AB_KEYS
        }

    def final(self, key: str, default=0):
        return self.rows[-1].get(key, default) if self.rows else default

    def cuda_stress(self) -> bool | None:
        """Did this run's binary carry the CUDA stress solver?

        None for runs recorded before the field existed. False means the CPU
        CG solver produced these numbers, whose residual reads as real stress
        and destroys a city at rest — no such run is comparable to anything.
        """
        fingerprint = self.meta.get("fingerprint") or {}
        return fingerprint.get("cuda_stress")


def load(path: str) -> Run:
    meta_path = os.path.join(path, "meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    rows = []
    timings = os.path.join(path, "timings.jsonl")
    if os.path.exists(timings):
        with open(timings) as handle:
            # A run killed mid-write leaves a truncated final line. Skipping
            # it beats refusing the whole run: the alternative is losing an
            # entire arm to one partial record.
            for line in handle:
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return Run(path=path, meta=meta, rows=rows)


def latest(label: str, count: int = 1, root: str = RUNS_ROOT) -> list[str]:
    """Newest run dirs whose name contains -<label>- (or endswith for git part)."""
    if not os.path.isdir(root):
        return []
    matches = sorted(
        (
            entry
            for entry in os.listdir(root)
            if f"-{label}-" in entry or entry.endswith(f"-{label}")
        ),
        reverse=True,
    )
    return [os.path.join(root, entry) for entry in matches[:count]]
