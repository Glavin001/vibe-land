#!/usr/bin/env python3
"""Summarise Netlab v2 runs for netcode tuning: bytes, latency and
drawn-vs-truth error per body class, one row per run.

  scripts/perf/netlab2-tune.py <matrixOrRunDir>... [--json out.json] [--md out.md]
                               [--pareto | --relative]

Every directory given (or each of its sub-directories) that holds a
`report.json` and `stream.json` from `netlab2 run|matrix` is one row.
Nothing here re-scores anything: it only reads what the scorer wrote.

Columns (all measured by the lab, see docs/netlab-v2.md "Metrics"):
- bytes: kbit/s delivered to the client, netcode kinds only (snapshot +
  city chunks + city reliable: topology, baseline, hash, bootstraps), and
  that split; `all` includes pass-through kinds (match stats, energy, ...).
- latency: datagram queue->arrival p50/p99; `drawn` = how far behind the
  server the dynamic bodies are drawn (p50), i.e. sent->drawn including the
  interpolation delay.
- error: per class, p50 at render time / p50 at "now" (m). City phases use
  the chunk-weighted lever error (render) and the uncompensated lever error
  (now); snapshot classes use err_render_m / err_now_m.
- stale: frames drawing a snapshot body the server no longer has
  (`no_truth`), and city moving body-frames with no pose at all.
- repairs: city bootstraps (join/resync/repair) the stream carried.
"""
import json
import os
import sys

NETCODE_KINDS = {
    "snapshot_v2": "snap",
    "snapshot_v1": "snap",
    "city_chunks": "city_dg",
    "city_debris": "city_dg",
    "city_topology": "city_rel",
    "city_baseline": "city_rel",
    "city_topo_hash": "city_rel",
    "city_bootstrap": "city_rel",
    "city_structure_bootstrap": "city_rel",
}
SNAP_CLASSES = ["resting", "ballistic", "colliding", "fast_projectile", "vehicle", "player"]
CITY_PHASES = ["resting", "settling", "landing", "just-freed", "falling"]


def runs_in(path):
    if os.path.exists(os.path.join(path, "report.json")):
        yield path
        return
    for name in sorted(os.listdir(path)):
        sub = os.path.join(path, name)
        if os.path.isdir(sub) and os.path.exists(os.path.join(sub, "report.json")):
            yield sub


def pct(d, key="p50"):
    if not d:
        return None
    return d.get(key)


def summarise(run):
    report = json.load(open(os.path.join(run, "report.json")))
    stream = json.load(open(os.path.join(run, "stream.json")))
    card = report["card"]
    dur = stream["duration_s"] or 1.0
    spec = stream.get("spec") or {}
    row = {
        "run": os.path.basename(os.path.dirname(run.rstrip("/"))) + "/" + os.path.basename(run.rstrip("/")),
        "link": spec.get("link"),
        "knobs": ",".join(f"{k}={v}" for k, v in sorted((spec.get("knobs") or {}).items())) or "production",
    }
    kbps = {"snap": 0.0, "city_dg": 0.0, "city_rel": 0.0}
    total = 0.0
    for kind, totals in stream["kinds"].items():
        k = totals["delivered_bytes"] * 8 / dur / 1000
        total += k
        if kind in NETCODE_KINDS:
            kbps[NETCODE_KINDS[kind]] += k
    row["kbps_all"] = total
    row.update({f"kbps_{k}": v for k, v in kbps.items()})
    row["kbps_net"] = sum(kbps.values())
    dg = stream["lanes"].get("datagram", {})
    row["dg_lat_p50"] = pct(dg.get("latency_ms"), "p50")
    row["dg_lat_p99"] = pct(dg.get("latency_ms"), "p99")
    row["dg_lost"] = dg.get("by_fate", {}).get("lost", 0)
    clock = card.get("clock", {})
    row["delay_p50"] = pct(clock.get("dyn_delay_ms"))
    row["drawn_behind_p50"] = pct(clock.get("dyn_behind_now_ms"))
    row["backsteps"] = clock.get("dyn_backsteps", 0)
    classes = card.get("classes", {})
    for name in SNAP_CLASSES:
        c = classes.get(name)
        if c:
            row[f"{name}_render_p50"] = pct(c["err_render_m"])
            row[f"{name}_render_p99"] = pct(c["err_render_m"], "p99")
            row[f"{name}_now_p50"] = pct(c["err_now_m"])
            row[f"{name}_now_p99"] = pct(c["err_now_m"], "p99")
            row[f"{name}_frames"] = c["entity_frames"]
    stale_card = card.get("stale")
    if stale_card:
        # Bodies drawn after they left truth or this client's interest.
        row["stale_frames"] = stale_card.get("no_truth_frames", 0) + stale_card.get("out_of_interest_frames", 0)
        row["stale_max_ms"] = (stale_card.get("stale_ms") or {}).get("max")
    else:
        stale = classes.get("no_truth")
        row["stale_frames"] = stale["entity_frames"] if stale else 0
    row["clock_lag_p50"] = pct(clock.get("lag_ms"))
    after = classes.get("meteor_body_after_flight")
    row["meteor_after_frames"] = after["entity_frames"] if after else 0
    meteors = card.get("meteors") or {}
    row["meteor_render_p50"] = pct(meteors.get("err_render_m"))
    row["meteor_render_p99"] = pct(meteors.get("err_render_m"), "p99")
    city = card.get("city") or {}
    if city:
        row["city_lever_p50"] = city["overall"]["lever_m"]["p50"]
        row["city_lever_p99"] = city["overall"]["lever_m"]["p99"]
        row["city_perceptible"] = city["overall"]["visual"]["perceptible_fraction"]
        row["city_missing_moving"] = city.get("missing_moving_body_frames", 0)
        # One number per run for the Pareto front: the chunk-weighted mean
        # lever error over every city body not yet settled (settled bodies
        # carry the reliable settle pose and are ~5 mm everywhere), at the
        # render time and at "now".
        w = r_sum = n_sum = 0.0
        for phase, cell in city.get("by_phase", {}).items():
            if phase == "settled":
                continue
            w += cell["weight"]
            r_sum += cell["weight"] * cell["lever_m"]["mean"]
            n_sum += cell["weight"] * cell["lever_uncompensated_m"]["mean"]
        row["city_active_render_mean"] = r_sum / w if w else None
        row["city_active_now_mean"] = n_sum / w if w else None
        for phase in CITY_PHASES:
            cell = city.get("by_phase", {}).get(phase)
            if cell:
                row[f"city_{phase}_render_p50"] = cell["lever_m"]["p50"]
                row[f"city_{phase}_render_p99"] = cell["lever_m"]["p99"]
                row[f"city_{phase}_now_p50"] = cell["lever_uncompensated_m"]["p50"]
                row[f"city_{phase}_now_p99"] = cell["lever_uncompensated_m"]["p99"]
                row[f"city_{phase}_perc"] = cell["visual"]["perceptible_fraction"]
    st = stream["stream"]
    row["city_bootstraps"] = st.get("city_bootstraps", 0) + st.get("city_structure_bootstraps_passed_through", 0)
    sel = st.get("city_selection", {})
    row["city_sent_records"] = sel.get("sent", 0)
    row["city_ceiling_drops"] = sel.get("ceiling", 0)
    row["city_used_share"] = sel.get("used_bytes", 0) / max(1, sel.get("allowance_bytes", 1))
    ss = st.get("snapshot_selection", {})
    row["snap_budget_drops"] = ss.get("bodies_budget", 0) + ss.get("vehicles_budget", 0) + ss.get("players_budget", 0)
    stats_path = os.path.join(run, "client-stats.json")
    if os.path.exists(stats_path):
        cs = json.load(open(stats_path))
        lab = cs[0] if isinstance(cs, list) else cs
        row["nacks"] = lab.get("nacksSent", 0)
        row["resyncs"] = lab.get("resyncRequestsSent", 0)
    return row


def f(v, digits=3):
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return str(v)


def markdown(rows):
    out = []
    out.append("| run | net kbit/s (snap / city dg / city rel) | dg lat p50/p99 ms | drawn behind p50 ms "
               "| city resting r/n | city settling r/n | city landing r/n | city just-freed r/n | city falling r/n "
               "| city perceptible | ballistic r/n | colliding r/n | vehicle r/n | player r/n | meteor r p50/p99 "
               "| stale frames | city missing | ceiling drops | repairs |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        def rn(prefix):
            a, b = r.get(f"{prefix}_render_p50"), r.get(f"{prefix}_now_p50")
            return "-" if a is None and b is None else f"{f(a)} / {f(b)}"
        out.append(
            f"| {r['run']} | {f(r['kbps_net'],1)} ({f(r['kbps_snap'],1)} / {f(r['kbps_city_dg'],1)} / {f(r['kbps_city_rel'],1)}) "
            f"| {f(r['dg_lat_p50'],1)} / {f(r['dg_lat_p99'],1)} | {f(r['drawn_behind_p50'],1)} "
            f"| {rn('city_resting')} | {rn('city_settling')} | {rn('city_landing')} | {rn('city_just-freed')} | {rn('city_falling')} "
            f"| {f(r.get('city_perceptible'),4)} | {rn('ballistic')} | {rn('colliding')} | {rn('vehicle')} | {rn('player')} "
            f"| {f(r.get('meteor_render_p50'),2)} / {f(r.get('meteor_render_p99'),2)} "
            f"| {r['stale_frames']} | {r.get('city_missing_moving', '-')} | {r['city_ceiling_drops']} | {r['city_bootstraps']} |"
        )
    return "\n".join(out)


def pareto(rows, out):
    """Per (bundle, link): each run's bytes and error relative to the
    `prod` knob set, and whether it is on the front (no other run has less
    or equal bytes AND error AND perceptible area AND drawn-behind latency,
    one strictly less)."""
    groups = {}
    for r in rows:
        bundle = r["run"].split("/")[0]
        groups.setdefault((bundle, r["link"]), []).append(r)
    out.append("| bundle | link | set | net kbit/s | vs prod | active err render/now mean m | perceptible | drawn behind ms | front |")
    out.append("|---|---|---|---:|---:|---|---:|---:|---|")
    for (bundle, link), group in sorted(groups.items()):
        prod = next((r for r in group if r["run"].endswith("__prod")), None)
        def key(r):
            # Latency within 1 ms counts as equal (run-to-run clock noise).
            return (r["kbps_net"], r.get("city_active_render_mean") or 0, r.get("city_perceptible") or 0,
                    round((r["drawn_behind_p50"] or 0) / 1.0))
        for r in sorted(group, key=lambda r: r["kbps_net"]):
            a = key(r)
            dominated = any(
                all(x <= y for x, y in zip(key(o), a)) and any(x < y for x, y in zip(key(o), a))
                for o in group if o is not r
            )
            name = r["run"].split("__")[-1]
            rel = f"{(r['kbps_net'] / prod['kbps_net'] - 1) * 100:+.1f}%" if prod else "-"
            out.append(
                f"| {bundle} | {link} | {name} | {f(r['kbps_net'],1)} | {rel} "
                f"| {f(r.get('city_active_render_mean'))} / {f(r.get('city_active_now_mean'))} "
                f"| {f(r.get('city_perceptible'),4)} | {f(r['drawn_behind_p50'],1)} | {'yes' if not dominated else ''} |"
            )


def relative(rows, out, links=("lan", "lte", "poor-mobile", "bw-capped")):
    """Per knob set and link: mean change vs the `prod` set across bundles
    (bytes, active city error at render time, perceptible area) and the
    drawn-behind change in ms; plus on how many (bundle, link) cells the set
    is on the Pareto front."""
    groups = {}
    for r in rows:
        groups.setdefault((r["run"].split("/")[0], r["link"]), {})[r["run"].split("__")[-1]] = r
    def key(r):
        return (r["kbps_net"], r.get("city_active_render_mean") or 0, r.get("city_perceptible") or 0,
                round(r["drawn_behind_p50"] or 0))
    stats = {}
    for (bundle, link), sets in groups.items():
        prod = sets.get("prod")
        if not prod or link not in links:
            continue
        for name, r in sets.items():
            dominated = any(
                all(x <= y for x, y in zip(key(o), key(r))) and any(x < y for x, y in zip(key(o), key(r)))
                for o in sets.values() if o is not r
            )
            cell = stats.setdefault(name, {}).setdefault(link, {"b": [], "e": [], "p": [], "l": [], "front": 0})
            cell["b"].append(r["kbps_net"] / prod["kbps_net"] - 1)
            cell["e"].append((r.get("city_active_render_mean") or 0) / max(prod.get("city_active_render_mean") or 1e-9, 1e-9) - 1)
            pp = prod.get("city_perceptible") or 0
            if pp > 0:
                cell["p"].append((r.get("city_perceptible") or 0) / pp - 1)
            cell["l"].append((r["drawn_behind_p50"] or 0) - (prod["drawn_behind_p50"] or 0))
            cell["front"] += 0 if dominated else 1
    mean = lambda v: sum(v) / len(v) if v else 0.0
    out.append("| set | " + " | ".join(f"{l}: bytes / err / perceptible / latency" for l in links) + " | on front |")
    out.append("|---|" + "---|" * len(links) + "---:|")
    order = sorted(stats, key=lambda n: mean([x for l in links for x in stats[n].get(l, {}).get("b", [])]))
    for name in order:
        cells, fronts, total = [], 0, 0
        for l in links:
            c = stats[name].get(l)
            if not c:
                cells.append("-")
                continue
            fronts += c["front"]
            total += len(c["b"])
            cells.append(f"{mean(c['b'])*100:+.0f}% / {mean(c['e'])*100:+.0f}% / {mean(c['p'])*100:+.0f}% / {mean(c['l']):+.1f} ms")
        out.append(f"| {name} | " + " | ".join(cells) + f" | {fronts}/{total} |")


def main():
    args = sys.argv[1:]
    out_json = out_md = None
    dirs = []
    i = 0
    while i < len(args):
        if args[i] == "--json":
            out_json = args[i + 1]; i += 2
        elif args[i] == "--md":
            out_md = args[i + 1]; i += 2
        elif args[i] in ("--pareto", "--relative"):
            i += 1
        else:
            dirs.append(args[i]); i += 1
    rows = [summarise(run) for d in dirs for run in runs_in(d)]
    if "--relative" in sys.argv:
        lines = []
        relative(rows, lines)
        print("\n".join(lines))
        return
    if "--pareto" in sys.argv:
        lines = []
        pareto(rows, lines)
        print("\n".join(lines))
        return
    md = markdown(rows)
    print(md)
    if out_md:
        open(out_md, "w").write(md + "\n")
    if out_json:
        json.dump(rows, open(out_json, "w"), indent=1)


if __name__ == "__main__":
    main()
