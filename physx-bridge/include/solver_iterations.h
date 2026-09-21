#pragma once
#include <cstdlib>
#include <cstdint>

namespace vibe_land::physx_bridge {
// Shared by ordinary bodies and native construction parents. PhysX copies the
// parent settings onto fragments; changing only ordinary bodies misses debris.
inline std::uint32_t solver_iterations_from_env(const char* name, std::uint32_t fallback) {
  const char* raw = std::getenv(name);
  if (!raw || !*raw) return fallback;
  char* end = nullptr;
  const long value = std::strtol(raw, &end, 10);
  return end != raw && *end == '\0' && value >= 1 && value <= 255
      ? static_cast<std::uint32_t>(value) : fallback;
}
inline std::uint32_t dynamic_solver_position_iterations() {
  return solver_iterations_from_env("VIBE_PHYSX_POSITION_ITERS", 4u);
}
inline std::uint32_t dynamic_solver_velocity_iterations() {
  return solver_iterations_from_env("VIBE_PHYSX_VELOCITY_ITERS", 1u);
}
} // namespace vibe_land::physx_bridge
