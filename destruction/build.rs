//! Emits the PhysX GPU runtime path for this crate's own targets.
//!
//! `cargo:rustc-link-arg` only applies to targets of the crate that owns the
//! build script — it does **not** propagate from a dependency. So the rpath
//! `physx-bridge/build.rs` emits covers the bridge's own tests but not this
//! crate's, and PhysX then fails to `dlopen` libPhysXGpu_64.so at CUDA-context
//! creation. The scene construction fails, the bridge honestly reports "no
//! GPU", and every GPU test quietly downgrades to a skip — which reads as
//! missing hardware rather than a missing runtime path.

include!("../physx-bridge/physx_sdk_location.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    println!("cargo:rerun-if-env-changed=PHYSX_DESTRUCTION_SDK");

    // Only relevant when a PhysX-backed path (Blast or native) is compiled in.
    let native = std::env::var_os("CARGO_FEATURE_NATIVE_DESTRUCTION").is_some();
    if std::env::var_os("CARGO_FEATURE_PHYSX").is_none() && !native {
        return;
    }

    if let Some(lib) = physx_root(native).as_deref().and_then(physx_lib_dir) {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    }
}
