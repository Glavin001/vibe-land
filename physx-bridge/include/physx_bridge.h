#pragma once

#include "rust/cxx.h"

#include <cstdint>
#include <memory>

namespace vibe_land::physx_bridge {

struct FfiVec3;
struct FfiWorldConfig;
struct FfiStaticBoxDesc;
struct FfiHeightfieldDesc;
struct FfiDynamicBoxDesc;
struct FfiDynamicSphereDesc;
struct FfiCapsulePlayerDesc;
struct FfiVehicleChassisDesc;
struct FfiRaycastRequest;
struct FfiRaycastHit;
struct FfiBodySnapshot;
struct FfiPlayerSnapshot;
struct FfiVehicleSnapshot;
struct FfiWorldStats;
struct FfiContactEvent;
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

class World final {
public:
  explicit World(const FfiWorldConfig &config);
  ~World();

  World(const World &) = delete;
  World &operator=(const World &) = delete;

  void add_static_box(const FfiStaticBoxDesc &desc);
  void add_heightfield(const FfiHeightfieldDesc &desc,
                       rust::Slice<const float> samples);
  void add_dynamic_box(const FfiDynamicBoxDesc &desc);
  void add_dynamic_sphere(const FfiDynamicSphereDesc &desc);
  void add_capsule_player(const FfiCapsulePlayerDesc &desc);
  void add_vehicle_chassis(const FfiVehicleChassisDesc &desc);
  void remove_actor(std::uint32_t entity_id);
  void set_user_id(std::uint32_t entity_id, std::uint32_t user_id);
  void apply_impulse(std::uint32_t entity_id, FfiVec3 impulse);
  void apply_impulse_at_point(std::uint32_t entity_id, FfiVec3 impulse,
                              FfiVec3 point);
  std::uint32_t wake_bodies_near(FfiVec3 center, float radius);
  void drive_vehicle(std::uint32_t entity_id, float throttle, float steer,
                     float brake);
  void move_player(std::uint32_t entity_id, FfiVec3 displacement,
                   float elapsed_time);
  void step();
  /// Dispatch the simulation without waiting; pair with end_step().
  void begin_step();
  /// Wait for and fetch the dispatched simulation's results.
  void end_step();

  FfiRaycastHit raycast(const FfiRaycastRequest &request) const;
  rust::Vec<FfiBodySnapshot> body_snapshots() const;
  rust::Vec<FfiPlayerSnapshot> player_snapshots() const;
  rust::Vec<FfiVehicleSnapshot> vehicle_snapshots() const;
  FfiWorldStats stats() const;
  rust::Vec<FfiContactEvent> take_contact_events();

  void create_destructible(std::uint32_t structure_id, const FfiPose &pose,
                           rust::Slice<const FfiChunkNodeDesc> nodes,
                           rust::Slice<const FfiChunkBondDesc> bonds,
                           const FfiDestructibleSettings &settings,
                           std::uint32_t collision_group,
                           std::uint32_t collision_mask);
  /// Release every destructible and its actors so the city can be rebuilt.
  void clear_destructibles();
  void destruction_tick(float dt, FfiVec3 gravity);
  void queue_chunk_damage(std::uint32_t structure_id, std::uint32_t chunk_id,
                          FfiVec3 impulse, FfiVec3 point);
  std::uint32_t apply_destruction_explosion(FfiVec3 center, float radius,
                                            float impulse_magnitude);
  std::uint32_t apply_destruction_blast(FfiVec3 center, FfiVec3 direction,
                                        float radius, float stress_impulse,
                                        float push_impulse);
  rust::Vec<FfiBrokenBondEvent> take_broken_bonds();
  rust::Vec<FfiChunkMigrationEvent> take_chunk_migrations();
  rust::Vec<FfiIslandBodyEvent> take_island_events();
  /// This tick's chunk body snapshots, borrowed from the destruction
  /// manager's persistent buffer. Valid until the next call.
  rust::Slice<const FfiChunkBodySnapshot> chunk_body_snapshots() const;
  void sleep_chunk_body(std::uint32_t entity_id);
  /// Retire settled debris from the solver by making it kinematic, and
  /// release it again. See DestructionManager::freeze_chunk_bodies.
  std::uint32_t freeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids);
  std::uint32_t unfreeze_chunk_bodies(rust::Slice<const std::uint32_t> entity_ids);
  /// Frozen bodies struck by dynamic debris since the last drain. See
  /// DestructionManager::note_contact_pair.
  rust::Vec<std::uint32_t> take_frozen_contact_wakes();
  /// Weight-bearing dependency updates (paired drains; consume together).
  rust::Vec<FfiSupportSet> take_support_sets();
  rust::Vec<FfiSupportRow> take_support_rows();
  FfiDestructionStats destruction_stats() const;
  bool validate_destruction_mappings() const;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

std::unique_ptr<World> new_world(const FfiWorldConfig &config);

} // namespace vibe_land::physx_bridge
