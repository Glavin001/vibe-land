// Diagnostics only: shared SDK phase labels/schema, no new physics timers.
#include "embedded_profiling.h"
#include "native_phase_profiler.h"
#include <time.h>
#include <sys/syscall.h>
#include <unistd.h>
namespace blast_demo {
// This consumer captures no CUPTI activity. Host intervals use CLOCK_MONOTONIC;
// device event intervals are emitted by the existing native runtime profiler.
static uint64_t clockNs(clockid_t id) {
    timespec value{};
    if(clock_gettime(id,&value))throw std::runtime_error("profiling clock failed");
    return uint64_t(value.tv_sec)*1000000000ull+uint64_t(value.tv_nsec);
}
uint64_t nativeProfileTimestamp(){return clockNs(CLOCK_MONOTONIC);}
uint64_t nativeThreadCpuNs(){return clockNs(CLOCK_THREAD_CPUTIME_ID);}
uint32_t nativeThreadId(){return uint32_t(syscall(SYS_gettid));}
}
namespace vibe_land::physx_bridge {
struct NativeProfile::Impl {
    blast_demo::NativePhaseProfiler profile;
    void* advance=nullptr;
    explicit Impl(rust::Str path):profile(std::string(path)){}
    ~Impl(){if(advance)profile.zoneEnd(advance,"GpuDestruction.consumerAdvance",false,0);}
};
NativeProfile::NativeProfile(rust::Str path):impl(new Impl(path)){}
NativeProfile::~NativeProfile()=default;
void NativeProfile::begin(std::uint32_t tick){
    impl->profile.begin(tick);
    impl->advance=impl->profile.zoneStart("GpuDestruction.consumerAdvance",false,0);
}
void NativeProfile::accepted(){
    impl->profile.zoneEnd(impl->advance,"GpuDestruction.consumerAdvance",false,0);
    impl->advance=nullptr;
    impl->profile.acceptedFrame();
}
std::unique_ptr<NativeProfile> new_native_profile(rust::Str path){return std::make_unique<NativeProfile>(path);}
}
