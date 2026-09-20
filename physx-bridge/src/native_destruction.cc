#include "native_state.h"

#include "extensions/PxMassProperties.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <numeric>

using namespace physx;

// Whether the stage runs its corrected rigid pass after a membership-changing
// verdict. One is the production value: one trial evaluation plus one
// corrected pass. Zero leaves the stage in its diagnostic mode, where any such
// verdict is rejected. The SDK accepts nothing else: `configureStress` refuses
// a limit above 1 (`PxgDestructionRuntime.cu`, `d.internalCorrectionLimit>1`)
// and treats the value as a boolean, so "two passes" is not a thing this
// engine can do. VIBE_CITY_NATIVE_CORRECTION_LIMIT=0 turns it off for A/B.
// Anything above 1 is clamped and shouted about, because the rejected
// configuration's symptom is a city that renders and cannot break, with one
// WARN in the log to say why.
static unsigned correction_limit() {
  static const unsigned value = [] {
    const char *raw = std::getenv("VIBE_CITY_NATIVE_CORRECTION_LIMIT");
    if (raw == nullptr || *raw == '\0') return 1u;
    char *end = nullptr;
    const unsigned long parsed = std::strtoul(raw, &end, 10);
    if (end == nullptr || *end != '\0') return 1u;
    if (parsed > 1) {
      std::fprintf(stderr,
                   "[destruction] VIBE_CITY_NATIVE_CORRECTION_LIMIT=%lu is not supported by the "
                   "stage (0 or 1 only; configureStress rejects more); using 1\n",
                   parsed);
      return 1u;
    }
    return unsigned(parsed);
  }();
  return value;
}

namespace vibe_land::physx_bridge {
namespace {

double now_ms() {
  using clock = std::chrono::steady_clock;
  return std::chrono::duration<double, std::milli>(
             clock::now().time_since_epoch())
      .count();
}

/// Reference stiffness for bond compliance, Pa.
///
/// Compliance is a *relative* quantity here: what matters is how load divides
/// between parallel paths, so each bond is scaled by sqrt(E*A/L) and the set is
/// then normalised by its own geometric mean. Dividing through by a fixed
/// modulus keeps a single-material structure at unit compliance, which is what
/// the stage's defaults are tuned against.
constexpr float kReferenceModulusPa = 30.0e9f;

} // namespace

std::uint32_t NativeDestruction::entity_id(std::uint32_t structure_id,
                                           std::uint32_t island_serial) {
  // Mirrors ids.rs: NS_CHUNK | structure << 22 | serial.
  native_require(structure_id < (1u << 6),
                 "structure id exceeds the 6-bit network field");
  native_require(island_serial < (1u << 22),
                 "island serial space exhausted for this structure");
  return 0x80000000u | (structure_id << 22) | island_serial;
}

NativeDestruction::NativeDestruction(PxPhysics &physics, PxScene &scene,
                                     PxMaterial &material)
    : state_(new State(physics, scene, material)) {
  native_require(
      !scene.getFlags().isSet(PxSceneFlag::eENABLE_DIRECT_GPU_API),
      "native destruction needs ordinary CPU actor access; disable the Direct "
      "GPU API");
  native_require(!scene.getFlags().isSet(PxSceneFlag::eENABLE_CCD),
                 "native destruction does not support scene CCD");
  native_require(scene.getDestructionScene() != nullptr,
                 "this PhysX build has no GPU destruction stage; check that "
                 "the physx-2 SDK is the one linked");
}

NativeDestruction::~NativeDestruction() {
  try {
    clear();
  } catch (...) {
    // A throwing destructor during teardown would mask the original failure.
  }
}

bool NativeDestruction::configured() const { return state_->configured; }

void NativeDestruction::clear() {
  State &s = *state_;
  s.release_rounds();
  // Fragment bodies are scene-owned and destroyed here, so this has to happen
  // before the authored parents and shapes go away.
  const bool released = s.configured ? s.stage().clearStress() : true;

  // This used to throw the moment `clearStress` refused, which left the object
  // exactly as it was: still `configured`, so the very next
  // `create_destructible` was rejected as "immutable once configured". The
  // stage refuses precisely when it is in an error state, which is the state a
  // rebuild is trying to repair -- so the one repair available could never run,
  // and the match stayed indestructible until the process was restarted.
  // Observed live: the automatic rebuild firing, being refused, and firing
  // again, with 10,684 rejected ticks behind it.
  //
  // So the teardown finishes either way and the failure is reported at the end,
  // with the object usable again. What is NOT done on that path is releasing
  // the authored parents and shapes: a stage that would not let go of its
  // topology may still hold references to them, and freeing those would trade a
  // dead match for a crash. They leak for the life of the process, which is the
  // right side of that trade to be on.
  if (released) {
    for (PxRigidDynamic *parent : s.parents) {
      if (parent != nullptr) {
        parent->release();
      }
    }
    for (State::Chunk &chunk : s.chunks) {
      if (chunk.shape != nullptr) {
        chunk.shape->release();
      }
    }
  }
  PxPhysics &physics = s.physics;
  PxScene &scene = s.scene;
  PxMaterial &material = s.material;
  state_.reset(new State(physics, scene, material));
  native_require(released,
                 "cannot clear the active native destruction topology");
}

void NativeDestruction::create_destructible(
    std::uint32_t structure_id, const FfiPose &pose,
    rust::Slice<const FfiChunkNodeDesc> nodes,
    rust::Slice<const FfiChunkBondDesc> bonds,
    const FfiDestructibleSettings &settings, std::uint32_t collision_group,
    std::uint32_t collision_mask) {
  State &s = *state_;
  native_require(!s.configured,
                 "the native topology is immutable once configured; rebuild "
                 "the city to change it");
  native_require(structure_id < (1u << 6) && s.next_serial.count(structure_id) == 0,
                 "duplicate or out-of-range structure id");
  native_require(!nodes.empty() && nodes.size() <= 65536,
                 "a structure must have 1..65536 authored nodes");
  native_require(!settings.materials.empty(),
                 "a structure with no material has no strength to solve for");

  const PxU32 base = static_cast<PxU32>(s.nodes.size());
  const PxU32 material_base = static_cast<PxU32>(s.materials.size());
  s.material_base[structure_id] = material_base;
  for (const FfiStressMaterial &m : settings.materials) {
    PxDestructionMaterial out;
    // Authored limits are already resolved to Pa by the caller, and the stage
    // reads negative tension/shear as "inherit compression" -- the same rule
    // the Blast materials use, so one authored table drives both backends.
    out.compressionElasticLimit = m.compression_elastic;
    out.compressionFatalLimit = m.compression_fatal;
    out.tensionElasticLimit = m.tension_elastic < 0 ? -1.0f : m.tension_elastic;
    out.tensionFatalLimit = m.tension_fatal < 0 ? -1.0f : m.tension_fatal;
    out.shearElasticLimit = m.shear_elastic < 0 ? -1.0f : m.shear_elastic;
    out.shearFatalLimit = m.shear_fatal < 0 ? -1.0f : m.shear_fatal;
    out.residualAreaFraction = m.residual_area_fraction;
    s.materials.push_back(out);
  }

  // Connected components of the authored bond graph. The stage requires the
  // initial cluster bindings to match them exactly, so this is the partition
  // that decides how many rigid bodies the intact structure starts as.
  std::vector<PxU32> roots(nodes.size());
  std::iota(roots.begin(), roots.end(), 0u);
  const auto find = [&](PxU32 v) {
    while (roots[v] != v) {
      roots[v] = roots[roots[v]];
      v = roots[v];
    }
    return v;
  };
  for (const FfiChunkBondDesc &b : bonds) {
    native_require(b.node0 < nodes.size() && b.node1 < nodes.size() &&
                       b.node0 != b.node1 &&
                       b.material < settings.materials.size() && b.area > 0.0f &&
                       b.bond_index < (1u << 20),
                   "invalid authored bond");
    const PxU32 a = find(b.node0);
    const PxU32 c = find(b.node1);
    roots[std::max(a, c)] = std::min(a, c);
  }
  std::map<PxU32, std::vector<PxU32>> components;
  for (PxU32 i = 0; i < nodes.size(); ++i) {
    components[find(i)].push_back(i);
  }

  // Support nodes carry zero mass by authoring convention, so they cannot
  // supply a density. Derive one from the structure's own massive chunks and
  // give the supports a physically consistent mass for the rigid body they
  // belong to; the stage still treats them as anchors through `supported`.
  double dynamic_mass = 0.0;
  double dynamic_volume = 0.0;
  for (const FfiChunkNodeDesc &n : nodes) {
    if (n.mass > 0.0f && n.volume > 0.0f) {
      dynamic_mass += n.mass;
      dynamic_volume += n.volume;
    }
  }
  native_require(dynamic_volume > 0.0,
                 "structure has no chunk with positive mass and volume");
  const float density = static_cast<float>(dynamic_mass / dynamic_volume);

  // Rounds filter exactly like a chunk, so a shot collides with the city on the
  // same terms its own debris does. Left at zero these would collide with
  // nothing at all -- the filter shader suppresses a pair whose groups do not
  // intersect -- and a shot would silently pass through the building.
  if (s.round_mask == 0) {
    s.round_group = collision_group;
    s.round_mask = collision_mask;
  }

  s.next_serial[structure_id] = 1; // 0 is the anchored support body.
  s.chunks.resize(base + nodes.size());
  s.nodes.resize(base + nodes.size());
  s.properties.resize(base + nodes.size());

  const PxTransform world(native_px(pose.position),
                          PxQuat(pose.rotation.x, pose.rotation.y,
                                 pose.rotation.z, pose.rotation.w));
  for (const auto &component : components) {
    PxRigidDynamic *actor = s.physics.createRigidDynamic(world);
    native_require(actor != nullptr, "native parent body allocation failed");
    s.parents.push_back(actor);
    const PxU32 cluster = static_cast<PxU32>(s.clusters.size());

    bool supported = false;
    std::vector<float> masses;
    masses.reserve(component.second.size());
    for (const PxU32 i : component.second) {
      const FfiChunkNodeDesc &n = nodes[i];
      native_require(n.node_index == i && n.volume > 0.0f,
                     "nodes must be authored in contiguous order with "
                     "positive volume");
      PxShape *shape = nullptr;
      if (n.geom_kind == 0) {
        shape = s.physics.createShape(PxBoxGeometry(native_px(n.half_extents)),
                                      s.material, true);
      } else if (n.geom_kind == 1) {
        std::vector<PxVec3> points;
        points.reserve(n.convex_points.size());
        for (const FfiVec3 &p : n.convex_points) {
          points.push_back(native_px(p));
        }
        PxConvexMeshDesc desc;
        desc.points.count = static_cast<PxU32>(points.size());
        desc.points.stride = sizeof(PxVec3);
        desc.points.data = points.data();
        desc.flags = PxConvexFlag::eCOMPUTE_CONVEX;
        desc.vertexLimit = 64;
        PxCookingParams params(s.physics.getTolerancesScale());
        // Without GPU data the hull falls back to CPU narrowphase, which for a
        // city of these is the difference between a GPU scene and a mostly-CPU
        // one -- and it shows up only as an unexplained tick cost.
        params.buildGPUData = true;
        PxConvexMesh *mesh = PxCreateConvexMesh(
            params, desc, s.physics.getPhysicsInsertionCallback());
        native_require(mesh != nullptr, "native convex cooking failed");
        shape = s.physics.createShape(PxConvexMeshGeometry(mesh), s.material,
                                      true);
        mesh->release();
      }
      native_require(shape != nullptr, "invalid or failed chunk geometry");
      shape->setLocalPose(PxTransform(native_px(n.centroid)));
      // word3's top bit marks this as a stage-owned chunk: the filter shader
      // drops contact notifications for those pairs, because the stage reads
      // the impulses on the GPU and the CPU callback has nothing to add.
      shape->setSimulationFilterData(
          PxFilterData(collision_group, collision_mask,
                       entity_id(structure_id, 0), kNativeChunkFilterBit));
      shape->setQueryFilterData(
          PxFilterData(collision_group, entity_id(structure_id, 0), 0, 0));
      native_require(actor->attachShape(*shape),
                     "persistent chunk shape attach failed");

      supported |= n.mass == 0.0f;
      const float mass = n.mass > 0.0f ? n.mass : density * n.volume;
      masses.push_back(mass);

      PxMassProperties props(shape->getGeometry());
      props = props * (mass / props.mass);
      const PxVec3 center = native_px(n.centroid) + props.centerOfMass;
      PxDestructionChunkMassProperties p{};
      p.mass = mass;
      p.supported = n.mass == 0.0f ? 1u : 0u;
      for (unsigned k = 0; k < 3; ++k) {
        p.center[k] = center[k];
        p.inertia[k] = props.inertiaTensor[k][k];
      }
      p.inertia[3] = props.inertiaTensor[1][0];
      p.inertia[4] = props.inertiaTensor[2][0];
      p.inertia[5] = props.inertiaTensor[2][1];

      s.chunks[base + i] = State::Chunk{shape, structure_id, i, 0,
                                        PX_INVALID_U32, 0};
      s.properties[base + i] = p;

      PxDestructionStressChunk node{};
      node.position = center;
      node.mass = n.mass;
      node.inertia =
          n.mass > 0.0f ? (props.inertiaTensor[0][0] + props.inertiaTensor[1][1] +
                           props.inertiaTensor[2][2]) /
                              3.0f
                        : 0.0f;
      node.cluster = cluster;
      node.contactIndex = PX_INVALID_U32; // bound in configure().
      node.volume = n.volume;
      node.material = material_base;
      s.nodes[base + i] = node;
    }

    native_require(PxRigidBodyExt::setMassAndUpdateInertia(
                       *actor, masses.data(),
                       static_cast<PxU32>(masses.size())),
                   "native parent mass/inertia failed");
    // A component holding an authored support is world-anchored, which is a
    // kinematic body here. The stage releases fragments from it as its bonds
    // break; the remnant stays kinematic for as long as it keeps an anchor.
    actor->setRigidBodyFlag(PxRigidBodyFlag::eKINEMATIC, supported);
    actor->setLinearDamping(settings.linear_damping);
    actor->setAngularDamping(settings.angular_damping);
    actor->userData = reinterpret_cast<void *>(
        static_cast<std::uintptr_t>(entity_id(structure_id, 0)) + 1u);
    s.scene.addActor(*actor);
    s.clusters.push_back(
        PxDestructionStressCluster{actor->getGPUIndex(),
                                   actor->getCMassLocalPose().p});
  }

  const std::size_t bond_base = s.bonds.size();
  double log_weight = 0.0;
  for (const FfiChunkBondDesc &b : bonds) {
    // Bond normals are authored per pair; the stage wants them oriented from
    // the lower chunk index to the higher, so flip when the authored order is
    // reversed rather than trusting the sign.
    const PxVec3 normal = native_px(b.normal) * (b.node0 < b.node1 ? 1.0f : -1.0f);
    native_require(normal.isFinite() && normal.magnitudeSquared() > 1e-8f,
                   "invalid bond normal");
    const float distance = (s.nodes[base + b.node0].position -
                            s.nodes[base + b.node1].position)
                               .magnitude();
    const float modulus = settings.materials[b.material].elastic_modulus;
    const float weight =
        std::sqrt((modulus > 0.0f ? modulus / kReferenceModulusPa : 1.0f) *
                  std::max(b.area, 1e-4f) / std::max(distance, 0.05f));
    log_weight += std::log(weight);

    PxDestructionStressBond bond{};
    bond.chunk0 = base + std::min(b.node0, b.node1);
    bond.chunk1 = base + std::max(b.node0, b.node1);
    bond.centroid = native_px(b.centroid);
    bond.normal = normal.getNormalized();
    bond.area = b.area;
    bond.health = 1.0f;
    bond.complianceScale = weight;
    bond.material = material_base + b.material;
    s.bonds.push_back(bond);
    s.bond_ids.emplace_back(structure_id, b.bond_index);
  }
  if (!bonds.empty()) {
    const float mean =
        std::exp(static_cast<float>(log_weight / static_cast<double>(bonds.size())));
    for (std::size_t i = bond_base; i < s.bonds.size(); ++i) {
      s.bonds[i].complianceScale /= mean;
    }
  }
}

FfiNativeConfigured NativeDestruction::configure(const FfiNativeConfig &config) {
  State &s = *state_;
  native_require(!s.configured, "the native stage is already configured");
  native_require(!s.nodes.empty(), "no structure has been authored");

  PxDestructionScene &api = s.stage();
  for (PxU32 i = 0; i < s.nodes.size(); ++i) {
    s.nodes[i].contactIndex = api.getShapeContactIndex(*s.chunks[i].shape);
    native_require(s.nodes[i].contactIndex != PX_INVALID_U32,
                   "chunk collision identity is not allocated yet; the scene "
                   "must complete one step after the chunks are added");
  }
  for (PxU32 i = 0; i < s.parents.size(); ++i) {
    s.clusters[i].body = s.parents[i]->getGPUIndex();
  }

  PxDestructionStressDesc desc;
  desc.chunks = s.nodes.data();
  desc.chunkCount = static_cast<PxU32>(s.nodes.size());
  desc.bonds = s.bonds.data();
  desc.bondCount = static_cast<PxU32>(s.bonds.size());
  desc.clusters = s.clusters.data();
  desc.clusterCount = static_cast<PxU32>(s.clusters.size());
  desc.chunkMassProperties = s.properties.data();
  desc.materials = s.materials.data();
  desc.materialCount = static_cast<PxU32>(s.materials.size());
  desc.maxIterations = config.max_iterations;
  desc.tolerance = config.tolerance;
  desc.warmStart = config.warm_start;
  desc.damageRate = config.damage_rate;
  desc.bendGainMax = config.bend_gain_max;
  desc.fibreBending = config.fibre_bending;
  // One trial evaluation plus one corrected rigid pass. Zero would leave the
  // stage in its diagnostic mode, where any membership-changing verdict is
  // rejected -- that is, a city that can never actually break.
  desc.internalCorrectionLimit = correction_limit();
  desc.preserveUnchangedContactPairs = config.preserve_unchanged_contact_pairs;
  std::fprintf(stderr, "[destruction] native internalCorrectionLimit=%u\n",
               unsigned(desc.internalCorrectionLimit));
#if VIBE_PHYSX_DESTRUCTION_SCENE_VERSION >= 16
  // Pre-touching contact-pair storage arrived in API v16. Without it the first
  // impact pages this memory in on the simulation thread, which shows up as one
  // unexplained spike at the moment of first contact and nowhere else.
  desc.reservedContactPairs = config.reserved_contact_pairs;
#endif
  desc.gpuIslandRepair = config.gpu_island_repair;

  native_require(api.configureStress(desc),
                 "native destruction configuration was rejected");
  s.configured = true;
  s.verdict_sample_interval = std::max(1u, config.verdict_sample_ticks);

  FfiNativeConfigured out{};
  out.chunks = static_cast<std::uint32_t>(s.nodes.size());
  out.bonds = static_cast<std::uint32_t>(s.bonds.size());
  out.clusters = static_cast<std::uint32_t>(s.clusters.size());
  out.materials = static_cast<std::uint32_t>(s.materials.size());
#if VIBE_PHYSX_DESTRUCTION_SCENE_VERSION >= 16
  out.reserved_pairs = config.reserved_contact_pairs;
#else
  // Reported as zero rather than as what we asked for: this SDK cannot reserve.
  out.reserved_pairs = 0;
#endif
  return out;
}

FfiNativeStatus NativeDestruction::tick() {
  State &s = *state_;
  FfiNativeStatus out{};
  if (!s.configured) {
    return out;
  }
  const double started = now_ms();
  s.tick_index += 1;

  const double status_started = now_ms();
  s.last = s.stage().getLastStatus();
  s.status_read_ms = now_ms() - status_started;

  out.frame = s.last.frame;
  out.error = s.last.error;
  out.iterations = s.last.iterations;
  out.converged = s.last.converged != 0;
  out.normal_contacts = s.last.normalContacts;
  out.friction_anchors = s.last.frictionAnchors;
  out.bond_commands = s.last.bondCommands;
  out.broken_bonds = s.last.brokenBonds;
  out.crushed_chunks = s.last.crushedChunks;
  out.correction_passes = s.last.correctionPasses;
  out.stress_passes = s.last.stressPasses;
  out.post_correction_broken_bonds = s.last.postCorrectionBrokenBonds;

  s.stress_iterations_peak =
      std::max(s.stress_iterations_peak, s.last.iterations);

  // A solve that ran out of iterations is not an error. It is a partial answer
  // that the solver keeps and refines on the next tick, exactly as the Blast
  // stress solver did, so it is counted and otherwise ignored.
  if (s.last.converged == 0) {
    s.unconverged_frames += 1;
  }

  // The stage publishes nothing for a step it could not complete, and a
  // rejected step is not a world anyone may be shown. Bit 8192 says the scene
  // cannot continue at all; everything else leaves the previous accepted state
  // standing and is reported, never smoothed over.
  if (s.last.error != 0) {
    s.error_frames += 1;
    s.error_bits_last = s.last.error;
    if ((s.last.error & 8192u) != 0) {
      s.degraded = true;
    }
    out.observed = false;
    out.degraded = s.degraded;
    s.tick_ms = now_ms() - started;
    return out;
  }

  if (s.last.frame == s.observed_frame) {
    // Already observed this frame (a second tick inside one step, or a step
    // that did not run). Reporting it again would double-count events.
    out.observed = false;
    out.degraded = s.degraded;
    s.tick_ms = now_ms() - started;
    return out;
  }

  s.observed_chunks = 0;
  s.observed_bonds = 0;
  s.observation_bytes = 0;
  const std::uint64_t expected = s.observed_frame + 1;
  const bool gap = s.observed_frame != 0 && s.last.frame != expected;
  if (gap) {
    s.missed_frames += s.last.frame - expected;
  }

  {
    const PxDestructionDeviceView view = s.stage().getDeviceView();
    NativeReadback read(s.scene, view.readyEvent);
    const double observe_started = now_ms();
    if (gap) {
      // The delta stream is only valid frame to frame. After a gap the only
      // honest recovery is a full re-read of accepted topology.
      s.rebuild_from_accepted_topology(view);
      s.full_reobservations += 1;
    } else {
      s.observe_topology(view);
    }
    s.observe_ms = now_ms() - observe_started;

    s.verdict_sample_age += 1;
    if (s.verdict_sample_age >= s.verdict_sample_interval) {
      const double verdict_started = now_ms();
      s.sample_bond_verdicts(view);
      s.verdict_ms = now_ms() - verdict_started;
      s.verdict_sample_age = 0;
    } else {
      s.verdict_ms = 0.0;
    }
  }

  s.corrections_total += s.last.correctionPasses;
  s.completed_updates += s.last.stressPasses;
  s.crush_yield_nodes += s.last.crushedChunks;
  if (s.last.iterations > 0) {
    s.active_island_updates += s.stress_islands;
  }
  s.observed_frame = s.last.frame;

  const double rounds_started = now_ms();
  s.expire_rounds();
  s.rounds_ms = now_ms() - rounds_started;

  const double snapshot_started = now_ms();
  s.refresh_snapshots();
  s.snapshot_ms = now_ms() - snapshot_started;

  out.committed_chunks = s.observed_chunks;
  out.committed_bonds = s.observed_bonds;
  out.cluster_count = static_cast<std::uint32_t>(s.bodies.size());
  out.stress_island_count = s.stress_islands;
  out.observed = true;
  out.degraded = s.degraded;
  out.missed_frames = static_cast<std::uint32_t>(s.missed_frames);
  s.tick_ms = now_ms() - started;
  return out;
}

FfiNativeStatus NativeDestruction::last_status() const {
  State &s = *state_;
  FfiNativeStatus out{};
  if (!s.configured) {
    return out;
  }
  const PxDestructionStageStatus status = s.stage().getLastStatus();
  out.frame = status.frame;
  out.error = status.error;
  out.iterations = status.iterations;
  out.converged = status.converged != 0;
  out.normal_contacts = status.normalContacts;
  out.friction_anchors = status.frictionAnchors;
  out.bond_commands = status.bondCommands;
  out.broken_bonds = status.brokenBonds;
  out.crushed_chunks = status.crushedChunks;
  out.correction_passes = status.correctionPasses;
  out.stress_passes = status.stressPasses;
  out.post_correction_broken_bonds = status.postCorrectionBrokenBonds;
  out.cluster_count = static_cast<std::uint32_t>(s.bodies.size());
  out.stress_island_count = s.stress_islands;
  out.degraded = s.degraded;
  return out;
}

FfiChunkAim NativeDestruction::chunk_aim(std::uint32_t structure_id,
                                         std::uint32_t node_index) const {
  FfiChunkAim out{};
  const State &s = *state_;
  for (const auto &chunk : s.chunks) {
    if (chunk.structure != structure_id || chunk.authored != node_index) {
      continue;
    }
    if (chunk.shape == nullptr) {
      break; // destroyed; report not found rather than a stale position
    }
    PxRigidActor *actor = chunk.shape->getActor();
    if (actor == nullptr) {
      break;
    }
    const PxTransform pose = actor->getGlobalPose();
    out.found = true;
    out.chunk_id = native_chunk_id(structure_id, node_index);
    out.structure_id = structure_id;
    out.entity_id = entity_id(chunk.structure, chunk.serial);
    // The shape's local pose is the chunk's centroid in the body frame, which
    // is the point to aim at: the body origin can be metres away once a
    // fragment carries several chunks.
    out.center = native_ffi(pose.transform(chunk.shape->getLocalPose().p));
    PxRigidDynamic *dynamic = actor->is<PxRigidDynamic>();
    out.sleeping = dynamic != nullptr && dynamic->isSleeping();
    break;
  }
  return out;
}

FfiChunkRayHit NativeDestruction::raycast_chunk(const FfiVec3 &origin,
                                                const FfiVec3 &direction,
                                                float max_distance) const {
  FfiChunkRayHit out{};
  const State &s = *state_;
  native_require(std::isfinite(max_distance) && max_distance > 0.0f,
                 "chunk raycast distance must be finite and positive");
  PxVec3 ray = native_px(direction);
  const float magnitude = ray.magnitude();
  native_require(magnitude > 1.0e-6f, "chunk raycast direction has zero length");
  ray /= magnitude;

  PxRaycastBuffer buffer;
  // Unfiltered by group on purpose: a shot that is stopped by the ground or by
  // a fragment in front of the intended chunk has NOT reached it, and a test
  // that filters those away would call that a hit.
  if (!s.scene.raycast(native_px(origin), ray, max_distance, buffer,
                       PxHitFlag::ePOSITION | PxHitFlag::eNORMAL) ||
      !buffer.hasBlock) {
    return out;
  }
  out.distance = buffer.block.distance;
  out.position = native_ffi(buffer.block.position);
  out.normal = native_ffi(buffer.block.normal);
  out.chunk_id = ~0u;
  for (const auto &chunk : s.chunks) {
    if (chunk.shape != buffer.block.shape) {
      continue;
    }
    out.hit = true;
    out.chunk_id = native_chunk_id(chunk.structure, chunk.authored);
    out.structure_id = chunk.structure;
    out.entity_id = entity_id(chunk.structure, chunk.serial);
    break;
  }
  return out;
}

std::uint32_t NativeDestruction::fire_round(const FfiRoundDesc &desc) {
  State &s = *state_;
  native_require(s.configured, "no native city to shoot at");
  native_require(desc.speed > 0.0f && desc.radius > 0.0f &&
                     desc.momentum_ns > 0.0f,
                 "a round needs positive speed, radius and momentum");
  const PxVec3 direction = native_px(desc.direction).getNormalized();
  native_require(direction.isFinite() && direction.magnitudeSquared() > 0.0f,
                 "a round needs a direction");

  // The stage takes loads only from PhysX's own solved contacts, so a shot is
  // delivered by a real body carrying the round's momentum. Mass follows from
  // momentum and speed rather than being invented: p = m*v.
  const float mass = desc.momentum_ns / desc.speed;
  const PxVec3 origin =
      native_px(desc.position) - direction * (desc.radius + 0.05f);

  PxRigidDynamic *body = s.physics.createRigidDynamic(PxTransform(origin));
  native_require(body != nullptr, "round body allocation failed");
  PxShape *shape = s.physics.createShape(PxSphereGeometry(desc.radius),
                                         s.material, true);
  native_require(shape != nullptr, "round shape allocation failed");
  // Collides with the world and the city; invisible to scene queries (query
  // word0 zero) so a round can never be mistaken for a shootable entity, and
  // carries the native-chunk notify suppression so it adds no callback cost.
  shape->setSimulationFilterData(PxFilterData(s.round_group, s.round_mask, 0,
                                              kNativeChunkFilterBit));
  shape->setQueryFilterData(PxFilterData(0, 0, 0, 0));
  body->attachShape(*shape);
  shape->release();
  // Mass and inertia have to describe the SAME body. Computing the inertia at
  // some convenient density and then overwriting the mass leaves a body whose
  // mass-to-inertia ratio is whatever the two happened to disagree by -- here a
  // factor of ~10^6 for a production-weight round -- and a solver handed that
  // produces angular responses wildly out of scale with the collision. Solid
  // sphere: I = 2/5 m r^2, the same expression the reference demo uses for its
  // projectiles.
  const PxReal inertia = 0.4f * mass * desc.radius * desc.radius;
  native_require(std::isfinite(mass) && mass > 0.0f && std::isfinite(inertia) &&
                     inertia > 0.0f,
                 "round mass and inertia must be finite and positive");
  body->setMass(mass);
  body->setMassSpaceInertiaTensor(PxVec3(inertia));
  body->setLinearDamping(0.0f);
  body->setAngularDamping(0.0f);
  body->setLinearVelocity(direction * desc.speed);
  s.scene.addActor(*body);

  // A bounded pool: a round is spent within a few ticks, so an unbounded
  // population would be a leak, and silently dropping the oldest without
  // saying so would hide it. The eviction is counted and published.
  constexpr std::size_t kMaxLiveRounds = 64;
  if (s.rounds.size() >= kMaxLiveRounds) {
    NativeRound oldest = s.rounds.front();
    s.rounds.erase(s.rounds.begin());
    if (oldest.actor != nullptr) {
      s.scene.removeActor(*oldest.actor);
      oldest.actor->release();
    }
    s.rounds_evicted += 1;
  }
  s.rounds.push_back(
      NativeRound{body, s.tick_index + std::max<std::uint32_t>(desc.ttl_ticks, 1u)});
  s.rounds_fired += 1;
  return static_cast<std::uint32_t>(s.rounds.size());
}

void NativeDestruction::State::expire_rounds() {
  auto it = rounds.begin();
  while (it != rounds.end()) {
    if (tick_index >= it->expires_tick) {
      if (it->actor != nullptr) {
        scene.removeActor(*it->actor);
        it->actor->release();
      }
      it = rounds.erase(it);
    } else {
      ++it;
    }
  }
}

void NativeDestruction::State::release_rounds() {
  for (NativeRound &round : rounds) {
    if (round.actor != nullptr) {
      scene.removeActor(*round.actor);
      round.actor->release();
    }
  }
  rounds.clear();
}

} // namespace vibe_land::physx_bridge
