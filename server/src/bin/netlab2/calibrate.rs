//! The proxy check. Netlab v2 is only a measurement of the shipping system
//! if, fed a live loopback recording and its recorded arrival times, it
//! reproduces:
//!
//!   (a) the bytes the live server sent this client -- every lab-generated
//!       packet against the live send-log record for the same tick, kind and
//!       ordinal (CRC32 + length), per lane and kind;
//!   (b) what the live client computed from them -- the lab's client clock
//!       (server-time offset and both interpolation delays) against the clock
//!       state the live client recorded on every frame, and the lab's drawn
//!       positions against the live renderer's samples (`live-samples.json`,
//!       when the recording harness wrote one);
//!   (c) and it names every divergence that remains.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::bundle::Bundle;
use crate::stream::{self, Origin, Stream};
use crate::{die, kind_name, Args};

#[derive(Clone, Debug, Default, Serialize)]
pub struct KindMatch {
    pub lab: u64,
    pub matched: u64,
    pub mismatched: u64,
    /// Lab packets with no live record at that (tick, kind, ordinal).
    pub lab_extra: u64,
    /// Live records in the lab's window the lab did not produce.
    pub live_missing: u64,
    pub match_rate: f64,
    /// Mismatches that are byte-identical once the SnapshotV2 wall-clock
    /// trailer is removed: a capture from a server that predates it.
    pub matched_modulo_trailer: u64,
    pub match_modulo_trailer_rate: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Mismatch {
    pub tick: u32,
    pub kind: String,
    pub ordinal: u32,
    pub lab_len: usize,
    pub live_len: u32,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ByteMatch {
    pub kinds: BTreeMap<String, KindMatch>,
    pub total: KindMatch,
    pub first_mismatches: Vec<Mismatch>,
    pub notes: Vec<String>,
}

/// Field-level diff of two V2 snapshots, for the mismatch report.
fn snapshot_diff(lab: &[u8], live: Option<&[u8]>) -> String {
    let Some(live) = live else {
        return "live bytes not on the tape".into();
    };
    if lab.len() < 23 || live.len() < 23 {
        return "short".into();
    }
    let counts = |b: &[u8]| (b[19], b[20], b[21], b[22]);
    let header = |b: &[u8]| b[1..19].to_vec();
    let mut parts = Vec::new();
    if header(lab) != header(live) {
        parts.push("header (tick/ack/anchor)".to_string());
    }
    if counts(lab) != counts(live) {
        parts.push(format!("counts lab {:?} live {:?} (remote,spheres,boxes,vehicles)", counts(lab), counts(live)));
    }
    if lab.get(23..56) != live.get(23..56) {
        parts.push("self state".into());
    }
    if parts.is_empty() {
        parts.push("entity records".into());
    }
    parts.join("; ")
}

pub fn byte_match(bundle: &Bundle, stream: &Stream) -> ByteMatch {
    let mut out = ByteMatch::default();
    let mut used_records: HashSet<usize> = HashSet::new();
    let mut lab_ticks: BTreeMap<u8, (u32, u32)> = BTreeMap::new();
    for packet in stream.packets.iter().filter(|p| p.origin == Origin::Lab) {
        let entry = out.kinds.entry(kind_name(packet.kind)).or_default();
        entry.lab += 1;
        let span = lab_ticks.entry(packet.kind).or_insert((u32::MAX, 0));
        span.0 = span.0.min(packet.tick);
        span.1 = span.1.max(packet.tick);
        match packet.live_record {
            None => entry.lab_extra += 1,
            Some(record_index) => {
                used_records.insert(record_index);
                let record = &bundle.sendlog[record_index];
                let crc = crc32fast::hash(&packet.bytes);
                let trailer = crate::protocol::SNAPSHOT_V2_TRAILER_BYTES;
                if crc == record.crc32 && packet.bytes.len() as u32 == record.size {
                    entry.matched += 1;
                } else if packet.kind == vibe_land_shared::constants::PKT_SNAPSHOT_V2
                    && packet.bytes.len() == record.size as usize + trailer
                    && crc32fast::hash(&packet.bytes[..packet.bytes.len() - trailer]) == record.crc32
                {
                    entry.matched_modulo_trailer += 1;
                } else {
                    entry.mismatched += 1;
                    if out.first_mismatches.len() < 40 {
                        let live_bytes = stream
                            .join
                            .record_to_tape
                            .get(&record_index)
                            .map(|&t| bundle.tape.packets[t].bytes.as_slice());
                        let detail = if stream::is_snapshot_kind(packet.kind) {
                            snapshot_diff(&packet.bytes, live_bytes)
                        } else {
                            match live_bytes {
                                Some(live) => {
                                    let first = packet.bytes.iter().zip(live).position(|(a, b)| a != b);
                                    format!("first differing byte {first:?}")
                                }
                                None => "live bytes not on the tape".into(),
                            }
                        };
                        out.first_mismatches.push(Mismatch {
                            tick: packet.tick,
                            kind: kind_name(packet.kind),
                            ordinal: packet.ordinal,
                            lab_len: packet.bytes.len(),
                            live_len: record.size,
                            detail,
                        });
                    }
                }
            }
        }
    }
    // Live records of a lab-generated kind, inside the lab's tick span for
    // that kind, that no lab packet claimed.
    for (index, record) in bundle.sendlog.iter().enumerate() {
        if record.player != bundle.player || used_records.contains(&index) {
            continue;
        }
        let Some(&(lo, hi)) = lab_ticks.get(&record.kind) else {
            continue;
        };
        if record.tick >= lo && record.tick <= hi {
            out.kinds.entry(kind_name(record.kind)).or_default().live_missing += 1;
        }
    }
    let mut total = KindMatch::default();
    for entry in out.kinds.values_mut() {
        entry.match_rate = entry.matched as f64 / (entry.lab + entry.live_missing).max(1) as f64;
        entry.match_modulo_trailer_rate = (entry.matched + entry.matched_modulo_trailer) as f64
            / (entry.lab + entry.live_missing).max(1) as f64;
        total.matched_modulo_trailer += entry.matched_modulo_trailer;
        total.lab += entry.lab;
        total.matched += entry.matched;
        total.mismatched += entry.mismatched;
        total.lab_extra += entry.lab_extra;
        total.live_missing += entry.live_missing;
    }
    total.match_rate = total.matched as f64 / (total.lab + total.live_missing).max(1) as f64;
    total.match_modulo_trailer_rate = (total.matched + total.matched_modulo_trailer) as f64
        / (total.lab + total.live_missing).max(1) as f64;
    out.total = total;
    out.notes = bundle.warnings.clone();
    out
}

pub fn byte_match_summary(m: &ByteMatch) -> String {
    let mut s = format!(
        "calibration (a) bytes: {}/{} lab packets byte-identical to the live send log ({:.2}%); mismatched {}, lab-only {}, live-only {}\n",
        m.total.matched,
        m.total.lab + m.total.live_missing,
        m.total.match_rate * 100.0,
        m.total.mismatched,
        m.total.lab_extra,
        m.total.live_missing
    );
    for (kind, k) in &m.kinds {
        s.push_str(&format!(
            "  {kind:<22} lab {:>6} matched {:>6} ({:>6.2}%) +{} modulo trailer | mismatched {:>5} lab-only {:>4} live-only {:>4}\n",
            k.lab, k.matched, k.match_rate * 100.0, k.matched_modulo_trailer, k.mismatched, k.lab_extra, k.live_missing
        ));
    }
    for mismatch in m.first_mismatches.iter().take(8) {
        s.push_str(&format!(
            "    tick {} {} #{}: lab {} B live {} B: {}\n",
            mismatch.tick, mismatch.kind, mismatch.ordinal, mismatch.lab_len, mismatch.live_len, mismatch.detail
        ));
    }
    s
}

/// `netlab2 calibrate`: the full proxy check, as a runnable gate.
pub fn cmd_calibrate(args: &Args) {
    let bundle_dir = args.path("bundle");
    let bundle = Bundle::open(&bundle_dir).unwrap_or_else(|e| die(&e.to_string()));
    let out = args.path("out");
    let mut spec_args = args.clone();
    spec_args.values.insert("link".into(), vec![crate::RECORDED.into()]);
    spec_args.values.insert("pace".into(), vec!["recorded".into()]);
    let (spec, config) = crate::run_spec(&spec_args);
    let run = crate::run_stream(&bundle, &spec, &config, &out).unwrap_or_else(|e| die(&e.to_string()));
    let bytes = byte_match(&bundle, &run.stream);
    println!("{}", byte_match_summary(&bytes));

    // (b): the same client code over the lab's tape and over the recorded
    // tape; both are compared with what the live client recorded.
    let client_root = crate::client_root(args);
    let recorded = crate::stream::Pace::Recorded;
    crate::run_client_stage_for(&bundle, &out.join("lab.vltape"), &out, "recorded", &client_root, "lab", recorded)
        .unwrap_or_else(|e| die(&e.to_string()));
    let reference = out.join("reference");
    crate::run_client_stage_for(&bundle, &bundle_dir.join("client.vltape"), &reference, "recorded", &client_root, "recorded", recorded)
        .unwrap_or_else(|e| die(&e.to_string()));
    let live_samples = args
        .get("live-samples")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            // record.mjs: <out>/bundle + <out>/live-samples.json.
            let guess = bundle_dir.parent()?.join("live-samples.json");
            guess.is_file().then_some(guess)
        })
        .or_else(|| {
            // city bench: <run>/debug-reports/session-...-c<n> + <run>/client-<n>-drawn.jsonl.
            let name = bundle_dir.file_name()?.to_string_lossy().to_string();
            let n = name.rsplit_once("-c")?.1.parse::<u32>().ok()?;
            let guess = bundle_dir.parent()?.parent()?.join(format!("client-{n}-drawn.jsonl"));
            guess.is_file().then_some(guess)
        });
    let client = crate::score::client_calibration(&bundle, &out, &reference, live_samples.as_deref())
        .unwrap_or_else(|e| die(&e.to_string()));
    let card = crate::score::score_run(&bundle, &out, &run.report).unwrap_or_else(|e| die(&e.to_string()));
    let mut client = client;
    client.lab_classes_drawn = card
        .all_draws
        .as_ref()
        .map(|all| all.classes.iter().filter(|(_, c)| c.scored > 0.0).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default();
    crate::report::write_run_report(&out, &run.report, &card).unwrap();
    let verdict = crate::report::write_calibration(&out, &bytes, &client, args.get("strict").is_some())
        .unwrap_or_else(|e| die(&e.to_string()));
    println!("{}", verdict.summary);
    if !verdict.pass {
        std::process::exit(1);
    }
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> std::io::Result<T> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
