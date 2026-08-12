#include "destruction.h"

#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "NvBlastExtStressPhysX.h"
#include "PxPhysicsAPI.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
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

std::uint32_t pack_chunk_id(std::uint32_t structure_id, std::uint32_t node_index) {
  return (structure_id << 12) | node_index;
}

std::uint32_t pack_bond_id(std::uint32_t structure_id, std::uint32_t bond_index) {
  return (structure_id << 16) | bond_index;
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
bool quiet_skip_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_CITY_QUIET_SKIP");
    return value == nullptr || std::string(value) != "0";
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

  // Tracking for event diffs.
  std::unordered_map<ExtStressPhysXId, std::uint32_t> body_to_serial;
  std::unordered_map<std::uint32_t, ExtStressPhysXId> node_to_body; // node -> bodyId
  std::unordered_map<std::uint32_t, std::uint32_t> node_to_serial;
  std::vector<std::uint8_t> bond_alive; // 1 = alive

  // Topology counters as of the last diff. The adapter only mutates topology
  // inside endTick, and only when bonds were overstressed, so when these are
  // unchanged the whole diff is provably a no-op and is skipped.
  std::uint64_t last_splits = 0;
  std::uint64_t last_bodies_created = 0;
  std::uint64_t last_shapes_migrated = 0;
  bool topology_primed = false;
};

DestructionManager::DestructionManager(PxPhysics &physics, PxScene &scene,
                                       PxMaterial &material,
                                       float contact_report_threshold)
    : physics_(physics), scene_(scene), material_(material),
      contact_report_threshold_(contact_report_threshold) {
  // Total parallelism for the stress solve, calling thread included.
  // VIBE_CITY_STRESS_WORKERS=1 forces the old fully-serial behaviour.
  unsigned workers = 8;
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

DestructionManager::~DestructionManager() {
  for (auto &slot : slots_) {
    if (slot && slot->dest != nullptr) {
      slot->dest->release();
      slot->dest = nullptr;
    }
  }
  slots_.clear();
  shape_owners_.clear();
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
    dst.material = 0;
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
  desc.settings.minimumSeparationVelocity =
      settings.apply_excess_forces ? 0.35f : 0.0f;
  desc.errorCallback = adapter_error;

  // Stress limits moved from settings onto a per-material table indexed by
  // each bond (upstream's multi-material work). One entry is enough here: the
  // city pack authors a single concrete, so index 0 is the structure default
  // and every bond references it. Per-bond materials can be read from the
  // ScenePack later without touching this call site.
  std::vector<ExtStressPhysXMaterial> stress_materials(1);
  stress_materials[0].compressionElasticLimit = settings.compression_elastic;
  stress_materials[0].compressionFatalLimit = settings.compression_fatal;
  stress_materials[0].tensionElasticLimit = settings.tension_elastic;
  stress_materials[0].tensionFatalLimit = settings.tension_fatal;
  stress_materials[0].shearElasticLimit = settings.shear_elastic;
  stress_materials[0].shearFatalLimit = settings.shear_fatal;
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

  // Seed support body as serial 0 before first filter pass.
  {
    std::vector<ExtStressPhysXBodySnapshot> bodies(slot->node_descs.size() + 4);
    const std::uint32_t body_count =
        dest->getBodySnapshots(bodies.data(), static_cast<std::uint32_t>(bodies.size()));
    for (std::uint32_t i = 0; i < body_count; ++i) {
      const auto &body = bodies[i];
      std::uint32_t serial = 0;
      if (!body.kinematic) {
        serial = next_serial(*slot);
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
constexpr float kChunkSleepThreshold = 0.05f;
constexpr float kChunkStabilizationThreshold = 0.02f;

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
    auto serial_it = slot.body_to_serial.find(body.bodyId);
    std::uint32_t serial = 0;
    if (serial_it == slot.body_to_serial.end()) {
      serial = body.kinematic ? 0 : next_serial(slot);
      slot.body_to_serial[body.bodyId] = serial;
    } else {
      serial = serial_it->second;
      // Serial 0 is the structure's kinematic support. A body keeps whatever
      // serial it was given the first time it was seen, so one that has since
      // become dynamic would hold 0 forever and alias onto the support -- and
      // onto every other such body. Re-issue a real serial when that happens.
      if (serial == kSupportIslandSerial && !body.kinematic) {
        serial = next_serial(slot);
        slot.body_to_serial[body.bodyId] = serial;
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
    auto stamped = body_entity_stamp_.find(body.body);
    if (stamped != body_entity_stamp_.end() && stamped->second == entity) {
      continue;
    }
    body_entity_stamp_[body.body] = entity;
    tag_actor(*body.body, entity);
    if (!body.kinematic) {
      // Contact reports are what let a falling chunk damage what it lands on:
      // onContact routes the impulse into the stress solver. They are not
      // free — the scene filter requests eNOTIFY_THRESHOLD_FORCE_PERSISTS and
      // eNOTIFY_CONTACT_POINTS, so every reporting pair extracts and copies
      // full contact data back to the host every tick, and a settled rubble
      // pile is nothing but persistent pairs. VIBE_CITY_CHUNK_CONTACT_REPORTS=0
      // disables them so the cost can be measured against the gameplay they buy.
      body.body->setContactReportThreshold(
          chunk_contact_reports_ ? contact_report_threshold_
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
      body.body->setSleepThreshold(kChunkSleepThreshold);
      body.body->setStabilizationThreshold(kChunkStabilizationThreshold);
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

  // Snapshot membership BEFORE assigning new serials so promotions are visible.
  const auto previous_body_to_serial = slot.body_to_serial;
  const auto previous_node_to_body = slot.node_to_body;
  const auto previous_node_to_serial = slot.node_to_serial;

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
    const auto mapped = previous_body_to_serial.find(bodies[i].bodyId);
    const bool became_dynamic = mapped != previous_body_to_serial.end()
                                && mapped->second == kSupportIslandSerial
                                && !bodies[i].kinematic;
    if (became_dynamic) {
      ++support_promotions_;
    }
    if (mapped == previous_body_to_serial.end() || became_dynamic) {
      const std::uint32_t serial =
          bodies[i].kinematic ? 0 : next_serial(slot);
      slot.body_to_serial[bodies[i].bodyId] = serial;
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
  std::vector<ExtStressPhysXId> retired_ids;
  for (const auto &entry : previous_body_to_serial) {
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
    slot.body_to_serial.erase(id);
  }

  const auto &shapes = slot.shape_cache;
  const std::uint32_t shape_count = slot.shape_cache_count;

  for (std::uint32_t i = 0; i < shape_count; ++i) {
    const auto &shape = shapes[i];
    const std::uint32_t node = shape.nodeIndex;
    const ExtStressPhysXId new_body = shape.bodyId;
    auto old_body_it = previous_node_to_body.find(node);
    const ExtStressPhysXId old_body =
        old_body_it != previous_node_to_body.end() ? old_body_it->second : 0;
    auto old_serial_it = previous_node_to_serial.find(node);
    const std::uint32_t old_serial =
        old_serial_it != previous_node_to_serial.end() ? old_serial_it->second
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
  for (std::uint32_t i = 1; i < slot.body_cache_count && i < slot.body_cache.size(); ++i) {
    if (slot.body_cache[i].bodyId == slot.body_cache[i - 1].bodyId) {
      ++repeated_body_snapshots_;
    }
  }
  if (slot.body_cache_count > slot.body_cache.size()) {
    slot.body_cache.resize(slot.body_cache_count);
    slot.body_cache_count = slot.dest->getBodySnapshots(
        slot.body_cache.data(), static_cast<std::uint32_t>(slot.body_cache.size()));
  }
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
  const PxVec3 g = to_px(gravity);
  using clock = std::chrono::steady_clock;
  const auto ms_since = [](clock::time_point from) {
    return static_cast<float>(
        std::chrono::duration<double, std::milli>(clock::now() - from).count());
  };
  const auto started = clock::now();
  // Per-phase attribution. The old single number covered this whole function,
  // so "stress solve" was really solve + GPU readback + event diffing.
  float solve_ms = 0.0f;
  float readback_ms = 0.0f;
  float events_ms = 0.0f;
  float filters_ms = 0.0f;
  // Live structures, gathered once so the parallel phase can index them.
  live_slots_.clear();
  for (auto &slot_ptr : slots_) {
    if (slot_ptr && slot_ptr->dest != nullptr) {
      live_slots_.push_back(slot_ptr.get());
    }
  }

  // Three phases, because only the middle one is safely concurrent.
  // beginTick injects contacts and gravity, endTick fractures and edits PhysX
  // actors -- both touch shared state. solveTick is pure computation over one
  // structure's own graph, so structures solve independently.
  auto phase = clock::now();
  for (Slot *slot : live_slots_) {
    require(slot->dest->beginTick(dt, g), "beginTick failed");
  }
  stress_executor_->run(live_slots_.size(), [this](std::size_t index) {
    require(live_slots_[index]->dest->solveTick(), "solveTick failed");
  });
  for (Slot *slot : live_slots_) {
    require(slot->dest->endTick(), "endTick failed");
  }
  solve_ms += ms_since(phase);

  for (Slot *slot_ptr : live_slots_) {
    Slot &slot = *slot_ptr;
    // One readback, then every consumer works off it. This always runs: poses
    // change every tick even when topology does not.
    phase = clock::now();
    refresh_snapshots(slot);
    readback_ms += ms_since(phase);

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
    for (std::uint32_t i = 0; i < slot.body_cache_count; ++i) {
      const auto &body = slot.body_cache[i];
      if (body.body == nullptr || body.kinematic) {
        continue;
      }
      if (ccd_enabled_.insert(body.body).second) {
        body.body->setRigidBodyFlag(
            physx::PxRigidBodyFlag::eENABLE_SPECULATIVE_CCD, true);
        // Bound the solver's depenetration response. Split children start
        // life overlapping their siblings (they shared faces one tick ago),
        // and PhysX's default depenetration velocity is unbounded. This is
        // not clamping physics: interpenetration is a numerical artifact of
        // discrete stepping, and this bounds only how fast the solver
        // corrects that unreal state. (It was once suspected as the source of
        // kilometre-scale escapes; measurement pinned those on the adapter's
        // unbounded excess-force injection instead -- see city.rs -- but the
        // bound remains correct on its own terms.)
        body.body->setMaxDepenetrationVelocity(3.0f);
      }
    }

    // Topology can only change inside endTick, and only when bonds were
    // overstressed. When these counters have not moved, nothing was split,
    // created or migrated, so the diff below would walk every body, every
    // shape and every bond only to conclude that nothing changed. Skip it.
    const ExtStressPhysXTelemetry &telemetry = slot.dest->getTelemetry();
    const bool topology_changed =
        !slot.topology_primed || telemetry.splits != slot.last_splits ||
        telemetry.bodiesCreated != slot.last_bodies_created ||
        telemetry.shapesMigrated != slot.last_shapes_migrated;
    if (!topology_changed && quiet_skip_enabled()) {
      ++quiet_slot_ticks_;
      continue;
    }
    slot.last_splits = telemetry.splits;
    slot.last_bodies_created = telemetry.bodiesCreated;
    slot.last_shapes_migrated = telemetry.shapesMigrated;
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
  last_solve_ms_ = solve_ms;
  last_readback_ms_ = readback_ms;
  last_events_ms_ = events_ms;
  last_filters_ms_ = filters_ms;
  last_stress_solve_ms_ = ms_since(started);
}

void DestructionManager::route_contact_shape(PxShape *shape, FfiVec3 position,
                                             FfiVec3 impulse) {
  if (shape == nullptr) {
    return;
  }
  auto it = shape_owners_.find(shape);
  if (it == shape_owners_.end()) {
    return;
  }
  Slot *slot = find_slot(it->second.first);
  if (slot == nullptr || slot->dest == nullptr) {
    return;
  }
  slot->dest->queueContact(*shape, to_px(position), to_px(impulse));
}

void DestructionManager::queue_chunk_damage(std::uint32_t structure_id,
                                            std::uint32_t chunk_id,
                                            FfiVec3 impulse, FfiVec3 point) {
  Slot *slot = find_slot(structure_id);
  require(slot != nullptr && slot->dest != nullptr, "unknown structure");
  const std::uint32_t node_index = chunk_id & 0x0fffu;
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

rust::Vec<FfiChunkBodySnapshot>
DestructionManager::chunk_body_snapshots() const {
  rust::Vec<FfiChunkBodySnapshot> out;
  // Which body produced each entity this tick. Two bodies landing on one
  // entity is the aliasing bug; recording both sides of the collision names
  // the mechanism (same structure or cross-structure, and which serials).
  std::unordered_map<std::uint32_t, std::pair<std::uint32_t, ExtStressPhysXId>>
      emitted;
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
  return out;
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

FfiDestructionStats DestructionManager::destruction_stats() const {
  FfiDestructionStats stats{};
  stats.structures = static_cast<std::uint32_t>(slots_.size());
  stats.broken_bonds = total_broken_bonds_;
  stats.stress_solve_ms = last_stress_solve_ms_;
  stats.unmapped_body_skips = unmapped_body_skips_;
  stats.solve_ms = last_solve_ms_;
  stats.readback_ms = last_readback_ms_;
  stats.events_ms = last_events_ms_;
  stats.filters_ms = last_filters_ms_;
  std::uint32_t sleeping = 0;
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr) continue;
    for (std::uint32_t i = 0; i < slot_ptr->body_cache_count; ++i) {
      const auto &body = slot_ptr->body_cache[i];
      if (!body.kinematic && body.sleeping) ++sleeping;
    }
  }
  stats.sleeping_chunk_bodies = sleeping;
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
  stats.gpu_stress_solve_ms +=
        static_cast<float>(telemetry.gpuStressSolveMilliseconds);
  }
  return stats;
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
