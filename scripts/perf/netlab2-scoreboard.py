#!/usr/bin/env python3
"""Netcode scoreboard: before/after tables from Netlab v2 runs.

  scripts/perf/netlab2-scoreboard.py lag <runDir>...
      Reads each run's presented.bin (the city presentation per frame) and
      writes presented-lag.json beside it: how far the presented city tick
      (render tick minus the playout delay) is behind the server's completed
      tick, per frame. Run it before pruning presented.bin.

  scripts/perf/netlab2-scoreboard.py table --before <dir> --after <dir>
      [--title T] [--links a,b,...] [--before-no-trailer] [--md out.md]
      [--detail out.md] [--json out.json]
      <dir> holds one run directory per link (named after the link, or
      `<link>__<set>` as `netlab2 matrix` names them). Writes one headline
      table (before -> after per link) and a per-class detail table.

Nothing is re-scored: every number is read from what `netlab2 run` wrote
(report.json, stream.json, client-stats.json) or from presented.bin.
docs/netcode-tuning.md "Netcode scoreboard (2026-09-24)" is the table this
produces and says what "before" means.

`--before-no-trailer`: the pre-0eb6f3fd server sent SnapshotV2 without the
4-byte wall-clock trailer. The lab's snapshot builder always writes it, so the
before arm's snapshot bytes are reported less 4 B per delivered snapshot.
"""
import argparse
import json
import os
import struct
import sys

NETCODE_KINDS = {
    "snapshot_v2": "snap",
    "snapshot_v1": "snap",
    "city_chunks": "city",
    "city_debris": "city",
    "city_topology": "city",
    "city_baseline": "city",
    "city_topo_hash": "city",
    "city_bootstrap": "city",
    "city_structure_bootstrap": "city",
}
CLASSES = ["player", "vehicle", "body", "meteor", "chunk_intact", "chunk_debris", "chunk_rubble"]
TICK_MS = 1000.0 / 60.0
SNAPSHOT_V2_TRAILER_BYTES = 4


# ── presented.bin ───────────────────────────────────────────────────────────

def read_presented(path):
    """(sim_tick, presented_tick) per frame from a VLPRES01 file."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] == b"\x28\xb5\x2f\xfd":
        try:
            import zstandard  # type: ignore
        except ImportError:
            sys.exit(f"{path} is zstd-compressed and this Python has no zstandard module")
        data = zstandard.ZstdDecompressor().decompressobj().decompress(data)
    if data[:8] != b"VLPRES01":
        raise ValueError(f"{path}: not a VLPRES01 file")
    (first_tick,) = struct.unpack_from("<I", data, 16)
    at = 20
    out = []
    n_data = len(data)
    while at + 16 <= n_data:
        sim_tick, render_tick, playout, changed = struct.unpack_from("<Iffi", data, at)
        at += 16 + changed * 32
        (retired,) = struct.unpack_from("<I", data, at)
        at += 4 + retired * 4
        # Frames drawn before the server capture's first tick have no server
        # tick to compare with (the timeline clamps them to its first).
        if sim_tick > first_tick:
            out.append((sim_tick, render_tick - playout))
    return out


def percentile(values, q):
    if not values:
        return None
    s = sorted(values)
    i = min(len(s) - 1, max(0, int(round(q / 100.0 * (len(s) - 1)))))
    return s[i]


def cmd_lag(dirs):
    for run in dirs:
        path = os.path.join(run, "presented.bin")
        if not os.path.exists(path):
            print(f"{run}: no presented.bin", file=sys.stderr)
            continue
        frames = read_presented(path)
        # Frames before the city presentation started (render tick 0) are left out.
        lags = [p - s for s, p in frames if p > 0 and s > 0]
        stopped = 0
        for (s0, p0), (s1, p1) in zip(frames, frames[1:]):
            if p0 > 0 and s1 > s0 and (p1 - p0) < 0.05 * (s1 - s0):
                stopped += 1
        summary = {
            "frames": len(lags),
            "presented_minus_server_ticks": {
                q: percentile(lags, float(q[1:])) for q in ("p1", "p5", "p50", "p95", "p99")
            },
            "mean_ticks": sum(lags) / len(lags) if lags else None,
            "frames_stopped_share": stopped / max(1, len(frames) - 1),
        }
        with open(os.path.join(run, "presented-lag.json"), "w") as fh:
            json.dump(summary, fh, indent=1)
        p = summary["presented_minus_server_ticks"]
        print(f"{run}: presented - server p50 {p['p50']:.1f} p1 {p['p1']:.1f} ticks, stopped {summary['frames_stopped_share']:.1%}")


# ── one run ─────────────────────────────────────────────────────────────────

def load_run(run, no_trailer=False):
    report = json.load(open(os.path.join(run, "report.json")))
    stream = json.load(open(os.path.join(run, "stream.json")))
    card = report["card"]
    dur = stream["duration_s"] or 1.0
    kb = {"snap": 0.0, "city": 0.0, "other": 0.0}
    for kind, t in stream["kinds"].items():
        b = t["delivered_bytes"]
        if kind == "snapshot_v2" and no_trailer:
            b -= SNAPSHOT_V2_TRAILER_BYTES * t["delivered"]
        kb[NETCODE_KINDS.get(kind, "other")] += b * 8 / dur / 1000
    ad = report.get("all_draws") or card.get("all_draws") or {}
    clock = card.get("clock", {})
    lag_path = os.path.join(run, "presented-lag.json")
    lag = json.load(open(lag_path)) if os.path.exists(lag_path) else None
    cs_path = os.path.join(run, "client-stats.json")
    cs = json.load(open(cs_path)) if os.path.exists(cs_path) else {}
    cs = cs[0] if isinstance(cs, list) else cs
    dg = stream["lanes"].get("datagram", {})
    return {
        "run": run,
        "kbps_snap": kb["snap"],
        "kbps_city": kb["city"],
        "kbps_net": kb["snap"] + kb["city"],
        "kbps_all": kb["snap"] + kb["city"] + kb["other"],
        "dg_p50": (dg.get("latency_ms") or {}).get("p50"),
        "dg_p99": (dg.get("latency_ms") or {}).get("p99"),
        "dg_lost": dg.get("by_fate", {}).get("lost", 0),
        "behind_p50": (clock.get("dyn_behind_now_ms") or {}).get("p50"),
        "dyn_delay_p50": (clock.get("dyn_delay_ms") or {}).get("p50"),
        "backsteps": clock.get("render_backsteps", 0) + clock.get("dyn_backsteps", 0),
        "backstep_max_ms": max(clock.get("render_backstep_max_ms", 0), clock.get("dyn_backstep_max_ms", 0)),
        "lag": lag,
        "ad": ad,
        "repairs": (ad.get("city_sync") or {}).get("repairs_asked", cs.get("resyncRequestsSent")),
        "wasm_clock": cs.get("usesWasmClock"),
        "client_root": cs.get("clientRoot"),
    }


# ── formatting ──────────────────────────────────────────────────────────────

def fm(v, d=3):
    if v is None:
        return "-"
    if isinstance(v, (int,)) or (isinstance(v, float) and v.is_integer() and abs(v) >= 1000):
        return f"{int(v):,}"
    return f"{v:.{d}f}"


def arrow(a, b, d=3):
    return f"{fm(a, d)} → {fm(b, d)}"


def pos(ad, cls, which, q):
    if cls == "overall":
        c = ad.get("overall") or {}
    else:
        c = (ad.get("classes") or {}).get(cls) or {}
    return (c.get(which) or {}).get(q)


def trio(ad, cls, which):
    return "/".join(fm(pos(ad, cls, which, q)) for q in ("p50", "p95", "p99"))


def first_draw(ad, cls, q):
    return (((ad.get("first_draw") or {}).get(cls) or {}).get("delay_ms") or {}).get(q)


def lagq(r, q):
    lag = r["lag"]
    return lag["presented_minus_server_ticks"][q] if lag else None


def find_runs(root):
    out = {}
    for name in sorted(os.listdir(root)):
        run = os.path.join(root, name)
        if os.path.exists(os.path.join(run, "report.json")):
            out[name.split("__")[0]] = run
    return out


def cmd_table(args):
    before = find_runs(args.before)
    after = find_runs(args.after)
    links = args.links.split(",") if args.links else [l for l in after if l in before]
    rows = []
    for link in links:
        if link not in before or link not in after:
            print(f"skip {link}: missing in {'before' if link not in before else 'after'}", file=sys.stderr)
            continue
        rows.append((link, load_run(before[link], args.before_no_trailer), load_run(after[link])))

    md = []
    title = args.title or ""
    md.append(f"**{title}** (before → after; each cell is the same frozen truth and link seed)\n" if title else "")
    md.append("| Link | Netcode kbit/s (snapshot + city) | All kinds kbit/s | Presented − server tick p50 / p1 | Bodies drawn behind server p50 ms "
              "| Island first draw p50 / p99 ms | Body first draw p50 / p99 ms | ALL pos@render p50/p95/p99 m | ALL pos@now p50/p95/p99 m "
              "| Missing / extra / wrong identity | Clock back-steps | Repairs asked |")
    md.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for link, b, a in rows:
        bad, aad = b["ad"], a["ad"]
        def mew(ad):
            o = ad.get("overall") or {}
            return f"{fm(o.get('missing'), 0)} / {fm(o.get('extra'), 0)} / {fm(o.get('wrong_identity'), 0)}"
        md.append(
            f"| {link} | {arrow(b['kbps_net'], a['kbps_net'], 1)} | {arrow(b['kbps_all'], a['kbps_all'], 1)} "
            f"| {fm(lagq(b, 'p50'), 1)} / {fm(lagq(b, 'p1'), 1)} → {fm(lagq(a, 'p50'), 1)} / {fm(lagq(a, 'p1'), 1)} "
            f"| {arrow(b['behind_p50'], a['behind_p50'], 1)} "
            f"| {fm(first_draw(bad, 'island', 'p50'), 0)} / {fm(first_draw(bad, 'island', 'p99'), 0)} → {fm(first_draw(aad, 'island', 'p50'), 0)} / {fm(first_draw(aad, 'island', 'p99'), 0)} "
            f"| {fm(first_draw(bad, 'body', 'p50'), 0)} / {fm(first_draw(bad, 'body', 'p99'), 0)} → {fm(first_draw(aad, 'body', 'p50'), 0)} / {fm(first_draw(aad, 'body', 'p99'), 0)} "
            f"| {trio(bad, 'overall', 'pos_render_m')} → {trio(aad, 'overall', 'pos_render_m')} "
            f"| {trio(bad, 'overall', 'pos_now_m')} → {trio(aad, 'overall', 'pos_now_m')} "
            f"| {mew(bad)} → {mew(aad)} | {fm(b['backsteps'], 0)} → {fm(a['backsteps'], 0)} | {fm(b['repairs'], 0)} → {fm(a['repairs'], 0)} |"
        )
    detail = []
    detail.append(f"**{title}, per class** (pos@render p50/p95/p99 m; pos@now p50/p95/p99 m; missing / extra / wrong identity)\n")
    detail.append("| Link | Class | pos@render before → after | pos@now before → after | m / e / w before → after |")
    detail.append("|---|---|---|---|---|")
    for link, b, a in rows:
        for cls in CLASSES:
            bc = (b["ad"].get("classes") or {}).get(cls)
            ac = (a["ad"].get("classes") or {}).get(cls)
            if not bc and not ac:
                continue
            def mew(c):
                if not c:
                    return "-"
                return f"{fm(c.get('missing'), 0)} / {fm(c.get('extra'), 0)} / {fm(c.get('wrong_identity'), 0)}"
            detail.append(
                f"| {link} | {cls} | {trio(b['ad'], cls, 'pos_render_m')} → {trio(a['ad'], cls, 'pos_render_m')} "
                f"| {trio(b['ad'], cls, 'pos_now_m')} → {trio(a['ad'], cls, 'pos_now_m')} | {mew(bc)} → {mew(ac)} |"
            )
    text = "\n".join(md)
    dtext = "\n".join(detail)
    if args.md:
        open(args.md, "w").write(text + "\n")
    if args.detail:
        open(args.detail, "w").write(dtext + "\n")
    if args.json:
        json.dump([{"link": l, "before": b, "after": a} for l, b, a in rows], open(args.json, "w"), indent=1, default=str)
    print(text)
    if not args.detail:
        print()
        print(dtext)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    lag = sub.add_parser("lag")
    lag.add_argument("runs", nargs="+")
    t = sub.add_parser("table")
    t.add_argument("--before", required=True)
    t.add_argument("--after", required=True)
    t.add_argument("--title")
    t.add_argument("--links")
    t.add_argument("--before-no-trailer", action="store_true")
    t.add_argument("--md")
    t.add_argument("--detail")
    t.add_argument("--json")
    args = p.parse_args()
    if args.cmd == "lag":
        cmd_lag(args.runs)
    else:
        cmd_table(args)


if __name__ == "__main__":
    main()
