#!/usr/bin/env python3
"""The performance suite: one answer to "how good is our performance".

    scripts/perf/suite.sh [--quick] [--reps N] [--profiles runtime,high]
                          [--label NAME] [--compare BASELINE.json] [--save-baseline]
    scripts/perf/suite.sh --report RUN_DIR [--compare BASELINE.json]   (no GPU)
    scripts/perf/suite.sh --capture                                    (once: impact captures)

Scenarios are data (scripts/perf/suite.json). Each scene runs in its own
process (the city reads its pack once), in both engine profiles
(scripts/fidelity/{runtime,high}.env, each on its own SDK and packs). The
test bed's harness is server/src/perf_suite.rs: the production arena, the
city stage and the fleet, stepped as the server steps them, with fixed inputs
at fixed ticks.

High-fidelity impacts cost 5-20 s a tick in the impact solve, so in that
profile the house impacts are timed as replays of captured impact ticks
(PhysX destruction_impact_capture_replay on target/perf-suite/captures/*.impc,
made once by --capture), not live: the suite would otherwise take minutes.

Everything timed runs inside ONE hold of the exclusive GPU lock
(scripts/perf/gpu-run.sh without VIBE_GPU_SHARED), after the builds, with an
untimed warm-up process first. Writes target/perf-suite/runs/<stamp>-<label>/
{report.json, report.txt, logs/, plans/}.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics as st
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "scripts/perf/suite.json"
OUT = ROOT / "target/perf-suite"
# The machine-wide GPU admission lives in the main checkout (gpu-run.sh header).
GPU_RUN = Path(os.environ.get("VIBE_GPU_RUN", "/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh"))
# Machine-wide (every checkout's suite replays the same inputs): the main checkout's.
CAPTURES = Path(os.environ.get("PERF_SUITE_CAPTURES", "/Users/glavin/Development/vibe-land/target/perf-suite/captures"))


def log(*a):
    print("[suite]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- profiles

def profile_env(profile: str) -> dict:
    """The environment scripts/fidelity/<profile>.env makes, checked against its SDK."""
    script = f'source "{ROOT}/scripts/fidelity/{profile}.env" && "{ROOT}/scripts/fidelity/check.sh" >&2 && env -0'
    r = subprocess.run(["bash", "-c", script], capture_output=True, env={k: v for k, v in os.environ.items()
                       if not k.startswith(("VIBE_", "PX_", "BLAST_", "TOWN_KIT"))})
    if r.returncode != 0:
        sys.exit(f"profile {profile}: {r.stderr.decode()[-2000:]}")
    env = dict(kv.split("=", 1) for kv in r.stdout.decode().split("\0") if "=" in kv)
    return env


def packs(profile: str) -> dict:
    out = subprocess.run([str(ROOT / "scripts/fidelity/packs.sh"), profile], capture_output=True, text=True, check=True).stdout
    p = dict(line.split("=", 1) for line in out.split())
    # Calibration scenes: structures/calibration/run.mjs SCENARIO --spec-only writes
    # out/SCENARIO (default) and out/SCENARIO-high (the high variant's pack build).
    p["calib"] = str(ROOT / "structures/calibration/out")
    return p


def scene_pack(profile: str, scene: dict) -> tuple[Path, Path | None]:
    """The pack file a scene runs on in this profile, and its meta (lab, town)."""
    p = packs(profile)
    kind = scene["pack"]
    if kind.startswith("calib:"):
        name = kind.split(":", 1)[1] + ("-high" if profile == "high" else "")
        d = Path(p["calib"]) / name
        if not (d / "scene.json").exists():
            subprocess.run(["node", str(ROOT / "structures/calibration/run.mjs"), kind.split(":", 1)[1], "--spec-only"],
                           check=True, cwd=ROOT, env=profile_env(profile), stdout=subprocess.DEVNULL)
        return d / "scene.json", None
    pack = Path(p[kind])
    if not pack.exists():
        sys.exit(f"missing pack {pack}: scripts/fidelity/build-packs.sh {profile}")
    return pack, pack.with_suffix(".meta.json")


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:16]


def sdk_fingerprint(sdk: Path) -> dict:
    art = sdk / "sdk-artifacts.json"
    if not art.exists():
        return {"sdk": str(sdk), "revision": None}
    d = json.loads(art.read_text())
    libs = hashlib.sha256(json.dumps(d.get("libraries", {}), sort_keys=True).encode()).hexdigest()[:16]
    return {"sdk": str(sdk), "revision": d.get("source_revision"), "dirty": d.get("source_dirty"), "libraries": libs}


# ---------------------------------------------------------------- builds

def build(env: dict) -> Path:
    """The test binary holding perf_suite, built against this profile's SDK."""
    sdk = Path(env["PHYSX_ROOT"])
    target = OUT / f"cargo-{sdk.name}"
    benv = {**os.environ, "PHYSX_ROOT": str(sdk), "CARGO_TARGET_DIR": str(target)}
    r = subprocess.run(["cargo", "test", "--release", "-p", "web-fps-server", "--features", "native-destruction", "--lib",
                        "--no-run", "--message-format=json"], cwd=ROOT, env=benv, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"build against {sdk} failed:\n{r.stderr[-4000:]}")
    for line in r.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("executable") and m.get("target", {}).get("name") == "web_fps_server":
            return Path(m["executable"])
    sys.exit("no test binary in the build output")


def replay_binary(env: dict) -> Path | None:
    """PhysX's destruction_impact_capture_replay from the SDK's own build tree."""
    if os.environ.get("PERF_SUITE_REPLAY_BIN"):
        return Path(os.environ["PERF_SUITE_REPLAY_BIN"])
    sdk = Path(env["PHYSX_ROOT"])
    art = sdk / "sdk-artifacts.json"
    prefix = Path(json.loads(art.read_text()).get("install_prefix", sdk)) if art.exists() else sdk
    candidate = prefix.parent.parent / "build" / prefix.name / "package/topology/destruction_impact_capture_replay"
    return candidate if candidate.exists() else None


# ---------------------------------------------------------------- plans

def shot_from_place(meta: dict, event: dict) -> dict:
    """A shot at a town building's street face: aimed at the face's middle,
    from the street side (its pavement), as the lab's attack `shot` is."""
    place = next(p for p in meta["places"] if p["id"] == event["place"])
    lo, hi, pave = place["min"], place["max"], place["pavement"]
    from_south = pave[2] < lo[2]
    z = lo[2] if from_south else hi[2]
    meteor = event["kind"] == "meteor"
    return {"tick": event["tick"], "kind": event["kind"], "target": [pave[0], event.get("height", 1.5), z],
            "from": 180 if from_south else 0, "slope": 0.3 if meteor else 0.02, "distance": 140 if meteor else 30}


# Frozen packs: the scene packs the baselines were recorded on, kept
# machine-wide so every checkout times the same workload (an engine change is
# measured on the same structures; an authoring change is not mixed in).
PACKS = Path(os.environ.get("PERF_SUITE_PACKS", "/Users/glavin/Development/vibe-land/target/perf-suite/packs"))
SIDE_FILES = (".meta.json", ".slots")


def frozen_pack(profile: str, scene: str) -> Path | None:
    d = PACKS / profile / scene
    found = sorted(p for p in d.glob("*.json") if not p.name.endswith((".meta.json", "charges.json"))) if d.exists() else []
    return found[0] if found else None


def freeze_packs(jobs: list[dict]) -> None:
    import shutil
    for job in jobs:
        pack = Path(job["pack"])
        d = PACKS / job["profile"] / job["scene"]
        if d.exists() and frozen_pack(job["profile"], job["scene"]) == d / pack.name and sha(d / pack.name) == job["pack_sha"]:
            continue
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        for f in [pack, *(pack.with_suffix(x) for x in SIDE_FILES), *([pack.parent / "charges.json"] if "charges" in json.loads(Path(job["plan"]).read_text()) else [])]:
            if f.exists():
                shutil.copy2(f, d / f.name)
        log(f"froze {job['profile']} {job['scene']} pack -> {d}")


def make_jobs(spec: dict, profile: str, tier: str, run_dir: Path, frozen: bool = False) -> list[dict]:
    jobs = []
    for proc in spec["processes"]:
        scene = spec["scenes"][proc["scene"]]
        fp = frozen_pack(profile, proc["scene"]) if frozen else None
        if fp:
            pack, meta_path = fp, fp.with_suffix(".meta.json")
        else:
            pack, meta_path = scene_pack(profile, scene)
        meta = json.loads(meta_path.read_text()) if meta_path and meta_path.exists() else None
        env = {"VIBE_CITY_SCENE": str(pack)}
        for k, v in scene.get("env", {}).items():
            env[k] = pack.with_suffix(".slots").read_text().strip() if v == "@slots" else v
        plan = {"cars": bool(scene.get("cars")), "phases": []}
        if scene.get("charges"):
            plan["charges"] = str(pack.parent / "charges.json")
        for ph in proc["phases"]:
            name = ph.get("scenario") or ph["name"]
            out = {"name": name, "ticks": ph["ticks"][tier], "record": ph.get("record", True)}
            if "drive" in ph:
                out["drive"] = ph["drive"]
            events = []
            listed = ph.get("events", [])
            if tier == "quick" and "events_quick" in ph:
                listed = listed[:ph["events_quick"]]
            for e in listed:
                events.append(shot_from_place(meta, e) if "place" in e else e)
            if events:
                out["events"] = events
            plan["phases"].append(out)
        pdir = run_dir / "plans"
        pdir.mkdir(parents=True, exist_ok=True)
        plan_path = pdir / f"{profile}-{proc['scene']}.json"
        plan_path.write_text(json.dumps(plan, indent=1))
        jobs.append({"profile": profile, "scene": proc["scene"], "plan": str(plan_path), "env": env,
                     "pack": str(pack), "pack_sha": sha(pack), "pack_frozen": bool(fp),
                     "scenarios": [p.get("scenario") for p in proc["phases"] if p.get("scenario")],
                     "replays": {p["scenario"]: p["replay"] for p in proc["phases"] if p.get("replay")}})
    return jobs


# ---------------------------------------------------------------- execution (inside the GPU lock)

def job_env(job: dict, profiles: dict, extra: dict) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("VIBE_", "PX_", "BLAST_", "TOWN_KIT", "CUMETAL_"))}
    env.update(profiles[job["profile"]])
    env.update(job["env"])
    env.update({"VIBE_SUITE_PLAN": job["plan"], "RUST_LOG": "warn", "VIBE_PHYSICS_BACKEND": "physx_gpu",
                "CUMETAL_CACHE_DIR": str(CUMETAL_CACHE),
                "VIBE_DESTRUCTION_ASSET_DIR": str(ROOT / "destruction/assets/scenes"),
                "VIBE_FLIGHT_RECORDER": "0"})
    env.update(extra)
    return env


CUMETAL_CACHE = Path(os.environ.get("PERF_SUITE_CUMETAL_CACHE", "/Users/glavin/Development/vibe-land/target/cumetal-cache"))
# Printed by the wrapper once the GPU lock is held: what came before is waiting.
LOCKED = "import os,sys,time; print('SUITE_LOCKED', time.time(), flush=True); os.execvp(sys.argv[1], sys.argv[1:])"


def gpu_cmd(label: str, cmd: list[str], shared: bool) -> tuple[list[str], dict]:
    """CMD under the machine's GPU admission, one job per hold: the exclusive
    lock for timing (it waits for running shared jobs and blocks new ones only
    while this one job runs), or a shared slot (VIBE_GPU_SHARED=1: timings only
    indicative)."""
    return [str(GPU_RUN), label, sys.executable, "-c", LOCKED, *cmd], ({"VIBE_GPU_SHARED": "1"} if shared else {})


def run_logged(cmd: list[str], env: dict, cwd: Path, logfile: Path, timeout: float) -> tuple[int, float, float]:
    """(rc, seconds holding the GPU, seconds waiting for it)."""
    t0 = time.time()
    with open(logfile, "w") as f:
        try:
            rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            rc = 124
            f.write(f"\nSUITE_TIMEOUT after {timeout} s\n")
    t1 = time.time()
    m = re.search(r"^SUITE_LOCKED ([\d.]+)", logfile.read_text(errors="replace"), re.M)
    locked = float(m[1]) if m else t0
    return rc, t1 - locked, locked - t0


def run_job(binary: str, env: dict, logfile: Path, timeout: float, shared: bool, label: str) -> tuple[int, float, float]:
    cmd, extra = gpu_cmd(f"perf-suite-{label}", [binary, "perf_suite::perf_suite", "--exact", "--ignored", "--nocapture",
                                                  "--test-threads=1"], shared)
    return run_logged(cmd, {**env, **extra}, ROOT / "server", logfile, timeout)


def run_replay(binary: str, capture: Path, runs: int, logfile: Path, shared: bool, label: str) -> tuple[int, float, float]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CUMETAL_")}
    env.update({"IMPACT_QUIET": "1", "CUMETAL_CACHE_DIR": str(CUMETAL_CACHE)})
    cmd, extra = gpu_cmd(f"perf-suite-{label}", [binary, str(capture), str(runs)], shared)
    return run_logged(cmd, {**env, **extra}, ROOT, logfile, 600)


def execute(run_dir: Path) -> None:
    """Every GPU job, each taking the GPU lock for itself only (at most a few
    minutes a hold), so queued correctness jobs run between them."""
    work = json.loads((run_dir / "work.json").read_text())
    shared = work.get("shared", False)
    logs = run_dir / "logs"
    logs.mkdir(exist_ok=True)
    timing = {"jobs": [], "shared": shared}

    def record(name, rc, held, waited):
        timing["jobs"].append({"job": name, "rc": rc, "seconds": held, "waited": waited})
        log(f"{name}: {held:.1f} s on the GPU (waited {waited:.0f} s for it; rc {rc})")

    # Warm-up: one short process per binary, untimed, on a shared slot: a new
    # build compiles its Metal pipelines here (minutes), which must not hold
    # the exclusive lock. Each timed process warms its own clocks in its
    # unrecorded settle phase.
    for profile, w in work["warmups"].items():
        record(f"warmup-{profile}", *run_job(work["binaries"][profile], job_env(w, work["profile_env"], work["extra_env"][profile]),
                                              logs / f"warmup-{profile}.log", 1800, True, f"warmup-{profile}"))
    for rep in range(work["reps"]):
        order = work["profiles"] if rep % 2 == 0 else list(reversed(work["profiles"]))
        for profile in order:
            for job in work["jobs"][profile]:
                name = f"rep{rep}-{profile}-{job['scene']}"
                record(name, *run_job(work["binaries"][profile], job_env(job, work["profile_env"], work["extra_env"][profile]),
                                      logs / f"{name}.log", work["timeout"], shared, name))
            for scenario, capture in work["replays"].get(profile, {}).items():
                name = f"rep{rep}-{profile}-replay-{scenario}"
                record(name, *run_replay(work["replay_binary"], Path(capture), work["replay_runs"], logs / f"{name}.log", shared, name))
    timing["seconds"] = sum(j["seconds"] for j in timing["jobs"])
    timing["timed_seconds"] = sum(j["seconds"] for j in timing["jobs"] if not j["job"].startswith("warmup"))
    timing["waited_seconds"] = sum(j["waited"] for j in timing["jobs"])
    (run_dir / "timing.json").write_text(json.dumps(timing, indent=1))


# ---------------------------------------------------------------- reading the logs

IMPACT_EVAL = re.compile(r"\[impact\] evaluation (\d+) pass (\d+): ([\d.]+) ms in (\d+) dispatches \(longest ([\d.]+) ms\)")
# The stage's summary of a triggered evaluation (PX_DESTRUCTION_IMPACT_LOG=1); the
# diverged count and the tail (held stops, infeasible projections) are newer fields.
IMPACT_PASS = re.compile(r"\[impact\] pass (\d+): (\d+) islands, (\d+) solves, (\d+) iterations \((\d+) capped(?:, (\d+) diverged)?\), "
                         r"(\d+) rounds, broke (\d+), yielded (\d+), (\d+) contacts from (\d+) impactors.*?error (\d+)\s*$")
REPLAY = re.compile(r": (\d+) chunks, (\d+) bonds, (\d+) rows; (\d+) islands, (\d+) solves, (\d+) iterations \((\d+) capped\), (\d+) rounds; "
                    r"broke (\d+), yielded (\d+); (\d+) contacts, (\d+) impactors; error (\d+); ([\d.]+) ms in (\d+) dispatches \(longest ([\d.]+) ms\)")


def read_job(path: Path) -> dict:
    """Phases with their ticks; each tick carries the impact passes printed during it."""
    phases, setup, done, pending = {}, None, None, {"evals": [], "passes": []}
    current = None
    for line in path.read_text(errors="replace").splitlines():
        if line.startswith("SUITE_TICK "):
            d = json.loads(line[11:])
            t = d["t"]
            t["impact_evals"], t["impact_passes"] = pending["evals"], pending["passes"]
            pending = {"evals": [], "passes": []}
            phases.setdefault(d["phase"], []).append(t)
        elif line.startswith("SUITE_PHASE "):
            current = json.loads(line[12:])["name"]
            pending = {"evals": [], "passes": []}
        elif line.startswith("SUITE_SETUP "):
            setup = json.loads(line[12:])
        elif line.startswith("SUITE_DONE "):
            done = json.loads(line[11:])
        elif (m := IMPACT_EVAL.search(line)):
            pending["evals"].append({"ms": float(m[3]), "dispatches": int(m[4]), "longest": float(m[5])})
        elif (m := IMPACT_PASS.search(line)):
            pending["passes"].append({"solves": int(m[3]), "iterations": int(m[4]), "capped": int(m[5]),
                                      "diverged": int(m[6]) if m[6] is not None else int(bool(int(m[12]) & 2)),
                                      "rounds": int(m[7]), "broke": int(m[8]), "error": int(m[12])})
    return {"phases": phases, "setup": setup, "done": done, "complete": done is not None}


def pct(v: list[float], p: float) -> float:
    if not v:
        return float("nan")
    s = sorted(v)
    return s[min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))]


def live_metrics(ticks: list[dict]) -> dict:
    total = [t["total"] for t in ticks]
    fetch = [t.get("fetch", float("nan")) for t in ticks]
    wait = [t["gpu_wait"] for t in ticks if t.get("gpu_wait") is not None]
    evals = [e for t in ticks for e in t["impact_evals"]]
    passes = [p for t in ticks for p in t["impact_passes"]]
    return {
        "kind": "live", "ticks": len(ticks),
        "step_ms": {"median": st.median(total), "p95": pct(total, 95), "max": max(total), "mean": st.fmean(total)},
        "parts_ms_median": {k: st.median(t[k] for t in ticks) for k in ("player", "dyn", "city")},
        # The fetch: the host blocked on the GPU's step (the destruction stage runs in it).
        "fetch_ms": {"median": st.median(fetch), "p95": pct(fetch, 95), "sum": sum(fetch)},
        # The bridge's exact GPU wait, on its sampled steps (1 in 16).
        "gpu_wait_ms": {"median": st.median(wait) if wait else None, "samples": len(wait)},
        "stress": {"iterations": sum(t["it"] for t in ticks), "iterations_per_tick": st.fmean(t["it"] for t in ticks),
                   "iterations_max": max(t["it"] for t in ticks), "unconverged_ticks": sum(1 for t in ticks if not t["conv"]),
                   "passes": sum(t["passes"] for t in ticks), "correction_passes": sum(t["corr"] for t in ticks)},
        "impact": {"evaluations": len(passes), "solves": sum(p["solves"] for p in passes),
                   "steps": sum(p["iterations"] for p in passes), "capped": sum(p["capped"] for p in passes),
                   "diverged": sum(p["diverged"] for p in passes), "round_budget": sum(1 for p in passes if p["error"] & 4),
                   "ms": sum(e["ms"] for e in evals), "longest_dispatch_ms": max((e["longest"] for e in evals), default=0.0),
                   "logged": bool(evals) or bool(passes)},
        "work": {"bonds_broken": sum(t["committed"] for t in ticks), "crushed": sum(t["crushed"] for t in ticks),
                 "error_ticks": sum(1 for t in ticks if t["err"]), "awake_max": max(t["awake"] for t in ticks),
                 "contacts_max": max(t["contacts"] for t in ticks)},
        "score_value": pct(total, 95),
    }


def read_replay(path: Path) -> dict | None:
    runs = []
    for line in path.read_text(errors="replace").splitlines():
        if (m := REPLAY.search(line)):
            runs.append({"solves": int(m[5]), "iterations": int(m[6]), "capped": int(m[7]), "rounds": int(m[8]),
                         "error": int(m[13]), "ms": float(m[14]), "dispatches": int(m[15]), "longest": float(m[16]),
                         "chunks": int(m[1]), "bonds": int(m[2])})
    if not runs:
        return None
    timed = runs[1:] if len(runs) > 2 else runs  # with 3+ runs the first (first-use costs) is dropped
    ms = [r["ms"] for r in timed]
    r0 = runs[0]
    return {"kind": "replay", "runs": len(timed),
            "step_ms": {"median": st.median(ms), "p95": pct(ms, 95), "max": max(ms), "mean": st.fmean(ms)},
            "impact": {"evaluations": 1, "solves": r0["solves"], "steps": r0["iterations"], "capped": r0["capped"],
                       "diverged": int(bool(r0["error"] & 2)), "round_budget": int(bool(r0["error"] & 4)),
                       "ms": st.median(ms), "longest_dispatch_ms": max(r["longest"] for r in timed),
                       "dispatches": r0["dispatches"], "chunks": r0["chunks"], "bonds": r0["bonds"]},
            "score_value": st.median(ms)}


# ---------------------------------------------------------------- the report

def gmean(v: list[float]) -> float:
    v = [x for x in v if x and x > 0 and math.isfinite(x)]
    return math.exp(st.fmean(math.log(x) for x in v)) if v else float("nan")


def summarise(run_dir: Path) -> dict:
    work = json.loads((run_dir / "work.json").read_text())
    timing = json.loads((run_dir / "timing.json").read_text()) if (run_dir / "timing.json").exists() else {}
    logs = run_dir / "logs"
    scen: dict = {p: {} for p in work["profiles"]}
    problems = []
    for rep in range(work["reps"]):
        for profile in work["profiles"]:
            for job in work["jobs"][profile]:
                path = logs / f"rep{rep}-{profile}-{job['scene']}.log"
                if not path.exists():
                    problems.append(f"{path.name}: not run")
                    continue
                j = read_job(path)
                if not j["complete"]:
                    tail = [l for l in path.read_text(errors="replace").splitlines() if "panicked" in l or "SUITE_TIMEOUT" in l or "error" in l.lower()][:2]
                    problems.append(f"{path.name}: did not finish ({'; '.join(tail)[:200]})")
                for s in job["scenarios"]:
                    ticks = j["phases"].get(s)
                    if not ticks:
                        continue
                    m = live_metrics(ticks)
                    m["setup_ms"] = (j["setup"] or {}).get("ms")
                    m["complete"] = j["complete"] and len(ticks) == next(
                        ph["ticks"] for ph in json.loads(Path(job["plan"]).read_text())["phases"] if ph["name"] == s)
                    scen[profile].setdefault(s, []).append(m)
            for s in work["replays"].get(profile, {}):
                path = logs / f"rep{rep}-{profile}-replay-{s}.log"
                r = read_replay(path) if path.exists() else None
                if r:
                    r["complete"] = True
                    scen[profile].setdefault(s, []).append(r)
                else:
                    problems.append(f"{path.name}: no replay result")
    out = {"label": work.get("label"), "tier": work.get("tier"), "reps": work["reps"], "created": work.get("created"),
           "fingerprint": work.get("fingerprint"), "headline": work.get("headline", "high"),
           "wall_seconds": timing.get("timed_seconds", timing.get("seconds")), "warmup_seconds":
               sum(j["seconds"] for j in timing.get("jobs", []) if j["job"].startswith("warmup")),
           "lock_wait_seconds": timing.get("waited_seconds"), "shared_gpu": timing.get("shared"), "jobs": timing.get("jobs"), "problems": problems, "profiles": {}}
    for profile, ss in scen.items():
        prof = {}
        for s, reps in ss.items():
            vals = [r["score_value"] for r in reps if r.get("complete")]
            # The median over reps: one rep disturbed (GPU clock, another process
            # on the GPU outside the lock) does not move the value.
            prof[s] = {"kind": reps[0]["kind"], "values": vals, "value": st.median(vals) if vals else None,
                       "cv": (st.stdev(vals) / st.fmean(vals)) if len(vals) > 1 else None, "reps": reps}
        out["profiles"][profile] = {"scenarios": prof,
                                    "geomean_ms": gmean([v["value"] for v in prof.values() if v["value"]])}
    return out


def declared_env(specs: list[str], profiles: list[str]) -> dict:
    """--env [PROFILE:]KEY=VAL ... as {profile: {KEY: VAL}}. Live jobs only:
    the high profile's impact replays run PhysX's replay binary, whose
    environment is its own."""
    out = {p: {} for p in profiles}
    for spec in specs:
        target, _, kv = spec.rpartition(":") if ":" in spec.split("=", 1)[0] else ("", "", spec)
        key, sep, value = kv.partition("=")
        if not sep or not key:
            sys.exit(f"--env {spec}: expected [PROFILE:]KEY=VAL")
        if target and target not in out:
            sys.exit(f"--env {spec}: profile {target} is not in this run ({','.join(profiles)})")
        for p in ([target] if target else profiles):
            out[p][key] = value
    return out


def comparability(report: dict, base: dict) -> list[str]:
    """What differs between the arms besides the code under test: a delta
    across different packs, captures or tiers describes another workload."""
    notes, a, b = [], report.get("fingerprint") or {}, base.get("fingerprint") or {}
    if report.get("tier") != base.get("tier"):
        notes.append(f"tier {report.get('tier')} vs baseline {base.get('tier')}: different tick counts")
    for p, scenes in (a.get("packs") or {}).items():
        for scene, h in scenes.items():
            bh = (b.get("packs") or {}).get(p, {}).get(scene)
            if bh and bh != h:
                notes.append(f"{p} {scene}: pack differs from the baseline's ({h} vs {bh})")
    for n, h in (a.get("captures") or {}).items():
        bh = (b.get("captures") or {}).get(n)
        if bh and bh != h:
            notes.append(f"capture {n} differs from the baseline's")
    for p in sorted(set(a.get("env") or {}) | set(b.get("env") or {})):
        mine, theirs = (a.get("env") or {}).get(p, {}), (b.get("env") or {}).get(p, {})
        for k in sorted(set(mine) | set(theirs)):
            if mine.get(k) != theirs.get(k):
                notes.append(f"{p}: declared env {k}={mine.get(k, '(unset)')} vs baseline {theirs.get(k, '(unset)')}")
    if report.get("shared_gpu") or base.get("shared_gpu"):
        notes.append("an arm ran on a shared GPU: timings indicative only")
    return notes


SD_FLOOR = {"live": 0.06, "replay": 0.015}


def score(report: dict, base: dict | None) -> None:
    """Fills each profile's composite: geomean of value/baseline (1.0 = the baseline; lower is faster),
    with its noise band from the per-rep scatter of both runs."""
    for profile, prof in report["profiles"].items():
        b = (base or {}).get("profiles", {}).get(profile, {}).get("scenarios", {}) if base else {}
        ratios, var = [], []
        for s, v in prof["scenarios"].items():
            bv = b.get(s)
            if not (bv and bv.get("value") and v.get("value")) or bv["kind"] != v["kind"]:
                v["delta"] = None
                continue
            r = v["value"] / bv["value"]
            # Run-to-run noise of log(value): pooled from whichever arms have reps.
            sds = [st.stdev([math.log(x) for x in arm["values"]]) for arm in (v, bv) if len(arm["values"]) > 1]
            # Floor: three reps taken minutes apart understate the scatter between
            # sessions (A/A runs a day's work apart moved live scenarios 5-10 %).
            sd = max(sds + [SD_FLOOR[v["kind"]]]) if sds else SD_FLOOR[v["kind"]]
            n_c, n_b = len(v["values"]), len(bv["values"])
            band = 2.0 * sd * math.sqrt(1 / n_c + 1 / n_b) if sd is not None else None
            sig = band is not None and abs(math.log(r)) > band and abs(r - 1) >= 0.05 and abs(v["value"] - bv["value"]) >= 0.3
            wb = [m["work"]["bonds_broken"] for m in v["reps"] if "work" in m]
            wbb = [m["work"]["bonds_broken"] for m in bv["reps"] if "work" in m]
            drift = None
            if wb and wbb and st.fmean(wbb) > 50:
                drift = st.fmean(wb) / st.fmean(wbb) - 1
            v["delta"] = {"ratio": r, "pct": (r - 1) * 100, "band_pct": (math.exp(band) - 1) * 100 if band is not None else None,
                          "significant": sig, "work_drift_pct": drift * 100 if drift is not None else None}
            ratios.append(math.log(r))
            if sd is not None:
                var.append((sd ** 2) * (1 / n_c + 1 / n_b))
        if ratios:
            k = len(ratios)
            comp = math.exp(st.fmean(ratios))
            band = 2.0 * math.sqrt(sum(var)) / k if var else None
            prof["score"] = {"value": comp, "scenarios": k, "band_pct": (math.exp(band) - 1) * 100 if band is not None else None,
                             "significant": band is not None and abs(math.log(comp)) > band}
        else:
            prof["score"] = None


def fmt(x, nd=1):
    return "-" if x is None or (isinstance(x, float) and not math.isfinite(x)) else f"{x:.{nd}f}"


def table(report: dict) -> str:
    lines = [f"perf suite: {report.get('label')} ({report.get('tier')}, {report['reps']} rep(s)), "
             f"{fmt(report.get('wall_seconds'), 0)} s timed on the GPU (+{fmt(report.get('warmup_seconds'), 0)} s warm-up, "
             f"{fmt(report.get('lock_wait_seconds'), 0)} s waiting for the lock)"
             + ("  [SHARED GPU: timings indicative only]" if report.get("shared_gpu") else "")]
    declared = {p: e for p, e in ((report.get("fingerprint") or {}).get("env") or {}).items() if e}
    if declared:
        lines.append("declared env (--env): " + "; ".join(f"{p} " + " ".join(f"{k}={v}" for k, v in sorted(e.items()))
                                                          for p, e in sorted(declared.items())))
    for profile in sorted(report["profiles"], key=lambda p: p != report.get("headline")):
        prof = report["profiles"][profile]
        sc = prof.get("score")
        head = f"\n== {profile}{' (headline)' if profile == report.get('headline') else ''}: geomean {fmt(prof['geomean_ms'], 2)} ms"
        if sc:
            head += (f", SCORE {sc['value']:.3f} vs baseline (±{fmt(sc['band_pct'])}%, "
                     f"{('faster' if sc['value'] < 1 else 'SLOWER') if sc['significant'] else 'within noise'}; lower is faster)")
        lines.append(head)
        lines.append(f"{'scenario':<17} {'kind':<6} {'median':>8} {'p95':>8} {'worst':>8} {'fetch':>8} {'it/tick':>7} "
                     f"{'unconv':>6} {'imp.ev':>6} {'imp.steps':>9} {'capped':>6} {'longest':>7} {'cv%':>5}  vs baseline")
        for s, v in prof["scenarios"].items():
            ms = [r["step_ms"] for r in v["reps"]]
            med = st.fmean(m["median"] for m in ms)
            p95 = st.fmean(m["p95"] for m in ms)
            worst = max(m["max"] for m in ms)
            r0 = v["reps"]
            imp = [r["impact"] for r in r0]
            wait = st.fmean(r["fetch_ms"]["median"] for r in r0) if v["kind"] == "live" else None
            it = st.fmean(r["stress"]["iterations_per_tick"] for r in r0) if v["kind"] == "live" else None
            unc = st.fmean(r["stress"]["unconverged_ticks"] for r in r0) if v["kind"] == "live" else None
            d = v.get("delta")
            dtxt = ""
            if d:
                verdict = ("faster" if d["pct"] < 0 else "SLOWER") if d["significant"] else ("within noise" if d["band_pct"] is not None else "no noise estimate (reps)")
                dtxt = f"{d['pct']:+.1f}% (±{fmt(d['band_pct'])}%) {verdict}"
                if d.get("work_drift_pct") is not None and abs(d["work_drift_pct"]) > 15:
                    dtxt += f" [bonds broken {d['work_drift_pct']:+.0f}%: different workload]"
            lines.append(f"{s:<17} {v['kind']:<6} {med:8.2f} {p95:8.2f} {worst:8.1f} {fmt(wait, 2):>8} {fmt(it):>7} {fmt(unc, 0):>6} "
                         f"{st.fmean(i['evaluations'] for i in imp):6.0f} {st.fmean(i['steps'] for i in imp):9.0f} "
                         f"{st.fmean(i['capped'] for i in imp):6.0f} {max(i['longest_dispatch_ms'] for i in imp):7.1f} "
                         f"{fmt((v['cv'] or 0) * 100 if v['cv'] is not None else None):>5}  {dtxt}")
    if report.get("comparability"):
        lines.append("\nCOMPARABILITY:\n  " + "\n  ".join(report["comparability"]))
    if report.get("problems"):
        lines.append("\nPROBLEMS:\n  " + "\n  ".join(report["problems"]))
    lines.append("\nScored value per scenario: live = p95 of the server tick (ms); replay = median impact-evaluation time (ms)."
                 "\nfetch = median PhysX fetch (host blocked on the GPU step, the stage inside it); it/tick = stress iterations;"
                 "\nunconv = unconverged ticks; imp.* = impact solve: triggered evaluations, ADMM steps, capped solves, longest dispatch (ms).")
    return "\n".join(lines)


# ---------------------------------------------------------------- captures (once)

def capture(spec: dict, args) -> None:
    """Live high-fidelity runs of the scenarios that name a `replay`, with the
    stage writing the inputs of its slowest impact evaluations
    (PX_DESTRUCTION_IMPACT_CAPTURE); keeps the slowest one per scenario as
    target/perf-suite/captures/<replay>.impc. Not timing: shares the GPU."""
    env = profile_env("high")
    binary = build(env)
    run_dir = OUT / "captures" / time.strftime("work-%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True)
    jobs = [j for j in make_jobs(spec, "high", "standard", run_dir) if j["replays"]]
    manifest_path = CAPTURES / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for job in jobs:
        cdir = run_dir / job["scene"]
        cdir.mkdir()
        extra = {"PX_DESTRUCTION_IMPACT_CAPTURE": str(cdir), "PX_DESTRUCTION_IMPACT_CAPTURE_MS": "300",
                 "PX_DESTRUCTION_IMPACT_CAPTURE_COUNT": "8", "VIBE_GPU_SHARED": "1"}
        logf = run_dir / f"{job['scene']}.log"
        log(f"capturing {job['scene']} (high profile, live; minutes)")
        e = job_env(job, {"high": env}, extra)
        cmd = [str(GPU_RUN), f"perf-suite-capture-{job['scene']}", str(binary), "perf_suite::perf_suite", "--exact",
               "--ignored", "--nocapture", "--test-threads=1"]
        with open(logf, "w") as f:
            subprocess.run(cmd, cwd=ROOT / "server", env=e, stdout=f, stderr=subprocess.STDOUT, timeout=args.timeout)
        caught = [(float(m[2]), m[1]) for m in re.finditer(r"\[impact\] captured (\S+) \(([\d.]+) ms\)", logf.read_text(errors="replace"))]
        if not caught:
            log(f"{job['scene']}: nothing captured (log {logf})")
            continue
        ms, path = max(caught)
        for scenario, name in job["replays"].items():
            dest = CAPTURES / f"{name}.impc"
            dest.write_bytes(Path(path).read_bytes())
            manifest[name] = {"scenario": scenario, "scene": job["scene"], "pack": job["pack"], "pack_sha": job["pack_sha"],
                              "captured_ms": ms, "source": path, "sha": sha(dest), "created": time.strftime("%Y-%m-%d %H:%M"),
                              "sdk": sdk_fingerprint(Path(env["PHYSX_ROOT"])), "candidates": sorted(caught, reverse=True)}
            log(f"{name}: kept {Path(path).name} ({ms:.0f} ms) of {len(caught)}")
    CAPTURES.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1))


# ---------------------------------------------------------------- main

def git(*a) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True).stdout.strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="the ~60 s tier (fewer ticks, one rep)")
    ap.add_argument("--reps", type=int, default=None, help="repetitions (default 1; a baseline wants 3+)")
    ap.add_argument("--profiles", default=None, help="comma list (default runtime,high)")
    ap.add_argument("--label", default="run")
    ap.add_argument("--compare", default=None, help="baseline report.json (default scripts/perf/suite-baseline.json, or suite-baseline-quick.json for --quick)")
    ap.add_argument("--no-compare", action="store_true")
    ap.add_argument("--save-baseline", action="store_true", help="write this run as the tier's baseline (scripts/perf/suite-baseline[-quick].json)")
    ap.add_argument("--report", default=None, help="re-read a run directory (no GPU)")
    ap.add_argument("--capture", action="store_true", help="make the impact captures the high-fidelity replays use")
    ap.add_argument("--replay-runs", type=int, default=None, help="runs of each impact replay per rep (default 1: each is a whole impact tick's solve, 2-12 s)")
    ap.add_argument("--timeout", type=float, default=900)
    ap.add_argument("--env", action="append", default=[], metavar="[PROFILE:]KEY=VAL",
                    help="an environment variable for every live job (or only PROFILE's), recorded in the report's "
                         "fingerprint; the suite otherwise strips VIBE_*, PX_*, BLAST_*, TOWN_KIT* and CUMETAL_* from "
                         "the caller, so this is the only way an A/B arm differs by a flag. Repeatable.")
    ap.add_argument("--checkout-packs", action="store_true", help="this checkout's packs instead of the frozen ones "
                    "(an authoring change; --save-baseline then freezes them)")
    ap.add_argument("--shared", action="store_true", help="share the GPU (VIBE_GPU_SHARED=1): for developing the suite; timings only indicative")
    ap.add_argument("--exec", default=None, help=argparse.SUPPRESS)
    args = ap.parse_args()
    spec = json.loads(SPEC.read_text())
    if args.exec:
        execute(Path(args.exec))
        return
    if args.capture:
        capture(spec, args)
        return
    def baseline_for(tier: str) -> Path:
        # One baseline per tier: a quick run compares with the quick baseline.
        return ROOT / f"scripts/perf/suite-baseline{'-quick' if tier == 'quick' else ''}.json"
    if args.report:
        run_dir = Path(args.report)
    else:
        tier = "quick" if args.quick else "standard"
        reps = args.reps or 1
        profiles = (args.profiles or ",".join(spec["profiles"])).split(",")
        run_dir = OUT / "runs" / f"{time.strftime('%Y%m%d-%H%M%S')}-{args.label}"
        run_dir.mkdir(parents=True)
        t_build = time.monotonic()
        penv = {p: profile_env(p) for p in profiles}
        binaries = {p: str(build(penv[p])) for p in profiles}
        jobs, replays, all_by_profile = {}, {}, {}
        manifest = json.loads((CAPTURES / "manifest.json").read_text()) if (CAPTURES / "manifest.json").exists() else {}
        for p in profiles:
            all_jobs = make_jobs(spec, p, tier, run_dir, frozen=not args.checkout_packs)
            live = [proc for proc in spec["processes"] if p in proc.get("live", spec["profiles"])]
            all_by_profile[p] = all_jobs
            jobs[p] = [j for j in all_jobs if any(proc["scene"] == j["scene"] for proc in live)]
            # Scenarios not run live in this profile are timed as replays of their capture.
            replays[p] = {}
            for j in all_jobs:
                if j in jobs[p]:
                    continue
                for s, name in j["replays"].items():
                    if (CAPTURES / f"{name}.impc").exists():
                        replays[p][s] = str(CAPTURES / f"{name}.impc")
                    else:
                        log(f"{p} {s}: no capture ({CAPTURES}/{name}.impc): run scripts/perf/suite.sh --capture")
        # Warm-up per binary: the first scene's setup and a few ticks, untimed.
        warmups = {}
        for p in profiles:
            w = dict(jobs[p][0]) if jobs[p] else None
            if w:
                plan = json.loads(Path(w["plan"]).read_text())
                # Long enough for the GPU to reach its working clock (a quick
                # baseline's first rep ran ~40% slow after a 30-tick warm-up).
                plan["phases"] = [{"name": "warm", "ticks": 150, "record": False}]
                wp = run_dir / "plans" / f"warmup-{p}.json"
                wp.write_text(json.dumps(plan))
                w["plan"] = str(wp)
                warmups[p] = w
        rbin = replay_binary(penv.get("high", {})) if "high" in penv else None
        if any(replays.values()) and not rbin:
            sys.exit("no destruction_impact_capture_replay (set PERF_SUITE_REPLAY_BIN)")
        declared = declared_env(args.env, profiles)
        fingerprint = {"git": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain", "--untracked-files=no")),
                       "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
                       "sdk": {p: sdk_fingerprint(Path(penv[p]["PHYSX_ROOT"])) for p in profiles},
                       "binary": {p: {"path": b, "mtime": os.stat(b).st_mtime} for p, b in binaries.items()},
                       "packs": {p: {j["scene"]: j["pack_sha"] for j in all_by_profile[p]} for p in profiles},
                       "packs_frozen": all(j["pack_frozen"] for p in profiles for j in all_by_profile[p]),
                       "captures": {n: c.get("sha") for n, c in manifest.items()},
                       "replay_binary": str(rbin) if rbin else None,
                       "env": declared,
                       "host": os.uname().nodename}
        work = {"label": args.label, "tier": tier, "reps": reps, "profiles": profiles, "binaries": binaries,
                "profile_env": penv, "headline": spec.get("headline", "high"), "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "extra_env": {p: {**({"PX_DESTRUCTION_IMPACT_LOG": "1"} if p == "high" else {}), **declared[p]} for p in profiles},
                "warmups": warmups, "jobs": jobs, "all_jobs": all_by_profile, "replays": replays, "replay_binary": str(rbin) if rbin else None,
                "replay_runs": args.replay_runs or 1, "timeout": args.timeout, "fingerprint": fingerprint,
                "build_seconds": time.monotonic() - t_build, "shared": args.shared}
        (run_dir / "work.json").write_text(json.dumps(work, indent=1))
        log(f"built and planned in {work['build_seconds']:.0f} s -> {run_dir}")
        execute(run_dir)
    report = summarise(run_dir)
    baseline_default = baseline_for(report.get("tier") or "standard")
    base_path = None if args.no_compare else Path(args.compare) if args.compare else (baseline_default if baseline_default.exists() else None)
    base = json.loads(base_path.read_text()) if base_path else None
    if args.save_baseline:
        base = None
    score(report, base)
    report["baseline"] = str(base_path) if base else None
    report["comparability"] = comparability(report, base) if base else []
    (run_dir / "report.json").write_text(json.dumps(report, indent=1))
    text = table(report)
    (run_dir / "report.txt").write_text(text + "\n")
    print(text)
    print(f"\n{run_dir}/report.json")
    if args.save_baseline:
        work = json.loads((run_dir / "work.json").read_text())
        freeze_packs([j for p in work["profiles"] for j in work.get("all_jobs", {}).get(p, work["jobs"][p])])
        baseline_default.write_text(json.dumps(report, indent=1))
        print(f"baseline saved: {baseline_default}")


if __name__ == "__main__":
    main()
