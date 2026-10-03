"""A private vibe-land stack for automated runs: vite, the server, a headless player.

Modelled on scripts/perf/city-bench.sh + locked.sh: private ports, the
server and everything it started killed as a tree on exit, the GPU part run
under scripts/perf/gpu-run.sh (the machine-wide lock), logs in the run dir.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GPU_RUN = Path(os.environ.get("GPU_RUN", "/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh"))

# The garage/vehicle SDK server: destructible fleet, force convergence, unconverged
# steps published (scripts/perf/garage-vehicle-server.sh).
DEFAULT_ENV = {
    "VIBE_PHYSICS_BACKEND": "physx_gpu",
    "VIBE_GARAGE_VEHICLE_DESTRUCTION": "1",
    "PX_DESTRUCTION_ALLOW_UNCONVERGED": "1",
    "VIBE_CITY_DESTRUCTIBLE_VEHICLES": "1",
    "VIBE_NATIVE_STRESS_FORCE_TOLERANCE": "0.001",
    "BLAST_STRESS_INCREMENTAL_MOTION": "1",
    "PX_DESTRUCTION_INCREMENTAL_TOPOLOGY": "1",
    "CUMETAL_CACHE_DIR": str(ROOT / "target/cumetal-cache-vehicles"),
    "SKIP_SPACETIMEDB_VERIFY": "1",
    "RUST_LOG": "info",
}


def get(url, timeout=5):
    return urllib.request.urlopen(url, timeout=timeout).read()


def answers(url):
    try:
        get(url, 2)
        return True
    except Exception:  # noqa: BLE001
        return False


def kill_tree(proc, leader_first=False):
    """Stop a process and everything it started. leader_first: signal only the
    leader and let it shut its children down (the headless player files its
    final report through its browser), then clean up the group."""
    if proc is None or proc.poll() is not None:
        return
    if leader_first:
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=20)
        except Exception:  # noqa: BLE001
            pass
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=20)
    except Exception:  # noqa: BLE001
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:  # noqa: BLE001
            pass


def start_vite(run_dir: Path, client_port: int, http_port: int):
    """The client dev server on a private port, pointed at the private server."""
    if answers(f"http://localhost:{client_port}/"):
        raise SystemExit(f"something already answers on :{client_port}")
    env = dict(os.environ, CLIENT_PORT=str(client_port), SERVER_PORT=str(http_port), SERVER_HOST="127.0.0.1",
               VITE_CACHE_DIR=str(ROOT / "target/vl/vite-cache"))
    log = open(run_dir / "vite.log", "w")
    proc = subprocess.Popen(["npx", "vite", "--config", "e2e/city-bench/vite.bench.config.ts", "--port", str(client_port), "--strictPort"],
                            cwd=ROOT / "client", env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(90):
        if answers(f"http://localhost:{client_port}/"):
            break
        if proc.poll() is not None:
            raise SystemExit(f"vite exited; see {run_dir / 'vite.log'}")
        time.sleep(1)
    else:
        kill_tree(proc)
        raise SystemExit("vite did not start")
    try:  # compile /city once so the first join is not a cold build
        get(f"http://localhost:{client_port}/city", 180)
    except Exception:  # noqa: BLE001
        pass
    return proc


def start_server(run_dir: Path, binary: Path, http_port: int, wt_port: int, env: dict):
    if answers(f"http://127.0.0.1:{http_port}/healthz"):
        raise SystemExit(f"something already answers on 127.0.0.1:{http_port}; refusing to share a server")
    (run_dir / "debug-reports").mkdir(parents=True, exist_ok=True)
    full = dict(os.environ)
    full.update(DEFAULT_ENV)
    full.update(env)
    full.update({"BIND_ADDR": f"127.0.0.1:{http_port}", "WT_BIND_ADDR": f"0.0.0.0:{wt_port}", "WT_HOST": "127.0.0.1",
                 "WEB_BIND_ADDR": "", "VIBE_DEBUG_REPORTS_DIR": str(run_dir / "debug-reports")})
    log = open(run_dir / "server.log", "w")
    proc = subprocess.Popen([str(binary)], env=full, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for i in range(150):
        if proc.poll() is not None:
            raise SystemExit(f"server exited during startup; see {run_dir / 'server.log'}")
        if answers(f"http://127.0.0.1:{http_port}/healthz"):
            return proc
        time.sleep(2)
    kill_tree(proc)
    raise SystemExit("server did not answer /healthz within 300 s")


def join(run_dir: Path, client_port: int, http_port: int, match: str):
    log = open(run_dir / "player.log", "w")
    proc = subprocess.Popen(["node", "e2e/city-join.mjs", f"http://localhost:{client_port}", f"http://127.0.0.1:{http_port}", "0", match],
                            cwd=ROOT / "client", stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(180):
        if proc.poll() is not None:
            raise SystemExit(f"headless player exited; see {run_dir / 'player.log'}")
        if "joined" in (run_dir / "player.log").read_text():
            return proc
        time.sleep(1)
    kill_tree(proc)
    raise SystemExit("headless player did not join within 180 s")


def fingerprint(binary: Path, env: dict) -> dict:
    def git(repo, *args):
        try:
            return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
        except Exception:  # noqa: BLE001
            return None
    physx = ROOT.parent / "PhysX"
    sdk = Path(os.environ.get("PHYSX_ROOT", ROOT.parent / "PhysX/out/install/garage-multihull"))
    manifest = sdk / "sdk-artifacts.json"
    sdk_rev = json.loads(manifest.read_text()).get("source_revision") if manifest.exists() else None
    return {"vibe_land": git(ROOT, "rev-parse", "HEAD"), "vibe_land_dirty": bool(git(ROOT, "status", "--short")),
            "physx": git(physx, "rev-parse", "HEAD"), "sdk": str(sdk), "sdk_revision": sdk_rev,
            "binary": str(binary), "binary_mtime": binary.stat().st_mtime if binary.exists() else None,
            "env": {**DEFAULT_ENV, **env}, "platform": sys.platform}
