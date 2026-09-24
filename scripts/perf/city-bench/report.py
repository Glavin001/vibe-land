#!/usr/bin/env python3
"""City-bench report: was the run real-time on the server and on every client,
and how well did the netcode stream it?

    python3 scripts/perf/city-bench/report.py <runDir> [--budgets F] [--baseline report.json]
                                               [--no-decode] [--no-charts]

Reads what scripts/perf/city-bench.sh left in <runDir>: run.json (plan and
phase times), server-stats.jsonl, client-<i>-samples.jsonl,
client-<i>-drawn.jsonl, server.log and the paired session bundles under
debug-reports/. Decodes each client tape with the tape-analysis scripts
(decode.ts, dumpstats.ts, meteors.ts) and stream.ts into analysis/c<i>/, joins
each bundle with scripts/perf/session_bundle.py, and writes report.json and
report.md into <runDir>. Exit status: 0 when every enabled budget passes, 1
when one fails, 2 when the run cannot be analysed.

Every time is put on the unix wall clock (one machine, one clock): tape time
t -> wallClockOriginMs + t; server ticks carry unix_us; the driver stamps
phases with Date.now().
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # keep the source tree free of __pycache__

import argparse
import bisect
import collections
import csv
import datetime
import json
import math
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "perf"))
import session_bundle  # noqa: E402

TICK_US = 1e6 / 60
KINDS = {101: "welcome", 102: "snapshot-v1", 103: "shot-result", 110: "ping", 112: "snapshot", 113: "roster",
         114: "body-meta", 115: "energy", 116: "battery", 117: "shot-fired", 118: "damage", 119: "city-chunks",
         120: "city-topology", 121: "city-baseline", 122: "city-bootstrap", 123: "city-manifest", 124: "match-stats",
         125: "city-debris", 127: "city-lanes", 128: "city-topo-hash", 129: "city-structure-repair", 130: "meteor-launched"}
CITY_KINDS = {119, 120, 121, 122, 125, 127, 128, 129}


# ── small helpers ──────────────────────────────────────────────────────────

def q(values, digits=2):
    """n, mean, p50, p90, p95, p99, max (nearest rank)."""
    v = sorted(x for x in values if x is not None and not (isinstance(x, float) and math.isnan(x)))
    if not v:
        return {"n": 0}
    at = lambda p: v[min(len(v) - 1, max(0, int(math.ceil(p / 100 * len(v))) - 1))]
    r = lambda x: round(x, digits)
    return {"n": len(v), "mean": r(sum(v) / len(v)), "p50": r(at(50)), "p90": r(at(90)), "p95": r(at(95)),
            "p99": r(at(99)), "max": r(v[-1])}


def pct(part, whole, digits=2):
    return round(100.0 * part / whole, digits) if whole else None


def corr(a, b):
    n = len(a)
    if n < 3:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((x - mb) ** 2 for x in b))
    return round(sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / (sa * sb), 2) if sa and sb else None


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def rd_csv(path):
    if not os.path.exists(path):
        return []
    with open(path) as handle:
        return list(csv.DictReader(handle))


def fnum(x, default=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def get_path(obj, dotted):
    for part in dotted.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        else:
            return None
    return obj


def git(repo, *args):
    try:
        return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return None


# ── decoding (the tape-analysis scripts, cached per tape) ──────────────────

def decode_tape(tape, out, charts, server_log):
    os.makedirs(out, exist_ok=True)
    stamp = os.path.join(out, ".decoded")
    client_dir = os.path.join(ROOT, "client")
    steps = [
        ["npx", "tsx", "../scripts/perf/tape-analysis/decode.ts", tape, out],
        ["npx", "tsx", "../scripts/perf/tape-analysis/dumpstats.ts", tape, os.path.join(out, "match_stats.json")],
        ["npx", "tsx", "../scripts/perf/tape-analysis/meteors.ts", tape, out],
        ["npx", "tsx", "../scripts/perf/city-bench/stream.ts", tape, os.path.join(out, "stream.json")],
    ]
    notes = []
    if not (os.path.exists(stamp) and os.path.getmtime(stamp) >= os.path.getmtime(tape)):
        for cmd in steps:
            r = subprocess.run(cmd, cwd=client_dir, capture_output=True, text=True)
            if r.returncode != 0:
                notes.append(f"{os.path.basename(cmd[2])} failed: {(r.stderr or r.stdout)[-400:]}")
        if not notes:
            open(stamp, "w").write("ok\n")
    if charts:
        # analyse.py: the session-analysis charts (timeline, render clock, meteors) for this tape.
        args = [sys.executable, os.path.join(ROOT, "scripts/perf/tape-analysis/analyse.py"), out, server_log]
        r = subprocess.run(args, capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        if r.returncode != 0:
            notes.append(f"analyse.py (charts) failed: {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else r.returncode}")
    return notes


# ── the run's clocks and phases ────────────────────────────────────────────

class Timeline:
    def __init__(self, run):
        self.phases = run.get("phases") or []
        self.t0 = run.get("recordStartUnixMs") or (self.phases[0]["startUnixMs"] if self.phases else 0)
        self.t1 = run.get("recordEndUnixMs") or (self.phases[-1]["endUnixMs"] if self.phases else self.t0)
        self.starts = [p["startUnixMs"] for p in self.phases]

    def phase_at(self, unix_ms):
        i = bisect.bisect_right(self.starts, unix_ms) - 1
        if i < 0 or unix_ms > self.phases[i]["endUnixMs"]:
            return "(outside plan)"
        p = self.phases[i]
        return f"{p['phase']}:{p['do']}"

    def coarse(self):
        """intro / destroy / settle / drive / idle-end spans."""
        spans = collections.OrderedDict()
        for p in self.phases:
            name = "destroy" if p["phase"].startswith("building-") else p["phase"]
            a, b = spans.get(name, (p["startUnixMs"], p["endUnixMs"]))
            spans[name] = (min(a, p["startUnixMs"]), max(b, p["endUnixMs"]))
        return spans


class Levels:
    """Destruction level over time, from the driver's /match-stats samples."""

    def __init__(self, samples):
        rows = [s for s in samples if "error" not in s and s.get("city")]
        self.t = [s["unixMs"] for s in rows]
        self.rows = rows

    def at(self, unix_ms):
        if not self.rows:
            return {}
        i = min(len(self.rows) - 1, max(0, bisect.bisect_left(self.t, unix_ms)))
        s = self.rows[i]
        return {"broken_bonds": s["city"].get("broken_bonds"), "chunk_bodies": s["city"].get("chunk_bodies"),
                "awake_city_bodies": s["city"].get("awake_bodies"),
                "active_bodies": s.get("physics_active_dynamic_bodies")}


# ── server ─────────────────────────────────────────────────────────────────

def server_metrics(server_dir, stats_samples, window, levels, tl, server_log_text):
    ticks = [t for t in read_jsonl(os.path.join(server_dir, "ticks.jsonl"))
             if window[0] * 1000 <= t["unix_us"] <= window[1] * 1000]
    ticks.sort(key=lambda t: t["tick"])
    out = {"ticks": len(ticks)}
    if len(ticks) < 2:
        return out, ticks
    total = [t["total_ms"] for t in ticks]
    span_s = (ticks[-1]["unix_us"] - ticks[0]["unix_us"]) / 1e6
    out["tick_ms"] = q(total)
    out["pct_ticks_over_16_7ms"] = pct(sum(1 for x in total if x > 16.667), len(total))
    out["pct_ticks_over_33ms"] = pct(sum(1 for x in total if x > 33.33), len(total))
    out["ticks_over_100ms"] = sum(1 for x in total if x > 100)
    out["sim_rate"] = round((ticks[-1]["tick"] - ticks[0]["tick"]) / 60 / span_s, 3) if span_s > 0 else None
    out["wall_s"] = round(span_s, 1)
    # Sim rate in 5 s windows.
    per5 = []
    start = ticks[0]["unix_us"]
    buckets = collections.defaultdict(list)
    for t in ticks:
        buckets[int((t["unix_us"] - start) / 5e6)].append(t)
    for k in sorted(buckets):
        b = buckets[k]
        if len(b) > 1 and k < max(buckets):
            per5.append(round(len(b) / 5 / 60, 3))
    out["sim_rate_5s_min"] = min(per5) if per5 else None
    comps = ["dynamics_ms", "city_ms", "snapshot_ms", "player_sim_ms", "vehicle_ms", "hitscan_ms", "publish_ms",
             "unattributed_ms", "capture_ms"]
    tot = sum(total)
    out["breakdown"] = {c: {**q([t.get(c, 0.0) for t in ticks], 3),
                            "share_pct": pct(sum(t.get(c, 0.0) for t in ticks), tot, 1)} for c in comps}
    # City encoder per tick.
    city = [c for c in read_jsonl(os.path.join(server_dir, "city", "stats.jsonl"))
            if ticks[0]["tick"] <= c["tick"] <= ticks[-1]["tick"]]
    if city:
        out["city_encoder"] = {
            "step_ms": q([c["step_ms"] for c in city], 3), "encode_ms": q([c["encode_ms"] for c in city], 3),
            "sent_bytes_per_tick": q([c["sent_bytes"] for c in city], 0),
            "outbound_drops": sum(c.get("outbound_drops", 0) for c in city),
            "desync_repairs": max(c.get("desync_repairs", 0) for c in city),
            "bytes_per_awake_body_tick": round(sum(c["sent_bytes"] for c in city) / max(1, sum(c["awake"] for c in city)), 1),
        }
    # Physics step / GPU wait: sampled once a second by the driver (last step only).
    inwin = [s for s in stats_samples if "error" not in s and window[0] <= s["unixMs"] <= window[1]]
    out["physics_sampled"] = {k: q([s.get(k) for s in inwin], 2) for k in
                              ("physics_last_step_ms", "physics_gpu_wait_ms", "physics_simulate_ms", "physics_fetch_ms")}
    ipt = [((s.get("timings") or {}).get("input_frames_per_tick") or {}).get("max") for s in inwin]
    out["input_frames_per_tick_window_max"] = q([x for x in ipt if x is not None], 0)
    out["gpu_warnings"] = max((s.get("physics_gpu_warning_count") or 0 for s in inwin), default=0)
    # Destruction reached.
    end = levels.at(window[1])
    peak_active = max((s.get("physics_active_dynamic_bodies") or 0 for s in inwin), default=0)
    m = re.search(r"bonds=(\d+)", server_log_text)
    total_bonds = int(m.group(1)) if m else None
    out["destruction"] = {**end, "peak_active_bodies": peak_active, "total_bonds": total_bonds,
                          "broken_bond_pct": pct(end.get("broken_bonds") or 0, total_bonds, 1) if total_bonds else None}
    out["left_the_world_log_lines"] = server_log_text.count("left the world")
    # Bodies retired at the floor under the ground (item 5), and bodies whose
    # first below-ground tick was logged: chunk bodies from the destruction
    # runtime, fired balls and meteors from the arena. Both logs are bounded,
    # so these are lower bounds past 32 of a kind.
    out["retired_at_floor_log_lines"] = server_log_text.count("retired at the floor")
    out["went_through_ground_log_lines"] = server_log_text.count("went through the ground")
    # Tick cost against destruction level.
    by_active, by_broken = collections.defaultdict(list), collections.defaultdict(list)
    for t in ticks:
        lv = levels.at(t["unix_us"] / 1000)
        a = lv.get("active_bodies") or 0
        by_active["0-99" if a < 100 else "100-499" if a < 500 else "500-999" if a < 1000 else "1000+"].append(t["total_ms"])
        if total_bonds:
            f = (lv.get("broken_bonds") or 0) / total_bonds
            by_broken["0-25%" if f < .25 else "25-50%" if f < .5 else "50-75%" if f < .75 else "75-100%"].append(t["total_ms"])
    level_rows = []
    for key, groups in (("active_bodies", by_active), ("broken_bonds", by_broken)):
        for bucket in sorted(groups, key=lambda s: float(re.match(r"[\d.]+", s).group())):
            g = groups[bucket]
            level_rows.append({"by": key, "bucket": bucket, "ticks": len(g), **{f"tick_{k}": v for k, v in q(g).items() if k != "n"},
                               "pct_over_16_7ms": pct(sum(1 for x in g if x > 16.667), len(g), 1)})
    out["by_destruction_level"] = level_rows
    fit_x = [levels.at(t["unix_us"] / 1000).get("active_bodies") or 0 for t in ticks]
    out["r_tick_vs_active_bodies"] = corr(fit_x, total)
    return out, ticks


def world_below_ground(server_dir, tick_lo, tick_hi):
    below = set()
    path = os.path.join(server_dir, "world.bin")
    if not os.path.exists(path):
        return None
    for tick, _m, _u, _p, _v, bodies in session_bundle.iter_world(path):
        if bodies is None or not (tick_lo <= tick <= tick_hi):
            continue
        for b in bodies:
            if b["pos"][1] < -3:
                below.add(b["id"])
    return len(below)


# ── clients ────────────────────────────────────────────────────────────────

def client_metrics(i, bundle, adir, run_dir, tl, budgets_cfg, server_ticks, levels, notes):
    hdr = json.load(open(os.path.join(adir, "header.json")))
    origin_wall = hdr.get("wallClockOriginMs")
    origin_perf = hdr.get("clockOriginMs")
    dur_s = hdr["durationMs"] / 1000
    to_unix = lambda t_ms: origin_wall + t_ms
    F = rd_csv(os.path.join(adir, "frames.csv"))
    P = rd_csv(os.path.join(adir, "packets.csv"))
    S = rd_csv(os.path.join(adir, "snapshots.csv"))
    C = rd_csv(os.path.join(adir, "chunks.csv"))
    R = rd_csv(os.path.join(adir, "render_clock.csv"))
    M = rd_csv(os.path.join(adir, "meteor_frames.csv"))
    EV = json.load(open(os.path.join(adir, "events.json"))) if os.path.exists(os.path.join(adir, "events.json")) else []
    TOPO = json.load(open(os.path.join(adir, "topology.json"))) if os.path.exists(os.path.join(adir, "topology.json")) else []
    stream = json.load(open(os.path.join(adir, "stream.json"))) if os.path.exists(os.path.join(adir, "stream.json")) else None
    out = {"client": i, "role": "player" if i == 0 else "spectator", "tape_s": round(dur_s, 1),
           "renderer": None, "packets": hdr.get("packets"), "frames_recorded": hdr.get("frames")}

    # ── frames
    ft = [fnum(r["t_ms"]) for r in F]
    fms = [fnum(r["frame_ms"]) for r in F]
    fcpu = [fnum(r["cpu_ms"]) for r in F]
    period = budgets_cfg.get("display_period_ms")
    if not period and fms:
        # The display (rAF) period: the median frame while the scene is quiet
        # (the first plan phase), snapped to a standard refresh rate.
        quiet = [fms[k] for k, t in enumerate(ft) if tl.phases and to_unix(t) < tl.phases[0]["endUnixMs"]] or fms
        med = sorted(quiet)[len(quiet) // 2]
        period = min((6.944, 8.333, 11.111, 16.667, 33.333), key=lambda d: abs(d - med))
    hitches = []
    for k, ms in enumerate(fms):
        if ms > 100 or (ms > 33.3 and fcpu[k] > 0.6 * ms):
            u = to_unix(ft[k])
            near = [t["total_ms"] for t in server_ticks if abs(t["unix_us"] / 1000 - u) < 150]
            hitches.append({"t_s": round((u - tl.t0) / 1000, 2), "phase": tl.phase_at(u), "frame_ms": ms, "cpu_ms": fcpu[k],
                            "cpu_bound": fcpu[k] > 0.6 * ms, "server_tick_max_ms_near": round(max(near), 1) if near else None})
    out["frames"] = {
        "display_period_ms": period, "avg_fps": round(len(F) / dur_s, 1) if dur_s else None,
        "frame_ms": q(fms), "cpu_ms": q(fcpu),
        "p95_over_display": round(q(fms).get("p95", 0) / period, 2) if fms else None,
        "pct_over_1_5x_display": pct(sum(1 for x in fms if x > 1.5 * period), len(fms)),
        "pct_over_2x_display": pct(sum(1 for x in fms if x > 2 * period), len(fms)),
        "hitches_over_50ms": sum(1 for x in fms if x > 50), "hitches_over_100ms": sum(1 for x in fms if x > 100),
        "cpu_bound_over_33ms": sum(1 for k, x in enumerate(fms) if x > 33.3 and fcpu[k] > 0.6 * x),
        "worst_hitches": sorted(hitches, key=lambda h: -h["frame_ms"])[:15],
    }

    # ── snapshots (stream rate against the server's tick rate)
    st = [fnum(r["t_ms"]) for r in S]
    stick = [int(r["tick"]) for r in S]
    gaps = [st[k + 1] - st[k] for k in range(len(st) - 1)]
    tick_span = (stick[-1] - stick[0]) if len(stick) > 1 else 0
    out["snapshots"] = {
        "count": len(S), "rate_hz": round(len(S) / ((st[-1] - st[0]) / 1000), 1) if len(st) > 1 else None,
        "per_server_tick": round((len(S) - 1) / tick_span, 3) if tick_span else None,
        "tick_deltas": dict(collections.Counter(str(stick[k + 1] - stick[k]) for k in range(len(stick) - 1)).most_common(6)),
        "interarrival_ms": q(gaps), "gaps_over_100ms": sum(1 for g in gaps if g > 100),
        "sim_rate_seen": round(tick_span / 60 / ((st[-1] - st[0]) / 1000), 3) if len(st) > 1 else None,
    }

    # ── interpolation / render clock
    lead = [fnum(r["lead_ms"]) for r in R]
    rdus = [fnum(r["render_dyn_us"]) for r in R]
    rt = [fnum(r["t_ms"]) for r in R]
    back = [(rt[k + 1], (rdus[k + 1] - rdus[k]) / 1000) for k in range(len(rdus) - 1) if rdus[k + 1] < rdus[k]]
    out["interpolation"] = {
        "lead_ms": q(lead, 1), "pct_frames_extrapolating": pct(sum(1 for x in lead if x > 0), len(lead)),
        "pct_frames_lead_over_100ms": pct(sum(1 for x in lead if x > 100), len(lead)),
        "render_clock_backward_steps": len(back), "render_clock_backward_total_ms": round(sum(b for _, b in back), 1),
        "worst_backward_steps": [{"t_s": round((to_unix(t) - tl.t0) / 1000, 2), "ms": round(b, 1), "phase": tl.phase_at(to_unix(t))}
                                 for t, b in sorted(back, key=lambda x: x[1])[:8]],
        "dyn_delay_ms": q([fnum(r["dyn_ms"]) for r in F if r.get("dyn_ms")], 2),
        "player_delay_ms": q([fnum(r["interp_ms"]) for r in F if r.get("interp_ms")], 2),
    }

    # ── meteors (MeteorLayer reconstructed by meteors.ts; logic as analyse.py)
    by = collections.defaultdict(list)
    for r in M:
        by[(int(r["body"]), fnum(r["launch_t_ms"]))].append(r)
    backs_total = arc_j = 0
    arc_jumps, hold_jumps, backs_m, below = [], [], [], 0
    per_meteor_backward = []
    for key, rs in by.items():
        prev = prevd = None
        nb = 0
        for k, r in enumerate(rs):
            if r["source"] == "hidden":
                prev = None
                continue
            p = [fnum(r["draw_x"]), fnum(r["draw_y"]), fnum(r["draw_z"])]
            if r["source"] == "body" and p[1] < -0.5 and fnum(r["raw_y"], 1.0) > -0.5:
                below += 1
            if prev:
                d = [p[j] - prev[j] for j in range(3)]
                dist = math.sqrt(sum(x * x for x in d))
                if prevd and dist > 0.05:
                    pn = math.sqrt(sum(x * x for x in prevd))
                    along = sum(d[j] * prevd[j] for j in range(3)) / pn if pn > 0.05 else 0
                    if along < -0.3:
                        nb += 1
                        backs_m.append(-along)
                if r["source"] != rs[k - 1]["source"] and rs[k - 1]["source"] != "hidden":
                    kind = rs[k - 1]["source"] + ">" + r["source"]
                    if kind == "arc>body":
                        arc_jumps.append(dist)
                    elif kind == "hold>body":
                        hold_jumps.append(dist)
                if dist > 0.05:
                    prevd = d
            prev = p
        backs_total += nb
        per_meteor_backward.append(nb)
    out["meteors"] = {
        "meteors": len(by), "with_backward_motion": sum(1 for n in per_meteor_backward if n), "backward_frames": backs_total,
        "max_backward_m": round(max(backs_m), 1) if backs_m else 0, "arc_to_body_jump_m": q(arc_jumps, 1),
        "hold_to_body_jump_m": q(hold_jumps, 1), "drawn_below_ground_frames": below,
    }
    if not arc_jumps:
        out["meteors"]["arc_to_body_jump_m"]["max"] = 0
    if not hold_jumps:
        out["meteors"]["hold_to_body_jump_m"]["max"] = 0

    # ── bandwidth, per lane and per packet kind
    kind_bytes, kind_pkts, lane_bytes, lane_pkts = collections.Counter(), collections.Counter(), collections.Counter(), collections.Counter()
    per_s = collections.defaultdict(collections.Counter)
    for r in P:
        k, n, lane = int(r["kind"]), int(r["len"]), r["channel"]
        name = KINDS.get(k, str(k))
        kind_bytes[name] += n
        kind_pkts[name] += 1
        lane_bytes[lane] += n
        lane_pkts[lane] += 1
        per_s[int(fnum(r["t_ms"]) // 1000)][name] += n
    total_bytes = sum(kind_bytes.values())
    out["bandwidth"] = {
        "kbps_avg": round(total_bytes * 8 / 1000 / dur_s, 1) if dur_s else None,
        "kbps_peak_1s": round(max((sum(c.values()) for c in per_s.values()), default=0) * 8 / 1000, 1),
        "by_lane": {lane: {"kB": round(lane_bytes[lane] / 1000, 1), "packets": lane_pkts[lane],
                           "kB_per_s": round(lane_bytes[lane] / 1000 / dur_s, 2), "packets_per_s": round(lane_pkts[lane] / dur_s, 1)}
                    for lane in sorted(lane_bytes)},
        "by_kind": {name: {"kB": round(kind_bytes[name] / 1000, 1), "packets": kind_pkts[name],
                           "kB_per_s": round(kind_bytes[name] / 1000 / dur_s, 2), "packets_per_s": round(kind_pkts[name] / dur_s, 1),
                           "pct_of_bytes": pct(kind_bytes[name], total_bytes, 1),
                           "peak_kB_s": round(max((c[name] for c in per_s.values()), default=0) / 1000, 1)}
                    for name, _ in kind_bytes.most_common()},
        "match_stats_pct_of_bytes": pct(kind_bytes["match-stats"], total_bytes),
        "energy_msgs_per_s": round(kind_pkts["energy"] / dur_s, 1) if dur_s else None,
    }

    # ── transport: sent vs received, drops, latency (the paired join)
    try:
        insp = session_bundle.analyse(bundle)
        json.dump(insp, open(os.path.join(adir, "inspect.json"), "w"), indent=1, default=str)
    except Exception as e:  # noqa: BLE001
        insp = None
        notes.append(f"client {i}: session_bundle failed: {e}")
    if insp:
        ch = insp["channels"]
        lost = sum(v.get("in_window_lost", 0) for v in ch.values())
        drops = sum(n for v in ch.values() for k, n in v.items()
                    if k.startswith("server_") and k not in ("server_sent", "server_sent-fallback"))
        lat = insp["clock"]
        out["transport"] = {
            "join_matched": f"{insp['join']['matched']}/{insp['join']['taped']}",
            "lost_packets": lost, "server_drops": drops,
            "by_lane": {lane: {"sent": v.get("in_window_sent_packets", 0), "received": v.get("received_packets", 0),
                               "lost": v.get("in_window_lost", 0),
                               "server_outcomes": {k[7:]: n for k, n in v.items() if k.startswith("server_")}}
                        for lane, v in ch.items()},
            "latency_ms": {k: lat["latency_wall_ms"].get(k) for k in ("p50", "p90", "p99", "max")},
            "latency_by_lane_ms": {lane: {k: v.get(k) for k in ("p50", "p99", "max")} for lane, v in lat["latency_wall_by_lane_ms"].items()},
            "tick_end_to_arrival_ms": {k: lat["tick_end_to_arrival_ms"].get(k) for k in ("p50", "p99", "max")},
            "queue_to_send_ms": {k: lat["queue_to_send_ms"].get(k) for k in ("p50", "p99", "max")},
            "snapshot_tick_disagreements": lat.get("snapshot_tick_disagreements"),
            "received_snapshot_error_mm": {k: {kk: v.get(kk) for kk in ("p50", "p99", "max")} for k, v in insp["position_error_mm"].items()},
            "server_selections": insp.get("selections"),
            "capture_drops": {"ticks": insp["server"].get("dropped_ticks"), "send_records": insp["server"].get("dropped_send_records")},
        }
    else:
        out["transport"] = {}

    # ── sync health: repairs, bootstraps, gaps, client ledger counters
    t0_tape = 3000
    boots = [e for e in EV if e.get("kind") == 122]
    repairs = [e for e in EV if e.get("kind") == 129]
    late_boots = [e for e in boots if e["t"] > t0_tape]
    seq_gaps = sum(1 for k in range(len(C) - 1) if int(C[k + 1]["seq"]) != int(C[k]["seq"]) + 1)
    topo_gaps = sum(1 for k in range(len(TOPO) - 1) if TOPO[k + 1]["topoSeq"] != TOPO[k]["topoSeq"] + 1)
    samples = [s for s in read_jsonl(os.path.join(run_dir, f"client-{i}-samples.jsonl")) if s.get("city")]
    last = samples[-1]["city"] if samples else {}
    mx = lambda key: max((s["city"].get(key) or 0 for s in samples), default=None)
    lossless = (out["transport"].get("lost_packets", 0) == 0) and seq_gaps == 0 and topo_gaps == 0
    n_repairs = len(repairs) + len(late_boots)
    out["sync"] = {
        "structure_repairs": len(repairs), "structure_repair_kB": round(sum(e.get("len", 0) for e in repairs) / 1000, 1),
        "structure_repair_times_s": [round((to_unix(e["t"]) - tl.t0) / 1000, 1) for e in repairs][:20],
        "full_bootstraps_after_start": len(late_boots), "datagram_seq_gaps": seq_gaps, "topology_seq_gaps": topo_gaps,
        "lossless": lossless, "repairs_without_loss": n_repairs if lossless else 0,
        "client_counters_end": {k: last.get(k) for k in (
            "bootstraps", "structureRepairs", "hashChecks", "hashMismatches", "nacksSent", "nackBodiesSent",
            "resyncRequestsSent", "topoSeqGaps", "poseJumpsOver4m", "presentedJumpsOver4m", "drawnTeleports",
            "clockRollbacks", "correctionSnaps", "implausibleJumps", "recordsOutsideWorld", "settleRejects")},
        "client_max": {k: mx(k) for k in ("chunksBelowGround", "orphanedChunks", "staleDrawnChunks", "chunksAwake")},
    }
    per_tick = collections.Counter()
    for r in C:
        per_tick[int(r["tick"])] += int(r["len"])
    out["sync"]["ceiling_sends"] = sum(1 for v in per_tick.values() if v >= 10000)
    out["sync"]["city_sends"] = len(per_tick)

    # ── efficiency
    if stream:
        T = stream["totals"]
        moving_s = sum(r["moving"] for r in stream["perSecond"])
        out["efficiency"] = {
            "city_bytes_per_moving_body_s": round(T["cityBytes"] / moving_s, 1) if moving_s else None,
            "city_bytes_per_record": round(T["cityBytes"] / T["records"], 2) if T["records"] else None,
            "city_records": T["records"], "city_repeat_records_pct": pct(T["repeats"], T["records"]),
            "city_repeat_kB": round(T["repeatBytes"] / 1000, 1),
            "record_modes": {k: T[k] for k in ("abs", "delta", "motion", "ballistic")},
            "snapshot_bytes_mean": round(T["snapBytes"] / T["snapshots"], 1) if T["snapshots"] else None,
            "snapshot_body_entries": T["snapBodies"], "snapshot_body_repeat_pct": pct(T["snapBodyRepeats"], T["snapBodies"]),
            "chunk_bodies_below_ground": T.get("belowGroundBodies"),
            "stream_decode_errors": T["decodeErrors"],
        }
    sel = (out["transport"].get("server_selections") or {}).get("city") or {}
    if sel:
        out.setdefault("efficiency", {})["server_city_selection"] = {
            "candidates": sel.get("candidates"), "sent": sel.get("sent"), "sent_pct": pct(sel.get("sent", 0), sel.get("candidates", 0)),
            "not_newsworthy": sel.get("not_newsworthy"), "rest_stride": sel.get("rest_stride"), "rest_unchanged": sel.get("rest_unchanged"),
            "ceiling": sel.get("ceiling"), "eval_cap": sel.get("eval_cap"),
            "budget_used_pct": pct(sel.get("used_bytes", 0), sel.get("allowance_bytes", 0))}

    # ── rendered vs server truth (drawn samples joined to world.bin)
    out["render_error"] = render_error(i, run_dir, bundle, hdr, F, notes, (stream or {}).get("snapshotBodyPresence") or {})

    # ── client fps vs server rate, per second
    fps_s = collections.Counter(int(to_unix(t) // 1000) for t in ft)
    tick_s = collections.Counter(int(t["unix_us"] // 1e6) for t in server_ticks)
    secs = [s for s in fps_s if s in tick_s][1:-1]
    out["r_client_fps_vs_server_ticks_per_s"] = corr([fps_s[s] for s in secs], [tick_s[s] for s in secs])
    return out, {"ft": ft, "fms": fms, "fcpu": fcpu, "st": st, "lead": lead, "rt": rt, "back": back, "P": P, "to_unix": to_unix,
                 "period": period, "stream": stream}


def render_error(i, run_dir, bundle, hdr, F, notes, presence):
    """Drawn positions (client-<i>-drawn.jsonl) against world.bin.

    at render time: each drawn entity vs server truth at the server time the
    client was rendering it (its render clock), interpolated between ticks --
    the netcode's reconstruction error. now: the same drawn position vs the
    truth at the latest server tick at that wall instant -- what the player
    sees versus where things are (interpolation delay and latency included).
    """
    drawn = read_jsonl(os.path.join(run_dir, f"client-{i}-drawn.jsonl"))
    manifest = json.load(open(os.path.join(bundle, "session.json")))
    server_dir = os.path.normpath(os.path.join(bundle, (manifest.get("server") or {}).get("dir", "server")))
    ticks = read_jsonl(os.path.join(server_dir, "ticks.jsonl"))
    if not drawn or not ticks or not F:
        return {"samples": 0}
    tick_unix = sorted((t["unix_us"] / 1000, t["tick"]) for t in ticks)
    tu = [x[0] for x in tick_unix]
    ftimes = [fnum(r["t_ms"]) for r in F]
    origin_perf, origin_wall = hdr["clockOriginMs"], hdr["wallClockOriginMs"]
    plan = []
    for d in drawn:
        tape_ms = d.get("tapeMs")
        if tape_ms is None:
            continue
        k = min(len(ftimes) - 1, bisect.bisect_left(ftimes, tape_ms))
        fr = F[k]
        if fr.get("offset_us") in (None, ""):
            continue
        server_now_us = (tape_ms + origin_perf) * 1000 + fnum(fr["offset_us"])
        dyn_tick = (server_now_us - fnum(fr["dyn_ms"]) * 1000) / TICK_US
        ply_tick = (server_now_us - fnum(fr["interp_ms"]) * 1000) / TICK_US
        j = bisect.bisect_right(tu, origin_wall + tape_ms) - 1
        now_tick = tick_unix[j][1] if j >= 0 else None
        plan.append((d, dyn_tick, ply_tick, now_tick))
    wanted = set()
    for _, a, b, c in plan:
        for x in (a, b):
            wanted.update((math.floor(x), math.floor(x) + 1))
        if c is not None:
            wanted.add(c)
    truth = {}
    for tick, _m, _u, players, vehicles, bodies in session_bundle.iter_world(os.path.join(server_dir, "world.bin"), wanted):
        if players is None:
            continue
        truth[tick] = {"p": {p["id"]: p["pos"] for p in players}, "v": {v["handle"]: v["pos"] for v in vehicles},
                       "b": {b["id"]: b["pos"] for b in bodies}, "h": {b["id"]: b["handle"] for b in bodies}}
    runs = {int(h): r for h, r in presence.items()}

    def streamed(handle, tape_ms):
        for a, b in runs.get(handle, ()):
            if a - 50 <= tape_ms <= b + 250:
                return True
        return False

    def at(tick_f, kind, ident):
        a, b = math.floor(tick_f), math.floor(tick_f) + 1
        pa, pb = truth.get(a, {}).get(kind, {}).get(ident), truth.get(b, {}).get(kind, {}).get(ident)
        if pa is None or pb is None:
            return pa or pb
        f = tick_f - a
        return [pa[k] + (pb[k] - pa[k]) * f for k in range(3)]

    dist = lambda x, y: math.sqrt(sum((x[k] - y[k]) ** 2 for k in range(3)))
    err = collections.defaultdict(list)
    matched = collections.Counter()
    missing = collections.Counter()
    for d, dyn_t, ply_t, now_t in plan:
        for b in d.get("bodies") or []:
            t = at(dyn_t, "b", b["id"])
            if t is None:
                missing["bodies_gone_on_server"] += 1
                continue
            handle = truth.get(math.floor(dyn_t), truth.get(math.floor(dyn_t) + 1, {})).get("h", {}).get(b["id"])
            if handle is not None and not streamed(handle, d["tapeMs"]):
                missing["bodies_not_streamed"] += 1
                err["stale_body_draw_m"].append(dist(b["position"], t))
                continue
            matched["bodies"] += 1
            err["bodies_at_render_time_m"].append(dist(b["position"], t))
            n = truth.get(now_t, {}).get("b", {}).get(b["id"])
            if n is not None:
                err["bodies_now_m"].append(dist(b["position"], n))
        for v in d.get("vehicles") or []:
            # The client keys vehicles by their snapshot handle; world.bin by server id and handle.
            t = at(ply_t, "v", v["id"])
            if t is None:
                missing["vehicles"] += 1
                continue
            matched["vehicles"] += 1
            err["vehicles_at_render_time_m"].append(dist(v["position"], t))
        for p in d.get("players") or []:
            t = at(ply_t, "p", p["id"])
            if t is None:
                missing["players"] += 1
                continue
            matched["players"] += 1
            err["remote_players_at_render_time_m"].append(dist(p["position"], t))
        if d.get("local") and now_t is not None:
            t = truth.get(now_t, {}).get("p", {}).get(d.get("playerId"))
            if t is not None:
                err["local_now_m"].append(dist(d["local"], t))
    out = {"samples": len(plan), "matched": dict(matched), "unmatched": dict(missing)}
    for k, v in err.items():
        out[k] = q(v, 3)
    for k in ("bodies_at_render_time_m", "local_now_m"):
        out.setdefault(k, {"n": 0, "p99": 0.0})
    return out


# ── time slices ────────────────────────────────────────────────────────────

def slice_rows(windows, server_ticks, clients_raw, levels):
    rows = []
    for name, a, b in windows:
        dur = max(1e-3, (b - a) / 1000)
        tk = [t for t in server_ticks if a <= t["unix_us"] / 1000 < b]
        tot = [t["total_ms"] for t in tk]
        row = {"window": name, "from_s": None, "dur_s": round(dur, 1),
               "server_tick_p50": q(tot).get("p50"), "server_tick_p95": q(tot).get("p95"), "server_tick_max": q(tot).get("max"),
               "server_pct_over_16_7": pct(sum(1 for x in tot if x > 16.667), len(tot), 1),
               "sim_rate": round(len(tk) / dur / 60, 3) if tk else None,
               "dynamics_ms_mean": round(sum(t["dynamics_ms"] for t in tk) / len(tk), 2) if tk else None,
               **levels.at(b)}
        for ci, raw in enumerate(clients_raw):
            if raw is None:
                continue
            u = raw["to_unix"]
            fm = [raw["fms"][k] for k, t in enumerate(raw["ft"]) if a <= u(t) < b]
            ld = [raw["lead"][k] for k, t in enumerate(raw["rt"]) if a <= u(t) < b]
            sn = sum(1 for t in raw["st"] if a <= u(t) < b)
            bk = sum(1 for t, _ in raw["back"] if a <= u(t) < b)
            city_b = sum(int(r["len"]) for r in raw["P"] if int(r["kind"]) in CITY_KINDS and a <= u(fnum(r["t_ms"])) < b)
            all_b = sum(int(r["len"]) for r in raw["P"] if a <= u(fnum(r["t_ms"])) < b)
            moving = 0
            if raw["stream"]:
                moving = sum(r["moving"] for r in raw["stream"]["perSecond"] if a <= u(r["s"] * 1000 + 500) < b)
            pre = f"c{ci}_"
            row.update({pre + "fps": round(len(fm) / dur, 1), pre + "frame_p95": q(fm).get("p95"),
                        pre + "pct_frames_over_2x": pct(sum(1 for x in fm if x > 2 * raw["period"]), len(fm), 1),
                        pre + "snapshots_per_s": round(sn / dur, 1), pre + "lead_p95": q(ld, 1).get("p95"),
                        pre + "pct_extrapolating": pct(sum(1 for x in ld if x > 0), len(ld), 1),
                        pre + "backward_steps": bk, pre + "city_kB_s": round(city_b / 1000 / dur, 1),
                        pre + "in_kB_s": round(all_b / 1000 / dur, 1),
                        pre + "city_B_per_moving_body_s": round(city_b / moving, 1) if moving else None})
        rows.append(row)
    return rows


# ── budgets and baseline ───────────────────────────────────────────────────

OPS = {"<": lambda a, b: a < b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b, ">=": lambda a, b: a >= b}


def evaluate_budgets(report, cfg):
    results = []
    for b in cfg.get("budgets", []):
        metric = b["metric"]
        if metric.startswith("clients.*."):
            vals = [(f"c{c['client']}", get_path(c, metric[len("clients.*."):])) for c in report["clients"]]
        else:
            vals = [("", get_path(report, metric))]
        vals = [(w, v) for w, v in vals if isinstance(v, (int, float))]
        if not vals:
            results.append({**b, "status": "n/a", "observed": None})
            continue
        fails = [(w, v) for w, v in vals if not OPS[b["op"]](v, b["value"])]
        worst = (max if b["op"] in ("<", "<=") else min)(vals, key=lambda x: x[1])
        status = "pass" if not fails else ("fail" if b.get("enabled", True) else "fail (not gating)")
        results.append({"id": b["id"], "metric": metric, "op": b["op"], "value": b["value"], "why": b.get("why"),
                        "observed": worst[1], "where": worst[0], "status": status})
    return results


def headline(report):
    """The flat numbers a baseline comparison looks at."""
    h = {}
    s = report["server"]
    for k in ("p50", "p95", "p99", "max"):
        h[f"server.tick_{k}_ms"] = (s.get("tick_ms") or {}).get(k)
    h["server.pct_over_16_7ms"] = s.get("pct_ticks_over_16_7ms")
    h["server.sim_rate"] = s.get("sim_rate")
    h["server.sim_rate_5s_min"] = s.get("sim_rate_5s_min")
    h["server.dynamics_ms_mean"] = ((s.get("breakdown") or {}).get("dynamics_ms") or {}).get("mean")
    h["server.gpu_wait_p95_ms"] = ((s.get("physics_sampled") or {}).get("physics_gpu_wait_ms") or {}).get("p95")
    h["server.broken_bond_pct"] = (s.get("destruction") or {}).get("broken_bond_pct")
    h["server.peak_active_bodies"] = (s.get("destruction") or {}).get("peak_active_bodies")
    for c in report["clients"]:
        p = f"c{c['client']}."
        f = c.get("frames") or {}
        h[p + "frame_p95_ms"] = (f.get("frame_ms") or {}).get("p95")
        h[p + "pct_frames_over_2x"] = f.get("pct_over_2x_display")
        h[p + "hitches_over_100ms"] = f.get("hitches_over_100ms")
        h[p + "snapshots_per_tick"] = (c.get("snapshots") or {}).get("per_server_tick")
        h[p + "lead_p95_ms"] = ((c.get("interpolation") or {}).get("lead_ms") or {}).get("p95")
        h[p + "pct_extrapolating"] = (c.get("interpolation") or {}).get("pct_frames_extrapolating")
        h[p + "backward_steps"] = (c.get("interpolation") or {}).get("render_clock_backward_steps")
        h[p + "meteor_backward_frames"] = (c.get("meteors") or {}).get("backward_frames")
        h[p + "kbps_avg"] = (c.get("bandwidth") or {}).get("kbps_avg")
        h[p + "city_B_per_moving_body_s"] = (c.get("efficiency") or {}).get("city_bytes_per_moving_body_s")
        h[p + "latency_p99_ms"] = ((c.get("transport") or {}).get("latency_ms") or {}).get("p99")
        h[p + "structure_repairs"] = (c.get("sync") or {}).get("structure_repairs")
        h[p + "body_render_err_p99_m"] = ((c.get("render_error") or {}).get("bodies_at_render_time_m") or {}).get("p99")
        h[p + "stale_body_draws"] = ((c.get("render_error") or {}).get("unmatched") or {}).get("bodies_not_streamed", 0)
        h[p + "hitches_cpu_bound_33ms"] = f.get("cpu_bound_over_33ms")
        h[p + "meteor_hold_jump_max_m"] = ((c.get("meteors") or {}).get("hold_to_body_jump_m") or {}).get("max")
    return h


def compare(cur, base):
    rows = []
    for k, v in cur.items():
        b = base.get(k)
        if isinstance(v, (int, float)) and isinstance(b, (int, float)):
            rows.append({"metric": k, "baseline": b, "current": v, "delta": round(v - b, 3),
                         "delta_pct": round(100 * (v - b) / abs(b), 1) if b else None})
    return rows


# ── markdown ───────────────────────────────────────────────────────────────

def fmt(v, digits=2):
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return str(v)


def table(rows, cols, heads=None):
    heads = heads or cols
    out = ["| " + " | ".join(heads) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        out.append("| " + " | ".join(fmt(r.get(c)) for c in cols) + " |")
    return "\n".join(out)


def write_md(report, path):
    s, run = report["server"], report["run"]
    L = [f"# City bench: {run['label']}", ""]
    L.append(f"Run `{run['run_id']}` — scenario **{run['scenario']}** ({run['buildings_destroyed']} buildings, "
             f"{run['clients']} client(s), intensity {run['intensity']}, seed {run['seed']}); status **{run['status']}**; "
             f"tape {fmt(run.get('tape_s'), 0)} s.")
    b = report["build"]
    L.append(f"Build: vibe-land `{b.get('vibe_land')}` (server fingerprint `{b.get('server_git')}`), PhysX SDK `{b.get('physx_sdk')}`, "
             f"cuda-metal `{b.get('cuda_metal_head')}` (libcumetal {b.get('libcumetal_mtime')}), {b.get('machine')}.")
    if report["errors"]:
        L.append("")
        L.append("**Errors:** " + "; ".join(report["errors"][:10]))
    fails = [x for x in report["budgets"] if x["status"] == "fail"]
    L += ["", f"## Verdict: {'PASS' if not fails else f'FAIL ({len(fails)} of {len(report['budgets'])} budgets)'}", ""]
    L.append(table([{**x, "observed": x["observed"], "limit": f"{x['op']} {x['value']}", "where": x.get("where") or ""}
                    for x in report["budgets"]], ["status", "id", "observed", "limit", "where"]))
    L += ["", "## Server real-time", ""]
    t = s.get("tick_ms") or {}
    L.append(f"- Tick p50/p95/p99/max: {fmt(t.get('p50'))} / {fmt(t.get('p95'))} / {fmt(t.get('p99'))} / {fmt(t.get('max'))} ms; "
             f"{fmt(s.get('pct_ticks_over_16_7ms'))}% over 16.7 ms, {fmt(s.get('pct_ticks_over_33ms'))}% over 33 ms, "
             f"{s.get('ticks_over_100ms')} over 100 ms ({s.get('ticks')} ticks).")
    L.append(f"- Sim rate: {fmt(s.get('sim_rate'), 3)} (worst 5 s window {fmt(s.get('sim_rate_5s_min'), 3)}).")
    br = s.get("breakdown") or {}
    L.append("- Tick breakdown (mean ms, share): " + ", ".join(
        f"{k[:-3]} {fmt((v or {}).get('mean'), 2)} ({fmt((v or {}).get('share_pct'), 1)}%)" for k, v in br.items() if (v or {}).get("share_pct")))
    ps = s.get("physics_sampled") or {}
    L.append(f"- PhysX last step / GPU wait (1 Hz samples) p50/p95/max: "
             f"{fmt(ps.get('physics_last_step_ms', {}).get('p50'))}/{fmt(ps.get('physics_last_step_ms', {}).get('p95'))}/{fmt(ps.get('physics_last_step_ms', {}).get('max'))} ms, "
             f"{fmt(ps.get('physics_gpu_wait_ms', {}).get('p50'))}/{fmt(ps.get('physics_gpu_wait_ms', {}).get('p95'))}/{fmt(ps.get('physics_gpu_wait_ms', {}).get('max'))} ms.")
    ce = s.get("city_encoder") or {}
    if ce:
        L.append(f"- City encoder: step p95 {fmt(ce['step_ms'].get('p95'), 3)} ms, encode p95 {fmt(ce['encode_ms'].get('p95'), 3)} ms, "
                 f"{fmt(ce.get('bytes_per_awake_body_tick'), 1)} B per awake body-tick, outbound drops {ce.get('outbound_drops')}.")
    d = s.get("destruction") or {}
    L.append(f"- Destruction reached: {d.get('broken_bonds')} of {d.get('total_bonds')} bonds broken ({fmt(d.get('broken_bond_pct'), 1)}%), "
             f"{d.get('chunk_bodies')} chunk bodies, peak {d.get('peak_active_bodies')} active bodies; r(tick, active bodies) = {fmt(s.get('r_tick_vs_active_bodies'))}; "
             f"bodies below -3 m: {s.get('bodies_below_ground')}; 'left the world' log lines: {s.get('left_the_world_log_lines')}; "
             f"went through the ground (first tick logged): {s.get('went_through_ground_log_lines')}; retired at the floor: {s.get('retired_at_floor_log_lines')}.")
    L += ["", "Tick cost against destruction level:", ""]
    L.append(table(s.get("by_destruction_level") or [], ["by", "bucket", "ticks", "tick_p50", "tick_p95", "tick_max", "pct_over_16_7ms"]))
    L += ["", "## Clients at a glance", ""]
    L.append(table([{
        "client": c["client"], "role": c["role"], "fps": (c.get("frames") or {}).get("avg_fps"),
        "frame_p95": ((c.get("frames") or {}).get("frame_ms") or {}).get("p95"),
        "pct_over_2x": (c.get("frames") or {}).get("pct_over_2x_display"),
        "snaps_per_tick": (c.get("snapshots") or {}).get("per_server_tick"),
        "lead_p95": ((c.get("interpolation") or {}).get("lead_ms") or {}).get("p95"),
        "pct_extrap": (c.get("interpolation") or {}).get("pct_frames_extrapolating"),
        "back_steps": (c.get("interpolation") or {}).get("render_clock_backward_steps"),
        "kbps": (c.get("bandwidth") or {}).get("kbps_avg"),
        "lat_p99": ((c.get("transport") or {}).get("latency_ms") or {}).get("p99"),
        "lost": (c.get("transport") or {}).get("lost_packets"),
        "repairs": (c.get("sync") or {}).get("structure_repairs"),
        "body_err_p99": ((c.get("render_error") or {}).get("bodies_at_render_time_m") or {}).get("p99"),
    } for c in report["clients"]], ["client", "role", "fps", "frame_p95", "pct_over_2x", "snaps_per_tick", "lead_p95",
                                    "pct_extrap", "back_steps", "kbps", "lat_p99", "lost", "repairs", "body_err_p99"]))
    for c in report["clients"]:
        f, n, it, m = c.get("frames", {}), c.get("snapshots", {}), c.get("interpolation", {}), c.get("meteors", {})
        tr, bw, sy, ef, re_ = c.get("transport", {}), c.get("bandwidth", {}), c.get("sync", {}), c.get("efficiency", {}), c.get("render_error", {})
        L += ["", f"## Client {c['client']} ({c['role']})", ""]
        fm = f.get("frame_ms", {})
        L.append(f"- Frames: {fmt(f.get('avg_fps'), 1)} fps; frame p50/p95/p99 {fmt(fm.get('p50'))}/{fmt(fm.get('p95'))}/{fmt(fm.get('p99'))} ms "
                 f"against a {fmt(f.get('display_period_ms'))} ms display period ({fmt(f.get('p95_over_display'))}x); "
                 f"{fmt(f.get('pct_over_2x_display'))}% over 2x; CPU p50/p95 {fmt(f.get('cpu_ms', {}).get('p50'))}/{fmt(f.get('cpu_ms', {}).get('p95'))} ms; "
                 f"hitches >100 ms: {f.get('hitches_over_100ms')}, CPU-bound >33 ms: {f.get('cpu_bound_over_33ms')}; "
                 f"r(fps, server ticks/s) = {fmt(c.get('r_client_fps_vs_server_ticks_per_s'))}.")
        ia = n.get("interarrival_ms", {})
        L.append(f"- Snapshots: {fmt(n.get('rate_hz'), 1)} Hz, {fmt(n.get('per_server_tick'), 3)} per server tick; arrival gaps p50/p99/max "
                 f"{fmt(ia.get('p50'))}/{fmt(ia.get('p99'))}/{fmt(ia.get('max'))} ms; {n.get('gaps_over_100ms')} gaps over 100 ms.")
        ld = it.get("lead_ms", {})
        L.append(f"- Interpolation: render lead over newest snapshot p50/p95/p99 {fmt(ld.get('p50'), 1)}/{fmt(ld.get('p95'), 1)}/{fmt(ld.get('p99'), 1)} ms; "
                 f"{fmt(it.get('pct_frames_extrapolating'))}% of frames extrapolating; render clock stepped back {it.get('render_clock_backward_steps')} times "
                 f"({fmt(it.get('render_clock_backward_total_ms'), 0)} ms); dyn delay p50 {fmt(it.get('dyn_delay_ms', {}).get('p50'))} ms.")
        L.append(f"- Meteors: {m.get('meteors')} drawn, {m.get('with_backward_motion')} moved backwards ({m.get('backward_frames')} frames, max {fmt(m.get('max_backward_m'), 1)} m); "
                 f"arc→body jump p50/max {fmt(m.get('arc_to_body_jump_m', {}).get('p50'), 1)}/{fmt(m.get('arc_to_body_jump_m', {}).get('max'), 1)} m; "
                 f"hold→body max {fmt(m.get('hold_to_body_jump_m', {}).get('max'), 1)} m; drawn below ground {m.get('drawn_below_ground_frames')} frames.")
        lat = tr.get("latency_ms") or {}
        L.append(f"- Transport: {tr.get('join_matched')} taped packets joined to sends; lost {tr.get('lost_packets')}, server drops {tr.get('server_drops')}; "
                 f"send→arrive p50/p99/max {fmt(lat.get('p50'))}/{fmt(lat.get('p99'))}/{fmt(lat.get('max'))} ms.")
        L.append(f"- Bandwidth: {fmt(bw.get('kbps_avg'), 0)} kbps average, {fmt(bw.get('kbps_peak_1s'), 0)} kbps peak second; match stats {fmt(bw.get('match_stats_pct_of_bytes'))}% of bytes; "
                 f"energy {fmt(bw.get('energy_msgs_per_s'), 1)} msg/s.")
        L.append("")
        L.append(table([{"kind": k, **v} for k, v in (bw.get("by_kind") or {}).items()][:12],
                       ["kind", "kB", "packets", "kB_per_s", "packets_per_s", "pct_of_bytes", "peak_kB_s"]))
        L.append("")
        L.append(f"- Sync: {sy.get('structure_repairs')} structure repairs ({fmt(sy.get('structure_repair_kB'), 1)} kB), "
                 f"{sy.get('full_bootstraps_after_start')} full bootstraps after start, datagram gaps {sy.get('datagram_seq_gaps')}, topology gaps {sy.get('topology_seq_gaps')} "
                 f"→ repairs without loss: {sy.get('repairs_without_loss')}; city sends at the 10 kB ceiling {sy.get('ceiling_sends')}/{sy.get('city_sends')}; "
                 f"client counters {json.dumps({k: v for k, v in (sy.get('client_counters_end') or {}).items() if v})}.")
        if ef:
            L.append(f"- Efficiency: {fmt(ef.get('city_bytes_per_moving_body_s'), 1)} city bytes per moving body-second, {fmt(ef.get('city_bytes_per_record'))} B/record, "
                     f"repeat records {fmt(ef.get('city_repeat_records_pct'))}% ({fmt(ef.get('city_repeat_kB'), 1)} kB), snapshot {fmt(ef.get('snapshot_bytes_mean'), 0)} B mean, "
                     f"unchanged snapshot bodies {fmt(ef.get('snapshot_body_repeat_pct'))}%; server city selection {json.dumps(ef.get('server_city_selection'))}.")
        L.append(f"- Rendered vs server truth ({re_.get('samples')} samples; matched {json.dumps(re_.get('matched'))}): " + ", ".join(
            f"{k} p50/p99/max {fmt(v.get('p50'), 3)}/{fmt(v.get('p99'), 3)}/{fmt(v.get('max'), 3)}" for k, v in re_.items()
            if isinstance(v, dict) and v.get("n")))
        if f.get("worst_hitches"):
            L += ["", "Worst hitches:", ""]
            L.append(table(f["worst_hitches"][:8], ["t_s", "phase", "frame_ms", "cpu_ms", "cpu_bound", "server_tick_max_ms_near"]))
    L += ["", "## By phase", ""]
    cols = ["window", "dur_s", "server_tick_p95", "server_pct_over_16_7", "sim_rate", "active_bodies", "broken_bonds",
            "c0_frame_p95", "c0_pct_frames_over_2x", "c0_snapshots_per_s", "c0_lead_p95", "c0_pct_extrapolating", "c0_backward_steps", "c0_city_kB_s"]
    L.append(table(report["slices"]["coarse"], cols))
    L += ["", "Per building:", ""]
    L.append(table(report["slices"]["buildings"], cols))
    L += ["", "## Per 5 s", ""]
    L.append(table(report["slices"]["per_5s"], ["window"] + cols[2:]))
    if report.get("baseline"):
        L += ["", f"## Against baseline `{report['baseline']['path']}`", ""]
        L.append(table(report["baseline"]["rows"], ["metric", "baseline", "current", "delta", "delta_pct"]))
    if report["notes"]:
        L += ["", "## Notes", ""] + [f"- {n}" for n in report["notes"]]
    L += ["", "Measured: everything above is read from the tapes, the server capture, /match-stats samples and the server log. "
          "PhysX step/GPU wait are 1 Hz samples of the last step, not every tick. Render error at render time depends on the client's "
          "recorded clock offset; 'now' error includes the intended interpolation delay."]
    open(path, "w").write("\n".join(L) + "\n")


# ── main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("run_dir")
    ap.add_argument("--budgets", default=os.path.join(HERE, "budgets.json"))
    ap.add_argument("--baseline")
    ap.add_argument("--no-decode", action="store_true")
    ap.add_argument("--no-charts", action="store_true")
    a = ap.parse_args()
    run_dir = os.path.abspath(a.run_dir)
    run = json.load(open(os.path.join(run_dir, "run.json")))
    cfg = json.load(open(a.budgets))
    notes = []
    tl = Timeline(run)
    server_log = os.path.join(run_dir, "server.log")
    log_text = re.sub(r"\x1b\[[0-9;]*m", "", open(server_log, errors="replace").read()) if os.path.exists(server_log) else ""
    stats = read_jsonl(os.path.join(run_dir, "server-stats.jsonl"))
    levels = Levels(stats)
    sessions = [s for s in run.get("sessions", []) if s.get("uploadFolder")]
    if not sessions:
        print("no session bundle to analyse", file=sys.stderr)
        sys.exit(2)
    bundles = {s["client"]: os.path.join(run_dir, "debug-reports", s["uploadFolder"]) for s in sessions}
    first = bundles[min(bundles)]
    manifest = json.load(open(os.path.join(first, "session.json")))
    server_dir = os.path.normpath(os.path.join(first, (manifest.get("server") or {}).get("dir", "server")))
    # The measured window: every tape's span.
    spans = []
    for c, bdir in bundles.items():
        adir = os.path.join(run_dir, "analysis", f"c{c}")
        if not a.no_decode:
            notes += [f"client {c}: {n}" for n in decode_tape(os.path.join(bdir, "client.vltape"), adir, not a.no_charts, server_log)]
        h = json.load(open(os.path.join(adir, "header.json")))
        spans.append((h["wallClockOriginMs"], h["wallClockOriginMs"] + h["durationMs"]))
    window = (min(x[0] for x in spans), max(x[1] for x in spans))
    srv, ticks = server_metrics(server_dir, stats, window, levels, tl, log_text)
    wb = world_below_ground(server_dir, ticks[0]["tick"], ticks[-1]["tick"]) if ticks else None
    clients, raws = [], []
    for c in sorted(bundles):
        adir = os.path.join(run_dir, "analysis", f"c{c}")
        try:
            m, raw = client_metrics(c, bundles[c], adir, run_dir, tl, cfg, ticks, levels, notes)
            info = next((x for x in run.get("clientInfo", []) if x["index"] == c), {})
            m["renderer"] = info.get("renderer")
            clients.append(m)
            raws.append(raw)
        except Exception as e:  # noqa: BLE001
            import traceback
            notes.append(f"client {c}: analysis failed: {e} {traceback.format_exc()[-600:]}")
            raws.append(None)
    chunk_below = max((c.get("efficiency", {}).get("chunk_bodies_below_ground") or 0 for c in clients), default=0)
    srv["bodies_below_ground"] = (wb or 0) + chunk_below
    srv["bodies_below_ground_detail"] = {"meteors_balls_world_bin": wb, "city_chunk_bodies_streamed": chunk_below}

    # Build identity.
    b = (manifest.get("server") or {}).get("build") or {}
    fp = b.get("fingerprint") or {}
    m = re.search(r"physx_sdk=(\S+)", log_text)
    libcm = "/Users/glavin/Development/PhysX/out/install/macos-cumetal/release/lib/libcumetal.dylib"
    build = {
        "server_build": b.get("server_build"), "server_git": fp.get("git"), "server_binary": fp.get("binary"),
        "physics_backend": b.get("physics_backend"), "cuda_stress": fp.get("cuda_stress"),
        "physx_sdk": m.group(1) if m else None,
        "physx_repo_head": git("/Users/glavin/Development/PhysX", "rev-parse", "--short", "HEAD"),
        "cuda_metal_head": git("/Users/glavin/Development/cuda-metal", "rev-parse", "--short", "HEAD"),
        "libcumetal_mtime": datetime.datetime.fromtimestamp(os.path.getmtime(libcm)).isoformat(timespec="seconds") if os.path.exists(libcm) else None,
        "vibe_land": (git(ROOT, "rev-parse", "--short", "HEAD") or "") + ("-dirty" if git(ROOT, "status", "--porcelain", "--untracked-files=no") else ""),
        "cumetal_warnings": sorted(set(re.findall(r"CUMETAL WARNING: (CUMETAL_\w+)", log_text))),
        "machine": subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip(),
        "client_renderer": clients[0].get("renderer") if clients else None,
    }

    # Time slices.
    coarse = [(name, a_, b_) for name, (a_, b_) in tl.coarse().items()]
    per_building = collections.OrderedDict()
    for p in tl.phases:
        if p["phase"].startswith("building-"):
            x = per_building.get(p["phase"], (p["startUnixMs"], p["endUnixMs"]))
            per_building[p["phase"]] = (min(x[0], p["startUnixMs"]), max(x[1], p["endUnixMs"]))
    per5 = []
    t = window[0]
    while t < window[1] - 1000:
        per5.append((f"{(t - window[0]) / 1000:.0f}-{(min(t + 5000, window[1]) - window[0]) / 1000:.0f}s", t, min(t + 5000, window[1])))
        t += 5000
    slices = {"coarse": slice_rows(coarse, ticks, raws, levels),
              "buildings": slice_rows([(k, a_, b_) for k, (a_, b_) in per_building.items()], ticks, raws, levels),
              "per_5s": slice_rows(per5, ticks, raws, levels)}

    report = {
        "format": "city-bench-report/1",
        "run": {"label": os.path.basename(run_dir), "run_id": run.get("runId"), "status": run.get("status"),
                "scenario": run.get("scenario", {}).get("name"), "clients": run.get("clients"),
                "buildings_destroyed": len(run.get("buildings") or []), "intensity": run.get("intensity"), "seed": run.get("seed"),
                "planned_s": run.get("plannedSeconds"), "tape_s": round((window[1] - window[0]) / 1000, 1),
                "record_start_unix_ms": tl.t0, "window_unix_ms": list(window),
                "failed_steps": [f"{p['phase']}:{p['do']}: {p['note']}" for p in tl.phases if not p.get("ok")]},
        "build": build, "errors": run.get("errors", []), "server": srv, "clients": clients, "slices": slices,
        "phases": tl.phases, "notes": notes,
    }
    report["budgets"] = evaluate_budgets(report, cfg)
    report["headline"] = headline(report)
    if a.baseline:
        base = json.load(open(a.baseline))
        report["baseline"] = {"path": a.baseline, "rows": compare(report["headline"], base.get("headline") or headline(base))}
        br, cr = base.get("run") or {}, report["run"]
        if (br.get("scenario"), br.get("clients"), br.get("buildings_destroyed")) != (cr["scenario"], cr["clients"], cr["buildings_destroyed"]):
            notes.append(f"baseline ran a different plan ({br.get('scenario')}, {br.get('clients')} clients, {br.get('buildings_destroyed')} buildings): deltas compare different workloads")
        bb = (base.get("headline") or {}).get("server.broken_bond_pct")
        cb = report["headline"].get("server.broken_bond_pct")
        if isinstance(bb, (int, float)) and isinstance(cb, (int, float)) and abs(bb - cb) > 10:
            notes.append(f"destruction reached differs from the baseline ({bb}% vs {cb}% of bonds): compare the per-level tables, not only totals")
    json.dump(report, open(os.path.join(run_dir, "report.json"), "w"), indent=1, default=str)
    write_md(report, os.path.join(run_dir, "report.md"))
    fails = [x for x in report["budgets"] if x["status"] == "fail"]
    print(f"report: {os.path.join(run_dir, 'report.md')}")
    print(f"verdict: {'PASS' if not fails else 'FAIL'} ({len(report['budgets']) - len(fails)}/{len(report['budgets'])} budgets pass)")
    for x in report["budgets"]:
        print(f"  {x['status']:5s} {x['id']:28s} observed {fmt(x['observed'])} {x.get('where') or ''} (limit {x['op']} {x['value']})")
    if report.get("baseline"):
        print("\nagainst baseline:")
        for r in report["baseline"]["rows"]:
            print(f"  {r['metric']:34s} {fmt(r['baseline']):>10s} -> {fmt(r['current']):>10s}  ({'+' if (r['delta'] or 0) >= 0 else ''}{fmt(r['delta'])}, {fmt(r['delta_pct'], 1)}%)")
    for n in notes:
        print(f"note: {n}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
