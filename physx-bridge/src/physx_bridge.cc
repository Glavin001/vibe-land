#include "vibe-land-physx-bridge/src/lib.rs.h"

#include "PxPhysicsAPI.h"

#ifdef VIBE_LAND_DESTRUCTION
#include "destruction.h"
#include "NvBlastExtStressPhysXContactWrench.h"
#endif

#ifdef VIBE_LAND_NATIVE_DESTRUCTION
#include "native_destruction.h"
#endif

#ifdef NVBLAST_ENABLE_CUDA_STRESS
#include "NvBlastExtStressPhysXGpuActivity.h"
#include "NvBlastExtStressPhysXDirectGpu.h"
#include "NvBlastExtStressPhysXContactScratch.h"
#include "NvBlastExtStressPhysXGpuHostMirror.h"
#endif

#if defined(__x86_64__) || defined(_M_X64)
#include <x86intrin.h>
#define VIBE_HAVE_RDTSC 1
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <map>
#include <cstdlib>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
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

#ifdef NVBLAST_ENABLE_CUDA_STRESS
bool compact_contacts_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_COMPACT_CONTACTS");
    return value != nullptr && std::string(value) == "1";
  }();
  return enabled;
}
bool compact_contacts_verify() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_COMPACT_CONTACTS_VERIFY");
    return value != nullptr && std::string(value) == "1";
  }();
  return enabled;
}
bool gpu_contact_order_enabled() {
  // Experimental until the repeated settling-gate difference is resolved.
  // See docs/gpu-contact-order-2026-09-05.md; ordinary launches keep CPU order.
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_GPU_CONTACT_ORDER");
    return value != nullptr && std::string(value) != "0";
  }();
  return enabled;
}
bool gpu_contact_order_verify() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_GPU_CONTACT_ORDER_VERIFY");
    return value != nullptr && std::string(value) != "0";
  }();
  return enabled;
}
using GpuContact = Nv::Blast::ExtStressPhysXDirectGpuContact;
void canonicalize_gpu_contact(GpuContact &contact) {
  if (contact.transformCacheRef1 < contact.transformCacheRef0) {
    std::swap(contact.actor0, contact.actor1);
    std::swap(contact.transformCacheRef0, contact.transformCacheRef1);
    contact.impulseOnActor0 = -contact.impulseOnActor0;
    contact.worldNormal = -contact.worldNormal;
  }
}
bool gpu_contact_less(const GpuContact &a, const GpuContact &b) {
  return std::tie(a.transformCacheRef0, a.transformCacheRef1, a.friction, a.pointIndex)
       < std::tie(b.transformCacheRef0, b.transformCacheRef1, b.friction, b.pointIndex);
}
bool gpu_contact_provenance_less(const GpuContact &a, const GpuContact &b) {
  return std::tie(a.transformCacheRef0, a.transformCacheRef1, a.friction, a.pointIndex, a.pairIndex)
       < std::tie(b.transformCacheRef0, b.transformCacheRef1, b.friction, b.pointIndex, b.pairIndex);
}
float gpu_contact_threshold(PxRigidActor *actor) {
  const auto *body = actor->is<PxRigidDynamic>();
  return body ? body->getContactReportThreshold() : PX_MAX_F32;
}
// Compare every payload field, including signed zero, without struct padding.
bool same_gpu_contact(const GpuContact &a, const GpuContact &b) {
  return a.actor0 == b.actor0 && a.actor1 == b.actor1
      && a.transformCacheRef0 == b.transformCacheRef0 && a.transformCacheRef1 == b.transformCacheRef1
      && a.friction == b.friction && a.pointIndex == b.pointIndex && a.pairIndex == b.pairIndex
      && std::memcmp(&a.worldPosition, &b.worldPosition, sizeof(PxVec3)) == 0
      && std::memcmp(&a.impulseOnActor0, &b.impulseOnActor0, sizeof(PxVec3)) == 0
      && std::memcmp(&a.worldNormal, &b.worldNormal, sizeof(PxVec3)) == 0
      && std::memcmp(&a.separation, &b.separation, sizeof(float)) == 0
      && std::memcmp(&a.normalImpulse, &b.normalImpulse, sizeof(float)) == 0;
}
#endif

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
/// Default 16 = ~0.29 ms/tick measured. Chosen over a cheaper 64 because
/// the recent-sample ring must refill fast enough to describe the CURRENT
/// regime: a cascade lasts seconds, and at 1-in-64 a 16-sample mean spans
/// ~17 s, which would average the collapse together with the settle after
/// it. At 1-in-16 the same ring covers ~4 s. Still far cheaper than the old
/// all-or-nothing PROFILE_FETCH (+0.91 ms, and therefore off in
/// production): the split is now cheap enough to leave ON while people
/// play, which is the whole point.
unsigned gpu_sample_interval() {
  static const unsigned interval = [] {
    if (const char *raw = std::getenv("VIBE_PHYSX_GPU_SAMPLE_TICKS")) {
      const long parsed = std::atol(raw);
      return parsed < 0 ? 0u : static_cast<unsigned>(parsed);
    }
    return 16u;
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
/// Default ON since the sub-timers moved to rdtsc. The reasoning above still
/// holds for a probe that costs ~0.19 ms/tick; it does not hold at ~0.05, and
/// the cost this decomposes is now the largest growth term in the tick
/// (callbacks went 0.4 -> 9.6 ms between 200 and 5600 awake bodies, while the
/// GPU sim only tripled). Leaving the breakdown dark by default meant every
/// report had to be followed by "now reproduce it with the flag on".
/// `VIBE_PHYSX_PROFILE_CALLBACK=0` restores the unmeasured path.
bool profile_callback_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_PROFILE_CALLBACK");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// Pair census + impulse histogram, opt-in. These answered their questions
/// (98.4% PERSISTS; pairs cluster at 128-1024 Ns, no low-force tail) and
/// cost ~0.4 ms/tick at cascade. Off until someone asks the next question.
/// The spans keep publishing zeros so trace columns stay stable.
bool contact_census_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_CONTACT_CENSUS");
    return value != nullptr && std::string(value) != "0";
  }();
  return enabled;
}

/// Phase C: capture contact data inside the callback, process it after
/// fetchResults returns. The callback runs on the host thread INSIDE
/// fetchResults; moving the marshaling out (a) removes our code from the
/// number labelled "PhysX" and (b) makes it parallelisable later. Timing-
/// neutral for physics: every consumer (solver queue, supporter loads,
/// frozen wakes) runs later in the same tick inside destruction_tick, and
/// the scene does not step between callback and drain, so actor reads see
/// identical state. The drain preserves recorded order, so the sequences
/// fed to every consumer are bit-identical to the inline path.
/// Default ON. Measured (grid 1, matched ticks, n=1199/arm): physx_step
/// -11.7%, and the same work costs less in the drain than inline -- 9.6 ms
/// inline vs 1.6 capture + 5.3 drain -- because batch processing beats
/// interleaving with PhysX's own callback machinery. Correctness case: ONE
/// shared body for both paths (process_extracted_pair), drain in recorded
/// order before any consumer runs, and the full gate battery green under
/// the flag -- including freeze semantics, which fail if pair delivery
/// breaks. Cross-run bit-identity is not measurable here (GPU
/// nondeterminism), and cumulative contact counters swing 2-3x between
/// identical-config runs, so counter deltas across arms are NOT evidence
/// either way. VIBE_PHYSX_DEFER_CONTACTS=0 restores inline processing.
/// A/B for hoisting the bondless test out of queueContact and into the
/// parallel classify pass. Default ON. One binary, two arms -- separate
/// builds would reintroduce build identity as a confounder.
///
/// The arms must agree EXACTLY on contacts_queued: the hoist skips only
/// contacts queueContact would itself have dropped, so the set reaching the
/// solver, and its order, are unchanged. A difference in contacts_queued is a
/// bug, not a tuning artefact.
bool bondless_hoist_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_BONDLESS_HOIST");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

/// Self-check for the hoist, immune to cascade nondeterminism because both
/// arms run in the SAME tick of the SAME run: predict the skip, then queue
/// anyway and compare the adapter's verdict. A contact the bridge would have
/// skipped that queueContact ACCEPTS is a real divergence -- it would have
/// been lost load on the solver. Off by default; it reinstates exactly the
/// work the hoist removes.
bool bondless_hoist_verify() {
  static const bool on = [] {
    const char *value = std::getenv("VIBE_PHYSX_BONDLESS_HOIST_VERIFY");
    return value != nullptr && std::string(value) == "1";
  }();
  return on;
}

/// A/B for hoisting the frozen-membership probe into the parallel classify
/// pass, same shape as the bondless hoist. Default ON.
///
/// The drain asks "is this entity frozen?" twice per manifold -- ~17,700 probes
/// a tick at `saturated` -- and ~40% of the answers are "no", each costing an
/// unordered_set lookup and usually a cache miss, purely to decide to do
/// nothing. The set cannot change during the drain (freeze/thaw and body
/// retirement both run later in the tick), so the answer is the same whether
/// it is computed serially or in the fan-out.
/// Same self-check as the bondless hoist: recompute the membership serially
/// and compare against what the parallel pass decided, in the same tick.
bool frozen_hoist_verify() {
  static const bool on = [] {
    const char *value = std::getenv("VIBE_PHYSX_FROZEN_HOIST_VERIFY");
    return value != nullptr && std::string(value) == "1";
  }();
  return on;
}

bool frozen_hoist_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_FROZEN_HOIST");
    return value == nullptr || std::string(value) != "0";
  }();
  return enabled;
}

bool defer_contacts_enabled() {
  static const bool enabled = [] {
    const char *value = std::getenv("VIBE_PHYSX_DEFER_CONTACTS");
    return value == nullptr || std::string(value) != "0";
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
#ifdef VIBE_LAND_NATIVE_DESTRUCTION
  // A pair involving a chunk owned by PhysX's own destruction stage needs no
  // CPU contact report: the stage assembles its loads from the solved impulses
  // on the GPU, so a notification here would cost a callback per manifold and
  // feed nothing. Ordinary actors -- players, vehicles, props -- keep theirs,
  // which is why this tests the shape bit rather than a global switch.
  if (((filter0.word3 | filter1.word3) & kNativeChunkFilterBit) != 0) {
    pair_flags = PxPairFlag::eCONTACT_DEFAULT;
    return PxFilterFlag::eDEFAULT;
  }
#endif
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
      // A CUDA context does not recover. One illegal address or a failed
      // allocation anywhere in the device work poisons it for the life of the
      // process: every later launch returns the same error, the scene stops
      // simulating, and nothing at the application level can undo it -- not a
      // reset, not rebuilding the stage, not releasing the scene. It has to be
      // distinguished from an ordinary rejected step, because the right
      // response is a new process and the wrong one is to keep serving a world
      // that will never move again. A live match spent 11,876 consecutive ticks
      // in exactly that state.
      if (text.find("previous CUDA errors") != std::string::npos ||
          text.find("Simulation cannot continue") != std::string::npos ||
          text.find("failed to allocate GPU memory") != std::string::npos) {
        context_lost_.store(true, std::memory_order_relaxed);
      }
    }
  }

  std::uint32_t warning_count() const {
    return warning_count_.load(std::memory_order_relaxed);
  }

  bool context_lost() const {
    return context_lost_.load(std::memory_order_relaxed);
  }

private:
  std::atomic<std::uint32_t> warning_count_{0};
  std::atomic<bool> context_lost_{false};
};

/// Collects PhysX's own instrumentation for one tick.
///
/// PhysX and the destruction stage already measure themselves in detail. CPU
/// phases arrive through zoneStart/zoneEnd; the stage's five CUDA phases arrive
/// through recordData carrying milliseconds read from CUDA events straddling
/// each phase. Nothing in this process was listening, which is why a 30 ms step
/// appeared in the panel as 30 ms of nothing, above a list of destruction
/// timings that were all honestly zero -- the work is inside `simulate()`, and
/// no span on our side of the FFI can see into it.
///
/// Off unless VIBE_PHYSX_PROFILE is set, because every zone in the engine pays
/// for it whether or not anyone reads the result.
class BridgeProfiler final : public PxProfilerCallback {
public:
  using Clock = std::chrono::steady_clock;

  struct Bucket {
    double total_ms = 0.0;
    std::uint32_t calls = 0;
    bool device = false;
  };

  void *zoneStart(const char *name, bool, std::uint64_t) override {
    const std::size_t slot =
        cursor_.fetch_add(1, std::memory_order_relaxed) % kSamples;
    Sample &sample = samples_[slot];
    // A ring, so a burst deeper than kSamples overwrites the oldest in-flight
    // sample rather than allocating. The name is re-checked on close, so a
    // stolen slot is dropped instead of being charged to the wrong zone.
    sample.name = name;
    sample.start = Clock::now();
    return &sample;
  }

  void zoneEnd(void *data, const char *name, bool, std::uint64_t) override {
    Sample *sample = static_cast<Sample *>(data);
    if (sample == nullptr || sample->name != name) {
      return;
    }
    const double ms =
        std::chrono::duration<double, std::milli>(Clock::now() - sample->start)
            .count();
    add(name, ms, false);
  }

  void recordData(float value, const char *name, std::uint64_t) override {
    add(name, static_cast<double>(value), true);
  }

  void recordData(std::int32_t value, const char *name,
                  std::uint64_t) override {
    add(name, static_cast<double>(value), true);
  }

  /// Drain the tick's totals. Named by pointer while accumulating, because
  /// PhysX guarantees the name is a persistent literal, and copied to owned
  /// strings only here.
  std::vector<std::pair<std::string, Bucket>> drain() {
    std::lock_guard<std::mutex> guard(mutex_);
    std::vector<std::pair<std::string, Bucket>> out;
    out.reserve(buckets_.size());
    for (const auto &entry : buckets_) {
      out.emplace_back(entry.first, entry.second);
    }
    buckets_.clear();
    return out;
  }

private:
  struct Sample {
    std::atomic<const char *> name{nullptr};
    Clock::time_point start{};
  };

  void add(const char *name, double value, bool device) {
    std::lock_guard<std::mutex> guard(mutex_);
    Bucket &bucket = buckets_[name];
    bucket.total_ms += value;
    bucket.calls += 1;
    bucket.device = device;
  }

  static constexpr std::size_t kSamples = 8192;
  std::array<Sample, kSamples> samples_{};
  std::atomic<std::size_t> cursor_{0};
  std::mutex mutex_;
  std::map<std::string, Bucket> buckets_;
};

inline bool physx_profile_enabled() {
  static const bool enabled = [] {
    const char *raw = std::getenv("VIBE_PHYSX_PROFILE");
    return raw != nullptr && raw[0] != '\0' && raw[0] != '0';
  }();
  return enabled;
}

inline BridgeProfiler &bridge_profiler() {
  static BridgeProfiler profiler;
  return profiler;
}

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
      // Installed before PxCreatePhysics so every engine zone from here on is
      // seen, including scene and CUDA setup.
      if (physx_profile_enabled()) {
        PxSetProfilerCallback(&bridge_profiler());
      }
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

  bool context_lost() const { return error_callback_.context_lost(); }

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

  ~Impl() {
#ifdef NVBLAST_ENABLE_CUDA_STRESS
    if (compact_contacts_verify()) {
      std::fprintf(stderr, "[compact-contact-audit] batches=%llu verified=%llu records=%llu pairs=%llu mismatches=%llu\n",
          (unsigned long long)gpu_compact_batches_, (unsigned long long)gpu_compact_verify_batches_,
          (unsigned long long)gpu_compact_verify_records_, (unsigned long long)gpu_compact_verify_pairs_,
          (unsigned long long)gpu_compact_verify_mismatches_);
    }
#endif
    teardown();
  }

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


  /// The per-pair processing, shared verbatim by the inline path (called
  /// from inside the contact callback) and the deferred drain (called from
  /// end_step after fetchResults returns). ONE body on purpose: two copies
  /// of this logic would drift, and a drift here is a physics divergence.
  /// The per-pair work that is a pure function of the pair: two shape->owner
  /// lookups and two rigid-body mass reads. Both are read-only over state that
  /// nothing mutates during the drain, which is what lets them move off the
  /// serial walk.
  struct PairPrecomputed {
#ifdef VIBE_LAND_DESTRUCTION
    DestructionManager::ContactTarget target0;
    DestructionManager::ContactTarget target1;
#endif
    float mass0 = -1.0f;
    float mass1 = -1.0f;
    /// Would queueContact drop a contact on this side as bondless? Resolved
    /// in the PARALLEL classify pass, so the serial drain skips the whole
    /// manifold's queue calls for that side at zero serial cost.
    ///
    /// 65% of queued contacts are aimed at single-node debris and dropped
    /// inside queueContact -- after the host has built the struct, converted
    /// two vectors and made a virtual call, once per contact POINT. This
    /// answers the same question once per manifold SIDE.
    bool bondless0 = false;
    bool bondless1 = false;
    /// Frozen membership for the two entities, resolved in the parallel pass.
    /// -1 = unresolved (the serial path then probes as before).
    int frozen_a = -1;
    int frozen_b = -1;
    bool valid = false;
    /// Per-manifold sums over the extracted points, computed in the parallel
    /// classify pass so the serial drain does not walk the points at all.
    /// Compensated force/moment sums preserve the full manifold wrench.
    PxVec3 total_impulse{0.0f};
    PxVec3 impulse_origin{0.0f};
    PxVec3 angular_impulse{0.0f};
    PxVec3 weighted_point{0.0f};
    float total_magnitude = 0.0f;
    float sum_abs_impulse_y = 0.0f;
    float min_separation = 1.0e6f;
    bool aggregated = false;
    /// The stress-solver injection for this manifold was already done by the
    /// per-structure parallel pass; the serial drain must not repeat it.
    bool queued = false;
  };

  /// One full wrench per manifold side preserves the resultant AND moment.
  /// Crushing retains point contacts because its virial/closing history cannot
  /// be recovered from a wrench. VIBE_PHYSX_CONTACT_AGGREGATE=0 is a per-point
  /// reference path; neither path removes forces or contact couples.
  static bool contact_aggregate_enabled() {
    static const bool enabled = [] {
      const char *raw = std::getenv("VIBE_PHYSX_CONTACT_AGGREGATE");
      if (raw != nullptr && std::string(raw) == "0") {
        return false;
      }
      // Crush needs the per-point positions.
      return std::getenv("BLAST_CRUSH_CAP") == nullptr;
    }();
    return enabled;
  }

  /// Inject each structure's contacts from its own pool task.
  ///
  /// queue_contact_at feeds a per-node float reduction inside the adapter,
  /// so the ORDER of a structure's contacts is load bearing -- but only
  /// within that structure: the four adapters share nothing. Each task walks
  /// the recorded pairs in order and queues only the sides that land on its
  /// structure, so every adapter sees exactly the sequence the serial drain
  /// gave it. VIBE_PHYSX_DRAIN_PARALLEL=0 restores the serial injection;
  /// VIBE_PHYSX_DRAIN_PARALLEL_VERIFY=1 replays the partition serially and
  /// compares the per-structure call sequences, same tick.
  static bool drain_parallel_enabled() {
    static const bool enabled = [] {
      const char *raw = std::getenv("VIBE_PHYSX_DRAIN_PARALLEL");
      return raw == nullptr || std::string(raw) != "0";
    }();
    return enabled;
  }
  static bool drain_parallel_verify() {
    static const bool enabled = [] {
      const char *raw = std::getenv("VIBE_PHYSX_DRAIN_PARALLEL_VERIFY");
      return raw != nullptr && std::string(raw) == "1";
    }();
    return enabled;
  }
  struct QueueTrace {
    const void *slot;
    std::uint32_t node;
    float x, y, z, px, py, pz, ax, ay, az;
    bool operator==(const QueueTrace &o) const {
      return std::tie(slot,node,x,y,z,px,py,pz,ax,ay,az)
          == std::tie(o.slot,o.node,o.x,o.y,o.z,o.px,o.py,o.pz,o.ax,o.ay,o.az);
    }
  };
  std::vector<std::vector<QueueTrace>> drain_trace_parallel_;
  std::vector<QueueTrace> drain_trace_serial_;
  std::uint64_t drain_verify_ticks_ = 0;
  std::uint64_t drain_verify_calls_ = 0;
  std::uint64_t drain_verify_mismatches_ = 0;

  static float dynamic_mass_of(const PxActor *actor) {
    const PxRigidDynamic *dynamic =
        actor != nullptr ? actor->is<PxRigidDynamic>() : nullptr;
    if (dynamic == nullptr ||
        dynamic->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC)) {
      return -1.0f;
    }
    return dynamic->getMass();
  }

  static bool contact_classify_enabled() {
    static const bool enabled = [] {
      const char *raw = std::getenv("VIBE_PHYSX_CONTACT_CLASSIFY");
      return raw == nullptr || std::string(raw) != "0";
    }();
    return enabled;
  }

  void process_extracted_pair(PxActor *actor0, PxActor *actor1,
                              PxShape *shape0, PxShape *shape1,
                              std::uint32_t entity_a, std::uint32_t entity_b,
                              bool ev_persists, bool ev_found,
                              const physx::PxContactPairPoint *points,
                              PxU32 extracted, PxU32 contact_count,
                              bool sample_subspans,
                              const PairPrecomputed *pre = nullptr) {
    const auto sub_now = [&]() {
      return sample_subspans ? cycle_now() : std::uint64_t{0};
    };
    const auto sub_ms = [](std::uint64_t from) {
      return static_cast<double>(cycle_now() - from) * cycles_to_ms_factor();
    };
      const bool census = contact_census_enabled();
      const auto census_started = census ? sub_now() : std::uint64_t{0};
      if (census) {
      // Pair census. The question this answers: of the ~11.6k pairs a
      // cascade tick reports, how many are a settled pile re-reporting the
      // same standing load (PERSISTS) versus a genuinely new contact
      // (FOUND)? That ratio decides whether "reduce pairs" is worth a
      // structural change, and which change.
      if (ev_persists) {
        ++cp_persists_;
      } else if (ev_found) {
        ++cp_found_;
      } else {
        ++cp_other_;
      }
      cp_points_ += contact_count;
      if (sample_subspans) {
        cb_census_ms_ += 8.0 * sub_ms(census_started);
      }
      }
#ifdef VIBE_LAND_DESTRUCTION
      // Once per shape per manifold, not once per shape per POINT. Every point
      // in a manifold shares the same two shapes, so the hash lookup and the
      // linear slot scan behind them were repeated for every point after the
      // first -- 2.06-3.64 points per manifold measured on downtown.
      DestructionManager::ContactTarget target0;
      DestructionManager::ContactTarget target1;
      const auto resolve_started = sub_now();
      if (pre != nullptr && pre->valid) {
        target0 = pre->target0;
        target1 = pre->target1;
      } else if (destruction_ && contact_cse_enabled()) {
        target0 = destruction_->resolve_contact_target(shape0);
        target1 = destruction_->resolve_contact_target(shape1);
      }
      bool skip0 = false;
      bool skip1 = false;
      if (!bondless_hoist_enabled()) {
        // Arm B: let queueContact make the decision, as before.
      } else if (pre != nullptr && pre->valid) {
        skip0 = pre->bondless0;
        skip1 = pre->bondless1;
      } else if (destruction_ && contact_cse_enabled()) {
        // Serial fallback (pair_count below the parallel floor). Still one
        // lookup per manifold side rather than one per point.
        skip0 = destruction_->target_is_bondless(target0);
        skip1 = destruction_->target_is_bondless(target1);
      }
      if (sample_subspans) {
        cb_resolve_ms_ += 8.0 * sub_ms(resolve_started);
      }
#endif
      PxVec3 total_impulse(0.0f);
      PxVec3 weighted_point(0.0f);
      float total_magnitude = 0.0f;
      float sum_abs_impulse_y = 0.0f;
      float min_separation = 1.0e6f;
      const auto points_started = sub_now();
#ifdef VIBE_LAND_DESTRUCTION
      const bool pre_aggregated = pre != nullptr && pre->valid && pre->aggregated;
      if (pre_aggregated) {
        total_impulse = pre->total_impulse;
        weighted_point = pre->weighted_point;
        total_magnitude = pre->total_magnitude;
        sum_abs_impulse_y = pre->sum_abs_impulse_y;
        min_separation = pre->min_separation;
        // Injection: done by the per-structure parallel pass, or here as one
        // call per side with the manifold's complete wrench.
        if (destruction_ && !pre->queued && total_magnitude > 0.0f) {
          const FfiVec3 position = from_px(pre->impulse_origin);
          const FfiVec3 impulse = from_px(total_impulse);
          const FfiVec3 angular = from_px(pre->angular_impulse);
          const FfiVec3 neg{-impulse.x, -impulse.y, -impulse.z};
          const FfiVec3 neg_angular{-angular.x, -angular.y, -angular.z};
          if (target0 && skip0) {
            ++bondless_skipped_host_;
          }
          if (target1 && skip1) {
            ++bondless_skipped_host_;
          }
          if (target0 && !skip0) {
            destruction_->queue_contact_wrench_at(target0, position, impulse, angular, /*wake=*/false);
          }
          if (target1 && !skip1) {
            destruction_->queue_contact_wrench_at(target1, position, neg, neg_angular, /*wake=*/false);
          }
        }
      }
      const PxU32 point_loop_count = pre_aggregated ? 0u : extracted;
#else
      const PxU32 point_loop_count = extracted;
#endif
      double impulse_sum[3] = {}, weighted_sum[3] = {};
      double magnitude_sum = 0.0, vertical_sum = 0.0;
      for (PxU32 point_index = 0; point_index < point_loop_count; ++point_index) {
        const PxContactPairPoint &point = points[point_index];
        if (point.separation < min_separation) {
          min_separation = point.separation;
        }
        const double x=point.impulse.x, y=point.impulse.y, z=point.impulse.z;
        const double magnitude = std::sqrt(x*x+y*y+z*z);
        impulse_sum[0] += x; impulse_sum[1] += y; impulse_sum[2] += z;
        weighted_sum[0] += double(point.position.x)*magnitude;
        weighted_sum[1] += double(point.position.y)*magnitude;
        weighted_sum[2] += double(point.position.z)*magnitude;
        magnitude_sum += magnitude;
        // A support contact's vertical magnitude is independent of actor order.
        vertical_sum += std::abs(y);
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
            // skip0/skip1 were decided once per manifold in the parallel
            // classify pass. queueContact would drop these anyway -- this
            // removes the struct build, the two to_px conversions and the
            // virtual call that preceded the drop, for every point.
            if (bondless_hoist_verify()) {
              // Queue everything, then check the prediction against reality.
              if (target0) {
                const bool queued = destruction_->queue_contact_at(
                    target0, position, impulse, /*wake=*/false);
                ++hoist_verify_checks_;
                if (skip0 == queued) {
                  report_hoist_mismatch(skip0, queued);
                }
              }
              if (target1) {
                const bool queued = destruction_->queue_contact_at(
                    target1, position, neg, /*wake=*/false);
                ++hoist_verify_checks_;
                if (skip1 == queued) {
                  report_hoist_mismatch(skip1, queued);
                }
              }
            } else {
              if (target0 && skip0) {
                ++bondless_skipped_host_;
              }
              if (target1 && skip1) {
                ++bondless_skipped_host_;
              }
              if (target0 && !skip0) {
                destruction_->queue_contact_at(target0, position, impulse,
                                               /*wake=*/false);
              }
              if (target1 && !skip1) {
                destruction_->queue_contact_at(target1, position, neg,
                                               /*wake=*/false);
              }
            }
          } else {
            destruction_->route_contact_shape(shape0, position, impulse,
                                              /*wake=*/false);
            destruction_->route_contact_shape(shape1, position, neg,
                                              /*wake=*/false);
          }
        }
#endif
      }
      if (point_loop_count != 0) {
        total_impulse = PxVec3(float(impulse_sum[0]),float(impulse_sum[1]),float(impulse_sum[2]));
        weighted_point = PxVec3(float(weighted_sum[0]),float(weighted_sum[1]),float(weighted_sum[2]));
        total_magnitude = float(magnitude_sum);
        sum_abs_impulse_y = float(vertical_sum);
      }
      if (sample_subspans) {
        cb_queue_ms_ += 8.0 * sub_ms(points_started);
      }
      // Which CONSUMER would miss this pair if it were not reported. The two
      // want opposite things -- stress damage only cares about contacts hard
      // enough to pass a bond's elastic limit, the supporter graph
      // specifically needs the gentle resting ones -- so a single threshold
      // cannot serve both, and this counts the overlap.
      if (sum_abs_impulse_y > 0.0f) {
        ++cp_supporter_relevant_;
      }
      // log2 histogram of the pair's total impulse. A histogram rather than a
      // count against a fixed cut, because the useful question is "what would
      // a threshold of X cost", and X is exactly what is not known yet.
      const auto hist_started = census ? sub_now() : std::uint64_t{0};
      if (census) {
      if (total_magnitude > 0.0f) {
        int bucket = 0;
        float m = total_magnitude;
        while (m >= 1.0f && bucket < kImpulseBuckets - 1) {
          m *= 0.5f;
          ++bucket;
        }
        ++cp_impulse_hist_[bucket];
      } else {
        ++cp_zero_impulse_;
      }
      if (sample_subspans) {
        cb_census_ms_ += 8.0 * sub_ms(hist_started);
      }
      }

      const auto events_started = sub_now();
      if (total_magnitude > 0.0f) {
        weighted_point /= total_magnitude;
        contact_events_.push_back(
            {entity_a, entity_b, from_px(total_impulse),
             from_px(weighted_point)});
      }
      if (sample_subspans) {
        cb_events_ms_ += 8.0 * sub_ms(events_started);
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
          destruction_->note_pair_load(target0, target1, shape0,
                                       shape1, actor0,
                                       actor1, sum_abs_impulse_y,
                                       min_separation);
        } else {
          destruction_->note_pair_load(shape0, shape1,
                                       actor0, actor1,
                                       sum_abs_impulse_y, min_separation);
        }
      }
      if (sample_subspans) {
        cb_pair_load_ms_ += 8.0 * sub_ms(pair_load_started);
      }
      const auto wake_started = sub_now();
      if (destruction_ && destruction_->has_frozen_bodies() &&
          total_magnitude > 0.0f) {
        const float mass0 = (pre != nullptr && pre->valid)
                                ? pre->mass0 : dynamic_mass_of(actor0);
        const float mass1 = (pre != nullptr && pre->valid)
                                ? pre->mass1 : dynamic_mass_of(actor1);
        const int fa = pre != nullptr ? pre->frozen_a : -1;
        const int fb = pre != nullptr ? pre->frozen_b : -1;
        if (frozen_hoist_verify() && fa >= 0) {
          const int truth_a = destruction_->entity_is_frozen(entity_a) ? 1 : 0;
          const int truth_b = destruction_->entity_is_frozen(entity_b) ? 1 : 0;
          ++frozen_verify_checks_;
          if (fa != truth_a || fb != truth_b) {
            ++frozen_verify_mismatches_;
            if (frozen_verify_mismatches_ <= 5) {
              std::fprintf(stderr,
                           "[frozen] MISMATCH hoisted=(%d,%d) truth=(%d,%d)\n",
                           fa, fb, truth_a, truth_b);
            }
          }
          if ((frozen_verify_checks_ % 20000000) == 0) {
            std::fprintf(stderr,
                         "[frozen] verify: checks=%llu mismatches=%llu\n",
                         static_cast<unsigned long long>(frozen_verify_checks_),
                         static_cast<unsigned long long>(
                             frozen_verify_mismatches_));
          }
        }
        destruction_->note_contact_pair(entity_a, entity_b, mass0, mass1,
                                        total_magnitude, fa, fb);
      }
      if (sample_subspans) {
        cb_wake_ms_ += 8.0 * sub_ms(wake_started);
      }
#endif
  }

  /// Process everything the callback captured, in recorded order.
  void drain_deferred_contacts() {
    if (deferred_pairs_.empty()) {
      return;
    }
    const std::uint64_t drain_started = cycle_now();

    // Classify in parallel, ingest serially in recorded order.
    //
    // The two shape->owner resolves and the two mass reads are pure lookups
    // over state nothing mutates during the drain, so they fan out. Everything
    // that MUTATES stays on the serial walk below, in the original order,
    // because that order is load bearing: queue_contact_at feeds
    // ext_stress_solver_add_all_forces, whose per-node force sum is a float
    // reduction, so reordering it changes which bonds break.
    //
    // Same shape as resolve_support_loads: an output vector pre-sized and
    // indexed by input index, so ordering is structural rather than emergent.
    const std::size_t pair_count = deferred_pairs_.size();
    classify_scratch_.clear();
#ifdef VIBE_LAND_DESTRUCTION
    constexpr std::size_t kClassifyFloor = 512;
    const bool aggregate = contact_aggregate_enabled() && contact_cse_enabled();
    const bool classify_parallel =
        contact_classify_enabled() && destruction_ != nullptr &&
        contact_cse_enabled() && pair_count >= kClassifyFloor &&
        destruction_->pool_parallelism() > 1;
    if (classify_parallel) {
      classify_scratch_.resize(pair_count);
      const std::size_t strips = destruction_->pool_parallelism();
      const std::size_t strip_len = (pair_count + strips - 1) / strips;
      destruction_->run_parallel(strips, [&](std::size_t strip) {
        const std::size_t begin = strip * strip_len;
        const std::size_t end = std::min(pair_count, begin + strip_len);
        for (std::size_t i = begin; i < end; ++i) {
          const DeferredContactPair &rec = deferred_pairs_[i];
          PairPrecomputed &out = classify_scratch_[i];
          out.target0 = destruction_->resolve_contact_target(rec.shape0);
          out.target1 = destruction_->resolve_contact_target(rec.shape1);
          out.mass0 = dynamic_mass_of(rec.actor0);
          out.mass1 = dynamic_mass_of(rec.actor1);
          if (bondless_hoist_enabled()) {
            out.bondless0 = destruction_->target_is_bondless(out.target0);
            out.bondless1 = destruction_->target_is_bondless(out.target1);
          }
          if (frozen_hoist_enabled() && destruction_->has_frozen_bodies()) {
            out.frozen_a = destruction_->entity_is_frozen(rec.entity_a) ? 1 : 0;
            out.frozen_b = destruction_->entity_is_frozen(rec.entity_b) ? 1 : 0;
          }
          if (aggregate) {
            const physx::PxContactPairPoint *points = deferred_points_.data() + rec.point_begin;
            const PxVec3 origin = static_cast<PxRigidActor*>(rec.actor0)->getGlobalPose().p;
            Nv::Blast::ExtStressPhysXContactWrenchAccumulator wrench(origin);
            double weighted[3] = {}, magnitude_sum = 0.0, vertical_sum = 0.0;
            float min_separation = 1.0e6f;
            for (PxU32 p = 0; p < rec.point_count; ++p) {
              const auto &point = points[p];
              min_separation = std::min(min_separation, point.separation);
              wrench.add(point.position, point.impulse);
              const double x=point.impulse.x, y=point.impulse.y, z=point.impulse.z;
              const double magnitude = std::sqrt(x*x+y*y+z*z);
              weighted[0] += double(point.position.x)*magnitude;
              weighted[1] += double(point.position.y)*magnitude;
              weighted[2] += double(point.position.z)*magnitude;
              magnitude_sum += magnitude;
              vertical_sum += std::abs(y);
            }
            out.total_impulse = wrench.linearImpulse();
            out.angular_impulse = wrench.angularImpulse();
            out.impulse_origin = origin;
            out.weighted_point = PxVec3(float(weighted[0]), float(weighted[1]), float(weighted[2]));
            out.total_magnitude = float(magnitude_sum);
            out.sum_abs_impulse_y = float(vertical_sum);
            out.min_separation = min_separation;
            require(out.total_impulse.isFinite() && out.angular_impulse.isFinite()
                    && out.weighted_point.isFinite() && finite(out.total_magnitude)
                    && finite(out.sum_abs_impulse_y), "Contact wrench exceeded numeric representation");
            out.aggregated = true;
          }
          out.valid = true;
        }
      });

      // Per-structure parallel injection. Only with the per-side aggregate
      // (so a side is one call), only when the bondless answer is hoisted
      // (so no per-point drop decision remains), and never under the hoist
      // verifier, which needs the old queue-everything path.
      if (aggregate && drain_parallel_enabled() && bondless_hoist_enabled() &&
          !bondless_hoist_verify()) {
        // Slot is opaque here; the target carries the structure id, which
        // orders the tasks deterministically.
        std::vector<std::pair<std::uint32_t, DestructionManager::Slot *>> keyed;
        for (std::size_t i = 0; i < pair_count; ++i) {
          const PairPrecomputed &pre = classify_scratch_[i];
          for (const DestructionManager::ContactTarget *t : {&pre.target0, &pre.target1}) {
            if (t->slot == nullptr) {
              continue;
            }
            bool seen = false;
            for (const auto &k : keyed) {
              if (k.second == t->slot) {
                seen = true;
                break;
              }
            }
            if (!seen) {
              keyed.emplace_back(t->structure_id, t->slot);
            }
          }
        }
        std::sort(keyed.begin(), keyed.end(),
                  [](const auto &a, const auto &b) { return a.first < b.first; });
        std::vector<DestructionManager::Slot *> slots;
        std::vector<std::uint32_t> slot_ids;
        for (const auto &k : keyed) {
          slots.push_back(k.second);
          slot_ids.push_back(k.first);
        }
        const bool verify = drain_parallel_verify();
        if (verify) {
          drain_trace_parallel_.assign(slots.size(), {});
        }
        std::vector<std::uint32_t> skipped(slots.size(), 0u);
        destruction_->run_parallel(slots.size(), [&](std::size_t s) {
          DestructionManager::Slot *mine = slots[s];
          std::uint32_t my_skipped = 0;
          for (std::size_t i = 0; i < pair_count; ++i) {
            const PairPrecomputed &pre = classify_scratch_[i];
            if (pre.total_magnitude <= 0.0f) {
              // Same gate as the serial path's weighted point: a manifold
              // with no impulse queued nothing per point either (every
              // point's impulse is zero), and its position is undefined.
              continue;
            }
            const FfiVec3 position = from_px(pre.impulse_origin);
            const FfiVec3 impulse = from_px(pre.total_impulse);
            const FfiVec3 angular = from_px(pre.angular_impulse);
            const FfiVec3 neg{-impulse.x, -impulse.y, -impulse.z};
            const FfiVec3 neg_angular{-angular.x, -angular.y, -angular.z};
            if (pre.target0.slot == mine) {
              if (pre.bondless0) {
                ++my_skipped;
              } else {
                if (verify) {
                  drain_trace_parallel_[s].push_back(
                      {mine, pre.target0.blast_node, impulse.x, impulse.y, impulse.z, position.x, position.y, position.z, angular.x, angular.y, angular.z});
                }
                destruction_->queue_contact_wrench_at(pre.target0, position, impulse, angular,
                                                      /*wake=*/false);
              }
            }
            if (pre.target1.slot == mine) {
              if (pre.bondless1) {
                ++my_skipped;
              } else {
                if (verify) {
                  drain_trace_parallel_[s].push_back(
                      {mine, pre.target1.blast_node, neg.x, neg.y, neg.z, position.x, position.y, position.z, neg_angular.x, neg_angular.y, neg_angular.z});
                }
                destruction_->queue_contact_wrench_at(pre.target1, position, neg, neg_angular,
                                                      /*wake=*/false);
              }
            }
          }
          skipped[s] = my_skipped;
        });
        for (std::size_t i = 0; i < pair_count; ++i) {
          classify_scratch_[i].queued = true;
        }
        for (const std::uint32_t n : skipped) {
          bondless_skipped_host_ += n;
        }
        if (verify) {
          // Serial replay of the partition, in recorded order, per structure.
          ++drain_verify_ticks_;
          for (std::size_t s = 0; s < slots.size(); ++s) {
            drain_trace_serial_.clear();
            for (std::size_t i = 0; i < pair_count; ++i) {
              const PairPrecomputed &pre = classify_scratch_[i];
              if (pre.total_magnitude <= 0.0f) {
                continue;
              }
              const FfiVec3 impulse = from_px(pre.total_impulse);
              if (pre.target0.slot == slots[s] && !pre.bondless0) {
                drain_trace_serial_.push_back(
                    {slots[s], pre.target0.blast_node, impulse.x, impulse.y, impulse.z, pre.impulse_origin.x, pre.impulse_origin.y, pre.impulse_origin.z, pre.angular_impulse.x, pre.angular_impulse.y, pre.angular_impulse.z});
              }
              if (pre.target1.slot == slots[s] && !pre.bondless1) {
                drain_trace_serial_.push_back(
                    {slots[s], pre.target1.blast_node, -impulse.x, -impulse.y, -impulse.z, pre.impulse_origin.x, pre.impulse_origin.y, pre.impulse_origin.z, -pre.angular_impulse.x, -pre.angular_impulse.y, -pre.angular_impulse.z});
              }
            }
            drain_verify_calls_ += drain_trace_serial_.size();
            if (drain_trace_serial_ != drain_trace_parallel_[s]) {
              ++drain_verify_mismatches_;
              std::fprintf(stderr,
                           "[drain-parallel] MISMATCH structure=%u serial=%zu parallel=%zu\n",
                           slot_ids[s], drain_trace_serial_.size(),
                           drain_trace_parallel_[s].size());
            }
          }
          if (drain_verify_ticks_ % 600 == 0) {
            std::fprintf(stderr,
                         "[drain-parallel] ticks=%llu calls=%llu mismatches=%llu\n",
                         static_cast<unsigned long long>(drain_verify_ticks_),
                         static_cast<unsigned long long>(drain_verify_calls_),
                         static_cast<unsigned long long>(drain_verify_mismatches_));
          }
        }
      }
    }
#endif

    for (std::size_t i = 0; i < pair_count; ++i) {
      const DeferredContactPair &rec = deferred_pairs_[i];
      ++contact_drain_records_;
      const bool sample =
          profile_callback_enabled() && (contact_drain_records_ & 7u) == 0;
      const PairPrecomputed *pre =
          i < classify_scratch_.size() ? &classify_scratch_[i] : nullptr;
      process_extracted_pair(rec.actor0, rec.actor1, rec.shape0, rec.shape1,
                             rec.entity_a, rec.entity_b, rec.ev_persists,
                             rec.ev_found,
                             deferred_points_.data() + rec.point_begin,
                             rec.point_count, rec.reported_count, sample, pre);
    }
    deferred_pairs_.clear();
    deferred_points_.clear();
#ifdef VIBE_LAND_DESTRUCTION
    if (destruction_ != nullptr && bondless_skipped_host_ != 0) {
      destruction_->note_bondless_skipped(bondless_skipped_host_);
      bondless_skipped_host_ = 0;
    }
#endif
    if (bondless_hoist_verify() && (++hoist_verify_drains_ % 600) == 0) {
      dump_hoist_verify();
    }
    contact_drain_cycles_ += cycle_now() - drain_started;
  }

#ifdef NVBLAST_ENABLE_CUDA_STRESS
  // Preserve the full legacy sequence (including equivalent-key payloads),
  // every float addition, and the complete deferred callback boundary. The
  // optional reference uses this same decoder batch, never another GPU copy.
  void capture_compact_gpu_contacts(PxU32 count) {
    using Clock = std::chrono::steady_clock;
    auto started = Clock::now();
    const auto finish = [&]() {
      const auto now = Clock::now();
      const double ms = std::chrono::duration<double, std::milli>(now - started).count();
      started = now;
      return ms;
    };
    const auto actor_key = [](const auto &a, const auto &b) {
      return (std::uint64_t(std::min(a.actor_index, b.actor_index)) << 32)
           | std::max(a.actor_index, b.actor_index);
    };
    const auto *ordered = gpu_compact_order_.sort(gpu_contacts_.data(), count);
    gpu_contact_sort_ms_ = finish();
    gpu_compact_impulses_.clear();
    for (PxU32 i = 0; i < count; ++i) {
      const auto &c = ordered[i];
      if (!c.friction) {
        const auto &a = gpu_contact_shapes_[c.transformCacheRef0];
        const auto &b = gpu_contact_shapes_[c.transformCacheRef1];
        gpu_compact_impulses_.add(actor_key(a, b), c.normalImpulse);
      }
    }
    gpu_contact_reduce_ms_ = finish();
    // Instantiate the identical event construction with independent tables and
    // metadata getters for the reference. Neither path changes event order.
    const auto route = [&](const GpuContact *input, auto load, auto threshold,
                           auto record_pair, auto &points, auto &pairs) {
      for (PxU32 begin = 0; begin < count;) {
        const auto &first = input[begin];
        PxU32 end = begin + 1;
        while (end < count && input[end].transformCacheRef0 == first.transformCacheRef0
               && input[end].transformCacheRef1 == first.transformCacheRef1) ++end;
        require(first.transformCacheRef0 < gpu_contact_shapes_.size()
                    && first.transformCacheRef1 < gpu_contact_shapes_.size(),
                "GPU contact references an unknown shape");
        const auto &a = gpu_contact_shapes_[first.transformCacheRef0];
        const auto &b = gpu_contact_shapes_[first.transformCacheRef1];
        require(a.shape && b.shape && a.actor == first.actor0 && b.actor == first.actor1,
                "GPU contact ownership disagrees with live shape mapping");
        float normal_impulse = 0.0f;
        for (PxU32 i = begin; i < end; ++i) {
          const auto &c = input[i];
          require(c.actor0 == a.actor && c.actor1 == b.actor, "GPU contact pair changed ownership");
          if (!c.friction) normal_impulse += c.normalImpulse;
        }
        if (normal_impulse > 0.0f && load(a, b) > threshold(a, b) * kFixedTimestep) {
          const std::uint64_t key = (std::uint64_t(first.transformCacheRef0) << 32) | first.transformCacheRef1;
          const bool persists = record_pair(key);
          const auto point_begin = static_cast<PxU32>(points.size());
          for (PxU32 i = begin; i < end; ++i) {
            const auto &c = input[i];
            PxContactPairPoint point{};
            point.position = c.worldPosition;
            point.normal = c.worldNormal;
            point.impulse = c.impulseOnActor0;
            point.separation = c.separation;
            points.push_back(point);
          }
          pairs.push_back({a.actor, b.actor, a.shape, b.shape,
              actor_entity_id(a.actor), actor_entity_id(b.actor), point_begin,
              end - begin, end - begin, persists, !persists});
        }
        begin = end;
      }
    };
    gpu_compact_current_.clear();
    route(ordered,
        [&](const auto &a, const auto &b) {
          const float *value = gpu_compact_impulses_.find(actor_key(a, b));
          return value ? *value : 0.0f;
        },
        [](const auto &a, const auto &b) { return std::min(a.threshold, b.threshold); },
        [&](std::uint64_t key) {
          const bool persists = gpu_compact_previous_.contains(key);
          gpu_compact_current_.insert(key);
          return persists;
        }, deferred_points_, deferred_pairs_);
    gpu_contact_route_ms_ = finish();
    if (compact_contacts_verify()) {
      const auto audit = [&](bool ok, const char *message) {
        if (!ok) ++gpu_compact_verify_mismatches_;
        require(ok, message);
      };
      const auto same_float = [](float a, float b) {
        return std::memcmp(&a, &b, sizeof(float)) == 0;
      };
      std::sort(gpu_contacts_.begin(), gpu_contacts_.begin() + count, gpu_contact_less);
      for (PxU32 i = 0; i < count; ++i)
        audit(same_gpu_contact(ordered[i], gpu_contacts_[i]),
              "Compact contact sort changed a complete legacy contact or tie order");
      const auto reference_key = [](PxRigidActor *a, PxRigidActor *b) {
        const auto index = [](PxRigidActor *actor) {
          const auto *body = actor->is<PxRigidDynamic>();
          return body ? body->getGPUIndex() : PX_INVALID_U32;
        };
        const PxU32 ia = index(a), ib = index(b);
        return (std::uint64_t(std::min(ia, ib)) << 32) | std::max(ia, ib);
      };
      for (const auto &shape : gpu_contact_shapes_) {
        if (shape.shape) audit(same_float(shape.threshold, gpu_contact_threshold(shape.actor)),
                               "Compact contact cached threshold differs");
      }
      gpu_actor_pair_normal_impulses_.clear();
      for (PxU32 i = 0; i < count; ++i) {
        const auto &c = gpu_contacts_[i];
        const auto key = reference_key(c.actor0, c.actor1);
        audit(key == actor_key(gpu_contact_shapes_[c.transformCacheRef0],
                               gpu_contact_shapes_[c.transformCacheRef1]),
              "Compact contact cached actor key differs");
        if (!c.friction) gpu_actor_pair_normal_impulses_[key] += c.normalImpulse;
      }
      audit(gpu_compact_impulses_.size() == gpu_actor_pair_normal_impulses_.size(),
            "Compact contact impulse table cardinality differs");
      for (const auto &[key, expected] : gpu_actor_pair_normal_impulses_) {
        const auto *actual = gpu_compact_impulses_.find(key);
        audit(actual && same_float(*actual, expected), "Compact contact impulse sum bits differ");
      }
      gpu_compact_reference_points_.clear();
      gpu_compact_reference_pairs_.clear();
      gpu_current_pairs_.clear();
      route(gpu_contacts_.data(),
          [&](const auto &a, const auto &b) {
            const auto found = gpu_actor_pair_normal_impulses_.find(reference_key(a.actor, b.actor));
            return found == gpu_actor_pair_normal_impulses_.end() ? 0.0f : found->second;
          },
          [](const auto &a, const auto &b) {
            return std::min(gpu_contact_threshold(a.actor), gpu_contact_threshold(b.actor));
          },
          [&](std::uint64_t key) {
            const bool persists = gpu_previous_pairs_.find(key) != gpu_previous_pairs_.end();
            gpu_current_pairs_.insert(key);
            return persists;
          }, gpu_compact_reference_points_, gpu_compact_reference_pairs_);
      audit(gpu_compact_current_.size() == gpu_current_pairs_.size(),
            "Compact contact shape-pair set cardinality differs");
      for (const auto key : gpu_current_pairs_)
        audit(gpu_compact_current_.contains(key), "Compact contact shape-pair set differs");
      audit(deferred_points_.size() == gpu_compact_reference_points_.size()
                && deferred_pairs_.size() == gpu_compact_reference_pairs_.size(),
            "Compact contact output cardinality differs");
      for (size_t i = 0; i < deferred_points_.size(); ++i) {
        const auto &a = deferred_points_[i], &b = gpu_compact_reference_points_[i];
        audit(std::memcmp(&a.position, &b.position, sizeof(PxVec3)) == 0
                  && std::memcmp(&a.normal, &b.normal, sizeof(PxVec3)) == 0
                  && std::memcmp(&a.impulse, &b.impulse, sizeof(PxVec3)) == 0
                  && same_float(a.separation, b.separation)
                  && a.internalFaceIndex0 == b.internalFaceIndex0
                  && a.internalFaceIndex1 == b.internalFaceIndex1,
              "Compact contact emitted point payload/order differs");
      }
      for (size_t i = 0; i < deferred_pairs_.size(); ++i) {
        const auto &a = deferred_pairs_[i], &b = gpu_compact_reference_pairs_[i];
        audit(a.actor0 == b.actor0 && a.actor1 == b.actor1 && a.shape0 == b.shape0 && a.shape1 == b.shape1
                  && a.entity_a == b.entity_a && a.entity_b == b.entity_b && a.point_begin == b.point_begin
                  && a.point_count == b.point_count && a.reported_count == b.reported_count
                  && a.ev_persists == b.ev_persists && a.ev_found == b.ev_found,
              "Compact contact emitted pair payload/order differs");
      }
      gpu_previous_pairs_.swap(gpu_current_pairs_);
      ++gpu_compact_verify_batches_;
      gpu_compact_verify_records_ += count;
      gpu_compact_verify_pairs_ += deferred_pairs_.size();
      gpu_compact_verify_ms_ = finish();
    }
    gpu_compact_previous_.swap(gpu_compact_current_);
  }

  void capture_gpu_contacts() {
    const bool compact = compact_contacts_enabled();
    require(!compact_contacts_verify() || compact, "Compact contact verification requires compact mode");
    require(!compact || Nv::Blast::ExtStressPhysXCompactContactOrder<GpuContact>::supported(),
            "Compact contact order requires a qualified libstdc++ build");
    require(!compact || !gpu_contact_order_enabled(), "Compact and GPU contact ordering are mutually exclusive");
    gpu_compact_verify_ms_ = 0.0;
    if (compact) ++gpu_compact_batches_;
    gpu_contact_copy_ms_ = gpu_contact_ownership_ms_ = gpu_contact_validate_ms_ = 0.0;
    gpu_contact_sort_ms_ = gpu_contact_reduce_ms_ = gpu_contact_route_ms_ = 0.0;
    gpu_contact_order_verify_ms_ = 0.0;
    gpu_contact_ordered_ = gpu_contact_order_ambiguous_ = false;
    auto phase_start = std::chrono::steady_clock::now();
    const auto finish_phase = [&]() {
      const auto now = std::chrono::steady_clock::now();
      const double ms = std::chrono::duration<double, std::milli>(now - phase_start).count();
      phase_start = now;
      return ms;
    };
    require(deferred_pairs_.empty() && deferred_points_.empty(),
            "Direct GPU mixed native callbacks with device contacts");
    const bool verify_order = gpu_contact_order_enabled() && gpu_contact_order_verify();
    if (verify_order) gpu_contact_reference_.resize(gpu_contacts_.size());
    const PxU32 count = gpu_contact_drain_->copyContacts(
        gpu_contacts_.data(), static_cast<PxU32>(gpu_contacts_.size()), gpu_contact_order_enabled(),
        verify_order ? gpu_contact_reference_.data() : nullptr);
    require(gpu_contact_drain_->lastCopyComplete(),
            "GPU contact readback failed or exceeded configured capacity");
    gpu_contact_gpu_order_ms_ = gpu_contact_drain_->lastOrderMilliseconds();
    gpu_contact_copy_ms_ = finish_phase() - gpu_contact_gpu_order_ms_;
    gpu_contact_count_ = count;
    gpu_contact_ordered_ = gpu_contact_drain_->lastCopyOrdered();
    gpu_contact_order_ambiguous_ = gpu_contact_order_enabled() && count && !gpu_contact_ordered_;
    if (count == 0) {
      gpu_previous_pairs_.clear();
      gpu_compact_previous_.clear();
      if (compact_contacts_verify()) ++gpu_compact_verify_batches_;
      return;
    }
    // Reference routing boundary. Rebuild from live shapes so recycled PhysX
    // indices never resolve through a retired shape or actor. The GPU stress
    // route can replace this observer once its ownership tables are wired.
    std::fill(gpu_contact_shapes_.begin(), gpu_contact_shapes_.end(), GpuContactShape{});
    const auto types = PxActorTypeFlag::eRIGID_DYNAMIC | PxActorTypeFlag::eRIGID_STATIC;
    gpu_contact_actors_.resize(scene_->getNbActors(types));
    const PxU32 actors = scene_->getActors(types, gpu_contact_actors_.data(),
                                          static_cast<PxU32>(gpu_contact_actors_.size()));
    for (PxU32 i = 0; i < actors; ++i) {
      auto *actor = static_cast<PxRigidActor *>(gpu_contact_actors_[i]);
      const auto *body = compact ? actor->is<PxRigidDynamic>() : nullptr;
      const PxU32 actor_index = body ? body->getGPUIndex() : PX_INVALID_U32;
      const float threshold = body ? body->getContactReportThreshold() : PX_MAX_F32;
      gpu_shape_scratch_.resize(actor->getNbShapes());
      const PxU32 shapes = actor->getShapes(gpu_shape_scratch_.data(),
                                           static_cast<PxU32>(gpu_shape_scratch_.size()));
      for (PxU32 j = 0; j < shapes; ++j) {
        auto *shape = gpu_shape_scratch_[j];
#if defined(PX_DIRECT_GPU_HOST_ACCESS_VERSION)
        // Geometry indices and contact transform-cache indices are separate
        // allocators; they diverge as soon as fracture migrates a shape.
        const auto index = scene_->getDirectGPUAPI().getShapeContactIndex(*shape);
#else
        const auto index = PX_INVALID_U32;
#endif
        require(index != PX_INVALID_U32, "live contact shape has no GPU contact index");
        if (index >= gpu_contact_shapes_.size()) gpu_contact_shapes_.resize(size_t(index) + 1);
        gpu_contact_shapes_[index] = {shape, actor, actor_index, threshold};
      }
    }
    gpu_contact_ownership_ms_ = finish_phase();
    // Native thresholds aggregate all shapes of a solver-body pair. Static
    // actors share the solver's world body, including separate static actors.
    const auto actor_pair_key = [](PxRigidActor *a, PxRigidActor *b) {
      const auto index = [](PxRigidActor *actor) {
        const auto *body = actor->is<PxRigidDynamic>();
        return body ? body->getGPUIndex() : PX_INVALID_U32;
      };
      const PxU32 ia = index(a), ib = index(b);
      return (std::uint64_t(std::min(ia, ib)) << 32) | std::max(ia, ib);
    };
    if (!compact) gpu_actor_pair_normal_impulses_.clear();
    for (PxU32 i = 0; i < count; ++i) {
      auto &contact = gpu_contacts_[i];
      require(contact.worldPosition.isFinite() && contact.impulseOnActor0.isFinite()
                  && contact.worldNormal.isFinite() && finite(contact.separation)
                  && finite(contact.normalImpulse) && contact.normalImpulse >= 0.0f,
              "nonfinite or negative GPU contact");
      require(contact.transformCacheRef0 < gpu_contact_shapes_.size()
                  && contact.transformCacheRef1 < gpu_contact_shapes_.size(),
              "GPU contact references an unknown shape");
      const auto &a = gpu_contact_shapes_[contact.transformCacheRef0];
      const auto &b = gpu_contact_shapes_[contact.transformCacheRef1];
      require(a.shape && b.shape && a.actor == contact.actor0 && b.actor == contact.actor1,
              "GPU contact ownership disagrees with live shape mapping");
      canonicalize_gpu_contact(contact);
    }
    gpu_contact_validate_ms_ = finish_phase();
    if (compact) { capture_compact_gpu_contacts(count); return; }
    if (!gpu_contact_ordered_) {
      std::sort(gpu_contacts_.begin(), gpu_contacts_.begin() + count, gpu_contact_less);
    }
    gpu_contact_sort_ms_ = finish_phase();
    if (verify_order && gpu_contact_ordered_) {
      // Reference observes the EXACT original decoder input, not another
      // copyContactData call whose pair order could differ. Preserve a copy
      // for the legacy four-key comparator's threshold decisions too.
      for (PxU32 i = 0; i < count; ++i) canonicalize_gpu_contact(gpu_contact_reference_[i]);
      gpu_contact_legacy_reference_.assign(gpu_contact_reference_.begin(), gpu_contact_reference_.begin() + count);
      std::sort(gpu_contact_reference_.begin(), gpu_contact_reference_.begin() + count, gpu_contact_provenance_less);
      std::sort(gpu_contact_legacy_reference_.begin(), gpu_contact_legacy_reference_.end(), gpu_contact_less);
      ++gpu_contact_order_verify_checks_;
      for (PxU32 i = 0; i < count; ++i) {
        if (!same_gpu_contact(gpu_contacts_[i], gpu_contact_reference_[i])) {
          ++gpu_contact_order_verify_mismatches_;
          require(false, "GPU contact ordering changed the canonical contact sequence");
        }
      }
    }
    gpu_contact_order_verify_ms_ = finish_phase();
    // Accumulate in the sorted order, independent of CUDA atomic emission.
    for (PxU32 i = 0; i < count; ++i) {
      const auto &contact = gpu_contacts_[i];
      if (!contact.friction) {
        gpu_actor_pair_normal_impulses_[actor_pair_key(contact.actor0, contact.actor1)]
            += contact.normalImpulse;
      }
    }
    gpu_contact_reduce_ms_ = finish_phase();
    if (verify_order && gpu_contact_ordered_) {
      struct LegacyPair { float impulse = 0.0f; float threshold = 0.0f; };
      std::unordered_map<std::uint64_t, LegacyPair> legacy;
      for (const auto &contact : gpu_contact_legacy_reference_) {
        if (contact.friction) continue;
        auto [entry, inserted] = legacy.try_emplace(actor_pair_key(contact.actor0, contact.actor1));
        if (inserted) entry->second.threshold = std::min(gpu_contact_threshold(contact.actor0),
            gpu_contact_threshold(contact.actor1)) * kFixedTimestep;
        entry->second.impulse += contact.normalImpulse;
      }
      for (const auto &[key, expected] : legacy) {
        const float actual = gpu_actor_pair_normal_impulses_.at(key);
        std::uint32_t actual_bits, expected_bits;
        std::memcpy(&actual_bits, &actual, sizeof(actual_bits));
        std::memcpy(&expected_bits, &expected.impulse, sizeof(expected_bits));
        gpu_contact_legacy_max_ulp_ = std::max(gpu_contact_legacy_max_ulp_,
            actual_bits > expected_bits ? actual_bits - expected_bits : expected_bits - actual_bits);
        ++gpu_contact_legacy_threshold_checks_;
        if ((actual > expected.threshold) != (expected.impulse > expected.threshold)) {
          ++gpu_contact_legacy_threshold_mismatches_;
          require(false, "GPU contact provenance ordering changed a legacy force-threshold decision");
        }
      }
    }
#ifdef VIBE_LAND_DESTRUCTION
    if (verify_order && gpu_contact_ordered_) {
      for (PxU32 begin=0; begin<count;) {
        const auto& first=gpu_contacts_[begin];
        PxU32 end=begin+1;
        while (end<count && gpu_contacts_[end].transformCacheRef0==first.transformCacheRef0
               && gpu_contacts_[end].transformCacheRef1==first.transformCacheRef1) ++end;
        const PxVec3 origin=first.actor0->getGlobalPose().p;
        Nv::Blast::ExtStressPhysXContactWrenchAccumulator actual(origin), expected(origin);
        for (PxU32 i=begin; i<end; ++i) {
          const auto& a=gpu_contacts_[i];
          const auto& e=gpu_contact_legacy_reference_[i];
          require(e.transformCacheRef0==first.transformCacheRef0
                      && e.transformCacheRef1==first.transformCacheRef1,
                  "Legacy contact audit grouped different shape pairs");
          actual.add(a.worldPosition,a.impulseOnActor0);
          expected.add(e.worldPosition,e.impulseOnActor0);
        }
        const PxVec3 af=actual.linearImpulse(), ef=expected.linearImpulse();
        const PxVec3 am=actual.angularImpulse(), em=expected.angularImpulse();
        ++gpu_contact_wrench_checks_;
        if (af!=ef || am!=em) ++gpu_contact_wrench_mismatches_;
        for (unsigned axis=0; axis<3; ++axis) {
          gpu_contact_wrench_max_force_error_=std::max(gpu_contact_wrench_max_force_error_,
              std::abs(double(af[axis])-ef[axis]));
          gpu_contact_wrench_max_moment_error_=std::max(gpu_contact_wrench_max_moment_error_,
              std::abs(double(am[axis])-em[axis]));
        }
        begin=end;
      }
    }
#endif
    gpu_contact_order_verify_ms_ += finish_phase();
    gpu_current_pairs_.clear();
    for (PxU32 begin = 0; begin < count;) {
      const auto &first = gpu_contacts_[begin];
      PxU32 end = begin + 1;
      while (end < count && gpu_contacts_[end].transformCacheRef0 == first.transformCacheRef0
             && gpu_contacts_[end].transformCacheRef1 == first.transformCacheRef1) ++end;
      require(first.transformCacheRef0 < gpu_contact_shapes_.size()
                  && first.transformCacheRef1 < gpu_contact_shapes_.size(),
              "GPU contact references an unknown shape");
      const auto &a = gpu_contact_shapes_[first.transformCacheRef0];
      const auto &b = gpu_contact_shapes_[first.transformCacheRef1];
      require(a.shape && b.shape && a.actor == first.actor0 && b.actor == first.actor1,
              "GPU contact ownership disagrees with live shape mapping");
      float normal_impulse = 0.0f;
      for (PxU32 i = begin; i < end; ++i) {
        const auto &c = gpu_contacts_[i];
        require(c.actor0 == a.actor && c.actor1 == b.actor, "GPU contact pair changed ownership");
        if (!c.friction) normal_impulse += c.normalImpulse;
      }
      const auto threshold = [](PxRigidActor *actor) {
        const auto *body = actor->is<PxRigidDynamic>();
        return body ? body->getContactReportThreshold() : PX_MAX_F32;
      };
      const auto load = gpu_actor_pair_normal_impulses_.find(actor_pair_key(a.actor, b.actor));
      const float actor_pair_impulse = load == gpu_actor_pair_normal_impulses_.end() ? 0.0f : load->second;
      // PhysX only inserts shape pairs with a nonzero normal impulse in its
      // threshold stream, even when other shapes of the body exceed the limit.
      if (normal_impulse > 0.0f && actor_pair_impulse >
              std::min(threshold(a.actor), threshold(b.actor)) * kFixedTimestep) {
        const std::uint64_t key = (std::uint64_t(first.transformCacheRef0) << 32) | first.transformCacheRef1;
        const bool persists = gpu_previous_pairs_.find(key) != gpu_previous_pairs_.end();
        gpu_current_pairs_.insert(key);
        const auto point_begin = static_cast<PxU32>(deferred_points_.size());
        for (PxU32 i = begin; i < end; ++i) {
          const auto &c = gpu_contacts_[i];
          PxContactPairPoint point{};
          point.position = c.worldPosition;
          point.normal = c.worldNormal;
          point.impulse = c.impulseOnActor0;
          point.separation = c.separation;
          deferred_points_.push_back(point);
        }
        deferred_pairs_.push_back({a.actor, b.actor, a.shape, b.shape,
            actor_entity_id(a.actor), actor_entity_id(b.actor), point_begin,
            end - begin, end - begin, persists, !persists});
      }
      begin = end;
    }
    gpu_previous_pairs_.swap(gpu_current_pairs_);
    gpu_contact_route_ms_ = finish_phase();
  }
#endif

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
    // Hoisted to callback scope: the entity resolution below and the
    // per-manifold target resolution further down were both OUTSIDE every
    // timed block, which is why the first live breakdown left 42% of the
    // callback cost unattributed -- more than any block it did name.
    const auto sub_now = [&]() {
      return sample_subspans ? cycle_now() : std::uint64_t{0};
    };
    const auto sub_ms = [](std::uint64_t from) {
      return static_cast<double>(cycle_now() - from) * cycles_to_ms_factor();
    };
    const auto entity_started = sub_now();
    const std::uint32_t entity_a = actor_entity_id(header.actors[0]);
    const std::uint32_t entity_b = actor_entity_id(header.actors[1]);
    if (sample_subspans) {
      cb_entity_ms_ += 8.0 * sub_ms(entity_started);
    }
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
      if (defer_contacts_enabled()) {
        // Capture only: the contact stream is valid ONLY during this
        // callback, so extraction cannot defer; everything else can and
        // does. Indices, not pointers, into deferred_points_ -- it grows
        // during capture.
        // The capture was the one untimed block on the default path, and it
        // is the whole of what onContact still does per manifold: extraction
        // cannot defer (the contact stream is valid only inside this
        // callback). Without it cb_tick had a ~1.5 ms hole that the tree had
        // no name for.
        const auto capture_started = sub_now();
        const std::size_t base = deferred_points_.size();
        deferred_points_.resize(base + contact_count);
        const PxU32 extracted =
            pair.extractContacts(deferred_points_.data() + base, contact_count);
        deferred_points_.resize(base + extracted);
        deferred_pairs_.push_back(
            {header.actors[0], header.actors[1], pair.shapes[0],
             pair.shapes[1], entity_a, entity_b,
             static_cast<std::uint32_t>(base), extracted, contact_count,
             static_cast<bool>(pair.events &
                               PxPairFlag::eNOTIFY_THRESHOLD_FORCE_PERSISTS),
             static_cast<bool>(pair.events &
                               (PxPairFlag::eNOTIFY_THRESHOLD_FORCE_FOUND |
                                PxPairFlag::eNOTIFY_TOUCH_FOUND))});
        if (sample_subspans) {
          cb_capture_ms_ += 8.0 * sub_ms(capture_started);
        }
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
      // rdtsc, not steady_clock: at cascade rates this fires ~950 times a tick
      // across four sub-blocks, and at ~25 ns a read the clock was costing
      // ~0.19 ms/tick -- which is why this was opt-in and therefore always
      // dark in exactly the reports that needed it. The cycle counter is
      // ~7 ns, putting the whole sub-attribution near 0.05 ms/tick, cheap
      // enough to leave on permanently.
      const auto resize_started = sub_now();
      contact_points_.resize(contact_count);
      if (sample_subspans) {
        cb_resize_ms_ += 8.0 * sub_ms(resize_started);
      }
      const auto extract_started = sub_now();
      const PxU32 extracted =
          pair.extractContacts(contact_points_.data(), contact_count);
      if (sample_subspans) {
        // x8, same convention as the outer contact_callback_ms_ probe.
        cb_extract_ms_ += 8.0 * sub_ms(extract_started);
      }
      process_extracted_pair(
          header.actors[0], header.actors[1], pair.shapes[0], pair.shapes[1],
          entity_a, entity_b,
          static_cast<bool>(pair.events &
                            PxPairFlag::eNOTIFY_THRESHOLD_FORCE_PERSISTS),
          static_cast<bool>(pair.events &
                            (PxPairFlag::eNOTIFY_THRESHOLD_FORCE_FOUND |
                             PxPairFlag::eNOTIFY_TOUCH_FOUND)),
          contact_points_.data(), extracted, contact_count, sample_subspans);

    }
    // Sum AND max. 526 ms of callback in one tick is either 11,710 callbacks
    // at 45 us each (systematic: the work got slower) or one callback that
    // blocked for half a second (a stall: allocation, page fault, or the
    // thread being descheduled -- rdtsc measures wall, so a preemption lands
    // inside whichever callback was running). Those are opposite bugs and the
    // sum cannot tell them apart.
    const std::uint64_t callback_cycles = cycle_now() - callback_started;
    contact_callback_cycles_ += callback_cycles;
    if (callback_cycles > contact_callback_max_cycles_) {
      contact_callback_max_cycles_ = callback_cycles;
    }
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

  void launch_dynamic_ball(const FfiLaunchedBallDesc &desc) {
    ensure_new_id(desc.entity_id);
    require(finite(desc.radius) && desc.radius > 0.0f,
            "launched ball radius must be positive");
    const PxVec3 velocity = to_px(desc.linear_velocity);
    require(velocity.isFinite(), "launched ball velocity must be finite");
    add_dynamic(desc.entity_id, desc.user_id, desc.pose,
                PxSphereGeometry(desc.radius), desc.mass,
                desc.collision_group, desc.collision_mask,
                RecordKind::DynamicSphere);
    Record &record = find(desc.entity_id);
    PxRigidDynamic *actor =
        record.actor != nullptr ? record.actor->is<PxRigidDynamic>() : nullptr;
    require(actor != nullptr, "launched ball is not a dynamic rigid body");
    // Speculative contacts, because the geometry alone cannot stop this thing
    // passing through a wall. The stage forbids scene CCD -- getDestructionScene()
    // returns null when PxSceneFlag::eENABLE_CCD is set -- but that is the
    // sweep-based pipeline. eENABLE_SPECULATIVE_CCD is a per-body flag which
    // simply widens contact generation by how far the body will travel this
    // step, inside the ordinary discrete solver, and the stage does not object
    // to it. A 0.3 m ball at 60 m/s moves a full metre per 60 Hz tick against
    // a 0.6 m diameter, so without this any wall thinner than about 0.4 m can
    // fall between two positions and never generate a contact at all.
    // Off by default, because it trades one bug for a worse one. It does stop
    // the ball passing through: without it the ball goes through the wall at
    // 140 m/s, with it the wall holds to somewhere past 140 and under 240. But
    // a speculative contact does not deliver the impulse the destruction stage
    // reads its loads from, so the same shot that broke 51 bonds breaks zero.
    // A projectile that stops dead and does nothing is not an improvement on
    // one that goes through. VIBE_CITY_BALL_SPECULATIVE_CCD=1 to re-measure.
    static const bool speculative = [] {
      const char *raw = std::getenv("VIBE_CITY_BALL_SPECULATIVE_CCD");
      return raw != nullptr && raw[0] == '1';
    }();
    actor->setRigidBodyFlag(PxRigidBodyFlag::eENABLE_SPECULATIVE_CCD, speculative);
    // Widening the shape's contact offset as well was tried and does nothing:
    // at 240 m/s the ball went through at 75.7 m without it and 75.6 m with,
    // so speculative contacts are already doing whatever there is to do here.
    // Not kept, so the next person does not read it as load-bearing.
    // A thrown ball is ballistic. The damping `add_dynamic` gives a loose prop
    // so it stops rolling would bleed roughly a quarter of the muzzle speed
    // away in the first second, which is the difference between a shot that
    // reaches the building and one that drops short of it.
    actor->setLinearDamping(0.0f);
    actor->setAngularDamping(0.0f);
    actor->setLinearVelocity(velocity);
  }

  void set_body_pose(std::uint32_t entity_id, const FfiPose &pose) {
    Record &record = find(entity_id);
    require(record.controller == nullptr, "cannot move a capsule controller this way");
    PxRigidDynamic *dynamic =
        record.actor != nullptr ? record.actor->is<PxRigidDynamic>() : nullptr;
    require(dynamic != nullptr, "entity is not a dynamic rigid body");
    const PxTransform target = to_px(pose);
    require(target.isSane(), "body pose must be finite");
    dynamic->setGlobalPose(target, /*autowake=*/true);
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
    cb_capture_ms_ = 0.0;
    cb_queue_ms_ = 0.0;
    cb_pair_load_ms_ = 0.0;
    cb_wake_ms_ = 0.0;
    cb_resolve_ms_ = 0.0;
    cb_entity_ms_ = 0.0;
    cb_events_ms_ = 0.0;
    cb_census_ms_ = 0.0;
    cb_resize_ms_ = 0.0;
    contact_drain_cycles_ = 0;
    cp_found_ = 0;
    cp_persists_ = 0;
    cp_other_ = 0;
    cp_points_ = 0;
    cp_supporter_relevant_ = 0;
    cp_zero_impulse_ = 0;
    for (int i = 0; i < kImpulseBuckets; ++i) {
      cp_impulse_hist_[i] = 0;
    }
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
    contact_callback_max_cycles_ = 0;
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
        if (!ready) {
          // Yield between probes. The original loop spun flat out, which is
          // what made per-tick sampling cost ~0.91 ms: not the timestamps
          // (we take those every tick anyway) but a core taken away from the
          // Blast walks running beside this. Handing the slice back turns the
          // spin into a wait, and the wait is what we are trying to MEASURE.
          std::this_thread::yield();
        }
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
      // Also keep the last few samples. A per-tick value that is zero on 15
      // ticks out of 16 is right for a trace, which buckets every tick and
      // can filter — but a 1 Hz report snapshot almost never lands on a
      // sampled tick, so it published zeros and the whole split was
      // invisible in exactly the place it was built for. The ring is read
      // -cadence independent: any observer, at any rate, sees the recent
      // mean.
      sim_wall_ring_[sim_wall_ring_head_] = last_gpu_wait_ms_;
      result_copy_ring_[sim_wall_ring_head_] =
          std::max(0.0f, last_fetch_copy_ms_ -
                             static_cast<float>(
                                 static_cast<double>(contact_callback_cycles_) *
                                 cycles_to_ms_factor()));
      // Callback and fetch-total go on the SAME ring, on the SAME ticks.
      // The 4.3% "unattributed" in the PhysX fetch was never untimed work:
      // gpu_wait and result_copy were recent means while fetch_total was
      // this tick's value, so the subtraction compared two different
      // windows. Same window, and the parts sum to the whole by
      // construction -- at no cost, since these ticks are already sampled.
      callback_ring_[sim_wall_ring_head_] = static_cast<float>(
          static_cast<double>(contact_callback_cycles_) *
          cycles_to_ms_factor());
      // fetch_total is not known until the fetch below finishes, so remember
      // which slot to complete rather than writing a stale value here.
      pending_ring_slot_ = static_cast<int>(sim_wall_ring_head_);
      sim_wall_ring_head_ = (sim_wall_ring_head_ + 1) % kSimWallRing;
      if (sim_wall_ring_fill_ < kSimWallRing) {
        ++sim_wall_ring_fill_;
      }
    } else {
      const bool succeeded = scene_->fetchResults(true);
      if (!succeeded) {
        // The simulate window is over either way: PhysX has fetched, and what
        // failed is the step's own result. Leaving the in-flight flag set would
        // make every later begin_step fail too, turning one rejected tick into
        // a permanently frozen scene -- which is what happened the first time
        // a caller tried to carry on after a rejected step.
        step_in_flight_ = false;
        require(false, "PhysX fetchResults failed");
      }
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
    if (pending_ring_slot_ >= 0) {
      fetch_total_ring_[static_cast<std::size_t>(pending_ring_slot_)] =
          last_fetch_total_ms_;
      pending_ring_slot_ = -1;
    }
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
#ifdef NVBLAST_ENABLE_CUDA_STRESS
    if (gpu_host_mirror_ != nullptr) {
      const auto mirror_start = std::chrono::steady_clock::now();
      const PxU32 count = scene_->getNbActors(PxActorTypeFlag::eRIGID_DYNAMIC);
      gpu_mirror_actors_.resize(count);
      gpu_mirror_bodies_.resize(count);
      const PxU32 written = scene_->getActors(PxActorTypeFlag::eRIGID_DYNAMIC,
                                             gpu_mirror_actors_.data(), count);
      require(written == count, "GPU observation actor list changed during fetch");
      for (PxU32 i = 0; i < count; ++i) {
        gpu_mirror_bodies_[i] = static_cast<PxRigidDynamic *>(gpu_mirror_actors_[i]);
      }
      require(gpu_host_mirror_->synchronize(gpu_mirror_bodies_.data(), count),
              "GPU motion observation failed");
      gpu_host_mirror_ms_ = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - mirror_start).count();
      capture_gpu_contacts();
    }
#endif
    // Include explicit observation in the completed physics step, while the
    // native fetch/callback timings above retain their original boundaries.
    const auto end = std::chrono::steady_clock::now();
    last_fetch_ms_ =
        std::chrono::duration<float, std::milli>(end - fetch_start).count();
    // Deferred-contact drain: after the fetch split is recorded (so the
    // capture-only callback cost stays inside fetch numbers and the drain
    // appears as its own span), before destruction_tick consumes the queues.
    if (defer_contacts_enabled()) {
      drain_deferred_contacts();
    }
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
#ifdef NVBLAST_ENABLE_CUDA_STRESS
    span("direct_host_mirror_ms", gpu_host_mirror_ms_, 0);
    span("direct_contact_copy_ms", gpu_contact_copy_ms_, 0);
    span("direct_contact_ownership_ms", gpu_contact_ownership_ms_, 0);
    span("direct_contact_validate_ms", gpu_contact_validate_ms_, 0);
    span("direct_contact_sort_ms", gpu_contact_sort_ms_, 0);
    span("compact_contact_enabled", compact_contacts_enabled(), 2);
    span("compact_contact_batches", gpu_compact_batches_, 2);
    span("compact_contact_verify_ms", gpu_compact_verify_ms_, 0);
    span("compact_contact_verify_batches", gpu_compact_verify_batches_, 2);
    span("compact_contact_verify_records", gpu_compact_verify_records_, 2);
    span("compact_contact_verify_pairs", gpu_compact_verify_pairs_, 2);
    span("compact_contact_verify_mismatches", gpu_compact_verify_mismatches_, 2);
    span("direct_contact_reduce_ms", gpu_contact_reduce_ms_, 0);
    span("direct_contact_route_ms", gpu_contact_route_ms_, 0);
    span("direct_contact_count", gpu_contact_count_, 2);
    span("direct_contact_gpu_order_ms", gpu_contact_gpu_order_ms_, 0);
    span("direct_contact_gpu_ordered", gpu_contact_ordered_, 2);
    span("direct_contact_order_ambiguous", gpu_contact_order_ambiguous_, 2);
    span("direct_contact_wrench_checks", gpu_contact_wrench_checks_, 2);
    span("direct_contact_wrench_mismatches", gpu_contact_wrench_mismatches_, 2);
    span("direct_contact_wrench_max_force_error", gpu_contact_wrench_max_force_error_, 0);
    span("direct_contact_wrench_max_moment_error", gpu_contact_wrench_max_moment_error_, 0);
    span("direct_contact_order_verify_checks", gpu_contact_order_verify_checks_, 2);
    span("direct_contact_order_verify_mismatches", gpu_contact_order_verify_mismatches_, 2);
    span("direct_contact_order_verify_ms", gpu_contact_order_verify_ms_, 0);
    span("direct_contact_legacy_threshold_checks", gpu_contact_legacy_threshold_checks_, 2);
    span("direct_contact_legacy_threshold_mismatches", gpu_contact_legacy_threshold_mismatches_, 2);
    span("direct_contact_legacy_sum_max_ulp", gpu_contact_legacy_max_ulp_, 2);
#endif
    // The rigid-body decomposition. sim_wall and fetch_call are 0 on
    // unsampled ticks; sim_wall_sampled marks the ones that carry a number,
    // so an average is taken over the right denominator rather than being
    // diluted by the zeros.
    span("sim_wall_ms", static_cast<double>(last_sim_wall_ms_), 0);
    span("fetch_call_ms", static_cast<double>(last_fetch_call_ms_), 0);
    span("sim_wall_sampled", static_cast<double>(sim_wall_samples_), 2);
    span("result_copy_ms", static_cast<double>(last_result_copy_ms_), 0);
    span("fetch_total_ms", static_cast<double>(last_fetch_total_ms_), 0);
    // Mean of the recent samples: what a 1 Hz report should read, since the
    // instantaneous fields above are zero on every unsampled tick.
    if (sim_wall_ring_fill_ > 0) {
      double sim_sum = 0.0;
      double copy_sum = 0.0;
      for (std::size_t i = 0; i < sim_wall_ring_fill_; ++i) {
        sim_sum += sim_wall_ring_[i];
        copy_sum += result_copy_ring_[i];
      }
      const double n = static_cast<double>(sim_wall_ring_fill_);
      span("sim_wall_recent_ms", sim_sum / n, 0);
      span("result_copy_recent_ms", copy_sum / n, 0);
      span("sim_wall_recent_n", n, 2);
      double cb_sum = 0.0;
      double total_sum = 0.0;
      for (std::size_t i = 0; i < sim_wall_ring_fill_; ++i) {
        cb_sum += callback_ring_[i];
        total_sum += fetch_total_ring_[i];
      }
      span("callback_recent_ms", cb_sum / n, 0);
      span("fetch_total_recent_ms", total_sum / n, 0);
      // All four from the same window, so this is the honest remainder.
      span("fetch_residual_recent_ms",
           (total_sum - sim_sum - copy_sum - cb_sum) / n, 0);
    }
    span("tsc_suspect_ticks", static_cast<double>(tsc_suspect_ticks_), 2);
    span("cb_extract_ms", cb_extract_ms_, 0);
    span("hoist_verify_checks", static_cast<double>(hoist_verify_checks_), 2);
    span("hoist_verify_mismatches",
         static_cast<double>(hoist_verify_mismatches_), 2);
    span("cb_capture_ms", cb_capture_ms_, 0);
    span("cb_queue_ms", cb_queue_ms_, 0);
    span("cb_pair_load_ms", cb_pair_load_ms_, 0);
    span("cb_wake_ms", cb_wake_ms_, 0);
    // Added after the first live breakdown left 42% of the callback cost in
    // an unnamed residual. resolve/entity are the shape- and actor-id hash
    // lookups; events is the per-manifold aggregate push.
    span("cb_resolve_ms", cb_resolve_ms_, 0);
    span("cb_entity_ms", cb_entity_ms_, 0);
    span("cb_events_ms", cb_events_ms_, 0);
    span("cb_census_ms", cb_census_ms_, 0);
    span("cb_resize_ms", cb_resize_ms_, 0);
    span("cb_drain_ms",
         static_cast<double>(contact_drain_cycles_) * cycles_to_ms_factor(),
         0);
    span("cb_max_us",
         static_cast<double>(contact_callback_max_cycles_) *
             cycles_to_ms_factor() * 1000.0,
         0);
    span("cp_found", static_cast<double>(cp_found_), 0);
    span("cp_persists", static_cast<double>(cp_persists_), 0);
    span("cp_other", static_cast<double>(cp_other_), 0);
    span("cp_points", static_cast<double>(cp_points_), 0);
    span("cp_supporter_relevant", static_cast<double>(cp_supporter_relevant_), 0);
    span("cp_zero_impulse", static_cast<double>(cp_zero_impulse_), 0);
    // Fixed names rather than a built string: the span lambda takes a
    // const char*, and a per-tick std::string allocation in the stats path
    // is exactly the kind of cost that shows up later as a mystery.
    static constexpr const char* kImpulseSpanNames[kImpulseBuckets] = {
        "cp_imp_2e0",  "cp_imp_2e1",  "cp_imp_2e2",  "cp_imp_2e3",
        "cp_imp_2e4",  "cp_imp_2e5",  "cp_imp_2e6",  "cp_imp_2e7",
        "cp_imp_2e8",  "cp_imp_2e9",  "cp_imp_2e10", "cp_imp_2e11",
        "cp_imp_2e12", "cp_imp_2e13", "cp_imp_2e14", "cp_imp_2e15",
        "cp_imp_2e16", "cp_imp_2e17", "cp_imp_2e18", "cp_imp_2e19"};
    for (int i = 0; i < kImpulseBuckets; ++i) {
      if (cp_impulse_hist_[i] != 0) {
        span(kImpulseSpanNames[i], static_cast<double>(cp_impulse_hist_[i]), 0);
      }
    }
    span("contact_callbacks", static_cast<double>(contact_callbacks_this_step_), 2);
    // Broadphase membership churn: prices freeze/thaw flips directly.
    span("bp_adds", static_cast<double>(statistics.getNbBroadPhaseAdds()), 2);
    span("bp_removes", static_cast<double>(statistics.getNbBroadPhaseRemoves()), 2);
    // CORRECTED 2026-08-27: this is a BUFFER HIGH-WATER from
    // gpuDynamicsMemoryConfigStatistics — the largest found/lost buffer the
    // GPU pipeline has needed since scene creation — NOT per-tick pair
    // activity. It read exactly 19481 across an hour of live reports while
    // being cited as an activity signal. Renamed so the name says what it
    // measures; the per-tick pair churn signals are the two below.
    span("gpu_found_lost_pairs_high_water",
         static_cast<double>(
             statistics.gpuDynamicsMemoryConfigStatistics.foundLostPairs),
         2);
    // Per-frame broadphase pair churn from PxSimulationStatistics. Unlike the
    // CPU narrowphase pair counter (absent under eGPU), these are filled by
    // the BP stage. New+lost ≈ how much of the pair set is actually changing;
    // a settled field re-reporting thousands of callbacks with near-zero
    // churn here is the quiet-pair lever's whole justification, measured.
    span("bp_new_pairs", static_cast<double>(statistics.nbNewPairs), 2);
    span("bp_lost_pairs", static_cast<double>(statistics.nbLostPairs), 2);
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
    // sim_wall is sampled 1 tick in 16, so on the other 15 these were
    // published as 0.0 -- and a 1 Hz report snapshot almost never lands on a
    // sampled tick. The headline PhysX split therefore read "0.0 gpu wait,
    // 0.0 copy" in every debug report while the underlying measurement was
    // sitting right there in the ring, which made PhysX look opaque when it
    // was only unpublished. Fall back to the recent mean rather than a zero
    // that reads as "measured, and it was free".
    out.last_gpu_wait_ms = last_gpu_wait_ms_;
    out.last_fetch_copy_ms = last_fetch_copy_ms_;
    if (sim_wall_samples_ == 0 && sim_wall_ring_fill_ > 0) {
      double sim_sum = 0.0;
      double copy_sum = 0.0;
      for (std::size_t i = 0; i < sim_wall_ring_fill_; ++i) {
        sim_sum += sim_wall_ring_[i];
        copy_sum += result_copy_ring_[i];
      }
      const double n = static_cast<double>(sim_wall_ring_fill_);
      out.last_gpu_wait_ms = static_cast<float>(sim_sum / n);
      out.last_fetch_copy_ms = static_cast<float>(copy_sum / n);
    }
    out.completed_steps = completed_steps_;
    out.gpu_warning_count = runtime_->warning_count();
    out.gpu_context_lost = runtime_->context_lost();
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
  rust::Vec<FfiBondStressRow> bond_stress_rows(std::uint32_t structure_id) const {
    if (!destruction_) {
      return {};
    }
    return destruction_->bond_stress_rows(structure_id);
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
    // GPU broadphase by default; VIBE_PHYSX_BROADPHASE=abp|pabp selects a CPU
    // one. A knob rather than a constant because the broadphase is the first
    // thing a GPU scene constructs, so it is also the first thing to fail when
    // an SDK build is wrong -- being able to take it out of the picture is the
    // difference between bisecting an engine and guessing at it.
    scene_desc.broadPhaseType = PxBroadPhaseType::eGPU;
    if (const char *raw = std::getenv("VIBE_PHYSX_BROADPHASE")) {
      const std::string choice(raw);
      if (choice == "abp") {
        scene_desc.broadPhaseType = PxBroadPhaseType::eABP;
      } else if (choice == "pabp") {
        scene_desc.broadPhaseType = PxBroadPhaseType::ePABP;
      } else if (choice != "gpu") {
        throw std::runtime_error(
            "VIBE_PHYSX_BROADPHASE must be gpu, abp or pabp");
      }
    }
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
    const char *direct_env = std::getenv("VIBE_PHYSX_DIRECT_GPU");
    const bool direct_gpu = direct_env != nullptr && direct_env[0] == '1';
    if (direct_gpu) {
#if defined(NVBLAST_ENABLE_CUDA_STRESS) && defined(PX_DIRECT_GPU_HOST_ACCESS_VERSION)
      require(defer_contacts_enabled(), "Direct GPU requires deferred contact processing");
      require(contact_persists_enabled(), "Direct GPU requires persistent support contacts");
      require(Nv::Blast::ExtStressPhysXGpuActivity::configureScene(scene_desc),
              "PhysX SDK does not support Direct GPU with native sleeping");
      scene_desc.flags |= PxSceneFlag::eENABLE_DIRECT_GPU_HOST_ACCESS;
#else
      throw std::runtime_error("VIBE_PHYSX_DIRECT_GPU requires CUDA stress and the host-access SDK");
#endif
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

#ifdef NVBLAST_ENABLE_CUDA_STRESS
    if (direct_gpu) {
      gpu_host_mirror_ = Nv::Blast::ExtStressPhysXGpuHostMirror::create(*scene_);
      require(gpu_host_mirror_ != nullptr && gpu_host_mirror_->available(),
              "GPU observation capability missing from created scene");
      gpu_contact_drain_ = Nv::Blast::ExtStressPhysXDirectGpuContactDrain::create(
          *scene_, scene_desc.gpuDynamicsConfig.maxRigidPatchCount);
      require(gpu_contact_drain_ != nullptr && gpu_contact_drain_->available(),
              "GPU contact capability missing from created scene");
      // At most one normal record per contact and two friction anchors per patch.
      const std::uint64_t capacity = std::uint64_t(scene_desc.gpuDynamicsConfig.maxRigidContactCount)
          + 2ull * scene_desc.gpuDynamicsConfig.maxRigidPatchCount;
      require(capacity <= std::numeric_limits<PxU32>::max(), "GPU contact capacity overflows indexing");
      gpu_contacts_.resize(static_cast<size_t>(capacity));
    }
#endif
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
#ifdef NVBLAST_ENABLE_CUDA_STRESS
    if (gpu_contact_drain_ != nullptr) {
      gpu_contact_drain_->release();
      gpu_contact_drain_ = nullptr;
    }
    if (gpu_host_mirror_ != nullptr) {
      gpu_host_mirror_->release();
      gpu_host_mirror_ = nullptr;
    }
#endif
#ifdef VIBE_LAND_NATIVE_DESTRUCTION
    // Before the scene's actors go: clearStress destroys the scene-owned
    // fragment bodies, and it can only do that while the scene is alive.
    native_.reset();
#endif
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
      // The PhysX 100 rad/s default clips angular momentum from off-centre
      // impacts. Use the SDK's numeric range, as for destructible children.
      actor->setMaxAngularVelocity(1.0e16f);
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
#ifdef VIBE_LAND_NATIVE_DESTRUCTION
  // --- PhysX's own GPU destruction stage ------------------------------------
  // Every entry point asserts we are outside a step. The stage is configured
  // and observed between simulates; touching it during one is undefined, and
  // the assert is what turns that into a clear error instead of a corrupt read.
  NativeDestruction &native() {
    require(native_ != nullptr, "native destruction is not attached");
    return *native_;
  }
  const NativeDestruction &native() const {
    require(native_ != nullptr, "native destruction is not attached");
    return *native_;
  }

  void native_attach() {
    require(!step_in_flight_, "native_attach must run outside a step");
    require(scene_ != nullptr && runtime_ != nullptr, "scene unavailable");
    if (native_ == nullptr) {
      native_ = std::make_unique<NativeDestruction>(runtime_->physics(), *scene_,
                                                    *material_);
    }
  }

  void native_create_destructible(std::uint32_t structure_id,
                                  const FfiPose &pose,
                                  rust::Slice<const FfiChunkNodeDesc> nodes,
                                  rust::Slice<const FfiChunkBondDesc> bonds,
                                  const FfiDestructibleSettings &settings,
                                  std::uint32_t collision_group,
                                  std::uint32_t collision_mask) {
    require(!step_in_flight_, "native_create_destructible must run outside a step");
    // Releasing the old city's shapes does not reach the GPU broadphase until
    // the scene next simulates, so authoring before that leaves it holding
    // pairs against freed shapes. The cost is one illegal memory access inside
    // GPU narrowphase, and CUDA does not forgive one: every later launch in the
    // process fails with error 700 and the match is over. Reproduced by
    // collapsing a building and resetting on top of it, which failed on the
    // third cycle and has since run twenty-six clean.
    //
    // Checked here because it is invisible at the call site and invisible in a
    // small test -- the bridge's own rebuild cycle does this with sixteen
    // chunks and has always passed.
    require(native_cleared_at_step_ == kNoNativeClear ||
                completed_steps_ > native_cleared_at_step_,
            "step the scene once after native_clear before authoring again: "
            "the GPU broadphase still holds pairs against the released shapes");
    native().create_destructible(structure_id, pose, nodes, bonds, settings,
                                 collision_group, collision_mask);
  }

  FfiNativeConfigured native_configure(const FfiNativeConfig &config) {
    require(!step_in_flight_, "native_configure must run outside a step");
    return native().configure(config);
  }

  FfiNativeStatus native_tick() {
    require(!step_in_flight_, "native_tick must run outside a step");
    return native().tick();
  }

  FfiNativeStatus native_last_status() const { return native().last_status(); }

  std::uint32_t native_fire_round(const FfiRoundDesc &desc) {
    require(!step_in_flight_, "native_fire_round must run outside a step");
    return native().fire_round(desc);
  }

  rust::Vec<FfiBrokenBondEvent> native_take_broken_bonds() {
    return native().take_broken_bonds();
  }
  rust::Vec<FfiChunkMigrationEvent> native_take_chunk_migrations() {
    return native().take_chunk_migrations();
  }
  rust::Vec<FfiIslandBodyEvent> native_take_island_events() {
    return native().take_island_events();
  }
  rust::Slice<const FfiChunkBodySnapshot> native_chunk_body_snapshots() const {
    return native().chunk_body_snapshots();
  }
  rust::Vec<FfiBondStressRow> native_bond_stress_rows(std::uint32_t structure_id) const {
    return native().bond_stress_rows(structure_id);
  }
  FfiDestructionStats native_stats() const {
    FfiDestructionStats stats = native().stats();
    // The destruction stage runs inside PxScene::simulate(), so every span the
    // stage itself can publish is honestly near zero while the step costs tens
    // of milliseconds. These are the engine's own measurements of that step:
    // five CUDA phases timed with events straddling each one, plus whatever CPU
    // zones PhysX opened. Without them the panel says "31 ms" and then lists
    // nothing that accounts for it.
    if (physx_profile_enabled()) {
      for (auto &entry : bridge_profiler().drain()) {
        FfiNamedSpan span{};
        span.name = rust::String(entry.first);
        span.value = entry.second.total_ms;
        // 1: summed across phases and threads, so it does not add up to a
        // wall-clock parent and must not be read as if it did.
        span.kind = 1;
        stats.extra_spans.push_back(std::move(span));
        FfiNamedSpan calls{};
        calls.name = rust::String(entry.first + ".calls");
        calls.value = static_cast<double>(entry.second.calls);
        calls.kind = 2;
        stats.extra_spans.push_back(std::move(calls));
      }
    }
    return stats;
  }
  bool native_validate_mappings() const { return native().validate_mappings(); }
  void native_clear() {
    require(!step_in_flight_, "native_clear must run outside a step");
    if (native_ != nullptr) {
      // Recorded before clear() can throw: a refused clearStress still leaves
      // released actors behind, so the step is needed just as much.
      native_cleared_at_step_ = completed_steps_;
      native_->clear();
    }
  }
  bool native_configured() const {
    return native_ != nullptr && native_->configured();
  }
  bool gpu_context_lost() const { return runtime_->context_lost(); }
#endif

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
#ifdef NVBLAST_ENABLE_CUDA_STRESS
  Nv::Blast::ExtStressPhysXGpuHostMirror *gpu_host_mirror_ = nullptr;
  std::vector<PxActor *> gpu_mirror_actors_;
  std::vector<PxRigidDynamic *> gpu_mirror_bodies_;
  Nv::Blast::ExtStressPhysXDirectGpuContactDrain *gpu_contact_drain_ = nullptr;
  std::vector<Nv::Blast::ExtStressPhysXDirectGpuContact> gpu_contacts_;
  std::vector<GpuContact> gpu_contact_reference_;
  std::vector<GpuContact> gpu_contact_legacy_reference_;
  std::uint64_t gpu_contact_wrench_checks_ = 0, gpu_contact_wrench_mismatches_ = 0;
  double gpu_contact_wrench_max_force_error_ = 0.0, gpu_contact_wrench_max_moment_error_ = 0.0;
  std::uint64_t gpu_contact_legacy_threshold_checks_ = 0, gpu_contact_legacy_threshold_mismatches_ = 0;
  std::uint32_t gpu_contact_legacy_max_ulp_ = 0;
  bool gpu_contact_ordered_ = false, gpu_contact_order_ambiguous_ = false;
  std::uint64_t gpu_contact_order_verify_checks_ = 0, gpu_contact_order_verify_mismatches_ = 0;
  double gpu_contact_order_verify_ms_ = 0.0;
  double gpu_contact_gpu_order_ms_ = 0.0;
  // Exact wall times for explicit Direct GPU observation, separate from fetch.
  double gpu_host_mirror_ms_ = 0.0, gpu_contact_copy_ms_ = 0.0;
  double gpu_contact_ownership_ms_ = 0.0, gpu_contact_validate_ms_ = 0.0;
  double gpu_contact_sort_ms_ = 0.0, gpu_contact_reduce_ms_ = 0.0;
  double gpu_contact_route_ms_ = 0.0;
  PxU32 gpu_contact_count_ = 0;
  Nv::Blast::ExtStressPhysXCompactContactOrder<GpuContact> gpu_compact_order_;
  Nv::Blast::ExtStressPhysXContactTable gpu_compact_impulses_, gpu_compact_previous_, gpu_compact_current_;
  double gpu_compact_verify_ms_ = 0.0;
  std::uint64_t gpu_compact_batches_ = 0, gpu_compact_verify_batches_ = 0;
  std::uint64_t gpu_compact_verify_records_ = 0, gpu_compact_verify_pairs_ = 0, gpu_compact_verify_mismatches_ = 0;
  struct GpuContactShape {
    PxShape *shape = nullptr;
    PxRigidActor *actor = nullptr;
    PxU32 actor_index = PX_INVALID_U32;
    float threshold = PX_MAX_F32;
  };
  std::vector<GpuContactShape> gpu_contact_shapes_;
  std::vector<PxActor *> gpu_contact_actors_;
  std::vector<PxShape *> gpu_shape_scratch_;
  std::unordered_set<std::uint64_t> gpu_previous_pairs_, gpu_current_pairs_;
  std::unordered_map<std::uint64_t, float> gpu_actor_pair_normal_impulses_;
#endif
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
  /// The last few SAMPLED measurements, so a report at any cadence sees a
  /// populated number. 16 samples is ~4 s at the default interval — long
  /// enough to be stable, short enough to still describe the current regime
  /// rather than averaging a cascade together with the settle after it.
  static constexpr std::size_t kSimWallRing = 16;
  float sim_wall_ring_[kSimWallRing] = {};
  float result_copy_ring_[kSimWallRing] = {};
  float callback_ring_[kSimWallRing] = {};
  float fetch_total_ring_[kSimWallRing] = {};
  /// Ring slot awaiting its fetch_total, or -1. The other three values are
  /// known before the fetch completes; this one is not.
  int pending_ring_slot_ = -1;
  std::size_t sim_wall_ring_head_ = 0;
  std::size_t sim_wall_ring_fill_ = 0;
  /// Ticks where the callback total exceeded the fetch that contains it —
  /// impossible unless the cycle counter is untrustworthy.
  std::uint64_t tsc_suspect_ticks_ = 0;
  // A0 sub-attribution of the callback cost, same sampling and x8 scaling.
  // extract = resize+extractContacts; queue = the per-point loop (accumulate
  // + queue_contact_at); pair_load = note_pair_load; wake = note_contact_pair
  // + the dynamic_mass virtual reads. Residual vs contact_callback_est_ms is
  // header decode + entity lookup + CSE resolve.
  double cb_extract_ms_ = 0.0;
  double cb_capture_ms_ = 0.0;
  double cb_queue_ms_ = 0.0;
  double cb_pair_load_ms_ = 0.0;
  double cb_wake_ms_ = 0.0;
  double cb_resolve_ms_ = 0.0;
  double cb_entity_ms_ = 0.0;
  double cb_events_ms_ = 0.0;
  /// The blocks that were previously only visible as cb_tick's remainder:
  /// the per-pair census and impulse histogram this file adds for
  /// diagnostics, and the contact_points_ resize.
  double cb_census_ms_ = 0.0;
  double cb_resize_ms_ = 0.0;
  /// Per-tick pair census, reset alongside the callback timers.
  static constexpr int kImpulseBuckets = 20;
  /// Deferred-contact capture (VIBE_PHYSX_DEFER_CONTACTS). Cleared every
  /// drain; capacity retained. The contact_events_ unbounded-growth episode
  /// is the cautionary tale for anything appended inside the callback.
  struct DeferredContactPair {
    PxActor *actor0;
    PxActor *actor1;
    PxShape *shape0;
    PxShape *shape1;
    std::uint32_t entity_a;
    std::uint32_t entity_b;
    std::uint32_t point_begin;
    PxU32 point_count;
    PxU32 reported_count;
    bool ev_persists;
    bool ev_found;
  };
#ifdef NVBLAST_ENABLE_CUDA_STRESS
  std::vector<DeferredContactPair> gpu_compact_reference_pairs_;
  std::vector<PxContactPairPoint> gpu_compact_reference_points_;
#endif
  std::vector<DeferredContactPair> deferred_pairs_;
  std::vector<PairPrecomputed> classify_scratch_;
  std::vector<physx::PxContactPairPoint> deferred_points_;
  std::uint64_t contact_drain_cycles_ = 0;
  std::uint32_t bondless_skipped_host_ = 0;
  std::uint64_t frozen_verify_checks_ = 0;
  std::uint64_t frozen_verify_mismatches_ = 0;
  std::uint64_t hoist_verify_drains_ = 0;
  std::uint64_t hoist_verify_checks_ = 0;
  std::uint64_t hoist_verify_mismatches_ = 0;
  void report_hoist_mismatch(bool predicted_skip, bool queued) {
    ++hoist_verify_mismatches_;
    if (hoist_verify_mismatches_ <= 5 ||
        (hoist_verify_mismatches_ % 100000) == 0) {
      std::fprintf(stderr,
                   "[hoist] MISMATCH #%llu predicted_skip=%d queueContact_"
                   "queued=%d  (checks so far %llu)\n",
                   static_cast<unsigned long long>(hoist_verify_mismatches_),
                   predicted_skip ? 1 : 0, queued ? 1 : 0,
                   static_cast<unsigned long long>(hoist_verify_checks_));
    }
  }
  void dump_hoist_verify() const {
    if (bondless_hoist_verify()) {
      std::fprintf(stderr, "[hoist] verify: checks=%llu mismatches=%llu\n",
                   static_cast<unsigned long long>(hoist_verify_checks_),
                   static_cast<unsigned long long>(hoist_verify_mismatches_));
    }
  }
  std::uint64_t contact_drain_records_ = 0;

  /// Longest SINGLE callback this tick, in cycles. See the sum/max comment.
  std::uint64_t contact_callback_max_cycles_ = 0;
  std::uint64_t cp_found_ = 0;
  std::uint64_t cp_persists_ = 0;
  std::uint64_t cp_other_ = 0;
  std::uint64_t cp_points_ = 0;
  std::uint64_t cp_supporter_relevant_ = 0;
  std::uint64_t cp_zero_impulse_ = 0;
  std::uint64_t cp_impulse_hist_[kImpulseBuckets] = {};
  std::uint64_t contact_callbacks_this_step_ = 0;
  float last_step_ms_ = 0.0f;
  float last_controller_ms_ = 0.0f;
  float last_simulate_ms_ = 0.0f;
  float last_fetch_ms_ = 0.0f;
  float last_gpu_wait_ms_ = 0.0f;
  float last_fetch_copy_ms_ = 0.0f;
  bool step_in_flight_ = false;
#ifdef VIBE_LAND_NATIVE_DESTRUCTION
  /// Completed-step count at the last `native_clear`, or `kNoNativeClear` when
  /// the stage has never been cleared. See `native_create_destructible`.
  static constexpr std::uint64_t kNoNativeClear = ~0ull;
  std::uint64_t native_cleared_at_step_ = kNoNativeClear;
#endif
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
#ifdef VIBE_LAND_NATIVE_DESTRUCTION
  /// PhysX's own destruction stage for this scene. Independent of
  /// `destruction_`: a binary can carry both and the runtime picks one, so the
  /// two backends can be compared inside a single process.
  std::unique_ptr<NativeDestruction> native_;
#endif
#ifdef VIBE_LAND_DESTRUCTION
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

void World::launch_dynamic_ball(const FfiLaunchedBallDesc &desc) {
  impl_->launch_dynamic_ball(desc);
}

void World::set_body_pose(std::uint32_t entity_id, const FfiPose &pose) {
  impl_->set_body_pose(entity_id, pose);
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

rust::Vec<FfiBondStressRow> World::bond_stress_rows(
    std::uint32_t structure_id) const {
  return impl_->bond_stress_rows(structure_id);
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

#ifdef VIBE_LAND_NATIVE_DESTRUCTION
void World::native_attach() { impl_->native_attach(); }

void World::native_create_destructible(
    std::uint32_t structure_id, const FfiPose &pose,
    rust::Slice<const FfiChunkNodeDesc> nodes,
    rust::Slice<const FfiChunkBondDesc> bonds,
    const FfiDestructibleSettings &settings, std::uint32_t collision_group,
    std::uint32_t collision_mask) {
  impl_->native_create_destructible(structure_id, pose, nodes, bonds, settings,
                                    collision_group, collision_mask);
}

FfiNativeConfigured World::native_configure(const FfiNativeConfig &config) {
  return impl_->native_configure(config);
}

FfiNativeStatus World::native_tick() { return impl_->native_tick(); }

FfiNativeStatus World::native_last_status() const {
  return impl_->native_last_status();
}

std::uint32_t World::native_fire_round(const FfiRoundDesc &desc) {
  return impl_->native_fire_round(desc);
}

FfiChunkAim World::native_chunk_aim(std::uint32_t structure_id,
                                    std::uint32_t node_index) const {
  return impl_->native().chunk_aim(structure_id, node_index);
}

FfiChunkRayHit World::native_raycast_chunk(FfiVec3 origin, FfiVec3 direction,
                                           float max_distance) const {
  return impl_->native().raycast_chunk(origin, direction, max_distance);
}

rust::Vec<FfiBrokenBondEvent> World::native_take_broken_bonds() {
  return impl_->native_take_broken_bonds();
}

rust::Vec<FfiChunkMigrationEvent> World::native_take_chunk_migrations() {
  return impl_->native_take_chunk_migrations();
}

rust::Vec<FfiIslandBodyEvent> World::native_take_island_events() {
  return impl_->native_take_island_events();
}

rust::Slice<const FfiChunkBodySnapshot> World::native_chunk_body_snapshots() const {
  return impl_->native_chunk_body_snapshots();
}

rust::Vec<FfiBondStressRow> World::native_bond_stress_rows(
    std::uint32_t structure_id) const {
  return impl_->native_bond_stress_rows(structure_id);
}

FfiDestructionStats World::native_stats() const { return impl_->native_stats(); }

bool World::native_validate_mappings() const {
  return impl_->native_validate_mappings();
}

void World::native_clear() { impl_->native_clear(); }
bool World::gpu_context_lost() const { return impl_->gpu_context_lost(); }

bool World::native_configured() const { return impl_->native_configured(); }

std::uint32_t native_entity_id(std::uint32_t structure_id,
                               std::uint32_t island_serial) {
  return NativeDestruction::entity_id(structure_id, island_serial);
}
#endif

std::uintptr_t World::scene_ptr() const { return impl_->scene_ptr(); }

std::uintptr_t World::physics_ptr() const { return impl_->physics_ptr(); }

std::unique_ptr<World> new_world(const FfiWorldConfig &config) {
  return std::make_unique<World>(config);
}

} // namespace vibe_land::physx_bridge
