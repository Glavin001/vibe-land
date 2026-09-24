#!/usr/bin/env python3
"""Inspect a paired client+server session bundle.

    python3 scripts/perf/session_bundle.py debug-reports/session-<id> [--json out.json]

A bundle is what the RECORD TAPE button (or the e2e bridge's paired
recordTape) leaves on the server: the client's tape (client.vltape), the
server capture (world.bin, sendlog.bin, ticks.jsonl, selections.jsonl, the
city encoder capture) and session.json linking them. This joins the two ends
and prints enough to show the data lines up:

  * duration of the tape and of the server capture, in ticks and seconds;
  * per channel, packets and bytes the server sent this client versus what
    the tape received, and what the server dropped, deferred or held back;
  * the clock mapping: each received packet joined to the send-log record
    that produced it (CRC32 + length, in order), giving its server tick and
    one-way latency on three clocks (shared wall clock, clock-sample offset,
    and the min-offset lower envelope);
  * position error of every entity in every received game snapshot against
    the server's authoritative state at the snapshot's tick.

Pure standard library. Formats are documented in server/src/send_log.rs,
server/src/session_capture.rs and client/src/city/cityTape.ts.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import zlib
from collections import Counter, defaultdict

PKT_WELCOME = 101
PKT_SNAPSHOT = 102
PKT_PING = 110
PKT_SNAPSHOT_V2 = 112

CHANNELS = {0: "city", 1: "wt-reliable", 2: "wt-datagram", 3: "websocket", 4: "rtt"}
PRELUDE = 0x80
LANES = ["wt-reliable", "wt-datagram", "websocket"]
OUTCOMES = ["sent", "sent-fallback", "queue-full", "reliable-overflow", "closed",
            "strict-drop", "fallback-dropped"]
DELIVERED = {0, 1}
SEND_RECORD = struct.Struct("<IIQQIIBBBx")
QUEUED_BEFORE_CAPTURE = 2**64 - 1


# ── readers ────────────────────────────────────────────────────────────────

def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def read_json(path):
    with open(path) as handle:
        return json.load(handle)


def read_client_tape(path):
    data = read_bytes(path)
    magic = data[:8].decode("latin-1")
    if magic not in ("VLTAPE01", "VLCTAPE2", "VLTAPE02"):
        raise SystemExit(f"{path}: not a client tape ({magic!r})")
    if magic == "VLTAPE02" and data[12:13] != b"{":
        raise SystemExit(f"{path}: a netlab encoder tape, not a client tape")
    v1 = magic == "VLTAPE01"
    (hlen,) = struct.unpack_from("<I", data, 8)
    header = json.loads(data[12:12 + hlen])
    at = 12 + hlen + (header.get("frames") or 0) * (header.get("frameBytes") or 16)
    packets = []  # (t_ms, channel, bytes)
    if v1:
        while at + 8 <= len(data):
            t, n = struct.unpack_from("<II", data, at)
            at += 8
            packets.append((float(t), 0, data[at:at + n]))
            at += n
    else:
        while at + 13 <= len(data):
            t, n, ch = struct.unpack_from("<dIB", data, at)
            at += 13
            packets.append((t, ch, data[at:at + n]))
            at += n
    return magic, header, packets


def read_send_log(path):
    data = read_bytes(path)
    if data[:8] != b"VLSEND01":
        raise SystemExit(f"{path}: not a send log")
    (hlen,) = struct.unpack_from("<I", data, 8)
    header = json.loads(data[12:12 + hlen])
    body = memoryview(data)[12 + hlen:]
    usable = len(body) - len(body) % SEND_RECORD.size
    records = list(SEND_RECORD.iter_unpack(body[:usable]))
    # (player, tick, queued_us, sent_us, size, crc32, kind, lane, outcome)
    return header, records


def iter_world(path, wanted_ticks=None):
    """Yields (tick, mono_us, unix_us, players, vehicles, bodies) per tick.

    Entity lists are only decoded for ticks in `wanted_ticks` (None: all)."""
    data = read_bytes(path)
    if data[:8] != b"VLWORLD1":
        raise SystemExit(f"{path}: not a world file")
    (hlen,) = struct.unpack_from("<I", data, 8)
    at = 12 + hlen
    head = struct.Struct("<IQQHHI")
    player = struct.Struct("<IBBH8f")
    vehicle = struct.Struct("<IBBBI13f")
    body = struct.Struct("<IHB16f")
    n = len(data)
    while at + head.size <= n:
        tick, mono, unix, np_, nv, nb = head.unpack_from(data, at)
        end = at + head.size + np_ * player.size + nv * vehicle.size + nb * body.size
        if end > n:
            break
        if wanted_ticks is None or tick in wanted_ticks:
            p = at + head.size
            players = []
            for _ in range(np_):
                f = player.unpack_from(data, p)
                players.append({"id": f[0], "handle": f[1], "pos": f[4:7]})
                p += player.size
            vehicles = []
            for _ in range(nv):
                f = vehicle.unpack_from(data, p)
                vehicles.append({"id": f[0], "handle": f[1], "pos": f[5:8]})
                p += vehicle.size
            bodies = []
            for _ in range(nb):
                f = body.unpack_from(data, p)
                bodies.append({"id": f[0], "handle": f[1], "shape": f[2], "pos": f[3:6]})
                p += body.size
            yield tick, mono, unix, players, vehicles, bodies
        else:
            yield tick, mono, unix, None, None, None
        at = end


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


# ── snapshot decoding (the server's wire layout, protocol.rs) ──────────────

def decode_snapshot_v2(b):
    """Positions of every entity in a SnapshotV2, in metres."""
    tick, _ack, ax, ay, az, nr, ns, nb, nv = struct.unpack_from("<IHiiiBBBB", b, 1)
    anchor = (ax / 1000.0, ay / 1000.0, az / 1000.0)
    at = 23 + 33  # header, self state
    rel = lambda d: tuple(anchor[i] + d[i] * 0.0025 for i in range(3))
    out = {"tick": tick, "self": anchor, "players": {}, "bodies": {}, "vehicles": {}}
    for _ in range(nr):
        h, dx, dy, dz = struct.unpack_from("<Bhhh", b, at)
        out["players"][h] = rel((dx, dy, dz))
        at += 19
    for _ in range(ns):
        h, dx, dy, dz = struct.unpack_from("<Hhhh", b, at)
        out["bodies"][h] = rel((dx, dy, dz))
        at += 20
    for _ in range(nb):
        h, dx, dy, dz = struct.unpack_from("<Hhhh", b, at)
        out["bodies"][h] = rel((dx, dy, dz))
        at += 28
    for _ in range(nv):
        h, _t, _d, _f, dx, dy, dz = struct.unpack_from("<BBBBhhh", b, at)
        out["vehicles"][h] = rel((dx, dy, dz))
        at += 30
    return out


def decode_snapshot_v1(b):
    """A V1 snapshot keys entities by id, with absolute mm positions."""
    _t, tick, _ack, npl, npr, nd, nv = struct.unpack_from("<QIHHHHH", b, 1)
    at = 1 + 8 + 4 + 2 + 8
    out = {"tick": tick, "self": None, "players_by_id": {}, "bodies_by_id": {}, "vehicles_by_id": {}}
    for _ in range(npl):
        pid, x, y, z = struct.unpack_from("<Iiii", b, at)
        out["players_by_id"][pid] = (x / 1000.0, y / 1000.0, z / 1000.0)
        at += 29
    at += npr * 31
    for _ in range(nd):
        bid, _shape, x, y, z = struct.unpack_from("<IBiii", b, at)
        out["bodies_by_id"][bid] = (x / 1000.0, y / 1000.0, z / 1000.0)
        at += 43
    for _ in range(nv):
        vid, _t, _f, _d, x, y, z = struct.unpack_from("<IBBIiii", b, at)
        out["vehicles_by_id"][vid] = (x / 1000.0, y / 1000.0, z / 1000.0)
        at += 50
    return out


# ── statistics ─────────────────────────────────────────────────────────────

def quantiles(values, qs=(0.5, 0.9, 0.99)):
    if not values:
        return {}
    s = sorted(values)
    out = {f"p{int(q * 100)}": s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))] for q in qs}
    out.update(n=len(s), min=s[0], max=s[-1], mean=sum(s) / len(s))
    return out


def fmt_q(q, unit="ms", scale=1.0, digits=2):
    if not q:
        return "n/a"
    f = lambda v: f"{v * scale:.{digits}f}"
    return (f"n={q['n']}  min {f(q['min'])}  p50 {f(q['p50'])}  p90 {f(q['p90'])}  "
            f"p99 {f(q['p99'])}  max {f(q['max'])} {unit}")


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


# ── the report ─────────────────────────────────────────────────────────────

def analyse(bundle):
    manifest = read_json(os.path.join(bundle, "session.json"))
    server = manifest.get("server") or {}
    server_dir = os.path.normpath(os.path.join(bundle, server.get("dir", "server")))
    report = {"bundle": bundle, "session_id": manifest.get("session_id"),
              "match_id": manifest.get("match_id")}

    magic, tape_header, tape_packets = read_client_tape(os.path.join(bundle, "client.vltape"))
    player = manifest.get("client_player_id") or tape_header.get("localPlayerId")
    report["client"] = {"magic": magic, "player_id": player,
                        "duration_s": tape_header.get("durationMs", 0) / 1000.0,
                        "packets": len(tape_packets), "frames": tape_header.get("frames"),
                        "transport": tape_header.get("transport"),
                        "pairing_state": (tape_header.get("pairing") or {}).get("state")}

    send_header, records = read_send_log(os.path.join(server_dir, "sendlog.bin"))
    epoch_unix_us = send_header["epoch_unix_us"]
    capture_meta = {}
    meta_path = os.path.join(server_dir, "session-capture.json")
    if os.path.exists(meta_path):
        capture_meta = read_json(meta_path)
    timings = read_jsonl(os.path.join(server_dir, "ticks.jsonl"))
    start = (server.get("start") or {})
    stop = (server.get("stop") or {})
    sim_hz = server.get("sim_hz") or 60
    report["server"] = {
        "start_tick": start.get("tick"), "stop_tick": stop.get("tick"),
        "session_ticks": (stop.get("tick", 0) - start.get("tick", 0)) if stop else None,
        "session_s": ((stop.get("tick", 0) - start.get("tick", 0)) / sim_hz) if stop else None,
        "session_wall_s": ((stop.get("mono_us", 0) - start.get("mono_us", 0)) / 1e6) if stop else None,
        "ticks_recorded": len(timings),
        "dropped_ticks": (capture_meta.get("tick_writer") or {}).get("dropped_ticks"),
        "send_records": len(records),
        "dropped_send_records": (capture_meta.get("send_log") or {}).get("dropped_records"),
        "city_capture": capture_meta.get("city"),
        "tick_total_ms": quantiles([t["total_ms"] for t in timings]),
        "tick_capture_ms": quantiles([t.get("capture_ms", 0.0) for t in timings]),
        "build": (server.get("build") or {}).get("server_build"),
    }
    tick_unix = {t["tick"]: t["unix_us"] for t in timings}
    events = read_jsonl(os.path.join(server_dir, "city", "events.jsonl"))
    lo_tick, hi_tick = start.get("tick", 0), stop.get("tick", 2**32)
    report["server"]["events"] = dict(Counter(e.get("kind") for e in events
                                              if lo_tick <= e.get("tick", 0) <= hi_tick))

    # ── join: every taped packet to the send record that produced it ──
    mine = [r for r in records if r[0] == player]
    by_key = defaultdict(list)
    for r in sorted(mine, key=lambda r: r[3]):
        if r[8] in DELIVERED:
            by_key[(r[5], r[4])].append(r)
    cursor = defaultdict(int)
    joined = []  # (t_ms, channel, record, bytes)
    unmatched = Counter()
    for t, ch, b in tape_packets:
        if ch & PRELUDE or ch == 4:
            continue
        key = (zlib.crc32(b), len(b))
        queue = by_key.get(key)
        i = cursor[key]
        if queue and i < len(queue):
            cursor[key] = i + 1
            joined.append((t, ch, queue[i], b))
        else:
            unmatched[CHANNELS.get(ch, ch)] += 1
    report["join"] = {"taped": sum(1 for t, ch, _ in tape_packets if not ch & PRELUDE and ch != 4),
                      "matched": len(joined), "unmatched_by_channel": dict(unmatched)}

    # ── sent vs received per channel, inside the joined window ──
    if joined:
        lo = min(j[2][3] for j in joined)
        hi = max(j[2][3] for j in joined)
    else:
        lo, hi = 0, -1
    channels = {}
    matched_ids = {id(j[2]) for j in joined}
    for r in mine:
        lane = LANES[r[7]] if r[7] < len(LANES) else str(r[7])
        c = channels.setdefault(lane, Counter())
        c[f"server_{OUTCOMES[r[8]]}"] += 1
        if r[8] in DELIVERED and lo <= r[3] <= hi:
            if r[7] == 1 and r[6] == PKT_PING:
                c["in_window_untaped_pings"] += 1
                continue
            c["in_window_sent_packets"] += 1
            c["in_window_sent_bytes"] += r[4]
            if id(r) not in matched_ids:
                c["in_window_lost"] += 1
    for t, ch, r, b in joined:
        lane = LANES[r[7]]
        channels[lane]["received_packets"] += 1
        channels[lane]["received_bytes"] += len(b)
    report["channels"] = {k: dict(v) for k, v in channels.items()}

    # ── deferral / interest decisions for this client ──
    selections = [s for s in read_jsonl(os.path.join(server_dir, "selections.jsonl"))
                  if s.get("player") == player]
    agg = defaultdict(Counter)
    for s in selections:
        for k, v in s.items():
            if k not in ("tick", "player", "stream") and isinstance(v, (int, float)):
                agg[s["stream"]][k] += v
        agg[s["stream"]]["sends"] += 1
    report["selections"] = {k: dict(v) for k, v in agg.items()}

    # ── clock mapping ──
    origin_ms = tape_header.get("clockOriginMs")
    wall_origin_ms = tape_header.get("wallClockOriginMs")
    samples = (tape_header.get("pairing") or {}).get("clockSamples") or []
    offsets, rtts = [], []
    for s in samples:
        if s.get("serverMonoUs") is None or origin_ms is None:
            continue
        mid_tape_us = ((s["sentPerfMs"] + s["receivedPerfMs"]) / 2 - origin_ms) * 1000
        offsets.append(mid_tape_us - s["serverMonoUs"])
        rtts.append(s["receivedPerfMs"] - s["sentPerfMs"])
    sample_offset = sorted(offsets)[len(offsets) // 2] if offsets else None
    residual = [t * 1000 - r[3] for t, ch, r, b in joined]  # tape_us - server send mono_us
    min_offset = min(residual) if residual else None
    lat = {"wall": [], "sample": [], "envelope": [], "queue": [], "tick_to_arrival": []}
    per_lane_wall = defaultdict(list)
    for (t, ch, r, b), res in zip(joined, residual):
        if wall_origin_ms is not None:
            arrival_unix_us = wall_origin_ms * 1000 + t * 1000
            ms = (arrival_unix_us - (epoch_unix_us + r[3])) / 1000
            lat["wall"].append(ms)
            per_lane_wall[LANES[r[7]]].append(ms)
            if r[1] in tick_unix:
                lat["tick_to_arrival"].append((arrival_unix_us - tick_unix[r[1]]) / 1000)
        if sample_offset is not None:
            lat["sample"].append((res - sample_offset) / 1000)
        lat["envelope"].append((res - min_offset) / 1000)
        if r[2] != QUEUED_BEFORE_CAPTURE:
            lat["queue"].append((r[3] - r[2]) / 1000)
    report["clock"] = {
        "samples": len(samples), "sample_rtt_ms": quantiles(rtts),
        "sample_offset_spread_ms": (max(offsets) - min(offsets)) / 1000 if len(offsets) > 1 else None,
        "latency_wall_ms": quantiles(lat["wall"]),
        "latency_wall_by_lane_ms": {k: quantiles(v) for k, v in per_lane_wall.items()},
        "latency_sample_offset_ms": quantiles(lat["sample"]),
        "latency_envelope_ms": quantiles(lat["envelope"]),
        "queue_to_send_ms": quantiles(lat["queue"]),
        "tick_end_to_arrival_ms": quantiles(lat["tick_to_arrival"]),
        "tick_mapped_packets": len(joined),
    }
    # Snapshots carry their own tick: check the join agrees with the wire.
    disagree = 0
    for t, ch, r, b in joined:
        if b and b[0] in (PKT_SNAPSHOT_V2, PKT_SNAPSHOT) and len(b) > 5:
            wire_tick = struct.unpack_from("<I", b, 1 if b[0] == PKT_SNAPSHOT_V2 else 9)[0]
            if wire_tick != r[1]:
                disagree += 1
    report["clock"]["snapshot_tick_disagreements"] = disagree

    # ── position error: received snapshots vs server truth at their tick ──
    snaps = []
    for t, ch, b in tape_packets:
        if ch & PRELUDE or not b:
            continue
        try:
            if b[0] == PKT_SNAPSHOT_V2:
                snaps.append(decode_snapshot_v2(b))
            elif b[0] == PKT_SNAPSHOT:
                snaps.append(decode_snapshot_v1(b))
        except struct.error:
            pass
    wanted = {s["tick"] for s in snaps}
    truth = {}
    for tick, mono, unix, players, vehicles, bodies in iter_world(os.path.join(server_dir, "world.bin"), wanted):
        if players is None:
            continue
        truth[tick] = {
            "player_by_id": {p["id"]: p["pos"] for p in players},
            "player_by_handle": {p["handle"]: p["pos"] for p in players if p["handle"]},
            "vehicle_by_handle": {v["handle"]: v["pos"] for v in vehicles if v["handle"]},
            "vehicle_by_id": {v["id"]: v["pos"] for v in vehicles},
            "body_by_handle": {x["handle"]: x["pos"] for x in bodies if x["handle"]},
            "body_by_id": {x["id"]: x["pos"] for x in bodies},
        }
    errors = defaultdict(list)
    missing = Counter()
    compared_snaps = 0
    for s in snaps:
        w = truth.get(s["tick"])
        if w is None:
            missing["snapshot_tick_not_in_capture"] += 1
            continue
        compared_snaps += 1
        pairs = []
        if "players" in s:
            if s["self"] is not None and player in w["player_by_id"]:
                pairs.append(("self", s["self"], w["player_by_id"][player]))
            pairs += [("player", pos, w["player_by_handle"].get(h)) for h, pos in s["players"].items()]
            pairs += [("vehicle", pos, w["vehicle_by_handle"].get(h)) for h, pos in s["vehicles"].items()]
            pairs += [("body", pos, w["body_by_handle"].get(h)) for h, pos in s["bodies"].items()]
        else:
            pairs += [("player", pos, w["player_by_id"].get(i)) for i, pos in s["players_by_id"].items()]
            pairs += [("vehicle", pos, w["vehicle_by_id"].get(i)) for i, pos in s["vehicles_by_id"].items()]
            pairs += [("body", pos, w["body_by_id"].get(i)) for i, pos in s["bodies_by_id"].items()]
        for kind, got, want in pairs:
            if want is None:
                missing[f"{kind}_not_in_truth"] += 1
            else:
                errors[kind].append(dist(got, want) * 1000.0)
    report["position_error_mm"] = {k: quantiles(v) for k, v in errors.items()}
    report["position_compare"] = {"snapshots": len(snaps), "compared": compared_snaps, **dict(missing)}
    return report


def print_report(r):
    c, s = r["client"], r["server"]
    print(f"session {r['session_id']}  match {r['match_id']}  player {c['player_id']}")
    print(f"  client tape  {c['magic']}  {c['duration_s']:.1f} s  {c['packets']} packets  "
          f"{c['frames']} frames  {c['transport']}  pairing={c['pairing_state']}")
    print(f"  server       ticks {s['start_tick']}..{s['stop_tick']} ({s['session_ticks']} ticks = "
          f"{s['session_s'] or 0:.1f} s of sim, {s['session_wall_s'] or 0:.1f} s wall); "
          f"{s['ticks_recorded']} tick records, dropped {s['dropped_ticks']}; "
          f"{s['send_records']} send records, dropped {s['dropped_send_records']}")
    print(f"  events       {s['events']}")
    print(f"  tick total   {fmt_q(s['tick_total_ms'])}")
    print(f"  capture cost {fmt_q(s['tick_capture_ms'], digits=3)}")
    city = s.get("city_capture") or {}
    print(f"  city capture {json.dumps(city)}")
    j = r["join"]
    print(f"\njoin: {j['matched']}/{j['taped']} taped packets matched to a send record; "
          f"unmatched {j['unmatched_by_channel'] or 0}")
    print("\nper channel (window = first..last joined send):")
    for lane, v in sorted(r["channels"].items()):
        sent, recv = v.get("in_window_sent_packets", 0), v.get("received_packets", 0)
        print(f"  {lane:12s} sent {sent:7d} pkts {v.get('in_window_sent_bytes', 0) / 1e6:8.2f} MB | "
              f"received {recv:7d} pkts {v.get('received_bytes', 0) / 1e6:8.2f} MB | "
              f"lost {v.get('in_window_lost', 0)}")
        drops = {k[7:]: n for k, n in v.items() if k.startswith("server_") and k not in ("server_sent",)}
        extra = f", untaped pings {v['in_window_untaped_pings']}" if v.get("in_window_untaped_pings") else ""
        print(f"  {'':12s} server outcomes (whole capture): sent {v.get('server_sent', 0)} {drops}{extra}")
    print("\nserver decisions for this client (summed over sends):")
    for stream, v in r["selections"].items():
        print(f"  {stream}: {json.dumps(v)}")
    k = r["clock"]
    print(f"\nclock mapping ({k['tick_mapped_packets']} packets mapped to their server tick; "
          f"{k['snapshot_tick_disagreements']} snapshot tick disagreements):")
    print(f"  sample RTT             {fmt_q(k['sample_rtt_ms'])}  ({k['samples']} samples, offset spread "
          f"{k['sample_offset_spread_ms'] if k['sample_offset_spread_ms'] is None else round(k['sample_offset_spread_ms'], 3)} ms)")
    print(f"  send->arrive (wall)    {fmt_q(k['latency_wall_ms'])}")
    for lane, q in sorted(k["latency_wall_by_lane_ms"].items()):
        print(f"    {lane:20s} {fmt_q(q)}")
    print(f"  send->arrive (samples) {fmt_q(k['latency_sample_offset_ms'])}")
    print(f"  send->arrive (min env) {fmt_q(k['latency_envelope_ms'])}")
    print(f"  queue->send            {fmt_q(k['queue_to_send_ms'], digits=3)}")
    print(f"  tick end->arrive       {fmt_q(k['tick_end_to_arrival_ms'])}")
    print(f"\nposition error, received snapshot vs server truth at its tick "
          f"({json.dumps(r['position_compare'])}):")
    for kind, q in sorted(r["position_error_mm"].items()):
        print(f"  {kind:8s} {fmt_q(q, unit='mm')}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("bundle", help="debug-reports/session-<id>")
    parser.add_argument("--json", help="also write the report as JSON here")
    args = parser.parse_args()
    report = analyse(args.bundle)
    print_report(report)
    if args.json:
        with open(args.json, "w") as out:
            json.dump(report, out, indent=2)


if __name__ == "__main__":
    main()
