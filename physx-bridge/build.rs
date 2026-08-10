#[cfg(feature = "gpu")]
use std::{env, path::PathBuf};

#[cfg(feature = "gpu")]
const DEFAULT_PHYSX_ROOT: &str = "/root/PhysX/physx/install/linux-clang/PhysX";

#[cfg(feature = "gpu")]
fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/physx_bridge.cc");
    println!("cargo:rerun-if-changed=include/physx_bridge.h");

    let root =
        PathBuf::from(env::var_os("PHYSX_ROOT").unwrap_or_else(|| DEFAULT_PHYSX_ROOT.into()));
    let include = root.join("include");
    let lib = [root.join("bin/linux.x86_64/release"), root.join("lib")]
        .into_iter()
        .find(|candidate| candidate.join("libPhysX_static_64.a").is_file())
        .unwrap_or_else(|| {
            panic!(
                "PhysX libraries not found below PHYSX_ROOT={}; expected \
             bin/linux.x86_64/release/libPhysX_static_64.a",
                root.display()
            )
        });

    for required in [
        include.join("PxPhysicsAPI.h"),
        lib.join("libPhysX_static_64.a"),
        lib.join("libPhysXCommon_static_64.a"),
        lib.join("libPhysXFoundation_static_64.a"),
        lib.join("libPhysXExtensions_static_64.a"),
        lib.join("libPhysXCooking_static_64.a"),
        lib.join("libPhysXCharacterKinematic_static_64.a"),
        lib.join("libPhysXVehicle_static_64.a"),
        lib.join("libPhysXGpu_64.so"),
    ] {
        assert!(
            required.is_file(),
            "required PhysX artifact is missing: {}",
            required.display()
        );
    }

    cxx_build::bridge("src/lib.rs")
        .file("src/physx_bridge.cc")
        .include(&include)
        .include("include")
        .define("PX_PHYSX_STATIC_LIB", None)
        .flag_if_supported("-std=c++17")
        .flag_if_supported("-Wall")
        .flag_if_supported("-Wextra")
        .compile("vibe_land_physx_bridge");

    println!("cargo:rustc-link-search=native={}", lib.display());
    for library in [
        "PhysXExtensions_static_64",
        "PhysXCharacterKinematic_static_64",
        "PhysXVehicle_static_64",
        "PhysXCooking_static_64",
        "PhysX_static_64",
        "PhysXPvdSDK_static_64",
        "PhysXCommon_static_64",
        "PhysXFoundation_static_64",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
    println!("cargo:rustc-link-lib=dylib=PhysXGpu_64");
    println!("cargo:rustc-link-lib=dylib=cuda");
    println!("cargo:rustc-link-lib=dylib=dl");
    println!("cargo:rustc-link-lib=dylib=pthread");
    println!("cargo:rustc-link-lib=dylib=rt");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
}

#[cfg(not(feature = "gpu"))]
fn main() {}
