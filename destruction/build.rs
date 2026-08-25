//! Emits the PhysX GPU runtime path for this crate's own targets.
//!
//! `cargo:rustc-link-arg` only applies to targets of the crate that owns the
//! build script — it does **not** propagate from a dependency. So the rpath
//! `physx-bridge/build.rs` emits covers the bridge's own tests but not this
//! crate's, and PhysX then fails to `dlopen` libPhysXGpu_64.so at CUDA-context
//! creation. The scene construction fails, the bridge honestly reports "no
//! GPU", and every GPU test quietly downgrades to a skip — which reads as
//! missing hardware rather than a missing runtime path.

fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");

    // Only relevant when the PhysX-backed paths are compiled in.
    if std::env::var_os("CARGO_FEATURE_PHYSX").is_none() {
        return;
    }

    const DEFAULT_PHYSX_ROOT: &str = "/root/PhysX/physx/install/linux-clang/PhysX";
    let root = std::path::PathBuf::from(
        std::env::var_os("PHYSX_ROOT").unwrap_or_else(|| DEFAULT_PHYSX_ROOT.into()),
    );
    for candidate in [root.join("bin/linux.x86_64/release"), root.join("lib")] {
        if candidate.is_dir() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", candidate.display());
            return;
        }
    }
}
