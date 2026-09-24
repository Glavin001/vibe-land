//! Integration test on a small synthetic bundle, written with the capture's
//! own writers: a "live" match (the production snapshot builder, run from
//! tick 0) whose session capture starts mid-match at tick 60, so the lab must
//! resume the selection from `snapshot-baseline.json` to reproduce it.
//!
//! What it pins: the bundle loader, the send-log join, the per-(tick, kind,
//! ordinal) matching, the mid-match baseline, the recorded link, the tape the
//! client stage reads, and the simulated link's determinism -- end to end on
//! the Rust side. (The client stage is exercised on real bundles by
//! `netlab2 calibrate`; see docs/netlab-v2.md.)

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::PathBuf;

use crate::bundle::Bundle;
use crate::protocol::{encode_server_packet, make_net_dynamic_body_state, make_net_player_state};
use crate::send_log::{SendRecord, MAGIC as SEND_MAGIC};
use crate::session_capture::{
    self as sc, BodyTruth, PlayerTruth, SnapshotBaseline, SnapshotInputs, TickBundle, TickTiming, TickTruth,
};
use crate::snapshot_builder::{
    build_recipient_snapshot, BodyMeta, RecipientInput, RecipientInterest, SnapshotConfig, SnapshotWorld,
};
use crate::stream::{self, Pace, StreamConfig};
use crate::vltape::{ClientTape, TapePacket, CHANNEL_WT_DATAGRAM, CHANNEL_WT_RELIABLE, MAGIC_V2};

const PLAYER: u32 = 1;
/// Off the 60-tick cold-refresh phase, so a cold (baseline-less) replay
/// refreshes resting bodies at different ticks from the live match.
const CAPTURE_FROM: u32 = 75;
const TICKS: u32 = 240;
const TICK_US: u64 = 16_667;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("netlab2-fixture-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The world at `tick`: the client walking, a remote player, and bodies at
/// several distances -- some resting (cold refresh), one rolling, one far
/// beyond the AOI that walks into it.
fn truth(tick: u32) -> TickTruth {
    let t = tick as f32 / 60.0;
    let mut bodies = Vec::new();
    for (i, (x, z, moving)) in
        [(5.0, 0.0, false), (20.0, 3.0, false), (30.0, -4.0, true), (70.0, 10.0, false), (95.0 - t * 4.0, 0.0, true)]
            .into_iter()
            .enumerate()
    {
        let speed = if moving { 4.0 } else { 0.0 };
        bodies.push(BodyTruth {
            id: 100 + i as u32,
            handle: 1 + i as u16,
            shape: if i % 2 == 0 { 1 } else { 2 },
            position: [x + if i == 2 { speed * t } else { 0.0 }, 0.5, z],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: [0.5, 0.5, 0.5],
            velocity: [speed, 0.0, 0.0],
            angular_velocity: [0.0, 0.0, 0.0],
        });
    }
    TickTruth {
        tick,
        mono_us: u64::from(tick) * TICK_US,
        unix_us: 1_000_000 + u64::from(tick) * TICK_US,
        players: vec![
            PlayerTruth {
                id: PLAYER,
                handle: 1,
                hp: 100,
                position: [t * 1.5, 0.0, 0.0],
                velocity: [1.5, 0.0, 0.0],
                ..Default::default()
            },
            PlayerTruth { id: 2, handle: 2, hp: 90, position: [10.0, 0.0, 5.0 + t], velocity: [0.0, 0.0, 1.0], ..Default::default() },
        ],
        vehicles: Vec::new(),
        bodies,
    }
}

fn body_meta(truth: &TickTruth) -> HashMap<u32, BodyMeta> {
    truth
        .bodies
        .iter()
        .map(|b| (b.id, BodyMeta { handle: b.handle, shape_type: b.shape, half_extents_m: b.half_extents }))
        .collect()
}

/// The live match's snapshot for the client at `tick` -- the same call the
/// server's `broadcast_snapshot` makes.
fn live_snapshot(tick: u32, interest: &mut RecipientInterest, ack: u16) -> Vec<u8> {
    let truth = truth(tick);
    let players: Vec<_> = truth
        .players
        .iter()
        .map(|p| (p.id, p.position, make_net_player_state(p.id, p.position, p.velocity, p.yaw, p.pitch, p.hp, p.flags, 7.5)))
        .collect();
    let bodies: Vec<_> = truth
        .bodies
        .iter()
        .map(|b| {
            (b.id, b.position, b.rotation, make_net_dynamic_body_state(b.id, b.position, b.rotation, b.half_extents, b.velocity, b.angular_velocity, b.shape))
        })
        .collect();
    let player_handles: HashMap<u32, u8> = truth.players.iter().map(|p| (p.id, p.handle)).collect();
    let world = SnapshotWorld {
        server_tick: tick,
        server_time_us: u64::from(tick) * TICK_US,
        server_wall_us: (u64::from(tick) * 16_700) as u32,
        players: &players,
        bodies: &bodies,
        vehicles: &[],
        player_handles: &player_handles,
        vehicle_handles: &HashMap::new(),
        body_meta: &body_meta(&truth),
    };
    let recipient = RecipientInput { id: PLAYER, ack_input_seq: ack, support: None };
    let (packet, _) =
        build_recipient_snapshot(&world, &recipient, interest, true, &SnapshotConfig::PRODUCTION).unwrap();
    encode_server_packet(&packet)
}

/// Writes the bundle; returns its directory.
fn write_bundle(name: &str, with_baseline: bool) -> PathBuf {
    write_bundle_with(name, with_baseline, None)
}

/// `repair_at`: the live server also sent this client a structure repair
/// (PKT_CITY_STRUCTURE_BOOTSTRAP, reliable) after that tick's snapshot.
fn write_bundle_with(name: &str, with_baseline: bool, repair_at: Option<u32>) -> PathBuf {
    let dir = temp_dir(name);
    let server = dir.join("server");
    std::fs::write(
        dir.join(sc::MANIFEST_FILE),
        serde_json::to_vec(&serde_json::json!({
            "client_player_id": PLAYER,
            "server": {"dir": "server", "sim_hz": 60},
        }))
        .unwrap(),
    )
    .unwrap();

    // The live match from tick 0; the capture opens after tick 59.
    let mut interest = RecipientInterest::default();
    let mut baseline = None;
    let mut writer = sc::TickWriter::open(&server, 1_000_000, 60).unwrap();
    let mut records = Vec::new();
    let mut tape = Vec::new();
    for tick in 0..TICKS {
        if tick == CAPTURE_FROM {
            baseline = Some(SnapshotBaseline {
                tick: tick - 1,
                strict_snapshot_datagrams: true,
                snapshot_hz: 60,
                interest: BTreeMap::from([(PLAYER, interest.clone())]),
                player_handles: BTreeMap::from([(1, 1), (2, 2)]),
                vehicle_handles: BTreeMap::new(),
                body_meta: body_meta(&truth(tick)).into_iter().collect(),
            });
        }
        let ack = (tick / 3) as u16;
        let bytes = live_snapshot(tick, &mut interest, ack);
        if tick < CAPTURE_FROM {
            continue;
        }
        writer.push(TickBundle {
            truth: truth(tick),
            timing: TickTiming {
                tick,
                mono_us: u64::from(tick) * TICK_US + 2_000,
                total_ms: 2.0,
                ..Default::default()
            },
            selections: Vec::new(),
        });
        writer.push_snapshot_inputs(SnapshotInputs {
            tick,
            server_wall_us: Some((u64::from(tick) * 16_700) as u32),
            recipients: vec![RecipientInput { id: PLAYER, ack_input_seq: ack, support: None }],
            meleeing: Vec::new(),
        });
        let queued_us = u64::from(tick) * TICK_US + 1_900;
        records.push(SendRecord {
            player: PLAYER,
            tick,
            queued_us,
            sent_us: queued_us + 20,
            size: bytes.len() as u32,
            crc32: crc32fast::hash(&bytes),
            kind: bytes[0],
            lane: 1,
            outcome: 0,
        });
        tape.push(TapePacket { t_ms: queued_us as f64 / 1000.0 + 0.5, channel: CHANNEL_WT_DATAGRAM, bytes });
        if repair_at == Some(tick) {
            let repair = vec![crate::stream::PKT_CITY_STRUCTURE_BOOTSTRAP, 2, 0, 0, 0, 0];
            let queued_us = queued_us + 50;
            records.push(SendRecord {
                player: PLAYER,
                tick,
                queued_us,
                sent_us: queued_us + 20,
                size: repair.len() as u32,
                crc32: crc32fast::hash(&repair),
                kind: repair[0],
                lane: 0,
                outcome: 0,
            });
            tape.push(TapePacket { t_ms: queued_us as f64 / 1000.0 + 0.5, channel: CHANNEL_WT_RELIABLE, bytes: repair });
        }
    }
    writer.finish().unwrap();
    if with_baseline {
        std::fs::write(server.join(sc::SNAPSHOT_BASELINE_FILE), serde_json::to_vec(&baseline.unwrap()).unwrap())
            .unwrap();
    }
    let mut log = std::fs::File::create(server.join(sc::SEND_LOG_FILE)).unwrap();
    let header = serde_json::to_vec(&serde_json::json!({"version": 1, "epoch_unix_us": 1_000_000})).unwrap();
    log.write_all(SEND_MAGIC).unwrap();
    log.write_all(&(header.len() as u32).to_le_bytes()).unwrap();
    log.write_all(&header).unwrap();
    for record in &records {
        log.write_all(&record.encode()).unwrap();
    }
    // The client tape: no frames, pairing samples putting both clocks on
    // the same origin.
    let client = ClientTape {
        header: serde_json::json!({
            "version": 2, "frames": 0, "frameBytes": 60, "clockOriginMs": 0.0, "localPlayerId": PLAYER,
            "durationMs": f64::from(TICKS) * 16.667,
            "pairing": {"clockSamples": [{"sentPerfMs": 10.0, "receivedPerfMs": 10.0, "serverMonoUs": 10_000.0}]},
        }),
        frame_bytes: 60,
        frames_raw: Vec::new(),
        frames: Vec::new(),
        packets: Vec::new(),
    };
    client.write_with_packets(&dir.join(sc::CLIENT_TAPE_FILE), &tape, serde_json::json!({})).unwrap();
    dir
}

fn recorded_spec() -> crate::RunSpec {
    crate::RunSpec {
        link: crate::RECORDED.into(),
        profile: None,
        pace: Pace::Recorded,
        seed: 1,
        knobs: BTreeMap::new(),
        frames: "recorded".into(),
    }
}

#[test]
fn a_mid_match_capture_replays_byte_for_byte_from_its_baseline() {
    let dir = write_bundle("exact", true);
    let bundle = Bundle::open(&dir).unwrap();
    assert!(bundle.warnings.iter().all(|w| !w.contains("baseline")), "{:?}", bundle.warnings);
    assert_eq!(bundle.first_tick(), CAPTURE_FROM);
    assert!(bundle.clock_offset_ms.abs() < 1e-9);
    let out = dir.join("run");
    let run = crate::run_stream(&bundle, &recorded_spec(), &StreamConfig::default(), &out).unwrap();
    let bytes = crate::calibrate::byte_match(&bundle, &run.stream);
    let snapshots = &bytes.kinds["snapshot_v2"];
    assert_eq!(snapshots.lab, u64::from(TICKS - CAPTURE_FROM));
    assert_eq!(snapshots.matched, snapshots.lab, "{:?}", bytes.first_mismatches);
    assert_eq!((snapshots.lab_extra, snapshots.live_missing), (0, 0));
    // The recorded link delivers each lab packet when the live one arrived,
    // and the tape the client stage reads carries them in that order.
    let tape = ClientTape::read(&out.join("lab.vltape")).unwrap();
    let recorded = ClientTape::read(&dir.join(sc::CLIENT_TAPE_FILE)).unwrap();
    assert_eq!(tape.packets.len(), recorded.packets.len());
    for (lab, live) in tape.packets.iter().zip(&recorded.packets) {
        assert_eq!(lab.bytes, live.bytes);
        assert_eq!(lab.t_ms, live.t_ms);
    }
    assert_eq!(&std::fs::read(out.join("lab.vltape")).unwrap()[..8], MAGIC_V2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn without_the_baseline_the_cold_selection_diverges_and_says_so() {
    let dir = write_bundle("cold", false);
    let bundle = Bundle::open(&dir).unwrap();
    assert!(bundle.warnings.iter().any(|w| w.contains("snapshot-baseline.json")));
    let run = crate::run_stream(&bundle, &recorded_spec(), &StreamConfig::default(), &dir.join("run")).unwrap();
    let bytes = crate::calibrate::byte_match(&bundle, &run.stream);
    let snapshots = &bytes.kinds["snapshot_v2"];
    assert!(snapshots.mismatched > 0, "empty interest memory must re-send cold bodies early");
    assert!(snapshots.matched > 0, "and converge once the cold refresh has cycled");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn simulated_links_are_deterministic_and_knobs_change_the_stream() {
    let dir = write_bundle("sim", true);
    let bundle = Bundle::open(&dir).unwrap();
    let profile = crate::link::Profile { delay_ms: 40.0, jitter_ms: 15.0, loss_pct: 5.0, ..Default::default() };
    let spec = crate::RunSpec { link: "fixture".into(), profile: Some(profile), ..recorded_spec() };
    let a = crate::run_stream(&bundle, &spec, &StreamConfig::default(), &dir.join("a")).unwrap();
    let b = crate::run_stream(&bundle, &spec, &StreamConfig::default(), &dir.join("b")).unwrap();
    assert_eq!(std::fs::read(dir.join("a/lab.vltape")).unwrap(), std::fs::read(dir.join("b/lab.vltape")).unwrap());
    let lost = a.report.lanes["datagram"].by_fate.get("lost").copied().unwrap_or(0);
    assert!(lost > 0 && lost < 30, "5% of 165 datagrams, got {lost}");
    assert_eq!(a.report.lanes["datagram"].packets, b.report.lanes["datagram"].packets);
    // Halving the snapshot rate halves the snapshots on the wire.
    let mut knobs = BTreeMap::new();
    knobs.insert("snapshot.interval_ticks".to_string(), "2".to_string());
    let half = crate::run_stream(
        &bundle,
        &spec,
        &crate::stream_config(Pace::Recorded, &knobs),
        &dir.join("half"),
    )
    .unwrap();
    let even_ticks = (CAPTURE_FROM..TICKS).filter(|tick| tick % 2 == 0).count() as u64;
    assert_eq!(half.report.kinds["snapshot_v2"].packets, even_ticks);
    // Ideal pacing puts ticks exactly 1/60 s apart.
    let ideal = stream::build(&bundle, &StreamConfig { pace: Pace::Ideal, ..Default::default() }).unwrap();
    let departures: Vec<f64> = ideal.packets.iter().map(|p| p.depart_ms).collect();
    for pair in departures.windows(2) {
        assert!((pair[1] - pair[0] - 1000.0 / 60.0).abs() < 1e-6);
    }
    let _ = std::fs::remove_dir_all(&dir);
}


/// Recorded structure repairs are replayed open loop (seam S6) unless the lab
/// is told to withhold them (`lab.recorded_repairs=0`), which is how a run
/// asks whether the client stays in sync without the repairs the live one got.
#[test]
fn recorded_structure_repairs_can_be_withheld() {
    let dir = write_bundle_with("repair", true, Some(120));
    let bundle = Bundle::open(&dir).unwrap();
    let kind = crate::stream::PKT_CITY_STRUCTURE_BOOTSTRAP;
    let replayed = stream::build(&bundle, &StreamConfig::default()).unwrap();
    assert_eq!(replayed.stats.city_structure_bootstraps_passed_through, 1);
    assert_eq!(replayed.packets.iter().filter(|p| p.kind == kind).count(), 1);
    let knobs = BTreeMap::from([("lab.recorded_repairs".to_string(), "0".to_string())]);
    let config = crate::stream_config(Pace::Recorded, &knobs);
    assert!(!config.recorded_repairs);
    let withheld = stream::build(&bundle, &config).unwrap();
    assert_eq!(withheld.stats.city_structure_bootstraps_withheld, 1);
    assert_eq!(withheld.stats.city_structure_bootstraps_passed_through, 0);
    assert!(withheld.packets.iter().all(|p| p.kind != kind));
    // Nothing else changes.
    assert_eq!(withheld.packets.len() + 1, replayed.packets.len());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn city_sync_reads_the_client_counters() {
    let stats = serde_json::json!({"city": {
        "hashChecks": 163, "hashMismatches": 0, "settleRejects": 0, "settlesAfterSilence": 5,
        "topoSeqGaps": 0, "resyncRequestsSent": 0, "structureRepairs": 5, "nacksSent": 0,
    }});
    let sync = crate::score::CitySync::from_client_stats(&stats).unwrap();
    assert_eq!((sync.hash_checks, sync.settles_after_silence, sync.repairs_asked), (163, 5, 0));
    assert_eq!(sync.structure_repairs_applied, 5);
    assert!(crate::score::CitySync::from_client_stats(&serde_json::json!({})).is_none());
}
