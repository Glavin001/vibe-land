//! Reports: per-run report.json/report.md, the calibration verdict, the
//! matrix and compare tables.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::bundle::Bundle;
use crate::calibrate::ByteMatch;
use crate::score::{Card, ClientCalibration};
use crate::{die, Args, StreamReport};

/// Percentiles of a sample set.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Pct {
    pub n: u64,
    pub mean: f64,
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
    pub max: f64,
}

impl Pct {
    pub fn of(mut values: Vec<f32>) -> Self {
        values.retain(|v| v.is_finite());
        if values.is_empty() {
            return Self::default();
        }
        values.sort_by(|a, b| a.total_cmp(b));
        let at = |q: f64| f64::from(values[((values.len() - 1) as f64 * q).round() as usize]);
        Self {
            n: values.len() as u64,
            mean: values.iter().map(|v| f64::from(*v)).sum::<f64>() / values.len() as f64,
            p50: at(0.5),
            p90: at(0.9),
            p99: at(0.99),
            max: at(1.0),
        }
    }
}

pub fn stream_summary(report: &StreamReport) -> String {
    let mut s = format!(
        "bundle {} player {} | {:.1} s | clock offset {:.3} ms ({})\n",
        report.bundle, report.player, report.duration_s, report.clock_offset_ms, report.clock_offset_source
    );
    for warning in &report.warnings {
        s.push_str(&format!("  warning: {warning}\n"));
    }
    s.push_str(&format!(
        "  snapshots: {} ticks every {} (strict {}), inputs {}, interest {}\n",
        report.stream.snapshot_ticks,
        report.stream.snapshot_interval_ticks,
        report.stream.strict_snapshots,
        report.stream.snapshot_inputs,
        report.stream.snapshot_interest_start
    ));
    s.push_str(&format!(
        "  city: from tick {:?}, encoder {}, send every {} ticks, ceiling {} B, bootstraps {}\n",
        report.stream.city_first_tick,
        report.stream.city_encoder_start,
        report.stream.city_send_interval_ticks,
        report.stream.city_ceiling_bytes,
        report.stream.city_bootstraps
    ));
    s.push_str(&format!("  origins: {:?}\n", report.by_origin));
    for (lane, totals) in &report.lanes {
        s.push_str(&format!(
            "  {lane:<9} {:>7} pkts {:>9} B -> delivered {:>7} ({:>9} B, {:.3} Mbit/s) latency p50 {:.1} p99 {:.1} ms hol p99 {:.1} | {:?}\n",
            totals.packets,
            totals.bytes,
            totals.delivered,
            totals.delivered_bytes,
            totals.delivered_bytes as f64 * 8.0 / report.duration_s.max(1e-9) / 1e6,
            totals.latency_ms.p50,
            totals.latency_ms.p99,
            totals.hol_ms.p99,
            totals.by_fate
        ));
    }
    if let Some(link) = &report.link {
        s.push_str(&format!("  link: {}\n", serde_json::to_string(link).unwrap_or_default()));
    }
    s
}

pub fn read_stream_report(out: &Path) -> std::io::Result<StreamReport> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(out.join("stream.json"))?)?;
    // The spec (with its profile) is informational; the rest round-trips.
    let mut report: StreamReport = serde_json::from_value(serde_json::json!({
        "bundle": value["bundle"], "player": value["player"], "warnings": value["warnings"],
        "clock_offset_ms": value["clock_offset_ms"], "clock_offset_source": value["clock_offset_source"],
        "duration_s": value["duration_s"], "stream": value["stream"], "lanes": value["lanes"],
        "kinds": value["kinds"], "by_origin": value["by_origin"],
    }))?;
    report.spec_json = Some(value["spec"].clone());
    report.link_json = Some(value["link"].clone());
    Ok(report)
}

fn fmt_pct(p: &Pct, scale: f64, digits: usize) -> String {
    if p.n == 0 {
        return "-".into();
    }
    format!("{:.d$} / {:.d$} / {:.d$}", p.p50 * scale, p.p99 * scale, p.max * scale, d = digits)
}

/// One run's headline numbers, flat, for tables.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Headline {
    pub run: String,
    pub link: String,
    pub knobs: String,
    pub down_kbps: f64,
    pub reliable_kbps: f64,
    pub datagram_kbps: f64,
    pub snapshot_kbps: f64,
    pub city_kbps: f64,
    pub datagrams_lost: u64,
    pub retransmits: u64,
    pub reliable_hol_p99_ms: f64,
    pub dyn_delay_p50_ms: f64,
    pub dyn_behind_now_p50_ms: f64,
    pub render_backsteps: u64,
    /// Clock lag (server tick now minus the client's server-time estimate), ms.
    pub clock_lag_p50_ms: f64,
    pub clock_lag_p99_ms: f64,
    /// Bodies drawn after they left truth or interest (see `StaleScore`).
    pub stale_body_frames: u64,
    pub stale_body_share: f64,
    pub stale_body_max_ms: f64,
    pub stale_fast_max_ms: f64,
    pub stale_slow_max_ms: f64,
    pub stale_meteor_frames: u64,
    pub stale_meteor_max_ms: f64,
    pub classes: BTreeMap<String, (f64, f64, f64, f64, f64)>,
    /// Entity-frames drawn per class.
    pub class_frames: BTreeMap<String, u64>,
    /// Meteors as MeteorLayer draws them; 0 flights when the client tree has
    /// no meteorPlacement.ts (then these are not comparable).
    pub meteor_flights: u64,
    pub meteor_err_p99_m: f64,
    pub meteor_backward_frames: u64,
    pub meteor_handover_max_m: f64,
    pub city_lever_p50_m: Option<f64>,
    pub city_lever_p99_m: Option<f64>,
    pub city_perceptible: Option<f64>,
}

pub fn headline(name: &str, stream: &StreamReport, card: &Card) -> Headline {
    let seconds = stream.duration_s.max(1e-9);
    let kbps = |bytes: u64| bytes as f64 * 8.0 / seconds / 1000.0;
    let lane = |name: &str| stream.lanes.get(name).map_or(0, |l| l.delivered_bytes);
    let kind = |prefix: &str| {
        stream.kinds.iter().filter(|(k, _)| k.starts_with(prefix)).map(|(_, v)| v.delivered_bytes).sum::<u64>()
    };
    let mut h = Headline {
        run: name.to_string(),
        link: stream.spec.as_ref().map(|s| s.link.clone()).or_else(|| {
            stream.spec_json.as_ref().and_then(|v| v["link"].as_str().map(String::from))
        }).unwrap_or_default(),
        knobs: stream
            .spec
            .as_ref()
            .map(|s| s.knobs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
            .unwrap_or_default(),
        down_kbps: kbps(lane("reliable") + lane("datagram")),
        reliable_kbps: kbps(lane("reliable")),
        datagram_kbps: kbps(lane("datagram")),
        snapshot_kbps: kbps(kind("snapshot")),
        city_kbps: kbps(kind("city_")),
        datagrams_lost: stream.link.as_ref().map_or(0, |l| l.datagrams_lost + l.datagrams_sender_dropped),
        retransmits: stream.link.as_ref().map_or(0, |l| l.stream_retransmits),
        reliable_hol_p99_ms: stream.lanes.get("reliable").map_or(0.0, |l| l.hol_ms.p99),
        dyn_delay_p50_ms: card.clock.dyn_delay_ms.p50,
        dyn_behind_now_p50_ms: card.clock.dyn_behind_now_ms.p50,
        render_backsteps: card.clock.render_backsteps + card.clock.dyn_backsteps,
        clock_lag_p50_ms: card.clock.lag_ms.p50,
        clock_lag_p99_ms: card.clock.lag_ms.p99,
        stale_body_frames: card.stale.no_truth_frames + card.stale.out_of_interest_frames,
        stale_body_share: (card.stale.no_truth_frames + card.stale.out_of_interest_frames) as f64
            / card.stale.body_frames.max(1) as f64,
        stale_body_max_ms: card.stale.stale_ms.max,
        stale_fast_max_ms: card.stale.fast_stale_ms.max,
        stale_slow_max_ms: card.stale.slow_stale_ms.max,
        stale_meteor_frames: card.stale.meteor_frames,
        stale_meteor_max_ms: card.stale.meteor_stale_ms.max,
        meteor_flights: card.meteors.flights,
        meteor_err_p99_m: card.meteors.err_render_m.p99,
        meteor_backward_frames: card.meteors.backward_frames,
        meteor_handover_max_m: card.meteors.handover_jump_m.max,
        ..Default::default()
    };
    for (class, score) in &card.classes {
        h.class_frames.insert(class.clone(), score.entity_frames);
        h.classes.insert(
            class.clone(),
            (
                score.err_render_m.p50,
                score.err_render_m.p99,
                score.err_now_m.p50,
                score.gates.artifacts_per_min,
                score.extrapolated_share,
            ),
        );
    }
    if let Some(city) = &card.city {
        h.city_lever_p50_m = city["overall"]["lever_m"]["p50"].as_f64();
        h.city_lever_p99_m = city["overall"]["lever_m"]["p99"].as_f64();
        h.city_perceptible = city["overall"]["visual"]["perceptible_fraction"].as_f64();
    }
    h
}

pub fn card_summary(card: &Card) -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        "frames {} ({:.1} s) | render backsteps {} (max {:.1} ms) / bodies {} (max {:.1} ms) | dyn delay p50 {:.1} ms | bodies drawn {:.1} ms behind the server (p50)",
        card.frames,
        card.span_s,
        card.clock.render_backsteps,
        card.clock.render_backstep_max_ms,
        card.clock.dyn_backsteps,
        card.clock.dyn_backstep_max_ms,
        card.clock.dyn_delay_ms.p50,
        card.clock.dyn_behind_now_ms.p50
    );
    let _ = writeln!(
        s,
        "clock lag p50/p99/max {} ms | stale bodies: {} of {} frames ({} no truth, {} out of interest, {} ids), max {:.0} ms (fast {:.0}, slow {:.0}) | stale meteor frames {} (max {:.0} ms)",
        fmt_pct(&card.clock.lag_ms, 1.0, 1),
        card.stale.no_truth_frames + card.stale.out_of_interest_frames,
        card.stale.body_frames,
        card.stale.no_truth_frames,
        card.stale.out_of_interest_frames,
        card.stale.bodies,
        card.stale.stale_ms.max,
        card.stale.fast_stale_ms.max,
        card.stale.slow_stale_ms.max,
        card.stale.meteor_frames,
        card.stale.meteor_stale_ms.max
    );
    let _ = writeln!(
        s,
        "  {:<16} {:>8} {:>5} {:>22} {:>22} {:>12} {:>7} {:>7} {:>7} {:>9}",
        "class", "frames", "ids", "err@render p50/p99/max", "err@now p50/p99/max", "age p50 ms", "extrap", "snaps", "revers", "art/min"
    );
    for (class, c) in &card.classes {
        let _ = writeln!(
            s,
            "  {:<16} {:>8} {:>5} {:>22} {:>22} {:>12.1} {:>6.1}% {:>7} {:>7} {:>9.2}",
            class,
            c.entity_frames,
            c.entities,
            fmt_pct(&c.err_render_m, 1.0, 3),
            fmt_pct(&c.err_now_m, 1.0, 3),
            c.age_ms.p50,
            c.extrapolated_share * 100.0,
            c.gates.snap_frames,
            c.gates.reversal_frames,
            c.gates.artifacts_per_min
        );
    }
    if card.meteors.flights > 0 {
        let _ = writeln!(
            s,
            "  meteors {} flights, frames {:?}, err@render {} m, handover jump max {:.2} m, backward frames {}, below ground {}",
            card.meteors.flights,
            card.meteors.frames_by_source,
            fmt_pct(&card.meteors.err_render_m, 1.0, 3),
            card.meteors.handover_jump_m.max,
            card.meteors.backward_frames,
            card.meteors.below_ground_frames
        );
    }
    if let Some(city) = &card.city {
        let _ = writeln!(
            s,
            "  city chunks: lever p50/p99 {:.3}/{:.3} m (uncompensated p50 {:.3} m), perceptible {:.2}%, missing moving body-frames {}",
            city["overall"]["lever_m"]["p50"].as_f64().unwrap_or(0.0),
            city["overall"]["lever_m"]["p99"].as_f64().unwrap_or(0.0),
            city["overall"]["lever_uncompensated_m"]["p50"].as_f64().unwrap_or(0.0),
            city["overall"]["visual"]["perceptible_fraction"].as_f64().unwrap_or(0.0) * 100.0,
            city["missing_moving_body_frames"].as_u64().unwrap_or(0)
        );
    }
    if let Some(error) = &card.city_error {
        let _ = writeln!(s, "  city scorer: {error}");
    }
    s
}

pub fn run_markdown(stream: &StreamReport, card: &Card) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "# Netlab v2 run\n");
    let _ = writeln!(s, "- bundle: `{}` (player {})", stream.bundle, stream.player);
    if let Some(spec) = &stream.spec {
        let _ = writeln!(
            s,
            "- link: **{}** {} | pace: {:?} | seed {} | knobs: {} | frames: {}",
            spec.link,
            spec.profile.as_ref().map(|p| serde_json::to_string(p).unwrap_or_default()).unwrap_or_default(),
            spec.pace,
            spec.seed,
            if spec.knobs.is_empty() { "production".to_string() } else { format!("{:?}", spec.knobs) },
            spec.frames
        );
    }
    let _ = writeln!(s, "- clock map: {:.3} ms ({})", stream.clock_offset_ms, stream.clock_offset_source);
    for warning in &stream.warnings {
        let _ = writeln!(s, "- **warning**: {warning}");
    }
    let _ = writeln!(s, "\n## Stream\n\n```\n{}```\n", stream_summary(stream));
    let _ = writeln!(s, "## What the client drew\n\n```\n{}```\n", card_summary(card));
    let _ = writeln!(s, "Bytes per kind (delivered):\n");
    let _ = writeln!(s, "| kind | packets | delivered | kbit/s | latency p50/p99 ms | fates |");
    let _ = writeln!(s, "|---|---:|---:|---:|---|---|");
    for (kind, totals) in &stream.kinds {
        let _ = writeln!(
            s,
            "| {kind} | {} | {} | {:.1} | {:.1} / {:.1} | {:?} |",
            totals.packets,
            totals.delivered,
            totals.delivered_bytes as f64 * 8.0 / stream.duration_s.max(1e-9) / 1000.0,
            totals.latency_ms.p50,
            totals.latency_ms.p99,
            totals.by_fate
        );
    }
    s
}

pub fn write_run_report(out: &Path, stream: &StreamReport, card: &Card) -> std::io::Result<()> {
    let name = out.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let report = serde_json::json!({
        "stream": stream,
        "card": card,
        "headline": headline(&name, stream, card),
    });
    std::fs::write(out.join("report.json"), serde_json::to_vec_pretty(&report)?)?;
    std::fs::write(out.join("report.md"), run_markdown(stream, card))
}

// ── calibration verdict ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct Verdict {
    pub pass: bool,
    pub exact_capture: bool,
    pub checks: Vec<(String, bool, String)>,
    pub summary: String,
}

pub fn write_calibration(
    out: &Path,
    bytes: &ByteMatch,
    client: &ClientCalibration,
    strict: bool,
) -> std::io::Result<Verdict> {
    let exact_capture = bytes.notes.is_empty();
    let mut checks: Vec<(String, bool, String)> = Vec::new();
    let byte_floor = if strict { 1.0 } else { 0.995 };
    for (kind, k) in &bytes.kinds {
        let effective = if exact_capture { k.match_rate } else { k.match_modulo_trailer_rate.max(k.match_rate) };
        checks.push((
            format!("(a) {kind} bytes"),
            effective >= byte_floor,
            format!(
                "{}/{} byte-identical ({:.2}%){}; mismatched {}, lab-only {}, live-only {}",
                k.matched,
                k.lab + k.live_missing,
                k.match_rate * 100.0,
                if k.matched_modulo_trailer > 0 {
                    format!(", {} identical but for the wall-clock trailer", k.matched_modulo_trailer)
                } else {
                    String::new()
                },
                k.mismatched,
                k.lab_extra,
                k.live_missing
            ),
        ));
    }
    // The lab's clock starts cold at the tape's first bootstrap (the live one
    // had the session's history) and, while the server stalls, depends on
    // when within each frame the live page read it (seam S8). It must still
    // CONVERGE: the last 10 s of the session, once quiet, must agree.
    let converged = client.offset_diff_p99_by_10s.last().copied();
    checks.push((
        "(b) client clock offset vs live converges: last 10 s window p99 <= 200 us".into(),
        converged.is_some_and(|p99| p99 <= 200.0),
        format!(
            "last window p99 {:.1} us; frames with no server stall in the preceding 3 s: p50 {:.1} us p99 {:.1} us ({} frames)",
            converged.unwrap_or(f64::NAN),
            client.steady_offset_diff_us.p50,
            client.steady_offset_diff_us.p99,
            client.steady_frames
        ),
    ));
    checks.push((
        "(b) client clock offset vs live, all frames after warm-up, p99 <= 20 ms (bounds seam S8)".into(),
        client.offset_diff_us.n > 0 && client.offset_diff_us.p99 <= 20_000.0,
        format!(
            "p50 {:.1} us p99 {:.1} us max {:.1} us over {} frames; p99 per 10 s window {:?} us",
            client.offset_diff_us.p50,
            client.offset_diff_us.p99,
            client.offset_diff_us.max,
            client.frames_compared,
            client.offset_diff_p99_by_10s.iter().map(|v| v.round() as i64).collect::<Vec<_>>()
        ),
    ));
    checks.push((
        "(b) interpolation delays vs live, steady state, p99 <= 0.5 ms".into(),
        client.steady_dyn_delay_diff_ms.p99 <= 0.5 && client.steady_interp_delay_diff_ms.p99 <= 0.5,
        format!(
            "players p99 {:.3} ms, bodies p99 {:.3} ms (all frames: players p99 {:.3}, bodies p99 {:.3})",
            client.steady_interp_delay_diff_ms.p99,
            client.steady_dyn_delay_diff_ms.p99,
            client.interp_delay_diff_ms.p99,
            client.dyn_delay_diff_ms.p99
        ),
    ));
    let worst_reference = client.vs_reference_m.values().map(|p| p.p99).fold(0.0, f64::max);
    checks.push((
        "(b) lab drawn positions vs the recorded tape through the same client, p99".into(),
        worst_reference <= 0.01,
        format!("{:?}", client.vs_reference_m.iter().map(|(k, p)| (k.clone(), p.p99)).collect::<BTreeMap<_, _>>()),
    ));
    let pass = checks.iter().all(|(_, ok, _)| *ok) && (exact_capture || !strict);
    let mut summary = format!(
        "CALIBRATION {} ({})\n",
        if pass { "PASS" } else { "FAIL" },
        if exact_capture { "exact capture" } else { "legacy capture: bytes compared modulo known gaps" }
    );
    for (name, ok, detail) in &checks {
        let _ = writeln!(summary, "  [{}] {name}: {detail}", if *ok { "ok" } else { "FAIL" });
    }
    if !client.vs_live_m.is_empty() {
        let _ = writeln!(
            summary,
            "  [info] drawn vs live renderer samples ({} samples), p50/p99 m: lab {:?} | recorded-tape replay {:?}",
            client.live_samples,
            client.vs_live_m.iter().map(|(k, p)| (k.clone(), (p.p50, p.p99))).collect::<BTreeMap<_, _>>(),
            client.reference_vs_live_m.iter().map(|(k, p)| (k.clone(), (p.p50, p.p99))).collect::<BTreeMap<_, _>>()
        );
    }
    for note in bytes.notes.iter().chain(&client.notes) {
        let _ = writeln!(summary, "  note: {note}");
    }
    let verdict = Verdict { pass, exact_capture, checks, summary };
    std::fs::write(
        out.join("calibration.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "verdict": verdict, "bytes": bytes, "client": client,
        }))?,
    )?;
    std::fs::write(out.join("calibration.md"), format!("# Netlab v2 calibration\n\n```\n{}```\n", verdict.summary))?;
    Ok(verdict)
}

// ── matrix and compare ──────────────────────────────────────────────────────

fn matrix_markdown(rows: &[Headline]) -> String {
    let mut s = String::new();
    let classes: std::collections::BTreeSet<String> =
        rows.iter().flat_map(|r| r.classes.keys().cloned()).collect();
    let _ = writeln!(s, "## Bytes and link\n");
    let _ = writeln!(s, "| run | link | knobs | down kbit/s | reliable | datagram | snapshot | city | dgram lost | retransmits | HOL p99 ms | body delay p50 ms | behind server p50 ms | clock backsteps |");
    let _ = writeln!(s, "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for r in rows {
        let _ = writeln!(
            s,
            "| {} | {} | {} | {:.0} | {:.0} | {:.0} | {:.0} | {:.0} | {} | {} | {:.1} | {:.1} | {:.1} | {} |",
            r.run, r.link, if r.knobs.is_empty() { "production" } else { &r.knobs }, r.down_kbps, r.reliable_kbps,
            r.datagram_kbps, r.snapshot_kbps, r.city_kbps, r.datagrams_lost, r.retransmits, r.reliable_hol_p99_ms,
            r.dyn_delay_p50_ms, r.dyn_behind_now_p50_ms, r.render_backsteps
        );
    }
    let _ = writeln!(s, "\n## Fidelity per class: error at render time p50 / p99 (m), error now p50 (m), artifacts/min, extrapolated %\n");
    let mut head = "| run |".to_string();
    let mut rule = "|---|".to_string();
    for class in &classes {
        head.push_str(&format!(" {class} |"));
        rule.push_str("---|");
    }
    head.push_str(" meteors err p99 / backward / handover max | city lever p50 / p99 m, perceptible |");
    rule.push_str("---|---|");
    let _ = writeln!(s, "{head}\n{rule}");
    for r in rows {
        let mut line = format!("| {} |", r.run);
        for class in &classes {
            match r.classes.get(class) {
                Some((p50, p99, now, art, extra)) => line.push_str(&format!(
                    " {:.3} / {:.3}, {:.3}, {:.1}, {:.0}% |",
                    p50, p99, now, art, extra * 100.0
                )),
                None => line.push_str(" - |"),
            }
        }
        line.push_str(&format!(
            " {:.2} m / {} / {:.2} m |",
            r.meteor_err_p99_m, r.meteor_backward_frames, r.meteor_handover_max_m
        ));
        line.push_str(&match (r.city_lever_p50_m, r.city_lever_p99_m, r.city_perceptible) {
            (Some(a), Some(b), Some(c)) => format!(" {a:.3} / {b:.3}, {:.2}% |", c * 100.0),
            _ => " - |".into(),
        });
        let _ = writeln!(s, "{line}");
    }
    s
}

/// `netlab2 matrix`: link profiles x knob sets on one frozen bundle.
pub fn cmd_matrix(args: &Args) {
    let bundle = Bundle::open(&args.path("bundle")).unwrap_or_else(|e| die(&e.to_string()));
    let out = args.path("out");
    std::fs::create_dir_all(&out).unwrap();
    let links: Vec<String> = args
        .get("links")
        .unwrap_or("recorded,lan,lte,poor-mobile")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|link| {
            // Recorded arrivals only exist on the recorded pace.
            let keep = !(link == crate::RECORDED && args.get("pace") == Some("ideal"));
            if !keep {
                eprintln!("netlab2: skipping the recorded link under --pace ideal");
            }
            keep
        })
        .collect();
    // name:k=v,k=v;name2:k=v
    let mut knob_sets: Vec<(String, String)> = vec![("production".into(), String::new())];
    if let Some(sets) = args.get("knob-sets") {
        knob_sets = sets
            .split(';')
            .filter(|s| !s.trim().is_empty())
            .map(|set| {
                let (name, knobs) = set.split_once(':').unwrap_or((set, ""));
                (name.trim().to_string(), knobs.trim().to_string())
            })
            .collect();
    }
    let mut rows = Vec::new();
    for link in &links {
        for (set_name, knobs) in &knob_sets {
            let name = format!("{link}__{set_name}");
            let dir = out.join(&name);
            let mut run_args = args.clone();
            run_args.values.insert("link".into(), vec![link.clone()]);
            run_args.values.remove("knob");
            if !knobs.is_empty() {
                run_args.values.insert("knob".into(), vec![knobs.clone()]);
            }
            eprintln!("── {name}");
            let (spec, config) = crate::run_spec(&run_args);
            let run = crate::run_stream(&bundle, &spec, &config, &dir).unwrap_or_else(|e| die(&e.to_string()));
            crate::run_client_stage_for(
                &bundle,
                &dir.join("lab.vltape"),
                &dir,
                &spec.frames,
                &crate::client_root(args),
                &name,
                spec.pace,
            )
            .unwrap_or_else(|e| die(&e.to_string()));
            let card = crate::score::score_run(&bundle, &dir, &run.report).unwrap_or_else(|e| die(&e.to_string()));
            write_run_report(&dir, &run.report, &card).unwrap();
            rows.push(headline(&name, &run.report, &card));
        }
    }
    let mut md = format!(
        "# Netlab v2 matrix\n\nbundle `{}` (player {}), pace {}, frames {}\n\n",
        bundle.dir.display(),
        bundle.player,
        args.get("pace").unwrap_or("recorded"),
        args.get("frames").unwrap_or("recorded")
    );
    md.push_str(&matrix_markdown(&rows));
    std::fs::write(out.join("matrix.md"), &md).unwrap();
    std::fs::write(out.join("matrix.json"), serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    println!("{md}");
}

fn read_headline(dir: &Path) -> Headline {
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join("report.json")).unwrap_or_else(|e| die(&format!("{}: {e}", dir.display()))),
    )
    .unwrap();
    serde_json::from_value(value["headline"].clone()).unwrap_or_else(|e| die(&e.to_string()))
}

/// `netlab2 compare --a D1 --b D2`: before/after on the same frozen truth
/// (runs or matrix directories).
pub fn cmd_compare(args: &Args) {
    let a = args.path("a");
    let b = args.path("b");
    let runs = |dir: &PathBuf| -> Vec<(String, Headline)> {
        if dir.join("report.json").is_file() {
            return vec![(String::new(), read_headline(dir))];
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().join("report.json").is_file() {
                out.push((entry.file_name().to_string_lossy().to_string(), read_headline(&entry.path())));
            }
        }
        out.sort_by(|x, y| x.0.cmp(&y.0));
        out
    };
    let (ra, rb) = (runs(&a), runs(&b));
    let mut md = format!("# Netlab v2 compare\n\nA = `{}`\nB = `{}`\n\n", a.display(), b.display());
    let _ = writeln!(md, "| run | metric | A | B | B - A |");
    let _ = writeln!(md, "|---|---|---:|---:|---:|");
    for (name, ha) in &ra {
        let Some((_, hb)) = rb.iter().find(|(n, _)| n == name) else { continue };
        let mut row = |metric: &str, x: f64, y: f64| {
            let _ = writeln!(md, "| {name} | {metric} | {x:.3} | {y:.3} | {:+.3} |", y - x);
        };
        row("down kbit/s", ha.down_kbps, hb.down_kbps);
        row("snapshot kbit/s", ha.snapshot_kbps, hb.snapshot_kbps);
        row("city kbit/s", ha.city_kbps, hb.city_kbps);
        row("body delay p50 ms", ha.dyn_delay_p50_ms, hb.dyn_delay_p50_ms);
        row("drawn behind server p50 ms", ha.dyn_behind_now_p50_ms, hb.dyn_behind_now_p50_ms);
        row("render clock backsteps", ha.render_backsteps as f64, hb.render_backsteps as f64);
        row("clock lag p50 ms", ha.clock_lag_p50_ms, hb.clock_lag_p50_ms);
        row("clock lag p99 ms", ha.clock_lag_p99_ms, hb.clock_lag_p99_ms);
        row("stale body frames", ha.stale_body_frames as f64, hb.stale_body_frames as f64);
        row("stale body max ms", ha.stale_body_max_ms, hb.stale_body_max_ms);
        row("stale meteor frames", ha.stale_meteor_frames as f64, hb.stale_meteor_frames as f64);
        if ha.meteor_flights > 0 && hb.meteor_flights > 0 {
            row("meteor err p99 m", ha.meteor_err_p99_m, hb.meteor_err_p99_m);
            row("meteor backward frames", ha.meteor_backward_frames as f64, hb.meteor_backward_frames as f64);
            row("meteor handover max m", ha.meteor_handover_max_m, hb.meteor_handover_max_m);
        }
        for (class, (p50, p99, now, art, extra)) in &ha.classes {
            if let Some((p50b, p99b, nowb, artb, extrab)) = hb.classes.get(class) {
                row(&format!("{class} err@render p50 m"), *p50, *p50b);
                row(&format!("{class} err@render p99 m"), *p99, *p99b);
                row(&format!("{class} err@now p50 m"), *now, *nowb);
                row(&format!("{class} artifacts/min"), *art, *artb);
                row(&format!("{class} extrapolated share"), *extra, *extrab);
            }
        }
        let classes: std::collections::BTreeSet<&String> =
            ha.class_frames.keys().chain(hb.class_frames.keys()).collect();
        for class in classes {
            let frames = |h: &Headline| h.class_frames.get(class).copied().unwrap_or(0) as f64;
            row(&format!("{class} frames drawn"), frames(ha), frames(hb));
        }
        if let (Some(x), Some(y)) = (ha.city_lever_p99_m, hb.city_lever_p99_m) {
            row("city lever p99 m", x, y);
        }
    }
    if let Some(out) = args.get("out") {
        std::fs::create_dir_all(out).unwrap();
        std::fs::write(Path::new(out).join("compare.md"), &md).unwrap();
    }
    println!("{md}");
}
