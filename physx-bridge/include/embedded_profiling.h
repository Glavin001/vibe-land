#pragma once
#include "rust/cxx.h"
#include <memory>
#include <cstdint>
namespace vibe_land::physx_bridge {
class NativeProfile {
    struct Impl;
    std::unique_ptr<Impl> impl;
public:
    explicit NativeProfile(rust::Str path);
    ~NativeProfile();
    void begin(std::uint32_t tick);
    void accepted();
};
std::unique_ptr<NativeProfile> new_native_profile(rust::Str path);
}
