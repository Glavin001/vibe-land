fn main() {
    // Reuse the server's pure launch planner without its network packet encoder.
    let meteor = "../../../../server/src/meteor.rs";
    println!("cargo:rerun-if-changed={meteor}");
    let source = std::fs::read_to_string(meteor).unwrap();
    let planner = source.split("/// What the server tells every client").next().unwrap()
        .replace("use bytes::BufMut;", "")
        .replace("use vibe_land_shared::constants::PKT_METEOR_LAUNCHED;", "")
        .lines().filter(|line| !line.starts_with("//!")).collect::<Vec<_>>().join("\n");
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("meteor_planner.rs"), planner).unwrap();
    println!("cargo:rerun-if-changed=src/impact_diagnostics.cpp");
    let sdk = std::env::var("PHYSX_DESTRUCTION_SDK").unwrap_or("/root/workspace/physx-2".into());
    cc::Build::new()
        .cpp(true)
        .file("src/impact_diagnostics.cpp")
        .include(format!("{sdk}/physx/include"))
        .include("/usr/local/cuda-12.8/include")
        .define("NDEBUG", None)
        .flag_if_supported("-std=c++17")
        .compile("town_kit_impact_diagnostics");
    println!("cargo:rustc-link-lib=cuda");
}
