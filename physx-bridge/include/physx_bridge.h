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

  FfiRaycastHit raycast(const FfiRaycastRequest &request) const;
  rust::Vec<FfiBodySnapshot> body_snapshots() const;
  rust::Vec<FfiPlayerSnapshot> player_snapshots() const;
  rust::Vec<FfiVehicleSnapshot> vehicle_snapshots() const;
  FfiWorldStats stats() const;
  rust::Vec<FfiContactEvent> take_contact_events();

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

std::unique_ptr<World> new_world(const FfiWorldConfig &config);

} // namespace vibe_land::physx_bridge
