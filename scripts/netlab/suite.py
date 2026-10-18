#!/usr/bin/env python3
"""The /city netcode measurement suite: capture from a live match, replay the
whole netcode headlessly, score, compare, journal.

    scripts/netlab/suite.py capture <scenario> [--bots N] [--out DIR]
    scripts/netlab/suite.py replay  <scenario> [--clients 10,50,100] [--profiles none,wifi-bad,lte]
    scripts/netlab/suite.py compare --baseline DIR --candidate DIR
    scripts/netlab/suite.py journal --experiment ID --hypothesis TEXT --verdict keep|discard

`capture` starts a PRIVATE server instance (its own ports; never the live one),
with the native backend on the town scene, recording its encoder tape
(VIBE_CITY_TAPE_OUT). It then joins N bots through degraded links and drives
the scenario's meteors through /city-meteor, stops the capture cleanly, and
kills only the process it started. The tape plus the bots' arrival-ordered
packet logs are what everything downstream measures.

The five downtown scenarios in scenarios.py are Blast-backend tapes recorded
offline; they remain a valid encoder regression set but are never aggregated
with native captures.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = Path("/dev/shm/netlab/captures")
API_PORT, WEB_PORT, WT_PORT = 4019, 1113, 4436
MATCH = "city-default"
CERT_DIR = ROOT / ".certs" / "vast-city"

# meteors per building by chunk count: (max_chunks, meteors)
METEORS_BY_SIZE = [(300, 1), (900, 2), (2000, 3), (10**9, 4)]


def meteors_for(chunks: int) -> int:
    for limit, count in METEORS_BY_SIZE:
        if chunks <= limit:
            return count
    return 4


# Each scenario: what it does and the question it answers. `plan` is a
# generator of (delay_seconds, [x,y,z]) meteor launches; `seconds` the total
# capture length (launches + aftermath).
SCENARIOS = {
    # One small house, one rock: the smoke test and the fast iteration tape.
    "town-house": dict(seconds=40, scene="fractured-town.json", kind="house"),
    # The largest building, four rocks: few large bodies, big lever arms.
    "town-garage": dict(seconds=60, scene="fractured-town.json", kind="garage"),
    # Every building, 1-4 rocks each, then an aftermath: the whole-town case
    # the game is meant to support. Windows are labelled by awake count.
    "town-volley": dict(seconds=220, scene="fractured-town.json", kind="volley", aftermath=40),
    # Keep re-hitting until the awake count holds high: the 10k-body regime.
    "town-rain": dict(seconds=200, scene="fractured-town.json", kind="rain", aftermath=20),
}


def api(path: str, method: str = "GET", body=None, timeout=5.0):
    url = f"http://127.0.0.1:{API_PORT}{path}"
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def find_server_pid():
    """Only a process whose environment says it binds OUR api port."""
    # -f, not -x: a deployed copy is named web-fps-server-<stamp>, and comm is
    # truncated to 15 characters, so an exact match misses it.
    for pid in subprocess.run(["pgrep", "-f", "web-fps-server"], capture_output=True, text=True).stdout.split():
        if int(pid) == os.getpid():
            continue
        try:
            environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        except OSError:
            continue
        if f"BIND_ADDR=127.0.0.1:{API_PORT}".encode() in environ:
            return int(pid)
    return None


def kill_server():
    pid = find_server_pid()
    if pid is None:
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(50):
        if find_server_pid() is None:
            return
        time.sleep(0.1)
    os.kill(pid, signal.SIGKILL)


def server_env(scene: str, tape_dir: Path) -> dict:
    env = dict(os.environ)
    for name in list(env):
        if name.startswith(("VIBE_", "BLAST_", "PHYSX_")):
            del env[name]
    # Mirror scripts/physics-env.sh + vast-city.py for the native backend.
    sdk = os.environ.get("PHYSX_DESTRUCTION_SDK", "/root/workspace/physx-2")
    libdir = next((c for c in (f"{sdk}/bin/linux.x86_64/release", f"{sdk}/physx/bin/linux.x86_64/release")
                   if Path(c, "libPhysXGpuActivity_64.so").is_file()), None)
    if not libdir:
        raise RuntimeError(f"no PhysX GPU module under {sdk}")
    cuda = os.environ.get("CUDA_HOME", "/usr/local/cuda-12.8")
    env.update(
        BIND_ADDR=f"127.0.0.1:{API_PORT}",
        WEB_BIND_ADDR=f"0.0.0.0:{WEB_PORT}",
        WT_BIND_ADDR=f"0.0.0.0:{WT_PORT}",
        WT_PUBLIC_URL=f"https://127.0.0.1:{WT_PORT}",
        WT_CERT_PEM=str(CERT_DIR / "cert.pem"),
        WT_KEY_PEM=str(CERT_DIR / "key.pem"),
        WT_STRICT_SNAPSHOT_DATAGRAMS="1",
        VIBE_WEB_DIR=str(ROOT / "client" / "dist"),
        VIBE_PHYSICS_BACKEND="physx_gpu",
        VIBE_CITY_DESTRUCTION="native",
        VIBE_CITY_GRID="1",
        VIBE_CITY_SCENE=scene,
        VIBE_CITY_NATIVE_CORRECTION_LIMIT=os.environ.get("VIBE_CITY_NATIVE_CORRECTION_LIMIT", "2"),
        VIBE_CITY_TAPE_OUT=str(tape_dir),
        PHYSX_DESTRUCTION_SDK=sdk,
        PHYSX_LIB_DIR=libdir,
        CUDA_HOME=cuda,
        LD_LIBRARY_PATH=f"{cuda}/lib64:{libdir}",
        RUST_LOG=os.environ.get("RUST_LOG", "info"),
    )
    # GPU capacities for a city-scale collapse (physics-env.sh).
    env.setdefault("VIBE_PHYSX_GPU_COLLISION_STACK_SIZE", "536870912")
    env.setdefault("VIBE_PHYSX_GPU_HEAP_CAPACITY", "2147483648")
    env.setdefault("VIBE_PHYSX_GPU_MAX_RIGID_CONTACTS", "8388608")
    env.setdefault("VIBE_PHYSX_GPU_MAX_RIGID_PATCHES", "8388608")
    env.setdefault("VIBE_PHYSX_GPU_FOUND_LOST_PAIRS_CAPACITY", "4194304")
    for name in ("VIBE_CITY_CEILING_BYTES", "VIBE_CITY_MAX_EVAL", "VIBE_CITY_WIRE"):
        if name in os.environ:
            env[name] = os.environ[name]
    return env


def launch_server(scene: str, out: Path) -> subprocess.Popen:
    if find_server_pid() is not None:
        raise RuntimeError(f"a server is already bound to {API_PORT}; refusing to start another")
    binary = ROOT / "target" / "release" / "web-fps-server"
    log = open(out / "server.log", "w")
    process = subprocess.Popen(
        [str(binary)], cwd=ROOT, env=server_env(scene, out / "capture"),
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    for _ in range(300):
        time.sleep(0.2)
        if process.poll() is not None:
            raise RuntimeError(f"server exited early ({process.returncode}); see {out/'server.log'}")
        try:
            health = api("/healthz")
            if isinstance(health, dict) and health.get("status") == "ok":
                return process
        except Exception:
            continue
    raise RuntimeError("server never became healthy")


def buildings():
    return api("/city-buildings")


def launch_meteor(target):
    return api(f"/city-meteor/{MATCH}", "POST", {"x": target[0], "y": target[1], "z": target[2]})


def plan_launches(kind: str, blds, seconds: int, aftermath: int, rng):
    """Yield (at_second, target) launches, at most one per second."""
    blds = sorted(blds, key=lambda b: b["id"])
    if kind == "house":
        b = min(blds, key=lambda b: b["chunks"])
        return [(3.0, [b["centre"][0], b["top"], b["centre"][2]])]
    if kind == "garage":
        b = max(blds, key=lambda b: b["chunks"])
        return [(3.0 + i * 3.0, jitter(b, rng)) for i in range(4)]
    launches = []
    if kind in ("volley", "rain"):
        order = list(blds)
        rng.shuffle(order)
        t = 3.0
        for b in order:
            for _ in range(meteors_for(b["chunks"])):
                launches.append((t, jitter(b, rng)))
                t += 1.0
        if kind == "rain":
            # Keep raining until the window closes: round-robin re-hits.
            index = 0
            while t < seconds - aftermath:
                b = order[index % len(order)]
                launches.append((t, jitter(b, rng)))
                t += 1.0
                index += 1
        return [(at, target) for at, target in launches if at < seconds - aftermath]
    raise ValueError(kind)


def jitter(b, rng):
    r = b["radius"] * 0.5
    return [b["centre"][0] + rng.uniform(-r, r), b["top"], b["centre"][2] + rng.uniform(-r, r)]


def capture(args) -> int:
    import random
    scenario = SCENARIOS[args.scenario]
    out = Path(args.out) / (args.scenario + (f"-{args.tag}" if args.tag else ""))
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    print(f"[capture] {args.scenario}: {scenario['seconds']} s, {args.bots} bots -> {out}", flush=True)
    server = launch_server(scenario["scene"], out)
    bots = None
    try:
        # Bots first: their join creates the match, and the tape opens with it.
        bots = subprocess.Popen(
            [str(ROOT / "target/release/city-bots"), "--api", f"http://127.0.0.1:{API_PORT}",
             "--wt-port", str(WT_PORT), "--bots", str(args.bots), "--duration", str(scenario["seconds"] + 2),
             "--out", str(out / "bots"), "--profiles", args.profiles, "--seed", str(args.seed)],
            cwd=ROOT, stdout=open(out / "bots.log", "w"), stderr=subprocess.STDOUT,
        )
        for _ in range(100):
            time.sleep(0.2)
            try:
                api(f"/match-stats/{MATCH}")
                break
            except Exception:
                continue
        else:
            raise RuntimeError("match never appeared (no bot joined?)")
        rng = random.Random(args.seed)
        launches = plan_launches(scenario["kind"], buildings(), scenario["seconds"], scenario.get("aftermath", 0), rng)
        print(f"[capture] {len(launches)} meteors planned", flush=True)
        started = time.monotonic()
        stats_samples = []
        next_launch = 0
        while time.monotonic() - started < scenario["seconds"]:
            now = time.monotonic() - started
            while next_launch < len(launches) and launches[next_launch][0] <= now:
                try:
                    launch_meteor(launches[next_launch][1])
                except Exception as error:
                    print(f"[capture] meteor failed: {error}", flush=True)
                next_launch += 1
            if int(now) != int(now - 0.25):
                try:
                    stats = api(f"/match-stats/{MATCH}")
                    stats_samples.append((round(now, 1), stats))
                    city = stats.get("city") or {}
                    timings = stats.get("timings") or {}
                    total = (timings.get("total_ms") or {})
                    print(f"[capture] t={now:5.1f}s meteors {next_launch}/{len(launches)} players {stats.get('player_count')} awake {city.get('awake_bodies')} broken {city.get('broken_bonds')} tick_ms p50 {total.get('p50')} p95 {total.get('p95')} city_ms {city.get('step_ms')}", flush=True)
                except Exception:
                    pass
            time.sleep(0.25)
        print("[capture] stopping capture", flush=True)
        api(f"/city-capture-stop/{MATCH}", "POST")
        time.sleep(1.0)
        (out / "match-stats.json").write_text(json.dumps(stats_samples))
    finally:
        if bots is not None:
            try:
                bots.wait(timeout=30)
            except subprocess.TimeoutExpired:
                bots.kill()
        kill_server()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
    return validate(out / "capture", args.bots)


def validate(capture_dir: Path, bots: int) -> int:
    meta = json.loads((capture_dir / "capture.json").read_text())
    ok = True
    def check(cond, what):
        nonlocal ok
        print(f"[validate] {'ok  ' if cond else 'FAIL'} {what}", flush=True)
        ok = ok and cond
    check(meta["backend"] == "native", f"backend {meta['backend']}")
    check(meta["dropped_ticks"] == 0, f"dropped ticks {meta['dropped_ticks']}")
    check(meta["first_tick"] is not None and meta["ticks"] == meta["last_tick"] - meta["first_tick"] + 1,
          f"ticks {meta['ticks']} == {meta['last_tick']} - {meta['first_tick']} + 1")
    cameras = (capture_dir / "cameras.jsonl").read_text().splitlines()
    events = [json.loads(l) for l in (capture_dir / "events.jsonl").read_text().splitlines() if l.strip()]
    meteors = [e for e in events if e.get("kind") == "meteor"]
    joins = [e for e in events if e.get("kind") == "join"]
    check(len(cameras) > 0, f"{len(cameras)} camera samples")
    check(len(joins) >= bots, f"{len(joins)} joins for {bots} bots")
    check(len(meteors) > 0, f"{len(meteors)} meteors")
    size = (capture_dir / "encoder.tape").stat().st_size
    print(f"[validate] tape {size/1e6:.1f} MB, {meta['ticks']} ticks at {meta['hz']} Hz")
    return 0 if ok else 1


# --- replay: the whole netcode, headlessly --------------------------------------

REPLAY_PROFILES = "none,wifi-good,wifi-bad,lte"


def awake_windows(capture_dir: Path, hz: int):
    """Windows of the tape labelled by how many bodies were awake.

    `all` is the whole tape. `1k`/`5k`/`10k` are the rising spans between
    those awake counts (up to the peak), `aftermath` the last 60 s. A window
    that the tape never reaches is absent, so a scenario that peaked at 3k
    bodies has no `5k` row rather than an empty one."""
    rows = [json.loads(l) for l in (capture_dir / "stats.jsonl").read_text().splitlines() if l.strip()]
    if not rows:
        return {}
    first, last = rows[0]["tick"], rows[-1]["tick"]
    windows = {"all": (first, last)}
    peak_index = max(range(len(rows)), key=lambda i: rows[i]["awake"])
    levels = [(1000, "1k"), (5000, "5k"), (10000, "10k")]
    for index, (level, name) in enumerate(levels):
        start = next((r["tick"] for r in rows[: peak_index + 1] if r["awake"] >= level), None)
        if start is None:
            continue
        nxt = next((r["tick"] for r in rows[: peak_index + 1] if index + 1 < len(levels) and r["awake"] >= levels[index + 1][0]), None)
        end = nxt if nxt is not None else last
        if end - start >= hz * 5:
            windows[name] = (start, end)
    if last - first > hz * 90:
        windows["aftermath"] = (last - hz * 60, last)
    return windows


def run_replay(args) -> int:
    capture_dir = Path(args.captures) / args.scenario / "capture"
    if not capture_dir.is_dir():
        # A bare downtown tape from scenarios.py.
        raise SystemExit(f"no capture at {capture_dir}")
    meta = json.loads((capture_dir / "capture.json").read_text())
    out = Path(args.out) / args.scenario
    out.mkdir(parents=True, exist_ok=True)
    windows = awake_windows(capture_dir, meta["hz"])
    print(f"[replay] {args.scenario}: windows {windows}", flush=True)
    summary = {"scenario": args.scenario, "capture": str(capture_dir), "manifest_hash": meta["manifest_hash"],
               "backend": meta["backend"], "windows": windows, "runs": {}}
    knob_args = []
    for name in ("ceiling-bytes", "max-eval", "send-hz", "error-budget-px"):
        value = getattr(args, name.replace("-", "_"), None)
        if value is not None:
            knob_args += [f"--{name}", str(value)]
    for count in [int(c) for c in args.clients.split(",")]:
        run_dir = out / f"clients-{count}"
        if run_dir.exists():
            shutil.rmtree(run_dir)
        cmd = [str(ROOT / "target/release/netlab-replay"), "--capture", str(capture_dir), "--out", str(run_dir),
               "--clients", str(count), "--profiles", args.profiles, "--seed", str(args.seed), "--sample", str(args.sample)] + knob_args
        if args.check_stable:
            cmd.append("--check-stable")
        started = time.monotonic()
        result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        (run_dir / "replay.log").write_text(result.stdout + result.stderr)
        if result.returncode != 0:
            print(result.stdout[-2000:], result.stderr[-2000:])
            raise SystemExit(f"netlab-replay failed for {count} clients")
        report = json.loads((run_dir / "replay.json").read_text())
        print(f"[replay] {count} clients: per-send ms p50 {report['per_send_ms']['p50']:.2f} p95 {report['per_send_ms']['p95']:.2f} max {report['per_send_ms']['max']:.2f} | egress {report['egress_mbps_total']:.1f} Mbps | {time.monotonic()-started:.1f} s", flush=True)
        run = {"replay": {k: report[k] for k in ("encode_send_ms", "client_datagrams_total_ms", "per_send_ms",
                                                    "reliable_bytes_per_client", "egress_bytes_total", "egress_mbps_total",
                                                    "peak_awake", "mean_awake", "sends", "ticks", "seconds", "ceiling_bytes")},
               "clients": {}}
        sampled = [c for c in report["clients"] if Path(c["dir"]).is_dir()][: args.sample]
        for client in sampled:
            cdir = Path(client["dir"])
            presented = cdir / "presented.bin"
            profile = client["spec"]["profile"]
            ts_cmd = ["npx", "tsx", "tools/replay-city-client.mts", "--packets", str(cdir), "--manifest",
                      str(capture_dir / "manifest.json"), "--bodies-out", str(presented), "--frame-hz", str(args.frame_hz)]
            if profile != "none":
                ts_cmd += ["--impair", profile]
            started = time.monotonic()
            result = subprocess.run(ts_cmd, cwd=ROOT / "client", capture_output=True, text=True)
            (cdir / "ts-replay.log").write_text(result.stdout + result.stderr)
            if result.returncode != 0:
                print(result.stdout[-1500:], result.stderr[-1500:])
                raise SystemExit(f"TS replay failed for client {client['id']}")
            ts_seconds = time.monotonic() - started
            ts_stats = json.loads((str(presented) + ".stats.json") and Path(str(presented) + ".stats.json").read_text())
            entry = {"spec": client["spec"], "bytes": {k: client[k] for k in ("pose_bytes", "reliable_bytes", "datagrams", "records", "pose_mbps", "reliable_mbps")},
                     "datagrams_ms": client["datagrams_ms"], "audit": client.get("audit"),
                     "client_cpu": {"sample_ms": ts_stats["sampleMsPerFrame"], "avg_ms_per_second": ts_stats["clientMsAvgPerSecond"]},
                     "client_stats": {k: ts_stats["stats"].get(k) for k in ("correctionSnaps", "clockRollbacks", "implausibleJumps",
                                                                            "presentedJumpsOver1m", "presentedJumpsOver4m", "sampleDelayTicks",
                                                                            "arrivalLatenessPeakTicks", "starvedReadmissions", "topoSeqGaps", "orphanedChunks")},
                     "windows": {}}
            for name, (wfrom, wto) in windows.items():
                score_path = cdir / f"score-{name}.json"
                cmd = [str(ROOT / "target/release/netlab-score"), "--capture", str(capture_dir), "--presented", str(presented),
                       "--client-meta", str(cdir / "meta.json"), "--window", f"{wfrom},{wto}", "--gravity", str(args.gravity),
                       "--out", str(score_path), "--md", str(cdir / f"score-{name}.md")]
                result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
                if result.returncode != 0:
                    print(result.stdout[-1500:], result.stderr[-1500:])
                    raise SystemExit(f"netlab-score failed for client {client['id']} window {name}")
                card = json.loads(score_path.read_text())
                entry["windows"][name] = card
                o = card["overall"]
                print(f"[score] c{count} {client['id']:>6} {client['spec']['camera']['kind']:<7} {profile:<9} {name:<9} lever p95 {o['lever_m']['p95']:.3f} p99 {o['lever_m']['p99']:.3f} | px p95 {o['pixel']['p95']:.1f} >2px {o['pixel_over_budget']*100:.1f}% | freeze {o['gates']['freeze']:.0f} rev {o['gates']['reversal']:.0f} tele {o['gates']['teleport']:.0f} grav {o['gates']['gravity']:.0f} | missing {card['missing_moving_weight']:.0f} | ts {ts_seconds:.0f}s", flush=True)
            run["clients"][str(client["id"])] = entry
            if not args.keep_presented:
                presented.unlink(missing_ok=True)
        summary["runs"][str(count)] = run
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(f"[replay] wrote {out / 'summary.json'}")
    return 0


# --- compare: baseline vs candidate ---------------------------------------------

# (path into a client-window scorecard, label, direction: -1 lower is better)
FIDELITY_METRICS = [
    (("overall", "lever_m", "p95"), "lever p95 m", -1, 0.02),
    (("overall", "lever_m", "p99"), "lever p99 m", -1, 0.02),
    (("overall", "pixel", "p95"), "px p95", -1, 0.02),
    (("overall", "pixel_over_budget"), ">2px frac", -1, 0.02),
    (("overall", "gates", "freeze"), "freeze", -1, 0.05),
    (("overall", "gates", "reversal"), "reversal", -1, 0.05),
    (("overall", "gates", "teleport"), "teleport", -1, 0.05),
    (("overall", "gates", "gravity"), "gravity", -1, 0.05),
    (("missing_moving_weight",), "missing", -1, 0.05),
    (("settle_lever_m", "p95"), "settle p95 m", -1, 0.02),
]
GATE_ABS_FLOOR = 20.0


def dig(d, path):
    for key in path:
        if d is None:
            return None
        d = d.get(key)
    return d


def compare(args) -> int:
    base = json.loads(Path(args.baseline).read_text())
    cand = json.loads(Path(args.candidate).read_text())
    if base.get("manifest_hash") != cand.get("manifest_hash") or base.get("backend") != cand.get("backend"):
        raise SystemExit("refusing to compare different manifests/backends")
    regressions, improvements, lines = [], [], []
    for count, brun in base["runs"].items():
        crun = cand["runs"].get(count)
        if not crun:
            continue
        # Server cost and bytes.
        for path, label, tol in ((("per_send_ms", "p95"), "encode/send p95 ms", 0.10), (("per_send_ms", "p50"), "encode/send p50 ms", 0.10),
                                 (("egress_mbps_total",), "egress Mbps", 0.03)):
            b, c = dig(brun["replay"], path), dig(crun["replay"], path)
            if b is None or c is None:
                continue
            delta = (c - b) / b if b else 0.0
            tag = ""
            if delta > tol and (c - b) > 0.05:
                tag = "REGRESSION"; regressions.append(f"c{count} {label} {b:.3f}->{c:.3f} (+{delta*100:.1f}%)")
            elif delta < -tol:
                tag = "better"; improvements.append(f"c{count} {label} {b:.3f}->{c:.3f} ({delta*100:.1f}%)")
            lines.append(f"c{count:<4} {label:<22} {b:10.3f} -> {c:10.3f} {delta*100:+7.1f}% {tag}")
        for client_id, bclient in brun["clients"].items():
            cclient = crun["clients"].get(client_id)
            if not cclient:
                continue
            for window, bcard in bclient["windows"].items():
                ccard = cclient["windows"].get(window)
                if not ccard:
                    continue
                for path, label, direction, tol in FIDELITY_METRICS:
                    b, c = dig(bcard, path), dig(ccard, path)
                    if b is None or c is None:
                        continue
                    is_gate = path[-1] in ("freeze", "reversal", "teleport", "gravity") or path[0] == "missing_moving_weight"
                    delta = (c - b) / b if b else (1.0 if c > 0 else 0.0)
                    worse = c > b * (1 + tol) and (not is_gate or (c - b) > GATE_ABS_FLOOR or b == 0 and c > GATE_ABS_FLOOR)
                    better = c < b * (1 - tol) and (not is_gate or (b - c) > GATE_ABS_FLOOR)
                    tag = ""
                    key = f"c{count} {client_id} {window} {label}"
                    if worse:
                        tag = "REGRESSION"; regressions.append(f"{key} {b:.3f}->{c:.3f}")
                    elif better:
                        tag = "better"; improvements.append(f"{key} {b:.3f}->{c:.3f}")
                    if tag or args.verbose:
                        lines.append(f"c{count:<4} {client_id:>6} {window:<9} {label:<14} {b:10.3f} -> {c:10.3f} {delta*100:+7.1f}% {tag}")
    print("\n".join(lines))
    print(f"\n{len(improvements)} better, {len(regressions)} regressions")
    if regressions:
        print("REGRESSIONS:\n  " + "\n  ".join(regressions[:40]))
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("capture")
    c.add_argument("scenario", choices=sorted(SCENARIOS))
    c.add_argument("--bots", type=int, default=10)
    c.add_argument("--profiles", default="wifi-good:40,wifi-bad:30,lte:20,loss-burst:10")
    c.add_argument("--seed", type=int, default=1)
    c.add_argument("--tag", default="", help="suffix for the output directory (e.g. bots100)")
    c.add_argument("--out", default=str(DEFAULT_OUT))
    v = sub.add_parser("validate")
    v.add_argument("dir")
    v.add_argument("--bots", type=int, default=0)
    r = sub.add_parser("replay")
    r.add_argument("scenario")
    r.add_argument("--captures", default=str(DEFAULT_OUT))
    r.add_argument("--out", required=True, help="results directory (e.g. /dev/shm/netlab/runs/baseline)")
    r.add_argument("--clients", default="10,50,100")
    r.add_argument("--sample", type=int, default=8)
    r.add_argument("--profiles", default=REPLAY_PROFILES)
    r.add_argument("--seed", type=int, default=1)
    r.add_argument("--frame-hz", type=int, default=60)
    r.add_argument("--gravity", type=float, default=9.81)
    r.add_argument("--ceiling-bytes", type=int)
    r.add_argument("--max-eval", type=int)
    r.add_argument("--send-hz", type=int)
    r.add_argument("--error-budget-px", type=float)
    r.add_argument("--check-stable", action="store_true")
    r.add_argument("--keep-presented", action="store_true")
    cmp = sub.add_parser("compare")
    cmp.add_argument("--baseline", required=True, help="summary.json")
    cmp.add_argument("--candidate", required=True, help="summary.json")
    cmp.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.command == "capture":
        return capture(args)
    if args.command == "validate":
        return validate(Path(args.dir), args.bots)
    if args.command == "replay":
        return run_replay(args)
    if args.command == "compare":
        return compare(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
