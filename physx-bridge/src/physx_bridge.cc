#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "PxPhysicsAPI.h"

#ifdef VIBE_LAND_DESTRUCTION
#include "destruction.h"
#endif

#if defined(__x86_64__) || defined(_M_X64)
#include <x86intrin.h>
#define VIBE_HAVE_RDTSC 1
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vibe_land::physx_bridge {
namespace {

using namespace physx;

constexpr float kFixedTimestep = 1.0f / 60.0f;
// Match Rapier gameplay push (shared/src/simulation.rs).
constexpr float kPlayerInteractionMass = 2.5f;
constexpr float kPlayerPushImpulseScale = 1.15f;
constexpr float kMinPushSpeedMps = 0.75f;
constexpr float kMinHorizontalRetain = 0.35f;
constexpr std::size_t kMaxPushedBodiesPerMove = 6;

enum class RecordKind : std::uint8_t {
  StaticBox = 1,
  Heightfield = 2,
  DynamicBox = 3,
  DynamicSphere = 4,
  VehicleChassis = 5,
  Player = 6,
};

struct Record {
  std::uint32_t entity_id = 0;
  std::uint32_t user_id = 0;
  std::uint32_t collision_group = 0;
  std::uint32_t collision_mask = 0;
  RecordKind kind = RecordKind::StaticBox;
  PxRigidActor *actor = nullptr;
  PxController *controller = nullptr;
  PxVec3 player_velocity{0.0f};
  bool grounded = false;
  float player_step_offset = 0.0f;
  float player_radius = 0.0f;
};

bool finite(float value) { return std::isfinite(value); }

void require(bool condition, const char *message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

PxVec3 to_px(const FfiVec3 &value) {
  require(finite(value.x) && finite(value.y) && finite(value.z),
          "vector contains a non-finite component");
  return {value.x, value.y, value.z};
}

FfiVec3 from_px(const PxVec3 &value) {
  return {value.x, value.y, value.z};
}

PxTransform to_px(const FfiPose &value) {
  const PxVec3 position = to_px(value.position);
  require(finite(value.rotation.x) && finite(value.rotation.y) &&
              finite(value.rotation.z) && finite(value.rotation.w),
          "quaternion contains a non-finite component");
  PxQuat rotation(value.rotation.x, value.rotation.y, value.rotation.z,
                  value.rotation.w);
  const float magnitude = rotation.magnitude();
  require(magnitude > 1.0e-6f, "quaternion has zero length");
  rotation.normalize();
  return {position, rotation};
}

FfiPose from_px(const PxTransform &value) {
  return {{value.p.x, value.p.y, value.p.z},
          {value.q.x, value.q.y, value.q.z, value.q.w}};
}

void require_positive_vec3(const FfiVec3 &value, const char *message) {
  require(finite(value.x) && finite(value.y) && finite(value.z) &&
              value.x > 0.0f && value.y > 0.0f && value.z > 0.0f,
          message);
}

void configure_shape(PxShape &shape, std::uint32_t entity_id,
                     std::uint32_t group, std::uint32_t mask) {
  shape.setSimulationFilterData(PxFilterData(group, mask, entity_id, 0));
  shape.setQueryFilterData(PxFilterData(group, entity_id, 0, 0));
}

std::uint32_t actor_entity_id(const PxActor *actor) {
  if (actor == nullptr || actor->userData == nullptr) {
    return 0;
  }
  return static_cast<std::uint32_t>(
      reinterpret_cast<std::uintptr_t>(actor->userData) - 1);
}

void tag_actor(PxActor &actor, std::uint32_t entity_id) {
  actor.userData =
      reinterpret_cast<void *>(static_cast<std::uintptr_t>(entity_id) + 1);
}

/// A/B for the onContact common-subexpression work. Value-checked: a presence
/// check here would make `=0` mean "on", which has already bitten this tree.
bool contact_cse_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_CONTACT_CSE");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// Cycle counter for probes that fire thousands of times per tick.
///
/// `steady_clock::now()` costs ~20-25 ns; `rdtsc` costs ~7. At cascade rates
/// (6.5k contact callbacks/tick, two reads each) that is the difference
/// between ~0.30 ms of measurement overhead and ~0.09 -- and the 0.30 was
/// enough to swamp the very costs the sub-span probes were added to price.
/// Cheap enough to time EVERY callback exactly instead of extrapolating from
/// a 1-in-8 sample, which is the point: an exact small number beats a
/// sampled large one.
///
/// Assumes an invariant TSC (every x86-64 CPU since Nehalem). The
/// calibration below is checked against steady_clock at startup, and
/// end_step cross-checks the result against a wall-clock bracket every tick,
/// publishing `tsc_suspect` if they disagree — a clock this code trusts must
/// be able to report its own failure.
inline std::uint64_t cycle_now() {
#ifdef VIBE_HAVE_RDTSC
  return __rdtsc();
#else
  return static_cast<std::uint64_t>(
      std::chrono::steady_clock::now().time_since_epoch().count());
#endif
}

/// Milliseconds per cycle, calibrated once against steady_clock.
double cycles_to_ms_factor() {
  static const double factor = [] {
#ifdef VIBE_HAVE_RDTSC
    const auto wall_start = std::chrono::steady_clock::now();
    const std::uint64_t cycle_start = cycle_now();
    // 20 ms is long enough that scheduler noise is <1% and short enough to
    // stay invisible in startup.
    while (std::chrono::steady_clock::now() - wall_start <
           std::chrono::milliseconds(20)) {
    }
    const std::uint64_t cycles = cycle_now() - cycle_start;
    const double ms = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - wall_start)
                          .count();
    if (cycles == 0 || ms <= 0.0) {
      return 0.0;
    }
    return ms / static_cast<double>(cycles);
#else
    // steady_clock fallback: cycle_now already returns its native ticks.
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::duration(1))
        .count();
#endif
  }();
  return factor;
}

/// How often to measure PhysX's own simulation wall time by polling instead
/// of blocking. 0 disables; N samples one tick in N.
///
/// The poll does not merely add overhead: it converts a blocking wait into a
/// spin, so the sampled tick pays its whole sim_wall in burnt core, competing
/// with PhysX's task threads and the Blast walks. Cost is therefore
/// sim_wall / interval. Measured at interval 16 on a grid-2 bombardment:
/// +0.29 ms/tick weighted, against 4.8 ms sim_wall at load — 4.8/16 = 0.30
/// predicted, so the model is linear and trustworthy.
///
/// Default 64 = ~0.075 ms/tick, about one sample a second, which is dozens
/// of samples per regime across any real session. That is the point of
/// sampling rather than the old all-or-nothing PROFILE_FETCH (+0.91 ms and
/// therefore off in production): the split is now cheap enough to leave ON
/// while people play.
unsigned gpu_sample_interval() {
  static const unsigned interval = [] {
    if (const char *raw = std::getenv("VIBE_PHYSX_GPU_SAMPLE_TICKS")) {
      const long parsed = std::atol(raw);
      return parsed < 0 ? 0u : static_cast<unsigned>(parsed);
    }
    return 64u;
  }();
  return interval;
}

/// A/B for the A1+A2 lookup elisions: note_pair_load reusing the manifold's
/// resolved targets, and queueContact taking a pre-resolved Blast node.
/// ON by default; `=0` restores the original per-side / per-point lookups.
///
/// A runtime switch rather than two builds on purpose: one binary means the
/// arms cannot differ by anything else, which is the failure mode that has
/// wasted the most time on this tree.
bool contact_fastpath_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_CONTACT_FASTPATH");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// Sub-attribution of the callback cost (cb_extract/queue/pair_load/wake).
/// OFF by default: four extra clock-read pairs per sampled callback measured
/// +0.35 ms at 2-4k callbacks/tick and +0.80 at 4-8k -- larger than the
/// costs they were added to find. Same lesson as the fetch-split busy-poll:
/// a probe that changes the number is a diagnostic mode, not a metric.
bool profile_callback_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_PROFILE_CALLBACK");
    return value != nullptr && std::string(value) != "0";
  }();
  return enabled;
}

bool contact_persists_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_CONTACT_PERSISTS");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}


/// Solver iteration counts for dynamic bodies.
///
/// VIBE_PHYSX_POSITION_ITERS / VIBE_PHYSX_VELOCITY_ITERS. Defaults match
/// PhysX's own (4/1) so behaviour is unchanged unless asked; the stack-settling
/// test sweeps them to locate the knee.
std::uint32_t dynamic_solver_position_iterations() {
  if (const char *raw = std::getenv("VIBE_PHYSX_POSITION_ITERS")) {
    const long parsed = std::strtol(raw, nullptr, 10);
    if (parsed > 0) return static_cast<std::uint32_t>(parsed);
  }
  return 4u;
}

std::uint32_t dynamic_solver_velocity_iterations() {
  if (const char *raw = std::getenv("VIBE_PHYSX_VELOCITY_ITERS")) {
    const long parsed = std::strtol(raw, nullptr, 10);
    if (parsed > 0) return static_cast<std::uint32_t>(parsed);
  }
  return 1u;
}

PxFilterFlags simulation_filter(PxFilterObjectAttributes attributes0,
                                PxFilterData filter0,
                                PxFilterObjectAttributes attributes1,
                                PxFilterData filter1, PxPairFlags &pair_flags,
                                const void *, PxU32) {
  if (PxFilterObjectIsTrigger(attributes0) ||
      PxFilterObjectIsTrigger(attributes1)) {
    pair_flags = PxPairFlag::eTRIGGER_DEFAULT;
    return PxFilterFlag::eDEFAULT;
  }
  if ((filter0.word0 & filter1.word1) == 0 ||
      (filter1.word0 & filter0.word1) == 0) {
    return PxFilterFlag::eSUPPRESS;
  }
  // FOUND fires when a contact first exceeds the threshold; PERSISTS re-fires
  // every tick for as long as it stays there.
  //
  // PERSISTS is the standing-load channel and is required for correctness, not
  // a diagnostic. A severed island gets no bond stress from gravity — uniform
  // per-node acceleration on an unanchored body is a rigid translation — so
  // the ground's continuous reaction force is the ONLY thing that reproduces
  // the load path its foundation used to provide. With FOUND alone a landed
  // slab reports one impact and then rests stress-free forever, which is what
  // made severed halves indestructible.
  //
  // The historical objection was cost and bodies never sleeping. Contacts now
  // route with wake=false, and a sleeping pair generates no narrowphase at
  // all, so a settled pile costs nothing. VIBE_PHYSX_CONTACT_PERSISTS=0 is the
  // kill switch if a pathological scene turns up.
  pair_flags = PxPairFlag::eCONTACT_DEFAULT |
               PxPairFlag::eNOTIFY_THRESHOLD_FORCE_FOUND |
               PxPairFlag::eNOTIFY_CONTACT_POINTS;
  if (contact_persists_enabled()) {
    pair_flags |= PxPairFlag::eNOTIFY_THRESHOLD_FORCE_PERSISTS;
  }
  return PxFilterFlag::eDEFAULT;
}

class MaskQueryFilter final : public PxQueryFilterCallback {
public:
  MaskQueryFilter(std::uint32_t mask, bool has_ignore,
                  std::uint32_t ignore_entity)
      : mask_(mask), has_ignore_(has_ignore),
        ignore_entity_(ignore_entity) {}

  PxQueryHitType::Enum preFilter(const PxFilterData &, const PxShape *shape,
                                 const PxRigidActor *actor,
                                 PxHitFlags &) override {
    if (has_ignore_ && actor_entity_id(actor) == ignore_entity_) {
      return PxQueryHitType::eNONE;
    }
    return (shape->getQueryFilterData().word0 & mask_) != 0
               ? PxQueryHitType::eBLOCK
               : PxQueryHitType::eNONE;
  }

  PxQueryHitType::Enum postFilter(const PxFilterData &, const PxQueryHit &,
                                  const PxShape *,
                                  const PxRigidActor *) override {
    return PxQueryHitType::eBLOCK;
  }

private:
  std::uint32_t mask_;
  bool has_ignore_;
  std::uint32_t ignore_entity_;
};

class LoggingErrorCallback final : public PxErrorCallback {
public:
  void reportError(PxErrorCode::Enum code, const char *message,
                   const char *file, int line) override {
    std::fprintf(stderr, "PhysX[%d] %s (%s:%d)\n", static_cast<int>(code),
                 message != nullptr ? message : "unknown error",
                 file != nullptr ? file : "unknown", line);
    if (code != PxErrorCode::eDEBUG_INFO &&
        code != PxErrorCode::eDEBUG_WARNING) {
      warning_count_.fetch_add(1, std::memory_order_relaxed);
    }
    if (message != nullptr) {
      const std::string text(message);
      if (text.find("buffer") != std::string::npos ||
          text.find("GPU") != std::string::npos ||
          text.find("gpu") != std::string::npos) {
        warning_count_.fetch_add(1, std::memory_order_relaxed);
      }
    }
  }

  std::uint32_t warning_count() const {
    return warning_count_.load(std::memory_order_relaxed);
  }

private:
  std::atomic<std::uint32_t> warning_count_{0};
};

// PhysX permits only one PxFoundation per process. Individual matches still
// own isolated PxScene instances, while this process-wide runtime owns the
// foundation, PxPhysics SDK, and CUDA context shared by those scenes.
class SharedPhysxRuntime final {
public:
  SharedPhysxRuntime() {
    try {
      foundation_ =
          PxCreateFoundation(PX_PHYSICS_VERSION, allocator_, error_callback_);
      require(foundation_ != nullptr, "PxCreateFoundation failed");
      physics_ = PxCreatePhysics(PX_PHYSICS_VERSION, *foundation_,
                                 PxTolerancesScale(), false, nullptr);
      require(physics_ != nullptr, "PxCreatePhysics failed");

      PxCudaContextManagerDesc cuda_desc;
      cuda_context_ = PxCreateCudaContextManager(*foundation_, cuda_desc,
                                                 PxGetProfilerCallback());
      require(cuda_context_ != nullptr,
              "PxCreateCudaContextManager failed (CUDA/driver unavailable)");
      require(cuda_context_->contextIsValid(),
              "PhysX CUDA context is invalid (no usable NVIDIA GPU)");
    } catch (...) {
      teardown();
      throw;
    }
  }

  ~SharedPhysxRuntime() { teardown(); }

  SharedPhysxRuntime(const SharedPhysxRuntime &) = delete;
  SharedPhysxRuntime &operator=(const SharedPhysxRuntime &) = delete;

  PxPhysics &physics() const {
    require(physics_ != nullptr, "PhysX runtime is not initialized");
    return *physics_;
  }

  PxCudaContextManager &cuda_context() const {
    require(cuda_context_ != nullptr, "PhysX CUDA context is not initialized");
    return *cuda_context_;
  }

  std::uint32_t warning_count() const {
    return error_callback_.warning_count();
  }

private:
  void teardown() noexcept {
    if (cuda_context_ != nullptr) {
      cuda_context_->release();
      cuda_context_ = nullptr;
    }
    if (physics_ != nullptr) {
      physics_->release();
      physics_ = nullptr;
    }
    if (foundation_ != nullptr) {
      foundation_->release();
      foundation_ = nullptr;
    }
  }

  PxDefaultAllocator allocator_;
  LoggingErrorCallback error_callback_;
  PxFoundation *foundation_ = nullptr;
  PxPhysics *physics_ = nullptr;
  PxCudaContextManager *cuda_context_ = nullptr;
};

std::shared_ptr<SharedPhysxRuntime> acquire_physx_runtime() {
  static std::mutex runtime_mutex;
  static std::weak_ptr<SharedPhysxRuntime> weak_runtime;

  std::lock_guard<std::mutex> lock(runtime_mutex);
  std::shared_ptr<SharedPhysxRuntime> runtime = weak_runtime.lock();
  if (runtime == nullptr) {
    runtime = std::make_shared<SharedPhysxRuntime>();
    weak_runtime = runtime;
  }
  return runtime;
}

} // namespace

class World::Impl : public PxUserControllerHitReport,
                    public PxControllerBehaviorCallback,
                    public PxSimulationEventCallback {
public:
  explicit Impl(const FfiWorldConfig &config) {
    try {
      initialize(config);
    } catch (...) {
      teardown();
      throw;
    }
  }

  ~Impl() { teardown(); }

  void onShapeHit(const PxControllerShapeHit &hit) override {
    PxRigidDynamic *dynamic =
        hit.actor != nullptr ? hit.actor->is<PxRigidDynamic>() : nullptr;
    if (dynamic == nullptr || dynamic->getRigidBodyFlags().isSet(
                                  PxRigidBodyFlag::eKINEMATIC)) {
      return;
    }
    // Landing / standing contacts must not shove supports into the ground.
    if (PxAbs(hit.dir.y) > 0.85f) {
      return;
    }

    PxVec3 push_dir(pending_player_velocity_.x, 0.0f,
                    pending_player_velocity_.z);
    const float player_speed = push_dir.normalize();
    if (player_speed < kMinPushSpeedMps) {
      return;
    }

    const PxExtendedVec3 controller_pos = hit.controller->getPosition();
    PxVec3 to_body(dynamic->getGlobalPose().p.x -
                       static_cast<float>(controller_pos.x),
                   0.0f,
                   dynamic->getGlobalPose().p.z -
                       static_cast<float>(controller_pos.z));
    if (to_body.normalize() > 1.0e-3f && push_dir.dot(to_body) < -0.25f) {
      // Only push bodies roughly in front of the intended horizontal motion.
      return;
    }

    const float body_speed = dynamic->getLinearVelocity().dot(push_dir);
    const float closing_speed = player_speed - body_speed;
    if (closing_speed <= 0.0f) {
      return;
    }

    if (pushed_actors_this_move_.size() >= kMaxPushedBodiesPerMove) {
      return;
    }
    if (!pushed_actors_this_move_.insert(dynamic).second) {
      return;
    }

    const float body_mass = PxMax(dynamic->getMass(), 0.05f);
    const float resistance =
        PxClamp(kPlayerInteractionMass / (kPlayerInteractionMass + body_mass),
                kMinHorizontalRetain, 1.0f);
    const float impulse_mag = kPlayerInteractionMass * closing_speed *
                              (1.0f - resistance) *
                              kPlayerPushImpulseScale;
    if (impulse_mag <= 1.0e-6f) {
      return;
    }

    const PxVec3 world_pos(static_cast<float>(hit.worldPos.x),
                           static_cast<float>(hit.worldPos.y),
                           static_cast<float>(hit.worldPos.z));
    PxRigidBodyExt::addForceAtPos(*dynamic, push_dir * impulse_mag, world_pos,
                                  PxForceMode::eIMPULSE);
  }

  void onControllerHit(const PxControllersHit &) override {}
  void onObstacleHit(const PxControllerObstacleHit &) override {}

  PxControllerBehaviorFlags getBehaviorFlags(const PxShape &,
                                               const PxActor &) override {
    return PxControllerBehaviorFlag::eCCT_CAN_RIDE_ON_OBJECT |
           PxControllerBehaviorFlag::eCCT_SLIDE;
  }

  PxControllerBehaviorFlags
  getBehaviorFlags(const PxController &) override {
    return PxControllerBehaviorFlag::eCCT_SLIDE;
  }

  PxControllerBehaviorFlags getBehaviorFlags(const PxObstacle &) override {
    return PxControllerBehaviorFlag::eCCT_SLIDE;
  }

  void onConstraintBreak(PxConstraintInfo *, PxU32) override {}
  void onWake(PxActor **, PxU32) override {}
  void onSleep(PxActor **, PxU32) override {}
  void onTrigger(PxTriggerPair *, PxU32) override {}
  void onAdvance(const PxRigidBody *const *, const PxTransform *,
                 const PxU32) override {}

  void onContact(const PxContactPairHeader &header,
                 const PxContactPair *pairs, PxU32 pair_count) override {
    // EXACT self-timing: this callback runs INSIDE fetchResults, so its cost
    // lands undifferentiated in the result-copy number — the conflation that
    // fed a whole wrong optimization line. Every invocation is now timed with
    // the cycle counter (~7 ns/read) rather than 1-in-8 with steady_clock
    // (~25 ns), so the published figure is a measurement rather than an
    // extrapolation, at ~0.09 ms/tick of overhead at cascade rates.
    ++contact_callback_calls_;
    ++contact_callbacks_this_step_;
    const std::uint64_t callback_started = cycle_now();
    // Sub-attribution costs more than the parts it prices; opt-in only, and
    // still sampled when on.
    const bool sample_subspans =
        profile_callback_enabled() && (contact_callback_calls_ & 7u) == 0;
    const std::uint32_t entity_a = actor_entity_id(header.actors[0]);
    const std::uint32_t entity_b = actor_entity_id(header.actors[1]);
    for (PxU32 pair_index = 0; pair_index < pair_count; ++pair_index) {
      const PxContactPair &pair = pairs[pair_index];
      if (pair.flags & (PxContactPairFlag::eREMOVED_SHAPE_0 |
                        PxContactPairFlag::eREMOVED_SHAPE_1)) {
        continue;
      }
      const PxU32 contact_count = pair.contactCount;
      if (contact_count == 0) {
        continue;
      }
      // Reused across pairs and ticks. This was a fresh heap allocation per
      // reported manifold, and a settled city reports thousands of resting
      // manifolds every tick -- all of it inside fetchResults(), which is what
      // physics_fetch_copy_ms actually measures.
      //
      // VIBE_PHYSX_CONTACT_CSE=0 restores the old shape: allocate per manifold
      // and resolve the owning slot per contact POINT.
      if (!contact_cse_enabled()) {
        contact_points_ = std::vector<physx::PxContactPairPoint>();
      }
      // A0 sub-attribution: on sampled calls, each sub-block below is timed
      // so the ~9 ms callback cost decomposes BEFORE anything is optimized.
      // Same 1-in-8 gate as the outer probe; x8 scaling at publish.
      const auto sub_now = [&]() {
        return sample_subspans ? std::chrono::steady_clock::now()
                                : std::chrono::steady_clock::time_point{};
      };
      const auto sub_ms = [](std::chrono::steady_clock::time_point from) {
        return std::chrono::duration<double, std::milli>(
                   std::chrono::steady_clock::now() - from)
            .count();
      };
      const auto extract_started = sub_now();
      contact_points_.resize(contact_count);
      const PxU32 extracted =
          pair.extractContacts(contact_points_.data(), contact_count);
      if (sample_subspans) {
        // x8, same convention as the outer contact_callback_ms_ probe.
        cb_extract_ms_ += 8.0 * sub_ms(extract_started);
      }
      const std::vector<PxContactPairPoint> &points = contact_points_;
#ifdef VIBE_LAND_DESTRUCTION
      // Once per shape per manifold, not once per shape per POINT. Every point
      // in a manifold shares the same two shapes, so the hash lookup and the
      // linear slot scan behind them were repeated for every point after the
      // first -- 2.06-3.64 points per manifold measured on downtown.
      DestructionManager::ContactTarget target0;
      DestructionManager::ContactTarget target1;
      if (destruction_ && contact_cse_enabled()) {
        target0 = destruction_->resolve_contact_target(pair.shapes[0]);
        target1 = destruction_->resolve_contact_target(pair.shapes[1]);
      }
#endif
      PxVec3 total_impulse(0.0f);
      PxVec3 weighted_point(0.0f);
      float total_magnitude = 0.0f;
      float sum_abs_impulse_y = 0.0f;
      float min_separation = 1.0e6f;
      const auto points_started = sub_now();
      for (PxU32 point_index = 0; point_index < extracted; ++point_index) {
        const PxContactPairPoint &point = points[point_index];
        if (point.separation < min_separation) {
          min_separation = point.separation;
        }
        const float magnitude = point.impulse.magnitude();
        total_impulse += point.impulse;
        weighted_point += point.position * magnitude;
        total_magnitude += magnitude;
        // |y| only: the impulse SIGN is ordering-dependent
        // (eINTERNAL_CONTACTS_ARE_FLIPPED, never corrected) and must not be
        // read; the magnitude of the vertical component is what says a
        // contact carries weight.
        sum_abs_impulse_y += point.impulse.y < 0.0f ? -point.impulse.y
                                                    : point.impulse.y;
#ifdef VIBE_LAND_DESTRUCTION
        if (destruction_) {
          const FfiVec3 position = from_px(point.position);
          const FfiVec3 impulse = from_px(point.impulse);
          const FfiVec3 neg{-impulse.x, -impulse.y, -impulse.z};
          // Reported contacts feed damage to the stress solver but never wake
          // sleeping bodies. Measured on a demolished city, every waking
          // variant -- including waking only on eNOTIFY_THRESHOLD_FORCE_FOUND
          // -- held 94% of 14k bodies awake indefinitely, because a rubble
          // pile continuously breaks and reforms contacts, so even "new"
          // events fire somewhere every tick and each wake re-opens the whole
          // contact island. With contact wakes off the same pile is 100%
          // asleep in 8 seconds.
          //
          // Nothing is lost by not waking here: PhysX itself wakes a sleeping
          // body struck by a moving one, deliberate damage goes through
          // wake_bodies_near, and a fracture wakes the bodies it creates. The
          // queued load still reaches the solver either way.
          if (contact_cse_enabled()) {
            if (target0) {
              destruction_->queue_contact_at(target0, position, impulse,
                                             /*wake=*/false);
            }
            if (target1) {
              destruction_->queue_contact_at(target1, position, neg,
                                             /*wake=*/false);
            }
          } else {
            destruction_->route_contact_shape(pair.shapes[0], position, impulse,
                                              /*wake=*/false);
            destruction_->route_contact_shape(pair.shapes[1], position, neg,
                                              /*wake=*/false);
          }
        }
#endif
      }
      if (sample_subspans) {
        cb_queue_ms_ += 8.0 * sub_ms(points_started);
      }
      if (total_magnitude > 0.0f) {
        weighted_point /= total_magnitude;
        contact_events_.push_back(
            {entity_a, entity_b, from_px(total_impulse),
             from_px(weighted_point)});
      }
#ifdef VIBE_LAND_DESTRUCTION
      // Frozen rubble struck by moving debris must respond. PhysX wakes a
      // sleeping body that is hit, but a frozen body is kinematic and has no
      // sleep state -- without this, a collapse rains onto frozen rubble as
      // though it were bedrock. The wake=false rule above is untouched: that
      // prohibition is about sleeping DYNAMIC bodies, where one wake re-opens
      // the whole contact island; a frozen body belongs to no island, so a
      // contact releases exactly the body that was hit.
      // Supporter-edge capture: which side is carrying whose weight. Runs
      // for every reported debris pair, not just frozen ones -- the
      // dependency graph must exist BEFORE a body freezes, since it is what
      // decides whether freezing is admissible at all.
      const auto pair_load_started = sub_now();
      if (destruction_ && sum_abs_impulse_y > 0.0f) {
        if (contact_cse_enabled() && contact_fastpath_enabled()) {
          // A1: hand over the targets this manifold already resolved so the
          // chunk sides skip the duplicate hash + linear slot scan.
          destruction_->note_pair_load(target0, target1, pair.shapes[0],
                                       pair.shapes[1], header.actors[0],
                                       header.actors[1], sum_abs_impulse_y,
                                       min_separation);
        } else {
          destruction_->note_pair_load(pair.shapes[0], pair.shapes[1],
                                       header.actors[0], header.actors[1],
                                       sum_abs_impulse_y, min_separation);
        }
      }
      if (sample_subspans) {
        cb_pair_load_ms_ += 8.0 * sub_ms(pair_load_started);
      }
      const auto wake_started = sub_now();
      if (destruction_ && destruction_->has_frozen_bodies() &&
          total_magnitude > 0.0f) {
        const auto dynamic_mass = [](const PxActor *actor) -> float {
          const PxRigidDynamic *dynamic =
              actor != nullptr ? actor->is<PxRigidDynamic>() : nullptr;
          if (dynamic == nullptr ||
              dynamic->getRigidBodyFlags().isSet(
                  PxRigidBodyFlag::eKINEMATIC)) {
            return -1.0f;
          }
          return dynamic->getMass();
        };
        destruction_->note_contact_pair(entity_a, entity_b,
                                        dynamic_mass(header.actors[0]),
                                        dynamic_mass(header.actors[1]),
                                        total_magnitude);
      }
      if (sample_subspans) {
        cb_wake_ms_ += 8.0 * sub_ms(wake_started);
      }
#endif
    }
    contact_callback_cycles_ += cycle_now() - callback_started;
  }

  void add_static_box(const FfiStaticBoxDesc &desc) {
    ensure_new_id(desc.entity_id);
    require_positive_vec3(desc.half_extents,
                          "static box half extents must be positive");
    PxRigidStatic *actor =
        runtime_->physics().createRigidStatic(to_px(desc.pose));
    require(actor != nullptr, "failed to create static box actor");
    try {
      PxShape *shape = PxRigidActorExt::createExclusiveShape(
          *actor, PxBoxGeometry(to_px(desc.half_extents)), *material_);
      require(shape != nullptr, "failed to create static box shape");
      configure_shape(*shape, desc.entity_id, desc.collision_group,
                      desc.collision_mask);
      tag_actor(*actor, desc.entity_id);
      scene_->addActor(*actor);
      records_.emplace(desc.entity_id,
                       Record{desc.entity_id, desc.user_id,
                              desc.collision_group, desc.collision_mask,
                              RecordKind::StaticBox, actor});
    } catch (...) {
      actor->release();
      throw;
    }
  }

  void add_heightfield(const FfiHeightfieldDesc &desc,
                       rust::Slice<const float> heights) {
    ensure_new_id(desc.entity_id);
    require(desc.rows >= 2 && desc.columns >= 2,
            "heightfield must contain at least 2x2 samples");
    const std::uint64_t count =
        static_cast<std::uint64_t>(desc.rows) * desc.columns;
    require(count == heights.size(), "heightfield sample count mismatch");
    require(finite(desc.height_scale) && desc.height_scale > 0.0f &&
                finite(desc.row_scale) && desc.row_scale > 0.0f &&
                finite(desc.column_scale) && desc.column_scale > 0.0f,
            "heightfield scales must be finite and positive");
    require(finite(desc.friction) && desc.friction >= 0.0f &&
                finite(desc.restitution) && desc.restitution >= 0.0f &&
                desc.restitution <= 1.0f,
            "heightfield material values are invalid");

    std::vector<PxHeightFieldSample> samples(static_cast<std::size_t>(count));
    for (std::size_t i = 0; i < samples.size(); ++i) {
      require(finite(heights[i]), "heightfield contains a non-finite sample");
      const float quantized = heights[i] / desc.height_scale;
      require(quantized >= std::numeric_limits<PxI16>::min() &&
                  quantized <= std::numeric_limits<PxI16>::max(),
              "heightfield sample exceeds i16 range at requested height scale");
      samples[i].height = static_cast<PxI16>(std::lround(quantized));
      samples[i].materialIndex0 = 0;
      samples[i].materialIndex1 = 0;
      samples[i].clearTessFlag();
    }

    PxHeightFieldDesc field_desc;
    field_desc.nbRows = desc.rows;
    field_desc.nbColumns = desc.columns;
    field_desc.samples.data = samples.data();
    field_desc.samples.stride = sizeof(PxHeightFieldSample);
    require(field_desc.isValid(), "invalid PhysX heightfield descriptor");

    PxPhysics &physics = runtime_->physics();
    PxHeightField *field =
        PxCreateHeightField(field_desc, physics.getPhysicsInsertionCallback());
    require(field != nullptr, "PhysX heightfield cooking failed");
    PxRigidStatic *actor = physics.createRigidStatic(to_px(desc.pose));
    if (actor == nullptr) {
      field->release();
      throw std::runtime_error("failed to create heightfield actor");
    }
    PxMaterial *heightfield_material =
        physics.createMaterial(desc.friction, desc.friction, desc.restitution);
    if (heightfield_material == nullptr) {
      actor->release();
      field->release();
      throw std::runtime_error("failed to create heightfield material");
    }
    try {
      const PxHeightFieldGeometry geometry(field, PxMeshGeometryFlags(),
                                           desc.height_scale, desc.row_scale,
                                           desc.column_scale);
      PxShape *shape = PxRigidActorExt::createExclusiveShape(
          *actor, geometry, *heightfield_material);
      heightfield_material->release();
      heightfield_material = nullptr;
      field->release();
      field = nullptr;
      require(shape != nullptr, "failed to create heightfield shape");
      configure_shape(*shape, desc.entity_id, desc.collision_group,
                      desc.collision_mask);
      tag_actor(*actor, desc.entity_id);
      scene_->addActor(*actor);
      records_.emplace(desc.entity_id,
                       Record{desc.entity_id, desc.user_id,
                              desc.collision_group, desc.collision_mask,
                              RecordKind::Heightfield, actor});
    } catch (...) {
      if (heightfield_material != nullptr) {
        heightfield_material->release();
      }
      if (field != nullptr) {
        field->release();
      }
      actor->release();
      throw;
    }
  }

  void add_dynamic_box(const FfiDynamicBoxDesc &desc) {
    ensure_new_id(desc.entity_id);
    require_positive_vec3(desc.half_extents,
                          "dynamic box half extents must be positive");
    add_dynamic(desc.entity_id, desc.user_id, desc.pose,
                PxBoxGeometry(to_px(desc.half_extents)), desc.mass,
                desc.collision_group, desc.collision_mask,
                RecordKind::DynamicBox);
  }

  void add_dynamic_sphere(const FfiDynamicSphereDesc &desc) {
    ensure_new_id(desc.entity_id);
    require(finite(desc.radius) && desc.radius > 0.0f,
            "dynamic sphere radius must be positive");
    add_dynamic(desc.entity_id, desc.user_id, desc.pose,
                PxSphereGeometry(desc.radius), desc.mass,
                desc.collision_group, desc.collision_mask,
                RecordKind::DynamicSphere);
  }

  void add_capsule_player(const FfiCapsulePlayerDesc &desc) {
    ensure_new_id(desc.entity_id);
    require(finite(desc.cylinder_height) && desc.cylinder_height > 0.0f &&
                finite(desc.radius) && desc.radius > 0.0f,
            "capsule dimensions must be finite and positive");
    require(finite(desc.step_offset) && desc.step_offset >= 0.0f &&
                finite(desc.contact_offset) && desc.contact_offset > 0.0f,
            "capsule offsets are invalid");
    require(finite(desc.slope_limit_radians) &&
                desc.slope_limit_radians >= 0.0f &&
                desc.slope_limit_radians < 1.5707963f,
            "slope limit must be in [0, pi/2)");

    PxCapsuleControllerDesc controller_desc;
    const PxVec3 position = to_px(desc.position);
    controller_desc.position =
        PxExtendedVec3(position.x, position.y, position.z);
    controller_desc.height = desc.cylinder_height;
    controller_desc.radius = desc.radius;
    // Easy mode lets the capsule's rounded base climb objects taller than the
    // configured step. Constrained mode preserves authored stair stepping but
    // makes small dynamic balls produce a side hit instead of being ignored.
    controller_desc.climbingMode = PxCapsuleClimbingMode::eCONSTRAINED;
    controller_desc.stepOffset = desc.step_offset;
    controller_desc.contactOffset = desc.contact_offset;
    controller_desc.slopeLimit = std::cos(desc.slope_limit_radians);
    controller_desc.upDirection = PxVec3(0.0f, 1.0f, 0.0f);
    controller_desc.material = material_;
    controller_desc.reportCallback = this;
    controller_desc.behaviorCallback = this;
    require(controller_desc.isValid(), "invalid capsule controller descriptor");

    PxController *controller =
        controller_manager_->createController(controller_desc);
    require(controller != nullptr, "failed to create capsule controller");
    PxRigidDynamic *actor = controller->getActor();
    require(actor != nullptr, "capsule controller has no backing actor");
    actor->setContactReportThreshold(contact_report_threshold_);
    tag_actor(*actor, desc.entity_id);
    PxShape *shape = nullptr;
    actor->getShapes(&shape, 1);
    require(shape != nullptr, "capsule controller has no shape");
    configure_shape(*shape, desc.entity_id, desc.collision_group,
                    desc.collision_mask);
    Record player{desc.entity_id, desc.user_id, desc.collision_group,
                  desc.collision_mask, RecordKind::Player, actor, controller};
    player.player_step_offset = desc.step_offset;
    player.player_radius = desc.radius;
    records_.emplace(desc.entity_id, player);
  }

  void add_vehicle_chassis(const FfiVehicleChassisDesc &desc) {
    ensure_new_id(desc.entity_id);
    require_positive_vec3(desc.half_extents,
                          "vehicle chassis half extents must be positive");
    add_dynamic(desc.entity_id, desc.user_id, desc.pose,
                PxBoxGeometry(to_px(desc.half_extents)), desc.mass,
                desc.collision_group, desc.collision_mask,
                RecordKind::VehicleChassis);
  }

  void remove_actor(std::uint32_t entity_id) {
    auto iterator = records_.find(entity_id);
    require(iterator != records_.end(), "unknown entity id");
    Record &record = iterator->second;
    if (record.controller != nullptr) {
      record.controller->release();
      record.controller = nullptr;
      record.actor = nullptr;
    } else if (record.actor != nullptr) {
      record.actor->release();
      record.actor = nullptr;
    }
    records_.erase(iterator);
  }

  void set_user_id(std::uint32_t entity_id, std::uint32_t user_id) {
    find(entity_id).user_id = user_id;
  }

  void apply_impulse(std::uint32_t entity_id, const FfiVec3 &impulse) {
    Record &record = find(entity_id);
    require(record.controller == nullptr,
            "cannot apply an impulse to a capsule controller");
    PxRigidDynamic *dynamic =
        record.actor != nullptr ? record.actor->is<PxRigidDynamic>() : nullptr;
    require(dynamic != nullptr, "entity is not a dynamic rigid body");
    dynamic->addForce(to_px(impulse), PxForceMode::eIMPULSE, true);
  }

  void apply_impulse_at_point(std::uint32_t entity_id,
                              const FfiVec3 &impulse,
                              const FfiVec3 &point) {
    Record &record = find(entity_id);
    require(record.controller == nullptr,
            "cannot apply an impulse to a capsule controller");
    PxRigidDynamic *dynamic =
        record.actor != nullptr ? record.actor->is<PxRigidDynamic>() : nullptr;
    require(dynamic != nullptr, "entity is not a dynamic rigid body");
    PxRigidBodyExt::addForceAtPos(*dynamic, to_px(impulse), to_px(point),
                                  PxForceMode::eIMPULSE, true);
  }

  std::uint32_t wake_bodies_near(const FfiVec3 &center, float radius) {
    require(finite(center.x) && finite(center.y) && finite(center.z) &&
                finite(radius) && radius >= 0.0f,
            "wake query must be finite with a non-negative radius");
    const PxVec3 query_center = to_px(center);
    const float radius_squared = radius * radius;
    std::uint32_t woken = 0;
    for (auto &[entity_id, record] : records_) {
      (void)entity_id;
      if (record.actor == nullptr || record.controller != nullptr) {
        continue;
      }
      PxRigidDynamic *dynamic = record.actor->is<PxRigidDynamic>();
      if (dynamic == nullptr ||
          (dynamic->getGlobalPose().p - query_center).magnitudeSquared() >
              radius_squared) {
        continue;
      }
      dynamic->wakeUp();
      ++woken;
    }
    return woken;
  }

  void drive_vehicle(std::uint32_t entity_id, float throttle, float steer,
                     float brake) {
    require(finite(throttle) && finite(steer) && finite(brake),
            "vehicle input contains a non-finite value");
    Record &record = find(entity_id);
    require(record.kind == RecordKind::VehicleChassis,
            "entity is not a vehicle chassis");
    PxRigidDynamic *dynamic = record.actor->is<PxRigidDynamic>();
    require(dynamic != nullptr, "vehicle chassis lost its dynamic actor");

    throttle = PxClamp(throttle, -1.0f, 1.0f);
    steer = PxClamp(steer, -1.0f, 1.0f);
    brake = PxClamp(brake, 0.0f, 1.0f);
    const PxVec3 forward =
        dynamic->getGlobalPose().q.rotate(PxVec3(0.0f, 0.0f, 1.0f));
    dynamic->addForce(forward * (throttle * 12.0f),
                      PxForceMode::eACCELERATION, true);
    dynamic->addTorque(PxVec3(0.0f, steer * 2.5f, 0.0f),
                       PxForceMode::eACCELERATION, true);
    dynamic->setLinearDamping(0.1f + brake * 8.0f);
    dynamic->setAngularDamping(0.5f + brake * 5.0f);
  }

  void move_player(std::uint32_t entity_id, const FfiVec3 &displacement,
                   float elapsed_time) {
    Record &record = find(entity_id);
    require(record.controller != nullptr, "entity is not a capsule controller");
    require(finite(elapsed_time) && elapsed_time > 0.0f,
            "elapsed time must be finite and positive");
    const PxVec3 delta = to_px(displacement);
    pushed_actors_this_move_.clear();
    pending_player_velocity_ = delta / elapsed_time;

    // Rapier excludes dynamic bodies from autostep. PhysX has one step offset
    // for every shape, so temporarily lower it only when this sweep approaches
    // a dynamic actor. This makes authored 0.3 m pit balls generate shape hits
    // while retaining the full step height for static stairs and terrain.
    const PxExtendedVec3 extended_position = record.controller->getPosition();
    const PxVec3 controller_position(
        static_cast<float>(extended_position.x),
        static_cast<float>(extended_position.y),
        static_cast<float>(extended_position.z));
    PxBounds3 swept_bounds =
        PxBounds3::boundsOfPoints(controller_position,
                                 controller_position + delta);
    swept_bounds.fattenFast(record.player_radius + 0.35f);
    bool dynamic_near_sweep = false;
    for (const auto &[other_id, other] : records_) {
      (void)other_id;
      if (other.actor == nullptr || other.controller != nullptr) {
        continue;
      }
      const PxRigidDynamic *dynamic = other.actor->is<PxRigidDynamic>();
      if (dynamic != nullptr &&
          !dynamic->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC) &&
          swept_bounds.intersects(dynamic->getWorldBounds())) {
        dynamic_near_sweep = true;
        break;
      }
    }
    record.controller->setStepOffset(
        dynamic_near_sweep ? 0.05f : record.player_step_offset);

    MaskQueryFilter callback(record.collision_mask, true, entity_id);
    const PxFilterData filter_data(record.collision_mask, 0, 0, 0);
    PxControllerFilters filters(&filter_data, &callback);
    const PxControllerCollisionFlags flags =
        record.controller->move(delta, 0.001f, elapsed_time, filters);
    record.player_velocity = pending_player_velocity_;
    record.grounded =
        flags.isSet(PxControllerCollisionFlag::eCOLLISION_DOWN);
  }

  /// Dispatch the simulation. With GPU dynamics this only enqueues work and
  /// returns immediately, so the caller can do CPU work before `end_step()`.
  void begin_step() {
    require(!step_in_flight_, "begin_step called twice without end_step");
    contact_callback_ms_ = 0.0;
    cb_extract_ms_ = 0.0;
    cb_queue_ms_ = 0.0;
    cb_pair_load_ms_ = 0.0;
    cb_wake_ms_ = 0.0;
    contact_callbacks_this_step_ = 0;
    step_start_ = std::chrono::steady_clock::now();
    controller_manager_->computeInteractions(kFixedTimestep);
    const auto after_controllers = std::chrono::steady_clock::now();
    scene_->simulate(kFixedTimestep);
    const auto after_simulate = std::chrono::steady_clock::now();
    last_controller_ms_ =
        std::chrono::duration<float, std::milli>(after_controllers - step_start_)
            .count();
    last_simulate_ms_ =
        std::chrono::duration<float, std::milli>(after_simulate - after_controllers)
            .count();
    step_in_flight_ = true;
  }

  /// Wait for the simulation and fetch its results, decomposed.
  ///
  /// What the tick actually spends on rigid-body physics was, until now,
  /// three costs reported as one. `fetchResults(true)` blocks until PhysX is
  /// done AND copies the results back AND dispatches our contact callbacks,
  /// so a single number covered: the simulation itself, PhysX's readback,
  /// and our own host code. This splits all three:
  ///
  ///   sim_wall  — dispatch to results-ready. PhysX's own simulation wall
  ///               time: GPU kernels plus whatever PhysX runs on its task
  ///               threads concurrently. Deliberately NOT called "gpu" —
  ///               from outside the SDK the two are not separable, and a
  ///               release-config PhysX compiles its internal profile zones
  ///               out, so there is no finer split available without
  ///               rebuilding the SDK.
  ///   fetch_call— the successful fetchResults call: PhysX's result copy
  ///               plus our callbacks, which run inside it.
  ///   callbacks — ours, timed exactly by cycle counter (see cycle_now).
  ///   result_copy = fetch_call - callbacks: PhysX's readback alone.
  ///
  /// sim_wall needs polling, which burns a core, so it is SAMPLED (one tick
  /// in `VIBE_PHYSX_GPU_SAMPLE_TICKS`, default 16 — about 0.06 ms/tick
  /// amortised against 0.91 for polling every tick). `VIBE_PHYSX_PROFILE_
  /// FETCH=1` still forces every tick, for traces that want it.
  void end_step() {
    require(step_in_flight_, "end_step called without begin_step");
    contact_callback_cycles_ = 0;
    const auto fetch_start = std::chrono::steady_clock::now();
    const unsigned interval = gpu_sample_interval();
    const bool sample_sim_wall =
        profile_fetch_ ||
        (interval > 0 && (completed_steps_ % interval) == 0);
    if (sample_sim_wall) {
      auto last_call_start = fetch_start;
      bool ready = false;
      while (!ready) {
        last_call_start = std::chrono::steady_clock::now();
        ready = scene_->fetchResults(false);
      }
      const auto end = std::chrono::steady_clock::now();
      last_gpu_wait_ms_ =
          std::chrono::duration<float, std::milli>(last_call_start - fetch_start)
              .count();
      last_fetch_copy_ms_ =
          std::chrono::duration<float, std::milli>(end - last_call_start).count();
      last_sim_wall_ms_ = last_gpu_wait_ms_;
      last_fetch_call_ms_ = last_fetch_copy_ms_;
      sim_wall_samples_ = 1;
    } else {
      const bool succeeded = scene_->fetchResults(true);
      require(succeeded, "PhysX fetchResults failed");
      last_gpu_wait_ms_ = 0.0f;
      last_fetch_copy_ms_ = 0.0f;
      // Unsampled tick: the blocking call covers wait + copy + callbacks
      // together, so only the callback share is separable here.
      last_sim_wall_ms_ = 0.0f;
      last_fetch_call_ms_ = 0.0f;
      sim_wall_samples_ = 0;
    }
    const double callback_ms = static_cast<double>(contact_callback_cycles_) *
                               cycles_to_ms_factor();
    contact_callback_ms_ = callback_ms;
    // The whole fetch, always measured: on unsampled ticks this is the only
    // fetch number there is, and callbacks come out of it either way.
    const double fetch_total_ms =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - fetch_start)
            .count();
    last_fetch_total_ms_ = static_cast<float>(fetch_total_ms);
    // ONLY on a sampled tick. On a blocking tick the fetch covers wait AND
    // copy, so subtracting callbacks from it yields "wait + copy", which
    // under the name result_copy would reintroduce precisely the conflation
    // this split exists to remove. Left at 0 and gated by sim_wall_sampled.
    last_result_copy_ms_ =
        sample_sim_wall
            ? static_cast<float>(std::max(0.0, last_fetch_call_ms_ - callback_ms))
            : 0.0f;
    // A clock that cannot be checked is a clock that lies quietly. Our
    // callbacks run inside the fetch, so their measured cost can never
    // exceed it; a violation means the TSC calibration drifted (or the CPU
    // migrated to a core with an unsynchronised counter) and every number
    // derived from it is suspect.
    if (callback_ms > fetch_total_ms * 1.05 + 0.05) {
      ++tsc_suspect_ticks_;
    }
    const auto end = std::chrono::steady_clock::now();
    last_fetch_ms_ =
        std::chrono::duration<float, std::milli>(end - fetch_start).count();
    last_step_ms_ =
        std::chrono::duration<float, std::milli>(end - step_start_).count();
    step_in_flight_ = false;
    ++completed_steps_;
  }

  void step() {
    begin_step();
    end_step();
  }

  FfiRaycastHit raycast(const FfiRaycastRequest &request) const {
    require(finite(request.max_distance) && request.max_distance > 0.0f,
            "raycast distance must be finite and positive");
    PxVec3 direction = to_px(request.direction);
    const float magnitude = direction.magnitude();
    require(magnitude > 1.0e-6f, "raycast direction has zero length");
    direction /= magnitude;

    MaskQueryFilter callback(request.collision_mask,
                             request.has_ignore_entity,
                             request.ignore_entity_id);
    PxQueryFilterData filter_data;
    filter_data.data = PxFilterData(request.collision_mask, 0, 0, 0);
    filter_data.flags = PxQueryFlag::eSTATIC | PxQueryFlag::eDYNAMIC |
                        PxQueryFlag::ePREFILTER;
    PxRaycastBuffer buffer;
    const bool hit = scene_->raycast(
        to_px(request.origin), direction, request.max_distance, buffer,
        PxHitFlag::ePOSITION | PxHitFlag::eNORMAL, filter_data, &callback);
    if (!hit || !buffer.hasBlock) {
      return {false, 0, 0, 0.0f, {}, {}};
    }

    const std::uint32_t entity_id = actor_entity_id(buffer.block.actor);
    const auto iterator = records_.find(entity_id);
    const std::uint32_t user_id =
        iterator != records_.end() ? iterator->second.user_id : 0;
    return {true,
            entity_id,
            user_id,
            buffer.block.distance,
            from_px(buffer.block.position),
            from_px(buffer.block.normal)};
  }

  rust::Vec<FfiBodySnapshot> body_snapshots() const {
    rust::Vec<FfiBodySnapshot> output;
    for (const Record *record : ordered_records()) {
      if (record->kind == RecordKind::Player || record->actor == nullptr) {
        continue;
      }
      const PxRigidDynamic *dynamic = record->actor->is<PxRigidDynamic>();
      output.push_back(
          {record->entity_id,
           record->user_id,
           static_cast<std::uint8_t>(record->kind),
           dynamic != nullptr && dynamic->isSleeping(),
           from_px(record->actor->getGlobalPose()),
           dynamic != nullptr ? from_px(dynamic->getLinearVelocity())
                              : FfiVec3{},
           dynamic != nullptr ? from_px(dynamic->getAngularVelocity())
                              : FfiVec3{}});
    }
    return output;
  }

  rust::Vec<FfiPlayerSnapshot> player_snapshots() const {
    rust::Vec<FfiPlayerSnapshot> output;
    for (const Record *record : ordered_records()) {
      if (record->kind != RecordKind::Player ||
          record->controller == nullptr) {
        continue;
      }
      const PxExtendedVec3 position = record->controller->getPosition();
      FfiPose pose{{static_cast<float>(position.x),
                    static_cast<float>(position.y),
                    static_cast<float>(position.z)},
                   {0.0f, 0.0f, 0.0f, 1.0f}};
      bool has_support = false;
      std::uint32_t support_entity_id = 0;
      if (record->grounded) {
        const PxExtendedVec3 foot = record->controller->getFootPosition();
        FfiRaycastRequest request{
            {static_cast<float>(foot.x), static_cast<float>(foot.y) + 0.05f,
             static_cast<float>(foot.z)},
            {0.0f, -1.0f, 0.0f},
            0.2f,
            record->collision_mask,
            record->entity_id,
            true};
        const FfiRaycastHit support = raycast(request);
        has_support = support.hit;
        support_entity_id = support.entity_id;
      }
      output.push_back({record->entity_id, record->user_id, pose,
                        from_px(record->player_velocity), record->grounded,
                        support_entity_id, has_support});
    }
    return output;
  }

  rust::Vec<FfiVehicleSnapshot> vehicle_snapshots() const {
    rust::Vec<FfiVehicleSnapshot> output;
    for (const Record *record : ordered_records()) {
      if (record->kind != RecordKind::VehicleChassis ||
          record->actor == nullptr) {
        continue;
      }
      const PxRigidDynamic *dynamic = record->actor->is<PxRigidDynamic>();
      require(dynamic != nullptr, "vehicle chassis lost its dynamic actor");
      output.push_back({record->entity_id,
                        record->user_id,
                        from_px(dynamic->getGlobalPose()),
                        from_px(dynamic->getLinearVelocity()),
                        from_px(dynamic->getAngularVelocity()),
                        dynamic->isSleeping()});
    }
    return output;
  }

  FfiWorldStats stats() const {
    PxSimulationStatistics statistics;
    scene_->getSimulationStatistics(statistics);
    std::uint32_t players = 0;
    std::uint32_t vehicles = 0;
    for (const auto &entry : records_) {
      players += entry.second.kind == RecordKind::Player ? 1U : 0U;
      vehicles +=
          entry.second.kind == RecordKind::VehicleChassis ? 1U : 0U;
    }
    FfiWorldStats out{};
    // Generic spans: one push_back per metric, no struct plumbing. See
    // FfiNamedSpan in lib.rs for the kind codes.
    const auto span = [&out](const char *name, double value,
                             std::uint8_t kind) {
      FfiNamedSpan entry;
      entry.name = rust::String(name);
      entry.value = value;
      entry.kind = kind;
      out.extra_spans.push_back(std::move(entry));
    };
    // Our callback share of fetchResults (sampled 1-in-8, x8 scaled) — the
    // split that separates "PhysX copying results" from "our contact
    // handlers", which used to be one indistinguishable fetch_copy number.
    // Kept under its old name so existing traces and comparisons keep
    // working, but it is no longer an estimate: every callback is timed.
    span("contact_callback_est_ms", contact_callback_ms_, 0);
    // The rigid-body decomposition. sim_wall and fetch_call are 0 on
    // unsampled ticks; sim_wall_sampled marks the ones that carry a number,
    // so an average is taken over the right denominator rather than being
    // diluted by the zeros.
    span("sim_wall_ms", static_cast<double>(last_sim_wall_ms_), 0);
    span("fetch_call_ms", static_cast<double>(last_fetch_call_ms_), 0);
    span("sim_wall_sampled", static_cast<double>(sim_wall_samples_), 2);
    span("result_copy_ms", static_cast<double>(last_result_copy_ms_), 0);
    span("fetch_total_ms", static_cast<double>(last_fetch_total_ms_), 0);
    span("tsc_suspect_ticks", static_cast<double>(tsc_suspect_ticks_), 2);
    span("cb_extract_ms", cb_extract_ms_, 0);
    span("cb_queue_ms", cb_queue_ms_, 0);
    span("cb_pair_load_ms", cb_pair_load_ms_, 0);
    span("cb_wake_ms", cb_wake_ms_, 0);
    span("contact_callbacks", static_cast<double>(contact_callbacks_this_step_), 2);
    // Broadphase membership churn: prices freeze/thaw flips directly.
    span("bp_adds", static_cast<double>(statistics.getNbBroadPhaseAdds()), 2);
    span("bp_removes", static_cast<double>(statistics.getNbBroadPhaseRemoves()), 2);
    // Pair found/lost volume from the GPU pipeline's own accounting — the
    // pair-activity signal that IS populated under eGPU (the CPU-narrowphase
    // pair counter is not, see contact_pairs below).
    span("gpu_found_lost_pairs",
         static_cast<double>(
             statistics.gpuDynamicsMemoryConfigStatistics.foundLostPairs),
         2);
    out.body_count = static_cast<std::uint32_t>(records_.size()) - players;
    out.player_count = players;
    out.vehicle_count = vehicles;
    out.active_dynamic_bodies = statistics.nbActiveDynamicBodies;
    out.active_kinematic_bodies = statistics.nbActiveKinematicBodies;
    out.contact_pairs = statistics.nbDiscreteContactPairsWithContacts;
    out.gpu_rigid_contact_high_water =
        statistics.gpuDynamicsMemoryConfigStatistics.rigidContactCount;
    out.gpu_rigid_patch_high_water =
        statistics.gpuDynamicsMemoryConfigStatistics.rigidPatchCount;
    out.last_step_ms = last_step_ms_;
    out.last_controller_ms = last_controller_ms_;
    out.last_simulate_ms = last_simulate_ms_;
    out.last_fetch_ms = last_fetch_ms_;
    out.last_gpu_wait_ms = last_gpu_wait_ms_;
    out.last_fetch_copy_ms = last_fetch_copy_ms_;
    out.completed_steps = completed_steps_;
    out.gpu_warning_count = runtime_->warning_count();
    return out;
  }

  rust::Vec<FfiContactEvent> take_contact_events() {
    rust::Vec<FfiContactEvent> output;
    output.reserve(contact_events_.size());
    for (const FfiContactEvent &event : contact_events_) {
      output.push_back(event);
    }
    contact_events_.clear();
    return output;
  }

  void create_destructible(std::uint32_t structure_id, const FfiPose &pose,
                           rust::Slice<const FfiChunkNodeDesc> nodes,
                           rust::Slice<const FfiChunkBondDesc> bonds,
                           const FfiDestructibleSettings &settings,
                           std::uint32_t collision_group,
                           std::uint32_t collision_mask) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    destruction_->create_destructible(structure_id, pose, nodes, bonds, settings,
                                      collision_group, collision_mask);
#else
    (void)structure_id;
    (void)pose;
    (void)nodes;
    (void)bonds;
    (void)settings;
    (void)collision_group;
    (void)collision_mask;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  void clear_destructibles() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    destruction_->clear_destructibles();
#endif
  }

  void destruction_tick(float dt, FfiVec3 gravity) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    destruction_->destruction_tick(dt, gravity);
#else
    (void)dt;
    (void)gravity;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  void queue_chunk_damage(std::uint32_t structure_id, std::uint32_t chunk_id,
                          FfiVec3 impulse, FfiVec3 point) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    destruction_->queue_chunk_damage(structure_id, chunk_id, impulse, point);
#else
    (void)structure_id;
    (void)chunk_id;
    (void)impulse;
    (void)point;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  std::uint32_t apply_destruction_explosion(FfiVec3 center, float radius,
                                            float impulse_magnitude) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->apply_destruction_explosion(center, radius,
                                                     impulse_magnitude);
#else
    (void)center;
    (void)radius;
    (void)impulse_magnitude;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  std::uint32_t apply_destruction_blast(FfiVec3 center, FfiVec3 direction,
                                        float radius, float stress_impulse,
                                        float push_impulse) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->apply_destruction_blast(
        center, direction, radius, stress_impulse, push_impulse);
#else
    (void)center;
    (void)direction;
    (void)radius;
    (void)stress_impulse;
    (void)push_impulse;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Vec<FfiBrokenBondEvent> take_broken_bonds() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->take_broken_bonds();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Vec<FfiChunkMigrationEvent> take_chunk_migrations() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->take_chunk_migrations();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Vec<FfiIslandBodyEvent> take_island_events() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->take_island_events();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Slice<const FfiChunkBodySnapshot> chunk_body_snapshots() const {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->chunk_body_snapshots();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  void sleep_chunk_body(std::uint32_t entity_id) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    destruction_->sleep_chunk_body(entity_id);
#else
    (void)entity_id;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  std::uint32_t freeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->freeze_chunk_bodies(entity_ids);
#else
    (void)entity_ids;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  std::uint32_t unfreeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids) {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->unfreeze_chunk_bodies(entity_ids);
#else
    (void)entity_ids;
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Vec<std::uint32_t> take_frozen_contact_wakes() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->take_frozen_contact_wakes();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Vec<FfiSupportSet> take_support_sets() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->take_support_sets();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  rust::Vec<FfiSupportRow> take_support_rows() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->take_support_rows();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  FfiDestructionStats destruction_stats() const {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->destruction_stats();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  std::uint64_t split_count() const {
#ifdef VIBE_LAND_DESTRUCTION
    return destruction_ != nullptr ? destruction_->split_count() : 0;
#else
    return 0;
#endif
  }

  bool resim_needed() const {
#ifdef VIBE_LAND_DESTRUCTION
    return destruction_ != nullptr && destruction_->resim_needed();
#else
    return false;
#endif
  }

  std::uint32_t resim_capture() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    require(!step_in_flight_, "resim_capture must run outside a step");
    return destruction_->resim_capture();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  bool resim_restore() {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    require(!step_in_flight_, "resim_restore must run outside a step");
    return destruction_->resim_restore();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

  bool validate_destruction_mappings() const {
#ifdef VIBE_LAND_DESTRUCTION
    require(destruction_ != nullptr, "destruction manager missing");
    return destruction_->validate_destruction_mappings();
#else
    throw std::runtime_error(
        "physx-bridge built without feature `destruction`");
#endif
  }

private:
  void initialize(const FfiWorldConfig &config) {
    require(config.cpu_threads > 0, "cpu_threads must be non-zero");
    require(finite(config.static_friction) && config.static_friction >= 0.0f &&
                finite(config.dynamic_friction) &&
                config.dynamic_friction >= 0.0f &&
                finite(config.restitution) && config.restitution >= 0.0f &&
                config.restitution <= 1.0f,
            "material coefficients are invalid");
    require(finite(config.contact_report_threshold) &&
                config.contact_report_threshold >= 0.0f,
            "contact report threshold is invalid");
    contact_report_threshold_ = config.contact_report_threshold;

    runtime_ = acquire_physx_runtime();
    PxPhysics &physics = runtime_->physics();
    PxCudaContextManager &cuda_context = runtime_->cuda_context();

    PxSceneDesc scene_desc(physics.getTolerancesScale());
    scene_desc.gravity = to_px(config.gravity);
    dispatcher_ = PxDefaultCpuDispatcherCreate(config.cpu_threads);
    require(dispatcher_ != nullptr, "failed to create CPU dispatcher");
    scene_desc.cpuDispatcher = dispatcher_;
    scene_desc.filterShader = simulation_filter;
    scene_desc.simulationEventCallback = this;
    scene_desc.cudaContextManager = &cuda_context;
    scene_desc.flags |= PxSceneFlag::eENABLE_GPU_DYNAMICS;
    scene_desc.flags |= PxSceneFlag::eENABLE_PCM;
    scene_desc.flags |= PxSceneFlag::eENABLE_STABILIZATION;
    scene_desc.broadPhaseType = PxBroadPhaseType::eGPU;
    scene_desc.gpuMaxNumPartitions = config.gpu_max_partitions;
    // The frozen-body clusters (destruction.cc, VIBE_CITY_FREEZE_AGGREGATE)
    // put thousands of actors into PxAggregates; awake debris raining onto a
    // pile generates external-vs-aggregate pairs against these buffers, whose
    // PhysX default is 1024 — overflow silently drops pairs, which reads as
    // debris resting inside a frozen pile and the contact-wake path going
    // deaf. Sized like the other GPU buffers: generous, and watched by the
    // same containment gate.
    scene_desc.gpuDynamicsConfig.foundLostAggregatePairsCapacity = 65536;
    scene_desc.gpuDynamicsConfig.totalAggregatePairsCapacity = 65536;
    if (config.gpu_max_rigid_contacts != 0) {
      scene_desc.gpuDynamicsConfig.maxRigidContactCount =
          config.gpu_max_rigid_contacts;
    }
    if (config.gpu_max_rigid_patches != 0) {
      scene_desc.gpuDynamicsConfig.maxRigidPatchCount =
          config.gpu_max_rigid_patches;
    }
    if (config.gpu_heap_capacity != 0) {
      scene_desc.gpuDynamicsConfig.heapCapacity = config.gpu_heap_capacity;
    }
    if (config.gpu_found_lost_pairs_capacity != 0) {
      scene_desc.gpuDynamicsConfig.foundLostPairsCapacity =
          config.gpu_found_lost_pairs_capacity;
    }
    if (config.gpu_found_lost_aggregate_pairs_capacity != 0) {
      scene_desc.gpuDynamicsConfig.foundLostAggregatePairsCapacity =
          config.gpu_found_lost_aggregate_pairs_capacity;
    }
    if (config.gpu_total_aggregate_pairs_capacity != 0) {
      scene_desc.gpuDynamicsConfig.totalAggregatePairsCapacity =
          config.gpu_total_aggregate_pairs_capacity;
    }
    if (config.gpu_collision_stack_size != 0) {
      scene_desc.gpuDynamicsConfig.collisionStackSize =
          config.gpu_collision_stack_size;
    }
    require(scene_desc.isValid(), "invalid GPU PhysX scene descriptor");
    scene_ = physics.createScene(scene_desc);
    require(scene_ != nullptr, "failed to create GPU PhysX scene");
    require(scene_->getCudaContextManager() == &cuda_context,
            "created scene is not attached to the CUDA context");
    require(scene_->getBroadPhaseType() == PxBroadPhaseType::eGPU,
            "created scene did not retain GPU broadphase");
    const PxSceneFlags actual_flags = scene_->getFlags();
    require(actual_flags.isSet(PxSceneFlag::eENABLE_GPU_DYNAMICS),
            "created scene did not retain GPU dynamics");

    material_ = physics.createMaterial(
        config.static_friction, config.dynamic_friction, config.restitution);
    require(material_ != nullptr, "failed to create default material");
    controller_manager_ = PxCreateControllerManager(*scene_);
    require(controller_manager_ != nullptr,
            "failed to create controller manager");
#ifdef VIBE_LAND_DESTRUCTION
    destruction_ = std::make_unique<DestructionManager>(
        physics, *scene_, *material_, contact_report_threshold_);
#endif

    // Dispatch one real empty GPU frame so constructor success means more than
    // merely loading the shared library and allocating a CUDA context.
    scene_->simulate(kFixedTimestep);
    require(scene_->fetchResults(true),
            "GPU scene startup self-test fetchResults failed");
  }

  void teardown() noexcept {
#ifdef VIBE_LAND_DESTRUCTION
    destruction_.reset();
#endif
    if (scene_ != nullptr) {
      for (auto &entry : records_) {
        Record &record = entry.second;
        if (record.controller != nullptr) {
          record.controller->release();
          record.controller = nullptr;
          record.actor = nullptr;
        } else if (record.actor != nullptr) {
          record.actor->release();
          record.actor = nullptr;
        }
      }
    }
    records_.clear();
    if (controller_manager_ != nullptr) {
      controller_manager_->release();
      controller_manager_ = nullptr;
    }
    if (material_ != nullptr) {
      material_->release();
      material_ = nullptr;
    }
    if (scene_ != nullptr) {
      scene_->release();
      scene_ = nullptr;
    }
    if (dispatcher_ != nullptr) {
      dispatcher_->release();
      dispatcher_ = nullptr;
    }
    runtime_.reset();
  }

  void ensure_new_id(std::uint32_t entity_id) const {
    require(records_.find(entity_id) == records_.end(),
            "entity id already exists");
  }

  Record &find(std::uint32_t entity_id) {
    auto iterator = records_.find(entity_id);
    require(iterator != records_.end(), "unknown entity id");
    return iterator->second;
  }

  template <typename Geometry>
  void add_dynamic(std::uint32_t entity_id, std::uint32_t user_id,
                   const FfiPose &pose, const Geometry &geometry, float mass,
                   std::uint32_t group, std::uint32_t mask, RecordKind kind) {
    require(finite(mass) && mass > 0.0f,
            "dynamic body mass must be finite and positive");
    PxRigidDynamic *actor =
        runtime_->physics().createRigidDynamic(to_px(pose));
    require(actor != nullptr, "failed to create dynamic actor");
    try {
      PxShape *shape = PxRigidActorExt::createExclusiveShape(
          *actor, geometry, *material_);
      require(shape != nullptr, "failed to create dynamic shape");
      configure_shape(*shape, entity_id, group, mask);
      require(PxRigidBodyExt::setMassAndUpdateInertia(*actor, mass),
              "failed to compute dynamic body inertia");
      // Match Rapier ball damping; boxes stay lightly damped.
      if (kind == RecordKind::DynamicSphere) {
        actor->setLinearDamping(0.3f);
        actor->setAngularDamping(0.5f);
      } else {
        actor->setAngularDamping(0.5f);
      }
      actor->setContactReportThreshold(contact_report_threshold_);
      // Solver iterations govern how completely stacked contacts are resolved.
      // PhysX's default 4 position / 1 velocity is tuned for a few loose props;
      // a deep pile leaves a residual velocity floor that no sleep threshold
      // can reach, because contact solving is iterative and never exact.
      //
      // Read per call rather than cached, so a test can sweep the value within
      // one process. Body creation is not a hot path.
      actor->setSolverIterationCounts(dynamic_solver_position_iterations(),
                                      dynamic_solver_velocity_iterations());
      tag_actor(*actor, entity_id);
      scene_->addActor(*actor);
      records_.emplace(entity_id,
                       Record{entity_id, user_id, group, mask, kind, actor});
    } catch (...) {
      actor->release();
      throw;
    }
  }

  std::vector<const Record *> ordered_records() const {
    std::vector<const Record *> output;
    output.reserve(records_.size());
    for (const auto &entry : records_) {
      output.push_back(&entry.second);
    }
    std::sort(output.begin(), output.end(),
              [](const Record *left, const Record *right) {
                return left->entity_id < right->entity_id;
              });
    return output;
  }

public:
  // --- Bring-your-own-world hand-off ---------------------------------------
  // Lend the scene so the blast-stress-solver core can attach a backend to it
  // instead of standing up a second scene. Players, vehicles and the
  // destructible city all have to live in one scene.
  std::uintptr_t scene_ptr() const { return reinterpret_cast<std::uintptr_t>(scene_); }
  std::uintptr_t physics_ptr() const {
    return reinterpret_cast<std::uintptr_t>(runtime_ ? &runtime_->physics() : nullptr);
  }

private:
  std::shared_ptr<SharedPhysxRuntime> runtime_;
  PxDefaultCpuDispatcher *dispatcher_ = nullptr;
  PxScene *scene_ = nullptr;
  PxMaterial *material_ = nullptr;
  PxControllerManager *controller_manager_ = nullptr;
  std::unordered_map<std::uint32_t, Record> records_;
  std::vector<FfiContactEvent> contact_events_;
  /// Scratch for extractContacts, reused across manifolds and ticks. onContact
  /// runs inside fetchResults() on the simulation thread, one manifold at a
  /// time, so a single buffer is safe -- and a per-manifold heap allocation
  /// here lands squarely in what physics_fetch_copy_ms measures.
  std::vector<physx::PxContactPairPoint> contact_points_;
  std::unordered_set<PxRigidDynamic *> pushed_actors_this_move_;
  PxVec3 pending_player_velocity_{0.0f};
  float contact_report_threshold_ = 50.0f;
  /// Sampled onContact self-timing (1-in-8, x8 scaled) and call count; the
  /// callbacks run inside fetchResults, so without this their cost is
  /// indistinguishable from the result copy. Reset per step; published as
  /// spans. calls_ stays monotonic so the sampling phase never aliases with
  /// per-step contact counts.
  std::uint64_t contact_callback_calls_ = 0;
  double contact_callback_ms_ = 0.0;
  /// Exact per-step callback cost in cycles, reset at the top of each fetch.
  std::uint64_t contact_callback_cycles_ = 0;
  /// PhysX's own simulation wall time and result-copy call, on sampled ticks
  /// only (see gpu_sample_interval); 0 on unsampled ticks, with
  /// sim_wall_samples_ saying which kind of tick this was so an average is
  /// taken over the right denominator.
  float last_sim_wall_ms_ = 0.0f;
  float last_fetch_call_ms_ = 0.0f;
  std::uint32_t sim_wall_samples_ = 0;
  /// fetch minus our callbacks: PhysX copying results back, alone. Measured
  /// every tick, because the callback side is now exact.
  float last_result_copy_ms_ = 0.0f;
  /// The whole fetch, every tick: wait + copy + callbacks on a blocking
  /// tick, the same three on a sampled one. The denominator the parts are
  /// checked against.
  float last_fetch_total_ms_ = 0.0f;
  /// Ticks where the callback total exceeded the fetch that contains it —
  /// impossible unless the cycle counter is untrustworthy.
  std::uint64_t tsc_suspect_ticks_ = 0;
  // A0 sub-attribution of the callback cost, same sampling and x8 scaling.
  // extract = resize+extractContacts; queue = the per-point loop (accumulate
  // + queue_contact_at); pair_load = note_pair_load; wake = note_contact_pair
  // + the dynamic_mass virtual reads. Residual vs contact_callback_est_ms is
  // header decode + entity lookup + CSE resolve.
  double cb_extract_ms_ = 0.0;
  double cb_queue_ms_ = 0.0;
  double cb_pair_load_ms_ = 0.0;
  double cb_wake_ms_ = 0.0;
  std::uint64_t contact_callbacks_this_step_ = 0;
  float last_step_ms_ = 0.0f;
  float last_controller_ms_ = 0.0f;
  float last_simulate_ms_ = 0.0f;
  float last_fetch_ms_ = 0.0f;
  float last_gpu_wait_ms_ = 0.0f;
  float last_fetch_copy_ms_ = 0.0f;
  bool step_in_flight_ = false;
  // Value-checked, not presence-checked. This used to be `!= nullptr`, which
  // made `VIBE_PHYSX_PROFILE_FETCH=0` still poll -- so the obvious A/B for
  // "is the polling itself costing us a core?" compared two identical
  // busy-polling builds and read the null result as "profiling is free".
  // Same shape as contact_persists_enabled() above, but defaulting OFF.
  bool profile_fetch_ = [] {
    const char *value = std::getenv("VIBE_PHYSX_PROFILE_FETCH");
    return value != nullptr && std::string(value) != "0";
  }();
  std::chrono::steady_clock::time_point step_start_{};
  std::uint64_t completed_steps_ = 0;
#ifdef VIBE_LAND_DESTRUCTION
  std::unique_ptr<DestructionManager> destruction_;
#endif
};

World::World(const FfiWorldConfig &config)
    : impl_(std::make_unique<Impl>(config)) {}

World::~World() = default;

void World::add_static_box(const FfiStaticBoxDesc &desc) {
  impl_->add_static_box(desc);
}

void World::add_heightfield(const FfiHeightfieldDesc &desc,
                            rust::Slice<const float> samples) {
  impl_->add_heightfield(desc, samples);
}

void World::add_dynamic_box(const FfiDynamicBoxDesc &desc) {
  impl_->add_dynamic_box(desc);
}

void World::add_dynamic_sphere(const FfiDynamicSphereDesc &desc) {
  impl_->add_dynamic_sphere(desc);
}

void World::add_capsule_player(const FfiCapsulePlayerDesc &desc) {
  impl_->add_capsule_player(desc);
}

void World::add_vehicle_chassis(const FfiVehicleChassisDesc &desc) {
  impl_->add_vehicle_chassis(desc);
}

void World::remove_actor(std::uint32_t entity_id) {
  impl_->remove_actor(entity_id);
}

void World::set_user_id(std::uint32_t entity_id, std::uint32_t user_id) {
  impl_->set_user_id(entity_id, user_id);
}

void World::apply_impulse(std::uint32_t entity_id, FfiVec3 impulse) {
  impl_->apply_impulse(entity_id, impulse);
}

void World::apply_impulse_at_point(std::uint32_t entity_id, FfiVec3 impulse,
                                   FfiVec3 point) {
  impl_->apply_impulse_at_point(entity_id, impulse, point);
}

std::uint32_t World::wake_bodies_near(FfiVec3 center, float radius) {
  return impl_->wake_bodies_near(center, radius);
}

void World::drive_vehicle(std::uint32_t entity_id, float throttle, float steer,
                          float brake) {
  impl_->drive_vehicle(entity_id, throttle, steer, brake);
}

void World::move_player(std::uint32_t entity_id, FfiVec3 displacement,
                        float elapsed_time) {
  impl_->move_player(entity_id, displacement, elapsed_time);
}

void World::step() { impl_->step(); }
void World::begin_step() { impl_->begin_step(); }
void World::end_step() { impl_->end_step(); }

FfiRaycastHit World::raycast(const FfiRaycastRequest &request) const {
  return impl_->raycast(request);
}

rust::Vec<FfiBodySnapshot> World::body_snapshots() const {
  return impl_->body_snapshots();
}

rust::Vec<FfiPlayerSnapshot> World::player_snapshots() const {
  return impl_->player_snapshots();
}

rust::Vec<FfiVehicleSnapshot> World::vehicle_snapshots() const {
  return impl_->vehicle_snapshots();
}

FfiWorldStats World::stats() const { return impl_->stats(); }

rust::Vec<FfiContactEvent> World::take_contact_events() {
  return impl_->take_contact_events();
}

void World::create_destructible(std::uint32_t structure_id, const FfiPose &pose,
                                rust::Slice<const FfiChunkNodeDesc> nodes,
                                rust::Slice<const FfiChunkBondDesc> bonds,
                                const FfiDestructibleSettings &settings,
                                std::uint32_t collision_group,
                                std::uint32_t collision_mask) {
  impl_->create_destructible(structure_id, pose, nodes, bonds, settings,
                             collision_group, collision_mask);
}

void World::clear_destructibles() { impl_->clear_destructibles(); }

void World::destruction_tick(float dt, FfiVec3 gravity) {
  impl_->destruction_tick(dt, gravity);
}

void World::queue_chunk_damage(std::uint32_t structure_id,
                               std::uint32_t chunk_id, FfiVec3 impulse,
                               FfiVec3 point) {
  impl_->queue_chunk_damage(structure_id, chunk_id, impulse, point);
}

std::uint32_t World::apply_destruction_explosion(FfiVec3 center, float radius,
                                                 float impulse_magnitude) {
  return impl_->apply_destruction_explosion(center, radius, impulse_magnitude);
}

std::uint32_t World::apply_destruction_blast(FfiVec3 center, FfiVec3 direction,
                                             float radius, float stress_impulse,
                                             float push_impulse) {
  return impl_->apply_destruction_blast(center, direction, radius,
                                        stress_impulse, push_impulse);
}

rust::Vec<FfiBrokenBondEvent> World::take_broken_bonds() {
  return impl_->take_broken_bonds();
}

rust::Vec<FfiChunkMigrationEvent> World::take_chunk_migrations() {
  return impl_->take_chunk_migrations();
}

rust::Vec<FfiIslandBodyEvent> World::take_island_events() {
  return impl_->take_island_events();
}

rust::Slice<const FfiChunkBodySnapshot> World::chunk_body_snapshots() const {
  return impl_->chunk_body_snapshots();
}

void World::sleep_chunk_body(std::uint32_t entity_id) {
  impl_->sleep_chunk_body(entity_id);
}

std::uint32_t World::freeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids) {
  return impl_->freeze_chunk_bodies(entity_ids);
}

std::uint32_t World::unfreeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids) {
  return impl_->unfreeze_chunk_bodies(entity_ids);
}

rust::Vec<std::uint32_t> World::take_frozen_contact_wakes() {
  return impl_->take_frozen_contact_wakes();
}

rust::Vec<FfiSupportSet> World::take_support_sets() {
  return impl_->take_support_sets();
}

rust::Vec<FfiSupportRow> World::take_support_rows() {
  return impl_->take_support_rows();
}

FfiDestructionStats World::destruction_stats() const {
  return impl_->destruction_stats();
}

bool World::validate_destruction_mappings() const {
  return impl_->validate_destruction_mappings();
}

std::uint64_t World::split_count() const { return impl_->split_count(); }
bool World::resim_needed() const { return impl_->resim_needed(); }
std::uint32_t World::resim_capture() { return impl_->resim_capture(); }
bool World::resim_restore() { return impl_->resim_restore(); }

std::uintptr_t World::scene_ptr() const { return impl_->scene_ptr(); }

std::uintptr_t World::physics_ptr() const { return impl_->physics_ptr(); }

std::unique_ptr<World> new_world(const FfiWorldConfig &config) {
  return std::make_unique<World>(config);
}

} // namespace vibe_land::physx_bridge
