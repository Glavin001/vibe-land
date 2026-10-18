#pragma once
#include <cstdint>
#include <cstdlib>

namespace vibe_land::physx_bridge {
/// Solver iteration counts for dynamic bodies: VIBE_PHYSX_POSITION_ITERS /
/// VIBE_PHYSX_VELOCITY_ITERS. Defaults match PhysX's own (4/1) so behaviour is
/// unchanged unless asked; the stack-settling test sweeps them to locate the
/// knee. Shared by ordinary bodies and native construction parents: PhysX
/// copies the parent's counts onto every fragment, so changing only ordinary
/// bodies misses the debris. The GPU solver runs the scene-wide maximum.
inline std::uint32_t solver_iterations_from_env(const char *name, std::uint32_t fallback) {
  const char *raw = std::getenv(name);
  if (raw == nullptr || *raw == '\0') return fallback;
  char *end = nullptr;
  const long value = std::strtol(raw, &end, 10);
  return end != raw && *end == '\0' && value >= 1 && value <= 255
             ? static_cast<std::uint32_t>(value)
             : fallback;
}
inline std::uint32_t dynamic_solver_position_iterations() {
  return solver_iterations_from_env("VIBE_PHYSX_POSITION_ITERS", 4u);
}
inline std::uint32_t dynamic_solver_velocity_iterations() {
  return solver_iterations_from_env("VIBE_PHYSX_VELOCITY_ITERS", 1u);
}
} // namespace vibe_land::physx_bridge
