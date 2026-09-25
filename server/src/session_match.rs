//! The match loop's side of a paired session capture: starting and stopping
//! sessions on request, recording each tick while one runs, and ending
//! sessions whose client left or never said stop. See `session_capture` for
//! the files and `send_log` for the per-packet log.

use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, TryRecvError};
use std::time::Instant;

use serde_json::json;
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::session_capture::{
    self as sc, ActiveCapture, BodyTruth, CityCapture, PlayerTruth, SessionEntry, StartOutcome,
    StopReason, TickBundle, TickTiming, TickTruth, VehicleTruth,
};
use crate::{send_log, MatchState, SIM_HZ};

/// An HTTP-visible failure: status code and message.
pub(crate) type SessionReply = Result<serde_json::Value, (u16, String)>;

pub(crate) enum SessionCommand {
    Start {
        session_id: String,
        player_id: Option<u32>,
        bundle: PathBuf,
        reply: oneshot::Sender<SessionReply>,
    },
    Stop {
        session_id: String,
        reply: oneshot::Sender<SessionReply>,
    },
}

/// A session that never says stop (a crashed tab) ends here. Thirty minutes
/// by default: far past any deliberate recording, well short of a full disk.
pub(crate) fn session_max_us() -> u64 {
    std::env::var("VIBE_SESSION_CAPTURE_MAX_S")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30 * 60)
        .saturating_mul(1_000_000)
}

/// The tick's own measurements, for the timing record.
pub(crate) struct TickCosts {
    pub total_ms: f32,
    pub city_ms: f32,
    pub publish_ms: f32,
    pub unattributed_ms: f32,
    /// This tick's own snapshot cost: 0 when it sent none.
    pub snapshot_ms: f32,
    pub snapshot_sent: bool,
    pub shots_ms: f32,
    pub meteors_launched: u32,
    pub meteor_launch_ms: f32,
    /// City work run inside the split step's GPU window.
    pub overlap_ms: f32,
}

impl MatchState {
    pub(crate) fn session_capture_active(&self) -> bool {
        self.session_capture.is_some()
    }

    pub(crate) fn handle_session_command(&mut self, command: SessionCommand) {
        match command {
            SessionCommand::Start { session_id, player_id, bundle, reply } => {
                let result = self.start_session(session_id, player_id, bundle);
                let _ = reply.send(result);
            }
            SessionCommand::Stop { session_id, reply } => {
                self.stop_session(&session_id, StopReason::Requested, Some(reply));
            }
        }
    }

    fn start_session(
        &mut self,
        session_id: String,
        player_id: Option<u32>,
        bundle: PathBuf,
    ) -> SessionReply {
        if let Some(player) = player_id {
            if !self.players.contains_key(&player) {
                return Err((409, format!("player {player} is not connected to this match")));
            }
        }
        let outcome = self
            .session_capture
            .as_ref()
            .map_or(StartOutcome::OpenCapture, |capture| capture.sessions.classify_start(&session_id));
        if outcome == StartOutcome::OpenCapture {
            self.open_session_capture(&session_id, &bundle)?;
        }
        let tick = self.server_tick;
        let capture = self.session_capture.as_mut().expect("opened above");
        if outcome != StartOutcome::AlreadyActive {
            let start = capture.mark(tick);
            capture.sessions.insert(SessionEntry {
                session_id: session_id.clone(),
                player_id,
                bundle,
                start,
            });
            info!(
                match_id = %self.id, session_id, ?player_id, tick,
                shared = capture.sessions.len(),
                "session capture: session started"
            );
        }
        let entry = capture.sessions.get(&session_id).expect("inserted above");
        Ok(json!({
            "session_id": session_id,
            "match_id": self.id,
            "player_id": entry.player_id,
            "joined": outcome == StartOutcome::JoinCapture,
            "already_active": outcome == StartOutcome::AlreadyActive,
            "start": entry.start,
            "capture_epoch_unix_us": capture.epoch_unix_us,
            "capture_start": capture.started,
            "server_dir": sc::relative_to_bundle(&entry.bundle, &capture.server_dir),
            "opened_by": capture.opened_by,
            "shared_with": capture.sessions.ids().into_iter().filter(|id| *id != session_id).collect::<Vec<_>>(),
            "city_capture": capture.city.describe(),
            "sim_hz": SIM_HZ,
        }))
    }

    fn open_session_capture(&mut self, session_id: &str, bundle: &std::path::Path) -> Result<(), (u16, String)> {
        let epoch = Instant::now();
        let epoch_unix_us = sc::unix_us();
        let server_dir = bundle.join(sc::SERVER_DIR);
        let failed = |what: &str, error: std::io::Error| (500, format!("{what}: {error}"));
        let ticks = sc::TickWriter::open(&server_dir, epoch_unix_us, u32::from(SIM_HZ))
            .map_err(|error| failed("tick writer", error))?;
        let (send_log, sink) = send_log::SendLogWriter::open(
            &server_dir.join(sc::SEND_LOG_FILE),
            epoch,
            epoch_unix_us,
            send_log::QUEUE_RECORDS,
        )
        .map_err(|error| failed("send log", error))?;
        let city = match self.city.as_ref() {
            None => CityCapture::NotCity,
            Some(city) if city.capturing() => CityCapture::External(PathBuf::from(
                std::env::var("VIBE_CITY_TAPE_OUT").unwrap_or_default(),
            )),
            Some(city) => {
                // The encoder capture writes the whole manifest before its
                // first tick; open it on a helper thread and install it when
                // it is ready (`poll_session_capture`).
                let spec = city.capture_spec();
                let dir = server_dir.join(sc::CITY_DIR);
                let (tx, rx) = sync_channel(1);
                let spawned = std::thread::Builder::new()
                    .name("capture-open".into())
                    .spawn(move || {
                        let _ = tx.send(crate::city::open_capture_at(&spec, &dir));
                    });
                match spawned {
                    Ok(_) => CityCapture::Opening(rx),
                    Err(error) => CityCapture::Failed(error.to_string()),
                }
            }
        };
        // The snapshot selection's memory of every connected player, so an
        // offline replay (Netlab v2) can resume it mid-match exactly.
        let baseline = sc::SnapshotBaseline {
            tick: self.server_tick,
            strict_snapshot_datagrams: self.strict_snapshot_datagrams,
            snapshot_hz: u32::from(self.physics.snapshot_hz()),
            interest: self
                .players
                .iter()
                .map(|(id, runtime)| (*id, runtime.snapshot_interest.clone()))
                .collect(),
            player_handles: self.player_handles.iter().map(|(k, v)| (*k, *v)).collect(),
            vehicle_handles: self.vehicle_handles.iter().map(|(k, v)| (*k, *v)).collect(),
            body_meta: self.dynamic_body_handles.iter().map(|(k, v)| (*k, *v)).collect(),
            compact_self: crate::snapshot_builder::SnapshotConfig::PRODUCTION.compact_self,
            removals: crate::snapshot_builder::SnapshotConfig::PRODUCTION.removals,
        };
        if let Err(error) = serde_json::to_vec(&baseline)
            .map_err(std::io::Error::from)
            .and_then(|bytes| std::fs::write(server_dir.join(sc::SNAPSHOT_BASELINE_FILE), bytes))
        {
            warn!(%error, "session capture: snapshot baseline not written");
        }
        self.io.send_hub.attach(sink);
        let started = sc::ServerMark { tick: self.server_tick, unix_us: epoch_unix_us, mono_us: 0 };
        info!(
            match_id = %self.id, session_id, dir = %server_dir.display(), tick = self.server_tick,
            "session capture: recording"
        );
        self.session_capture = Some(ActiveCapture {
            epoch,
            epoch_unix_us,
            server_dir,
            opened_by: session_id.to_string(),
            started,
            sessions: Default::default(),
            ticks,
            send_log,
            city,
            selections: Vec::new(),
        });
        Ok(())
    }

    /// Ends one session. The last session out stops the capture: the send
    /// log is detached here, and the writers are drained on a helper thread
    /// (joining them could take as long as the disk is behind), which then
    /// writes the session's manifest and replies.
    pub(crate) fn stop_session(
        &mut self,
        session_id: &str,
        reason: StopReason,
        reply: Option<oneshot::Sender<SessionReply>>,
    ) {
        let tick = self.server_tick;
        let Some(capture) = self.session_capture.as_mut() else {
            if let Some(reply) = reply {
                let _ = reply.send(Err((404, "no session capture is running".into())));
            }
            return;
        };
        let Some((entry, last)) = capture.sessions.remove(session_id) else {
            if let Some(reply) = reply {
                let _ = reply.send(Err((404, format!("session {session_id} is not running"))));
            }
            return;
        };
        let stop = capture.mark(tick);
        let server_dir = sc::relative_to_bundle(&entry.bundle, &capture.server_dir);
        let remaining = capture.sessions.ids();
        let finishing = if last {
            self.io.send_hub.detach();
            let capture = self.session_capture.take().expect("checked above");
            // The bundle holding the files, when another session opened them.
            let opener = capture
                .server_dir
                .parent()
                .filter(|dir| *dir != entry.bundle.as_path())
                .map(|dir| dir.to_path_buf());
            let city = match capture.city {
                CityCapture::Owned => self.city.as_mut().and_then(|city| city.take_capture()),
                _ => None,
            };
            Some((capture, city, opener))
        } else {
            None
        };
        info!(
            match_id = %self.id, session_id, tick, ?reason, capture_finished = last,
            "session capture: session stopped"
        );
        let stats_registry = self.stats_registry.clone();
        let match_id = self.id.clone();
        let session_id = session_id.to_string();
        let spawned = std::thread::Builder::new().name("capture-finish".into()).spawn(move || {
            let capture = finishing.map(|(capture, city, opener)| {
                let summary = capture.finish(city, stop);
                // The opener stopped earlier and recorded the capture as still
                // running; tell its manifest how the capture ended.
                if let Some(opener) = opener {
                    let patch = json!({"server": {"capture_final": summary.clone()}});
                    if let Err(error) = sc::merge_manifest(&opener, patch) {
                        warn!(%error, "session manifest update (opener) failed");
                    }
                }
                summary
            });
            let stats = stats_registry
                .read()
                .ok()
                .and_then(|registry| registry.get(&match_id).cloned());
            if let Some(stats) = stats {
                if let Ok(bytes) = serde_json::to_vec_pretty(&stats) {
                    let _ = std::fs::write(entry.bundle.join(sc::STATS_STOP_FILE), bytes);
                }
            }
            let summary = json!({
                "session_id": session_id,
                "stop": stop,
                "reason": reason,
                "capture_finished": last,
                "still_recording_for": remaining,
                "server_dir": server_dir,
                "capture": capture,
            });
            let patch = json!({
                "server": {
                    "stop": stop,
                    "stop_reason": reason,
                    "capture_finished": last,
                    "still_recording_for": summary["still_recording_for"],
                    "capture": summary["capture"],
                },
                "stats": {"stop": sc::STATS_STOP_FILE},
            });
            if let Err(error) = sc::merge_manifest(&entry.bundle, patch) {
                warn!(%error, session_id, "session manifest update failed");
            }
            if let Some(reply) = reply {
                let _ = reply.send(Ok(summary));
            }
        });
        if let Err(error) = spawned {
            warn!(%error, "session capture: could not spawn the finishing thread");
        }
    }

    /// Start of tick: install a city capture that finished opening, and end
    /// sessions that must end on their own.
    pub(crate) fn poll_session_capture(&mut self) {
        let Some(capture) = self.session_capture.as_mut() else {
            return;
        };
        let polled = match &capture.city {
            CityCapture::Opening(rx) => Some(rx.try_recv()),
            _ => None,
        };
        if let Some(polled) = polled {
            match polled {
                Ok(Ok(netlab)) => {
                    capture.city = match self.city.as_mut() {
                        Some(city) => match city.install_capture(netlab) {
                            Ok(()) => CityCapture::Owned,
                            // Someone else started one meanwhile; ours is surplus.
                            Err(surplus) => {
                                let dir = surplus.dir().to_path_buf();
                                std::thread::spawn(move || drop(surplus.finish()));
                                CityCapture::Failed(format!(
                                    "a capture was already recording; {} discarded",
                                    dir.display()
                                ))
                            }
                        },
                        None => CityCapture::NotCity,
                    };
                }
                Ok(Err(error)) => capture.city = CityCapture::Failed(error.to_string()),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    capture.city = CityCapture::Failed("capture opener exited".into())
                }
            }
        }
        let now = sc::micros_since(capture.epoch);
        let expired =
            capture.sessions.expired(|player| self.players.contains_key(&player), now, self.session_max_us);
        for (session_id, reason) in expired {
            warn!(match_id = %self.id, session_id, ?reason, "session capture: ending session");
            self.stop_session(&session_id, reason, None);
        }
    }

    /// End of tick: the authoritative world and the tick's costs, with the
    /// selection records the send paths left, handed to the writer.
    pub(crate) fn record_session_tick(&mut self, costs: TickCosts) {
        let Some(capture) = self.session_capture.as_ref() else {
            return;
        };
        let started = Instant::now();
        let mono_us = sc::micros_since(capture.epoch);
        let unix_us = sc::unix_us();
        let truth = self.collect_world_truth(mono_us, unix_us);
        let awake = self.city.as_ref().map_or(0, |city| city.stats().awake_chunk_bodies as u32);
        let mut timing = TickTiming {
            tick: self.server_tick,
            mono_us,
            unix_us,
            total_ms: costs.total_ms,
            player_sim_ms: self.timings.player_sim_ms.last(),
            vehicle_ms: self.timings.vehicle_ms.last(),
            dynamics_ms: self.timings.dynamics_ms.last(),
            hitscan_ms: self.timings.hitscan_ms.last(),
            city_ms: costs.city_ms,
            snapshot_ms: costs.snapshot_ms,
            publish_ms: costs.publish_ms,
            unattributed_ms: costs.unattributed_ms,
            players: self.players.len() as u32,
            awake_city_bodies: awake,
            capture_ms: 0.0,
            timing_version: sc::TICK_TIMING_VERSION,
            snapshot_sent: Some(costs.snapshot_sent),
            shots_ms: costs.shots_ms,
            meteors_launched: costs.meteors_launched,
            meteor_launch_ms: costs.meteor_launch_ms,
            ..TickTiming::default()
        };
        let phases_started = Instant::now();
        self.collect_step_phases(&mut timing, costs.overlap_ms);
        timing.phases_us = phases_started.elapsed().as_secs_f32() * 1e6;
        let capture = self.session_capture.as_mut().expect("checked above");
        let selections = std::mem::take(&mut capture.selections);
        timing.capture_ms = started.elapsed().as_secs_f32() * 1000.0;
        capture.ticks.push(TickBundle { truth, timing, selections });
    }

    /// The PhysX step's phases and the destruction stage's tick, read from
    /// what the step and the stage already measured. Copies and a scan of the
    /// tick's spans; no allocation unless the engine profiler is on.
    fn collect_step_phases(&self, timing: &mut TickTiming, overlap_ms: f32) {
        if let Some(step) = self.arena.step_phases() {
            timing.physx = Some(sc::PhysxPhases {
                controller_ms: step.controller_ms,
                submit_ms: step.submit_ms,
                overlap_ms,
                fetch_ms: step.fetch_ms,
                callbacks_ms: step.callbacks_ms,
                gpu_wait_ms: step.gpu_wait_ms,
                readback_ms: step.readback_ms,
                players_ms: step.players_ms,
                awake_bodies: step.awake_bodies,
                found_pairs: step.found_pairs,
                lost_pairs: step.lost_pairs,
            });
        }
        #[cfg(feature = "native-destruction")]
        if let Some((status, counts, spans)) =
            self.city.as_ref().and_then(|city| city.native_tick_view())
        {
            let observe_ms = spans
                .iter()
                .find(|span| span.name == "native_tick_ms")
                .map_or(0.0, |span| span.value as f32);
            let named = || spans.iter().map(|span| (span.name.as_str(), span.value, span.kind));
            timing.stage = Some(sc::StagePhases {
                frame: status.frame,
                error: status.error,
                iterations: status.iterations,
                converged: status.converged,
                passes: status.stress_passes,
                corrections: status.correction_passes,
                bonds_broken: counts.bonds_broken,
                bonds_broken_after_correction: status.post_correction_broken_bonds,
                crushed_chunks: status.crushed_chunks,
                contacts: status.normal_contacts,
                bodies_promoted: counts.bodies_promoted,
                chunks_migrated: counts.chunks_migrated,
                observe_ms,
                zones: sc::StageZones::from_spans(named()),
            });
            timing.engine_zones = sc::engine_zones(named());
        }
    }

    /// What the snapshots are built from, before interest or quantisation.
    fn collect_world_truth(&self, mono_us: u64, unix_us: u64) -> TickTruth {
        let mut players: Vec<PlayerTruth> = self
            .players
            .keys()
            .filter_map(|&id| {
                let (position, velocity, yaw, pitch, hp, flags) = self.arena.snapshot_player(id)?;
                Some(PlayerTruth {
                    id,
                    handle: self.player_handles.get(&id).copied().unwrap_or(0),
                    hp,
                    flags,
                    position,
                    velocity,
                    yaw,
                    pitch,
                })
            })
            .collect();
        players.sort_by_key(|player| player.id);
        let snorm = crate::protocol::snorm16_to_f32;
        let mut vehicles: Vec<VehicleTruth> = self
            .arena
            .snapshot_vehicles()
            .into_iter()
            .map(|v| VehicleTruth {
                id: v.id,
                handle: self.vehicle_handles.get(&v.id).copied().unwrap_or(0),
                vehicle_type: v.vehicle_type,
                flags: v.flags,
                driver: v.driver_id,
                position: [
                    crate::protocol::mm_to_meters(v.px_mm),
                    crate::protocol::mm_to_meters(v.py_mm),
                    crate::protocol::mm_to_meters(v.pz_mm),
                ],
                rotation: [snorm(v.qx_snorm), snorm(v.qy_snorm), snorm(v.qz_snorm), snorm(v.qw_snorm)],
                velocity: [
                    crate::protocol::cms_to_mps(v.vx_cms),
                    crate::protocol::cms_to_mps(v.vy_cms),
                    crate::protocol::cms_to_mps(v.vz_cms),
                ],
                angular_velocity: [
                    v.wx_mrads as f32 / 1000.0,
                    v.wy_mrads as f32 / 1000.0,
                    v.wz_mrads as f32 / 1000.0,
                ],
            })
            .collect();
        vehicles.sort_by_key(|vehicle| vehicle.id);
        let bodies: Vec<BodyTruth> = self
            .arena
            .snapshot_dynamic_bodies()
            .into_iter()
            .map(|(id, position, rotation, half_extents, velocity, angular_velocity, shape)| BodyTruth {
                id,
                handle: self.dynamic_body_handles.get(&id).map_or(0, |meta| meta.handle),
                shape,
                position,
                rotation,
                half_extents,
                velocity,
                angular_velocity,
            })
            .collect();
        TickTruth { tick: self.server_tick, mono_us, unix_us, players, vehicles, bodies }
    }

    /// A snapshot tick's recipient inputs, if a capture is running.
    pub(crate) fn note_snapshot_inputs(
        &mut self,
        server_wall_us: u32,
        recipients: Vec<crate::snapshot_builder::RecipientInput>,
    ) {
        let tick = self.server_tick;
        let meleeing: Vec<u32> = recipients
            .iter()
            .filter(|recipient| {
                self.players
                    .get(&recipient.id)
                    .is_some_and(|runtime| tick < runtime.melee_flag_clear_tick)
            })
            .map(|recipient| recipient.id)
            .collect();
        if let Some(capture) = self.session_capture.as_mut() {
            capture.ticks.push_snapshot_inputs(sc::SnapshotInputs {
                tick,
                server_wall_us: Some(server_wall_us),
                recipients,
                meleeing,
            });
        }
    }

    /// A send path's decision record for this tick, if a capture is running.
    pub(crate) fn note_selection(&mut self, selection: sc::Selection) {
        if let Some(capture) = self.session_capture.as_mut() {
            capture.selections.push(selection);
        }
    }
}
