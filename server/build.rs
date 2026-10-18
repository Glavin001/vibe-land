include!("../physx-bridge/physx_sdk_location.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    println!("cargo:rerun-if-env-changed=PHYSX_DESTRUCTION_SDK");
    if std::env::var_os("CARGO_FEATURE_PHYSX_GPU").is_none() {
        return;
    }

    // `cargo:rustc-link-arg` does not propagate from a dependency, so the
    // binary re-emits the rpath physx-bridge resolved.
    let native = std::env::var_os("CARGO_FEATURE_NATIVE_DESTRUCTION").is_some();
    let root = physx_root(native).unwrap_or_else(|| DEFAULT_PHYSX_ROOT.into());
    let lib = physx_lib_dir(&root).unwrap_or_else(|| root.join("bin/linux.x86_64/release"));
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
}
