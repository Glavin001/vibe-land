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
PHYSICS_ENV_PREFIXES = ("VIBE_CITY_", "VIBE_WORLD_", "BLAST_")
#: Measurement-only knobs excluded from the physics-equivalence check.
MEASUREMENT_ONLY_KEYS = {
    "VIBE_PHYSX_PROFILE_FETCH",
    "VIBE_CITY_POSE_CENSUS",
    "VIBE_CITY_POSE_CENSUS_DUMP",
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
            if key.startswith(PHYSICS_ENV_PREFIXES) and key not in MEASUREMENT_ONLY_KEYS
        }

    def final(self, key: str, default=0):
        return self.rows[-1].get(key, default) if self.rows else default


def load(path: str) -> Run:
    meta_path = os.path.join(path, "meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    rows = []
    timings = os.path.join(path, "timings.jsonl")
    if os.path.exists(timings):
        with open(timings) as handle:
            rows = [json.loads(line) for line in handle if line.strip()]
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
