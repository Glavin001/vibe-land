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
#include <unordered_set>
#include <vector>

namespace physx {
class PxActor;
class PxAggregate;
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
struct FfiSupportSet;
struct FfiSupportRow;
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

  /// Release every destructible and its PhysX actors, returning the manager to
  /// its just-constructed state. The city is then rebuilt by re-issuing
  /// create_destructible, which is the only way to get an undamaged city
  /// without restarting the process.
  void clear_destructibles();

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
  /// Opaque to callers: they receive a ContactTarget from
  /// resolve_contact_target and hand it straight back to queue_contact_at.
  struct Slot;

  /// A contact's destination, resolved once per shape per manifold.
  ///
  /// Every point in a PhysX manifold belongs to the same pair of shapes, so
  /// resolving the owner per POINT -- which is what route_contact_shape does --
  /// repeats a hash lookup and a linear slot scan for every point after the
  /// first. Measured 2.06-3.64 points per manifold on downtown, so most of
  /// that work was redundant.
  struct ContactTarget {
    Slot *slot = nullptr;
    physx::PxShape *shape = nullptr;
    /// Owner coordinates from the same shape_owners_ hit that produced slot.
    /// Carried so note_pair_load can skip re-running the identical lookup
    /// chain (hash + linear slot scan) for a shape this manifold already
    /// resolved. Only meaningful when slot != nullptr.
    std::uint32_t structure_id = 0;
    std::uint32_t node_index = 0;
    /// Blast's own node for this shape (nodeForShape), resolved once here so
    /// queue_contact_at skips the per-POINT m_shapeToNode hash inside
    /// queueContact. Deliberately NOT node_index above: that is the manager's
    /// registration-time mapping, this is the adapter's live one — they agree
    /// except possibly mid-fracture, and the adapter's answer is the one the
    /// per-point lookup would have produced. UINT32_MAX falls back to the
    /// original in-queue resolution, bit-for-bit.
    std::uint32_t blast_node = 0xFFFFFFFFu;
    explicit operator bool() const { return slot != nullptr; }
  };
  ContactTarget resolve_contact_target(physx::PxShape *shape);
  void queue_contact_at(const ContactTarget &target, FfiVec3 position,
                        FfiVec3 impulse, bool wake);

  void route_contact_shape(physx::PxShape *shape, FfiVec3 position,
                           FfiVec3 impulse, bool wake);

  rust::Vec<FfiBrokenBondEvent> take_broken_bonds();
  rust::Vec<FfiChunkMigrationEvent> take_chunk_migrations();
  rust::Vec<FfiIslandBodyEvent> take_island_events();
  /// Per-tick body snapshots as a slice into a persistent buffer.
  ///
  /// Returned by reference rather than by value: at 10k bodies the old
  /// rust::Vec return copied ~760 KB out of C++ and the Rust side copied it
  /// again into its own Vec, twice per tick, for data that is regenerated
  /// every tick anyway. The buffer lives here and is refilled in place.
  /// Valid until the next call.
  rust::Slice<const FfiChunkBodySnapshot> chunk_body_snapshots() const;

  void sleep_chunk_body(std::uint32_t entity_id);

  /// Take settled debris out of the rigid-body solver by making it kinematic,
  /// and put it back.
  ///
  /// PhysX sleeps per contact island, so a merged rubble field can only sleep
  /// as a whole and any one member waking wakes all of it -- measured as one
  /// rifle round waking 6,065 bodies. A kinematic body generates no contact
  /// pairs against other kinematic or static geometry, so an all-kinematic
  /// pile has no island to wake and no contacts to converge, while dynamic
  /// debris and the player controller still collide with it.
  ///
  /// The actor and its island serial survive the round trip, which is what
  /// lets the network layer treat a freeze as the settle it already handles.
  /// Bodies are addressed by packed entity id; unknown ids and the structure's
  /// kinematic support actor are skipped rather than erroring, because the
  /// caller's view of what is live is one tick old by construction.
  /// Returns how many bodies actually changed state.
  std::uint32_t freeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids);
  std::uint32_t unfreeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids);

  /// A reported contact pair, resolved to stable identities at capture time.
  ///
  /// Resolution happens in the scene callback, not later: the adapter's
  /// endTick can release shapes on the same tick, so a stored PxShape* would
  /// dangle by resolve time. What is stored is pure data about the bodies
  /// the contact ACTUALLY happened between (the pre-fracture configuration,
  /// which is the physically correct one -- the impulse was exchanged with
  /// that body).
  struct PendingPairSide {
    bool is_chunk = false;
    /// Non-chunk side: static world geometry (immutable) or a foreign
    /// movable (player, vehicle, prop) that can never be a valid supporter.
    bool is_static = false;
    std::uint32_t structure_id = 0;
    std::uint32_t node_index = 0;
    std::uint64_t body_id = 0;
  };
  struct PendingPairLoad {
    PendingPairSide a;
    PendingPairSide b;
    /// Sum of |impulse.y| over the pair's contact points this step, N*s.
    /// The absolute value is deliberate: the reported sign is
    /// ordering-dependent (eINTERNAL_CONTACTS_ARE_FLIPPED, uncorrected by
    /// extractContacts) and must never be read.
    float sum_abs_impulse_y = 0.0f;
    /// Most negative contact separation this step, metres. Deep negative =
    /// the pair is interpenetrating -- freezing either side would bake the
    /// overlap into an immovable anchor and turn its neighbour into a
    /// depenetration pump.
    float min_separation = 0.0f;
  };

  /// Record one reported pair's vertical contact load. Called from onContact.
  void note_pair_load(const physx::PxShape *shape_a, const physx::PxShape *shape_b,
                      const physx::PxActor *actor_a, const physx::PxActor *actor_b,
                      float sum_abs_impulse_y, float min_separation);
  /// Same record, but reusing the manifold's already-resolved ContactTargets
  /// so the chunk side skips shape_owners_.find + find_slot. A null target
  /// falls back to the full per-shape resolution — resolve_contact_target
  /// returns null in strictly more cases than "not a chunk" (e.g. a slot
  /// whose destructible is gone), and those cases must keep their original
  /// classification. Outcome-identical to the overload above by construction.
  void note_pair_load(const ContactTarget &target_a, const ContactTarget &target_b,
                      const physx::PxShape *shape_a, const physx::PxShape *shape_b,
                      const physx::PxActor *actor_a, const physx::PxActor *actor_b,
                      float sum_abs_impulse_y, float min_separation);
  /// Latch "this chunk body has touched static geometry" for the settle
  /// assist. Called from both note_pair_load entries once both sides are
  /// resolved; a no-op unless exactly one side is a chunk and the other is
  /// static world geometry.
  void note_ground_touch(const PendingPairLoad &load);

  /// Support-set drains: one FfiSupportSet per dependent whose supporter set
  /// changed this tick, indexing into the rows drain. Both are cleared
  /// together; callers must consume them as a pair.
  rust::Vec<FfiSupportSet> take_support_sets();
  rust::Vec<FfiSupportRow> take_support_rows();

  /// A reported contact touched these two entities with this total impulse.
  /// Called from the scene's onContact for every reported chunk pair; decides
  /// whether a FROZEN participant should be released to respond.
  ///
  /// This is the mechanism that keeps frozen rubble physically honest: PhysX
  /// wakes a sleeping body struck by a moving one, but a kinematic body has
  /// no sleep state to wake, so without this a collapse rains onto frozen
  /// rubble as though it were bedrock -- immovable anchors mid-pile, and the
  /// collapse visibly "hits itself". The measured prohibition on contact
  /// wakes (route_contact_shape's wake=false) is about SLEEPING DYNAMIC
  /// bodies, where one wake re-opens the whole contact island; a frozen body
  /// is kinematic, belongs to no island, and waking it wakes exactly one
  /// body, so the cascade that killed that idea cannot happen here.
  ///
  /// Masses are the dynamic participants' (< 0 when a side is not a dynamic
  /// body); the threshold is a RATIO against the striker's resting load
  /// (m*g*dt), so it self-normalises across chunk masses: debris resting on
  /// a frozen pile scores ~1 and never wakes it, an impact at >~0.7 m/s
  /// scores past the default ratio of 4 and releases the chunk it hit.
  void note_contact_pair(std::uint32_t entity_a, std::uint32_t entity_b,
                         float mass_a, float mass_b, float impulse);

  /// Frozen bodies contact-struck since the last drain, deduplicated.
  rust::Vec<std::uint32_t> take_frozen_contact_wakes();

  /// Whether contact reports need to consult the frozen set at all; lets the
  /// scene callback skip the lookup on the hot path when nothing is frozen.
  bool has_frozen_bodies() const { return !frozen_entities_.empty(); }

  FfiDestructionStats destruction_stats() const;
  bool validate_destruction_mappings() const;

  /// Fracture-frame resimulation (Blast engine contract 2.8).
  ///
  /// Without it, a tower striking another resolves the contact against the
  /// INTACT rigid body: the split happens afterwards, so the fragments are
  /// placed into a world where the impact has already finished and they never
  /// experience it. Capture before simulate; if the tick fractured, restore
  /// motion and re-run the step so contacts resolve against the pieces.
  ///
  /// Restore rewinds motion state ONLY -- topology, masses, shapes and
  /// kinematic flags survive. Both calls require the destructible to be in its
  /// Idle tick phase and must run outside simulate/fetchResults.
  /// Cumulative island splits across all slots. The resim protocol keys off
  /// this: a tick fractured iff splits increased across it.
  std::uint64_t split_count() const;
  bool resim_needed() const;
  std::uint32_t resim_capture();
  bool resim_restore();

private:
  Slot *find_slot(std::uint32_t structure_id);
  const Slot *find_slot(std::uint32_t structure_id) const;
  /// Full per-shape resolution for one side of a pair load — the shared body
  /// of both note_pair_load entries; the resolved-target overload calls it
  /// only for sides without a usable ContactTarget.
  PendingPairSide resolve_pair_side(const physx::PxShape *shape,
                                    const physx::PxActor *actor);
  /// Shared body of freeze_chunk_bodies / unfreeze_chunk_bodies.
  std::uint32_t set_chunk_bodies_kinematic(rust::Slice<const std::uint32_t> entity_ids,
                                           bool kinematic);
  void register_filters(Slot &slot);
  /// Single GPU->CPU readback of body and shape state for one structure.
  void refresh_snapshots(Slot &slot) const;
  /// Shape snapshots: only needed on ticks where topology changed.
  void refresh_shape_snapshots(Slot &slot) const;
  void collect_events(Slot &slot);
  /// Allocates the next island serial for a structure, reporting exhaustion of
  /// the 16-bit space rather than silently aliasing live bodies.
  std::uint32_t next_serial(Slot &slot);

  physx::PxPhysics &physics_;
  physx::PxScene &scene_;
  physx::PxMaterial &material_;
  float contact_report_threshold_;
  /// Whether chunk bodies report contacts at all (VIBE_CITY_CHUNK_CONTACT_REPORTS).
  bool chunk_contact_reports_ =
      std::getenv("VIBE_CITY_CHUNK_CONTACT_REPORTS") == nullptr
      || std::string(std::getenv("VIBE_CITY_CHUNK_CONTACT_REPORTS")) != "0";

  /// P1b: spatial-cell PxAggregates holding FROZEN bodies, one broadphase
  /// entry per cluster instead of one per body. Members remain real actors
  /// with real shapes — contacts against dynamics, the contact-wake release
  /// path, and geometry are unchanged; self-collision is off because members
  /// are kinematic and mutually at rest, so PhysX generated no pairs among
  /// them anyway. Occupancy is read live from PxAggregate (a body released
  /// by the adapter while frozen leaves its aggregate automatically); only
  /// the per-aggregate shape tally is shadowed, and compaction recomputes it.
  void frozen_aggregate_insert(physx::PxRigidDynamic &body);
  void frozen_aggregate_extract(physx::PxRigidDynamic &body);
  physx::PxAggregate *frozen_aggregate_for(float x, float z, std::uint32_t shapes);
  void frozen_aggregate_maybe_retire(physx::PxAggregate *aggregate);
  void frozen_aggregates_release_all();

  std::unordered_map<std::uint64_t, std::vector<physx::PxAggregate *>>
      frozen_agg_cells_;
  std::unordered_map<physx::PxAggregate *, std::uint32_t> frozen_agg_shapes_;
  /// Empty aggregates parked for reuse; freeze churn is hundreds of flips a
  /// second at the pile margins and create/release would thrash the GPU BP.
  std::vector<physx::PxAggregate *> frozen_agg_pool_;
  std::uint64_t frozen_agg_inserts_ = 0;
  std::uint64_t frozen_agg_extracts_ = 0;
  std::uint64_t frozen_agg_retired_ = 0;
  std::uint64_t frozen_agg_fallbacks_ = 0;

  /// Generic named-span channel (see FfiNamedSpan in lib.rs): a new metric is
  /// ONE span_add call — no header/struct/copy plumbing. Cleared at tick
  /// entry; drained by destruction_stats(). kind: 0 wall ms, 1 slot-summed
  /// ms, 2 count. Same-name adds within a tick accumulate.
  void span_add(const char *name, double value, std::uint8_t kind);
  std::vector<std::pair<const char *, std::pair<double, std::uint8_t>>>
      extra_spans_;

  std::vector<std::unique_ptr<Slot>> slots_;
  std::unique_ptr<StressExecutor> stress_executor_;
  /// Live structures for the current tick; a member so the per-tick gather
  /// does not reallocate, and so the parallel phase can index it.
  std::vector<Slot *> live_slots_;
  std::unordered_map<const physx::PxShape *, std::pair<std::uint32_t, std::uint32_t>>
      shape_owners_; // shape -> (structure_id, node_index)

  /// Last entity id stamped onto each body / shape. Re-stamping identical
  /// data wakes a sleeping PhysX actor, so only changes are written.
  /// Keyed by (structure_id, bodyId), never by PxRigidDynamic*.
  ///
  /// The adapter recycles actors, so a pointer can outlive the body it
  /// belonged to and come back pointing at a different one -- the same hazard
  /// the `frozen` set documents. Pointer-keyed, a recycled address inherited
  /// the dead body's entity stamp, and the "identity unchanged" test below
  /// then skipped tag_actor() for a body that had never been tagged.
  std::unordered_map<std::uint64_t, std::uint32_t> body_entity_stamp_;
  std::unordered_map<const physx::PxShape *, std::uint32_t> shape_entity_stamp_;

  /// Bond-utilisation sampling cadence. The scan walks every bond of every
  /// structure, so it runs on a cadence rather than per tick; the two numbers
  /// it produces are published once a second.
  std::uint32_t bond_sample_interval_ = 30;
  std::uint32_t bond_sample_counter_ = 0;
  /// Slot-ticks where topology was unchanged and the event diff was skipped.
  std::uint64_t quiet_slot_ticks_ = 0;
  /// Running totals of the per-tick island partition, so a rate can be had by
  /// differencing two samples. `solver_islands_skipped` is a GAUGE of the last
  /// tick and a bond break zeroes it by design, so it reads 0 through an entire
  /// demolition even while skipping works -- it cannot judge anything on its
  /// own. These accumulate every tick instead of being sampled at publish.
  std::uint64_t solver_islands_skipped_accum_ = 0;
  std::uint64_t solver_islands_total_accum_ = 0;
  std::uint64_t serial_wraps_ = 0;
  /// Wake requests exceeding a slot's wake buffer. Non-zero means a contacted
  /// sleeping body was left asleep for a tick.
  std::uint64_t wake_truncations_ = 0;
  /// Backing store for chunk_body_snapshots(); reused across ticks.
  mutable std::vector<FfiChunkBodySnapshot> body_snapshot_buffer_;
  /// Entity-claim map for the same call's aliasing check. A member, not a
  /// local: it is sized by live body count and the call runs twice per tick,
  /// so building it fresh meant two whole-population hash maps allocated and
  /// destroyed every tick purely to assert an invariant.
  /// (structure_id, bodyId) per entity; bodyId is ExtStressPhysXId, spelled as
  /// uint64_t because this header does not pull in the Blast extension.
  mutable std::unordered_map<std::uint32_t,
                             std::pair<std::uint32_t, std::uint64_t>>
      emitted_entities_;
  /// Bodies with speculative CCD enabled. Applied once per body, outside the
  /// event diff, so a body that turns dynamic on a quiet tick cannot miss it.
  /// Keyed by (structure_id, bodyId), never by PxRigidDynamic*. Same recycling
  /// hazard as body_entity_stamp_, and a worse failure: pointer-keyed, a
  /// recycled address made insert().second false, so the NEW body silently
  /// never received eENABLE_SPECULATIVE_CCD or its depenetration cap -- exactly
  /// the tunnelling this block exists to prevent. Erased on retire.
  std::unordered_set<std::uint64_t> ccd_enabled_;
  /// Chunk bodies that have touched STATIC world geometry at least once.
  ///
  /// The settle assist (VIBE_CITY_SETTLE_ASSIST) is gated on this, and the
  /// gate is the whole safety argument: raising a body's sleep threshold is
  /// what once froze ballistic debris at the apex of its arc (see
  /// kChunkSleepThreshold), and a body still in flight has never touched the
  /// ground, so it can never be assisted. Latched in note_pair_load, which
  /// runs inside fetchResults and may only touch host state.
  /// Keyed by (structure_id, bodyId) and erased on retire, for the same
  /// recycling reason as ccd_enabled_.
  std::unordered_set<std::uint64_t> ground_touched_;
  /// Bodies whose damping and sleep threshold have already been raised.
  /// insert().second is the write-once test: rewriting a rigid-body property
  /// wakes a sleeping actor, so the assist must never be re-applied.
  std::unordered_set<std::uint64_t> settle_assisted_;
  std::uint64_t ground_touch_latches_ = 0;
  std::uint64_t settle_assist_applied_ = 0;
  /// Times getBodySnapshots returned one bodyId more than once in a tick.
  /// Mutable because refresh_snapshots is const; this is pure observation.
  mutable std::uint64_t repeated_body_snapshots_ = 0;
  /// Times two distinct bodies produced the same body entity in one tick.
  mutable std::uint64_t aliased_body_entities_ = 0;
  /// Bodies re-issued a serial after going kinematic -> dynamic.
  std::uint64_t support_promotions_ = 0;
  /// Tripwires for the freeze path. A frozen body is kinematic, which is also
  /// how the adapter marks a structure's support actor, so every place that
  /// keys off `kinematic` is a chance to mistake settled rubble for a support
  /// body and re-issue its island serial -- which would present as the body
  /// being retired and re-promoted on the wire, losing its chunks. These must
  /// stay zero; they are asserted in the freeze tests.
  std::uint64_t frozen_serial_blocks_ = 0;
  /// Frozen bodies the adapter set dynamic again on its own (they split under
  /// load). Expected and handled, but the rate is worth watching.
  std::uint64_t frozen_adapter_releases_ = 0;
  std::uint64_t freeze_flips_ = 0;
  std::uint64_t unfreeze_flips_ = 0;
  /// Freeze/unfreeze calls that named a ROOTED body and were refused.
  /// Releasing a stump would drop a standing building; must stay zero.
  std::uint64_t rooted_guard_blocks_ = 0;
  /// Re-sleep WRITES issued after a kinematic flip woke the flipped body's
  /// contact island as collateral. Counts writes, not confirmed wakes: the
  /// woken set is not observable on the host until the next fetchResults, so
  /// the repair writes to every body the engine had asleep before the batch.
  /// See `freeze_island_resleep` in destruction.cc.
  std::uint64_t island_resleep_writes_ = 0;

  /// The weight-bearing dependency store: who is holding each body up,
  /// according to the engine's own contact reports.
  ///
  /// kind: 0 = World (static geometry -- immutable, needs no events),
  ///       1 = Foreign (player/vehicle/prop -- movable and NOT event-
  ///           observable, so it blocks freezing),
  ///       2 = Rooted (a stump, named by its real serial + supporting node),
  ///       3 = ChunkBody (another debris body, frozen or dynamic).
  struct SupporterRec {
    std::uint8_t kind = 0;
    std::uint32_t entity = 0; // packed body entity for kinds 2/3
    std::uint32_t node = 0xffff'ffff; // supporting node for kind 2
    std::uint64_t last_tick = 0;
  };
  struct DependentEntry {
    std::uint32_t entity = 0;
    std::uint64_t last_report_tick = 0;
    /// Most negative separation across this body's contacts, last report.
    float min_separation = 0.0f;
    bool dirty = false;
    std::vector<SupporterRec> supporters;
  };
  /// Keyed by (structure_id << 48) | bodyId. bodyIds are per-structure
  /// monotone counters, far below 2^48.
  std::unordered_map<std::uint64_t, DependentEntry> support_store_;
  static std::uint64_t support_key(std::uint32_t structure_id, std::uint64_t body_id) {
    return (static_cast<std::uint64_t>(structure_id) << 48) |
           (body_id & 0x0000'ffff'ffff'ffffULL);
  }
  std::vector<PendingPairLoad> pending_pair_loads_;
  /// Dependents whose supporter set changed, staged for the paired drains.
  std::vector<FfiSupportSet> staged_support_sets_;
  std::vector<FfiSupportRow> staged_support_rows_;
  std::uint64_t tick_count_ = 0;
  std::uint64_t support_edges_total_ = 0;
  /// Resolve pending pair loads into the store; runs once per
  /// destruction_tick after serials are current.
  void resolve_support_loads();
  /// Frozen bodies released because dynamic debris struck them. The count
  /// says whether piles are responding to collapses (healthy, proportional)
  /// or being sanded awake by resting contacts (a ratio mis-tune).
  std::uint64_t contact_wakes_ = 0;
  /// Entity ids of every currently frozen body, for the contact hot path:
  /// onContact fires per reported pair per tick and cannot afford the
  /// slot walk. Kept in lockstep with each Slot::frozen everywhere that set
  /// changes.
  std::unordered_set<std::uint32_t> frozen_entities_;
  /// Contact-struck frozen bodies awaiting the per-tick drain (deduped).
  std::unordered_set<std::uint32_t> contact_wake_pending_;
  /// Per-tick accumulated contact impulse and heaviest striker per frozen
  /// body; judged once per tick in resolve_frozen_contact_wakes().
  std::unordered_map<std::uint32_t, float> contact_tick_load_;
  std::unordered_map<std::uint32_t, float> contact_tick_striker_;
  void resolve_frozen_contact_wakes();
  /// Steady contact load each frozen body bears, per entity.
  ///
  /// A buried chunk carries the accumulated weight of the pile above it, which
  /// is large but *constant*. An impact is a transient spike. Comparing against
  /// a single striker's weight cannot tell those apart; comparing against what
  /// this body has actually been bearing can.
  std::unordered_map<std::uint32_t, float> contact_load_baseline_;
  std::vector<std::uint32_t> contact_wake_order_;
  /// Fixed step from the last destruction_tick, for the resting-load ratio.
  float last_dt_ = 1.0f / 60.0f;
  /// Promotions whose body reuses the parent actor, so its centre of mass is a
  /// local offset rather than its origin.
  std::uint64_t reused_parent_promotions_ = 0;
  std::uint32_t max_island_serial_ = 0;

  std::vector<FfiBrokenBondEvent> broken_bonds_;
  std::vector<FfiChunkMigrationEvent> migrations_;
  std::vector<FfiIslandBodyEvent> island_events_;

  std::uint32_t total_broken_bonds_ = 0;
  float last_stress_solve_ms_ = 0.0f;
  /// Native tick wall time minus every phase that claims part of it.
  float last_stress_solve_residual_ms_ = 0.0f;
  /// Per-phase breakdown of destruction_tick.
  /// beginTick (contact/gravity injection) across all structures. Parallel
  /// over slots by default (VIBE_CITY_SNAPSHOT_BEGIN); only the wakeUp apply
  /// inside it is serial.
  float last_begin_ms_ = 0.0f;
  /// Parallel/CUDA solveTick only.
  float last_solve_ms_ = 0.0f;
  /// Serial endTick (fracture + PhysX actor edits) across all structures.
  float last_end_ms_ = 0.0f;
  float last_readback_ms_ = 0.0f;
  float last_events_ms_ = 0.0f;
  float last_filters_ms_ = 0.0f;
  /// The three phases that used to sit inside the stress_solve_ms bracket
  /// with no timer of their own, and so appeared only as the gap between the
  /// native tick and the sum of its parts. Two of them are O(live bodies)
  /// EVERY tick, including quiet ticks, which is why the gap was present at
  /// idle too.
  /// Per-body CCD/depenetration application walk.
  float last_ccd_ms_ = 0.0f;
  /// resolve_support_loads(): contact loads -> supporter edges.
  float last_support_loads_ms_ = 0.0f;
  /// Contact pairs that resolve fed on. This is what support_loads_ms tracks
  /// -- comparing the ms alone across runs is meaningless, because damage (and
  /// therefore contact count) is not reproducible run to run.
  std::uint32_t last_support_pair_loads_ = 0;
  /// refresh_shape_snapshots() on topology-changed slots.
  float last_shape_readback_ms_ = 0.0f;
  /// The live-slot gather plus the per-slot telemetry read and topology
  /// compare -- the "per-slot dispatch" the field docs blamed the gap on.
  float last_slot_dispatch_ms_ = 0.0f;
  /// The 1-in-30 bond-utilisation scan. Zero on the other 29 ticks; a full
  /// walk of every bond of every structure on the 30th, so it is a periodic
  /// spike rather than a steady cost and must not be averaged away.
  float last_bond_sample_ms_ = 0.0f;
  /// Worst bond utilisation (stress / that bond's own elastic limit) seen in
  /// the last solve, and how many bonds sat at half their limit or above.
  float last_bond_utilisation_max_ = 0.0f;
  std::uint32_t last_bonds_above_half_utilisation_ = 0;
  /// Dynamic bodies dropped from snapshots because they had no island serial.
  /// Non-zero means the serial tables and the adapter's live bodies disagree.
  mutable std::uint32_t unmapped_body_skips_ = 0;
};

} // namespace vibe_land::physx_bridge
