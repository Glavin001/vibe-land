#include "destruction.h"

#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "NvBlastExtStressPhysX.h"
#include "PxPhysicsAPI.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
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

std::uint32_t pack_body_entity(std::uint32_t structure_id, std::uint16_t serial) {
  return kNsChunk | (structure_id << 16) | static_cast<std::uint32_t>(serial);
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

struct DestructionManager::Slot {
  std::uint32_t structure_id = 0;
  ExtStressPhysXDestructible *dest = nullptr;
  std::uint16_t next_island_serial = 1;
  std::uint32_t collision_group = 0;
  std::uint32_t collision_mask = 0;

  // Owned geometry storage so create() pointers stay valid.
  std::vector<std::vector<PxVec3>> convex_storage;
  std::vector<ExtStressPhysXNodeDesc> node_descs;
  std::vector<ExtStressPhysXBondDesc> bond_descs;

  // Tracking for event diffs.
  std::unordered_map<ExtStressPhysXId, std::uint16_t> body_to_serial;
  std::unordered_map<std::uint32_t, ExtStressPhysXId> node_to_body; // node -> bodyId
  std::unordered_map<std::uint32_t, std::uint16_t> node_to_serial;
  std::vector<std::uint8_t> bond_alive; // 1 = alive
};

DestructionManager::DestructionManager(PxPhysics &physics, PxScene &scene,
                                       PxMaterial &material,
                                       float contact_report_threshold)
    : physics_(physics), scene_(scene), material_(material),
      contact_report_threshold_(contact_report_threshold) {}

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
  desc.settings.islandAware = true;
  desc.settings.skipSettledIslands = true;
  desc.settings.gpuStressSolver = false;
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
      std::uint16_t serial = 0;
      if (!body.kinematic) {
        serial = slot->next_island_serial++;
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
constexpr float kMaxChunkLinearVelocity = 12.0f;
constexpr float kMaxChunkAngularVelocity = 10.0f;

void DestructionManager::register_filters(Slot &slot) {
  require(slot.dest != nullptr, "missing destructible");
  std::vector<ExtStressPhysXBodySnapshot> bodies(slot.node_descs.size() + 64);
  std::uint32_t body_count = slot.dest->getBodySnapshots(
      bodies.data(), static_cast<std::uint32_t>(bodies.size()));
  if (body_count > bodies.size()) {
    bodies.resize(body_count);
    body_count = slot.dest->getBodySnapshots(
        bodies.data(), static_cast<std::uint32_t>(bodies.size()));
  }

  for (std::uint32_t i = 0; i < body_count; ++i) {
    const auto &body = bodies[i];
    if (body.body == nullptr) {
      continue;
    }
    auto serial_it = slot.body_to_serial.find(body.bodyId);
    std::uint16_t serial = 0;
    if (serial_it == slot.body_to_serial.end()) {
      serial = body.kinematic ? 0 : slot.next_island_serial++;
      slot.body_to_serial[body.bodyId] = serial;
    } else {
      serial = serial_it->second;
    }
    const std::uint32_t entity = pack_body_entity(slot.structure_id, serial);
    tag_actor(*body.body, entity);
    if (!body.kinematic) {
      body.body->setContactReportThreshold(contact_report_threshold_);
      // Debris runs without CCD, so a body must never move more than roughly
      // its own thickness per step or it tunnels through the ground. External
      // impulses (the hitscan blast push) bypass the adapter's own
      // `maximumLinearVelocity`, and a 4e5 N-s impulse on a ~1.6 t slab is
      // ~240 m/s — 4 m per 60 Hz step, straight through the heightfield.
      // Clamping at the body bounds every impulse source at once.
      body.body->setMaxLinearVelocity(kMaxChunkLinearVelocity);
      body.body->setMaxAngularVelocity(kMaxChunkAngularVelocity);
    }
  }

  std::vector<ExtStressPhysXShapeSnapshot> shapes(slot.node_descs.size() + 64);
  std::uint32_t shape_count = slot.dest->getShapeSnapshots(
      shapes.data(), static_cast<std::uint32_t>(shapes.size()));
  if (shape_count > shapes.size()) {
    shapes.resize(shape_count);
    shape_count = slot.dest->getShapeSnapshots(
        shapes.data(), static_cast<std::uint32_t>(shapes.size()));
  }

  for (std::uint32_t i = 0; i < shape_count; ++i) {
    const auto &shape = shapes[i];
    if (shape.shape == nullptr) {
      continue;
    }
    auto serial_it = slot.body_to_serial.find(shape.bodyId);
    const std::uint16_t serial =
        serial_it != slot.body_to_serial.end() ? serial_it->second : 0;
    const std::uint32_t entity = pack_body_entity(slot.structure_id, serial);
    configure_shape(*shape.shape, entity, slot.collision_group,
                    slot.collision_mask);
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

  std::vector<ExtStressPhysXBodySnapshot> bodies(slot.node_descs.size() + 64);
  std::uint32_t body_count = slot.dest->getBodySnapshots(
      bodies.data(), static_cast<std::uint32_t>(bodies.size()));
  if (body_count > bodies.size()) {
    bodies.resize(body_count);
    body_count = slot.dest->getBodySnapshots(
        bodies.data(), static_cast<std::uint32_t>(bodies.size()));
  }

  std::unordered_map<ExtStressPhysXId, const ExtStressPhysXBodySnapshot *>
      body_by_id;
  std::unordered_set<ExtStressPhysXId> live_bodies;
  std::unordered_map<std::uint16_t, std::size_t> promo_event_index;
  for (std::uint32_t i = 0; i < body_count; ++i) {
    body_by_id[bodies[i].bodyId] = &bodies[i];
    live_bodies.insert(bodies[i].bodyId);
    if (previous_body_to_serial.find(bodies[i].bodyId) ==
        previous_body_to_serial.end()) {
      const std::uint16_t serial =
          bodies[i].kinematic ? 0 : slot.next_island_serial++;
      slot.body_to_serial[bodies[i].bodyId] = serial;
      if (!bodies[i].kinematic) {
        FfiIslandBodyEvent event{};
        event.structure_id = slot.structure_id;
        event.island_id = serial;
        event.kind = 0; // promoted
        event.mass =
            bodies[i].body != nullptr ? bodies[i].body->getMass() : 0.0f;
        event.position = from_px(bodies[i].globalPose.p);
        event.rotation = from_px(bodies[i].globalPose.q);
        event.linear_velocity = from_px(bodies[i].linearVelocity);
        event.angular_velocity = from_px(bodies[i].angularVelocity);
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

  std::vector<ExtStressPhysXShapeSnapshot> shapes(slot.node_descs.size() + 64);
  std::uint32_t shape_count = slot.dest->getShapeSnapshots(
      shapes.data(), static_cast<std::uint32_t>(shapes.size()));
  if (shape_count > shapes.size()) {
    shapes.resize(shape_count);
    shape_count = slot.dest->getShapeSnapshots(
        shapes.data(), static_cast<std::uint32_t>(shapes.size()));
  }

  for (std::uint32_t i = 0; i < shape_count; ++i) {
    const auto &shape = shapes[i];
    const std::uint32_t node = shape.nodeIndex;
    const ExtStressPhysXId new_body = shape.bodyId;
    auto old_body_it = previous_node_to_body.find(node);
    const ExtStressPhysXId old_body =
        old_body_it != previous_node_to_body.end() ? old_body_it->second : 0;
    auto old_serial_it = previous_node_to_serial.find(node);
    const std::uint16_t old_serial =
        old_serial_it != previous_node_to_serial.end() ? old_serial_it->second
                                                       : 0;
    auto new_serial_it = slot.body_to_serial.find(new_body);
    const std::uint16_t new_serial =
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

void DestructionManager::destruction_tick(float dt, FfiVec3 gravity) {
  const PxVec3 g = to_px(gravity);
  const auto started = std::chrono::steady_clock::now();
  for (auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    Slot &slot = *slot_ptr;
    require(slot.dest->beginTick(dt, g), "beginTick failed");
    require(slot.dest->solveTick(), "solveTick failed");
    require(slot.dest->endTick(), "endTick failed");
    // Diff membership first (assigns serials for new bodies), then stamp
    // filter/contact data onto every live shape/actor.
    collect_events(slot);
    register_filters(slot);
  }
  last_stress_solve_ms_ = static_cast<float>(
      std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - started)
          .count());
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
      const PxVec3 impulse = push_dir * (push_impulse * falloff * falloff);
      physx::PxRigidBodyExt::addForceAtPos(*rigid, impulse, c,
                                           physx::PxForceMode::eIMPULSE, true);
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
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    const Slot &slot = *slot_ptr;
    std::vector<ExtStressPhysXBodySnapshot> bodies(slot.node_descs.size() + 64);
    std::uint32_t body_count = slot.dest->getBodySnapshots(
        bodies.data(), static_cast<std::uint32_t>(bodies.size()));
    if (body_count > bodies.size()) {
      bodies.resize(body_count);
      body_count = slot.dest->getBodySnapshots(
          bodies.data(), static_cast<std::uint32_t>(bodies.size()));
    }
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
      const std::uint16_t serial = serial_it->second;
      FfiChunkBodySnapshot snap{};
      snap.entity_id = pack_body_entity(slot.structure_id, serial);
      snap.structure_id = slot.structure_id;
      snap.island_id = serial;
      snap.position = from_px(body.globalPose.p);
      snap.rotation = from_px(body.globalPose.q);
      snap.linear_velocity = from_px(body.linearVelocity);
      snap.angular_velocity = from_px(body.angularVelocity);
      snap.sleeping = body.sleeping;
      snap.kinematic = body.kinematic;
      snap.node_count = body.nodeCount;
      snap.flags = 0;
      out.push_back(snap);
    }
  }
  return out;
}

void DestructionManager::sleep_chunk_body(std::uint32_t entity_id) {
  require((entity_id & 0xf000'0000u) == kNsChunk, "not a chunk entity");
  const std::uint32_t structure_id = (entity_id & 0x0fff'ffffu) >> 16;
  const std::uint16_t serial =
      static_cast<std::uint16_t>(entity_id & 0xffffu);
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
  for (const auto &slot_ptr : slots_) {
    if (!slot_ptr || slot_ptr->dest == nullptr) {
      continue;
    }
    const auto &telemetry = slot_ptr->dest->getTelemetry();
    stats.chunk_bodies += telemetry.bodyCount;
    stats.awake_chunk_bodies += telemetry.awakeDynamicBodyCount;
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
