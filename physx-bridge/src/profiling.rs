//! Opt-in diagnostic consumer of PhysX's existing profiler callback.
//! Construct before the World so the profiler outlives its asynchronous tasks.
#[cxx::bridge(namespace = "vibe_land::physx_bridge")]
mod ffi {
    unsafe extern "C++" {
        include!("embedded_profiling.h");
        type NativeProfile;
        fn new_native_profile(path: &str) -> Result<UniquePtr<NativeProfile>>;
        fn begin(self: Pin<&mut NativeProfile>, tick: u32);
        fn accepted(self: Pin<&mut NativeProfile>) -> Result<()>;
    }
}

pub struct NativeProfile(cxx::UniquePtr<ffi::NativeProfile>);
impl NativeProfile {
    pub fn new(path: &str) -> Result<Self, cxx::Exception> {
        ffi::new_native_profile(path).map(Self)
    }
    pub fn begin(&mut self, tick: u32) {
        self.0.pin_mut().begin(tick);
    }
    pub fn accepted(&mut self) -> Result<(), cxx::Exception> {
        self.0.pin_mut().accepted()
    }
}
