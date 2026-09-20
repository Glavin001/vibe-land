#include "native_state.h"

#include <algorithm>

using namespace physx;

namespace vibe_land::physx_bridge {

void NativeDestruction::State::observe_topology(
    const PxDestructionDeviceView &view) {
  const PxDestructionCommittedChangesView &changes = view.committedChanges;
  native_require(changes.status != nullptr,
                 "native committed-change publication missing");
  NativeReadback read(scene, nullptr); // ordered by the caller's readyEvent.
  const PxDestructionCommittedChangesStatus status =
      read.read(changes.status, 1).front();
  native_require(status.error == 0 && status.frame == last.frame,
                 "invalid or stale committed changes");
  native_require(status.chunkCount <= changes.chunkCapacity &&
                     status.bondCount <= changes.bondCapacity,
                 "committed changes overflowed their capacity");
  native_require(observed_frame != 0 || status.fullSnapshot != 0,
                 "first observation is not a full snapshot");

  const std::vector<PxDestructionChangedChunk> changed =
      read.read(changes.chunks, status.chunkCount);
  const std::vector<std::uint32_t> broken_indices =
      read.read(changes.brokenBonds, status.bondCount);
  observed_chunks = status.chunkCount;
  observed_bonds = status.bondCount;
  stress_islands = status.stressIslandCount;
  observation_bytes = sizeof(status) +
                      changed.size() * sizeof(PxDestructionChangedChunk) +
                      broken_indices.size() * sizeof(std::uint32_t);

  apply_changed_chunks(changed, status.clusterCount, /*full=*/false);

  std::uint32_t previous = PX_INVALID_U32;
  for (const std::uint32_t index : broken_indices) {
    native_require(index < bond_ids.size() &&
                       (previous == PX_INVALID_U32 || previous < index),
                   "duplicate or unordered broken bond");
    previous = index;
    const auto id = bond_ids[index];
    broken.push_back(
        FfiBrokenBondEvent{id.first, native_bond_id(id.first, id.second)});
  }
  broken_total += broken_indices.size();
}

void NativeDestruction::State::rebuild_from_accepted_topology(
    const PxDestructionDeviceView &view) {
  // Recovery path after a missed frame: the delta stream is only valid frame
  // to frame, so re-derive every chunk's owner from accepted topology instead
  // of applying a delta against state that has already drifted.
  const PxDestructionTopologyDeviceView &topology = view.acceptedTopology;
  native_require(topology.status != nullptr,
                 "accepted topology publication missing");
  NativeReadback read(scene, nullptr);
  const PxDestructionTopologyStatus status =
      read.read(topology.status, 1).front();
  const std::vector<std::uint32_t> chunk_cluster =
      read.read(topology.chunkCluster, chunks.size());
  const std::vector<std::uint32_t> cluster_slots =
      read.read(topology.clusterSlots, chunks.size());
  const std::vector<std::uint64_t> generations =
      read.read(topology.slotGenerations, topology.slotCapacity);
  observation_bytes = sizeof(status) +
                      chunk_cluster.size() * sizeof(std::uint32_t) +
                      cluster_slots.size() * sizeof(std::uint32_t) +
                      generations.size() * sizeof(std::uint64_t);
  observed_chunks = static_cast<std::uint32_t>(chunks.size());
  observed_bonds = 0;

  std::vector<PxDestructionChangedChunk> rows;
  rows.reserve(chunks.size());
  for (std::uint32_t chunk = 0; chunk < chunks.size(); ++chunk) {
    const std::uint32_t root = chunk_cluster[chunk];
    if (root == PX_INVALID_U32 || root >= cluster_slots.size()) {
      continue;
    }
    const std::uint32_t slot = cluster_slots[root];
    PxDestructionChangedChunk row{};
    row.chunk = chunk;
    row.root = root;
    row.slot = slot;
    row.generation = slot < generations.size() ? generations[slot] : 0;
    row.active = 1;
    rows.push_back(row);
  }
  apply_changed_chunks(rows, status.clusterCount, /*full=*/true);

  // Bond health is the authoritative record of what is broken; after a gap the
  // broken-bond deltas we missed cannot be recovered as events, so re-derive
  // the total rather than leaving the counter wrong.
  const std::vector<float> health = read.read(view.bondHealth, bonds.size());
  broken_total = static_cast<std::uint64_t>(
      std::count_if(health.begin(), health.end(),
                    [](float v) { return v <= 0.0f; }));
}

void NativeDestruction::State::apply_changed_chunks(
    const std::vector<PxDestructionChangedChunk> &changed,
    std::uint32_t cluster_count, bool full) {
  using Key = std::pair<std::uint32_t, std::uint64_t>;
  std::map<Key, std::vector<std::uint32_t>> groups;
  std::set<Key> affected;
  std::uint32_t previous = PX_INVALID_U32;
  for (const PxDestructionChangedChunk &row : changed) {
    native_require(row.chunk < chunks.size() && row.root < chunks.size() &&
                       row.active != 0,
                   "invalid committed chunk row");
    native_require(previous == PX_INVALID_U32 || previous < row.chunk,
                   "duplicate or unordered committed chunk row");
    previous = row.chunk;
    Chunk &chunk = chunks[row.chunk];
    if (chunk.root != PX_INVALID_U32) {
      affected.emplace(chunk.root, chunk.generation);
    }
    groups[{row.root, row.generation}].push_back(row.chunk);
  }

  std::map<Key, NativeBody> next;
  for (auto &group : groups) {
    const Key key = group.first;
    PxRigidActor *owner = chunks[group.second.front()].shape->getActor();
    PxRigidDynamic *actor = owner != nullptr ? owner->is<PxRigidDynamic>() : nullptr;
    native_require(actor != nullptr, "committed chunk has no native body");
    const bool supported =
        actor->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC);
    const std::uint32_t structure = chunks[group.second.front()].structure;

    auto old = bodies.find(key);
    std::uint32_t serial = old == bodies.end() ? 0u : old->second.serial;
    bool promoted = false;
    if (!supported && serial == 0) {
      serial = next_serial.at(structure)++;
      promoted = true;
      splits += 1;
    }
    // Membership decides the centre of mass, and the wire pose is expressed in
    // that frame. A body whose members changed must be republished or the
    // client keeps composing its chunks against a stale origin.
    promoted |= !supported && old != bodies.end() &&
                old->second.chunks != group.second;

    const std::uint32_t entity = NativeDestruction::entity_id(structure, serial);
    actor->userData =
        reinterpret_cast<void *>(static_cast<std::uintptr_t>(entity) + 1u);

    FfiIslandBodyEvent event{};
    if (promoted) {
      const PxTransform pose = actor->getGlobalPose();
      event.structure_id = structure;
      event.island_id = serial;
      event.kind = 0;
      event.mass = actor->getMass();
      event.position = native_ffi(pose.transform(actor->getCMassLocalPose().p));
      event.rotation = native_ffi(pose.q);
      event.linear_velocity = native_ffi(actor->getLinearVelocity());
      event.angular_velocity = native_ffi(actor->getAngularVelocity());
    }

    for (const std::uint32_t id : group.second) {
      Chunk &chunk = chunks[id];
      native_require(chunk.structure == structure &&
                         chunk.shape->getActor() == actor,
                     "GPU ownership and the CPU collision mirror disagree");
      const std::uint32_t packed = native_chunk_id(structure, chunk.authored);
      if (chunk.serial != serial && !full) {
        migrations.push_back(FfiChunkMigrationEvent{structure, packed,
                                                    chunk.serial, serial});
        migration_total += 1;
      }
      const bool query_changed =
          chunk.root == PX_INVALID_U32 || chunk.serial != serial;
      chunk.serial = serial;
      chunk.root = key.first;
      chunk.generation = key.second;
      // Query identity is an observation. Touching *simulation* filter data
      // here would invalidate the contact pairs the stage deliberately reuses.
      if (query_changed) {
        PxFilterData filter = chunk.shape->getQueryFilterData();
        filter.word1 = entity;
        chunk.shape->setQueryFilterData(filter);
      }
      if (promoted) {
        event.chunk_ids.push_back(packed);
      }
    }
    if (promoted) {
      events.push_back(std::move(event));
      topology_changes += 1;
    }
    NativeBody body;
    body.actor = actor;
    body.structure = structure;
    body.serial = serial;
    body.chunks = std::move(group.second);
    body.sleeping = old == bodies.end() ? false : old->second.sleeping;
    next.emplace(key, std::move(body));
  }

  // Only groups the stage actually reported as changed retire; unrelated and
  // sleeping bodies keep their records, which is the whole point of consuming
  // a delta rather than re-reading the world.
  for (const Key &key : affected) {
    const auto old = bodies.find(key);
    native_require(old != bodies.end(), "missing old committed group");
    if (old->second.serial != 0 && next.count(key) == 0) {
      FfiIslandBodyEvent event{};
      event.structure_id = old->second.structure;
      event.island_id = old->second.serial;
      event.kind = 1;
      events.push_back(std::move(event));
      topology_changes += 1;
    }
    bodies.erase(old);
  }
  if (full) {
    // A rebuild describes every chunk, so anything not in it is gone.
    for (auto it = bodies.begin(); it != bodies.end();) {
      if (next.count(it->first) == 0) {
        if (it->second.serial != 0) {
          FfiIslandBodyEvent event{};
          event.structure_id = it->second.structure;
          event.island_id = it->second.serial;
          event.kind = 1;
          events.push_back(std::move(event));
        }
        it = bodies.erase(it);
      } else {
        ++it;
      }
    }
  }
  bodies.merge(next);
  native_require(next.empty(), "committed group merge collided");
  native_require(bodies.size() == cluster_count,
                 "committed GPU/CPU group count mismatch");
}

/// Below this height a body has left the world and is never coming back.
static float native_debris_floor_m() {
  static const float floor = [] {
    if (const char *raw = std::getenv("VIBE_CITY_NATIVE_DEBRIS_FLOOR_M")) {
      const float parsed = std::strtof(raw, nullptr);
      if (std::isfinite(parsed)) {
        return parsed;
      }
    }
    // Disabled with the rest of the lifecycle: parking uses the same
    // putToSleep on the same stage-owned bodies. A body lost below the world
    // is a real cost, but not one worth an unbreakable city.
    return -std::numeric_limits<float>::infinity();
  }();
  return floor;
}

/// Speed under which a body counts as quiet, and how many consecutive quiet
/// ticks earn it a forced sleep. Zero ticks disables the assist.
static float native_settle_speed() {
  static const float speed = [] {
    if (const char *raw = std::getenv("VIBE_CITY_NATIVE_SETTLE_SPEED")) {
      const float parsed = std::strtof(raw, nullptr);
      if (std::isfinite(parsed) && parsed >= 0.0f) {
        return parsed;
      }
    }
    return 0.12f;
  }();
  return speed;
}

/// Freeze quiet debris to kinematic rather than merely sleeping it.
///
/// Off, and measured that way rather than assumed. Flipping thousands of
/// stage-owned fragments to kinematic did not finish an 800-shot run in three
/// times the wall time the sleeping variant needed; these are GPU-resident
/// bodies and changing that flag on them is evidently not the cheap bookkeeping
/// it is for an ordinary actor. Kept behind the switch so the result is
/// reproducible, not repeated.
static bool native_settle_freezes() {
  static const bool freeze = [] {
    const char *raw = std::getenv("VIBE_CITY_NATIVE_SETTLE_FREEZE");
    return raw != nullptr && raw[0] == '1';
  }();
  return freeze;
}

/// Off by default, and this is the second attempt that had to be turned off.
///
/// Both ways of taking a stage-owned fragment out of the simulation break the
/// stage. Making one kinematic did not finish an 800-shot run in three times
/// the wall time. Putting one to sleep looked fine in the bench and killed a
/// live server: four minutes after the first cannonball, the stage began
/// failing with runtime error bit 4 and did not stop -- 91,201 consecutive
/// rejected steps, the city frozen at 90 broken bonds and unbreakable for the
/// rest of the session. The bench never saw it because it fires and settles;
/// only continuous play reaches the state.
///
/// These bodies belong to the destruction stage. Nothing outside it may decide
/// when they stop simulating, and the fix for debris cost has to come from the
/// stage itself. Set VIBE_CITY_NATIVE_SETTLE_TICKS to re-enable for
/// investigation; it is not a tuning knob.
static std::uint32_t native_settle_ticks() {
  static const std::uint32_t ticks = [] {
    if (const char *raw = std::getenv("VIBE_CITY_NATIVE_SETTLE_TICKS")) {
      const long parsed = std::strtol(raw, nullptr, 10);
      if (parsed >= 0) {
        return static_cast<std::uint32_t>(parsed);
      }
    }
    return 0u;
  }();
  return ticks;
}

void NativeDestruction::State::refresh_snapshots() {
  snapshots.clear();
  snapshots.reserve(bodies.size());
  const float floor_m = native_debris_floor_m();
  const float quiet_speed = native_settle_speed();
  const std::uint32_t quiet_limit = native_settle_ticks();
  for (auto &entry : bodies) {
    NativeBody &body = entry.second;
    PxRigidDynamic &actor = *body.actor;
    const bool kinematic =
        actor.getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC);

    // Steady sleeper: asleep last tick, asleep (or anchored) now, row already
    // published. Nothing about it has changed, and the host drops sleeping
    // rows before the encoder sees them, so the cached row is the answer.
    // Two property reads instead of seven; see NativeBody::last_snapshot.
    // The chunk count is refreshed from our own record because a migration
    // can change it without waking the body.
    if (body.sleeping && body.has_snapshot && (kinematic || actor.isSleeping())) {
      body.quiet_ticks = 0;
      FfiChunkBodySnapshot &snap = body.last_snapshot;
      snap.kinematic = kinematic;
      snap.node_count = static_cast<std::uint32_t>(body.chunks.size());
      snap.flags = 0;
      snapshots.push_back(snap);
      continue;
    }

    // Each property once. The awake path used to read the sleep state, the
    // pose and both velocities twice over (once for the debris lifecycle,
    // once for the row), and at 19k awake bodies the second read was ~2 ms.
    const bool asleep = !kinematic && actor.isSleeping();
    const PxTransform pose = actor.getGlobalPose();
    const PxVec3 linear = actor.getLinearVelocity();
    const PxVec3 angular = actor.getAngularVelocity();

    // Debris lifecycle. The stage has none of its own, and without one a city
    // that has been fought over is thousands of chunks that simulate forever:
    // a rubble pile never satisfies PhysX's sleep test, and anything that
    // tunnels through the ground falls for the rest of the match. Measured at
    // 6,181 awake bodies out of 6,510, the rigid-body step alone was 16.6 ms
    // of a 16.7 ms budget -- the destruction was cheap by then and the debris
    // was the whole cost.
    bool parked_this_tick = false;
    if (!kinematic && !asleep) {
      const PxVec3 position = pose.p;
      const bool lost = !position.isFinite() || position.y < floor_m;
      const float speed = linear.magnitude();
      const float spin = angular.magnitude();
      const bool quiet = speed <= quiet_speed && spin <= quiet_speed;
      body.quiet_ticks = quiet ? body.quiet_ticks + 1 : 0;
      if (lost) {
        // Falling out of the world is terminal. Parking it costs one call and
        // takes the body out of the simulation for good; it cannot be woken by
        // a contact it will never have.
        actor.putToSleep();
        parked_this_tick = true;
        debris_parked += 1;
      } else if (quiet_limit != 0 && body.quiet_ticks >= quiet_limit) {
        // Sleep does not fully stick: over 800 cannonball shots this fired
        // 27,043 times for 1,794 bodies, about fifteen times each, because
        // something wakes them again. It still removes real work between
        // wakes. Freezing to kinematic would be terminal and is what the Blast
        // path does with rubble, but on stage-owned GPU bodies it measured
        // far slower -- see native_settle_freezes.
        if (native_settle_freezes()) {
          // A body frozen this tick still answers isSleeping() false until the
          // next step, and its row said so before this walk was rewritten.
          actor.setRigidBodyFlag(PxRigidBodyFlag::eKINEMATIC, true);
        } else {
          actor.putToSleep();
          parked_this_tick = true;
        }
        body.quiet_ticks = 0;
        debris_settled += 1;
      }
    } else {
      body.quiet_ticks = 0;
    }

    // A body put to sleep this tick reads as sleeping from here on, exactly
    // as the re-read it replaces did (putToSleep takes effect immediately).
    const bool sleeping = kinematic || asleep || parked_this_tick;
    if (sleeping && !body.sleeping) {
      // Sleep edges are what the wire calls a settle; levels cannot express
      // "came to rest just now".
    } else if (!sleeping && body.sleeping) {
      resettled_wakes += 1;
    }
    FfiChunkBodySnapshot snap{};
    snap.entity_id = NativeDestruction::entity_id(body.structure, body.serial);
    snap.structure_id = body.structure;
    snap.island_id = body.serial;
    // The wire pose is the centre-of-mass frame: a client composes chunk rest
    // offsets minus the island centre of mass against it.
    snap.position = native_ffi(pose.transform(actor.getCMassLocalPose().p));
    snap.rotation = native_ffi(pose.q);
    snap.linear_velocity = native_ffi(linear);
    snap.angular_velocity = native_ffi(angular);
    snap.sleeping = sleeping;
    snap.kinematic = kinematic;
    snap.node_count = static_cast<std::uint32_t>(body.chunks.size());
    snap.flags = 0;
    if (sleeping != body.sleeping) {
      snap.flags = sleeping ? 1u : 2u; // 1 = settled this tick, 2 = woke.
    }
    body.sleeping = sleeping;
    body.last_snapshot = snap;
    body.has_snapshot = true;
    snapshots.push_back(snap);
  }
}

void NativeDestruction::State::sample_bond_verdicts(
    const PxDestructionDeviceView &view) {
  if (view.bondVerdicts == nullptr || bonds.empty()) {
    return;
  }
  NativeReadback read(scene, nullptr);
  const std::vector<PxDestructionBondVerdict> verdicts =
      read.read(view.bondVerdicts, bonds.size());
  observation_bytes += verdicts.size() * sizeof(PxDestructionBondVerdict);
  float worst = 0.0f;
  std::uint32_t above_half = 0;
  std::uint32_t overstressed = 0;
  for (std::size_t i = 0; i < bonds.size(); ++i) {
    const PxDestructionMaterial &m = materials[bonds[i].material];
    const PxDestructionBondVerdict &v = verdicts[i];
    const float tension = m.tensionElasticLimit < 0 ? m.compressionElasticLimit
                                                    : m.tensionElasticLimit;
    const float shear =
        m.shearElasticLimit < 0 ? m.compressionElasticLimit : m.shearElasticLimit;
    const float utilisation = std::max(
        {std::max(0.0f, -v.stressNormal) / m.compressionElasticLimit,
         std::max(0.0f, v.stressNormal) / tension, v.stressShear / shear});
    worst = std::max(worst, utilisation);
    if (utilisation >= 0.5f) {
      above_half += 1;
    }
    if (utilisation > 1.0f) {
      overstressed += 1;
    }
  }
  bond_utilisation_max = worst;
  bonds_above_half = above_half;
  overstressed_bonds = overstressed;
}

rust::Slice<const FfiChunkBodySnapshot>
NativeDestruction::chunk_body_snapshots() const {
  const std::vector<FfiChunkBodySnapshot> &out = state_->snapshots;
  return {out.data(), out.size()};
}

rust::Vec<FfiBrokenBondEvent> NativeDestruction::take_broken_bonds() {
  rust::Vec<FfiBrokenBondEvent> out = std::move(state_->broken);
  state_->broken = {};
  return out;
}

rust::Vec<FfiChunkMigrationEvent> NativeDestruction::take_chunk_migrations() {
  rust::Vec<FfiChunkMigrationEvent> out = std::move(state_->migrations);
  state_->migrations = {};
  return out;
}

rust::Vec<FfiIslandBodyEvent> NativeDestruction::take_island_events() {
  rust::Vec<FfiIslandBodyEvent> out = std::move(state_->events);
  state_->events = {};
  return out;
}

rust::Vec<FfiBondStressRow>
NativeDestruction::bond_stress_rows(std::uint32_t structure_id) const {
  const State &s = *state_;
  rust::Vec<FfiBondStressRow> out;
  if (!s.configured || s.observed_frame == 0) {
    return out;
  }
  const PxDestructionDeviceView view = s.stage().getDeviceView();
  NativeReadback read(s.scene, view.readyEvent);
  if (view.bondVerdicts == nullptr) {
    return out;
  }
  const std::vector<PxDestructionBondVerdict> verdicts =
      read.read(view.bondVerdicts, s.bonds.size());
  const auto base = s.material_base.find(structure_id);
  for (std::size_t i = 0; i < s.bonds.size(); ++i) {
    if (s.bond_ids[i].first != structure_id) {
      continue;
    }
    const PxDestructionStressBond &bond = s.bonds[i];
    const PxDestructionBondVerdict &v = verdicts[i];
    const PxDestructionMaterial &m = s.materials[bond.material];
    FfiBondStressRow row{};
    row.bond_index = s.bond_ids[i].second;
    row.node0 = s.chunks[bond.chunk0].authored;
    row.node1 = s.chunks[bond.chunk1].authored;
    row.material =
        base == s.material_base.end() ? bond.material : bond.material - base->second;
    row.area = bond.area;
    row.compression = std::max(0.0f, -v.stressNormal);
    row.tension = std::max(0.0f, v.stressNormal);
    row.shear = v.stressShear;
    const float tension = m.tensionElasticLimit < 0 ? m.compressionElasticLimit
                                                    : m.tensionElasticLimit;
    const float shear =
        m.shearElasticLimit < 0 ? m.compressionElasticLimit : m.shearElasticLimit;
    row.utilisation =
        std::max({row.compression / m.compressionElasticLimit,
                  row.tension / tension, row.shear / shear});
    out.push_back(row);
  }
  return out;
}

FfiDestructionStats NativeDestruction::stats() const {
  const State &s = *state_;
  FfiDestructionStats out{};
  out.structures = static_cast<std::uint32_t>(s.next_serial.size());
  // The stress solve runs on CUDA inside simulate() for every structure at
  // once; there is no per-structure CPU fallback to distinguish from.
  out.gpu_stress_structures = out.structures;
  out.chunk_bodies = static_cast<std::uint32_t>(s.snapshots.size());
  for (const FfiChunkBodySnapshot &snap : s.snapshots) {
    if (!snap.sleeping) {
      out.awake_chunk_bodies += 1;
    }
  }
  out.sleeping_chunk_bodies = out.chunk_bodies - out.awake_chunk_bodies;
  out.solver_island_count = s.stress_islands;
  // The engine solves warm starts every tick today, so "skipped" is only
  // truthful when it reports no iterations at all.
  out.solver_islands_skipped = s.last.iterations == 0 ? s.stress_islands : 0;
  out.contacts_processed = s.last.normalContacts;
  out.broken_bonds = static_cast<std::uint32_t>(s.broken_total);
  out.overstressed_bonds = s.overstressed_bonds;
  out.bond_utilisation_max = s.bond_utilisation_max;
  out.bonds_above_half_utilisation = s.bonds_above_half;
  // The committed-delta read is the readback, and grouping it into bodies is
  // the event pass; they are one interval here because they are one pass.
  out.readback_ms = static_cast<float>(s.observe_ms);
  out.events_ms = static_cast<float>(s.observe_ms);
  // Left at zero deliberately, and published as `native_*` spans instead:
  // `stress_solve_ms`, `begin/solve/end_ms` and every `blast_*` field describe
  // an application-driven solve that does not happen on this backend. The
  // honest number for the stress cost is the scene's own simulate time.

  auto span = [&out](const char *name, double value, std::uint8_t kind) {
    FfiNamedSpan s{};
    s.name = rust::String(name);
    s.value = value;
    s.kind = kind;
    out.extra_spans.push_back(std::move(s));
  };
  span("native_tick_ms", s.tick_ms, 0);
  span("native_status_read_ms", s.status_read_ms, 0);
  span("native_observe_ms", s.observe_ms, 0);
  span("native_snapshot_ms", s.snapshot_ms, 0);
  span("native_rounds_ms", s.rounds_ms, 0);
  span("native_debris_parked", static_cast<double>(s.debris_parked), 2);
  span("native_debris_settled", static_cast<double>(s.debris_settled), 2);
  span("native_migrations_total", static_cast<double>(s.migration_total), 2);
  span("native_resettled_wakes", static_cast<double>(s.resettled_wakes), 2);
  span("native_splits", static_cast<double>(s.splits), 2);
  span("native_verdict_ms", s.verdict_ms, 0);

  span("native_backend", 1, 2);
  span("native_frame", static_cast<double>(s.last.frame), 2);
  span("native_error_frames", static_cast<double>(s.error_frames), 2);
  span("native_error_bits_last", static_cast<double>(s.error_bits_last), 2);
  span("native_unconverged_frames", static_cast<double>(s.unconverged_frames), 2);
  span("native_degraded", s.degraded ? 1 : 0, 2);
  span("native_correction_passes", static_cast<double>(s.last.correctionPasses), 2);
  span("native_corrections_total", static_cast<double>(s.corrections_total), 2);
  span("native_stress_passes", static_cast<double>(s.last.stressPasses), 2);
  span("native_stress_iterations", static_cast<double>(s.last.iterations), 2);
  span("native_stress_iterations_peak",
       static_cast<double>(s.stress_iterations_peak), 2);
  span("native_clusters", static_cast<double>(s.bodies.size()), 2);
  span("native_chunks", static_cast<double>(s.chunks.size()), 2);
  span("native_bonds", static_cast<double>(s.bonds.size()), 2);
  span("native_topology_observed_chunks", static_cast<double>(s.observed_chunks), 2);
  span("native_topology_observed_bonds", static_cast<double>(s.observed_bonds), 2);
  span("native_observation_bytes", static_cast<double>(s.observation_bytes), 2);
  span("native_full_reobservations", static_cast<double>(s.full_reobservations), 2);
  span("native_missed_frames", static_cast<double>(s.missed_frames), 2);
  span("native_rounds_live", static_cast<double>(s.rounds.size()), 2);
  span("native_rounds_fired", static_cast<double>(s.rounds_fired), 2);
  span("native_rounds_evicted", static_cast<double>(s.rounds_evicted), 2);
  span("native_verdict_sample_age_ticks",
       static_cast<double>(s.verdict_sample_age), 2);

  // The six counts `destruction/src/equilibrium.rs` reads. Mapped to what the
  // stage actually reports, so the idle gate passes only when the engine
  // genuinely stops working -- never because the numbers were made to agree.
  span("stress_live_structures", static_cast<double>(out.structures), 2);
  span("stress_converged_structures",
       s.last.converged != 0 ? static_cast<double>(out.structures) : 0.0, 2);
  span("stress_completed_updates", static_cast<double>(s.completed_updates), 2);
  span("stress_active_island_updates",
       static_cast<double>(s.active_island_updates), 2);
  span("stress_crush_yield_nodes", static_cast<double>(s.crush_yield_nodes), 2);
  span("stress_topology_changes", static_cast<double>(s.topology_changes), 2);
  return out;
}

bool NativeDestruction::validate_mappings() const {
  const State &s = *state_;
  if (!s.configured || s.observed_frame == 0) {
    return true;
  }
  // Deliberately heavy and deliberately outside any timed path: it reads the
  // whole-world arrays that normal publication never touches.
  const PxDestructionDeviceView view = s.stage().getDeviceView();
  NativeReadback read(s.scene, view.readyEvent);
  const PxDestructionTopologyDeviceView &topology = view.acceptedTopology;
  const PxDestructionTopologyStatus status = read.read(topology.status, 1).front();
  const std::vector<std::uint32_t> roots =
      read.read(topology.chunkCluster, s.chunks.size());
  const std::vector<std::uint32_t> slots =
      read.read(topology.clusterSlots, s.chunks.size());
  const std::vector<std::uint64_t> generations =
      read.read(topology.slotGenerations, topology.slotCapacity);
  if (status.clusterCount != s.bodies.size()) {
    return false;
  }
  std::size_t seen = 0;
  for (const auto &entry : s.bodies) {
    for (const std::uint32_t id : entry.second.chunks) {
      if (id >= s.chunks.size() || roots[id] != entry.first.first ||
          slots[roots[id]] >= generations.size() ||
          generations[slots[roots[id]]] != entry.first.second ||
          s.chunks[id].shape->getActor() != entry.second.actor ||
          s.chunks[id].serial != entry.second.serial) {
        return false;
      }
      ++seen;
    }
  }
  return seen == s.chunks.size();
}

} // namespace vibe_land::physx_bridge
