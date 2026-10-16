#!/usr/bin/env python3
"""Record destruction truth for the netcode lab from a declarative scenario.

    scripts/netlab/record-truth.py record scenarios/netcode/wedge.json --out DIR
    scripts/netlab/record-truth.py validate DIR            # re-check a recording
    scripts/netlab/record-truth.py plan scenarios/netcode/wedge.json \
        [--manifest DIR/capture/manifest.json]             # print what would run

"Record the physics once, replay the netcode many times": `netlab2 city`
replays a city capture (the encoder tape plus its sidecars) through any
replication strategy. This writes that capture from the live server, so the
truth is what players get, on this tree:

1. picks a free HTTP (TCP) + WebTransport (UDP) port pair, never one of the
   ports other sessions own (RESERVED_PORTS);
2. starts the native-destruction server under the machine's GPU admission
   (scripts/perf/gpu-run.sh, VIBE_GPU_SHARED=1: a correctness run, not a
   timing run) with VIBE_CITY_TAPE_OUT=<out>/capture;
3. joins ONE city-bots bot, parked well outside the city, so the match
   exists (a city match is created by its first join);
4. fires the scenario's events over HTTP on schedule (/city-demolish,
   /city-meteor), relative to t0 = match up + warmup_s;
5. waits out duration_s plus settle_s, POSTs /city-capture-stop/<match>,
   waits for capture.json to be finalised, then stops the server BY PORT;
6. validates: dropped_ticks == 0, ticks > 0, fracture batches in the tape.

Outputs <out>/capture (the lab's input), <out>/record.json (scenario, git
HEAD, binaries, healthz, ports, environment, timings, validation) and the
logs (<out>/server.log, <out>/bot.log, <out>/bot/).

Scenario file (scenarios/netcode/<name>.json):

    {
      "name": "wedge",
      "description": "...",
      "match": "city-default",                 # optional, default city-default
      "server_env": {"VIBE_CITY_SCENE": "high-rise-3f-local.json"},
      "seed": 1,                               # -> VIBE_MATCH_SEED
      "warmup_s": 3, "duration_s": 30, "settle_s": 15,
      "bot": {"centre": [0, 0], "radius": 150, "seed": 1},
      "events": [
        {"t_s": 2.0, "kind": "demolish", "tallest": true, "radius_m": 40, ...},
        {"t_s": 2.0, "kind": "demolish", "footprint": {"rank": 1, "count": 3,
                                                      "spacing_m": 72}, ...},
        {"t_s": 1.0, "kind": "meteor", "target": [x, y, z]},
        {"t_s": 1.5, "kind": "meteor", "structure": 6}
      ]
    }

A demolish event's other fields are the /city-demolish body verbatim
(DemolishRequest in server/src/main.rs: x, z, tallest, radius_m, below_y,
rounds, wedge_deg, heading_deg, jitter, per_tick). `footprint` picks the
rank-th of the `count` tallest 8 m cells no two within `spacing_m`, the same
ranking `record-city-trace --demolish-buildings` uses
(destruction::demolition::tallest_footprints), read from the capture's own
manifest.json. A meteor event takes `target` [x, y, z], `targets` [[x, y, z],
...] (released one per tick), or `structure` (that structure's roof centre).

GPU rules this follows: one GPU job (the server, under gpu-run.sh) at a time;
every wait is bounded and PID- or port-based (never pgrep); the server is
stopped with `kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`. If the server or the
bot dies unexpectedly the recording stops and reports; it never relaunches.
"""
import argparse
import hashlib
import io
import json
import math
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The GPU admission is machine-wide only through the main checkout's copy.
MAIN_CHECKOUT = Path("/Users/glavin/Development/vibe-land")
GPU_RUN = MAIN_CHECKOUT / "scripts/perf/gpu-run.sh"
CUMETAL_CACHE_DIR = MAIN_CHECKOUT / "target/cumetal-cache"

# Spoken for by other sessions on this Mac: the owner's play session
# (4001/4002/3003), city-bench (4301/4302/3303), the rest soak
# (6401/6402/3643), Netlab v2 recording (4501/4502/3503).
RESERVED_PORTS = {4001, 4002, 3003, 4301, 4302, 3303, 6401, 6402, 3643, 4501, 4502, 3503}
DEFAULT_PORT_BASE = 6930

# Server environment the recorder owns. Inherited copies are dropped so a
# variable left in the caller's shell cannot silently change the truth.
OWNED_ENV_PREFIXES = ("VIBE_", "WT_", "CUMETAL_")
OWNED_ENV_KEYS = {"BIND_ADDR", "WEB_BIND_ADDR", "RUST_LOG", "SKIP_SPACETIMEDB_VERIFY"}


def log(message: str) -> None:
    print(f"[record-truth {time.strftime('%H:%M:%S')}] {message}", flush=True)


class RecordError(RuntimeError):
    pass


# ── scenario ────────────────────────────────────────────────────────────────

def load_scenario(path: Path) -> dict:
    scenario = json.loads(path.read_text())
    for key in ("name", "duration_s", "events"):
        if key not in scenario:
            raise RecordError(f"{path}: scenario needs '{key}'")
    scenario.setdefault("match", "city-default")
    scenario.setdefault("server_env", {})
    scenario.setdefault("seed", 1)
    scenario.setdefault("warmup_s", 3.0)
    scenario.setdefault("settle_s", 15.0)
    scenario.setdefault("bot", {})
    for event in scenario["events"]:
        if event.get("kind") not in ("demolish", "meteor"):
            raise RecordError(f"{path}: event kind must be demolish or meteor: {event}")
        if not isinstance(event.get("t_s"), (int, float)) or event["t_s"] < 0:
            raise RecordError(f"{path}: event needs t_s >= 0: {event}")
        if event["t_s"] > scenario["duration_s"]:
            raise RecordError(f"{path}: event at {event['t_s']} s is past duration_s")
    return scenario


# ── manifest geometry (ports of destruction::demolition / buildings) ──────

FOOTPRINT_CELL_M = 8.0


def manifest_points(manifest: dict):
    """(structure id, world x, y, z, radius) for every chunk, axis-aligned
    placement as /city-demolish assumes."""
    out = []
    for structure in manifest["structures"]:
        wp = structure.get("worldPosition") or structure.get("world_position")
        sid = structure.get("structureId", structure.get("structure_id"))
        for chunk in structure["chunks"]:
            c = chunk["centroid"]
            out.append((sid, wp[0] + c[0], wp[1] + c[1], wp[2] + c[2], chunk.get("radius", 0.0)))
    return out


def tallest_footprints(points, count: int, spacing_m: float):
    """destruction::demolition::tallest_footprints: the `count` tallest 8 m
    XZ cells, tallest first (ties by cell x then z), no two within spacing."""
    cells = {}
    for _, x, y, z, _ in points:
        key = (math.floor(x / FOOTPRINT_CELL_M), math.floor(z / FOOTPRINT_CELL_M))
        lo, hi = cells.get(key, (math.inf, -math.inf))
        cells[key] = (min(lo, y), max(hi, y))
    ranked = sorted(((key, hi - lo) for key, (lo, hi) in cells.items()),
                    key=lambda item: (-item[1], item[0][0], item[0][1]))
    chosen = []
    for key, extent in ranked:
        if len(chosen) >= count:
            break
        centre = ((key[0] + 0.5) * FOOTPRINT_CELL_M, (key[1] + 0.5) * FOOTPRINT_CELL_M)
        if all((centre[0] - o[0]) ** 2 + (centre[1] - o[1]) ** 2 >= spacing_m * spacing_m
               for o, _ in chosen):
            chosen.append((centre, extent))
    return chosen


def structure_roof(points, structure_id):
    """Footprint centre and roof height of one structure, world space."""
    mine = [p for p in points if p[0] == structure_id]
    if not mine:
        raise RecordError(f"no structure {structure_id} in the manifest")
    xs = [p[1] for p in mine]
    zs = [p[3] for p in mine]
    top = max(p[2] + p[4] for p in mine)
    return [round((min(xs) + max(xs)) / 2, 3), round(top, 3), round((min(zs) + max(zs)) / 2, 3)]


def resolve_event(event: dict, points) -> dict:
    """The HTTP body for one scenario event, plus what was resolved."""
    body = {k: v for k, v in event.items() if k not in ("t_s", "kind", "footprint", "structure",
                                                         "target", "note")}
    resolved = {}
    if event["kind"] == "demolish":
        if "footprint" in event:
            if points is None:
                return {"body": None, "resolved": {"footprint": "needs the manifest"}}
            spec = event["footprint"]
            count = int(spec.get("count", spec["rank"] + 1))
            chosen = tallest_footprints(points, count, float(spec.get("spacing_m", 0.0)))
            if spec["rank"] >= len(chosen):
                raise RecordError(f"footprint rank {spec['rank']}: only {len(chosen)} cells "
                                  f"are {spec.get('spacing_m', 0)} m apart")
            (x, z), extent = chosen[spec["rank"]]
            body["x"], body["z"] = x, z
            body["tallest"] = False
            resolved = {"footprint": [x, z], "extent_m": round(extent, 3)}
        elif event.get("tallest") and points is not None:
            # The server ranks in f32; this is the same rule in f64, for the record.
            (x, z), extent = tallest_footprints(points, 1, 0.0)[0]
            resolved = {"tallest_footprint": [x, z], "extent_m": round(extent, 3)}
    else:
        if "structure" in event:
            if points is None:
                return {"body": None, "resolved": {"structure": "needs the manifest"}}
            target = structure_roof(points, event["structure"])
            body.update({"x": target[0], "y": target[1], "z": target[2]})
            resolved = {"structure": event["structure"], "target": target}
        elif "target" in event:
            x, y, z = event["target"]
            body.update({"x": x, "y": y, "z": z})
        elif "targets" not in event:
            raise RecordError(f"meteor event needs target, targets or structure: {event}")
    return {"body": body, "resolved": resolved}


# ── processes, ports, HTTP ─────────────────────────────────────────────────

def port_in_use(port: int) -> bool:
    tcp = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                         capture_output=True, text=True).stdout.strip()
    udp = subprocess.run(["lsof", "-nP", f"-iUDP:{port}"],
                         capture_output=True, text=True).stdout.strip()
    if tcp or udp:
        return True
    # lsof only sees this user's sockets; a bind test catches the rest.
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        with socket.socket(socket.AF_INET, kind) as sock:
            try:
                sock.bind(("0.0.0.0", port))
            except OSError:
                return True
    return False


def pick_ports(base: int):
    """Two adjacent free ports (HTTP TCP, WebTransport UDP), none reserved."""
    for http in range(base, base + 200, 2):
        pair = (http, http + 1)
        if any(p in RESERVED_PORTS for p in pair):
            continue
        if not any(port_in_use(p) for p in pair):
            return pair
    raise RecordError(f"no free port pair in {base}..{base + 200}")


def http(method: str, url: str, body=None, timeout: float = 5.0):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode(errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors="replace")
    except (urllib.error.URLError, ConnectionError, socket.timeout, TimeoutError) as error:
        return None, str(error)


def server_tick(api: str, match: str):
    status, text = http("GET", f"{api}/match-stats/{match}/tick", timeout=3.0)
    if status == 200:
        try:
            return int(text.strip())
        except ValueError:
            return None
    return None


def listener_pids(port: int):
    out = subprocess.run(["lsof", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
                         capture_output=True, text=True).stdout.split()
    return [int(pid) for pid in out if pid.isdigit()]


def stop_server_by_port(port: int) -> list:
    """`kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`: only the process serving
    this recording's port, never a match on the binary's name."""
    pids = listener_pids(port)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    return pids


def wait_child(process: subprocess.Popen, limit_s: float) -> bool:
    """Bounded wait on our own child by PID (reaps it, so no zombie keeps
    `kill -0` true). True if it exited within the limit."""
    try:
        process.wait(timeout=limit_s)
        return True
    except subprocess.TimeoutExpired:
        return False


def git_head():
    def run(*args):
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    return {
        "head": run("rev-parse", "HEAD"),
        "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(run("status", "--porcelain", "--untracked-files=no")),
        "subject": run("log", "-1", "--format=%s")[:200],
    }


def file_identity(path: Path):
    if not path.exists():
        return {"path": str(path), "exists": False}
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    stat = path.stat()
    return {"path": str(path), "sha256": digest.hexdigest(), "bytes": stat.st_size,
            "mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime))}


# ── tape summary (destruction/src/netlab/tape.rs, VLTAPE02) ─────────────────

SNAPSHOT_BYTES = 4 + 12 + 16 + 12 + 12 + 2 + 1
PROMOTION_FLOATS = 1 + 3 + 3 + 3 + 4 + 3 + 3 + 3


class _Stream:
    def __init__(self, raw):
        self.raw = raw

    def take(self, n: int) -> bytes:
        data = self.raw.read(n)
        if len(data) != n:
            raise EOFError(f"short read: wanted {n}, got {len(data)}")
        return data

    def skip(self, n: int) -> None:
        while n > 0:
            chunk = self.raw.read(min(n, 1 << 20))
            if not chunk:
                raise EOFError("short skip")
            n -= len(chunk)

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]


def summarize_tape(path: Path) -> dict:
    """Ticks, bodies and fracture activity in an encoder tape. Streams it
    through `zstd -dc` when it is zstd-framed (live captures are)."""
    with path.open("rb") as handle:
        zstd_framed = handle.read(4) == b"\x28\xb5\x2f\xfd"
    process = None
    if zstd_framed:
        process = subprocess.Popen(["zstd", "-dcq", str(path)], stdout=subprocess.PIPE)
        raw = io.BufferedReader(process.stdout, buffer_size=1 << 22)
    else:
        raw = path.open("rb")
    s = _Stream(raw)
    try:
        if s.take(8) != b"VLTAPE02":
            raise RecordError(f"{path}: not a VLTAPE02 tape")
        hz = s.u32()
        s.skip(32 + 7 * 4)
        ticks = 0
        first = last = None
        batches = broken = promoted = retired = migrations = settles = wakes = 0
        fracture_ticks = 0
        max_snapshots = 0
        snapshot_sum = 0
        structures = Counter()
        promoted_chunks = 0
        while True:
            head = raw.read(4)
            if not head:
                break
            if len(head) != 4:
                raise RecordError(f"{path}: truncated tick header")
            tick = struct.unpack("<I", head)[0]
            first = tick if first is None else first
            last = tick
            ticks += 1
            count = s.u32()
            max_snapshots = max(max_snapshots, count)
            snapshot_sum += count
            s.skip(count * SNAPSHOT_BYTES)
            batch_count = s.u32()
            if batch_count:
                fracture_ticks += 1
            batches += batch_count
            for _ in range(batch_count):
                structures[s.u32()] += 1
                n = s.u32(); broken += n; s.skip(4 * n)
                n = s.u32(); migrations += n; s.skip(12 * n)
                n = s.u32(); promoted += n
                for _ in range(n):
                    s.skip(8)
                    chunks = s.u32(); promoted_chunks += chunks
                    s.skip(4 * chunks + 4 * PROMOTION_FLOATS)
                n = s.u32(); retired += n; s.skip(4 * n)
            n = s.u32(); settles += n; s.skip(36 * n)
            n = s.u32(); wakes += n; s.skip(8 * n)
    finally:
        if process is not None:
            process.stdout.close()
            process.wait(timeout=60)
        elif hasattr(raw, "close"):
            raw.close()
    return {
        "hz": hz, "ticks": ticks, "first_tick": first, "last_tick": last,
        "fracture_batches": batches, "fracture_ticks": fracture_ticks,
        "broken_bonds": broken, "promoted_islands": promoted,
        "promoted_chunks": promoted_chunks, "retired_islands": retired,
        "migrations": migrations, "settles": settles, "wakes": wakes,
        "max_bodies_per_tick": max_snapshots,
        "mean_bodies_per_tick": round(snapshot_sum / ticks, 1) if ticks else 0,
        "structures_fractured": dict(sorted(structures.items())),
    }


def validate(out: Path) -> dict:
    capture = out / "capture"
    meta_path = capture / "capture.json"
    problems = []
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    if not meta:
        problems.append("no capture.json")
    for name in ("encoder.tape", "manifest.json", "cameras.jsonl", "events.jsonl", "stats.jsonl",
                 "encoder-checkpoint.json.zst"):
        if not (capture / name).exists():
            problems.append(f"missing {name}")
    if meta.get("dropped_ticks", 1) != 0:
        problems.append(f"dropped_ticks = {meta.get('dropped_ticks')}")
    if not meta.get("ticks"):
        problems.append("ticks = 0 (capture not finalised?)")
    tape = summarize_tape(capture / "encoder.tape") if (capture / "encoder.tape").exists() else {}
    if tape and tape["ticks"] != meta.get("ticks"):
        problems.append(f"tape holds {tape['ticks']} ticks, capture.json says {meta.get('ticks')}")
    if tape and tape["fracture_batches"] == 0:
        problems.append("no fracture batches in the tape")
    events = []
    if (capture / "events.jsonl").exists():
        for line in (capture / "events.jsonl").read_text().splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                problems.append("unparseable events.jsonl line")
    cameras = (capture / "cameras.jsonl").read_text().splitlines() if (capture / "cameras.jsonl").exists() else []
    return {
        "ok": not problems,
        "problems": problems,
        "capture_meta": {k: meta.get(k) for k in ("hz", "scene", "backend", "wire", "manifest_hash",
                                                  "first_tick", "last_tick", "ticks", "dropped_ticks")},
        "tape": tape,
        "events_by_kind": dict(Counter(e.get("kind", "?") for e in events)),
        "server_events": [e for e in events if e.get("kind") in ("demolish", "meteor")][:64],
        "camera_samples": len(cameras),
        "bytes": {name: (capture / name).stat().st_size for name in
                  ("encoder.tape", "manifest.json", "cameras.jsonl", "events.jsonl", "stats.jsonl")
                  if (capture / name).exists()},
    }


# ── recording ───────────────────────────────────────────────────────────────

def server_environment(scenario: dict, out: Path, http_port: int, wt_port: int) -> dict:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(OWNED_ENV_PREFIXES) and k not in OWNED_ENV_KEYS}
    owned = {
        "BIND_ADDR": f"127.0.0.1:{http_port}",
        "WT_BIND_ADDR": f"0.0.0.0:{wt_port}",
        "WT_HOST": "127.0.0.1",
        "WEB_BIND_ADDR": "",
        "SKIP_SPACETIMEDB_VERIFY": "1",
        "RUST_LOG": "info",
        "VIBE_PHYSICS_BACKEND": "physx_gpu",
        "CUMETAL_CACHE_DIR": str(CUMETAL_CACHE_DIR),
        "VIBE_CITY_TAPE_OUT": str(out / "capture"),
        "VIBE_DEBUG_REPORTS_DIR": str(out / "debug-reports"),
        "VIBE_MATCH_SEED": str(int(scenario["seed"])),
    }
    owned.update({k: str(v) for k, v in scenario["server_env"].items()})
    env.update(owned)
    env["VIBE_GPU_SHARED"] = "1"
    return env, owned


def record(args) -> int:
    scenario_path = Path(args.scenario).resolve()
    scenario = load_scenario(scenario_path)
    name = scenario["name"]
    out = Path(args.out or ROOT / "target/netcode-truth" / name).resolve()
    if (out / "capture").exists() or (out / "record.json").exists():
        if not args.force:
            raise RecordError(f"{out} already holds a recording; pass --force to move it aside")
        aside = out.with_name(out.name + time.strftime(".prev-%Y%m%d-%H%M%S"))
        out.rename(aside)
        log(f"moved the previous recording to {aside}")
    out.mkdir(parents=True, exist_ok=True)

    server_bin = Path(args.bin).resolve()
    bots_bin = Path(args.bots_bin).resolve()
    for binary in (server_bin, bots_bin):
        if not binary.is_file():
            raise RecordError(f"missing binary {binary}")
    if not GPU_RUN.is_file():
        raise RecordError(f"missing {GPU_RUN}")

    match = scenario["match"]
    http_port, wt_port = (args.http_port, args.http_port + 1) if args.http_port else pick_ports(args.port_base)
    if args.http_port and any(p in RESERVED_PORTS or port_in_use(p) for p in (http_port, wt_port)):
        raise RecordError(f"ports {http_port}/{wt_port} are reserved or in use")
    api = f"http://127.0.0.1:{http_port}"
    env, owned_env = server_environment(scenario, out, http_port, wt_port)
    label = f"truth-{name}"

    record_doc = {
        "scenario_file": str(scenario_path),
        "scenario": scenario,
        "git": git_head(),
        "server_binary": file_identity(server_bin),
        "bots_binary": file_identity(bots_bin),
        "ports": {"http": http_port, "webtransport": wt_port},
        "server_env": owned_env,
        "gpu": {"admission": str(GPU_RUN), "label": label, "shared": True},
        "timings": {},
        "events_fired": [],
    }
    timings = record_doc["timings"]
    started = time.time()

    def mark(key):
        timings[key] = round(time.time() - started, 3)

    def write_record():
        (out / "record.json").write_text(json.dumps(record_doc, indent=2) + "\n")

    server = bot = None
    server_log = (out / "server.log").open("w")
    bot_log = None
    failure = None
    try:
        log(f"{name}: ports http {http_port} / wt {wt_port}; out {out}")
        log(f"starting the server under {GPU_RUN.name} ({label}, shared slot)")
        server = subprocess.Popen(
            [str(GPU_RUN), label, str(server_bin)],
            cwd=ROOT, env=env, stdout=server_log, stderr=subprocess.STDOUT,
            start_new_session=True)
        record_doc["server_wrapper_pid"] = server.pid
        mark("server_launched")

        deadline = time.time() + args.lock_wait_s
        healthz = None
        while time.time() < deadline:
            if server.poll() is not None:
                raise RecordError(f"server wrapper exited ({server.returncode}) before /healthz; "
                                  f"see {out / 'server.log'}")
            status, text = http("GET", f"{api}/healthz", timeout=2.0)
            if status == 200:
                healthz = json.loads(text)
                break
            time.sleep(1.0)
        if healthz is None:
            raise RecordError(f"no /healthz within {args.lock_wait_s} s (GPU admission queue?)")
        mark("healthz_up")
        record_doc["healthz"] = healthz
        record_doc["server_pids"] = listener_pids(http_port)
        backend = healthz.get("destruction_backend")
        log(f"healthz: backend {backend}, sdk {healthz.get('physx_sdk')}")
        if backend != "native":
            raise RecordError(f"destruction_backend is {backend!r}, not 'native'")

        bot_cfg = scenario["bot"]
        centre = bot_cfg.get("centre", [0.0, 0.0])
        bot_duration = scenario["warmup_s"] + scenario["duration_s"] + scenario["settle_s"] + 120.0
        bot_cmd = [str(bots_bin), "--api", api, "--wt-port", str(wt_port), "--match", match,
                   "--bots", "1", "--duration", f"{bot_duration:.0f}", "--out", str(out / "bot"),
                   "--seed", str(int(bot_cfg.get("seed", 1))),
                   "--centre", f"{centre[0]},{centre[1]}", "--radius", str(bot_cfg.get("radius", 150.0))]
        record_doc["bot_command"] = bot_cmd
        bot_log = (out / "bot.log").open("w")
        bot = subprocess.Popen(bot_cmd, cwd=ROOT, stdout=bot_log, stderr=subprocess.STDOUT,
                               start_new_session=True)
        record_doc["bot_pid"] = bot.pid
        mark("bot_launched")
        log(f"bot {bot.pid} joining {match}")

        deadline = time.time() + args.match_wait_s
        tick = None
        while time.time() < deadline:
            if bot.poll() is not None:
                raise RecordError(f"bot exited ({bot.returncode}) before the match came up; see bot.log")
            if server.poll() is not None:
                raise RecordError(f"server exited ({server.returncode}) while the match was building")
            tick = server_tick(api, match)
            if tick is not None:
                break
            time.sleep(0.5)
        if tick is None:
            raise RecordError(f"match {match} did not come up within {args.match_wait_s} s")
        mark("match_up")
        record_doc["match_up_tick"] = tick
        manifest_path = out / "capture" / "manifest.json"
        for _ in range(60):
            if manifest_path.exists() and manifest_path.stat().st_size > 0:
                break
            time.sleep(0.5)
        if not manifest_path.exists():
            raise RecordError("the match is up but no capture/manifest.json: was VIBE_CITY_TAPE_OUT honoured?")
        points = manifest_points(json.loads(manifest_path.read_text()))
        plan = []
        for event in sorted(scenario["events"], key=lambda e: e["t_s"]):
            resolved = resolve_event(event, points)
            plan.append((event, resolved))
        log(f"match up at tick {tick}; warmup {scenario['warmup_s']} s")

        def check_alive(where):
            if server.poll() is not None:
                raise RecordError(f"server exited ({server.returncode}) {where}; not relaunching")
            if bot.poll() is not None:
                raise RecordError(f"bot exited ({bot.returncode}) {where}; see bot.log")

        time.sleep(scenario["warmup_s"])
        check_alive("during warmup")
        t0 = time.time()
        record_doc["t0_tick"] = server_tick(api, match)
        mark("t0")
        log(f"t0 at tick {record_doc['t0_tick']}")
        for event, resolved in plan:
            due = t0 + event["t_s"]
            while time.time() < due:
                time.sleep(min(0.05, max(0.0, due - time.time())))
            check_alive(f"before the {event['kind']} at {event['t_s']} s")
            kind = event["kind"]
            route = "city-demolish" if kind == "demolish" else "city-meteor"
            fired_at = time.time()
            status, text = http("POST", f"{api}/{route}/{match}", resolved["body"])
            fired = {
                "t_s": event["t_s"], "kind": kind, "body": resolved["body"],
                "resolved": resolved["resolved"], "status": status, "response": text[:200],
                "late_ms": round((fired_at - due) * 1000.0, 1),
                "tick_after": server_tick(api, match),
            }
            record_doc["events_fired"].append(fired)
            log(f"{kind} at {event['t_s']} s -> {status} {text[:60]!r} (tick {fired['tick_after']})")
            if status != 202:
                raise RecordError(f"{route} answered {status}: {text[:200]}")

        end = t0 + scenario["duration_s"] + scenario["settle_s"]
        log(f"waiting out the run: {end - time.time():.0f} s (duration + settle)")
        while time.time() < end:
            check_alive("during the run")
            time.sleep(min(2.0, max(0.0, end - time.time())))
        record_doc["end_tick"] = server_tick(api, match)
        mark("run_end")

        status, text = http("POST", f"{api}/city-capture-stop/{match}")
        mark("capture_stop_posted")
        if status != 202:
            raise RecordError(f"city-capture-stop answered {status}: {text[:200]}")
        meta_path = out / "capture" / "capture.json"
        deadline = time.time() + args.finalise_wait_s
        meta = {}
        while time.time() < deadline:
            try:
                meta = json.loads(meta_path.read_text())
            except (OSError, json.JSONDecodeError):
                meta = {}
            if meta.get("ticks") and meta.get("last_tick") is not None:
                break
            check_alive("while the capture was finalising")
            time.sleep(1.0)
        if not meta.get("ticks"):
            raise RecordError(f"capture.json not finalised within {args.finalise_wait_s} s")
        mark("capture_finalised")
        log(f"capture finalised: {meta['ticks']} ticks, {meta['dropped_ticks']} dropped")
    except RecordError as error:
        failure = str(error)
        log(f"FAILED: {failure}")
    except KeyboardInterrupt:
        failure = "interrupted"
        log("interrupted")
    finally:
        # Stop the server by its port; its gpu-run.sh then exits and frees
        # the slot. Then the bot, by its own PID.
        pids = stop_server_by_port(http_port)
        record_doc["stopped_server_pids"] = pids
        if server is not None and not pids and server.poll() is None:
            # Nothing listens yet: the wrapper is still queued for the GPU
            # (or the server is mid-start). Both are in the process group
            # this script created for them, and nothing else is.
            log(f"no listener on :{http_port}; stopping our own wrapper group {server.pid}")
            try:
                os.killpg(server.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if server is not None:
            if not wait_child(server, 60):
                log(f"server wrapper {server.pid} still running 60 s after the kill; "
                    f"listener now {listener_pids(http_port)}")
                record_doc["server_stop"] = "wrapper did not exit within 60 s"
            else:
                record_doc["server_wrapper_exit"] = server.returncode
        mark("server_stopped")
        if bot is not None:
            if not wait_child(bot, 20):
                bot.terminate()
                wait_child(bot, 10)
            record_doc["bot_exit"] = bot.returncode
        server_log.close()
        if bot_log is not None:
            bot_log.close()
        write_record()

    if failure is None or (out / "capture" / "capture.json").exists():
        log("validating the capture")
        try:
            record_doc["validation"] = validate(out)
        except (RecordError, EOFError, OSError) as error:
            record_doc["validation"] = {"ok": False, "problems": [f"validation crashed: {error}"]}
        mark("validated")
    record_doc["failure"] = failure
    write_record()
    validation = record_doc.get("validation", {})
    print_summary(out, record_doc)
    return 0 if failure is None and validation.get("ok") else 1


def print_summary(out: Path, doc: dict) -> None:
    validation = doc.get("validation") or {}
    meta = validation.get("capture_meta") or {}
    tape = validation.get("tape") or {}
    print(f"\n{doc['scenario']['name']}: {out / 'capture'}")
    if meta:
        print(f"  ticks {meta.get('ticks')} ({meta.get('first_tick')}..{meta.get('last_tick')}), "
              f"dropped {meta.get('dropped_ticks')}, scene {meta.get('scene')}, backend {meta.get('backend')}")
    if tape:
        print(f"  fracture batches {tape['fracture_batches']} over {tape['fracture_ticks']} ticks, "
              f"broken bonds {tape['broken_bonds']}, promoted islands {tape['promoted_islands']}, "
              f"bodies max {tape['max_bodies_per_tick']}/tick (mean {tape['mean_bodies_per_tick']})")
        print(f"  structures fractured {tape['structures_fractured']}")
    print(f"  validation: {'ok' if validation.get('ok') else 'FAILED ' + str(validation.get('problems'))}")
    if doc.get("failure"):
        print(f"  run failure: {doc['failure']}")


def plan_command(args) -> int:
    scenario = load_scenario(Path(args.scenario).resolve())
    points = manifest_points(json.loads(Path(args.manifest).read_text())) if args.manifest else None
    print(json.dumps({k: v for k, v in scenario.items() if k != "events"}, indent=2))
    for event in sorted(scenario["events"], key=lambda e: e["t_s"]):
        resolved = resolve_event(event, points)
        print(f"{event['t_s']:>6.2f} s  {event['kind']:<9} {json.dumps(resolved['body'])}  "
              f"{json.dumps(resolved['resolved'])}")
    return 0


def validate_command(args) -> int:
    out = Path(args.out).resolve()
    result = validate(out)
    record_path = out / "record.json"
    if record_path.exists():
        doc = json.loads(record_path.read_text())
        doc["validation"] = result
        record_path.write_text(json.dumps(doc, indent=2) + "\n")
        print_summary(out, doc)
    else:
        print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    rec = sub.add_parser("record", help="record one scenario")
    rec.add_argument("scenario")
    rec.add_argument("--out", help="output dir (default target/netcode-truth/<name>)")
    rec.add_argument("--bin", default=os.environ.get("BIN", str(ROOT / "target/release/web-fps-server")),
                     help="native-destruction web-fps-server binary (env BIN)")
    rec.add_argument("--bots-bin", default=os.environ.get("BOTS_BIN", ""),
                     help="city-bots binary (env BOTS_BIN; default: beside --bin)")
    rec.add_argument("--port-base", type=int, default=DEFAULT_PORT_BASE)
    rec.add_argument("--http-port", type=int, default=0,
                     help="fixed HTTP port (WebTransport is the next one); default: first free pair")
    rec.add_argument("--lock-wait-s", type=float, default=1800.0,
                     help="how long to wait for GPU admission plus server start")
    rec.add_argument("--match-wait-s", type=float, default=240.0)
    rec.add_argument("--finalise-wait-s", type=float, default=180.0)
    rec.add_argument("--force", action="store_true", help="move an existing recording aside")
    pl = sub.add_parser("plan", help="print the resolved event plan")
    pl.add_argument("scenario")
    pl.add_argument("--manifest", help="a capture's manifest.json, to resolve footprints/structures")
    va = sub.add_parser("validate", help="re-validate a recording dir")
    va.add_argument("out")
    args = parser.parse_args()
    try:
        if args.command == "record":
            if not args.bots_bin:
                args.bots_bin = str(Path(args.bin).resolve().parent / "city-bots")
            return record(args)
        if args.command == "plan":
            return plan_command(args)
        return validate_command(args)
    except RecordError as error:
        print(f"record-truth: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
