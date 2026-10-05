#pragma once

// Shared internals of NativeDestruction. Included only by the two native .cc
// files; physx_bridge.cc sees the class through native_destruction.h alone.

#include "native_destruction.h"
#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "PxPhysicsAPI.h"
#include "PxDestructionScene.h"
#include "cuda.h"

#include <cstdint>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>
#include <stdexcept>
#include <string>
#include <vector>

namespace vibe_land::physx_bridge {

inline void native_require(bool ok, const char *message) {
  if (!ok) {
    throw std::runtime_error(message);
  }
}

inline physx::PxVec3 native_px(const FfiVec3 &v) { return {v.x, v.y, v.z}; }
inline FfiVec3 native_ffi(const physx::PxVec3 &v) { return {v.x, v.y, v.z}; }
inline FfiQuat native_ffi(const physx::PxQuat &q) {
  return {q.x, q.y, q.z, q.w};
}

/// Chunk and bond ids on the wire, mirroring `destruction/src/ids.rs`.
/// `native_gameplay.rs` asserts these agree with the Rust functions; the two
/// must move together or a break event renames which bond it refers to.
inline std::uint32_t native_chunk_id(std::uint32_t structure,
                                     std::uint32_t node) {
  return (structure << 16) | node;
}
inline std::uint32_t native_bond_id(std::uint32_t structure,
                                    std::uint32_t bond) {
  return (structure << 20) | bond;
}

/// One live body as the network sees it, keyed by the GPU's own identity.
///
/// Keyed by (root, generation) and never by actor pointer: the engine recycles
/// fragment actors, so a pointer can outlive its body and come back naming a
/// different one. Root plus generation is the pair the stage guarantees unique
/// for the life of a cluster.
struct NativeBody {
  physx::PxRigidDynamic *actor = nullptr;
  std::uint32_t structure = 0;
  std::uint32_t serial = 0;
  std::vector<std::uint32_t> chunks;
  /// Last published sleep state, so a tick can report sleep/wake *edges*
  /// rather than a level. The wire treats a settle as terminal, so a body that
  /// moves again has to be announced or the client keeps drawing it parked.
  bool sleeping = false;
  /// Consecutive ticks this body has been barely moving. PhysX's own sleep
  /// test never fires for a chunk in a deep rubble pile: contact solving is
  /// iterative, so the pile keeps a residual jitter above the sleep threshold
  /// forever, and the body simulates for the rest of the match.
  std::uint32_t quiet_ticks = 0;
  /// The row published last tick, re-emitted while the body stays asleep.
  /// A sleeper has not moved and nothing downstream reads a sleeper's pose
  /// (the host skips sleeping rows before they reach the wire), so re-reading
  /// seven actor properties for it every tick was pure cost: measured 5.4 ms
  /// a tick at 29k bodies, tracking TOTAL bodies while the awake count was
  /// two thirds of that. `has_snapshot` is false on a freshly rebuilt record,
  /// so a body whose chunks just changed is always read in full once.
  FfiChunkBodySnapshot last_snapshot{};
  bool has_snapshot = false;
  /// Where the body has been over the current rest window, and the means of
  /// the last three windows it was awake through; see
  /// `State::sleep_resting_islands`. Reset whenever the body sleeps, is
  /// kinematic, or its record is rebuilt (membership changed).
  struct RestTrack {
    physx::PxVec3 sum{0.0f};
    physx::PxVec4 quat_sum{0.0f};
    physx::PxVec3 lo{PX_MAX_F32};
    physx::PxVec3 hi{-PX_MAX_F32};
    physx::PxQuat first{physx::PxIdentity};
    float turn = 0.0f;
    std::uint32_t samples = 0;
    physx::PxVec3 means[3];
    physx::PxQuat quat_means[3];
    std::uint32_t windows = 0;
    /// No net motion over the last three windows, inside a small envelope.
    bool resting = false;
    /// Windows left before this body may be rest-slept again, after the
    /// engine woke it straight back up.
    std::uint32_t cooldown = 0;
    /// Tick it was last rest-slept, to tell an immediate re-wake.
    std::uint64_t slept_tick = 0;
  } rest;
  /// Hibernated by `State::hibernate_resting`: the stage holds it frozen in
  /// place as a kinematic body. It is published as a settled dynamic body,
  /// never as an anchored remnant. `frozen_bounds` is its world AABB, which
  /// cannot change while frozen and is what the frozen index files it under.
  bool frozen = false;
  physx::PxBounds3 frozen_bounds = physx::PxBounds3::empty();
  /// Rest windows left before a thawed body may freeze again.
  std::uint32_t freeze_cooldown = 0;
};

/// The rest test shared by rest sleep and hibernation (see
/// `State::close_rest_windows`): a body is at rest after three windows whose
/// means agree within the drift limits and whose motion stayed inside the
/// envelope.
constexpr std::uint32_t kRestWindowTicks = 120;
constexpr float kRestDriftM = 0.003f;
constexpr float kRestDriftRad = 0.3f * 3.14159265f / 180.0f;
constexpr float kRestEnvelopeM = 0.05f;
constexpr float kRestEnvelopeRad = 10.0f * 3.14159265f / 180.0f;
/// Bounds this far apart count as touching: PhysX's default contact offset.
constexpr float kRestContactMarginM = 0.02f;

/// Debris hibernation settings (VIBE_CITY_NATIVE_HIBERNATE; see
/// native_hibernation.cc). Off by default.
struct NativeHibernation {
  bool enabled = false;
  /// Thaw a frozen body when the velocity a mover would give it,
  /// v * m / (m + M), exceeds this (m/s). Below it, the frozen body sliding to
  /// a stop on friction would move less than about a centimetre:
  /// d = dv^2 / (2 mu g), and sqrt(2 * 0.5 * 9.81 * 0.01) = 0.31 m/s.
  float wake_dv = 0.31f;
};

/// The server's default: VIBE_CITY_NATIVE_HIBERNATE=1 opts in;
/// VIBE_CITY_NATIVE_HIBERNATE_WAKE_DV overrides `wake_dv`.
NativeHibernation native_hibernation_default();
bool hibernation_trace();

/// World AABBs of frozen bodies on a uniform grid, so a mover asks only the
/// cells it overlaps. Entries are body keys; a stale key (the body thawed or
/// was rebuilt) is skipped and dropped by the reader that finds it.
struct FrozenIndex {
  using Key = std::pair<std::uint32_t, std::uint64_t>;
  static constexpr float kCell = 2.0f;
  std::unordered_map<std::uint64_t, std::vector<Key>> cells;
  static std::int32_t cell_of(float v) {
    return static_cast<std::int32_t>(std::floor(v / kCell));
  }
  static std::uint64_t pack(std::int32_t x, std::int32_t y, std::int32_t z) {
    const auto u = [](std::int32_t v) {
      return static_cast<std::uint64_t>(static_cast<std::uint32_t>(v) & 0x1fffffu);
    };
    return (u(x) << 42) | (u(y) << 21) | u(z);
  }
  template <typename F> static void each_cell(const physx::PxBounds3 &b, F &&f) {
    for (std::int32_t x = cell_of(b.minimum.x); x <= cell_of(b.maximum.x); ++x)
      for (std::int32_t y = cell_of(b.minimum.y); y <= cell_of(b.maximum.y); ++y)
        for (std::int32_t z = cell_of(b.minimum.z); z <= cell_of(b.maximum.z); ++z)
          f(pack(x, y, z));
  }
  void insert(const Key &key, const physx::PxBounds3 &b) {
    each_cell(b, [&](std::uint64_t c) { cells[c].push_back(key); });
  }
  void remove(const Key &key, const physx::PxBounds3 &b) {
    each_cell(b, [&](std::uint64_t c) {
      auto it = cells.find(c);
      if (it == cells.end()) return;
      auto &v = it->second;
      v.erase(std::remove(v.begin(), v.end(), key), v.end());
      if (v.empty()) cells.erase(it);
    });
  }
  void clear() { cells.clear(); }
};

/// A shot in flight. Owned here rather than by `World`, because every body in
/// World's record table is published to clients: a round is a physics detail
/// of how a hit deposits its momentum, not an entity anyone should see.
struct NativeRound {
  physx::PxRigidDynamic *actor = nullptr;
  std::uint64_t expires_tick = 0;
};

struct NativeDestruction::State {
  physx::PxPhysics &physics;
  physx::PxScene &scene;
  physx::PxMaterial &material;

  bool configured = false;
  bool fibre_bending = true;
  bool degraded = false;
  std::uint64_t tick_index = 0;
  std::uint64_t observed_frame = 0;
  physx::PxDestructionStageStatus last{};

  struct Chunk {
    physx::PxShape *shape = nullptr;
    std::uint32_t structure = 0;
    std::uint32_t authored = 0;
    std::uint32_t serial = 0;
    std::uint32_t root = PX_INVALID_U32;
    std::uint64_t generation = 0;
  };

#if PX_DESTRUCTION_SCENE_VERSION >= 22
  struct VehicleBinding {
    physx::native::NativeVehicle *vehicle;
    std::uint32_t base, count;
    std::uint32_t wheel_mask=15, drive_mask=15;
    bool engine_connected=true;
    std::vector<std::uint32_t> wheels[4], drives[4], engines;
    /// Every hull at registration: its authored local pose and filter.
    /// Posed hulls move on the carrier; a migrated hull keeps its own frame
    /// and gets its authored filter back (see pose_vehicle_parts).
    struct Hull { physx::PxShape *shape; std::uint32_t part; physx::PxTransform rest; physx::PxFilterData filter; };
    std::vector<Hull> hulls;
    /// The last wheel commands submitted as chunk loads (forces, N / N m).
    struct WheelLoad { physx::PxVec3 suspension, tire, couple; bool submitted=false; };
    WheelLoad loads[4];
  };
  std::vector<VehicleBinding> vehicles;
  struct ExtraShape { physx::PxShape *shape; std::uint32_t chunk; };
  std::vector<ExtraShape> extra_shapes;
  std::vector<physx::PxDestructionStressConstraint> constraints;
  std::vector<physx::PxDestructionChunkLoad> loads;
  std::set<physx::PxRigidDynamic *> borrowed_parents;
#endif
  std::uint32_t append_materials(std::uint32_t structure, const FfiDestructibleSettings &settings);
  void append_bonds(std::uint32_t structure, std::uint32_t base,
      rust::Slice<const FfiChunkBondDesc> bonds, const FfiDestructibleSettings &settings, bool vehicle);

  std::vector<Chunk> chunks;
  std::vector<physx::PxRigidDynamic *> parents;
  std::vector<physx::PxDestructionStressChunk> nodes;
  std::vector<physx::PxDestructionChunkMassProperties> properties;
  std::vector<physx::PxDestructionStressBond> bonds;
  /// (structure, authored bond index) per stage bond, in stage order.
  std::vector<std::pair<std::uint32_t, std::uint32_t>> bond_ids;
  std::vector<physx::PxDestructionStressCluster> clusters;
  std::vector<physx::PxDestructionMaterial> materials;
  /// First stage material index per structure, so a bond's authored material
  /// resolves inside its own structure's table.
  std::map<std::uint32_t, std::uint32_t> material_base;
  std::map<std::uint32_t, std::uint32_t> next_serial;
  std::map<std::pair<std::uint32_t, std::uint64_t>, NativeBody> bodies;

  std::vector<NativeRound> rounds;
  std::uint32_t round_group = 0;
  std::uint32_t round_mask = 0;

  rust::Vec<FfiBrokenBondEvent> broken;
  rust::Vec<FfiChunkMigrationEvent> migrations;
  rust::Vec<FfiIslandBodyEvent> events;
  mutable std::vector<FfiChunkBodySnapshot> snapshots;

  // --- counters published as spans; every one is a real measurement --------
  std::uint32_t stress_islands = 0;
  std::uint32_t observed_chunks = 0;
  std::uint32_t observed_bonds = 0;
  std::uint64_t observation_bytes = 0;
  std::uint64_t broken_total = 0;
  std::uint64_t migration_total = 0;
  std::uint64_t splits = 0;
  std::uint64_t corrections_total = 0;
  std::uint64_t error_frames = 0;
  std::uint32_t error_bits_last = 0;
  std::uint64_t unconverged_frames = 0;
  std::uint64_t full_reobservations = 0;
  std::uint64_t missed_frames = 0;
  std::uint64_t rounds_fired = 0;
  std::uint64_t rounds_evicted = 0;
  std::uint32_t stress_iterations_peak = 0;
  std::uint64_t topology_changes = 0;
  std::uint64_t completed_updates = 0;
  std::uint64_t active_island_updates = 0;
  std::uint64_t crush_yield_nodes = 0;
  std::uint64_t resettled_wakes = 0;
  /// Debris taken out of the simulation: parked after leaving the world, and
  /// forced to sleep after staying quiet. Published so the lifecycle is
  /// visible rather than inferred from a falling body count.
  std::uint64_t debris_parked = 0;
  std::uint64_t debris_settled = 0;
  /// Island sleep for rubble at true rest (`sleep_resting_islands`): bodies
  /// put to sleep, clusters slept, clusters held awake by a moving member,
  /// and rest-slept bodies the engine woke again within a second.
  std::uint64_t rest_slept_bodies = 0;
  std::uint64_t rest_slept_clusters = 0;
  std::uint64_t rest_held_clusters = 0;
  std::uint64_t rest_rewakes = 0;

  // --- debris hibernation (native_hibernation.cc) ---------------------------
  NativeHibernation hibernation;
  /// Diagnostic (VIBE_CITY_NATIVE_HIBERNATE_TRACE): per closed rest window,
  /// the drift between window means and the envelope inside the window.
  std::vector<float> rest_drift_mm, rest_envelope_mm, rest_turn_deg;
  /// Whether the stage was configured with GPU island repair, which rules
  /// hibernation out (see configure).
  bool gpu_island_repair = false;
  FrozenIndex frozen_index;
  /// Bodies awake after the last refresh, for the pre-step thaw test.
  std::vector<std::pair<std::uint32_t, std::uint64_t>> awake_keys;
  std::uint32_t frozen_bodies = 0;
  std::uint64_t hibernate_froze = 0;
  /// Thaws by cause: a mover about to hit it (directly or along a chain), a
  /// moving body it rests on, a slow body pushing it, a query (shot, blast)
  /// near it, the stage changing its cluster, an explicit request.
  std::uint64_t thaw_approach = 0;
  std::uint64_t thaw_support = 0;
  std::uint64_t thaw_push = 0;
  std::uint64_t thaw_query = 0;
  std::uint64_t thaw_topology = 0;
  std::uint64_t thaw_request = 0;
  std::uint32_t thawed_last_step = 0;
  std::uint32_t thawed_max_step = 0;
  /// Wall time of the last freeze pass (a rest-window boundary) and of this
  /// step's pre-step thaw test.
  double hibernate_ms = 0.0;
  double thaw_ms = 0.0;
  /// Chunk index ranges that belong to destructible vehicles. A vehicle's
  /// bodies are never hibernated: a parked car must still drive.
  std::vector<std::pair<std::uint32_t, std::uint32_t>> vehicle_chunk_ranges;

  // --- sampled bond utilisation -------------------------------------------
  /// Per-bond verdicts are a whole-graph device read, so they are sampled on a
  /// cadence rather than every tick. The age is published beside the value:
  /// a utilisation number with no age cannot be told from a fresh one.
  std::uint32_t verdict_sample_interval = 60;
  std::uint32_t verdict_sample_age = 0;
  float bond_utilisation_max = 0.0f;
  std::uint32_t bonds_above_half = 0;
  std::uint32_t overstressed_bonds = 0;

  // --- timings (ms) --------------------------------------------------------
  double tick_ms = 0.0;
  double status_read_ms = 0.0;
  double observe_ms = 0.0;
  double snapshot_ms = 0.0;
  double rounds_ms = 0.0;
  double verdict_ms = 0.0;

  State(physx::PxPhysics &p, physx::PxScene &s, physx::PxMaterial &m)
      : physics(p), scene(s), material(m) {}

  physx::PxDestructionScene &stage() const {
    physx::PxDestructionScene *api = scene.getDestructionScene();
    native_require(api != nullptr, "native destruction stage unavailable");
    return *api;
  }

  void observe_topology(const physx::PxDestructionDeviceView &view);
  void rebuild_from_accepted_topology(
      const physx::PxDestructionDeviceView &view);
  /// Shared body of both observation paths: regroup the named chunks by the
  /// GPU's (root, generation) identity, assign or keep serials, and emit the
  /// promotions, migrations and retirements that follow.
  void apply_changed_chunks(
      const std::vector<physx::PxDestructionChangedChunk> &changed,
      std::uint32_t cluster_count, bool full);
  void refresh_snapshots();
  /// Put to sleep every cluster of touching awake chunk bodies in which no
  /// body has gone anywhere for several seconds. `awake` pairs each awake
  /// body with its row in `snapshots`.
  void sleep_resting_islands(
      std::vector<std::pair<NativeBody *, std::size_t>> &awake);
  /// Close the current rest window of every awake body and set its
  /// `rest.resting` verdict.
  void close_rest_windows(std::vector<std::pair<NativeBody *, std::size_t>> &awake);
  void sample_bond_verdicts(const physx::PxDestructionDeviceView &view);
  // Debris hibernation (native_hibernation.cc).
  /// At a rest-window boundary: close the windows of awake bodies, then
  /// freeze every eligible body at rest (engine-asleep or rest-tested).
  void hibernate_resting(std::vector<std::pair<NativeBody *, std::size_t>> &awake);
  /// Thaw the frozen bodies in `keys` through the stage. Returns how many.
  std::uint32_t thaw(const std::vector<std::pair<std::uint32_t, std::uint64_t>> &keys,
                     std::uint64_t &cause);
  bool hibernation_eligible(const NativeBody &body) const;
  /// Whether `body` rests only on static ground and frozen bodies (those in
  /// `frozen_now` count as frozen) and touches no anchored structure.
  bool rests_on_frozen_ground(const NativeBody &body,
                              const std::unordered_set<const physx::PxRigidActor *> &frozen_now) const;
  /// Whether the stage holds this actor hibernated (false before SDK v25).
  bool fragment_hibernated(const physx::PxRigidDynamic &actor) const;
  /// Drop a body's frozen bookkeeping because its record is going away;
  /// `by_stage` counts it as a topology thaw.
  void forget_frozen(const std::pair<std::uint32_t, std::uint64_t> &key, NativeBody &body,
                     bool by_stage);
  bool is_vehicle_chunk(std::uint32_t chunk) const;
  void expire_rounds();
  void release_rounds();
};

/// Scoped CPU read of stage device memory.
///
/// Acquires the scene's own CUDA context and orders the read behind the
/// stage's ready event. Explicitly a gameplay *observation*: nothing read here
/// decides a fracture, and the stage has already committed everything it
/// publishes by the time the event fires.
struct NativeReadback {
  physx::PxCudaContextManager &cuda;

  NativeReadback(physx::PxScene &scene, CUevent ready)
      : cuda(*scene.getCudaContextManager()) {
    cuda.acquireContext();
    if (ready != nullptr && cuEventSynchronize(ready) != CUDA_SUCCESS) {
      cuda.releaseContext();
      throw std::runtime_error("native destruction ready event failed");
    }
  }
  ~NativeReadback() { cuda.releaseContext(); }

  NativeReadback(const NativeReadback &) = delete;
  NativeReadback &operator=(const NativeReadback &) = delete;

  template <class T>
  std::vector<T> read(const T *pointer, std::size_t count) const {
    std::vector<T> out(count);
    native_require(count == 0 ||
                       (pointer != nullptr &&
                        cuMemcpyDtoH(out.data(),
                                     reinterpret_cast<CUdeviceptr>(pointer),
                                     count * sizeof(T)) == CUDA_SUCCESS),
                   "native destruction device read failed");
    return out;
  }
};

} // namespace vibe_land::physx_bridge
