// Where the PhysX SDK lives, shared by the build scripts of physx-bridge,
// destruction and server through `include!`. `cargo:rustc-link-arg` does not
// propagate from a dependency, so every crate that produces a binary re-emits
// the rpath, and all three must resolve the same SDK.
//
// Linux + NVIDIA: the upstream install, or the physx-2 checkout under
// `native-destruction`. macOS: the PhysX fork's CuMetal install (built with
// `tools/scripts/build-destruction-sdk.py --preset macos-cumetal --stage sdk
// --install`), from a sibling checkout by default; Apple Silicon has no
// upstream GPU PhysX, so every GPU build there uses it.

#[allow(dead_code)]
const DEFAULT_PHYSX_ROOT: &str = "/root/PhysX/physx/install/linux-clang/PhysX";

/// The PhysX fork whose GPU destruction stage runs inside `PxScene::simulate()`.
///
/// Only consulted under `native-destruction` (or on macOS), and only when
/// `PHYSX_ROOT` is not set explicitly. The plain Blast builds keep
/// `DEFAULT_PHYSX_ROOT`: an experiment must not silently move the baseline's
/// SDK, which is exactly how an earlier attempt ended up comparing two
/// different engines and calling it one.
#[allow(dead_code)]
const DEFAULT_PHYSX_DESTRUCTION_SDK: &str = "/root/workspace/physx-2";

/// The macOS install prefix inside the fork, relative to its checkout.
#[allow(dead_code)]
const MACOS_SDK_INSTALL: &str = "out/install/macos-cumetal/release";

#[allow(dead_code)]
fn target_is_macos() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
}

/// `lib<name>.so` on Linux, `lib<name>.dylib` on macOS.
#[allow(dead_code)]
fn shared_library(name: &str) -> String {
    format!("lib{name}.{}", if target_is_macos() { "dylib" } else { "so" })
}

/// `PHYSX_DESTRUCTION_SDK`, else the checkout the platform expects: the
/// deployment path on Linux, a sibling `PhysX` checkout on macOS.
#[allow(dead_code)]
fn physx_destruction_sdk() -> std::path::PathBuf {
    if let Some(explicit) = std::env::var_os("PHYSX_DESTRUCTION_SDK") {
        return explicit.into();
    }
    if target_is_macos() {
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
        return manifest.join("../../PhysX");
    }
    DEFAULT_PHYSX_DESTRUCTION_SDK.into()
}

/// The directory holding `PxPhysicsAPI.h`: `include` in a checkout or the
/// upstream install, `include/physx` in the fork's packaged install.
#[allow(dead_code)]
fn physx_include(root: &std::path::Path) -> std::path::PathBuf {
    let packaged = root.join("include/physx");
    if packaged.join("PxPhysicsAPI.h").is_file() {
        packaged
    } else {
        root.join("include")
    }
}

/// The directory holding `libPhysX_static_64.a`, if any.
#[allow(dead_code)]
fn physx_lib_dir(root: &std::path::Path) -> Option<std::path::PathBuf> {
    [root.join("bin/linux.x86_64/release"), root.join("bin/mac.arm64/release"), root.join("lib")]
        .into_iter()
        .find(|candidate| candidate.join("libPhysX_static_64.a").is_file())
}

/// `PHYSX_ROOT` always wins, so an explicit override still selects any SDK.
/// Otherwise `native` (and every macOS build) resolves the physx-2 SDK, whose
/// headers carry `PxDestructionScene.h`; other builds keep the upstream install.
#[allow(dead_code)]
fn physx_root(native: bool) -> Option<std::path::PathBuf> {
    if let Some(explicit) = std::env::var_os("PHYSX_ROOT") {
        return Some(explicit.into());
    }
    if !native && !target_is_macos() {
        return Some(DEFAULT_PHYSX_ROOT.into());
    }
    let sdk = physx_destruction_sdk();
    // The checkout keeps headers in physx/include and libraries in physx/bin;
    // `out/install` is the same SDK relocated, and the macOS package sits in
    // its own prefix. Accept any so a packaged install needs no other variable.
    [sdk.join(MACOS_SDK_INSTALL), sdk.join("physx"), sdk.join("out/install"), sdk.clone()]
        .into_iter()
        .find(|candidate| {
            physx_include(candidate).join("PxDestructionScene.h").is_file()
                && physx_lib_dir(candidate).is_some()
        })
}
