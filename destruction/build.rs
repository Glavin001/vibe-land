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
    println!("cargo:rerun-if-env-changed=PHYSX_DESTRUCTION_SDK");

    // Only relevant when the PhysX-backed paths are compiled in.
    if std::env::var_os("CARGO_FEATURE_PHYSX").is_none() {
        return;
    }

    let root = physx_root();
    for candidate in [root.join("bin/linux.x86_64/release"), root.join("lib")] {
        if candidate.is_dir() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", candidate.display());
            return;
        }
    }
}

/// Mirrors `physx-bridge/build.rs`: an explicit PHYSX_ROOT wins, otherwise the
/// native feature resolves the physx-2 checkout and everything else keeps the
/// upstream install. `cargo:rustc-link-arg` does not propagate from a
/// dependency, so each crate that produces a binary re-emits the rpath.
fn physx_root() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Some(explicit) = std::env::var_os("PHYSX_ROOT") {
        return PathBuf::from(explicit);
    }
    if std::env::var_os("CARGO_FEATURE_NATIVE_DESTRUCTION").is_some() {
        let sdk = PathBuf::from(
            std::env::var_os("PHYSX_DESTRUCTION_SDK")
                .unwrap_or_else(|| "/root/workspace/physx-2".into()),
        );
        for candidate in [sdk.join("physx"), sdk.join("out/install"), sdk.clone()] {
            if candidate.join("include/PxDestructionScene.h").is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("/root/PhysX/physx/install/linux-clang/PhysX")
}
