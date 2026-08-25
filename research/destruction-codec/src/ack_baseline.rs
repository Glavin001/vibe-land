//! Offline Fiedler-style acked-baseline ablation on the *adaptive* sender.
//!
//! Scheduling matches the live FullModePriority path: classify → error/priority
//! → optional interest → pack under an optional Mbps ceiling (ceiling ≠ fill).
//! On top of that scheduler, compare three wire policies:
//! 1. always absolute quantized poses
//! 2. delta versus last absolute *sent* (optimistic; breaks under loss)
//! 3. delta versus last absolute *acked/delivered* (correct under loss)
//!
//! Emits a JSON report and a TWSTATE1 reconstruction for the acked policy.

use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{ensure, Result};
use glam::Vec3;
use serde::Serialize;

use crate::{
    codec::{
        angular_error_degrees, packetize, predict_ballistic, projected_error_pixels,
        quantize_vec_i16, quantized_absolute_pose, rigid_shell_error_meters, Classifier,
        ClassifierConfig, DatagramRecord, LossModel, LossRng, PhysicalClass, PredictorParams,
        WireChoice, DATAGRAM_HEADER, MOTION_ABSOLUTE_BYTES, MOTION_DELTA_BYTES,
    },
    interest::{InterestConfig, InterestTrack, InterestViewTrack},
    replay::ReplayWriter,
    scheduler::{
        compute_priority, select_with_ceiling, BudgetCandidate, PriorityConfig, PriorityInput,
    },
    trace::{ActorDef, Pose, TraceReader},
};

#[derive(Clone, Debug, Serialize)]
pub struct AckBaselineModeReport {
    pub mode: &'static str,
    pub average_mbps: f64,
    pub peak_one_second_mbps: f64,
    pub p95_one_second_mbps: f64,
    pub absolute_records: u64,
    pub delta_records: u64,
    pub omitted_actor_ticks: u64,
    pub dropped_datagrams: u64,
    pub invalid_deltas_avoided: u64,
    pub max_shell_cm: f64,
    pub max_screen_px: f64,
    pub p99_screen_px: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct AckBaselineReport {
    pub source_trace: String,
    pub actors: usize,
    pub physics_hz: u32,
    pub duration_seconds: f64,
    pub scheduler: &'static str,
    pub bitrate_budget_mbps: Option<f64>,
    pub single_view_interest: bool,
    pub omniscient: bool,
    pub world_shell_budget_cm: f32,
    pub loss_rate: f64,
    pub ack_delay_ticks: u32,
    pub baseline_interval_ms: u32,
    pub modes: Vec<AckBaselineModeReport>,
    pub reconstructed_towerstate: String,
    pub note: &'static str,
}

#[derive(Clone, Copy)]
enum BaselinePolicy {
    AlwaysAbsolute,
    DeltaVsLastSent,
    DeltaVsLastAcked,
}

#[derive(Clone, Debug)]
pub struct AckBaselineConfig {
    pub loss_rate: f64,
    pub ack_delay_ticks: u32,
    pub baseline_interval_ms: u32,
    pub output_fps: u32,
    pub seed: u64,
    pub bitrate_budget_mbps: Option<f64>,
    pub single_view_interest: bool,
    pub omniscient: bool,
    pub world_shell_budget_cm: f32,
    pub max_moving_update_ms: u32,
    pub contact_update_ms: u32,
    pub pixel_budget: f32,
}

impl Default for AckBaselineConfig {
    fn default() -> Self {
        Self {
            loss_rate: 0.01,
            ack_delay_ticks: 0,
            baseline_interval_ms: 1000,
            output_fps: 30,
            seed: 0x4143_4b42,
            bitrate_budget_mbps: None,
            single_view_interest: false,
            omniscient: true,
            world_shell_budget_cm: 2.0,
            max_moving_update_ms: 500,
            contact_update_ms: 83,
            pixel_budget: 2.0,
        }
    }
}

struct ActorEnc {
    classifier: Classifier,
    class: PhysicalClass,
    pose: Pose,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    last_update_tick: u32,
}

pub fn run(
    trace_path: &Path,
    out_dir: &Path,
    config: &AckBaselineConfig,
) -> Result<AckBaselineReport> {
    ensure!(
        (0.0..1.0).contains(&config.loss_rate),
        "loss-rate must be in [0,1)"
    );
    ensure!(config.baseline_interval_ms > 0);
    ensure!(config.omniscient || config.single_view_interest || true);
    std::fs::create_dir_all(out_dir)?;

    let policies = [
        (BaselinePolicy::AlwaysAbsolute, "always_absolute"),
        (BaselinePolicy::DeltaVsLastSent, "delta_vs_last_sent"),
        (BaselinePolicy::DeltaVsLastAcked, "delta_vs_last_acked"),
    ];
    let mut modes = Vec::new();
    let mut reconstructed = None;
    for (policy, label) in policies {
        let replay = if matches!(policy, BaselinePolicy::DeltaVsLastAcked) {
            Some(out_dir.join("ack-baseline-reconstructed.towerstate"))
        } else {
            None
        };
        let mode = run_mode(
            trace_path,
            policy,
            label,
            config,
            config.seed ^ label.as_bytes().iter().map(|b| *b as u64).sum::<u64>(),
            replay.as_deref(),
        )?;
        if replay.is_some() {
            reconstructed = replay;
        }
        modes.push(mode);
    }

    let meta = TraceReader::open(trace_path)?;
    let report = AckBaselineReport {
        source_trace: trace_path.display().to_string(),
        actors: meta.actors.len(),
        physics_hz: meta.header.physics_hz,
        duration_seconds: meta.header.tick_count as f64 / meta.header.physics_hz as f64,
        scheduler: "full_mode_priority",
        bitrate_budget_mbps: config.bitrate_budget_mbps,
        single_view_interest: config.single_view_interest,
        omniscient: config.omniscient,
        world_shell_budget_cm: config.world_shell_budget_cm,
        loss_rate: config.loss_rate,
        ack_delay_ticks: config.ack_delay_ticks,
        baseline_interval_ms: config.baseline_interval_ms,
        modes,
        reconstructed_towerstate: reconstructed
            .unwrap_or_else(|| out_dir.join("ack-baseline-reconstructed.towerstate"))
            .display()
            .to_string(),
        note: "Adaptive scheduler (classify + priority + optional interest/ceiling). Wire policy is Absolute vs delta-vs-last-sent vs delta-vs-last-acked. Pose datagrams are unreliable; an Absolute becomes the client baseline only after modeled delivery. Budget is a ceiling, never a fill target.",
    };
    let path = out_dir.join("ack_baseline_report.json");
    let mut file = File::create(&path)?;
    serde_json::to_writer_pretty(&mut file, &report)?;
    file.write_all(b"\n")?;
    Ok(report)
}

fn run_mode(
    trace_path: &Path,
    policy: BaselinePolicy,
    label: &'static str,
    config: &AckBaselineConfig,
    seed: u64,
    replay_path: Option<&Path>,
) -> Result<AckBaselineModeReport> {
    let mut trace = TraceReader::open(trace_path)?;
    let hz = trace.header.physics_hz;
    let dt = 1.0 / hz as f32;
    let baseline_ticks = (config.baseline_interval_ms as u64 * hz as u64)
        .div_ceil(1000)
        .max(1) as u32;
    let priority_config = PriorityConfig {
        max_moving_age_ticks: ((config.max_moving_update_ms as u64 * hz as u64) / 1000).max(1)
            as u32,
        contact_target_age_ticks: ((config.contact_update_ms as u64 * hz as u64) / 1000).max(1)
            as u32,
        linear_motion_threshold: 0.05,
        angular_motion_threshold: 0.08,
    };
    let classifier_cfg = ClassifierConfig::default();
    let interest_config = InterestConfig {
        fov_margin_degrees: 12.0,
        lookahead_ticks: ((250u64 * hz as u64) / 1000).max(1) as u32,
        grace_ticks: ((500u64 * hz as u64) / 1000).max(1) as u32,
        proximity_meters: 25.0,
        dt,
        pane_width: trace.header.pane_width,
        pane_height: trace.header.pane_height,
    };
    let budget_per_tick = config
        .bitrate_budget_mbps
        .map(|mbps| ((mbps * 1_000_000.0 / 8.0) / hz as f64).floor().max(0.0) as usize);

    let loss = LossModel::Random(config.loss_rate);
    let mut rng = LossRng::new(seed);

    let n = trace.actors.len();
    let mut enc: Vec<ActorEnc> = (0..n)
        .map(|_| ActorEnc {
            classifier: Classifier::default(),
            class: PhysicalClass::ContactActive,
            pose: Pose::default(),
            linear_velocity: Vec3::ZERO,
            angular_velocity: Vec3::ZERO,
            last_update_tick: 0,
        })
        .collect();
    let mut last_sent: Vec<Option<Pose>> = vec![None; n];
    let mut last_acked: Vec<Option<Pose>> = vec![None; n];
    let mut pending_acks: Vec<Vec<(u32, Pose)>> = vec![Vec::new(); n];
    let mut client_baseline: Vec<Option<Pose>> = vec![None; n];
    let mut presented: Vec<Option<Pose>> = vec![None; n];
    let mut sleeping = vec![false; n];
    let mut interest_tracks = vec![InterestTrack::default(); n];
    let mut interest_view = InterestViewTrack::default();

    let mut absolute_records = 0_u64;
    let mut delta_records = 0_u64;
    let mut omitted = 0_u64;
    let mut dropped = 0_u64;
    let mut invalid_avoided = 0_u64;
    let mut tick_bytes = Vec::<u64>::new();
    let mut screen_samples = Vec::<f32>::new();
    let mut max_shell = 0.0_f32;

    let mut replay = match replay_path {
        Some(path) => Some(ReplayWriter::create(
            path,
            &trace.header,
            &trace.actors,
            config.output_fps,
        )?),
        None => None,
    };
    let mut last_output_frame = None;
    let mut sequence = 0_u32;
    let cameras = trace.header.cameras;

    while let Some(tick) = trace.next_tick()? {
        for actor in 0..n {
            let due: Vec<_> = pending_acks[actor]
                .iter()
                .copied()
                .filter(|(ready, _)| *ready <= tick.index)
                .collect();
            pending_acks[actor].retain(|(ready, _)| *ready > tick.index);
            if let Some((_, pose)) = due.last().copied() {
                last_acked[actor] = Some(pose);
            }
        }

        if tick.index > 0 {
            let gravity = trace.header.gravity;
            for (actor_index, actor) in enc.iter_mut().enumerate() {
                advance_pose(actor, &trace.actors[actor_index], gravity, dt);
            }
        }

        let interest_cameras = if config.single_view_interest {
            interest_view.update(
                cameras[3.min(cameras.len().saturating_sub(1))],
                interest_config,
            )
        } else {
            interest_view.update(cameras[0], interest_config)
        };
        let is_baseline = tick.index % baseline_ticks == 0;
        let final_tick = tick.index + 1 == trace.header.tick_count;

        struct Cand {
            actor: usize,
            choice: WireChoice,
            bytes: usize,
            wire: Pose,
            linear_velocity: Vec3,
            angular_velocity: Vec3,
            server_base: Option<Pose>,
            priority: f32,
            required: bool,
            class: PhysicalClass,
        }
        let mut candidates = Vec::new();
        let mut interested_now = vec![true; n];

        for (actor_index, truth) in tick.states.iter().copied().enumerate() {
            let previous_class = enc[actor_index].class;
            let class = enc[actor_index].classifier.update(truth, classifier_cfg);
            enc[actor_index].class = class;

            let (interested, interest_entry) = if config.single_view_interest {
                let decision = interest_tracks[actor_index].update(
                    tick.index,
                    truth.pose,
                    truth.linear_velocity,
                    trace.actors[actor_index].bounding_radius,
                    interest_cameras,
                    interest_config,
                );
                (decision.relevant, decision.entering)
            } else {
                (true, false)
            };
            interested_now[actor_index] = interested;
            if !interested {
                omitted += 1;
                continue;
            }

            let (predicted_error, error_budget) = if config.omniscient {
                (
                    rigid_shell_error_meters(
                        truth.pose,
                        enc[actor_index].pose,
                        trace.actors[actor_index].bounding_radius,
                    ) * 100.0,
                    config.world_shell_budget_cm,
                )
            } else {
                (
                    worst_camera_error(
                        truth.pose,
                        enc[actor_index].pose,
                        &trace.actors[actor_index],
                        &cameras,
                        trace.header.pane_width,
                        trace.header.pane_height,
                    ),
                    config.pixel_budget,
                )
            };

            let priority = compute_priority(
                PriorityInput {
                    class,
                    projected_error_ratio: predicted_error / error_budget.max(1e-6),
                    age_ticks: tick.index.saturating_sub(enc[actor_index].last_update_tick),
                    contacts: truth.contacts,
                    linear_speed: truth.linear_velocity.length(),
                    angular_speed: truth.angular_velocity.length(),
                    linear_velocity_innovation: (truth.linear_velocity
                        - enc[actor_index].linear_velocity)
                        .length(),
                    angular_velocity_innovation: (truth.angular_velocity
                        - enc[actor_index].angular_velocity)
                        .length(),
                    contact_begin: truth.flags & 4 != 0,
                    joint_break: truth.flags & 16 != 0,
                    wake: truth.flags & 64 != 0,
                    interest_entry,
                },
                priority_config,
            );

            let force_baseline = interest_entry
                || tick.index == 0
                || ((is_baseline || final_tick)
                    && class != PhysicalClass::Quiescent
                    && predicted_error > 0.0)
                || (class != previous_class
                    && (class == PhysicalClass::Quiescent
                        || previous_class == PhysicalClass::Quiescent
                        || class == PhysicalClass::Ballistic
                        || previous_class == PhysicalClass::Ballistic));

            if !priority.should_send && !force_baseline {
                omitted += 1;
                continue;
            }

            let wire = quantized_absolute_pose(truth.pose);
            let lv = quantize_vec_i16(truth.linear_velocity, 0.01);
            let av = quantize_vec_i16(truth.angular_velocity, 0.001);
            let (choice, bytes, server_base) = choose_wire(
                policy,
                force_baseline,
                wire,
                last_sent[actor_index],
                last_acked[actor_index],
                &mut invalid_avoided,
            );
            candidates.push(Cand {
                actor: actor_index,
                choice,
                bytes,
                wire,
                linear_velocity: lv,
                angular_velocity: av,
                server_base,
                priority: priority.score,
                required: force_baseline || priority.hard_deadline,
                class,
            });
        }

        let budget_candidates: Vec<BudgetCandidate> = candidates
            .iter()
            .enumerate()
            .map(|(index, cand)| BudgetCandidate {
                index,
                cost_bytes: cand.bytes,
                priority: cand.priority,
                required: cand.required,
            })
            .collect();
        // Ceiling uses payload bytes; packetize adds shared datagram headers after.
        let selected = select_with_ceiling(&budget_candidates, budget_per_tick, DATAGRAM_HEADER);
        let selected_set: std::collections::BTreeSet<usize> =
            selected.selected_indices.iter().copied().collect();
        for (index, cand) in candidates.iter().enumerate() {
            if !selected_set.contains(&index) {
                omitted += 1;
            } else {
                // Encoder commits on send (last-sent semantics).
                enc[cand.actor].pose = cand.wire;
                enc[cand.actor].linear_velocity = cand.linear_velocity;
                enc[cand.actor].angular_velocity = cand.angular_velocity;
                enc[cand.actor].last_update_tick = tick.index;
                enc[cand.actor].class = cand.class;
                if matches!(cand.choice, WireChoice::Absolute) {
                    last_sent[cand.actor] = Some(cand.wire);
                    absolute_records += 1;
                } else {
                    delta_records += 1;
                }
            }
        }

        let records: Vec<DatagramRecord> = selected
            .selected_indices
            .iter()
            .map(|&index| {
                let cand = &candidates[index];
                DatagramRecord {
                    actor: cand.actor as u32,
                    choice: cand.choice,
                    bytes: cand.bytes,
                }
            })
            .collect();
        let packets = packetize(&records, &mut sequence, tick.index, tick.index);
        let mut delivered = vec![false; n];
        let mut delivered_choice = vec![None; n];
        let mut delivered_wire = vec![None; n];
        let mut delivered_base = vec![None; n];
        for packet in &packets {
            if loss.dropped(tick.index, &mut rng) {
                dropped += 1;
                continue;
            }
            for record in &packet.records {
                let actor = record.actor as usize;
                delivered[actor] = true;
                if let Some(cand) = candidates.iter().find(|c| c.actor == actor) {
                    delivered_choice[actor] = Some(cand.choice);
                    delivered_wire[actor] = Some(cand.wire);
                    delivered_base[actor] = cand.server_base;
                }
            }
        }
        let bytes_this_tick: u64 = packets.iter().map(|packet| packet.bytes as u64).sum();
        tick_bytes.push(bytes_this_tick);

        for actor in 0..n {
            if !delivered[actor] {
                continue;
            }
            let choice = delivered_choice[actor].unwrap_or(WireChoice::Absolute);
            let wire = delivered_wire[actor]
                .unwrap_or_else(|| quantized_absolute_pose(tick.states[actor].pose));
            let server_base = delivered_base[actor];
            let pose = match choice {
                WireChoice::Absolute | WireChoice::Raw => {
                    client_baseline[actor] = Some(wire);
                    wire
                }
                WireChoice::Delta => {
                    let Some(client_base) = client_baseline[actor] else {
                        client_baseline[actor] = Some(wire);
                        presented[actor] = Some(wire);
                        continue;
                    };
                    let Some(base) = server_base else {
                        client_baseline[actor] = Some(wire);
                        presented[actor] = Some(wire);
                        continue;
                    };
                    Pose {
                        position: client_base.position + (wire.position - base.position),
                        rotation: wire.rotation,
                    }
                }
            };
            presented[actor] = Some(pose);
            if matches!(choice, WireChoice::Absolute) {
                let ready = tick.index.saturating_add(config.ack_delay_ticks);
                pending_acks[actor].push((ready, wire));
                if config.ack_delay_ticks == 0 {
                    last_acked[actor] = Some(wire);
                    pending_acks[actor].clear();
                }
            }
        }

        let mut frame_poses = Vec::with_capacity(n);
        for (actor, state) in tick.states.iter().enumerate() {
            // Present held pose; bootstrap from truth only before first update.
            let pose = presented[actor].unwrap_or(state.pose);
            if presented[actor].is_none() {
                presented[actor] = Some(state.pose);
            }
            // Quality metrics only on actors the adaptive sender is responsible for.
            if interested_now[actor] {
                let shell =
                    rigid_shell_error_meters(state.pose, pose, trace.actors[actor].bounding_radius);
                max_shell = max_shell.max(shell);
                let mut worst = 0.0_f32;
                for camera in &cameras {
                    worst = worst.max(projected_error_pixels(
                        state.pose,
                        pose,
                        trace.actors[actor].bounding_radius,
                        *camera,
                        trace.header.pane_width,
                        trace.header.pane_height,
                    ));
                }
                screen_samples.push(worst);
                let _ = angular_error_degrees(state.pose.rotation, pose.rotation);
            }
            sleeping[actor] = state.sleeping();
            frame_poses.push(pose);
        }

        if let Some(writer) = replay.as_mut() {
            let frame = tick.index.saturating_mul(config.output_fps) / hz;
            if last_output_frame != Some(frame) {
                writer.write_frame(&frame_poses, &sleeping)?;
                last_output_frame = Some(frame);
            }
        }
    }
    trace.finish()?;
    if let Some(writer) = replay.take() {
        writer.finish()?;
    }

    let duration = tick_bytes.len() as f64 / hz as f64;
    let total_bytes: u64 = tick_bytes.iter().sum();
    let average_mbps = if duration > 0.0 {
        total_bytes as f64 * 8.0 / duration / 1_000_000.0
    } else {
        0.0
    };
    let (peak, p95) = peak_and_p95_one_second_mbps(&tick_bytes, hz);
    screen_samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p99 = if screen_samples.is_empty() {
        0.0
    } else {
        let idx = ((screen_samples.len() as f64 - 1.0) * 0.99).round() as usize;
        screen_samples[idx.min(screen_samples.len() - 1)] as f64
    };

    Ok(AckBaselineModeReport {
        mode: label,
        average_mbps,
        peak_one_second_mbps: peak,
        p95_one_second_mbps: p95,
        absolute_records,
        delta_records,
        omitted_actor_ticks: omitted,
        dropped_datagrams: dropped,
        invalid_deltas_avoided: invalid_avoided,
        max_shell_cm: max_shell as f64 * 100.0,
        max_screen_px: screen_samples.last().copied().unwrap_or(0.0) as f64,
        p99_screen_px: p99,
    })
}

fn choose_wire(
    policy: BaselinePolicy,
    force_baseline: bool,
    wire: Pose,
    last_sent: Option<Pose>,
    last_acked: Option<Pose>,
    invalid_avoided: &mut u64,
) -> (WireChoice, usize, Option<Pose>) {
    match policy {
        BaselinePolicy::AlwaysAbsolute => (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None),
        BaselinePolicy::DeltaVsLastSent => {
            if force_baseline {
                (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
            } else if let Some(base) = last_sent {
                if delta_within_i16(wire.position, base.position) {
                    (WireChoice::Delta, MOTION_DELTA_BYTES, Some(base))
                } else {
                    (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
                }
            } else {
                (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
            }
        }
        BaselinePolicy::DeltaVsLastAcked => {
            if force_baseline {
                (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
            } else if let Some(base) = last_acked {
                if delta_within_i16(wire.position, base.position) {
                    (WireChoice::Delta, MOTION_DELTA_BYTES, Some(base))
                } else if last_sent.is_some_and(|sent| sent.position.distance(base.position) > 1e-6)
                {
                    *invalid_avoided += 1;
                    (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
                } else {
                    (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
                }
            } else {
                if last_sent.is_some() {
                    *invalid_avoided += 1;
                }
                (WireChoice::Absolute, MOTION_ABSOLUTE_BYTES, None)
            }
        }
    }
}

fn advance_pose(actor: &mut ActorEnc, def: &ActorDef, gravity: Vec3, dt: f32) {
    match actor.class {
        PhysicalClass::Quiescent => {}
        PhysicalClass::Ballistic => {
            let (pose, lv, av) = predict_ballistic(
                actor.pose,
                actor.linear_velocity,
                actor.angular_velocity,
                PredictorParams {
                    gravity,
                    linear_damping: def.linear_damping,
                    angular_damping: def.angular_damping,
                    dt,
                    steps: 1,
                },
            );
            actor.pose = pose;
            actor.linear_velocity = lv;
            actor.angular_velocity = av;
        }
        PhysicalClass::ContactActive | PhysicalClass::ImpactBurst => {
            actor.linear_velocity *= 1.0 / (1.0 + def.linear_damping * dt);
            actor.angular_velocity *= 1.0 / (1.0 + def.angular_damping * dt);
            actor.pose.position += actor.linear_velocity * dt;
            let angle = actor.angular_velocity.length() * dt;
            if angle > 1e-8 {
                actor.pose.rotation =
                    (glam::Quat::from_axis_angle(actor.angular_velocity.normalize(), angle)
                        * actor.pose.rotation)
                        .normalize();
            }
        }
    }
}

fn worst_camera_error(
    truth: Pose,
    predicted: Pose,
    actor: &ActorDef,
    cameras: &[crate::trace::Camera],
    pane_width: u32,
    pane_height: u32,
) -> f32 {
    let mut worst = 0.0_f32;
    for camera in cameras {
        worst = worst.max(projected_error_pixels(
            truth,
            predicted,
            actor.bounding_radius,
            *camera,
            pane_width,
            pane_height,
        ));
    }
    worst
}

fn delta_within_i16(current: Vec3, baseline: Vec3) -> bool {
    let delta = (current - baseline) * 100.0;
    delta
        .to_array()
        .into_iter()
        .all(|component| component.round().abs() <= i16::MAX as f32)
}

fn peak_and_p95_one_second_mbps(tick_bytes: &[u64], hz: u32) -> (f64, f64) {
    if tick_bytes.is_empty() {
        return (0.0, 0.0);
    }
    let window = hz.max(1) as usize;
    let mut rolling = Vec::with_capacity(tick_bytes.len());
    let mut sum = 0_u64;
    for (index, &bytes) in tick_bytes.iter().enumerate() {
        sum += bytes;
        if index >= window {
            sum -= tick_bytes[index - window];
        }
        if index + 1 >= window {
            rolling.push(sum);
        }
    }
    if rolling.is_empty() {
        let total: u64 = tick_bytes.iter().sum();
        let mbps = total as f64 * 8.0 / 1_000_000.0;
        return (mbps, mbps);
    }
    rolling.sort_unstable();
    let peak = *rolling.last().unwrap() as f64 * 8.0 / 1_000_000.0;
    let p95_idx = ((rolling.len() as f64 - 1.0) * 0.95).round() as usize;
    let p95 = rolling[p95_idx.min(rolling.len() - 1)] as f64 * 8.0 / 1_000_000.0;
    (peak, p95)
}

#[allow(dead_code)]
pub fn report_path(out_dir: &Path) -> PathBuf {
    out_dir.join("ack_baseline_report.json")
}
