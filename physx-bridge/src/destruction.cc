#include "destruction.h"

#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "NvBlastExtStressPhysX.h"
#include "PxPhysicsAPI.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace vibe_land::physx_bridge {
namespace {

using namespace physx;
using namespace Nv::Blast;

constexpr std::uint32_t kNsChunk = 0x8000'0000u;

/// Must match destruction/src/ids.rs body_entity: 6 bits of structure, 22 of
/// island serial. The serial is monotonic and never reused, so it is consumed
/// by cumulative body creation and a 16-bit field exhausts in a long session.
/// Reserved for a structure's intact kinematic support actor.
constexpr std::uint32_t kSupportIslandSerial = 0;

/// Intra-structure index fields, mirroring destruction/src/ids.rs
/// MAX_NODES_PER_STRUCTURE (1 << 16) and MAX_BONDS_PER_STRUCTURE (1 << 20).
constexpr std::uint32_t kNodeIndexMask = 0x0000'FFFFu;
constexpr std::uint32_t kBondIndexMask = 0x000F'FFFFu;

/// World pose of a body's centre-of-mass frame.
///
/// Bodies reach clients under one convention: the pose maps structure-rest
/// coordinates, minus the island's centre of mass, to world. That holds
/// trivially for actors the adapter creates for a split, which it positions at
/// their centre of mass -- but NOT for the one child per split that reuses the
/// parent PxRigidDynamic (NvBlastExtStressPhysX.cpp:1080). That actor keeps the
/// parent's frame and takes its new centre of mass as a *local* offset via
/// setCMassLocalPose (:1348), so its globalPose is still wherever the parent
/// was -- for a severed upper half, the structure origin at ground level.
///
/// Emitting globalPose raw for that body draws every one of its chunks one
/// centre-of-mass height too low, and makes them orbit the origin as the body
/// tumbles about its centre of mass. Composing the local centre of mass in
/// normalises both cases: it is a no-op for a created actor whose centre of
/// mass is already at its origin.
inline physx::PxVec3 com_world_position(const ExtStressPhysXBodySnapshot &body) {
  return body.globalPose.transform(body.centerOfMassLocalPose.p);
}

std::uint32_t pack_body_entity(std::uint32_t structure_id, std::uint32_t serial) {
  return kNsChunk | (structure_id << 22) | (serial & 0x003F'FFFFu);
}

// Field widths must mirror destruction/src/ids.rs exactly: 16 bits of node,
// 20 bits of bond. They were widened there (a district pack is 15,918 nodes, a
// downtown 74,543 bonds) and this side was missed, so every id crossing the FFI
// was packed into the old 12/16-bit fields. Latent only because production runs
// a single structure, where the shift is a no-op; at grid > 1 the two sides
// disagree about which structure a chunk or bond belongs to.
std::uint32_t pack_chunk_id(std::uint32_t structure_id, std::uint32_t node_index) {
  return (structure_id << 16) | (node_index & kNodeIndexMask);
}

std::uint32_t pack_bond_id(std::uint32_t structure_id, std::uint32_t bond_index) {
  return (structure_id << 20) | (bond_index & kBondIndexMask);
}

void tag_actor(PxActor &actor, std::uint32_t entity_id) {
  actor.userData =
      reinterpret_cast<void *>(static_cast<std::uintptr_t>(entity_id) + 1);
}

void configure_shape(PxShape &shape, std::uint32_t entity_id,
                     std::uint32_t group, std::uint32_t mask) {
  shape.setSimulationFilterData(PxFilterData(group, mask, entity_id, 0));
  shape.setQueryFilterData(PxFilterData(group, entity_id, 0, 0));
}

PxVec3 to_px(const FfiVec3 &v) { return PxVec3(v.x, v.y, v.z); }

FfiVec3 from_px(const PxVec3 &v) { return FfiVec3{v.x, v.y, v.z}; }

FfiQuat from_px(const PxQuat &q) { return FfiQuat{q.x, q.y, q.z, q.w}; }

PxTransform to_px(const FfiPose &pose) {
  return PxTransform(to_px(pose.position),
                     PxQuat(pose.rotation.x, pose.rotation.y, pose.rotation.z,
                            pose.rotation.w));
}

void require(bool ok, const char *message) {
  if (!ok) {
    throw std::runtime_error(message);
  }
}

void adapter_error(ExtStressPhysXError error, std::uint32_t node,
                   const char *message, void *) {
  std::fprintf(stderr, "[StressPhysX:%u node=%u] %s\n",
               static_cast<unsigned>(error), node,
               message != nullptr ? message : "");
}

} // namespace

/// VIBE_CITY_QUIET_SKIP=0 forces the event diff to run every tick, so the
/// quiet-tick optimisation can be ruled in or out as a source of stale body
/// identity.
/// VIBE_CITY_CCD=0 disables speculative CCD (A/B for settling behaviour).
bool speculative_ccd_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_CCD");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// VIBE_CITY_DEPEN_VELOCITY: max depenetration velocity; 0 = PhysX default.
///
/// 1.0 m/s, deliberately below the sleep threshold's ~2 m/s equivalent. A
/// depenetration correction is the solver fixing overlap that never
/// physically happened, and at 3.0 it ejected bodies fast enough to reset
/// sleep progress for their whole contact island -- the settle curve showed a
/// resting pile spiking to 5 m/s every few seconds and never sleeping.
/// Below the threshold, a correction can nudge but never counts as motion.
float depenetration_velocity() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_DEPEN_VELOCITY")) {
      return static_cast<float>(std::atof(raw));
    }
    return 1.0f;
  }();
  return value;
}

/// VIBE_CITY_SNAPSHOT_BEGIN=0 falls back to the PhysX-reading beginTick.
///
/// On by default. Verified equivalent on the severed-tower test (4686-5014
/// broken bonds against 4465-4475 for the original path -- inside the GPU's
/// own ~12% run-to-run band) and crash-free where the old parallel beginTick
/// segfaulted: the full e2e suite at 7600 islands with the process alive at
/// the end.
bool snapshot_begin_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_SNAPSHOT_BEGIN");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

bool quiet_skip_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_QUIET_SKIP");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// Per-body contact-report threshold as a multiple of the body's own resting
/// weight (`ratio * m * g`), or 0 to keep the flat scene-wide value.
///
/// MEASURED AND REFUTED (2026-08-27, scripts/contact-threshold-experiment.sh).
/// Three arms, identical scripted input, suite green in all three:
///
///   unset   dsim  0.00 ms   floaters 2
///   k=0.5   dsim +2.27 ms   floaters 2
///   k=2     dsim -0.14 ms   floaters 5
///
/// Nothing to win. The premise came from a CONFOUNDED A/B: disabling reports
/// wholesale (VIBE_CITY_CHUNK_CONTACT_REPORTS=0) looked like ~6 ms, but it
/// also removes stress injection, so that run broke 21% fewer bonds and was
/// simulating a materially different (less damaged) city. With the physics
/// held fixed -- bond band 0.4-0.5% here -- the report path is not the cost.
///
/// The reason is in the scene filter's own comment: a SLEEPING pair generates
/// no narrowphase at all, so a settled pile already costs nothing, and during
/// a live collapse the contacts genuinely exceed any threshold, so nothing is
/// suppressed. Raising thresholds only skips the callback for touches that
/// were cheap either way -- and at k=2 it starts starving support discovery
/// (floaters 2 -> 5), which is the coupling this was warned about.
///
/// Kept off-by-default and documented rather than deleted, so the next person
/// who has this idea can read the numbers instead of re-running the week.
float contact_report_mass_ratio() {
  static const float ratio = [] {
    if (const char *raw = std::getenv("VIBE_CITY_CONTACT_REPORT_MASS_RATIO")) {
      const float parsed = static_cast<float>(std::atof(raw));
      if (parsed > 0.0f) {
        return parsed;
      }
    }
    return 0.0f;
  }();
  return ratio;
}

/// The threshold a chunk body of this mass should carry. `flat` (the
/// scene-wide value) is returned unchanged when the experiment is off, and is
/// also the FLOOR when it is on: a featherweight shard must not end up with a
/// threshold so low that it reports noise the flat value already suppressed.
float chunk_contact_report_threshold(float mass, float flat) {
  const float ratio = contact_report_mass_ratio();
  if (ratio <= 0.0f || !(mass > 0.0f)) {
    return flat;
  }
  // Duplicated rather than calling world_gravity(), which is defined in a
  // later translation-unit-local namespace; kept in sync by reading the same
  // env with the same default.
  static const float gravity = [] {
    if (const char *raw = std::getenv("VIBE_WORLD_GRAVITY")) {
      const float parsed = static_cast<float>(std::fabs(std::atof(raw)));
      if (parsed > 0.0f) {
        return parsed;
      }
    }
    return 20.0f;
  }();
  return std::max(flat, ratio * mass * gravity);
}

/// P1b: cluster frozen bodies into spatial-cell PxAggregates. OPT-IN
/// (VIBE_CITY_FREEZE_AGGREGATE=1), because the matched-load A/B refuted the
/// premise: in the settled tail (awake<500, frozen 1500-2000) aggregation
/// MEASURED 3.9 ms SLOWER per tick than standalone actors (7.88 vs 4.03 ms
/// medians over ~6k ticks, identical scripted input, fewer bonds broken on
/// the slow side) — the aggregate machinery costs more than the broadphase
/// entries it retires, at least at this occupancy and flip churn. The P1a
/// ceiling (2.3 ms at 1.7k frozen for full REMOVAL) is real, but PxAggregate
/// is not the mechanism that captures it. Kept behind the flag for future
/// experiments (hysteresis, larger cells, higher occupancy).
bool freeze_aggregate_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_FREEZE_AGGREGATE");
    return value != nullptr && std::string(value) == "1";
  }();
  return enabled;
}

/// XZ cell edge for the frozen clusters, metres. ~2x the largest chunk reach
/// so a pile spans few cells; piles are ground-level so Y does not partition.
float freeze_aggregate_cell_m() {
  static const float cell = [] {
    if (const char *raw = std::getenv("VIBE_CITY_FREEZE_AGG_CELL_M")) {
      const float parsed = static_cast<float>(std::atof(raw));
      if (parsed > 0.5f) {
        return parsed;
      }
    }
    return 8.0f;
  }();
  return cell;
}

/// Per-aggregate capacity. 128 actors is the classic broadphase cluster cap;
/// the shape bound exists because an island body carries one shape per chunk
/// and the GPU sizes aggregate bounds work off shape counts.
constexpr std::uint32_t kFrozenAggMaxActors = 128;
constexpr std::uint32_t kFrozenAggMaxShapes = 1024;
/// Parked-empty aggregates kept for reuse before releasing outright.
constexpr std::size_t kFrozenAggPoolCap = 32;

/// MEASUREMENT ONLY, default off: remove frozen bodies from the PxScene
/// entirely instead of leaving them as kinematic actors holding broadphase
/// entries. Exists to price the ceiling of any frozen-body population
/// optimisation (P1a): run matched traces with and without it and the
/// dynamics_ms delta is the most any clustering scheme could recover.
///
/// NEVER deploy with this set. A removed body has no contacts, so the
/// contact-wake release path cannot fire and players fall through frozen
/// piles — correctness is knowingly sacrificed for the measurement.
bool freeze_remove_from_scene() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_FREEZE_REMOVE_FROM_SCENE");
    return value != nullptr && std::string(value) == "1";
  }();
  return enabled;
}

#if defined(NVBLAST_ENABLE_CUDA_STRESS)
/// Whether to request the CUDA stress solver (VIBE_CITY_GPU_STRESS=0 disables).
///
/// On by default when compiled in: the GPU path was verified to converge to the
/// same solution as the CPU path, and it is the only one that can afford to
/// reach convergence at all. See the note on gpu_stress_min_bonds().
bool gpu_stress_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_GPU_STRESS");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// Bond-count crossover below which a structure stays on the CPU solver.
///
/// The GPU solve is not less accurate than the CPU one -- it is more converged.
/// Sweeping iterations on the 10-floor city with identical input, both solvers
/// descend monotonically to the SAME answer:
///
///   iterations      CPU bonds   GPU bonds
///            8           5149           -
///        32-44           4096        1901
///          150           3156        1150
///          400           1073        1246
///
/// So ~1100-1250 broken bonds is what this structure actually does under load,
/// and the 5149 our CPU default produced was solver residual, not physics. The
/// CPU cannot afford convergence (solve goes 5.95 -> 60+ ms); the GPU reaches
/// it in ~3 ms. That is the real argument for the GPU path.
///
/// Consequence for content: destruction scale must come from material strength,
/// not from under-solving. VIBE_CITY_STRESS_LIMIT_SCALE=0.5 restores it with
/// converged physics and zero spontaneous damage on the intact city.
std::uint32_t gpu_stress_min_bonds() {
  static const std::uint32_t bonds = [] {
    if (const char *value = std::getenv("VIBE_CITY_GPU_STRESS_MIN_BONDS")) {
      const long parsed = std::strtol(value, nullptr, 10);
      if (parsed >= 0) {
        return static_cast<std::uint32_t>(parsed);
      }
    }
    // 0 = every structure solves on the GPU. A non-zero crossover splits the
    // scene across two solvers that do NOT agree at a shared iteration budget,
    // so neighbouring towers in one city fracture by different physics --
    // measured 6-of-16 on GPU giving 4855 broken bonds against 821 with all 16
    // on GPU, same scene, same settings. Uniformity matters more than winning
    // a few microseconds on the smallest graphs.
    return 0u;
  }();
  return bonds;
}
#endif

struct DestructionManager::Slot {
  std::uint32_t structure_id = 0;
  ExtStressPhysXDestructible *dest = nullptr;
  std::uint32_t next_island_serial = 1;
  std::uint32_t collision_group = 0;
  std::uint32_t collision_mask = 0;

  // Owned geometry storage so create() pointers stay valid.
  std::vector<std::vector<PxVec3>> convex_storage;
  std::vector<ExtStressPhysXNodeDesc> node_descs;
  std::vector<ExtStressPhysXBondDesc> bond_descs;
  /// Reused per-tick scratch for the bond-utilisation sample; sized once so
  /// the sampling pass allocates nothing.
  std::vector<float> bond_utilisation;

  // One GPU->CPU readback per tick, shared by every consumer.
  //
  // With GPU rigid bodies, each per-actor pose read is a device readback. We
  // were doing four body passes and two shape passes per structure per tick
  // (collect_events, register_filters, and chunk_body_snapshots twice from
  // Rust), which is the per-actor pattern the Direct GPU API exists to avoid.
  std::vector<ExtStressPhysXBodySnapshot> body_cache;
  std::vector<ExtStressPhysXShapeSnapshot> shape_cache;
  std::uint32_t body_cache_count = 0;
  std::uint32_t shape_cache_count = 0;
  /// Non-kinematic sleeping bodies as of the last readback, tallied during it.
  /// Mutable for the same reason the caches are: refresh_snapshots is const.
  mutable std::uint32_t sleeping_body_count = 0;
  /// Whether body_cache came back ascending by bodyId. The adapter documents
  /// that it does, and the duplicate-detection walk below already relies on
  /// it, but resolve_support_loads now BINARY SEARCHES on that basis -- so the
  /// invariant is checked rather than assumed, and a violation degrades to the
  /// linear path instead of silently losing supporter edges.
  mutable bool body_cache_sorted = true;

  /// Bodies we have made kinematic to retire them from the solver.
  ///
  /// Keyed by bodyId, never by PxRigidDynamic*: the adapter recycles actors,
  /// so a pointer can outlive the body it belonged to and come back pointing
  /// at a different one. Membership is pruned wherever the adapter can change
  /// a body behind our back -- retirement, and the split path that sets a body
  /// dynamic again.
  std::unordered_set<ExtStressPhysXId> frozen;
  /// Bodies the ADAPTER holds kinematic because they still contain a
  /// world-anchored (zero-mass) node: the intact support actor and every
  /// ground-rooted fragment ("stump") that fracture leaves standing. Distinct
  /// from `frozen` (ours): a rooted body's kinematic-ness belongs to the
  /// adapter, and freeze/unfreeze must never touch it -- releasing a stump
  /// would drop a standing building. Maintained wherever the adapter flips
  /// bodies: create seeding, first-seen kinematics, became-dynamic, retire.
  std::unordered_set<ExtStressPhysXId> rooted;

  // Tracking for event diffs.
  std::unordered_map<ExtStressPhysXId, std::uint32_t> body_to_serial;
  std::unordered_map<std::uint32_t, ExtStressPhysXId> node_to_body; // node -> bodyId
  std::unordered_map<std::uint32_t, std::uint32_t> node_to_serial;
  std::vector<std::uint8_t> bond_alive; // 1 = alive

  /// Bodies the snapshot-fed begin phase wants woken. wakeUp() is a scene
  /// write, so that phase records ids here and the caller applies them
  /// serially. Overflow is counted, not silently dropped.
  std::vector<ExtStressPhysXId> wake_bodies = std::vector<ExtStressPhysXId>(256);
  std::uint32_t wake_count = 0;

  // Topology counters as of the last diff. The adapter only mutates topology
  // inside endTick, and only when bonds were overstressed, so when these are
  // unchanged the whole diff is provably a no-op and is skipped.
  std::uint64_t last_splits = 0;
  std::uint64_t last_bodies_created = 0;
  std::uint64_t last_shapes_migrated = 0;
  std::uint64_t last_bodies_recycled = 0;
  bool topology_primed = false;
  // The adapter's gpuStressSolveMilliseconds is cumulative since the
  // destructible was created -- it is only ever `+=`d and never reset. Every
  // other timing in DestructionStats is the cost of one tick, so the raw value
  // reported alongside them read as a single 3,207 ms solve. Keep the previous
  // total here and report the delta.
  double last_gpu_stress_solve_ms = 0.0;
  /// The adapter's OTHER five phase timers, cumulative for the same reason and
  /// deltaed the same way. These decompose the three phases the bridge times
  /// from outside: contact-processing + gravity are what `begin_ms` is made
  /// of, `stressSolve` is the CPU side of `solve_ms` (the GPU side is
  /// gpuStressSolve), and fracture-topology + mapping-validation are what
  /// `end_ms` is made of.
  ///
  /// They were computed every tick and discarded. `solve_ms` measured 3-5 ms
  /// against a gpu_stress_solve of ~1.1 ms, so the largest single phase in the
  /// tick had 2-3.5 ms in it that nothing accounted for -- while the adapter
  /// was already measuring exactly that and throwing it away.
  double last_contact_processing_ms = 0.0;
  double last_gravity_ms = 0.0;
  double last_stress_solve_cpu_ms = 0.0;
  double last_fracture_topology_ms = 0.0;
  double last_mapping_validation_ms = 0.0;
  double last_fracture_generate_ms = 0.0;
  double last_fracture_prep_ms = 0.0;
  double last_fracture_apply_ms = 0.0;
  double last_fracture_scene_ms = 0.0;
  double last_fracture_rebuild_ms = 0.0;
};

DestructionManager::DestructionManager(PxPhysics &physics, PxScene &scene,
                                       PxMaterial &material,
                                       float contact_report_threshold)
    : physics_(physics), scene_(scene), material_(material),
      contact_report_threshold_(contact_report_threshold) {
  // Total parallelism for the stress solve, calling thread included.
  // VIBE_CITY_STRESS_WORKERS=1 forces the old fully-serial behaviour.
  unsigned workers = 8;
  if (const char *value = std::getenv("VIBE_CITY_BOND_SAMPLE_TICKS")) {
    const long parsed = std::strtol(value, nullptr, 10);
    if (parsed > 0) {
      bond_sample_interval_ = static_cast<std::uint32_t>(parsed);
    }
  }
  if (const char *value = std::getenv("VIBE_CITY_STRESS_WORKERS")) {
    const long parsed = std::strtol(value, nullptr, 10);
    if (parsed > 0 && parsed <= 64) {
      workers = static_cast<unsigned>(parsed);
    }
  }
  const unsigned hardware = std::thread::hardware_concurrency();
  if (hardware > 0) {
    workers = std::min(workers, hardware);
  }
  stress_executor_ = std::make_unique<StressExecutor>(workers);
}

DestructionManager::~DestructionManager() { clear_destructibles(); }

void DestructionManager::clear_destructibles() {
  // Frozen clusters first: extracting members back to standalone actors means
  // the adapter's own release below sees exactly the topology it created.
  // (PxActor::release would also auto-leave an aggregate, but the empty
  // aggregates themselves are ours to release.)
  frozen_aggregates_release_all();
  // Releasing a destructible releases the PhysX bodies, shapes and convex
  // meshes it created (under a scene write lock), so this leaves no orphaned
  // actors behind in the scene.
  for (auto &slot : slots_) {
    if (slot && slot->dest != nullptr) {
      slot->dest->release();
      slot->dest = nullptr;
    }
  }
  slots_.clear();
  live_slots_.clear();
  // Every one of these keys a released pointer or counts an event about bodies
  // that no longer exist. Leaving any of it behind would let a recycled
  // address inherit a dead body's identity, which is the id-aliasing class of
  // bug this code has been bitten by before.
  shape_owners_.clear();
  body_entity_stamp_.clear();
  shape_entity_stamp_.clear();
  ccd_enabled_.clear();
  body_snapshot_buffer_.clear();
  broken_bonds_.clear();
  migrations_.clear();
  island_events_.clear();
  quiet_slot_ticks_ = 0;
  serial_wraps_ = 0;
  wake_truncations_ = 0;
  repeated_body_snapshots_ = 0;
  aliased_body_entities_ = 0;
  support_promotions_ = 0;
  reused_parent_promotions_ = 0;
  max_island_serial_ = 0;
  total_broken_bonds_ = 0;
  last_stress_solve_ms_ = 0.0f;
  frozen_entities_.clear();
  contact_wake_pending_.clear();
  contact_wake_order_.clear();
  support_store_.clear();
  pending_pair_loads_.clear();
  staged_support_sets_.clear();
  staged_support_rows_.clear();
  support_edges_total_ = 0;
}

DestructionManager::Slot *
DestructionManager::find_slot(std::uint32_t structure_id) {
  for (auto &slot : slots_) {
    if (slot && slot->structure_id == structure_id) {
      return slot.get();
    }
  }
  return nullptr;
}

const DestructionManager::Slot *
DestructionManager::find_slot(std::uint32_t structure_id) const {
  for (const auto &slot : slots_) {
    if (slot && slot->structure_id == structure_id) {
      return slot.get();
    }
  }
  return nullptr;
}

void DestructionManager::create_destructible(
    std::uint32_t structure_id, const FfiPose &pose,
    rust::Slice<const FfiChunkNodeDesc> nodes,
    rust::Slice<const FfiChunkBondDesc> bonds,
    const FfiDestructibleSettings &settings, std::uint32_t collision_group,
    std::uint32_t collision_mask) {
  require(find_slot(structure_id) == nullptr, "structure already registered");
  require(nodes.size() > 0, "destructible requires nodes");
  require(bonds.size() > 0, "destructible requires bonds");

  auto slot = std::make_unique<Slot>();
  slot->structure_id = structure_id;
  slot->collision_group = collision_group;
  slot->collision_mask = collision_mask;
  slot->convex_storage.resize(nodes.size());
  slot->node_descs.resize(nodes.size());
  slot->bond_descs.resize(bonds.size());
  slot->bond_alive.assign(bonds.size(), 1);

  for (std::size_t i = 0; i < nodes.size(); ++i) {
    const FfiChunkNodeDesc &src = nodes[i];
    ExtStressPhysXNodeDesc &dst = slot->node_descs[i];
    dst.centroid = to_px(src.centroid);
    dst.mass = src.mass;
    dst.volume = src.volume > 0.0f ? src.volume : 1.0f;
    dst.geometry.localPose = PxTransform(dst.centroid);
    if (src.geom_kind == 1) {
      dst.geometry.type = ExtStressPhysXGeometryType::Convex;
      auto &storage = slot->convex_storage[i];
      storage.reserve(src.convex_points.size());
      for (const FfiVec3 &p : src.convex_points) {
        storage.push_back(to_px(p));
      }
      require(!storage.empty(), "convex node requires points");
      dst.geometry.convexPoints = storage.data();
      dst.geometry.convexPointCount = static_cast<std::uint32_t>(storage.size());
      dst.geometry.halfExtents = PxVec3(0.5f);
    } else {
      dst.geometry.type = ExtStressPhysXGeometryType::Cuboid;
      dst.geometry.halfExtents = to_px(src.half_extents);
      require(dst.geometry.halfExtents.x > 0.0f &&
                  dst.geometry.halfExtents.y > 0.0f &&
                  dst.geometry.halfExtents.z > 0.0f,
              "cuboid half extents must be positive");
    }
  }

  for (std::size_t i = 0; i < bonds.size(); ++i) {
    const FfiChunkBondDesc &src = bonds[i];
    ExtStressPhysXBondDesc &dst = slot->bond_descs[i];
    dst.centroid = to_px(src.centroid);
    dst.normal = to_px(src.normal);
    if (dst.normal.magnitudeSquared() < 1.0e-8f) {
      dst.normal = PxVec3(0.0f, 1.0f, 0.0f);
    } else {
      dst.normal.normalize();
    }
    dst.area = src.area > 0.0f ? src.area : 1.0f;
    dst.node0 = src.node0;
    dst.node1 = src.node1;
    dst.material = src.material;
    require(dst.material < settings.materials.size(),
            "bond material index out of range");
    require(dst.node0 < nodes.size() && dst.node1 < nodes.size(),
            "bond node index out of range");
  }

  ExtStressPhysXDesc desc;
  desc.physics = &physics_;
  desc.cooking = nullptr;
  desc.scene = &scene_;
  desc.material = &material_;
  desc.nodes = slot->node_descs.data();
  desc.nodeCount = static_cast<std::uint32_t>(slot->node_descs.size());
  desc.bonds = slot->bond_descs.data();
  desc.bondCount = static_cast<std::uint32_t>(slot->bond_descs.size());
  desc.worldTransform = to_px(pose);
  desc.settings.maxSolverIterationsPerFrame =
      settings.max_solver_iterations_per_frame;
  desc.settings.graphReductionLevel = settings.graph_reduction_level;
  // VIBE_CITY_ISLAND_AWARE=0 forces the CPU solver to treat the whole graph as
  // one system, which is what the GPU path does. Used to test whether global
  // versus per-island conjugate gradient explains the CPU/GPU divergence.
  desc.settings.islandAware = [] {
    const char *value = std::getenv("VIBE_CITY_ISLAND_AWARE");
    return value == nullptr || std::string(value) != "0";
  }();
  // VIBE_CITY_SKIP_SETTLED=0 forces every island to be re-solved each tick.
  // Skipping freezes an island's impulses; if they froze while still
  // under-converged, that stale (inflated) stress keeps breaking bonds.
  desc.settings.skipSettledIslands = [] {
    const char *value = std::getenv("VIBE_CITY_SKIP_SETTLED");
    return value == nullptr || std::string(value) != "0";
  }();
#if defined(NVBLAST_ENABLE_CUDA_STRESS)
  // The CUDA solver borrows PhysX's own CUDA context (the adapter fetches it
  // from the scene), runs on a private non-blocking stream and replays a
  // captured CUDA graph, so it shares the GPU with rigid-body simulation
  // without a second context. Sleeping is unaffected.
  //
  // The crossover is latency vs throughput: each GPU solve pays a fixed
  // upload/launch/sync cost per structure per frame, so small graphs are
  // genuinely faster in cache on the CPU. It is re-evaluated per structure on
  // every fracture resync, so a structure migrates back to the CPU as its
  // graph shrinks. Upstream defaults to 4096 bonds, which is above our
  // 10-floor structures (3624), so they would all silently stay on CPU.
  // Creation-time body protection and injection bounds. The library applies
  // these at createBody, which is the only site covering a split child's FIRST
  // step -- the bridge's own per-tick walk provably missed it (see the
  // kill-floor story). The walk below is now redundant belt-and-braces and can
  // be retired once the scenario gate shows escaped_bodies_parked at 0.
  // VIBE_CITY_SKIP_STABLE_UNCONVERGED=0 restores the converged-only skip.
  desc.settings.skipStableUnconverged = [] {
    const char *raw = std::getenv("VIBE_CITY_SKIP_STABLE_UNCONVERGED");
    return raw == nullptr || std::string(raw) != "0";
  }();
  desc.settings.enableSpeculativeCcd = speculative_ccd_enabled();
  desc.settings.maxDepenetrationVelocity = depenetration_velocity();
  // "pos,vel" -- PhysX per-body solver iterations, engine default 4,1.
  {
    std::uint32_t pos = 4, vel = 1;
    if (const char *raw = std::getenv("VIBE_CITY_BODY_ITERATIONS")) {
      std::sscanf(raw, "%u,%u", &pos, &vel);
    }
    desc.settings.bodyPositionIterations = pos;
    desc.settings.bodyVelocityIterations = vel;
  }
  desc.settings.gpuStressSolver = gpu_stress_enabled();
  desc.settings.gpuStressMinimumBondCount = gpu_stress_min_bonds();
  // Converged stress means authored material strength is finally what decides
  // destruction -- and these packs were authored against an under-converged
  // solver, so at full strength they barely fracture (the e2e's "debris comes
  // to rest" check fails with peakAwake == 0). Warn once, rather than let a
  // silently indestructible city look like a bug somewhere else.
  static bool warned = false;
  if (!warned && gpu_stress_enabled()) {
    warned = true;
    std::fprintf(stderr,
                 "[destruction] CUDA stress solver active: stress is solved to "
                 "convergence, so scenes authored against the CPU solver need "
                 "weaker materials to fracture as before "
                 "(VIBE_CITY_STRESS_LIMIT_SCALE ~0.06-0.12).\n");
  }
#else
  desc.settings.gpuStressSolver = false;
#endif
  desc.settings.recordSplitContinuity = true;
  desc.settings.applyExcessForces = settings.apply_excess_forces;
  desc.settings.applyCentrifugal = settings.apply_centrifugal;
  desc.settings.excessForceScale = settings.excess_force_scale;
  desc.settings.maximumBodies = settings.maximum_bodies;
  desc.settings.maximumFracturesPerActorPerTick =
      settings.maximum_fractures_per_actor_per_tick;
  // Upstream removed protectSupportBonds, supportPeelMaxMass,
  // fatalizeImpactContactBonds and the per-body velocity caps (blast commit
  // 19245a62). Its contract is now "joint strength is authored: bond area =
  // geometry, material limits = strength; anything the solver says breaks,
  // breaks", so those knobs are no longer ours to set.
  //
  // Let the adapter settle its own bodies. Without this the debris from a
  // collapse never sleeps: 654 of 792 chunk bodies stayed awake indefinitely,
  // and the per-tick cost of simulating, snapshotting and encoding them pushed
  // the match loop to 21-29 ms against a 16.67 ms budget.
  desc.settings.baseStepSleep = true;
  desc.settings.settledLinearSpeed = 0.15f;
  desc.settings.settledAngularSpeed = 0.15f;
  desc.settings.idleSkip = true;
  // Keep a tiny peel impulse so new islands don't stick, but not the old 4 m/s
  // "inflate then collapse" puff that made shots look like overlapping chunks.
  desc.settings.linearDamping = settings.linear_damping;
  desc.settings.angularDamping = settings.angular_damping;
  desc.settings.minimumSeparationVelocity =
      settings.apply_excess_forces ? 0.35f : 0.0f;
  desc.errorCallback = adapter_error;

  // A structure is not made of one thing: the frame, its slabs, the facade
  // panels and the clips holding them on all fail at different loads, and the
  // pack authors that as a material table with each bond naming its entry.
  // Collapsing it to a single material makes everything fail at the same
  // threshold -- the facade stops shedding first, and footings authored two
  // orders of magnitude stronger than cladding become just as fragile.
  require(!settings.materials.empty(),
          "destructible requires at least one stress material");
  std::vector<ExtStressPhysXMaterial> stress_materials(settings.materials.size());
  for (std::size_t i = 0; i < settings.materials.size(); ++i) {
    const FfiStressMaterial &src = settings.materials[i];
    stress_materials[i].compressionElasticLimit = src.compression_elastic;
    stress_materials[i].compressionFatalLimit = src.compression_fatal;
    stress_materials[i].tensionElasticLimit = src.tension_elastic;
    stress_materials[i].tensionFatalLimit = src.tension_fatal;
    stress_materials[i].shearElasticLimit = src.shear_elastic;
    stress_materials[i].shearFatalLimit = src.shear_fatal;
  }
  desc.stressMaterials = stress_materials.data();
  desc.stressMaterialCount = static_cast<std::uint32_t>(stress_materials.size());

  ExtStressPhysXTelemetry failure;
  ExtStressPhysXDestructible *dest =
      ExtStressPhysXDestructible::create(desc, &failure);
  if (dest == nullptr) {
    throw std::runtime_error(
        "ExtStressPhysXDestructible::create failed; error=" +
        std::to_string(static_cast<unsigned>(failure.lastError)) + " node=" +
        std::to_string(failure.lastErrorNode));
  }
  slot->dest = dest;

  // Seed the intact support body as serial 0 before the first filter pass.
  // Serial 0 belongs to THIS body alone: rooted fragments that split off it
  // later get real serials (see register_filters), because "one kinematic
  // support actor per structure" stops being true after the first fracture
  // -- a wrecked downtown measured 153 rooted fragments, and aliasing them
  // all onto serial 0 made every one of them unaddressable.
  {
    std::vector<ExtStressPhysXBodySnapshot> bodies(slot->node_descs.size() + 4);
    const std::uint32_t body_count =
        dest->getBodySnapshots(bodies.data(), static_cast<std::uint32_t>(bodies.size()));
    for (std::uint32_t i = 0; i < body_count; ++i) {
      const auto &body = bodies[i];
      std::uint32_t serial = 0;
      if (!body.kinematic) {
        serial = next_serial(*slot);
      } else {
        slot->rooted.insert(body.bodyId);
      }
      slot->body_to_serial[body.bodyId] = serial;
    }
  }
  {
    std::vector<ExtStressPhysXShapeSnapshot> shapes(slot->node_descs.size());
    const std::uint32_t shape_count = dest->getShapeSnapshots(
        shapes.data(), static_cast<std::uint32_t>(shapes.size()));
    for (std::uint32_t i = 0; i < shape_count; ++i) {
      slot->node_to_body[shapes[i].nodeIndex] = shapes[i].bodyId;
      auto it = slot->body_to_serial.find(shapes[i].bodyId);
      if (it != slot->body_to_serial.end()) {
        slot->node_to_serial[shapes[i].nodeIndex] = it->second;
      }
    }
  }

  register_filters(*slot);
  slots_.push_back(std::move(slot));
}

/// Matches `ExtStressPhysXSettings::maximumLinearVelocity` set in
/// create_destructible, so externally-applied impulses obey the same bound the
/// adapter applies to its own bodies.
// No velocity caps. setMaxLinearVelocity is not physics -- it silently
// falsifies every fast trajectory (debris free-falling off a 30 m tower should
// pass 24 m/s; a 12 m/s cap forbade it). It existed to stop fast bodies
// tunnelling through the floor between 60 Hz steps; the principled mechanism
// for that is speculative CCD, which widens contact generation by the body's
// velocity and changes no trajectory that wasn't about to hit something.
/// Mass-normalised kinetic energy below which a chunk body may sleep
/// (0.5 * v^2, so ~0.32 m/s), and the stabilisation threshold that lets a
/// resting pile stop jittering.
///
/// This was briefly raised to 2.0 (~2 m/s) because rubble jittered above 0.05
/// and a demolished city never slept. That treated the symptom: the jitter
/// existed because fracture debris had no linear damping, and once damping was
/// added the pile settles at 0.05 anyway -- measured, 11 of 5209 bodies awake.
///
/// Raising it was also actively harmful. A body at the top of a ballistic arc
/// is momentarily slow, and at a 2 m/s threshold it spends 0.41 s under that
/// speed -- just past PhysX's 0.4 s wake counter. Debris thrown upward by an
/// impact therefore froze in mid-air. At 0.05 that window is 0.06 s and cannot
/// trigger. Sleep must only ever describe rest, never interrupt flight.
constexpr float kChunkSleepThreshold = 0.05f;

/// VIBE_CITY_SLEEP_THRESHOLD: mass-normalised kinetic energy below which a
/// chunk may sleep. This declares when a body counts as at rest; it does not
/// alter any trajectory, which is why it is a legitimate knob where a velocity
/// clamp was not.
float chunk_sleep_threshold() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_SLEEP_THRESHOLD")) {
      return static_cast<float>(std::atof(raw));
    }
    return kChunkSleepThreshold;
  }();
  return value;
}
/// Settle assist: after a small chunk has touched static ground once, raise
/// its damping and sleep threshold so a rubble pile stops trading
/// micro-contacts and actually goes to sleep.
///
/// This DOES alter trajectories, which is why it is off by default and judged
/// on video rather than on counters alone. It is deliberately not a
/// restitution change: world restitution is already 0.02 and the visible
/// bouncing is the solver's residual velocity floor plus depenetration, not
/// rebound.
///
/// MEASURED, and it corrected the design. On the settle_assist test's
/// toppled wall (deterministic: three runs, identical totals), in
/// awake-body-ticks -- the integral of awake count over the settle, which is
/// exactly the cost every awake body imposes on sim, callbacks and solve:
///
///   off                          2730
///   damping 1.0/2.0 only         3264   +20%  WORSE
///   sleep threshold x4 only      2572   -5.8% better
///   sleep x4 + damping 0.2/0.3   2627   -3.8% better
///
/// Damping made settling WORSE at every strength tried: a damped chunk creeps
/// to a halt instead of tumbling to one, so it spends longer above the sleep
/// threshold rather than less. The sleep threshold alone is the knob that
/// works. Damping therefore defaults to ZERO -- the knobs remain so the
/// finding can be re-tested, not because they are recommended.
///
/// The ground-touch gate is the safety argument. Raising a sleep threshold
/// alone once froze debris in mid-air (see kChunkSleepThreshold above): at a
/// high threshold a body spends longer under it than PhysX's 0.4 s wake
/// counter while still travelling. A body that has never touched static
/// geometry is never assisted, so flight is untouched by construction.
bool settle_assist_enabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("VIBE_CITY_SETTLE_ASSIST");
    return raw != nullptr && std::string(raw) != "0";
  }();
  return enabled;
}

/// Mass ceiling for "small debris", kilograms. Mass is the cheapest size
/// proxy available per body -- it already rides the snapshot row -- and at a
/// uniform 2400 kg/m^3 it is monotonic in volume. A 0.6 m cube is ~518 kg;
/// the median chunk in downtown is ~10 t. The default cleanly separates
/// loose debris from slabs, which must keep their exact settling behaviour.
float assist_max_mass() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_ASSIST_MAX_MASS")) {
      return static_cast<float>(std::atof(raw));
    }
    return 1500.0f;
  }();
  return value;
}

/// Zero by default: measured counterproductive (see settle_assist_enabled).
float assist_linear_damping() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_ASSIST_LIN_DAMP")) {
      return static_cast<float>(std::atof(raw));
    }
    return 0.0f;
  }();
  return value;
}

/// Zero by default: measured counterproductive (see settle_assist_enabled).
float assist_angular_damping() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_ASSIST_ANG_DAMP")) {
      return static_cast<float>(std::atof(raw));
    }
    return 0.0f;
  }();
  return value;
}

/// Multiplier on the base chunk sleep threshold for assisted bodies. The
/// threshold is mass-normalised kinetic energy, so 4x is ~2x the speed at
/// which a grounded body is called at rest.
float assist_sleep_multiplier() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_ASSIST_SLEEP_MULT")) {
      return static_cast<float>(std::atof(raw));
    }
    return 4.0f;
  }();
  return value;
}

constexpr float kChunkStabilizationThreshold = 0.02f;

/// Position/velocity solver iterations for chunk bodies.
///
/// PhysX defaults (4/1) leave a residual velocity floor in a deep pile; these
/// raise it enough that a resting body actually reaches zero. Costs solver
/// time per awake body, which pays for itself many times over if it lets
/// thousands of bodies sleep instead of staying awake forever.
///
/// VIBE_CITY_SOLVER_POSITION_ITERS / VIBE_CITY_SOLVER_VELOCITY_ITERS override.
std::uint32_t chunk_solver_position_iterations() {
  static const std::uint32_t v = [] {
    if (const char *raw = std::getenv("VIBE_CITY_SOLVER_POSITION_ITERS")) {
      const long parsed = std::strtol(raw, nullptr, 10);
      if (parsed > 0) return static_cast<std::uint32_t>(parsed);
    }
    // PhysX's own default. tests/stack_settling.rs shows 1,015 stacked
    // concrete boxes reaching exactly 0.0000 m/s and 100% asleep at 4/1, so
    // there is no evidence stacking needs more. Left as a knob, not a change.
    return 4u;
  }();
  return v;
}

std::uint32_t chunk_solver_velocity_iterations() {
  static const std::uint32_t v = [] {
    if (const char *raw = std::getenv("VIBE_CITY_SOLVER_VELOCITY_ITERS")) {
      const long parsed = std::strtol(raw, nullptr, 10);
      if (parsed > 0) return static_cast<std::uint32_t>(parsed);
    }
    return 1u;
  }();
  return v;
}

void DestructionManager::register_filters(Slot &slot) {
  require(slot.dest != nullptr, "missing destructible");
  // Shared readback from refresh_snapshots(); no second device read.
  const auto &bodies = slot.body_cache;
  const std::uint32_t body_count = slot.body_cache_count;

  for (std::uint32_t i = 0; i < body_count; ++i) {
    const auto &body = bodies[i];
    if (body.body == nullptr) {
      continue;
    }
    // Frozen rubble is kinematic too, so `kinematic` alone no longer means
    // "support body". Every serial decision below has to exclude it, or a
    // frozen chunk would be handed serial 0 and alias onto the structure's
    // support actor together with every other frozen chunk.
    const bool frozen = slot.frozen.count(body.bodyId) != 0;
    auto serial_it = slot.body_to_serial.find(body.bodyId);
    std::uint32_t serial = 0;
    if (serial_it == slot.body_to_serial.end()) {
      // A body can only be frozen after we have seen it dynamic, so this is
      // unreachable; count it rather than trusting that silently.
      if (frozen) {
        ++frozen_serial_blocks_;
      }
      // EVERY first-seen body gets a real serial. Kinematic first-seens are
      // rooted fragments born from a split of the support actor; they used
      // to alias onto serial 0, which made stumps unaddressable -- no
      // dependency edges could name them, no retire event could announce
      // their death. Serial 0 is reserved for the intact support actor
      // seeded at create and is never issued here.
      serial = next_serial(slot);
      slot.body_to_serial[body.bodyId] = serial;
      if (body.kinematic && !frozen) {
        slot.rooted.insert(body.bodyId);
      }
    } else {
      serial = serial_it->second;
      // Serial 0 is the intact support actor. If it has become dynamic the
      // whole structure came off its anchors; it needs a real serial or it
      // aliases onto nothing meaningful.
      if (serial == kSupportIslandSerial && !body.kinematic && !frozen) {
        serial = next_serial(slot);
        slot.body_to_serial[body.bodyId] = serial;
        slot.rooted.erase(body.bodyId);
      }
    }
    const std::uint32_t entity = pack_body_entity(slot.structure_id, serial);
    // Only touch a body whose identity actually changed.
    //
    // Writing rigid-body properties or shape filter data wakes a sleeping
    // PhysX actor. Re-stamping every body and every shape each tick therefore
    // woke the entire city 60 times a second: ~600 of ~735 chunk bodies never
    // stayed asleep, ~850 wake events a second, debris visibly juddering as it
    // was repeatedly frozen and released, and the match loop paying to
    // simulate, snapshot and encode all of it.
    const std::uint64_t identity_key = support_key(slot.structure_id, body.bodyId);
    auto stamped = body_entity_stamp_.find(identity_key);
    if (stamped != body_entity_stamp_.end() && stamped->second == entity) {
      continue;
    }
    body_entity_stamp_[identity_key] = entity;
    tag_actor(*body.body, entity);
    if (!body.kinematic) {
      // Contact reports are what let a falling chunk damage what it lands on:
      // onContact routes the impulse into the stress solver. They are not
      // free — the scene filter requests eNOTIFY_THRESHOLD_FORCE_PERSISTS and
      // eNOTIFY_CONTACT_POINTS, so every reporting pair extracts and copies
      // full contact data back to the host every tick, and a settled rubble
      // pile is nothing but persistent pairs. VIBE_CITY_CHUNK_CONTACT_REPORTS=0
      // disables them so the cost can be measured against the gameplay they buy.
      //
      // The flat threshold is decorative at city scale: at 20 m/s^2 a 10 t
      // chunk RESTS at ~200 kN and even the lightest shard rests at ~800 N,
      // so every touching awake pair clears 50 N by orders of magnitude and
      // reports every tick. Measured cost of the whole report path: ~6 ms of
      // the tick (4-10 by regime), by matched-bucket A/B against
      // VIBE_CITY_CHUNK_CONTACT_REPORTS=0.
      //
      // A flat RAISE cannot fix it -- a light body's genuine strike (~12 kN)
      // sits an order of magnitude BELOW a heavy body's resting load, so any
      // single number silences small-body physics first. A threshold
      // proportional to the body's own weight is scale-free: resting under
      // your own weight is below it by construction at any size, and being
      // struck above ~ratio*g/60 m/s (0.7 m/s at ratio 2) is above it. Same
      // trick contact_wake_ratio() already uses for the wake test.
      //
      // Unset leaves the flat behaviour byte-for-byte, so this is an
      // experiment that can be turned off without a rebuild.
      body.body->setContactReportThreshold(
          chunk_contact_reports_
              ? chunk_contact_report_threshold(body.mass, contact_report_threshold_)
              : std::numeric_limits<float>::max());
      // Let debris go to sleep.
      //
      // PhysX's default sleep threshold is tuned for gameplay objects that
      // should stay responsive. Rubble is not that: a collapsed tower leaves
      // hundreds of bodies in a pile trading micro-contacts, all of which stay
      // above the default threshold indefinitely. Measured at ~1200 bodies,
      // ~1000 of them never slept, and simulating, snapshotting and encoding
      // them held the match loop at 26-30 ms against a 16.67 ms budget.
      //
      // The threshold is mass-normalised kinetic energy, so this sleeps
      // anything drifting slower than roughly 0.3 m/s — well below the speed
      // at which debris motion is still worth streaming.
      body.body->setSleepThreshold(chunk_sleep_threshold());
      body.body->setStabilizationThreshold(kChunkStabilizationThreshold);
      // Chunk bodies were left on PhysX's default 4 position / 1 velocity
      // iterations, which is tuned for a handful of loose props rather than a
      // 10k-body rubble pile.
      //
      // Contact solving is iterative: each pass reduces the error but never
      // eliminates it, so an under-iterated deep stack leaves a *residual
      // velocity floor*. That is what stops a resting body ever sleeping --
      // not the sleep threshold. Velocity does not asymptote to zero, it
      // asymptotes to the floor, and everything below the floor is unreachable
      // no matter how long you wait. Raising the sleep threshold past it only
      // masks the symptom, and makes a still-visibly-moving body snap to
      // stationary.
      //
      // Doubling world gravity doubled the contact forces the solver must
      // cancel within the same iteration budget, so it roughly doubled that
      // floor -- which is why the city settled at 9.81 m/s^2 and stopped
      // settling at 20.
      body.body->setSolverIterationCounts(
          chunk_solver_position_iterations(), chunk_solver_velocity_iterations());
    }
  }

  const auto &shapes = slot.shape_cache;
  const std::uint32_t shape_count = slot.shape_cache_count;

  for (std::uint32_t i = 0; i < shape_count; ++i) {
    const auto &shape = shapes[i];
    if (shape.shape == nullptr) {
      continue;
    }
    auto serial_it = slot.body_to_serial.find(shape.bodyId);
    const std::uint32_t serial =
        serial_it != slot.body_to_serial.end() ? serial_it->second : 0;
    const std::uint32_t entity = pack_body_entity(slot.structure_id, serial);
    // Same rule for shapes: re-stamping identical filter data is not free, it
    // wakes the owning actor.
    auto shape_stamped = shape_entity_stamp_.find(shape.shape);
    if (shape_stamped == shape_entity_stamp_.end() || shape_stamped->second != entity) {
      shape_entity_stamp_[shape.shape] = entity;
      configure_shape(*shape.shape, entity, slot.collision_group,
                      slot.collision_mask);
    }
    shape_owners_[shape.shape] =
        std::make_pair(slot.structure_id, shape.nodeIndex);
  }
}

void DestructionManager::collect_events(Slot &slot) {
  require(slot.dest != nullptr, "missing destructible");

  // Diffed in place against the live maps, not against copies of them.
  //
  // This used to deep-copy body_to_serial, node_to_body and node_to_serial on
  // every changed slot -- one allocation per entry, thousands of entries, on
  // exactly the fracture ticks that already cost the most. The copies existed
  // to see pre-update state, which is available anyway as long as each entry
  // is READ before it is WRITTEN. Every loop below visits a given body or node
  // once, so that ordering holds; the reads are marked where it matters.

  // Shared readback from refresh_snapshots(); no second device read.
  const auto &bodies = slot.body_cache;
  const std::uint32_t body_count = slot.body_cache_count;

  std::unordered_map<ExtStressPhysXId, const ExtStressPhysXBodySnapshot *>
      body_by_id;
  std::unordered_set<ExtStressPhysXId> live_bodies;
  // Keyed by island serial, which is 22 bits. Narrowing this to uint16 silently
  // fails the lookup below for any serial past 65535, which means a promoted
  // island is announced to clients with no chunks attached -- the island exists
  // but nothing is bound to it, so it renders as nothing at all.
  std::unordered_map<std::uint32_t, std::size_t> promo_event_index;
  for (std::uint32_t i = 0; i < body_count; ++i) {
    body_by_id[bodies[i].bodyId] = &bodies[i];
    live_bodies.insert(bodies[i].bodyId);
    // A body already mapped to the support sentinel but no longer kinematic
    // has become an independent island since we last looked. Treat it as new:
    // it needs its own serial, and clients need the promotion event, or its
    // chunks stay bound to the support body and move as one piece with it.
    // Read before this iteration's write, so it still sees prior state.
    // A body we froze that reads dynamic again was flipped by the adapter --
    // it split under load, and setBodyKinematic ran on our behalf. Drop it
    // from the frozen set here, where every topology change is already
    // observed, so the set never claims a body the adapter has taken back.
    // Rust sees the same body reappear in the snapshot and announces the wake.
    if (!bodies[i].kinematic && slot.frozen.erase(bodies[i].bodyId) != 0) {
      ++frozen_adapter_releases_;
      const auto freed = slot.body_to_serial.find(bodies[i].bodyId);
      if (freed != slot.body_to_serial.end()) {
        frozen_entities_.erase(pack_body_entity(slot.structure_id, freed->second));
      }
    }
    const bool frozen = slot.frozen.count(bodies[i].bodyId) != 0;
    const auto mapped = slot.body_to_serial.find(bodies[i].bodyId);
    // The intact support actor (serial 0) coming off its anchors: the one
    // case that still needs a serial REISSUE, because 0 cannot go on the
    // wire as an island.
    const bool support_became_dynamic = mapped != slot.body_to_serial.end()
                                        && mapped->second == kSupportIslandSerial
                                        && !bodies[i].kinematic;
    // A rooted fragment (real serial, kinematic) that lost its last anchored
    // node: the adapter flipped it dynamic. It KEEPS its serial -- it is the
    // same body -- and is promoted onto the wire under it. This is also a
    // supporter-death event for anything resting on it; the tracker sees the
    // promotion and invalidates those dependency edges.
    const bool rooted_became_dynamic = !support_became_dynamic
                                       && !bodies[i].kinematic
                                       && slot.rooted.count(bodies[i].bodyId) != 0;
    if (support_became_dynamic || rooted_became_dynamic) {
      ++support_promotions_;
      slot.rooted.erase(bodies[i].bodyId);
    }
    if (mapped == slot.body_to_serial.end() || support_became_dynamic
        || rooted_became_dynamic) {
      if (frozen) {
        ++frozen_serial_blocks_;
      }
      std::uint32_t serial;
      if (rooted_became_dynamic) {
        serial = mapped->second; // identity continuity: same body, same serial
      } else {
        // Every first-seen body gets a real serial, kinematic or not.
        // First-seen kinematics are rooted fragments from a split; aliasing
        // them onto serial 0 made stumps unaddressable (no dependency edge
        // could name them, no retire could announce their death).
        serial = next_serial(slot);
        slot.body_to_serial[bodies[i].bodyId] = serial;
        if (bodies[i].kinematic && !frozen) {
          slot.rooted.insert(bodies[i].bodyId);
        }
      }
      if (!bodies[i].kinematic) {
        FfiIslandBodyEvent event{};
        event.structure_id = slot.structure_id;
        event.island_id = serial;
        event.kind = 0; // promoted
        event.mass =
            bodies[i].body != nullptr ? bodies[i].body->getMass() : 0.0f;
        event.position = from_px(com_world_position(bodies[i]));
        event.rotation = from_px(bodies[i].globalPose.q);
        event.linear_velocity = from_px(bodies[i].linearVelocity);
        event.angular_velocity = from_px(bodies[i].angularVelocity);
        // Bodies that reuse the parent actor on a split carry a non-zero
        // local centre of mass; com_world_position() normalises their pose.
        // Counted so the frequency of that path stays visible.
        if (bodies[i].centerOfMassLocalPose.p.magnitude() > 0.05f) {
          ++reused_parent_promotions_;
        }
        promo_event_index[serial] = island_events_.size();
        island_events_.push_back(std::move(event));
      }
    }
  }

  // Retire disappeared non-support bodies.
  // Bodies added by the loop above are live, so iterating the live map here
  // retires exactly the same set the copy did.
  std::vector<ExtStressPhysXId> retired_ids;
  for (const auto &entry : slot.body_to_serial) {
    if (live_bodies.find(entry.first) == live_bodies.end() &&
        entry.second != 0) {
      FfiIslandBodyEvent event{};
      event.structure_id = slot.structure_id;
      event.island_id = entry.second;
      event.kind = 1; // retired
      island_events_.push_back(event);
      retired_ids.push_back(entry.first);
    }
  }
  for (ExtStressPhysXId id : retired_ids) {
    // A frozen body can still be destroyed under us (crushed, or merged away).
    // Leaving it in the sets would leak entries and, once the adapter
    // recycles the id, wrongly mark a brand new body as already frozen.
    // Serial read before the erase that invalidates it.
    if (slot.frozen.erase(id) != 0) {
      const auto freed = slot.body_to_serial.find(id);
      if (freed != slot.body_to_serial.end()) {
        frozen_entities_.erase(pack_body_entity(slot.structure_id, freed->second));
      }
    }
    // A rooted fragment crushed to nothing retires like any body now that it
    // holds a real serial -- the kind=1 event above already announced it,
    // which is exactly the supporter-death signal its dependents need.
    slot.rooted.erase(id);
    // Its supporter entries (and any it was a dependent of) die with it.
    support_store_.erase(support_key(slot.structure_id, id));
    slot.body_to_serial.erase(id);
    // These two were pointer-keyed and pruned nowhere, so they leaked an entry
    // per retired body AND let a recycled actor inherit a dead body's state.
    // VIBE_CITY_PRUNE_BODY_BOOKKEEPING=0 restores the un-pruned behaviour, so
    // the bounded-growth tripwire in record-city-trace can be shown to fire.
    // A tripwire that has never been observed failing is not a tripwire.
    static const bool prune = [] {
      const char *raw = std::getenv("VIBE_CITY_PRUNE_BODY_BOOKKEEPING");
      return raw == nullptr || std::string(raw) != "0";
    }();
    if (prune) {
      ccd_enabled_.erase(support_key(slot.structure_id, id));
      body_entity_stamp_.erase(support_key(slot.structure_id, id));
      // Same recycling hazard: an unpruned latch would make a NEW body born
      // on a recycled id look like it had already landed, and the assist
      // would fire on a body still in flight -- the one case the ground gate
      // exists to prevent.
      ground_touched_.erase(support_key(slot.structure_id, id));
      settle_assisted_.erase(support_key(slot.structure_id, id));
    }
  }

  const auto &shapes = slot.shape_cache;
  const std::uint32_t shape_count = slot.shape_cache_count;

  for (std::uint32_t i = 0; i < shape_count; ++i) {
    const auto &shape = shapes[i];
    const std::uint32_t node = shape.nodeIndex;
    const ExtStressPhysXId new_body = shape.bodyId;
    // Both reads precede this iteration's writes to the same node key.
    auto old_body_it = slot.node_to_body.find(node);
    const ExtStressPhysXId old_body =
        old_body_it != slot.node_to_body.end() ? old_body_it->second : 0;
    auto old_serial_it = slot.node_to_serial.find(node);
    const std::uint32_t old_serial =
        old_serial_it != slot.node_to_serial.end() ? old_serial_it->second
                                                       : 0;
    auto new_serial_it = slot.body_to_serial.find(new_body);
    const std::uint32_t new_serial =
        new_serial_it != slot.body_to_serial.end() ? new_serial_it->second : 0;

    if (old_body != 0 && old_body != new_body) {
      FfiChunkMigrationEvent migration{};
      migration.structure_id = slot.structure_id;
      migration.chunk_id = pack_chunk_id(slot.structure_id, node);
      migration.from_island = old_serial;
      migration.to_island = new_serial;
      migrations_.push_back(migration);
    }

    if (new_serial != 0) {
      auto promo_it = promo_event_index.find(new_serial);
      if (promo_it != promo_event_index.end()) {
        island_events_[promo_it->second].chunk_ids.push_back(
            pack_chunk_id(slot.structure_id, node));
      }
    }

    slot.node_to_body[node] = new_body;
    slot.node_to_serial[node] = new_serial;
  }

  // Infer broken bonds: endpoints on different bodies.
  for (std::size_t bond_index = 0; bond_index < slot.bond_descs.size();
       ++bond_index) {
    if (!slot.bond_alive[bond_index]) {
      continue;
    }
    const auto &bond = slot.bond_descs[bond_index];
    auto a = slot.node_to_body.find(bond.node0);
    auto b = slot.node_to_body.find(bond.node1);
    if (a == slot.node_to_body.end() || b == slot.node_to_body.end()) {
      continue;
    }
    if (a->second != b->second) {
      slot.bond_alive[bond_index] = 0;
      FfiBrokenBondEvent broken{};
      broken.structure_id = slot.structure_id;
      broken.bond_id = pack_bond_id(slot.structure_id,
                                    static_cast<std::uint32_t>(bond_index));
      broken_bonds_.push_back(broken);
      ++total_broken_bonds_;
    }
  }
}

void DestructionManager::refresh_snapshots(Slot &slot) const {
  slot.body_cache.resize(slot.node_descs.size() + 64);
  slot.body_cache_count = slot.dest->getBodySnapshots(
      slot.body_cache.data(), static_cast<std::uint32_t>(slot.body_cache.size()));
  // The snapshot is sorted by bodyId, so a repeat is adjacent. A repeated id
  // maps two snapshot rows onto one island serial, which is exactly how two
  // distinct bodies end up sharing a network id downstream.
  //
  // The sleeping tally rides this walk. destruction_stats() used to do its own
  // full pass over every body of every slot, every tick, purely to count them
  // -- a second whole-population walk for one number.
  std::uint32_t sleeping = 0;
  bool sorted = true;
  for (std::uint32_t i = 0; i < slot.body_cache_count && i < slot.body_cache.size(); ++i) {
    if (i > 0 && slot.body_cache[i].bodyId == slot.body_cache[i - 1].bodyId) {
      ++repeated_body_snapshots_;
    }
    // Free: this loop already walks every row.
    if (i > 0 && slot.body_cache[i].bodyId < slot.body_cache[i - 1].bodyId) {
      sorted = false;
    }
    if (!slot.body_cache[i].kinematic && slot.body_cache[i].sleeping) {
      ++sleeping;
    }
  }
  slot.sleeping_body_count = sleeping;
  slot.body_cache_sorted = sorted;
  if (slot.body_cache_count > slot.body_cache.size()) {
    slot.body_cache.resize(slot.body_cache_count);
    slot.body_cache_count = slot.dest->getBodySnapshots(
        slot.body_cache.data(), static_cast<std::uint32_t>(slot.body_cache.size()));
  }
}

/// Shape snapshots, refreshed only when something will read them.
///
/// The only consumers are collect_events and register_filters, and both are
/// skipped on ticks where topology did not change -- which is nearly every
/// tick. Reading one snapshot per NODE (11k+ citywide, awake or not) and then
/// discarding it was pure cost: getShapeSnapshots always writes
/// min(capacity, m_nodes.size()) entries regardless of what is moving.
void DestructionManager::refresh_shape_snapshots(Slot &slot) const {
  slot.shape_cache.resize(slot.node_descs.size() + 64);
  slot.shape_cache_count = slot.dest->getShapeSnapshots(
      slot.shape_cache.data(), static_cast<std::uint32_t>(slot.shape_cache.size()));
  if (slot.shape_cache_count > slot.shape_cache.size()) {
    slot.shape_cache.resize(slot.shape_cache_count);
    slot.shape_cache_count = slot.dest->getShapeSnapshots(
        slot.shape_cache.data(), static_cast<std::uint32_t>(slot.shape_cache.size()));
  }
}

StressExecutor::StressExecutor(unsigned workers) {
  // `workers` counts total parallelism; the calling thread is one of them.
  const unsigned extra = workers > 1 ? workers - 1 : 0;
  threads_.reserve(extra);
  for (unsigned i = 0; i < extra; ++i) {
    threads_.emplace_back([this] {
      std::uint64_t seen = 0;
      for (;;) {
        {
          std::unique_lock<std::mutex> lock(mutex_);
          start_.wait(lock, [this, seen] { return stop_ || generation_ != seen; });
          if (stop_) {
            return;
          }
          seen = generation_;
        }
        drain();
        {
          std::lock_guard<std::mutex> lock(mutex_);
          if (--active_ == 0) {
            done_.notify_one();
          }
        }
      }
    });
  }
}

StressExecutor::~StressExecutor() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stop_ = true;
    ++generation_;
  }
  start_.notify_all();
  for (auto &thread : threads_) {
    if (thread.joinable()) {
      thread.join();
    }
  }
}

void StressExecutor::drain() {
  for (;;) {
    const std::size_t index = next_.fetch_add(1, std::memory_order_relaxed);
    if (index >= count_) {
      return;
    }
    try {
      (*task_)(index);
    } catch (...) {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!error_) {
        error_ = std::current_exception();
      }
    }
  }
}

void StressExecutor::run(std::size_t count,
                         const std::function<void(std::size_t)> &task) {
  if (count == 0) {
    return;
  }
  // One item, or no helper threads: no point paying for a handoff.
  if (threads_.empty() || count == 1) {
    for (std::size_t i = 0; i < count; ++i) {
      task(i);
    }
    return;
  }

  {
    std::lock_guard<std::mutex> lock(mutex_);
    task_ = &task;
    count_ = count;
    next_.store(0, std::memory_order_relaxed);
    active_ = threads_.size();
    error_ = nullptr;
    ++generation_;
  }
  start_.notify_all();

  // The caller works too rather than idling while the pool runs.
  drain();

  std::unique_lock<std::mutex> lock(mutex_);
  done_.wait(lock, [this] { return active_ == 0; });
  task_ = nullptr;
  if (error_) {
    std::exception_ptr error = error_;
    error_ = nullptr;
    std::rethrow_exception(error);
  }
}

std::uint32_t DestructionManager::next_serial(Slot &slot) {
  if (slot.next_island_serial >= 0x003F'FFFFu) {
    ++serial_wraps_;
    std::fprintf(stderr,
                 "[destruction] structure %u exhausted its 16-bit island serial "
                 "space (wrap #%llu): ids are about to be reused while still "
                 "live, which aliases distinct bodies onto one network id\n",
                 slot.structure_id,
                 static_cast<unsigned long long>(serial_wraps_));
  }
  const std::uint32_t serial = slot.next_island_serial++;
  if (slot.next_island_serial >= 0x0040'0000u) {
    slot.next_island_serial = 1; // 0 is the kinematic-support sentinel
  }
  if (serial > max_island_serial_) {
    max_island_serial_ = serial;
  }
  return serial;
}

void DestructionManager::destruction_tick(float dt, FfiVec3 gravity) {
  // Remembered for the contact-wake resting-load ratio, which needs the
  // step the reported impulses were integrated over.
  if (dt > 0.0f) {
    last_dt_ = dt;
  }
  // Fresh span slate per tick; same-name adds below accumulate.
  extra_spans_.clear();
  const PxVec3 g = to_px(gravity);
  using clock = std::chrono::steady_clock;
  const auto ms_since = [](clock::time_point from) {
    return static_cast<float>(
        std::chrono::duration<double, std::milli>(clock::now() - from).count());
  };
  const auto started = clock::now();
  // Per-phase attribution. The old single number covered this whole function,
  // so "stress solve" was really solve + GPU readback + event diffing.
  float begin_ms = 0.0f;
  float solve_ms = 0.0f;
  float end_ms = 0.0f;
  float readback_ms = 0.0f;
  float events_ms = 0.0f;
  float filters_ms = 0.0f;
  float ccd_ms = 0.0f;
  float shape_readback_ms = 0.0f;
  float slot_dispatch_ms = 0.0f;
  // Live structures, gathered once so the parallel phase can index them.
  auto dispatch_phase = clock::now();
  live_slots_.clear();
  for (auto &slot_ptr : slots_) {
    if (slot_ptr && slot_ptr->dest != nullptr) {
      live_slots_.push_back(slot_ptr.get());
    }
  }

  // Three phases, of which only the middle one is concurrent.
  //
  // Phase order: read body state ONCE, then begin (parallel), solve
  // (parallel), end (serial).
  //
  // beginTick() used to be serial because parallelising it segfaulted inside
  // PhysX -- captured under gdb (EXIT_STATUS=139):
  //
  //   Sc::SqBoundsManagerEx::removeSyncShape(ShapeSimBase&)
  //   PxgSimulationControllerCallback::updateScBodyAndShapeSim
  //   Sc::Scene::afterIntegration        <- PhysX worker thread
  //
  // Its addGravity called isSleeping() + getGlobalPose() on EVERY body, so
  // running it on N threads was unsynchronised PxScene access racing PhysX's
  // deferred shape/bounds sync. Read locks do not help: PxScene's RW lock only
  // engages with PxSceneFlag::eREQUIRE_RW_LOCK, which would oblige every scene
  // access in the bridge to take matching locks (measured: still SIGSEGV).
  //
  // The fix is to remove the reads rather than guard them. We already read
  // every body's pose and sleep state once per tick, and the stress phases do
  // not move bodies -- PhysX did that in world.step(), and splits only create
  // bodies in endTick. So the snapshot taken here is exactly what addGravity
  // was re-fetching one virtual call at a time. beginTickFromSnapshot consumes
  // it and touches PhysX not at all, which makes the phase pure per-structure
  // math and safe to parallelise by construction.
  //
  // Contacts on a sleeping body still need wakeUp(), which is a scene write,
  // so the adapter returns those ids and we apply them serially below.
  slot_dispatch_ms += ms_since(dispatch_phase);

  auto phase = clock::now();
  for (Slot *slot : live_slots_) {
    refresh_snapshots(*slot);
  }
  readback_ms += ms_since(phase);

  phase = clock::now();
  if (snapshot_begin_enabled()) {
    stress_executor_->run(live_slots_.size(), [this, dt, g](std::size_t index) {
      Slot &slot = *live_slots_[index];
      slot.wake_count = 0;
      require(
          slot.dest->beginTickFromSnapshot(
              dt, g, slot.body_cache.data(), slot.body_cache_count,
              slot.wake_bodies.data(),
              static_cast<std::uint32_t>(slot.wake_bodies.size()),
              &slot.wake_count),
          "beginTickFromSnapshot failed");
    });
    // Serial: wakeUp() is a scene write. Only bodies that took a contact while
    // asleep appear here, so this is a handful even during a collapse.
    for (Slot *slot : live_slots_) {
      const std::uint32_t capacity =
          static_cast<std::uint32_t>(slot->wake_bodies.size());
      const std::uint32_t applied = std::min(slot->wake_count, capacity);
      // getBodySnapshots returns bodies sorted by id, so this is a binary
      // search rather than a scan per wake.
      const auto begin = slot->body_cache.begin();
      const auto end = begin + slot->body_cache_count;
      for (std::uint32_t i = 0; i < applied; ++i) {
        const ExtStressPhysXId id = slot->wake_bodies[i];
        const auto found = std::lower_bound(
            begin, end, id,
            [](const ExtStressPhysXBodySnapshot &entry, ExtStressPhysXId value) {
              return entry.bodyId < value;
            });
        if (found != end && found->bodyId == id && found->body != nullptr &&
            !found->kinematic) {
          found->body->wakeUp();
        }
      }
      if (slot->wake_count > capacity) {
        wake_truncations_ += slot->wake_count - capacity;
      }
    }
  } else {
    for (Slot *slot : live_slots_) {
      require(slot->dest->beginTick(dt, g), "beginTick failed");
    }
  }
  begin_ms += ms_since(phase);

  phase = clock::now();
  stress_executor_->run(live_slots_.size(), [this](std::size_t index) {
    require(live_slots_[index]->dest->solveTick(), "solveTick failed");
  });
  solve_ms += ms_since(phase);

  // Sample how close bonds are to failing, between solve and fracture. This
  // is the only signal that distinguishes "the load path is intact and nothing
  // is near its limit" from "no load is reaching the bonds at all" -- the
  // broken-bond count cannot, because it is inferred from chunks landing on
  // different bodies and so stays zero until something actually separates.
  //
  // SAMPLED, not per tick: it reads and scans EVERY bond of every structure
  // (74k citywide), which cost more than the GPU stress solve it reports on --
  // it sat between the solve and end brackets, so it showed up only as a gap
  // between the native tick and the sum of its phases. It feeds two telemetry
  // numbers published once a second; measuring them 60 times a second bought
  // nothing. VIBE_CITY_BOND_SAMPLE_TICKS=1 restores per-tick sampling.
  const auto bond_phase = clock::now();
  ++bond_sample_counter_;
  if (bond_sample_counter_ >= bond_sample_interval_) {
    bond_sample_counter_ = 0;
    float utilisation_max = 0.0f;
    std::uint32_t above_half = 0;
    for (Slot *slot_ptr : live_slots_) {
      Slot &slot = *slot_ptr;
      const std::uint32_t bond_count =
          static_cast<std::uint32_t>(slot.bond_descs.size());
      if (bond_count == 0) {
        continue;
      }
      if (slot.bond_utilisation.size() < bond_count) {
        slot.bond_utilisation.resize(bond_count);
      }
      const std::uint32_t written = slot.dest->getBondUtilisations(
          slot.bond_utilisation.data(), bond_count);
      for (std::uint32_t i = 0; i < written; ++i) {
        const float utilisation = slot.bond_utilisation[i];
        if (!std::isfinite(utilisation)) {
          continue;
        }
        if (utilisation > utilisation_max) {
          utilisation_max = utilisation;
        }
        if (utilisation >= 0.5f) {
          ++above_half;
        }
      }
    }
    last_bond_utilisation_max_ = utilisation_max;
    last_bonds_above_half_utilisation_ = above_half;
  }
  // Zero on the 29 ticks in 30 that skip the scan; on the 30th it is a full
  // walk of every bond of every structure (74k citywide). Reported per tick
  // rather than averaged so the spike is visible as a spike.
  last_bond_sample_ms_ = ms_since(bond_phase);

  phase = clock::now();
  for (Slot *slot : live_slots_) {
    require(slot->dest->endTick(), "endTick failed");
  }
  end_ms += ms_since(phase);

  for (Slot *slot_ptr : live_slots_) {
    Slot &slot = *slot_ptr;

    // Speculative CCD, enabled exactly once per dynamic body, independently of
    // the event diff (a body can turn dynamic on a tick with no split, which
    // the quiet-tick gate skips -- one escaped that way at ~776 m/s and left
    // the map). Speculative CCD is the GPU-compatible continuous-collision
    // mode: it widens contact generation by the body's velocity so a fast body
    // cannot pass through the floor between steps, without altering any
    // trajectory that wasn't about to hit something. This replaces the old
    // setMaxLinearVelocity(12) clamp, which prevented tunnelling by falsifying
    // physics for every body all the time.
    //
    // Applied on first sight, when the body is freshly created or split and
    // therefore awake, so it never rewrites properties on a sleeping actor.
    phase = clock::now();
    // Retired by default: the library applies speculative CCD and the
    // depenetration cap AT BODY CREATION since 04a874af, which provably covers
    // the first step this walk always missed; gates and live play have shown
    // escaped_bodies_parked = 0 ever since. VIBE_CITY_BRIDGE_CCD_WALK=1
    // restores the walk as belt-and-braces.
    static const bool bridge_ccd_walk = [] {
      const char *raw = std::getenv("VIBE_CITY_BRIDGE_CCD_WALK");
      return raw != nullptr && std::string(raw) == "1";
    }();
    for (std::uint32_t i = 0; bridge_ccd_walk && i < slot.body_cache_count; ++i) {
      const auto &body = slot.body_cache[i];
      if (body.body == nullptr || body.kinematic) {
        continue;
      }
      if (ccd_enabled_.insert(support_key(slot.structure_id, body.bodyId)).second) {
        if (speculative_ccd_enabled()) {
          body.body->setRigidBodyFlag(
              physx::PxRigidBodyFlag::eENABLE_SPECULATIVE_CCD, true);
        }
        // Bound the solver's depenetration response. Split children start
        // life overlapping their siblings (they shared faces one tick ago),
        // and PhysX's default depenetration velocity is unbounded. This is
        // not clamping physics: interpenetration is a numerical artifact of
        // discrete stepping, and this bounds only how fast the solver
        // corrects that unreal state. (It was once suspected as the source of
        // kilometre-scale escapes; measurement pinned those on the adapter's
        // unbounded excess-force injection instead -- see city.rs -- but the
        // bound remains correct on its own terms.)
        const float depen = depenetration_velocity();
        if (depen > 0.0f) {
          body.body->setMaxDepenetrationVelocity(depen);
        }
      }
    }
    // Settle assist. Same shape as the CCD walk above: once per body, in the
    // post-endTick window where scene writes are legal, keyed by
    // (structure_id, bodyId) so a recycled actor cannot inherit the flag.
    //
    // Writing a rigid-body property wakes a sleeping actor, which is why
    // every other property write in this file is gated on an identity
    // change. Here the write happens on the tick the body first touched the
    // ground, when it is awake by definition, and never again.
    if (settle_assist_enabled()) {
      const float max_mass = assist_max_mass();
      const float sleep_threshold =
          chunk_sleep_threshold() * assist_sleep_multiplier();
      for (std::uint32_t i = 0; i < slot.body_cache_count; ++i) {
        const auto &body = slot.body_cache[i];
        if (body.body == nullptr || body.kinematic) {
          continue;
        }
        if (body.mass > max_mass) {
          continue; // slabs keep their exact settling behaviour
        }
        const std::uint64_t key = support_key(slot.structure_id, body.bodyId);
        if (ground_touched_.find(key) == ground_touched_.end()) {
          continue; // never landed: still in flight, or never existed
        }
        if (!settle_assisted_.insert(key).second) {
          continue;
        }
        // Only write what actually changes. Every property write wakes the
        // actor, so writing a zero damping that equals the body's existing
        // value would cost a wake and buy nothing.
        const float linear = assist_linear_damping();
        const float angular = assist_angular_damping();
        if (linear > 0.0f) {
          body.body->setLinearDamping(linear);
        }
        if (angular > 0.0f) {
          body.body->setAngularDamping(angular);
        }
        body.body->setSleepThreshold(sleep_threshold);
        ++settle_assist_applied_;
      }
    }
    ccd_ms += ms_since(phase);

    // Topology can only change inside endTick, and only when bonds were
    // overstressed. When these counters have not moved, nothing was split,
    // created or migrated, so the diff below would walk every body, every
    // shape and every bond only to conclude that nothing changed. Skip it.
    dispatch_phase = clock::now();
    const ExtStressPhysXTelemetry &telemetry = slot.dest->getTelemetry();
    // Accumulated here, per tick, and deliberately above the quiet-skip
    // `continue` below: a settled slot is exactly the case the skip is for, so
    // dropping its islands would bias the rate toward the ticks that skipped
    // nothing. See the accumulator declarations for why the gauge alone lies.
    solver_islands_skipped_accum_ += telemetry.solverIslandsSkipped;
    solver_islands_total_accum_ += telemetry.solverIslandCount;
    // bodiesRecycled is in the set because a PURE-CRUSH tick erases bodies
    // without splitting, creating or migrating anything -- a rooted fragment
    // (or a dynamic body) could vanish on a tick this gate skipped, its
    // retire event never firing and its dependents never released.
    const bool topology_changed =
        !slot.topology_primed || telemetry.splits != slot.last_splits ||
        telemetry.bodiesCreated != slot.last_bodies_created ||
        telemetry.shapesMigrated != slot.last_shapes_migrated ||
        telemetry.bodiesRecycled != slot.last_bodies_recycled;
    slot_dispatch_ms += ms_since(dispatch_phase);
    if (!topology_changed && quiet_skip_enabled()) {
      ++quiet_slot_ticks_;
      continue;
    }

    // Topology changed, so endTick created/destroyed bodies after the
    // pre-solve readback. Re-read for the consumers below and for the
    // encoder. On quiet ticks the pre-solve snapshot is already exact: the
    // stress phases do not move bodies.
    phase = clock::now();
    refresh_snapshots(slot);
    readback_ms += ms_since(phase);
    // Shapes are only read by the two functions below, so they are fetched
    // here rather than every tick in refresh_snapshots.
    phase = clock::now();
    refresh_shape_snapshots(slot);
    shape_readback_ms += ms_since(phase);
    slot.last_splits = telemetry.splits;
    slot.last_bodies_created = telemetry.bodiesCreated;
    slot.last_shapes_migrated = telemetry.shapesMigrated;
    slot.last_bodies_recycled = telemetry.bodiesRecycled;
    slot.topology_primed = true;

    // Diff membership first (assigns serials for new bodies), then stamp
    // filter/contact data onto every live shape/actor.
    phase = clock::now();
    collect_events(slot);
    events_ms += ms_since(phase);

    phase = clock::now();
    register_filters(slot);
    filters_ms += ms_since(phase);
  }
  last_begin_ms_ = begin_ms;
  last_solve_ms_ = solve_ms;
  last_end_ms_ = end_ms;
  last_readback_ms_ = readback_ms;
  last_events_ms_ = events_ms;
  last_filters_ms_ = filters_ms;
  last_ccd_ms_ = ccd_ms;
  last_shape_readback_ms_ = shape_readback_ms;
  last_slot_dispatch_ms_ = slot_dispatch_ms;

  // Serials are current for every slot that changed, so the contact loads
  // captured during the physics step can be resolved into supporter edges.
  const auto support_phase = clock::now();
  resolve_support_loads();
  // Judge this tick's accumulated frozen-body contact loads now that the
  // contact stream is complete; the caller's drain then only reads.
  resolve_frozen_contact_wakes();
  last_support_loads_ms_ = ms_since(support_phase);

  last_stress_solve_ms_ = ms_since(started);
  // What the native tick spent that none of its phases claim.
  //
  // Measured at +0.001 ms across five live reports: this level was ALREADY
  // fully attributed, and the "2.8-4.2 ms native gap" it was thought to have
  // was an artifact of summing an incomplete child set by hand -- ccd,
  // shape_readback, slot_dispatch, support_loads and especially bond_sample
  // were left out, and bond_sample alone was the whole apparent gap.
  //
  // Which is the argument for computing this HERE, next to the phases,
  // instead of in an analysis script: the code knows the child set, and a
  // hand-written sum will keep drifting from it every time a phase is added.
  last_stress_solve_residual_ms_ =
      last_stress_solve_ms_ -
      (last_begin_ms_ + last_solve_ms_ + last_end_ms_ + last_readback_ms_ +
       last_events_ms_ + last_filters_ms_ + last_ccd_ms_ +
       last_shape_readback_ms_ + last_slot_dispatch_ms_ +
       last_support_loads_ms_ + last_bond_sample_ms_);
}

DestructionManager::ContactTarget
DestructionManager::resolve_contact_target(PxShape *shape) {
  if (shape == nullptr) {
    return {};
  }
  auto it = shape_owners_.find(shape);
  if (it == shape_owners_.end()) {
    return {};
  }
  Slot *slot = find_slot(it->second.first);
  if (slot == nullptr || slot->dest == nullptr) {
    return {};
  }
  // One adapter-side hash per shape per manifold, in place of one per POINT
  // inside queueContact (2.06-3.64 points/manifold measured on downtown).
  // VIBE_PHYSX_CONTACT_FASTPATH=0 leaves it unresolved, and queueContact
  // falls back to its own per-point lookup exactly as before.
  static const bool fastpath = [] {
    const char *value = std::getenv("VIBE_PHYSX_CONTACT_FASTPATH");
    return value == nullptr || std::string(value) != "0";
  }();
  // The node index is ALREADY in the hit we just took: shape_owners_ stores
  // (structure_id, nodeIndex), populated from the same shape snapshots the
  // library builds m_shapeToNode from. nodeForShape() is a second hash over
  // a second map keyed by the same PxShape* to recover a number already in
  // hand -- two cache misses per shape, four per manifold, ~32k per tick.
  //
  // Measured before this change: cb_resolve_ms was 1.47-2.10 ms, as large as
  // queueing the actual physics damage.
  //
  // Both maps are refreshed on the same cadence. register_filters (which
  // writes shape_owners_) and the library's endTick (which writes
  // m_shapeToNode) both run inside destruction_tick, and the quiet-skip that
  // bypasses register_filters only fires when topology did NOT change --
  // i.e. exactly when no shape's node could have moved. So during a
  // callback the two agree by construction.
  //
  // "By construction" is an argument, not a measurement, so
  // VIBE_PHYSX_NODE_CACHE_VERIFY=1 computes both and counts disagreements
  // into node_cache_mismatches. VIBE_PHYSX_NODE_CACHE=0 restores the second
  // lookup outright.
  static const bool node_cache = [] {
    const char *value = std::getenv("VIBE_PHYSX_NODE_CACHE");
    return value == nullptr || std::string(value) != "0";
  }();
  static const bool node_cache_verify = [] {
    const char *value = std::getenv("VIBE_PHYSX_NODE_CACHE_VERIFY");
    return value != nullptr && std::string(value) != "0";
  }();
  std::uint32_t blast_node = 0xFFFFFFFFu;
  if (fastpath) {
    if (node_cache) {
      blast_node = it->second.second;
      if (node_cache_verify) {
        const std::uint32_t authoritative = slot->dest->nodeForShape(shape);
        if (authoritative != blast_node) {
          ++node_cache_mismatches_;
        }
        ++node_cache_checks_;
      }
    } else {
      blast_node = slot->dest->nodeForShape(shape);
    }
  }
  return ContactTarget{slot, shape, it->second.first, it->second.second,
                       blast_node};
}

void DestructionManager::queue_contact_at(const ContactTarget &target,
                                          FfiVec3 position, FfiVec3 impulse,
                                          bool wake) {
  ExtStressPhysXContact contact;
  contact.shape = target.shape;
  contact.nodeIndex = target.blast_node;
  contact.worldPosition = to_px(position);
  contact.worldImpulse = to_px(impulse);
  contact.wake = wake;
  target.slot->dest->queueContact(contact);
}

void DestructionManager::route_contact_shape(PxShape *shape, FfiVec3 position,
                                             FfiVec3 impulse, bool wake) {
  const ContactTarget target = resolve_contact_target(shape);
  if (!target) {
    return;
  }
  queue_contact_at(target, position, impulse, wake);
}

void DestructionManager::queue_chunk_damage(std::uint32_t structure_id,
                                            std::uint32_t chunk_id,
                                            FfiVec3 impulse, FfiVec3 point) {
  Slot *slot = find_slot(structure_id);
  require(slot != nullptr && slot->dest != nullptr, "unknown structure");
  const std::uint32_t node_index = chunk_id & kNodeIndexMask;
  std::vector<ExtStressPhysXShapeSnapshot> shapes(slot->node_descs.size());
  const std::uint32_t shape_count = slot->dest->getShapeSnapshots(
      shapes.data(), static_cast<std::uint32_t>(shapes.size()));
  for (std::uint32_t i = 0; i < shape_count; ++i) {
    if (shapes[i].nodeIndex == node_index && shapes[i].shape != nullptr) {
      slot->dest->queueContact(*shapes[i].shape, to_px(point), to_px(impulse));
      return;
    }
  }
  // Fallback: synthetic contact keyed by shapeId 0 is rejected; use any shape
  // near the node centroid if the exact shape was missing.
  throw std::runtime_error("chunk shape not found for damage");
}

std::uint32_t
DestructionManager::apply_destruction_explosion(FfiVec3 center, float radius,
                                                float impulse_magnitude) {
  require(radius > 0.0f, "explosion radius must be positive");
  const PxVec3 c = to_px(center);
  std::uint32_t affected = 0;
  for (auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    Slot &slot = *slot_ptr;
    std::vector<ExtStressPhysXShapeSnapshot> shapes(slot.node_descs.size() + 64);
    std::uint32_t shape_count = slot.dest->getShapeSnapshots(
        shapes.data(), static_cast<std::uint32_t>(shapes.size()));
    if (shape_count > shapes.size()) {
      shapes.resize(shape_count);
      shape_count = slot.dest->getShapeSnapshots(
          shapes.data(), static_cast<std::uint32_t>(shapes.size()));
    }
    // Legacy radial stress injection (smoke / grenade). Prefer
    // apply_destruction_blast for hitscan / rockets.
    for (std::uint32_t i = 0; i < shape_count; ++i) {
      const auto &shape = shapes[i];
      if (shape.shape == nullptr) {
        continue;
      }
      const PxVec3 offset = shape.worldPose.p - c;
      const float distance = offset.magnitude();
      if (distance > radius) {
        continue;
      }
      PxVec3 direction = distance > 1.0e-3f ? offset / distance : PxVec3(0, 1, 0);
      const float falloff = 1.0f - (distance / radius) * 0.5f;
      const PxVec3 impulse = direction * (impulse_magnitude * falloff);
      if (slot.dest->queueContact(*shape.shape, c, impulse)) {
        ++affected;
      }
    }
  }
  return affected;
}

std::uint32_t DestructionManager::apply_destruction_blast(
    FfiVec3 center, FfiVec3 direction, float radius, float stress_impulse,
    float push_impulse) {
  require(radius > 0.0f, "blast radius must be positive");
  const PxVec3 c = to_px(center);
  PxVec3 shot = to_px(direction);
  if (shot.magnitudeSquared() < 1.0e-8f) {
    shot = PxVec3(0.0f, 0.0f, 1.0f);
  } else {
    shot.normalize();
  }

  std::uint32_t affected = 0;

  for (auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    Slot &slot = *slot_ptr;
    std::vector<ExtStressPhysXShapeSnapshot> shapes(slot.node_descs.size() + 64);
    std::uint32_t shape_count = slot.dest->getShapeSnapshots(
        shapes.data(), static_cast<std::uint32_t>(shapes.size()));
    if (shape_count > shapes.size()) {
      shapes.resize(shape_count);
      shape_count = slot.dest->getShapeSnapshots(
          shapes.data(), static_cast<std::uint32_t>(shapes.size()));
    }

    // bodyId is only unique within one destructible.
    std::unordered_map<ExtStressPhysXId, ExtStressPhysXBodySnapshot> bodies_by_id;
    if (push_impulse > 0.0f) {
      std::vector<ExtStressPhysXBodySnapshot> bodies(slot.node_descs.size() + 64);
      std::uint32_t body_count = slot.dest->getBodySnapshots(
          bodies.data(), static_cast<std::uint32_t>(bodies.size()));
      if (body_count > bodies.size()) {
        bodies.resize(body_count);
        body_count = slot.dest->getBodySnapshots(
            bodies.data(), static_cast<std::uint32_t>(bodies.size()));
      }
      for (std::uint32_t i = 0; i < body_count; ++i) {
        if (bodies[i].body != nullptr) {
          bodies_by_id.emplace(bodies[i].bodyId, bodies[i]);
        }
      }
    }

    // Closest in-radius shape distance per dynamic body in this structure.
    std::unordered_map<physx::PxRigidDynamic *, float> push_distance;

    // 1) Directed stress at the impact point (no radial inflate).
    // 2) Mark dynamic bodies that own a shape inside the blast radius —
    //    island COM alone can sit outside the radius after a split.
    for (std::uint32_t i = 0; i < shape_count; ++i) {
      const auto &shape = shapes[i];
      if (shape.shape == nullptr) {
        continue;
      }
      const float distance = (shape.worldPose.p - c).magnitude();
      if (distance > radius) {
        continue;
      }
      if (stress_impulse > 0.0f) {
        const float falloff = 1.0f - (distance / radius);
        const float stress_scale = falloff * falloff;
        const PxVec3 stress = shot * (stress_impulse * stress_scale);
        if (slot.dest->queueContact(*shape.shape, c, stress)) {
          ++affected;
        }
      }
      if (push_impulse <= 0.0f || shape.bodyKinematic) {
        continue;
      }
      auto body_it = bodies_by_id.find(shape.bodyId);
      if (body_it == bodies_by_id.end() || body_it->second.body == nullptr ||
          body_it->second.kinematic) {
        continue;
      }
      auto inserted = push_distance.emplace(body_it->second.body, distance);
      if (!inserted.second) {
        inserted.first->second = std::min(inserted.first->second, distance);
      }
    }

    for (const auto &entry : push_distance) {
      physx::PxRigidDynamic *rigid = entry.first;
      const float distance = entry.second;
      const float falloff = 1.0f - (distance / radius);
      const PxVec3 offset = rigid->getGlobalPose().p - c;
      const float body_distance = offset.magnitude();
      PxVec3 radial = body_distance > 1.0e-3f ? offset / body_distance
                                              : PxVec3(0.0f, 1.0f, 0.0f);
      PxVec3 push_dir = shot * 0.85f + radial * 0.15f;
      if (push_dir.magnitudeSquared() < 1.0e-8f) {
        push_dir = shot;
      } else {
        push_dir.normalize();
      }
      // Velocity change at the centre of mass, not an impulse at the blast
      // point.
      //
      // An impulse divides by mass, so a blast tuned to nudge a 5 t slab gave
      // a 5 kg fragment 4000 m/s. And addForceAtPos with eVELOCITY_CHANGE is
      // worse than wrong: the helper turns the lever arm (blast centre - COM)
      // times the velocity change directly into rad/s of spin, so a 4 m lever
      // with a 12 m/s kick injected ~48 rad/s per shot -- measured stacking to
      // 448 rad/s, whose rim velocity became 900 m/s fragments at the next
      // split. An impulse physically acts on the body's surface, not at a
      // point in space beside it; rather than approximate that, the kick is a
      // bounded velocity change at the centre of mass and spin comes from
      // real contacts, which debris has no shortage of.
      const PxVec3 kick = push_dir * (push_impulse * falloff * falloff);
      rigid->addForce(kick, physx::PxForceMode::eVELOCITY_CHANGE, true);
      ++affected;
    }
  }
  return affected;
}

rust::Vec<FfiBrokenBondEvent> DestructionManager::take_broken_bonds() {
  rust::Vec<FfiBrokenBondEvent> out;
  out.reserve(broken_bonds_.size());
  for (const auto &event : broken_bonds_) {
    out.push_back(event);
  }
  broken_bonds_.clear();
  return out;
}

rust::Vec<FfiChunkMigrationEvent> DestructionManager::take_chunk_migrations() {
  rust::Vec<FfiChunkMigrationEvent> out;
  out.reserve(migrations_.size());
  for (const auto &event : migrations_) {
    out.push_back(event);
  }
  migrations_.clear();
  return out;
}

rust::Vec<FfiIslandBodyEvent> DestructionManager::take_island_events() {
  rust::Vec<FfiIslandBodyEvent> out;
  out.reserve(island_events_.size());
  for (const auto &event : island_events_) {
    out.push_back(event);
  }
  island_events_.clear();
  return out;
}

rust::Slice<const FfiChunkBodySnapshot>
DestructionManager::chunk_body_snapshots() const {
  auto &out = body_snapshot_buffer_;
  out.clear();
  // The buffer keeps its capacity between ticks, so after the first few this
  // reserve is a no-op and the whole function allocates nothing.
  std::size_t reserve_hint = 0;
  for (const auto &slot_ptr : slots_) {
    if (slot_ptr && slot_ptr->dest != nullptr) {
      reserve_hint += slot_ptr->body_cache_count;
    }
  }
  out.reserve(reserve_hint);
  // Which body produced each entity this tick. Two bodies landing on one
  // entity is the aliasing bug; recording both sides of the collision names
  // the mechanism (same structure or cross-structure, and which serials).
  // Cleared, not rebuilt: it keeps its buckets across ticks.
  auto &emitted = emitted_entities_;
  emitted.clear();
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    const Slot &slot = *slot_ptr;
    // Reuse this tick's readback. Called twice per tick from Rust.
    const auto &bodies = slot.body_cache;
    const std::uint32_t body_count = slot.body_cache_count;
    for (std::uint32_t i = 0; i < body_count; ++i) {
      const auto &body = bodies[i];
      if (body.kinematic) {
        continue;
      }
      auto serial_it = slot.body_to_serial.find(body.bodyId);
      if (serial_it == slot.body_to_serial.end()) {
        // Serial 0 is reserved for this structure's kinematic support body.
        // Defaulting an unmapped dynamic body to 0 aliased its network id onto
        // the support (and onto every other unmapped body), which produced
        // duplicate body entities in one datagram and killed the match loop on
        // the encoder's sorted-records assertion. Drop it and surface the
        // count instead: a missing serial is a mapping bug, not a body.
        ++unmapped_body_skips_;
        continue;
      }
      const std::uint32_t serial = serial_it->second;
      FfiChunkBodySnapshot snap{};
      snap.entity_id = pack_body_entity(slot.structure_id, serial);
      snap.structure_id = slot.structure_id;
      snap.island_id = serial;
      snap.position = from_px(com_world_position(body));
      snap.rotation = from_px(body.globalPose.q);
      snap.linear_velocity = from_px(body.linearVelocity);
      snap.angular_velocity = from_px(body.angularVelocity);
      snap.sleeping = body.sleeping;
      snap.kinematic = body.kinematic;
      snap.node_count = body.nodeCount;
      snap.flags = 0;
      auto claim = emitted.emplace(snap.entity_id,
                                   std::make_pair(slot.structure_id, body.bodyId));
      if (!claim.second) {
        ++aliased_body_entities_;
        if (aliased_body_entities_ <= 8) {
          std::fprintf(
              stderr,
              "[destruction] entity %#x claimed twice in one tick: "
              "structure %u body %llu serial %u  VS  structure %u body %llu\n",
              snap.entity_id, slot.structure_id,
              static_cast<unsigned long long>(body.bodyId), serial,
              claim.first->second.first,
              static_cast<unsigned long long>(claim.first->second.second));
        }
        continue;
      }
      out.push_back(snap);
    }
  }
  return rust::Slice<const FfiChunkBodySnapshot>(out.data(), out.size());
}

void DestructionManager::sleep_chunk_body(std::uint32_t entity_id) {
  require((entity_id & 0xf000'0000u) == kNsChunk, "not a chunk entity");
  // Must mirror pack_body_entity: 6 bits structure, 22 bits serial.
  const std::uint32_t structure_id = (entity_id & 0x0fff'ffffu) >> 22;
  const std::uint32_t serial = entity_id & 0x003f'ffffu;
  Slot *slot = find_slot(structure_id);
  require(slot != nullptr && slot->dest != nullptr, "unknown structure");
  std::vector<ExtStressPhysXBodySnapshot> bodies(slot->node_descs.size() + 64);
  std::uint32_t body_count = slot->dest->getBodySnapshots(
      bodies.data(), static_cast<std::uint32_t>(bodies.size()));
  if (body_count > bodies.size()) {
    bodies.resize(body_count);
    body_count = slot->dest->getBodySnapshots(
        bodies.data(), static_cast<std::uint32_t>(bodies.size()));
  }
  for (std::uint32_t i = 0; i < body_count; ++i) {
    auto serial_it = slot->body_to_serial.find(bodies[i].bodyId);
    if (serial_it != slot->body_to_serial.end() &&
        serial_it->second == serial && bodies[i].body != nullptr) {
      bodies[i].body->putToSleep();
      return;
    }
  }
}

namespace {

/// Unpack a chunk body entity. Must mirror pack_body_entity and
/// destruction/src/ids.rs: 6 bits of structure, 22 of island serial.
inline bool split_body_entity(std::uint32_t entity_id, std::uint32_t &structure_id,
                              std::uint32_t &serial) {
  if ((entity_id & 0xf000'0000u) != kNsChunk) {
    return false;
  }
  structure_id = (entity_id & 0x0fff'ffffu) >> 22;
  serial = entity_id & 0x003f'ffffu;
  return true;
}

} // namespace

std::uint32_t
DestructionManager::freeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids) {
  return set_chunk_bodies_kinematic(entity_ids, true);
}

std::uint32_t
DestructionManager::unfreeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids) {
  return set_chunk_bodies_kinematic(entity_ids, false);
}

namespace {

/// Put back to sleep every body a kinematic flip woke as collateral.
///
/// MEASURED (physx-bridge/tests/freeze_wake_semantics.rs::
/// `freezing_part_of_a_sleeping_pile_leaves_the_rest_asleep`): freezing ONE
/// body of a 24-body sleeping pile wakes the other 23 on the very next step
/// -- the rest of the island exactly. PhysX's island manager cannot remove a
/// node from an island without re-forming it, and it re-forms it AWAKE, so
/// `setRigidBodyFlag(eKINEMATIC)` is an island-wide wake, not a per-body
/// write.
///
/// This was invisible because the original claim-1 test
/// stepped 60 ticks before reading the awake count, and PhysX's wake counter
/// is 0.4 s -- 24 ticks at 60 Hz. The pile woke, stayed awake for 24 ticks,
/// and re-slept, all inside the test's blind window. Measure the tick the
/// flip lands on, never later.
///
/// The production consequence is the never-settles bug: the freeze pass runs
/// every tick, so every tick's batch re-woke the whole pile and reset its
/// 24-tick wake counter. The pile could never accumulate the quiet needed to
/// stay asleep, and players saw it hop forever. Freeze was waking the debris
/// it was retiring.
///
/// The repair restores the invariant the flip breaks: bodies that were asleep
/// before the batch, were not themselves flipped, and are still dynamic are
/// put straight back to sleep. It is not a cap and it does not fight the
/// engine -- these bodies were at rest by the engine's own judgement one
/// instant earlier, and nothing physical happened in between.
///
/// Legitimate wakes are untouched. Contact wakes and blast impulses run
/// earlier in the same tick and set the awake flag synchronously, so those
/// bodies never enter the recorded set; and an island that still holds a
/// genuinely active body reactivates on the next step regardless, which is
/// also why this is stable rather than a fight with the engine.
///
/// COST: one pass over the structure's bodies plus one `putToSleep` per
/// sleeping body, per call that actually flips something. Measured at ~2.2k
/// bodies through `full_demolition_cost` as no change in tick p50. The
/// cascade paths in runtime.rs call unfreeze once per cascade level, so a
/// deep cascade pays this several times in one tick; if that ever shows in a
/// profile, batch it to once per tick (all flips in a tick land between the
/// same pair of `simulate()` calls, so a single flush at the end is
/// equivalent).
///
/// The write is UNCONDITIONAL on the recorded sleepers, and it has to be:
/// `isSleeping()` still reports true immediately after the flip (Np's copy of
/// the sleep state only refreshes at fetchResults), so the woken set is not
/// yet distinguishable on the host. `putToSleep()` reaches the island node
/// directly, which is why issuing it before the next `simulate()` cancels the
/// activation rather than racing it.
///
/// `VIBE_FREEZE_ISLAND_RESLEEP=0` disables it, for bisecting a regression
/// against the old behaviour without a rebuild.
bool freeze_island_resleep() {
  static const bool value = [] {
    const char *raw = std::getenv("VIBE_FREEZE_ISLAND_RESLEEP");
    return raw == nullptr || std::atoi(raw) != 0;
  }();
  return value;
}

/// XZ cell key for the frozen clusters. Y does not partition: piles are
/// ground-level, and a vertical split would only spread one pile's bodies
/// across more aggregates.
std::uint64_t frozen_agg_cell_key(float x, float z, float cell) {
  const auto qx = static_cast<std::int32_t>(std::floor(x / cell));
  const auto qz = static_cast<std::int32_t>(std::floor(z / cell));
  return (static_cast<std::uint64_t>(static_cast<std::uint32_t>(qx)) << 32)
       | static_cast<std::uint64_t>(static_cast<std::uint32_t>(qz));
}

} // namespace

physx::PxAggregate *DestructionManager::frozen_aggregate_for(
    float x, float z, std::uint32_t shapes) {
  auto &cell = frozen_agg_cells_[frozen_agg_cell_key(x, z, freeze_aggregate_cell_m())];
  for (physx::PxAggregate *candidate : cell) {
    if (candidate->getNbActors() < kFrozenAggMaxActors
        && frozen_agg_shapes_[candidate] + shapes <= kFrozenAggMaxShapes) {
      return candidate;
    }
  }
  physx::PxAggregate *fresh = nullptr;
  if (!frozen_agg_pool_.empty()) {
    fresh = frozen_agg_pool_.back();
    frozen_agg_pool_.pop_back();
  } else {
    // eKINEMATIC, self-collision off: members are kinematic and mutually at
    // rest, so no internal pairs existed to lose — and the kinematic type
    // hint lets the broadphase cull pairs BETWEEN neighbouring frozen
    // clusters wholesale.
    fresh = physics_.createAggregate(
        kFrozenAggMaxActors, kFrozenAggMaxShapes,
        physx::PxGetAggregateFilterHint(physx::PxAggregateType::eKINEMATIC, false));
    if (fresh == nullptr) {
      return nullptr;
    }
  }
  scene_.addAggregate(*fresh);
  frozen_agg_shapes_[fresh] = 0;
  cell.push_back(fresh);
  return fresh;
}

void DestructionManager::frozen_aggregate_insert(physx::PxRigidDynamic &body) {
  if (body.getAggregate() != nullptr || body.getScene() == nullptr) {
    return;
  }
  const std::uint32_t shapes = body.getNbShapes();
  if (shapes > kFrozenAggMaxShapes) {
    // A body bigger than a whole aggregate stays a standalone actor.
    ++frozen_agg_fallbacks_;
    return;
  }
  const physx::PxVec3 position = body.getGlobalPose().p;
  physx::PxAggregate *aggregate =
      frozen_aggregate_for(position.x, position.z, shapes);
  if (aggregate == nullptr) {
    ++frozen_agg_fallbacks_;
    return;
  }
  // wakeOnLostTouch=false, and it matters: the body is not leaving the world,
  // it is re-entering one aggregate away at the same pose. The default (true)
  // refreshed the wake counter of everything the frozen body touched — the
  // same island-wide wake the kinematic flip already fights — and measured as
  // T4 awake-decline slipping from 0.09 to 0.11 across the gate band.
  scene_.removeActor(body, /*wakeOnLostTouch=*/false);
  if (!aggregate->addActor(body)) {
    // Refused (capacity race with a body PhysX released this tick) — the
    // body must not be left sceneless over it.
    scene_.addActor(body);
    ++frozen_agg_fallbacks_;
    return;
  }
  frozen_agg_shapes_[aggregate] += shapes;
  ++frozen_agg_inserts_;
}

void DestructionManager::frozen_aggregate_extract(physx::PxRigidDynamic &body) {
  physx::PxAggregate *aggregate = body.getAggregate();
  if (aggregate == nullptr) {
    return;
  }
  const std::uint32_t shapes = body.getNbShapes();
  // removeActor reinserts the actor into the aggregate's scene itself; adding
  // it again here would double-insert.
  aggregate->removeActor(body);
  auto shadow = frozen_agg_shapes_.find(aggregate);
  if (shadow != frozen_agg_shapes_.end()) {
    shadow->second -= std::min(shadow->second, shapes);
  }
  ++frozen_agg_extracts_;
  frozen_aggregate_maybe_retire(aggregate);
}

void DestructionManager::frozen_aggregate_maybe_retire(physx::PxAggregate *aggregate) {
  // Lazy: only an EMPTY aggregate is retired. Merging a half-empty cluster's
  // members into siblings would re-run broadphase insertion for every one of
  // them at the churn rate of the pile margin — the thing this whole scheme
  // exists to avoid. Half-empty aggregates refill from the same cell instead
  // (frozen_aggregate_for prefers existing aggregates with headroom).
  if (aggregate->getNbActors() != 0) {
    return;
  }
  // Empty by the check above — no member pairs exist to lose, but say so.
  scene_.removeAggregate(*aggregate, /*wakeOnLostTouch=*/false);
  frozen_agg_shapes_.erase(aggregate);
  for (auto &entry : frozen_agg_cells_) {
    auto &list = entry.second;
    list.erase(std::remove(list.begin(), list.end(), aggregate), list.end());
  }
  ++frozen_agg_retired_;
  if (frozen_agg_pool_.size() < kFrozenAggPoolCap) {
    frozen_agg_pool_.push_back(aggregate);
  } else {
    aggregate->release();
  }
}

void DestructionManager::frozen_aggregates_release_all() {
  for (auto &entry : frozen_agg_cells_) {
    for (physx::PxAggregate *aggregate : entry.second) {
      // Actors still inside go back to the scene; their owner (the adapter)
      // releases them on its own terms.
      std::vector<physx::PxActor *> actors(aggregate->getNbActors());
      if (!actors.empty()) {
        aggregate->getActors(actors.data(), static_cast<physx::PxU32>(actors.size()));
        for (physx::PxActor *actor : actors) {
          aggregate->removeActor(*actor);
        }
      }
      scene_.removeAggregate(*aggregate, /*wakeOnLostTouch=*/false);
      aggregate->release();
    }
  }
  frozen_agg_cells_.clear();
  frozen_agg_shapes_.clear();
  for (physx::PxAggregate *aggregate : frozen_agg_pool_) {
    aggregate->release();
  }
  frozen_agg_pool_.clear();
}

std::uint32_t DestructionManager::set_chunk_bodies_kinematic(
    rust::Slice<const std::uint32_t> entity_ids, bool kinematic) {
  if (entity_ids.empty()) {
    return 0;
  }
  // Group by structure so each slot's serial -> body index is built once.
  // sleep_chunk_body's per-call getBodySnapshots scan is O(bodies) per body,
  // which at a 6,000-body wake would be 36 million lookups; the per-tick
  // body_cache already holds everything this needs.
  std::unordered_map<std::uint32_t, std::vector<std::uint32_t>> by_structure;
  for (std::uint32_t entity : entity_ids) {
    std::uint32_t structure_id = 0;
    std::uint32_t serial = 0;
    if (!split_body_entity(entity, structure_id, serial)) {
      continue;
    }
    by_structure[structure_id].push_back(serial);
  }

  std::uint32_t changed = 0;
  for (auto &entry : by_structure) {
    Slot *slot = find_slot(entry.first);
    if (slot == nullptr || slot->dest == nullptr) {
      continue;
    }
    std::unordered_map<std::uint32_t, const ExtStressPhysXBodySnapshot *> by_serial;
    by_serial.reserve(slot->body_cache_count);
    for (std::uint32_t i = 0; i < slot->body_cache_count; ++i) {
      const auto &body = slot->body_cache[i];
      auto serial_it = slot->body_to_serial.find(body.bodyId);
      if (serial_it == slot->body_to_serial.end()) {
        continue;
      }
      by_serial[serial_it->second] = &body;
    }
    // Who the engine had asleep in this structure immediately before the
    // batch. Taken lazily, on the first flip that actually happens, so a call
    // that changes nothing costs nothing. See `freeze_island_resleep`.
    const bool resleep = freeze_island_resleep();
    std::vector<PxRigidDynamic *> sleepers;
    bool sleepers_taken = false;
    auto take_sleepers = [&]() {
      if (sleepers_taken) {
        return;
      }
      sleepers_taken = true;
      sleepers.reserve(slot->body_cache_count);
      for (std::uint32_t i = 0; i < slot->body_cache_count; ++i) {
        PxRigidDynamic *b = slot->body_cache[i].body;
        if (b == nullptr ||
            b->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC) ||
            !b->isSleeping()) {
          continue;
        }
        sleepers.push_back(b);
      }
    };

    for (std::uint32_t serial : entry.second) {
      // The adapter's own kinematic bodies -- the intact support actor and
      // every rooted fragment -- are not ours to touch: unfreezing one would
      // turn a standing building (or its stump) into free-falling debris.
      // Class-based, not serial-based: rooted fragments hold REAL serials
      // now, so "serial 0" stopped covering them. Counted, because a caller
      // naming a rooted body is a bug upstream.
      if (serial == kSupportIslandSerial) {
        continue;
      }
      auto found = by_serial.find(serial);
      if (found == by_serial.end() || found->second->body == nullptr) {
        continue;
      }
      PxRigidDynamic *body = found->second->body;
      const ExtStressPhysXId body_id = found->second->bodyId;
      if (slot->rooted.count(body_id) != 0) {
        ++rooted_guard_blocks_;
        continue;
      }
      const bool already =
          body->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC);
      if (already == kinematic) {
        // Keep the sets honest even when the flag needed no change.
        if (kinematic) {
          slot->frozen.insert(body_id);
          frozen_entities_.insert(pack_body_entity(entry.first, serial));
        } else {
          slot->frozen.erase(body_id);
          frozen_entities_.erase(pack_body_entity(entry.first, serial));
        }
        continue;
      }
      const std::uint32_t entity = pack_body_entity(entry.first, serial);
      if (resleep) {
        take_sleepers();
      }
      body->setRigidBodyFlag(PxRigidBodyFlag::eKINEMATIC, kinematic);
      if (kinematic) {
        slot->frozen.insert(body_id);
        frozen_entities_.insert(entity);
        if (freeze_remove_from_scene() && body->getScene() != nullptr) {
          // Measuring mode wins over clustering; the two are exclusive.
          scene_.removeActor(*body);
        } else if (freeze_aggregate_enabled()) {
          frozen_aggregate_insert(*body);
        }
        ++freeze_flips_;
      } else {
        if (freeze_remove_from_scene() && body->getScene() == nullptr) {
          // Back in the scene before the wake below — waking a sceneless
          // actor is undefined.
          scene_.addActor(*body);
        } else if (freeze_aggregate_enabled()) {
          // Also before the wake below: removeActor reinserts the body into
          // the scene as a standalone actor, which the wake requires.
          frozen_aggregate_extract(*body);
        }
        slot->frozen.erase(body_id);
        frozen_entities_.erase(entity);
        // PhysX zeroes velocities across the dynamic transition, so the body
        // returns exactly at its frozen pose and at rest. The impulse that
        // released it arrives from the caller's deferred push pass on the next
        // tick, once the body is dynamic and no longer skipped for being
        // kinematic. Waking explicitly because a body restored as dynamic can
        // otherwise come back asleep and ignore that push.
        body->wakeUp();
        ++unfreeze_flips_;
      }
      ++changed;
    }
    // Undo the island-wide wake the flips just caused. A body only qualifies
    // if the engine had it asleep before the batch and it is still dynamic,
    // so a body that was flipped (now kinematic) or was already awake is
    // never touched.
    for (PxRigidDynamic *sleeper : sleepers) {
      if (sleeper->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC)) {
        continue;
      }
      sleeper->putToSleep();
      ++island_resleep_writes_;
    }
  }
  return changed;
}

namespace {

/// Impulse-to-resting-load ratio above which a contact releases a frozen
/// body. A striker resting under gravity delivers exactly m*g*dt per step
/// (ratio 1), so the ratio measures "how much harder than lying still is
/// this touch" independent of chunk mass -- the same test works for a 40 kg
/// panel and a 4 t slab. 4 corresponds to an impact at roughly 0.7 m/s.
/// 0 disables contact wakes entirely.
///
/// KNOWN DEFECT: the reference load is ONE body lying still, but a body inside
/// a pile carries the accumulated weight of everything above it. A chunk under
/// five others receives ~5x m*g*dt of contact impulse while perfectly at rest,
/// so it scores ratio 5, exceeds this threshold of 4, and is released -- every
/// tick, forever. The test cannot distinguish "something hit me" from "I am
/// buried", which is the normal state of rubble.
///
/// Measured on the demolished-tower bench (freeze on, production terrain):
///
///   ratio 4 (default)  ->  280 awake non-kinematic bodies
///   ratio 0 (disabled) ->    1
///
/// That is the whole never-settles bug. The awake bodies are not moving --
/// p50 0.033 m/s, ~90x under the sleep threshold -- they are eligible to
/// settle and are being released from freeze by their own neighbours' weight.
///
/// The fix is to compare against the load this body actually bears at rest,
/// not against a single body's, so that being buried is not mistaken for being
/// struck. Raising the ratio only moves the pile depth at which it misfires.
/// How far above its own steady load a contact must spike to wake a frozen body.
///
/// 2 means "twice what you are already carrying". Independent of burial depth,
/// which is the entire point: a fixed multiple of one striker's weight is not.
constexpr float kContactSpikeRatio = 2.0f;

/// How fast the steady-load estimate follows a change. Slow enough that an
/// impact does not get absorbed into the baseline before it can be detected.
constexpr float kContactBaselineAlpha = 0.05f;

/// World gravity, not Earth's.
///
/// Both halves of the resting-load model compare an impulse against what a body
/// weighs at rest, so both have to use the gravity bodies actually fall under.
/// note_contact_pair was fixed to read this and resolve_support_loads was not,
/// so with the world at 20 m/s^2 the support side's reference load was 49% of
/// the real one -- one load model, two gravities, differing by 2x.
///
/// The direction matters: too small a reference makes the weight-bearing gate
/// fire on half the load it should, which makes a body carrying weight look
/// unsupported, and an unsupported body is one freeze refuses to retire.
float world_gravity() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_WORLD_GRAVITY")) {
      const float parsed = static_cast<float>(std::fabs(std::atof(raw)));
      if (parsed > 0.0f) {
        return parsed;
      }
    }
    return 20.0f;
  }();
  return value;
}

float contact_wake_ratio() {
  static const float value = [] {
    if (const char *raw = std::getenv("VIBE_CITY_CONTACT_WAKE_RATIO")) {
      return static_cast<float>(std::atof(raw));
    }
    return 4.0f;
  }();
  return value;
}

} // namespace

void DestructionManager::note_contact_pair(std::uint32_t entity_a,
                                           std::uint32_t entity_b,
                                           float mass_a, float mass_b,
                                           float impulse) {
  const float ratio = contact_wake_ratio();
  if (ratio <= 0.0f || frozen_entities_.empty() || impulse <= 0.0f) {
    return;
  }
  // Accumulate only. The judgement moved to the per-tick drain: a buried
  // body's resting load arrives as SEVERAL pair impulses per tick — the big
  // column above plus small side touches — and judging (and learning the
  // baseline from) each pair alone let the small pairs drag the baseline
  // down between big-pair arrivals, so the steady column load read as a 2x
  // "spike" every tick. Freeze/thaw churn of tens of thousands of near-equal
  // flips, and debris visibly bouncing red before it could stay blue, was
  // this per-pair judgement. The body's load is the SUM over its pairs; only
  // the sum can be compared against what it was carrying yesterday.
  const auto consider = [&](std::uint32_t entity, float striker_mass) {
    if (striker_mass <= 0.0f) {
      return; // struck by a static or kinematic: no resting load to compare.
    }
    if (frozen_entities_.find(entity) == frozen_entities_.end()) {
      return;
    }
    contact_tick_load_[entity] += impulse;
    auto &strongest = contact_tick_striker_[entity];
    strongest = std::max(strongest, striker_mass);
  };
  consider(entity_a, mass_b);
  consider(entity_b, mass_a);
}

/// Judge the tick's accumulated contact load per frozen body — see
/// note_contact_pair for why this cannot happen per pair.
void DestructionManager::resolve_frozen_contact_wakes() {
  if (contact_tick_load_.empty()) {
    return;
  }
  const float ratio = contact_wake_ratio();
  const float g_dt = world_gravity() * (last_dt_ > 0.0f ? last_dt_ : 1.0f / 60.0f);
  // Sorted so wake order does not depend on hash-map iteration.
  std::vector<std::uint32_t> entities;
  entities.reserve(contact_tick_load_.size());
  for (const auto &entry : contact_tick_load_) {
    entities.push_back(entry.first);
  }
  std::sort(entities.begin(), entities.end());
  for (const std::uint32_t entity : entities) {
    const float total = contact_tick_load_[entity];
    // Two references, and the wake needs to clear BOTH.
    //
    // The single-body floor stops trivia waking anything: it is the heaviest
    // single striker's own resting weight, times the ratio — for a lone body
    // landing on the pile this reduces exactly to the original test. The
    // baseline is what makes burial survivable: being buried is a steady
    // load; being struck is a spike above whatever you were already carrying.
    const float floor = ratio * contact_tick_striker_[entity] * g_dt;
    auto &baseline = contact_load_baseline_[entity];
    if (baseline <= 0.0f) {
      // Seed so the FIRST tick behaves as the original test: threshold ==
      // floor. Seeding from the observed load instead would read a
      // first-contact impact as resting load and never wake — which broke
      // debris_landing_on_frozen_rubble_releases_it_by_contact. The baseline
      // may only rise from loads that were judged to be at rest.
      baseline = floor / kContactSpikeRatio;
    }
    const float threshold = std::max(floor, baseline * kContactSpikeRatio);
    if (total < threshold) {
      // The load it bears at rest. Rising slowly (more debris settling on
      // top) must not read as an impact, so the baseline follows the SUM.
      baseline += kContactBaselineAlpha * (total - baseline);
      continue;
    }
    // A real spike. Forget the baseline so the body re-learns its load once
    // it settles again, rather than inheriting a stale one from the hit.
    contact_load_baseline_.erase(entity);
    if (contact_wake_pending_.insert(entity).second) {
      contact_wake_order_.push_back(entity);
      ++contact_wakes_;
    }
  }
  contact_tick_load_.clear();
  contact_tick_striker_.clear();
}

DestructionManager::PendingPairSide
DestructionManager::resolve_pair_side(const PxShape *shape,
                                      const PxActor *actor) {
  PendingPairSide side{};
  const auto owner = shape_owners_.find(shape);
  if (owner != shape_owners_.end()) {
    side.is_chunk = true;
    side.structure_id = owner->second.first;
    side.node_index = owner->second.second;
    // node -> body from the LAST topology registration: exactly the
    // configuration the physics step (and therefore this contact) ran
    // against. If fracture moves the node this tick, the impulse was
    // still exchanged with the old body.
    if (const Slot *slot = find_slot(side.structure_id)) {
      const auto body = slot->node_to_body.find(side.node_index);
      if (body != slot->node_to_body.end()) {
        side.body_id = body->second;
      } else {
        side.is_chunk = false; // unmapped: treat as foreign, blocks freezing
      }
    } else {
      side.is_chunk = false;
    }
    return side;
  }
  // Non-chunk. Static geometry is immutable and needs no events; anything
  // else that can touch debris (players, vehicles, props) is movable and
  // NOT event-observable, so it must block freezing.
  side.is_static =
      actor != nullptr && actor->is<physx::PxRigidStatic>() != nullptr;
  return side;
}

void DestructionManager::note_ground_touch(const PendingPairLoad &load) {
  if (!settle_assist_enabled()) {
    return;
  }
  // Exactly one chunk against static world geometry. Chunk-on-chunk says
  // nothing about having landed, and the is_static flag is already computed
  // by resolve_pair_side for the support graph -- this rides along free.
  const PendingPairSide *chunk = nullptr;
  if (load.a.is_chunk && load.b.is_static) {
    chunk = &load.a;
  } else if (load.b.is_chunk && load.a.is_static) {
    chunk = &load.b;
  }
  if (chunk == nullptr) {
    return;
  }
  if (ground_touched_.insert(support_key(chunk->structure_id, chunk->body_id))
          .second) {
    ++ground_touch_latches_;
  }
}

void DestructionManager::note_pair_load(const PxShape *shape_a,
                                        const PxShape *shape_b,
                                        const PxActor *actor_a,
                                        const PxActor *actor_b,
                                        float sum_abs_impulse_y,
                                        float min_separation) {
  if (sum_abs_impulse_y <= 0.0f) {
    return;
  }
  PendingPairLoad load{};
  load.a = resolve_pair_side(shape_a, actor_a);
  load.b = resolve_pair_side(shape_b, actor_b);
  if (!load.a.is_chunk && !load.b.is_chunk) {
    return; // no debris involved; not our concern
  }
  load.sum_abs_impulse_y = sum_abs_impulse_y;
  load.min_separation = min_separation;
  note_ground_touch(load);
  pending_pair_loads_.push_back(load);
}

void DestructionManager::note_pair_load(const ContactTarget &target_a,
                                        const ContactTarget &target_b,
                                        const PxShape *shape_a,
                                        const PxShape *shape_b,
                                        const PxActor *actor_a,
                                        const PxActor *actor_b,
                                        float sum_abs_impulse_y,
                                        float min_separation) {
  if (sum_abs_impulse_y <= 0.0f) {
    return;
  }
  // A non-null target already paid shape_owners_.find + find_slot in
  // resolve_contact_target this manifold; reuse it. node_to_body still runs
  // here — it is the one lookup the target does not carry, and it must read
  // the same registration the original path reads.
  const auto from_target = [this](const ContactTarget &target,
                                  const PxShape *shape,
                                  const PxActor *actor) -> PendingPairSide {
    if (!target) {
      return resolve_pair_side(shape, actor);
    }
    PendingPairSide side{};
    side.is_chunk = true;
    side.structure_id = target.structure_id;
    side.node_index = target.node_index;
    const auto body = target.slot->node_to_body.find(target.node_index);
    if (body != target.slot->node_to_body.end()) {
      side.body_id = body->second;
    } else {
      side.is_chunk = false; // unmapped: treat as foreign, blocks freezing
    }
    return side;
  };
  PendingPairLoad load{};
  load.a = from_target(target_a, shape_a, actor_a);
  load.b = from_target(target_b, shape_b, actor_b);
  if (!load.a.is_chunk && !load.b.is_chunk) {
    return; // no debris involved; not our concern
  }
  load.sum_abs_impulse_y = sum_abs_impulse_y;
  load.min_separation = min_separation;
  note_ground_touch(load);
  pending_pair_loads_.push_back(load);
}

void DestructionManager::resolve_support_loads() {
  ++tick_count_;
  if (pending_pair_loads_.empty()) {
    return;
  }
  // How much harder than "lying still" a contact must press, vertically, to
  // count as weight-bearing. A supporter carrying a body's full weight
  // delivers m*g*dt per step; several sharing it deliver fractions, so the
  // ratio sits well under 1.
  static const float fy_ratio = [] {
    if (const char *raw = std::getenv("VIBE_CITY_SUPPORT_FY_RATIO")) {
      return static_cast<float>(std::atof(raw));
    }
    return 0.2f;
  }();
  // Pairs stop reporting when they sleep, so entries age only against ticks
  // where the dependent was awake and reporting SOMETHING (its
  // last_report_tick moves). This constant bounds how long a broken contact
  // lingers while its body is still awake.
  static const std::uint64_t age_ticks = [] {
    if (const char *raw = std::getenv("VIBE_CITY_SUPPORT_AGE_TICKS")) {
      return static_cast<std::uint64_t>(std::atoll(raw));
    }
    return static_cast<std::uint64_t>(10);
  }();
  // Was 9.81 while note_contact_pair used world gravity. See world_gravity().
  const float g_dt = world_gravity() * (last_dt_ > 0.0f ? last_dt_ : 1.0f / 60.0f);

  // A/B switch for the lookup strategy. Same binary, same scene, same shot
  // plan -- the only way to compare these two honestly, because GPU
  // non-determinism moves damage (and therefore contact count) 10-15% run to
  // run, and support-load cost tracks contacts, not wall time.
  static const bool use_row_map = [] {
    const char *raw = std::getenv("VIBE_CITY_SUPPORT_ROW_MAP");
    return raw != nullptr && std::string(raw) != "0";
  }();
  std::unordered_map<const Slot *,
                     std::unordered_map<ExtStressPhysXId, const ExtStressPhysXBodySnapshot *>>
      row_maps;

  // bodyId -> cache row. getBodySnapshots returns rows ascending by bodyId
  // (see refresh_snapshots, which both documents and now verifies it), so this
  // is a binary search over the existing cache.
  //
  // It used to build a whole-population unordered_map PER SLOT PER TICK and
  // throw it away -- O(live bodies) of hashing and allocation every tick, for
  // lookups that the cache's own ordering already answers. That rebuild sat
  // inside the stress_solve_ms bracket with no timer of its own, so it was
  // invisible except as the gap between the native tick and the sum of its
  // phases, and it was the dominant term in that gap (measured: ~0.6 ms of a
  // ~0.65 ms gap at 3k bodies, and it grows linearly with body count).
  const auto body_row_in = [&](const Slot &slot_ref, std::uint64_t body_id)
      -> const ExtStressPhysXBodySnapshot * {
    const Slot *slot = &slot_ref;
    const std::uint32_t count =
        std::min<std::uint32_t>(slot->body_cache_count,
                                static_cast<std::uint32_t>(slot->body_cache.size()));
    if (use_row_map) {
      auto &rows = row_maps[slot];
      if (rows.empty()) {
        rows.reserve(count);
        for (std::uint32_t i = 0; i < count; ++i) {
          rows[slot->body_cache[i].bodyId] = &slot->body_cache[i];
        }
      }
      const auto found = rows.find(body_id);
      return found != rows.end() ? found->second : nullptr;
    }
    if (slot->body_cache_sorted) {
      std::uint32_t lo = 0;
      std::uint32_t hi = count;
      while (lo < hi) {
        const std::uint32_t mid = lo + (hi - lo) / 2;
        const auto mid_id = slot->body_cache[mid].bodyId;
        if (mid_id == body_id) {
          return &slot->body_cache[mid];
        }
        if (mid_id < body_id) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return nullptr;
    }
    // Ordering invariant violated: fall back rather than lose supporter edges.
    for (std::uint32_t i = 0; i < count; ++i) {
      if (slot->body_cache[i].bodyId == body_id) {
        return &slot->body_cache[i];
      }
    }
    return nullptr;
  };

  last_support_pair_loads_ =
      static_cast<std::uint32_t>(pending_pair_loads_.size());
  std::unordered_set<std::uint64_t> touched;

  // Work out which side depends on which. Kinematic and non-chunk sides
  // never depend on debris; between two dynamics the higher centre of
  // mass depends on the lower (ties carry no information -- skip).
  struct Resolved {
    bool chunk = false;
    bool kinematic = false;
    bool frozen = false;
    bool rooted = false;
    float com_y = 0.0f;
    float mass = 0.0f;
    std::uint32_t serial = 0;
    const PendingPairSide *side = nullptr;
  };
  const auto classify = [&](const PendingPairSide &side) -> Resolved {
    Resolved out{};
    out.side = &side;
    if (!side.is_chunk) {
      return out;
    }
    // One slot resolution per side. body_row re-resolved the slot
    // internally, making four linear scans per pair -- free at one
    // structure, dominant at a multi-structure grid.
    const Slot *slot = find_slot(side.structure_id);
    const ExtStressPhysXBodySnapshot *row =
        slot != nullptr ? body_row_in(*slot, side.body_id) : nullptr;
    if (slot == nullptr || row == nullptr) {
      return out; // body died this tick; retire/promote events cover it
    }
    const auto serial_it = slot->body_to_serial.find(side.body_id);
    if (serial_it == slot->body_to_serial.end()) {
      return out;
    }
    out.chunk = true;
    out.kinematic = row->kinematic;
    out.frozen = slot->frozen.count(side.body_id) != 0;
    out.rooted = slot->rooted.count(side.body_id) != 0;
    out.com_y = com_world_position(*row).y;
    // Cached at mass-recompute time by the library. The live getMass here
    // was ~52k PhysX reads per tick at a 7.9k-awake peak.
    out.mass = row->mass;
    out.serial = serial_it->second;
    return out;
  };

  // Pair -> (Resolved, Resolved) is pure lookups over state nothing mutates
  // during this phase, so it fans out across the stress pool; the ingest
  // below stays serial and walks the results in original pair order, so the
  // supporter store is byte-identical to the single-threaded walk. This was
  // 4.7-6.1 ms of serial wall per tick at 20k pairs, all of it here.
  //
  // The row_map A/B path builds its per-slot map lazily inside body_row_in,
  // which is a shared-map write; warm every slot serially first so the
  // parallel phase only ever reads it.
  const std::size_t load_count = pending_pair_loads_.size();
  std::vector<std::pair<Resolved, Resolved>> resolved(load_count);
  const unsigned pool = stress_executor_ ? stress_executor_->parallelism() : 1;
  // Below this the fan-out costs more than the walk. Measured live, same
  // session, same build: 16.7k pairs ran at 0.186 us/pair parallel (vs the
  // pre-change serial 0.226), but 5.7k pairs ran at 0.337 us/pair -- WORSE
  // than serial, all of it fan-out overhead. The crossover sits near 10k.
  constexpr std::size_t kParallelLoadFloor = 10000;
  if (pool > 1 && load_count >= kParallelLoadFloor) {
    if (use_row_map) {
      for (const PendingPairLoad &load : pending_pair_loads_) {
        for (const PendingPairSide *side : {&load.a, &load.b}) {
          if (side->is_chunk) {
            if (const Slot *slot = find_slot(side->structure_id)) {
              (void)body_row_in(*slot, side->body_id);
            }
          }
        }
      }
    }
    const std::size_t strips = pool;
    const std::size_t strip_len = (load_count + strips - 1) / strips;
    stress_executor_->run(strips, [&](std::size_t strip) {
      const std::size_t begin = strip * strip_len;
      const std::size_t end = std::min(load_count, begin + strip_len);
      for (std::size_t i = begin; i < end; ++i) {
        resolved[i].first = classify(pending_pair_loads_[i].a);
        resolved[i].second = classify(pending_pair_loads_[i].b);
      }
    });
  } else {
    for (std::size_t i = 0; i < load_count; ++i) {
      resolved[i].first = classify(pending_pair_loads_[i].a);
      resolved[i].second = classify(pending_pair_loads_[i].b);
    }
  }

  for (std::size_t load_index = 0; load_index < load_count; ++load_index) {
    const PendingPairLoad &load = pending_pair_loads_[load_index];
    const Resolved &a = resolved[load_index].first;
    const Resolved &b = resolved[load_index].second;

    const auto record = [&](const Resolved &dependent, const Resolved &supporter) {
      if (!dependent.chunk || dependent.kinematic) {
        return; // kinematic bodies (frozen or rooted) depend on nothing
      }
      SupporterRec rec{};
      if (!supporter.chunk) {
        rec.kind = supporter.side->is_static ? 0 : 1; // World : Foreign
      } else if (supporter.rooted) {
        rec.kind = 2;
        rec.entity = pack_body_entity(supporter.side->structure_id, supporter.serial);
        rec.node = supporter.side->node_index;
      } else {
        rec.kind = 3; // another debris body, frozen or dynamic
        rec.entity = pack_body_entity(supporter.side->structure_id, supporter.serial);
      }
      const std::uint64_t key =
          support_key(dependent.side->structure_id, dependent.side->body_id);
      DependentEntry &entry = support_store_[key];
      entry.entity = pack_body_entity(dependent.side->structure_id, dependent.serial);
      if (entry.last_report_tick != tick_count_) {
        entry.min_separation = load.min_separation;
      } else if (load.min_separation < entry.min_separation) {
        entry.min_separation = load.min_separation;
      }
      if (entry.min_separation != entry.min_separation) {
        entry.min_separation = 0.0f; // NaN guard
      }
      entry.last_report_tick = tick_count_;
      touched.insert(key);
      entry.dirty = true;
      // Weight-bearing gate, scaled to the DEPENDENT's own resting load.
      if (load.sum_abs_impulse_y < fy_ratio * dependent.mass * g_dt) {
        return;
      }
      for (SupporterRec &existing : entry.supporters) {
        if (existing.kind == rec.kind && existing.entity == rec.entity &&
            existing.node == rec.node) {
          existing.last_tick = tick_count_;
          return;
        }
      }
      rec.last_tick = tick_count_;
      entry.supporters.push_back(rec);
      entry.dirty = true;
    };

    if (a.chunk && b.chunk && !a.kinematic && !b.kinematic) {
      // Two dynamics: strictly lower centre of mass supports the higher.
      if (a.com_y < b.com_y) {
        record(b, a);
      } else if (b.com_y < a.com_y) {
        record(a, b);
      }
    } else {
      record(a, b);
      record(b, a);
    }
  }
  pending_pair_loads_.clear();

  // Age out contacts that stopped reporting while their dependent kept
  // reporting others, and stage dirty sets for the drain.
  for (const std::uint64_t key : touched) {
    auto entry_it = support_store_.find(key);
    if (entry_it == support_store_.end()) {
      continue;
    }
    DependentEntry &entry = entry_it->second;
    const std::size_t before = entry.supporters.size();
    entry.supporters.erase(
        std::remove_if(entry.supporters.begin(), entry.supporters.end(),
                       [&](const SupporterRec &rec) {
                         return entry.last_report_tick - rec.last_tick > age_ticks;
                       }),
        entry.supporters.end());
    if (entry.supporters.size() != before) {
      entry.dirty = true;
    }
    if (entry.dirty) {
      FfiSupportSet set{};
      set.dependent_entity = entry.entity;
      set.last_report_tick = entry.last_report_tick;
      set.min_separation = entry.min_separation;
      set.first_row = static_cast<std::uint32_t>(staged_support_rows_.size());
      set.row_count = static_cast<std::uint32_t>(entry.supporters.size());
      for (const SupporterRec &rec : entry.supporters) {
        FfiSupportRow row{};
        row.kind = rec.kind;
        row.supporter_entity = rec.entity;
        row.supporter_node = rec.node;
        staged_support_rows_.push_back(row);
      }
      staged_support_sets_.push_back(set);
      entry.dirty = false;
    }
  }
  support_edges_total_ = 0;
  for (const auto &entry : support_store_) {
    support_edges_total_ += entry.second.supporters.size();
  }
}

rust::Vec<FfiSupportSet> DestructionManager::take_support_sets() {
  rust::Vec<FfiSupportSet> out;
  out.reserve(staged_support_sets_.size());
  for (const FfiSupportSet &set : staged_support_sets_) {
    out.push_back(set);
  }
  staged_support_sets_.clear();
  return out;
}

rust::Vec<FfiSupportRow> DestructionManager::take_support_rows() {
  rust::Vec<FfiSupportRow> out;
  out.reserve(staged_support_rows_.size());
  for (const FfiSupportRow &row : staged_support_rows_) {
    out.push_back(row);
  }
  staged_support_rows_.clear();
  return out;
}

void DestructionManager::span_add(const char *name, double value,
                                  std::uint8_t kind) {
  // Names are string LITERALS by convention (pointer compare is the fast
  // path); a handful of spans per tick makes the linear scan free.
  for (auto &entry : extra_spans_) {
    if (entry.first == name || std::strcmp(entry.first, name) == 0) {
      entry.second.first += value;
      return;
    }
  }
  extra_spans_.push_back({name, {value, kind}});
}

rust::Vec<std::uint32_t> DestructionManager::take_frozen_contact_wakes() {
  // The tick's accumulated pair loads are judged here, at the drain, so the
  // caller sees exactly one decision per body per tick.
  resolve_frozen_contact_wakes();
  rust::Vec<std::uint32_t> out;
  out.reserve(contact_wake_order_.size());
  for (std::uint32_t entity : contact_wake_order_) {
    out.push_back(entity);
  }
  contact_wake_order_.clear();
  contact_wake_pending_.clear();
  return out;
}

FfiDestructionStats DestructionManager::destruction_stats() const {
  FfiDestructionStats stats{};
  for (const auto &entry : extra_spans_) {
    FfiNamedSpan span;
    span.name = rust::String(entry.first);
    span.value = entry.second.first;
    span.kind = entry.second.second;
    stats.extra_spans.push_back(std::move(span));
  }
  stats.structures = static_cast<std::uint32_t>(slots_.size());
  stats.broken_bonds = total_broken_bonds_;
  stats.stress_solve_ms = last_stress_solve_ms_;
  stats.unmapped_body_skips = unmapped_body_skips_;
  stats.begin_ms = last_begin_ms_;
  stats.solve_ms = last_solve_ms_;
  stats.end_ms = last_end_ms_;
  stats.readback_ms = last_readback_ms_;
  stats.events_ms = last_events_ms_;
  stats.filters_ms = last_filters_ms_;
  stats.ccd_ms = last_ccd_ms_;
  stats.support_loads_ms = last_support_loads_ms_;
  stats.support_pair_loads = last_support_pair_loads_;
  stats.shape_readback_ms = last_shape_readback_ms_;
  stats.slot_dispatch_ms = last_slot_dispatch_ms_;
  stats.bond_sample_ms = last_bond_sample_ms_;
  stats.quiet_slot_ticks = quiet_slot_ticks_;
  std::uint32_t sleeping = 0;
  std::uint32_t frozen = 0;
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr) continue;
    // Tallied during this tick's readback walk rather than re-walked here.
    sleeping += slot_ptr->sleeping_body_count;
    frozen += static_cast<std::uint32_t>(slot_ptr->frozen.size());
  }
  stats.sleeping_chunk_bodies = sleeping;
  // Counted from the bridge's own set rather than from Rust's, so a
  // disagreement between the two is visible instead of silently papered over.
  stats.frozen_chunk_bodies = frozen;
  {
    // Few dozen aggregates at most; the live occupancy read keeps this
    // honest against bodies PhysX released while frozen.
    std::uint32_t aggregates = 0;
    std::uint32_t aggregated_actors = 0;
    for (const auto &cell : frozen_agg_cells_) {
      for (const physx::PxAggregate *aggregate : cell.second) {
        ++aggregates;
        aggregated_actors += aggregate->getNbActors();
      }
    }
    stats.frozen_aggregates = aggregates;
    stats.frozen_aggregate_actors = aggregated_actors;
  }
  stats.frozen_serial_blocks = frozen_serial_blocks_;
  stats.frozen_adapter_releases = frozen_adapter_releases_;
  stats.freeze_flips = freeze_flips_;
  stats.unfreeze_flips = unfreeze_flips_;
  stats.contact_wakes = contact_wakes_;
  stats.support_promotions = support_promotions_;
  stats.rooted_guard_blocks = rooted_guard_blocks_;
  stats.island_resleep_writes = island_resleep_writes_;
  stats.support_edges = support_edges_total_;
  std::uint32_t rooted_count = 0;
  for (const auto &slot_ptr : slots_) {
    if (slot_ptr) {
      rooted_count += static_cast<std::uint32_t>(slot_ptr->rooted.size());
    }
  }
  stats.rooted_chunk_bodies = rooted_count;
  float contact_slot_max = 0.0f;
  float gravity_slot_max = 0.0f;
  std::uint64_t single_node_bodies = 0;
  std::uint64_t single_node_contacts = 0;
  std::uint64_t single_node_awake = 0;
  std::uint64_t bondless_skipped = 0;
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    const auto &telemetry = slot_ptr->dest->getTelemetry();
    stats.chunk_bodies += telemetry.bodyCount;
    stats.awake_chunk_bodies += telemetry.awakeDynamicBodyCount;
    // Whether the CUDA solver is actually running, not merely requested: the
    // adapter falls back to CPU silently if the graph is under the crossover
    // or CUDA init failed, and that must not look like a GPU solve.
    if (slot_ptr->dest->usesGpuStressSolver()) {
      stats.gpu_stress_structures += 1;
    }
    stats.repeated_body_snapshots = repeated_body_snapshots_;
    // Delta, not the running total -- see last_gpu_stress_solve_ms. Guarded
    // because the counter resets to 0 if a destructible is recreated, and a
    // negative "solve time" is worse than a zero.
    const double gpu_total = telemetry.gpuStressSolveMilliseconds;
    const double gpu_delta = gpu_total - slot_ptr->last_gpu_stress_solve_ms;
    slot_ptr->last_gpu_stress_solve_ms = gpu_total;
    stats.gpu_stress_solve_ms += static_cast<float>(gpu_delta > 0.0 ? gpu_delta : 0.0);
    // Same delta-with-reset-guard treatment for the five phase timers the
    // adapter keeps alongside it. Summed across slots, like every other
    // per-structure figure here.
    const auto phase_delta = [](double total, double &previous) {
      const double delta = total - previous;
      previous = total;
      return static_cast<float>(delta > 0.0 ? delta : 0.0);
    };
    // Per-slot maxima ride the span channel beside the sums: slots run
    // concurrently, so MAX-across-slots is the wall-time bound a summed
    // field cannot provide (reading a sum as wall nearly bought a CUDA
    // kernel for a ~0.5 ms cost).
    const float contact_slot_ms = phase_delta(
        telemetry.contactProcessingMilliseconds,
        slot_ptr->last_contact_processing_ms);
    stats.blast_contact_processing_ms += contact_slot_ms;
    contact_slot_max = std::max(contact_slot_max, contact_slot_ms);
    const float gravity_slot_ms =
        phase_delta(telemetry.gravityMilliseconds, slot_ptr->last_gravity_ms);
    stats.blast_gravity_ms += gravity_slot_ms;
    gravity_slot_max = std::max(gravity_slot_max, gravity_slot_ms);
    stats.blast_stress_solve_cpu_ms += phase_delta(
        telemetry.stressSolveMilliseconds, slot_ptr->last_stress_solve_cpu_ms);
    stats.blast_fracture_topology_ms += phase_delta(
        telemetry.fractureTopologyMilliseconds,
        slot_ptr->last_fracture_topology_ms);
    stats.blast_mapping_validation_ms += phase_delta(
        telemetry.mappingValidationMilliseconds,
        slot_ptr->last_mapping_validation_ms);
    // The interior of fracture topology. Children of it, and NOT summable with
    // it -- mapping validation is in there too, so the unattributed remainder
    // is topology - (these five) - validation.
    stats.blast_fracture_generate_ms += phase_delta(
        telemetry.fractureGenerateMilliseconds,
        slot_ptr->last_fracture_generate_ms);
    stats.blast_fracture_prep_ms += phase_delta(
        telemetry.fracturePrepMilliseconds,
        slot_ptr->last_fracture_prep_ms);
    stats.blast_fracture_apply_ms += phase_delta(
        telemetry.fractureApplyMilliseconds,
        slot_ptr->last_fracture_apply_ms);
    stats.blast_fracture_scene_ms += phase_delta(
        telemetry.fractureSceneMilliseconds,
        slot_ptr->last_fracture_scene_ms);
    stats.blast_fracture_rebuild_ms += phase_delta(
        telemetry.fractureRebuildMilliseconds,
        slot_ptr->last_fracture_rebuild_ms);
    stats.blast_sleeping_actors_skipped += telemetry.sleepingActorsSkipped;
    // The quantity that actually decides whether anything fractures this tick:
    // endTick() only runs fracture when it is non-zero. Without it in the
    // stats, "the island never breaks" and "nothing was even close to its
    // limit" are indistinguishable from outside.
    stats.overstressed_bonds += telemetry.overstressedBondCount;
    stats.contacts_processed += telemetry.contactsProcessed;
    stats.contacts_dropped += telemetry.contactsDropped;
    // Queued vs processed sizes the contact pipeline. Contacts are routed per
    // contact POINT and twice per point (once per shape), so
    // contacts_queued / (2 * support_pair_loads) is the points-per-manifold
    // factor -- the number that decides what per-manifold aggregation is worth.
    stats.contacts_queued += telemetry.contactsQueued;
    // The granularity PhysX actually sleeps at. A merged rubble field is one
    // island of thousands of bodies: it can only sleep as a whole, and any one
    // member waking wakes all of it. Body counts alone read identically
    // whether the same 6,000 bodies are one island or 6,000.
    stats.solver_island_count += telemetry.solverIslandCount;
    stats.solver_islands_skipped += telemetry.solverIslandsSkipped;
    stats.sleeping_actors_skipped += telemetry.sleepingActorsSkipped;
    single_node_bodies += telemetry.singleNodeBodyCount;
    single_node_contacts += telemetry.singleNodeContacts;
    single_node_awake += telemetry.singleNodeAwakeBodies;
    bondless_skipped += telemetry.bondlessContactsSkipped;
  }

  // Bounded-growth tripwire. Both are keyed by (structure_id, bodyId) and
  // erased on retire; pointer-keyed and never pruned, they grew without limit
  // and let a recycled actor inherit a dead body's CCD state.
  stats.ccd_tracked_bodies = static_cast<std::uint32_t>(ccd_enabled_.size());
  stats.identity_stamped_bodies =
      static_cast<std::uint32_t>(body_entity_stamp_.size());
  stats.solver_islands_skipped_accum = solver_islands_skipped_accum_;
  stats.solver_islands_total_accum = solver_islands_total_accum_;
  stats.bond_utilisation_max = last_bond_utilisation_max_;
  stats.bonds_above_half_utilisation = last_bonds_above_half_utilisation_;
  // Wall-time bounds for the two most-consulted slot-summed fields (kind 0:
  // these ARE wall — slots run concurrently, so the slowest slot bounds the
  // phase's wall share).
  const auto push_span = [&stats](const char *name, double value,
                                  std::uint8_t kind) {
    FfiNamedSpan span;
    span.name = rust::String(name);
    span.value = value;
    span.kind = kind;
    stats.extra_spans.push_back(std::move(span));
  };
  push_span("blast_gravity_slotmax_ms", gravity_slot_max, 0);
  push_span("blast_contact_processing_slotmax_ms", contact_slot_max, 0);
  // A single-node body has no internal bonds, so nothing in it can break: the
  // contacts routed into it, and its share of the solve, cannot change the
  // simulation whatever they contain. Published to size that share before
  // anything is built on it.
  push_span("single_node_bodies", static_cast<double>(single_node_bodies), 2);
  // Only meaningful in the BLAST_SKIP_BONDLESS_CONTACTS=0 arm. With the skip
  // on (the default) these contacts are dropped BEFORE the loop that counts
  // them, so the counter is structurally pinned to zero -- and a pinned zero
  // in a report reads as "measured, and it was none", which is the same
  // failure F11 fixed for the PhysX split. Publish it only when it can carry
  // information; `bondless_contacts_skipped` is the metric for the skip-on
  // arm, and it is always published below.
  if (bondless_skipped == 0) {
    push_span("single_node_contacts",
              static_cast<double>(single_node_contacts), 2);
  }
  push_span("single_node_awake", static_cast<double>(single_node_awake), 2);
  push_span("ground_touch_latches", static_cast<double>(ground_touch_latches_), 2);
  push_span("settle_assist_applied", static_cast<double>(settle_assist_applied_), 2);
  // Cumulative. single_node_contacts now reads 0 BECAUSE the skip works --
  // dropped contacts never reach the loop that counts them -- so the volume
  // being saved is only visible here.
  push_span("bondless_contacts_skipped", static_cast<double>(bondless_skipped), 2);
  // Must stay 0. Non-zero means the cached node index disagreed with the
  // library's map, i.e. a contact was routed to the wrong Blast node.
  push_span("node_cache_mismatches",
            static_cast<double>(node_cache_mismatches_), 2);
  push_span("node_cache_checks", static_cast<double>(node_cache_checks_), 2);
  push_span("stress_solve_residual_ms",
            static_cast<double>(last_stress_solve_residual_ms_), 0);
  return stats;
}

std::uint64_t DestructionManager::split_count() const {
  std::uint64_t total = 0;
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    total += slot_ptr->dest->getTelemetry().splits;
  }
  return total;
}

bool DestructionManager::resim_needed() const {
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    if (slot_ptr->dest->needsResimulationSnapshot()) {
      return true;
    }
  }
  return false;
}

std::uint32_t DestructionManager::resim_capture() {
  std::uint32_t captured = 0;
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    captured += slot_ptr->dest->captureResimulationSnapshot();
  }
  return captured;
}

bool DestructionManager::resim_restore() {
  bool any = false;
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    // Full-scene restore: passing no active set rewinds every captured body.
    any = slot_ptr->dest->restoreResimulationSnapshot() || any;
  }
  return any;
}

bool DestructionManager::validate_destruction_mappings() const {
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    if (!slot_ptr->dest->validateMappings()) {
      return false;
    }
  }
  return true;
}

} // namespace vibe_land::physx_bridge
