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
    out = Path(args.out) / args.scenario
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("capture")
    c.add_argument("scenario", choices=sorted(SCENARIOS))
    c.add_argument("--bots", type=int, default=10)
    c.add_argument("--profiles", default="wifi-good:40,wifi-bad:30,lte:20,loss-burst:10")
    c.add_argument("--seed", type=int, default=1)
    c.add_argument("--out", default=str(DEFAULT_OUT))
    v = sub.add_parser("validate")
    v.add_argument("dir")
    v.add_argument("--bots", type=int, default=0)
    args = parser.parse_args()
    if args.command == "capture":
        return capture(args)
    if args.command == "validate":
        return validate(Path(args.dir), args.bots)
    return 2


if __name__ == "__main__":
    sys.exit(main())
