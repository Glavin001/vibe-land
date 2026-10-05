#pragma once

#include "rust/cxx.h"

#include <cstdint>
#include <memory>
#include <vector>

namespace physx {
class PxFilterData;
class PxShape;
class PxMaterial;
class PxPhysics;
class PxScene;
namespace native { class NativeVehicle; }
} // namespace physx

namespace vibe_land::physx_bridge {

struct FfiVec3;
struct FfiVehicleFracturePart;
struct FfiVehiclePartPose;
struct FfiVehicleDebug;
struct FfiStressSolveReport;
struct FfiPose;
struct FfiDestructibleSettings;
struct FfiChunkNodeDesc;
struct FfiChunkBondDesc;
struct FfiBrokenBondEvent;
struct FfiChunkMigrationEvent;
struct FfiIslandBodyEvent;
struct FfiChunkBodySnapshot;
struct FfiBondStressRow;
struct FfiDestructionStats;
struct FfiNativeConfig;
struct FfiNativeConfigured;
struct FfiNativeStatus;
struct FfiRoundDesc;
struct FfiChunkAim;
struct FfiChunkRayHit;
struct FfiHibernationConfig;
struct FfiHibernationStats;

/// Shape filter word3 bit marking a chunk owned by the native destruction
/// stage.
///
/// The stage consumes PhysX's own solved contact impulses on the GPU, so the
/// CPU contact callback has nothing to do for these pairs. The filter shader
/// drops their notification flags, which removes the whole `onContact` cost for
/// the city while players, vehicles and projectiles keep their reports.
inline constexpr std::uint32_t kNativeChunkFilterBit = 1u << 31;

/// Drives PhysX's built-in GPU destruction stage for one `PxScene`.
///
/// The division of labour is the point of this class. It authors the asset
/// (chunk shapes, bond graph, materials), hands it to `configureStress` once,
/// and afterwards only *observes*: the stress solve, material verdict,
/// connectivity split, fragment body creation and the one corrected re-solve
/// all happen inside `PxScene::simulate()`. There is no per-tick solve to
/// drive, no fracture command to apply and no replay to orchestrate.
///
/// Deliberately a separate type from `DestructionManager` rather than a
/// same-named replacement. The two model destruction differently -- notably,
/// this one has no external force injection, no artificial freezing and no
/// application-side resimulation -- and an earlier attempt that swapped a
/// same-named class behind an `#ifdef` left ten methods as silent no-op stubs
/// that every caller kept calling. Here an unsupported operation is absent at
/// compile time or throws, never quietly does nothing.
class NativeDestruction final {
public:
  NativeDestruction(physx::PxPhysics &physics, physx::PxScene &scene,
                    physx::PxMaterial &material);
  ~NativeDestruction();

  NativeDestruction(const NativeDestruction &) = delete;
  NativeDestruction &operator=(const NativeDestruction &) = delete;

  /// Author one structure. Must run before `configure`; the stage's topology is
  /// immutable once configured, so a changed city is a `clear` and a rebuild.
  void create_destructible(std::uint32_t structure_id, const FfiPose &pose,
                           rust::Slice<const FfiChunkNodeDesc> nodes,
                           rust::Slice<const FfiChunkBondDesc> bonds,
                           const FfiDestructibleSettings &settings,
                           std::uint32_t collision_group,
                           std::uint32_t collision_mask);

  void register_vehicle(physx::native::NativeVehicle &vehicle, std::uint32_t structure_id,
      rust::Slice<const FfiVehicleFracturePart> parts, rust::Slice<const FfiChunkBondDesc> bonds,
      const FfiDestructibleSettings &settings);

  /// Move the carrier's hulls of the given parts to delta * authored pose
  /// (actor frame), optionally excluding `exclude_mask` from their contacts.
  /// Stress geometry and mass stay at rest. Call between steps.
  std::uint32_t pose_vehicle_parts(physx::native::NativeVehicle &vehicle,
      rust::Slice<const FfiVehiclePartPose> poses, std::uint32_t exclude_mask);
  /// World transforms, from each part's authored actor-frame pose, of the
  /// parts whose hulls have left the vehicle's carrier (detached fragments).
  rust::Vec<FfiVehiclePartPose> detached_vehicle_parts(const physx::native::NativeVehicle &vehicle) const;
  /// Debug readback: every hull's world pose, owner and filter; owners' mass frames.
  FfiVehicleDebug vehicle_debug(const physx::native::NativeVehicle &vehicle) const;
  /// Refresh functional state from accepted shape owners, before Vehicle2 runs.
  void prepare_vehicles();
  /// Give hulls that left a vehicle carrier their authored filter back.
  void restore_detached_hull_filters();
  /// Set a hull's filter and re-filter the pairs it already has.
  void refilter(physx::PxShape &shape, const physx::PxFilterData &filter);
  /// Submit the measured commands after Vehicle2 runs and before simulate.
  void submit_vehicle_loads(float dt);
  bool owns_vehicle(const physx::native::NativeVehicle *vehicle) const;

  /// Hand the authored asset to the stage. The caller must have stepped the
  /// scene once already: shape and body GPU identities do not exist until a
  /// completed simulate/fetchResults, and they are what the descriptor binds.
  FfiNativeConfigured configure(const FfiNativeConfig &config);
  /// Physical angular xyz / linear xyz per authored bond. Initial guesses only.
  rust::String warm_runtime_path();
  rust::Vec<float> export_warm_start();
  void import_warm_start(rust::Slice<const float> values);

  /// Observe the step that just completed. Idempotent within a frame.
  ///
  /// Never advances anything: by the time this runs the engine has already
  /// solved, fractured and corrected. A step the engine reports as incomplete
  /// is not observed at all -- publishing a rejected step as gameplay state is
  /// how a client ends up drawing a world the server never simulated.
  FfiNativeStatus tick();

  /// The stage's current status, read live and consuming nothing.
  ///
  /// `tick` only reports a status for a step it was able to observe, so after a
  /// rejected step there is nothing cached to explain the rejection. This is
  /// how a caller finds out *why* a step failed.
  FfiNativeStatus last_status() const;

  /// Spawn one physical round carrying a shot's momentum.
  ///
  /// The stage takes loads only from PhysX's own solved contacts, so a hitscan
  /// round becomes a real body for the few ticks it takes to strike. Returns
  /// the number of rounds currently live.
  std::uint32_t fire_round(const FfiRoundDesc &desc);

  /// Where a named chunk is now, and which body owns it.
  FfiChunkAim chunk_aim(std::uint32_t structure_id,
                        std::uint32_t node_index) const;

  /// Raycast restricted to stage-owned chunks, reporting WHICH chunk was hit.
  /// The ordinary raycast reports the owning body, which cannot distinguish
  /// the chunk aimed at from its neighbour in the same fragment.
  FfiChunkRayHit raycast_chunk(const FfiVec3 &origin, const FfiVec3 &direction,
                               float max_distance) const;

  rust::Vec<FfiBrokenBondEvent> take_broken_bonds();
  rust::Vec<FfiChunkMigrationEvent> take_chunk_migrations();
  rust::Vec<FfiIslandBodyEvent> take_island_events();
  /// Per-tick body rows as a slice into a persistent buffer, valid until the
  /// next tick.
  rust::Slice<const FfiChunkBodySnapshot> chunk_body_snapshots() const;
  rust::Vec<FfiBondStressRow> bond_stress_rows(std::uint32_t structure_id) const;
  bool set_stress_solve_report(std::uint32_t passes);
  FfiStressSolveReport stress_solve_report();
  FfiDestructionStats stats() const;

  // --- debris hibernation (native_hibernation.cc) ---------------------------
  /// A body that may disturb frozen debris this step, other than the stage's
  /// own fragments and rounds (which the stage knows): its world AABB, its
  /// velocity and its mass. `always` thaws whatever it is about to touch
  /// regardless of speed: a vehicle being driven against rubble.
  struct HibernationMover {
    float min[3], max[3], velocity[3];
    float mass;
    bool always;
  };
  /// Opt in or out at runtime; the server's default comes from
  /// VIBE_CITY_NATIVE_HIBERNATE. Turning it off thaws every frozen body.
  void set_hibernation(const FfiHibernationConfig &config);
  FfiHibernationStats hibernation_stats() const;
  /// Entity ids of the bodies currently frozen.
  rust::Vec<std::uint32_t> frozen_entities() const;
  /// Freeze (or thaw) the named bodies now, bypassing the rest test: for tests
  /// and tools. Returns how many changed; ineligible ids are skipped.
  std::uint32_t set_entities_hibernated(rust::Slice<const std::uint32_t> entities,
                                        bool hibernated);
  /// Whether anything is frozen, so the world can skip gathering movers.
  bool has_frozen_debris() const;
  /// Before simulate: thaw the frozen debris that this step's movers, the
  /// stage's own awake fragments and its rounds are about to disturb.
  void thaw_for_movers(const std::vector<HibernationMover> &movers, float dt);
  /// Thaw frozen debris inside a sphere, before a shot or blast acts there.
  std::uint32_t thaw_near(const FfiVec3 &center, float radius);

  /// Whole-world GPU/CPU ownership audit. Reads arrays that normal publication
  /// never touches, so it belongs in tests and explicit gates, never in a
  /// timed tick.
  bool validate_mappings() const;

  /// Release the stage's topology and every actor this class created, leaving
  /// it ready to author a fresh city. The scene owns fragment bodies and
  /// `clearStress` destroys them, so ordering here is not optional.
  void clear();

  bool configured() const;

  /// Network entity id for a body, mirroring `destruction/src/ids.rs`.
  static std::uint32_t entity_id(std::uint32_t structure_id,
                                 std::uint32_t island_serial);

  struct State;

private:
  std::unique_ptr<State> state_;
};

} // namespace vibe_land::physx_bridge
