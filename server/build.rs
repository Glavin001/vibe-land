use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    if env::var_os("CARGO_FEATURE_PHYSX_GPU").is_none() {
        return;
    }

    let root = PathBuf::from(
        env::var_os("PHYSX_ROOT")
            .unwrap_or_else(|| "/root/PhysX/physx/install/linux-clang/PhysX".into()),
    );
    let lib = root.join("bin/linux.x86_64/release");
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
}
