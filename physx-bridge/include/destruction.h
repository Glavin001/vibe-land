#pragma once

#include "rust/cxx.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace physx {
class PxMaterial;
class PxPhysics;
class PxRigidDynamic;
class PxScene;
class PxShape;
} // namespace physx

namespace Nv {
namespace Blast {
class ExtStressPhysXDestructible;
}
} // namespace Nv

namespace vibe_land::physx_bridge {

struct FfiVec3;
struct FfiPose;
struct FfiDestructibleSettings;
struct FfiChunkNodeDesc;
struct FfiChunkBondDesc;
struct FfiBrokenBondEvent;
struct FfiChunkMigrationEvent;
struct FfiIslandBodyEvent;
struct FfiChunkBodySnapshot;
struct FfiDestructionStats;

/// Owns ExtStressPhysXDestructible slots for one PxScene / World.
/// Fixed pool that runs one indexed task across several threads and blocks
/// until every index is done.
///
/// Exists for the stress solve: `solveTick` is pure computation over one
/// structure's own graph, so 16 structures can solve concurrently, while
/// `beginTick` (contact/gravity injection) and `endTick` (fracture, PhysX
/// actor edits) mutate shared state and stay serial. Mirrors the upstream
/// demo's StressExecutor. Worker exceptions are captured and rethrown on the
/// calling thread so a solver failure still surfaces as a hard error.
class StressExecutor final {
public:
  explicit StressExecutor(unsigned workers);
  ~StressExecutor();

  StressExecutor(const StressExecutor &) = delete;
  StressExecutor &operator=(const StressExecutor &) = delete;

  /// Number of threads doing work, including the calling thread.
  unsigned parallelism() const {
    return static_cast<unsigned>(threads_.size()) + 1;
  }

  void run(std::size_t count, const std::function<void(std::size_t)> &task);

private:
  void drain();

  std::vector<std::thread> threads_;
  std::mutex mutex_;
  std::condition_variable start_;
  std::condition_variable done_;
  const std::function<void(std::size_t)> *task_ = nullptr;
  std::size_t count_ = 0;
  std::atomic<std::size_t> next_{0};
  std::size_t active_ = 0;
  std::uint64_t generation_ = 0;
  bool stop_ = false;
  std::exception_ptr error_;
};

class DestructionManager final {
public:
  DestructionManager(physx::PxPhysics &physics, physx::PxScene &scene,
                     physx::PxMaterial &material,
                     float contact_report_threshold);
  ~DestructionManager();

  DestructionManager(const DestructionManager &) = delete;
  DestructionManager &operator=(const DestructionManager &) = delete;

  void create_destructible(std::uint32_t structure_id, const FfiPose &pose,
                           rust::Slice<const FfiChunkNodeDesc> nodes,
                           rust::Slice<const FfiChunkBondDesc> bonds,
                           const FfiDestructibleSettings &settings,
                           std::uint32_t collision_group,
                           std::uint32_t collision_mask);

  void destruction_tick(float dt, FfiVec3 gravity);

  void queue_chunk_damage(std::uint32_t structure_id, std::uint32_t chunk_id,
                          FfiVec3 impulse, FfiVec3 point);

  std::uint32_t apply_destruction_explosion(FfiVec3 center, float radius,
                                            float impulse_magnitude);

  /// Rocket-style hit: directed stress contacts at the impact point (to break
  /// bonds) plus PhysX impulses on nearby dynamic debris (to push them).
  /// `direction` should be the unit shot direction (into the surface).
  std::uint32_t apply_destruction_blast(FfiVec3 center, FfiVec3 direction,
                                        float radius, float stress_impulse,
                                        float push_impulse);

  /// Route a PhysX contact pair into the owning destructible(s).
  void route_contact_shape(physx::PxShape *shape, FfiVec3 position,
                           FfiVec3 impulse);

  rust::Vec<FfiBrokenBondEvent> take_broken_bonds();
  rust::Vec<FfiChunkMigrationEvent> take_chunk_migrations();
  rust::Vec<FfiIslandBodyEvent> take_island_events();
  rust::Vec<FfiChunkBodySnapshot> chunk_body_snapshots() const;

  void sleep_chunk_body(std::uint32_t entity_id);
  FfiDestructionStats destruction_stats() const;
  bool validate_destruction_mappings() const;

private:
  struct Slot;

  Slot *find_slot(std::uint32_t structure_id);
  const Slot *find_slot(std::uint32_t structure_id) const;
  void register_filters(Slot &slot);
  /// Single GPU->CPU readback of body and shape state for one structure.
  void refresh_snapshots(Slot &slot) const;
  void collect_events(Slot &slot);

  physx::PxPhysics &physics_;
  physx::PxScene &scene_;
  physx::PxMaterial &material_;
  float contact_report_threshold_;
  /// Whether chunk bodies report contacts at all (VIBE_CITY_CHUNK_CONTACT_REPORTS).
  bool chunk_contact_reports_ =
      std::getenv("VIBE_CITY_CHUNK_CONTACT_REPORTS") == nullptr
      || std::string(std::getenv("VIBE_CITY_CHUNK_CONTACT_REPORTS")) != "0";

  std::vector<std::unique_ptr<Slot>> slots_;
  std::unique_ptr<StressExecutor> stress_executor_;
  /// Live structures for the current tick; a member so the per-tick gather
  /// does not reallocate, and so the parallel phase can index it.
  std::vector<Slot *> live_slots_;
  std::unordered_map<const physx::PxShape *, std::pair<std::uint32_t, std::uint32_t>>
      shape_owners_; // shape -> (structure_id, node_index)

  /// Last entity id stamped onto each body / shape. Re-stamping identical
  /// data wakes a sleeping PhysX actor, so only changes are written.
  std::unordered_map<const physx::PxRigidDynamic *, std::uint32_t> body_entity_stamp_;
  std::unordered_map<const physx::PxShape *, std::uint32_t> shape_entity_stamp_;

  std::vector<FfiBrokenBondEvent> broken_bonds_;
  std::vector<FfiChunkMigrationEvent> migrations_;
  std::vector<FfiIslandBodyEvent> island_events_;

  std::uint32_t total_broken_bonds_ = 0;
  float last_stress_solve_ms_ = 0.0f;
  /// Per-phase breakdown of destruction_tick.
  float last_solve_ms_ = 0.0f;
  float last_readback_ms_ = 0.0f;
  float last_events_ms_ = 0.0f;
  float last_filters_ms_ = 0.0f;
  /// Dynamic bodies dropped from snapshots because they had no island serial.
  /// Non-zero means the serial tables and the adapter's live bodies disagree.
  mutable std::uint32_t unmapped_body_skips_ = 0;
};

} // namespace vibe_land::physx_bridge
