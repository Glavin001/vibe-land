#!/usr/bin/env python3
"""Interleaved n-trial A/B for the city trace, with a noise floor.

Encodes two rules this project has repeatedly been burned by:

  - GPU physics is not reproducible and each run collapses a different amount
    of building, so an effect smaller than the run-to-run band is UNMEASURED,
    not measured-as-small. This reports the band and says so.
  - A perf win that destroys less city is not a win. Damage is reported beside
    every timing, and a run whose damage moved more than the band is flagged.

Sides are interleaved A,B,A,B... so thermal drift and GPU clock ramp land on
both rather than on whichever ran second.

  scripts/ab-measure.py --env BLAST_INCREMENTAL_LOOKUP --off 0 --on 1 -n 5
"""
import argparse, os, re, statistics as st, subprocess, sys

TICK = re.compile(
    r"^tick\s+(\d+)\s+bodies\s+(\d+)\s+awake\s+(\d+)\s+broken\s+(\d+)\s+solve\s+([\d.]+)"
    r".*?begin\s+([\d.]+)\s+solve\s+([\d.]+)\s+end\s+([\d.]+)\s+readback\s+([\d.]+)"
    r"\s+events\s+([\d.]+)\s+filters\s+([\d.]+)\s+ccd\s+([\d.]+)\s+support\s+([\d.]+)")
FRAC = re.compile(r"fracture:\s+gen\s+([\d.]+)\s+prep\s+([\d.]+)\s+apply\s+([\d.]+)"
                  r"\s+scene\s+([\d.]+)\s+rebuild\s+([\d.]+)\s+valid\s+([\d.]+)")
PHYSX = re.compile(r"physx step\s+([\d.]+)\s+ms avg")
FINAL = re.compile(r"broken bonds\s+(\d+)")

# Metrics keyed by name -> list of samples within one run.
def parse(out):
    m = {k: [] for k in
         ("stress_solve", "begin", "solve", "end", "readback", "events",
          "filters", "ccd", "support", "awake", "physx_step",
          "frac_gen", "frac_rebuild", "frac_scene")}
    broken = 0
    for line in out.splitlines():
        t = TICK.search(line)
        if t and int(t.group(1)) > 0:          # tick 0 is the city being built
            g = [float(x) for x in t.groups()]
            m["awake"].append(g[2]); m["stress_solve"].append(g[4])
            m["begin"].append(g[5]); m["solve"].append(g[6]); m["end"].append(g[7])
            m["readback"].append(g[8]); m["events"].append(g[9])
            m["filters"].append(g[10]); m["ccd"].append(g[11]); m["support"].append(g[12])
        f = FRAC.search(line)
        if f and float(f.group(1)) < 50:       # skip the initial build
            m["frac_gen"].append(float(f.group(1)))
            m["frac_rebuild"].append(float(f.group(5)))
            m["frac_scene"].append(float(f.group(4)))
        p = PHYSX.search(line)
        if p and float(p.group(1)) < 50:
            m["physx_step"].append(float(p.group(1)))
        b = FINAL.search(line)
        if b:
            broken = int(b.group(1))
    return {k: (st.median(v) if v else 0.0) for k, v in m.items()}, broken

def run(cmd, env_name, value, extra_env):
    env = dict(os.environ, **extra_env)
    if env_name:
        env[env_name] = value
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=3600)
    return parse(r.stdout + r.stderr)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True, help="env var to A/B")
    ap.add_argument("--off", default="0"); ap.add_argument("--on", default="1")
    ap.add_argument("-n", type=int, default=5)
    ap.add_argument("--seconds", default="30")
    ap.add_argument("--scene", default="destruction/assets/scenes/fractured-downtown.json")
    a = ap.parse_args()

    cmd = ["./target/release/record-city-trace", "--scene", a.scene, "--grid", "1",
           "--seconds", a.seconds, "--shots", "600", "--shot-interval-ticks", "4",
           "--targets", "27", "--output", "/dev/null"]
    extra = dict(
        LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:"
                        + os.environ.get("LD_LIBRARY_PATH", ""),
        VIBE_CITY_FREEZE="1", VIBE_CITY_VARIED_HEIGHTS="0",
        VIBE_CITY_STRESS_LIMIT_SCALE="0.6", VIBE_CITY_SOLVER_ITERATIONS="32",
        VIBE_CITY_SHOT_BLAST_RADIUS="0.4", VIBE_CITY_SHOT_STRESS_IMPULSE="4.0e7",
        VIBE_WORLD_FRICTION="0.75", VIBE_WORLD_RESTITUTION="0.02",
        VIBE_PHYSX_PROFILE_FETCH="1")

    A, B, AB, BB = [], [], [], []
    for i in range(a.n):
        for side, val, acc, bacc in (("off", a.off, A, AB), ("on", a.on, B, BB)):
            m, b = run(cmd, a.env, val, extra)
            acc.append(m); bacc.append(b)
            print(f"  trial {i+1} {side:3s}  broken {b:6d}  end {m['end']:.2f} "
                  f"physx {m['physx_step']:.2f}  awake {m['awake']:.0f}", flush=True)

    print(f"\n{a.env}: {a.off} -> {a.on}, n={a.n} interleaved\n")
    # Almost every phase scales with awake bodies, and awake varies run to run
    # because each run collapses a different amount of building. Comparing raw
    # milliseconds across sides whose awake counts differ is a category error --
    # it credits the fix with damage variance. Normalise the awake-scaled
    # phases, and say plainly when the two sides were not comparable.
    AWAKE_SCALED = {"stress_solve", "begin", "solve", "readback", "events",
                    "filters", "ccd", "support", "physx_step"}
    aw_off = st.median([m["awake"] for m in A])
    aw_on = st.median([m["awake"] for m in B])
    aw_noise = max(max(m["awake"] for m in A) - min(m["awake"] for m in A),
                   max(m["awake"] for m in B) - min(m["awake"] for m in B)) / 2
    skew = abs(aw_on - aw_off)
    if skew > aw_noise:
        print(f"!! awake differs {aw_off:.0f} vs {aw_on:.0f} (band {aw_noise:.0f}).")
        print("   Awake-scaled phases shown per 1k awake; raw ms would credit this")
        print("   fix with the damage difference. Raise -n or match damage.")
        print("")

    print(f"{'metric':16s} {'off':>9s} {'on':>9s} {'delta':>9s} {'noise':>9s}  verdict")
    print("-" * 68)
    for k in A[0]:
        if k in AWAKE_SCALED and skew > aw_noise:
            # per 1k awake, using each run's own awake count
            ao = [m[k] / max(m["awake"], 1) * 1000 for m in A]
            bo = [m[k] / max(m["awake"], 1) * 1000 for m in B]
            k = k + "/1k"
        else:
            ao = [m[k] for m in A]; bo = [m[k] for m in B]
        mo, mn = st.median(ao), st.median(bo)
        # Noise floor: the larger within-side spread. An effect that does not
        # clear the noise the SAME configuration produces is not an effect.
        noise = max(max(ao) - min(ao), max(bo) - min(bo)) / 2 if a.n > 1 else float("inf")
        d = mn - mo
        verdict = "MEASURABLE" if abs(d) > noise and noise > 0 else "inside noise"
        arrow = "better" if (d < 0 and k != "awake") else ("worse" if d > 0 else "")
        print(f"{k:16s} {mo:9.2f} {mn:9.2f} {d:+9.2f} {noise:9.2f}  {verdict} {arrow}")
    dmo, dmn = st.median(AB), st.median(BB)
    dnoise = max(max(AB) - min(AB), max(BB) - min(BB)) / 2 if a.n > 1 else 0
    held = abs(dmn - dmo) <= max(dnoise, 0.15 * dmo)
    print("-" * 68)
    print(f"{'broken_bonds':16s} {dmo:9.0f} {dmn:9.0f} {dmn-dmo:+9.0f} {dnoise:9.0f}  "
          f"{'damage held' if held else 'DAMAGE MOVED -- not a valid comparison'}")
    return 0 if held else 1

sys.exit(main())
