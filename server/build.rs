use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    println!("cargo:rerun-if-env-changed=PHYSX_DESTRUCTION_SDK");
    if env::var_os("CARGO_FEATURE_PHYSX_GPU").is_none() {
        return;
    }

    let root = physx_root();
    let lib = root.join("bin/linux.x86_64/release");
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
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
