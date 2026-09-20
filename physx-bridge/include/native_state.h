#pragma once

// Shared internals of NativeDestruction. Included only by the two native .cc
// files; physx_bridge.cc sees the class through native_destruction.h alone.

#include "native_destruction.h"
#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "PxPhysicsAPI.h"
#include "PxDestructionScene.h"
#include "cuda.h"

#include <cstdint>
#include <map>
#include <set>
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
  void sample_bond_verdicts(const physx::PxDestructionDeviceView &view);
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
