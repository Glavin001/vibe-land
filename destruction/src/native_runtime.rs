//! `/city` destruction driven by PhysX's own GPU destruction stage.
//!
//! The other two backends drive a stress solver from the application: they
//! inject loads, run a solve, read verdicts back, apply fracture commands and
//! edit the scene. This one does none of that. The stage lives inside
//! `PxScene::simulate()`, where it assembles loads from the solver's own
//! contact impulses, evaluates the material model, splits connectivity, creates
//! the fragment bodies and re-runs one corrected rigid pass -- all before
//! `fetchResults()` returns.
//!
//! What is left for an application is genuinely small: author the asset once,
//! then each tick read the committed delta and hand it to the encoder. This
//! module is therefore mostly translation, and deliberately so -- the previous
//! attempt at this port kept the application-side machinery (freezing, resim,
//! support tracking) alive next to an engine that had taken over the same jobs.
//!
//! Three things the other backends do are *absent* here rather than disabled:
//! there is no force injection (the stage takes loads only from real contacts,
//! so a shot is a real body), no artificial freezing (the engine's own sleep is
//! the settle signal), and no resimulation (the engine owns correction).

use std::collections::HashMap;
use std::sync::Arc;

use vibe_land_physx_bridge::{NativeConfig, NativeStatus, RoundDesc, Vec3, World};
use vibe_netcode::destruction_backend::{
    DestructionStats, DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
    ShapeMigration, StressSolverSettings,
};

use crate::encoder::BodySnapshotInput;
use crate::ids;
use crate::manifest::DestructionManifest;
use crate::types::NamedSpan;
use crate::runtime::{
    authored_structure, CityDestructionError, CHUNK_COLLISION_MASK, GROUP_CHUNK,
};

/// Stress iterations per evaluation.
///
/// The same kind of knob as the Blast backends' `VIBE_CITY_SOLVER_ITERATIONS`,
/// and now with the same meaning: a cap on the iterations one tick may spend,
/// not a demand that the solve finish inside that tick. The solver keeps its
/// warm-started iterate and refines the same solve on the next tick, so a tick
/// that runs out of budget loses time, not fidelity.
///
/// It did not use to mean that. The stage failed the entire simulation step
/// when the solve had not converged by the end of the budget, which is how a
/// hard-to-solve building became a frozen, teleporting city. That check is gone
/// from the engine; see the removal of `requireNativeConvergence` in physx-2's
/// PxgDestructionRuntime.cu.
///
/// This is the single most expensive setting in the game. PhysX's own
/// instrumentation puts `GpuDestruction.cuda.stress` at 94% of the simulation
/// step, and that phase is very close to linear in the budget. Measured under
/// sustained cannonball fire at fractured-downtown, 160 shots, mean of the
/// whole server tick:
///
/// | cap | whole tick | stress | bonds broken |
/// |----:|-----------:|-------:|-------------:|
/// |  16 |    10.3 ms |  7.3 ms|        4,359 |
/// |  24 |    15.3 ms | 12.2 ms|        4,245 |
/// |  32 |    20.2 ms | 16.0 ms|        5,792 |
/// |  48 |    28.2 ms | 24.8 ms|        4,940 |
/// |  64 |    29.0 ms | 25.5 ms|        5,971 |
///
/// 16 is the default because it is the only measured point that holds 60 Hz
/// while the city is coming apart, at roughly three quarters of the
/// destruction. Bond counts are chaotic rather than monotone: a slightly
/// different force field sends the collapse somewhere else, so read the column
/// as a rough scale, not a ranking.
///
/// Two cautions before tuning this. Raising it buys destruction and spends
/// frame time roughly proportionally. Lowering it below 16 has not been
/// qualified, and the budget also decides whether a large scene starts at all:
/// on skyline-stable the very first solve must converge or the stage's resident
/// stress topology update fails with error bit 64 and never recovers. On that
/// scene 16 starts and 32 and 64 do not, which is an engine defect rather than
/// a tuning rule, so re-measure rather than reasoning from this number.
fn stress_iterations() -> u32 {
    env_u32("VIBE_CITY_NATIVE_STRESS_ITERATIONS", 16)
}

fn stress_tolerance() -> f32 {
    std::env::var("VIBE_CITY_NATIVE_STRESS_TOLERANCE")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(1.0e-5)
}

/// Contact-pair storage touched up front.
///
/// Sized from the scene rather than fixed: the first impact on a city that has
/// never had one otherwise pages in this storage on the simulation thread,
/// which shows up as a single unexplained spike at the moment of first contact.
fn reserved_contact_pairs(chunks: usize) -> u32 {
    let scaled = (chunks.saturating_mul(3) / 2).min(1 << 20) as u32;
    env_u32("VIBE_CITY_NATIVE_RESERVED_PAIRS", scaled)
}

/// How often the whole-graph bond verdict read runs.
///
/// It is a device read proportional to bond count, so it runs on a cadence and
/// publishes its age; the stability gates set it to 1 because they are asking a
/// question about *this* tick.
fn verdict_sample_ticks() -> u32 {
    env_u32("VIBE_CITY_NATIVE_VERDICT_SAMPLE_TICKS", 60).max(1)
}

/// Speed of a fired round, m/s. With the round's momentum fixed by the weapon,
/// speed chooses the mass: faster is lighter and travels further per tick.
fn round_speed() -> f32 {
    std::env::var("VIBE_CITY_NATIVE_ROUND_SPEED")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(20.0)
}

/// Round radius, m. Kept above the per-tick travel distance at `round_speed`
/// so a round cannot pass through a chunk between steps -- the stage does not
/// support CCD, so the geometry has to be the guarantee.
fn round_radius() -> f32 {
    std::env::var("VIBE_CITY_NATIVE_ROUND_RADIUS")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(0.4)
}

fn round_ttl_ticks() -> u32 {
    env_u32("VIBE_CITY_NATIVE_ROUND_TTL_TICKS", 6).max(1)
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
}

/// Claim the stage is stuck, once, at a chosen tick.
///
/// The failure this exists to rehearse -- a rebuilt stage that comes up at
/// frame 0 and never produces another -- has not been reproduced on demand, in
/// thirty reset cycles at production scale, with cannonballs in the scene and
/// player churn across the reset. An unreproducible fault still needs its
/// recovery path exercised, or the recovery is only a belief. So:
///
///   VIBE_CITY_NATIVE_FAULT_AT_TICK=600
///
/// makes `needs_rebuild` report true once, ten seconds in, and the server
/// should then rebuild the city, re-bootstrap its clients, and carry on being
/// destructible. Fires once per process so the rebuilt city is not immediately
/// torn down again.
fn fault_injection_due(ticks: u64) -> bool {
    static FIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(at) = std::env::var("VIBE_CITY_NATIVE_FAULT_AT_TICK")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return false;
    };
    if ticks < at || FIRED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return false;
    }
    eprintln!("[native-destruction] FAULT INJECTION: reporting the stage stuck at tick {ticks}");
    true
}

/// Snapshot flags the bridge sets on a sleep or wake edge.
const NATIVE_FLAG_SETTLED: u32 = 1;
const NATIVE_FLAG_WOKE: u32 = 2;

pub struct NativeCityDestruction {
    manifest: Arc<DestructionManifest>,
    encoder_input: Vec<BodySnapshotInput>,
    stats: DestructionStats,
    extra_spans: Vec<NamedSpan>,
    ticks: u64,
    /// Set when the engine reports that the scene cannot continue. The city is
    /// frozen from that point; it is reported rather than papered over.
    degraded: bool,
    last_status: NativeStatus,
    /// Wakes staged by shots between ticks, drained into the next output.
    pending_wakes: Vec<(u32, u32)>,
    /// Cumulative, for the stats shape. The stage reports per-tick deltas.
    migrations_total: u64,
    resettled_wakes: u64,
    /// Incomplete steps already logged. Bounded so a persistent fault cannot
    /// drown the log; the count itself stays exact in the spans.
    error_frames_logged: u32,
    /// Consecutive ticks the stage has rejected without ever reaching frame 1.
    ///
    /// The difference between "this tick did not complete" and "this stage
    /// never started" is the frame counter, and it is the difference between a
    /// hiccup and a match that is over. A stage stuck at frame 0 publishes
    /// nothing, ever: the city cannot be broken, `clearStress` refuses because
    /// of that state so it cannot be reset either, and every other reading --
    /// tick rate, player count, client agreement -- looks healthy. Twice on the
    /// live server this ran for 4,560 and 19,590 consecutive ticks before a
    /// human noticed the buildings had stopped falling down.
    stuck_at_frame_zero: u32,
}

impl NativeCityDestruction {
    /// Author every structure into the scene and configure the stage.
    ///
    /// The extra `world.step()` in here is required, not incidental: chunk
    /// shapes and bodies have no GPU identities until a step has completed, and
    /// those identities are exactly what the stage descriptor binds. It runs at
    /// match open, before the tick loop, so no gameplay tick is consumed.
    pub fn build(
        manifest: Arc<DestructionManifest>,
        world: &mut World,
        settings: StressSolverSettings,
        sim_hz: u32,
    ) -> Result<Self, CityDestructionError> {
        let _ = sim_hz;
        let ffi_settings = crate::runtime::ffi_settings(&settings);
        let material_count = ffi_settings.materials.len() as u32;
        if let Some(bad) = manifest
            .structures
            .iter()
            .flat_map(|structure| structure.bonds.iter())
            .find(|bond| bond.material >= material_count)
        {
            return Err(CityDestructionError::Bridge(format!(
                "bond material {} out of range ({material_count} materials)",
                bad.material
            )));
        }

        world
            .native_attach()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        let mut chunk_total = 0usize;
        for structure in &manifest.structures {
            let (pose, nodes, bonds) = authored_structure(&manifest, structure);
            chunk_total += nodes.len();
            world
                .native_create_destructible(
                    structure.structure_id,
                    pose,
                    &nodes,
                    &bonds,
                    ffi_settings.clone(),
                    GROUP_CHUNK,
                    CHUNK_COLLISION_MASK,
                )
                .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        }

        // The step that materialises GPU identities. Nothing observes it.
        world
            .step()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        let configured = world
            .native_configure(NativeConfig {
                max_iterations: stress_iterations(),
                tolerance: stress_tolerance(),
                warm_start: true,
                damage_rate: 2.0,
                bend_gain_max: 3.0,
                fibre_bending: true,
                reserved_contact_pairs: reserved_contact_pairs(chunk_total),
                preserve_unchanged_contact_pairs: true,
                gpu_island_repair: true,
                verdict_sample_ticks: verdict_sample_ticks(),
            })
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        eprintln!(
            "[native-destruction] structures={} chunks={} bonds={} clusters={} \
materials={} reserved_pairs={} iterations={} tolerance={:e}",
            manifest.structures.len(),
            configured.chunks,
            configured.bonds,
            configured.clusters,
            configured.materials,
            configured.reserved_pairs,
            stress_iterations(),
            stress_tolerance(),
        );

        Ok(Self {
            stats: DestructionStats {
                structures: manifest.structures.len() as u32,
                ..DestructionStats::default()
            },
            manifest,
            encoder_input: Vec::new(),
            extra_spans: Vec::new(),
            ticks: 0,
            degraded: false,
            last_status: NativeStatus::default(),
            pending_wakes: Vec::new(),
            migrations_total: 0,
            resettled_wakes: 0,
            error_frames_logged: 0,
            stuck_at_frame_zero: 0,
        })
    }

    /// Observe the step the host just completed and produce the tick's events.
    ///
    /// Call after `fetchResults` and before the next `simulate`, exactly where
    /// the other backends run their solve.
    pub fn post_step(
        &mut self,
        world: &mut World,
        dt: f32,
    ) -> Result<DestructionTickOutput, CityDestructionError> {
        let _ = dt;
        self.ticks += 1;
        let started = std::time::Instant::now();

        let status = world
            .native_tick()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        self.last_status = status;
        if status.degraded && !self.degraded {
            self.degraded = true;
            eprintln!(
                "[native-destruction] FATAL: the scene cannot continue (error bits \
{}); the city is frozen from here",
                status.error
            );
        }
        if status.error != 0 {
            if status.frame == 0 {
                self.stuck_at_frame_zero += 1;
            }
            // A step the engine did not complete publishes nothing, so there is
            // nothing to hand on. Reported through the spans and the log, never
            // smoothed into an empty-but-normal-looking tick.
            if self.error_frames_logged < 8 {
                self.error_frames_logged += 1;
                eprintln!(
                    "[native-destruction] step incomplete (error bits {}, frame {}); \
no observation this tick",
                    status.error, status.frame
                );
            }
            self.refresh_stats(world, started);
            return Ok(DestructionTickOutput::default());
        }
        self.stuck_at_frame_zero = 0;
        if !status.observed {
            self.refresh_stats(world, started);
            return Ok(DestructionTickOutput::default());
        }

        let broken = world
            .native_take_broken_bonds()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        let migrations = world
            .native_take_chunk_migrations()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        let islands = world
            .native_take_island_events()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;

        let mut batches: HashMap<u32, FractureBatch> = HashMap::new();
        let mut order: Vec<u32> = Vec::new();
        let batch = |batches: &mut HashMap<u32, FractureBatch>,
                         order: &mut Vec<u32>,
                         structure_id: u32| {
            if !batches.contains_key(&structure_id) {
                order.push(structure_id);
                batches.insert(
                    structure_id,
                    FractureBatch {
                        structure_id,
                        ..FractureBatch::default()
                    },
                );
            }
        };

        for event in &broken {
            batch(&mut batches, &mut order, event.structure_id);
            batches
                .get_mut(&event.structure_id)
                .expect("just inserted")
                .broken_bond_ids
                .push(event.bond_id);
        }
        self.migrations_total += migrations.len() as u64;
        for event in &migrations {
            batch(&mut batches, &mut order, event.structure_id);
            batches
                .get_mut(&event.structure_id)
                .expect("just inserted")
                .migrations
                .push(ShapeMigration {
                    chunk_id: event.chunk_id,
                    from_island_id: event.from_island,
                    to_island_id: event.to_island,
                });
        }
        for event in &islands {
            batch(&mut batches, &mut order, event.structure_id);
            let entry = batches
                .get_mut(&event.structure_id)
                .expect("just inserted");
            match event.kind {
                0 => entry.promoted_islands.push(IslandPromotion {
                    structure_id: event.structure_id,
                    island_id: event.island_id,
                    chunks: event.chunk_ids.clone(),
                    mass: event.mass,
                    // The bridge publishes centre-of-mass frame poses, which is
                    // the convention the wire documents: a client composes
                    // `rest_local - island_com` against this pose.
                    center_of_mass: [
                        event.position.x,
                        event.position.y,
                        event.position.z,
                    ],
                    position: [event.position.x, event.position.y, event.position.z],
                    rotation: [
                        event.rotation.x,
                        event.rotation.y,
                        event.rotation.z,
                        event.rotation.w,
                    ],
                    linear_velocity: [
                        event.linear_velocity.x,
                        event.linear_velocity.y,
                        event.linear_velocity.z,
                    ],
                    angular_velocity: [
                        event.angular_velocity.x,
                        event.angular_velocity.y,
                        event.angular_velocity.z,
                    ],
                    // Left zero deliberately. The stage does not publish a
                    // fragment inertia tensor or a split impulse, and a
                    // fabricated value is worse than an absent one. Neither
                    // field has a consumer today.
                    inertia_diagonal: [0.0; 3],
                    split_impulse: [0.0; 3],
                }),
                1 => entry.retired_island_ids.push(event.island_id),
                other => {
                    // Matched explicitly: a new event kind must be handled here
                    // rather than silently swallowed by a wildcard.
                    eprintln!("[native-destruction] unhandled island event kind {other}");
                }
            }
        }

        // Body rows, plus the settle and wake edges the stage reported.
        let snapshots = world
            .native_chunk_body_snapshots()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))?;
        self.encoder_input.clear();
        self.encoder_input.reserve(snapshots.len());
        let mut settled: Vec<SettleEvent> = Vec::new();
        let mut wakes: Vec<(u32, u32)> = std::mem::take(&mut self.pending_wakes);
        for snap in snapshots {
            if snap.flags == NATIVE_FLAG_SETTLED {
                settled.push(SettleEvent {
                    structure_id: snap.structure_id,
                    island_id: snap.island_id,
                    position: [snap.position.x, snap.position.y, snap.position.z],
                    rotation: [
                        snap.rotation.x,
                        snap.rotation.y,
                        snap.rotation.z,
                        snap.rotation.w,
                    ],
                });
            } else if snap.flags == NATIVE_FLAG_WOKE {
                self.resettled_wakes += 1;
                wakes.push((snap.structure_id, snap.island_id));
            }
            // Kinematic bodies are the anchored remnants: the client draws them
            // from the manifest's rest poses, and streaming them would be a
            // pose per tick for something that never moves.
            if snap.kinematic || snap.sleeping {
                continue;
            }
            let mut flags = 0u8;
            if snap.flags == NATIVE_FLAG_WOKE {
                flags |= crate::types::FLAG_WAKE_EVENT;
            }
            self.encoder_input.push(BodySnapshotInput {
                body_entity: ids::body_entity(snap.structure_id, snap.island_id),
                position: [snap.position.x, snap.position.y, snap.position.z],
                rotation: [
                    snap.rotation.x,
                    snap.rotation.y,
                    snap.rotation.z,
                    snap.rotation.w,
                ],
                linear_velocity: [
                    snap.linear_velocity.x,
                    snap.linear_velocity.y,
                    snap.linear_velocity.z,
                ],
                angular_velocity: [
                    snap.angular_velocity.x,
                    snap.angular_velocity.y,
                    snap.angular_velocity.z,
                ],
                // The stage consumes contacts on the GPU and publishes no
                // per-body count. Zero here is "not reported", and the encoder
                // treats contacts as a scheduling hint rather than an input to
                // correctness.
                contacts: 0,
                flags,
            });
        }

        self.refresh_stats(world, started);

        let mut out = DestructionTickOutput {
            batches: order
                .into_iter()
                .filter_map(|id| batches.remove(&id))
                .collect(),
            settled,
            wakes,
        };
        out.batches.retain(|b| {
            !b.broken_bond_ids.is_empty()
                || !b.migrations.is_empty()
                || !b.promoted_islands.is_empty()
                || !b.retired_island_ids.is_empty()
        });
        Ok(out)
    }

    /// Deliver a shot as a physical round.
    ///
    /// The stage has no force injection: bonds break because PhysX solved a
    /// contact, so a hitscan hit becomes a real body carrying the round's
    /// momentum. It is owned by the bridge, never networked, and retires after
    /// a few ticks.
    pub fn fire_round(
        &mut self,
        world: &mut World,
        point: [f32; 3],
        direction: [f32; 3],
        momentum_ns: f32,
    ) -> Result<(), CityDestructionError> {
        world
            .native_fire_round(RoundDesc {
                position: Vec3::new(point[0], point[1], point[2]),
                direction: Vec3::new(direction[0], direction[1], direction[2]),
                momentum_ns,
                radius: round_radius(),
                speed: round_speed(),
                ttl_ticks: round_ttl_ticks(),
            })
            .map(|_| ())
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))
    }

    /// Copy the stage's own measurements into the shared stats shape.
    ///
    /// Only fields this backend can actually measure are assigned. The
    /// application-solve timings (`stress_solve_ms`, `begin/solve/end_ms`, every
    /// `blast_*`) stay at their defaults because no such phase exists here --
    /// leaving them zero is the truthful answer, and the `native_*` spans carry
    /// what there is to carry.
    fn refresh_stats(&mut self, world: &World, started: std::time::Instant) {
        let Ok(bridge) = world.native_stats() else {
            return;
        };
        let spans = world.take_destruction_spans();
        self.extra_spans = spans
            .into_iter()
            .map(|span| NamedSpan {
                name: span.name,
                value: span.value,
                kind: span.kind,
            })
            .collect();

        let structures = self.manifest.structures.len() as u32;
        let total_ms = started.elapsed().as_secs_f32() * 1000.0;
        let tick_ffi_ms = self
            .extra_spans
            .iter()
            .find(|span| span.name == "native_tick_ms")
            .map(|span| span.value as f32)
            .unwrap_or(0.0);

        self.stats = DestructionStats {
            structures,
            chunk_bodies: bridge.chunk_bodies,
            awake_chunk_bodies: bridge.awake_chunk_bodies,
            sleeping_chunk_bodies: bridge.sleeping_chunk_bodies,
            broken_bonds: bridge.broken_bonds,
            overstressed_bonds: bridge.overstressed_bonds,
            bond_utilisation_max: bridge.bond_utilisation_max,
            bonds_above_half_utilisation: bridge.bonds_above_half_utilisation,
            contacts_processed: bridge.contacts_processed,
            solver_island_count: bridge.solver_island_count,
            solver_islands_skipped: bridge.solver_islands_skipped,
            gpu_stress_structures: bridge.gpu_stress_structures,
            readback_ms: bridge.readback_ms,
            events_ms: bridge.events_ms,
            tick_ffi_ms,
            post_step_total_ms: total_ms,
            post_step_ms: total_ms,
            post_step_residual_ms: (total_ms - tick_ffi_ms).max(0.0),
            chunk_migrations: self.migrations_total,
            resettled_wakes: self.resettled_wakes,
            ..DestructionStats::default()
        };
    }

    pub fn body_snapshots(&self) -> &[BodySnapshotInput] {
        &self.encoder_input
    }

    pub fn stats(&self) -> DestructionStats {
        self.stats.clone()
    }

    pub fn extra_spans(&self) -> &[NamedSpan] {
        &self.extra_spans
    }

    pub fn is_degraded(&self) -> bool {
        self.degraded
    }

    /// True once the stage has been stuck at frame 0 long enough that it is not
    /// going to start on its own.
    ///
    /// Two seconds, because a stage that is going to produce a frame produces
    /// its first one immediately, and because the cure -- rebuilding the city
    /// and re-bootstrapping every client -- is disruptive enough that it should
    /// not fire on a transient. Why a rebuilt stage sometimes comes up this way
    /// is not established: it has not been reproduced in thirty reset cycles at
    /// production scale, mid-collapse, with cannonballs in the scene and player
    /// churn across the reset. So this does not pretend to be a fix. It is the
    /// difference between a match that recovers in a couple of seconds and one
    /// that is silently over.
    pub fn needs_rebuild(&self) -> bool {
        if fault_injection_due(self.ticks) {
            return true;
        }
        self.stuck_at_frame_zero >= 120
    }

    pub fn last_status(&self) -> NativeStatus {
        self.last_status
    }

    pub fn ticks(&self) -> u64 {
        self.ticks
    }

    pub fn manifest(&self) -> &Arc<DestructionManifest> {
        &self.manifest
    }

    /// Per-bond stress for one structure: the surgical readout.
    ///
    /// Returned as (bond index, node0, node1, utilisation) so the structural
    /// audit can join it against the manifest without this crate re-exporting
    /// a bridge type. A snapshot of the last sampled solve; nothing is solved
    /// here.
    pub fn bond_stress_rows(
        &self,
        world: &World,
        structure_id: u32,
    ) -> Vec<(u32, u32, u32, f32)> {
        world
            .native_bond_stress_rows(structure_id)
            .map(|rows| {
                rows.into_iter()
                    .map(|r| (r.bond_index, r.node0, r.node1, r.utilisation))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whole-world GPU/CPU ownership audit. Heavy by design; for gates, not ticks.
    pub fn validate_mappings(&self, world: &World) -> bool {
        world.native_validate_mappings().unwrap_or(false)
    }

    /// Release the stage and every actor it owns, so a fresh city can be built.
    pub fn clear(&mut self, world: &mut World) -> Result<(), CityDestructionError> {
        world
            .native_clear()
            .map_err(|e| CityDestructionError::Bridge(e.to_string()))
    }
}
