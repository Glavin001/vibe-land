// Debris hibernation: settled stage fragments frozen in place, thawed locally.
//
// A rubble pile is one contact island, and PhysX sleeps an island only when
// every member is ready. A few rocking chunks therefore keep tens of thousands
// of bodies simulating for the rest of the match, and any touch wakes the whole
// pile. Hibernation takes settled fragments out of the island one at a time:
// the stage turns each into a kinematic body in place (PxDestructionScene v25,
// setFragmentsHibernated). A kinematic body never joins an island and is never
// woken by contact, so a frozen pile costs no solver work and a disturbance
// wakes only what it actually reaches.
//
// What stays physically true:
// - Nothing moves when it freezes. A body freezes at its current pose, and only
//   once it is at rest: engine-asleep, or through three rest windows with no
//   net drift inside a small envelope (the rest-sleep test).
// - Frozen debris still collides. Dynamic bodies meet it as an immovable body.
// - It thaws BEFORE the step in which something would move it, so momentum is
//   exchanged with a dynamic body, never bounced off a wall:
//   * approach: a mover whose swept bounds reach it would deliver, along the
//     contact normal, a velocity v.n * m / (m + M) above `wake_dv` -- the
//     speed below which a body sliding to a stop on friction moves less than
//     about a centimetre. The struck body then counts as a mover carrying that
//     velocity, so a hit passing through a packed pile within one step thaws
//     the chain it reaches, and stops where the delivered velocity runs out;
//   * support: it rests on the top face of a body that is moving faster than
//     `wake_dv`, in any direction (what holds it up is going);
//   * push: a slow body that is not at rest (moved beyond the rest envelope in
//     this window) is touching it;
//   * a driven vehicle touches it;
//   * a shot or blast queries its neighbourhood (`thaw_near`);
//   * the stage changes its cluster (a fracture thaws it inside the step).
// - A thawed body that does not move does not thaw its neighbours: only motion
//   spreads a thaw, so a disturbance stays local.
//
// Vehicles' own bodies never freeze: a parked car must still drive.

#include "native_state.h"

#include <chrono>
#include <cstdlib>
#include <set>

namespace vibe_land::physx_bridge {

using namespace physx;
using Key = std::pair<std::uint32_t, std::uint64_t>;

namespace {

/// Rest windows a thawed body waits before it may freeze again, so a body the
/// world keeps touching is not frozen and thawed every window.
constexpr std::uint32_t kThawCooldownWindows = 2;
/// A mover's bounds are swept this many steps ahead and padded by this much,
/// so a thaw lands at least one step before contact.
constexpr float kSweepSteps = 2.0f;
constexpr float kMoverMarginM = 0.05f;
/// A body rests on another when their bounds overlap by at least this much on
/// both horizontal axes. Less is an edge or a corner graze, which carries no
/// weight to speak of.
constexpr float kMinFaceM = 0.05f;

/// How a mover meets a frozen body, from their bounds. The contact normal is
/// the axis along which the mover's current bounds are most separated from
/// the frozen body's (the separating axis), pointing from the mover to it;
/// the line of centres is not used, since in a packed pile it points
/// diagonally at a neighbour that only touches an edge. `strikes`: over its
/// swept path the mover overlaps the frozen body on both other axes, however
/// little -- an edge hit is still a hit. `rests_on_it`: the frozen body is
/// above the mover across a real face (at least kMinFaceM on both horizontal
/// axes of the current bounds).
struct Touch {
  PxVec3 normal{0.0f};
  bool strikes = false;
  bool rests_on_it = false;
};
Touch touch(const PxBounds3 &mover, const PxBounds3 &swept, const PxBounds3 &other) {
  int axis = 1;
  float widest = -PX_MAX_F32;
  for (int i = 0; i < 3; ++i) {
    const float gap = PxMax(other.minimum[i] - mover.maximum[i], mover.minimum[i] - other.maximum[i]);
    if (gap > widest) {
      widest = gap;
      axis = i;
    }
  }
  const auto overlap = [&](const PxBounds3 &a, int j) {
    return PxMin(other.maximum[j], a.maximum[j]) - PxMax(other.minimum[j], a.minimum[j]);
  };
  Touch t;
  t.normal[axis] = other.getCenter()[axis] >= mover.getCenter()[axis] ? 1.0f : -1.0f;
  t.strikes = true;
  for (int j = 0; j < 3; ++j) {
    if (j != axis && overlap(swept, j) <= 0.0f) {
      t.strikes = false;
    }
  }
  t.rests_on_it = axis == 1 && t.normal.y > 0.0f && overlap(mover, 0) >= kMinFaceM &&
                  overlap(mover, 2) >= kMinFaceM;
  return t;
}

bool supported_by_sdk() {
#if PX_DESTRUCTION_SCENE_VERSION >= 25
  return true;
#else
  return false;
#endif
}

} // namespace

NativeHibernation native_hibernation_default() {
  NativeHibernation h;
  const char *on = std::getenv("VIBE_CITY_NATIVE_HIBERNATE");
  h.enabled = on != nullptr && on[0] == '1' && supported_by_sdk();
  if (const char *raw = std::getenv("VIBE_CITY_NATIVE_HIBERNATE_WAKE_DV")) {
    const float parsed = std::strtof(raw, nullptr);
    if (std::isfinite(parsed) && parsed >= 0.0f) {
      h.wake_dv = parsed;
    }
  }
  return h;
}

bool NativeDestruction::State::fragment_hibernated(const PxRigidDynamic &actor) const {
#if PX_DESTRUCTION_SCENE_VERSION >= 25
  return configured && stage().isFragmentHibernated(actor);
#else
  (void)actor;
  return false;
#endif
}

bool NativeDestruction::State::is_vehicle_chunk(std::uint32_t chunk) const {
  for (const auto &range : vehicle_chunk_ranges) {
    if (chunk >= range.first && chunk < range.second) {
      return true;
    }
  }
  return false;
}

bool NativeDestruction::State::hibernation_eligible(const NativeBody &body) const {
  return hibernation.enabled && !body.frozen && body.serial != 0 &&
         !body.chunks.empty() && !is_vehicle_chunk(body.chunks.front()) &&
         body.actor != nullptr &&
         !body.actor->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC);
}

void NativeDestruction::State::forget_frozen(const Key &key, NativeBody &body,
                                             bool by_stage) {
  if (!body.frozen) {
    return;
  }
  frozen_index.remove(key, body.frozen_bounds);
  body.frozen = false;
  frozen_bodies -= 1;
  if (by_stage) {
    thaw_topology += 1;
  }
}

void NativeDestruction::State::hibernate_resting(
    std::vector<std::pair<NativeBody *, std::size_t>> &awake) {
  const auto started = std::chrono::steady_clock::now();
  struct Timer {
    std::chrono::steady_clock::time_point started;
    double &out;
    ~Timer() {
      out = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    }
  } timer{started, hibernate_ms};
  close_rest_windows(awake);
  if (!supported_by_sdk()) {
    return;
  }
#if PX_DESTRUCTION_SCENE_VERSION >= 25
  std::vector<Key> keys;
  std::vector<PxRigidDynamic *> actors;
  for (auto &entry : bodies) {
    NativeBody &body = entry.second;
    if (body.freeze_cooldown != 0) {
      body.freeze_cooldown -= 1;
      continue;
    }
    if (!hibernation_eligible(body)) {
      continue;
    }
    // At rest: asleep by the engine's own test, or awake and through the rest
    // windows. Either way it has not moved, so freezing it moves nothing.
    const bool at_rest = body.sleeping ? body.actor->isSleeping() : body.rest.resting;
    if (!at_rest) {
      continue;
    }
    keys.push_back(entry.first);
    actors.push_back(body.actor);
  }
  if (actors.empty()) {
    return;
  }
  PxDestructionScene &api = stage();
  std::vector<std::uint8_t> frozen(actors.size(), 0);
  if (api.setFragmentsHibernated(actors.data(), static_cast<PxU32>(actors.size()), true)) {
    std::fill(frozen.begin(), frozen.end(), 1);
  } else {
    // All-or-nothing refused: one is ineligible to the stage. Freeze the rest.
    for (std::size_t i = 0; i < actors.size(); ++i) {
      frozen[i] = api.setFragmentsHibernated(&actors[i], 1, true) ? 1 : 0;
    }
  }
  for (std::size_t i = 0; i < keys.size(); ++i) {
    if (!frozen[i]) {
      continue;
    }
    NativeBody &body = bodies.at(keys[i]);
    body.frozen = true;
    body.frozen_bounds = body.actor->getWorldBounds();
    frozen_index.insert(keys[i], body.frozen_bounds);
    frozen_bodies += 1;
    hibernate_froze += 1;
    body.rest.resting = false;
    body.rest.windows = 0;
  }
#endif
}

std::uint32_t NativeDestruction::State::thaw(const std::vector<Key> &keys,
                                             std::uint64_t &cause) {
#if PX_DESTRUCTION_SCENE_VERSION >= 25
  std::vector<Key> live;
  std::vector<PxRigidDynamic *> actors;
  for (const Key &key : keys) {
    const auto it = bodies.find(key);
    if (it == bodies.end() || !it->second.frozen) {
      continue;
    }
    live.push_back(key);
    actors.push_back(it->second.actor);
  }
  if (actors.empty()) {
    return 0;
  }
  PxDestructionScene &api = stage();
  std::vector<std::uint8_t> thawed(actors.size(), 0);
  if (api.setFragmentsHibernated(actors.data(), static_cast<PxU32>(actors.size()), false)) {
    std::fill(thawed.begin(), thawed.end(), 1);
  } else {
    for (std::size_t i = 0; i < actors.size(); ++i) {
      // Refused: the stage no longer holds it frozen (a topology change
      // thawed it); our record just catches up.
      thawed[i] = api.setFragmentsHibernated(&actors[i], 1, false) ||
                          !api.isFragmentHibernated(*actors[i])
                      ? 1
                      : 0;
    }
  }
  std::uint32_t count = 0;
  for (std::size_t i = 0; i < live.size(); ++i) {
    if (!thawed[i]) {
      continue;
    }
    NativeBody &body = bodies.at(live[i]);
    forget_frozen(live[i], body, false);
    body.freeze_cooldown = kThawCooldownWindows;
    count += 1;
  }
  cause += count;
  thawed_last_step += count;
  return count;
#else
  (void)keys;
  (void)cause;
  return 0;
#endif
}

void NativeDestruction::thaw_for_movers(const std::vector<HibernationMover> &external,
                                        float dt) {
  State &s = *state_;
  s.thawed_last_step = 0;
  s.thaw_ms = 0.0;
  if (!s.hibernation.enabled || s.frozen_bodies == 0 || !s.configured) {
    return;
  }
  const auto started = std::chrono::steady_clock::now();
  struct Mover {
    PxBounds3 bounds;
    PxVec3 velocity;
    float mass;
    bool always;
    bool pushing;
  };
  std::vector<Mover> queue;
  queue.reserve(external.size() + s.awake_keys.size() + s.rounds.size());
  for (const HibernationMover &m : external) {
    queue.push_back({PxBounds3(PxVec3(m.min[0], m.min[1], m.min[2]),
                               PxVec3(m.max[0], m.max[1], m.max[2])),
                     PxVec3(m.velocity[0], m.velocity[1], m.velocity[2]), m.mass, m.always,
                     false});
  }
  for (const Key &key : s.awake_keys) {
    const auto it = s.bodies.find(key);
    if (it == s.bodies.end() || it->second.frozen) {
      continue;
    }
    const NativeBody &body = it->second;
    PxRigidDynamic &actor = *body.actor;
    if (actor.getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC) || actor.isSleeping()) {
      continue;
    }
    const NativeBody::RestTrack &r = body.rest;
    const bool pushing = r.samples != 0 && (r.hi - r.lo).magnitude() > kRestEnvelopeM;
    queue.push_back({actor.getWorldBounds(), actor.getLinearVelocity(), actor.getMass(), false,
                     pushing});
  }
  for (const NativeRound &round : s.rounds) {
    if (round.actor != nullptr) {
      queue.push_back({round.actor->getWorldBounds(), round.actor->getLinearVelocity(),
                       round.actor->getMass(), false, false});
    }
  }

  // Breadth-first over predicted contacts. A frozen body a mover will strike
  // hard enough thaws, and becomes a predicted mover itself carrying the
  // velocity it would receive, so momentum passing through a tightly packed
  // pile within one step is never stopped by a frozen body further along.
  // Each hop keeps only its share m / (m + M), so the frontier ends where the
  // delivered velocity falls below `wake_dv`.
  std::set<Key> approach, support, push;
  const float wake = s.hibernation.wake_dv;
  for (std::size_t q = 0; q < queue.size(); ++q) {
    const Mover mover = queue[q];
    const float speed = mover.velocity.magnitude();
    if (!mover.always && !mover.pushing && speed <= wake) {
      continue; // even against a feather it could not deliver the wake speed
    }
    PxBounds3 touching = mover.bounds;
    touching.fattenFast(kMoverMarginM);
    PxBounds3 swept = touching;
    const PxVec3 ahead = mover.velocity * (dt * kSweepSteps);
    swept.include(touching.minimum + ahead);
    swept.include(touching.maximum + ahead);
    FrozenIndex::each_cell(swept, [&](std::uint64_t cell) {
      const auto found = s.frozen_index.cells.find(cell);
      if (found == s.frozen_index.cells.end()) {
        return;
      }
      for (const Key &key : found->second) {
        const auto it = s.bodies.find(key);
        if (it == s.bodies.end() || !it->second.frozen || approach.count(key) ||
            support.count(key) || !it->second.frozen_bounds.intersects(swept)) {
          continue;
        }
        const NativeBody &frozen = it->second;
        if (mover.always) {
          approach.insert(key);
          continue;
        }
        // Velocity delivered across the contact face: v.n * m / (m + M). A
        // kinematic actor reports the mass it had before it froze.
        const Touch meet = touch(mover.bounds, swept, frozen.frozen_bounds);
        const float closing = meet.strikes ? PxMax(0.0f, mover.velocity.dot(meet.normal)) : 0.0f;
        const float frozen_mass = frozen.actor->getMass();
        const float share =
            mover.mass > 0.0f ? mover.mass / (mover.mass + frozen_mass) : 1.0f;
        const float delivered = closing * share;
        const bool contact = frozen.frozen_bounds.intersects(touching);
        if (delivered > wake) {
          approach.insert(key);
          queue.push_back({frozen.frozen_bounds, meet.normal * delivered, frozen_mass, false, false});
        } else if (contact && meet.rests_on_it && speed > wake) {
          // It rests on a body that is moving: its support is going, whatever
          // the direction of the motion. "On" means across the mover's top
          // face, not merely touching it.
          support.insert(key);
        } else if (contact && mover.pushing) {
          push.insert(key);
        }
      }
    });
  }
  for (const Key &key : approach) {
    support.erase(key);
    push.erase(key);
  }
  for (const Key &key : support) {
    push.erase(key);
  }
  s.thaw(std::vector<Key>(approach.begin(), approach.end()), s.thaw_approach);
  s.thaw(std::vector<Key>(support.begin(), support.end()), s.thaw_support);
  s.thaw(std::vector<Key>(push.begin(), push.end()), s.thaw_push);
  s.thawed_max_step = std::max(s.thawed_max_step, s.thawed_last_step);
  s.thaw_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
}

bool NativeDestruction::has_frozen_debris() const {
  return state_->hibernation.enabled && state_->frozen_bodies != 0;
}

std::uint32_t NativeDestruction::thaw_near(const FfiVec3 &center, float radius) {
  State &s = *state_;
  if (s.frozen_bodies == 0) {
    return 0;
  }
  const PxVec3 c = native_px(center);
  const PxBounds3 query(c - PxVec3(radius), c + PxVec3(radius));
  std::set<Key> keys;
  FrozenIndex::each_cell(query, [&](std::uint64_t cell) {
    const auto found = s.frozen_index.cells.find(cell);
    if (found == s.frozen_index.cells.end()) {
      return;
    }
    for (const Key &key : found->second) {
      const auto it = s.bodies.find(key);
      if (it == s.bodies.end() || !it->second.frozen) {
        continue;
      }
      // Distance from the centre to the box, against the radius.
      const PxBounds3 &b = it->second.frozen_bounds;
      const PxVec3 nearest(PxClamp(c.x, b.minimum.x, b.maximum.x),
                           PxClamp(c.y, b.minimum.y, b.maximum.y),
                           PxClamp(c.z, b.minimum.z, b.maximum.z));
      if ((nearest - c).magnitudeSquared() <= radius * radius) {
        keys.insert(key);
      }
    }
  });
  return s.thaw(std::vector<Key>(keys.begin(), keys.end()), s.thaw_query);
}

void NativeDestruction::set_hibernation(const FfiHibernationConfig &config) {
  State &s = *state_;
  native_require(std::isfinite(config.wake_dv) && config.wake_dv >= 0.0f,
                 "hibernation wake_dv must be finite and non-negative");
  native_require(!config.enabled || supported_by_sdk(),
                 "debris hibernation needs PhysX destruction scene v25");
  if (!config.enabled && s.frozen_bodies != 0) {
    std::vector<Key> keys;
    for (const auto &entry : s.bodies) {
      if (entry.second.frozen) {
        keys.push_back(entry.first);
      }
    }
    s.thaw(keys, s.thaw_request);
  }
  s.hibernation.enabled = config.enabled;
  s.hibernation.wake_dv = config.wake_dv;
}

FfiHibernationStats NativeDestruction::hibernation_stats() const {
  const State &s = *state_;
  FfiHibernationStats stats{};
  stats.frozen = s.frozen_bodies;
  stats.froze_total = s.hibernate_froze;
  stats.thaw_approach = s.thaw_approach;
  stats.thaw_support = s.thaw_support;
  stats.thaw_push = s.thaw_push;
  stats.thaw_query = s.thaw_query;
  stats.thaw_topology = s.thaw_topology;
  stats.thaw_request = s.thaw_request;
  stats.thawed_last_step = s.thawed_last_step;
  stats.thawed_max_step = s.thawed_max_step;
  return stats;
}

rust::Vec<std::uint32_t> NativeDestruction::frozen_entities() const {
  rust::Vec<std::uint32_t> out;
  for (const auto &entry : state_->bodies) {
    if (entry.second.frozen) {
      out.push_back(entity_id(entry.second.structure, entry.second.serial));
    }
  }
  return out;
}

std::uint32_t NativeDestruction::set_entities_hibernated(
    rust::Slice<const std::uint32_t> entities, bool hibernated) {
  State &s = *state_;
  native_require(supported_by_sdk(), "debris hibernation needs PhysX destruction scene v25");
  native_require(s.configured, "hibernation needs a configured stage");
  const std::set<std::uint32_t> wanted(entities.begin(), entities.end());
  std::vector<Key> keys;
  for (const auto &entry : s.bodies) {
    if (wanted.count(entity_id(entry.second.structure, entry.second.serial))) {
      keys.push_back(entry.first);
    }
  }
  if (!hibernated) {
    return s.thaw(keys, s.thaw_request);
  }
#if PX_DESTRUCTION_SCENE_VERSION >= 25
  std::uint32_t count = 0;
  for (const Key &key : keys) {
    NativeBody &body = s.bodies.at(key);
    // The rest test is bypassed; every other rule holds, enabled or not.
    if (body.frozen || body.serial == 0 || body.chunks.empty() ||
        s.is_vehicle_chunk(body.chunks.front()) ||
        body.actor->getRigidBodyFlags().isSet(PxRigidBodyFlag::eKINEMATIC)) {
      continue;
    }
    PxRigidDynamic *actor = body.actor;
    if (!s.stage().setFragmentsHibernated(&actor, 1, true)) {
      continue;
    }
    body.frozen = true;
    body.frozen_bounds = actor->getWorldBounds();
    s.frozen_index.insert(key, body.frozen_bounds);
    s.frozen_bodies += 1;
    s.hibernate_froze += 1;
    count += 1;
  }
  return count;
#else
  return 0;
#endif
}

} // namespace vibe_land::physx_bridge
