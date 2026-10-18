fn main() {
    println!("cargo:rerun-if-changed=src/contact_solver.cpp");
    println!("cargo:rerun-if-env-changed=PHYSX_DESTRUCTION_SDK");
    let sdk=std::env::var("PHYSX_DESTRUCTION_SDK").unwrap_or("/root/workspace/physx-2".into());
    cc::Build::new().cpp(true).file("src/contact_solver.cpp")
        .include(format!("{sdk}/physx/include")).define("NDEBUG",None)
        .flag_if_supported("-std=c++17").compile("town_kit_contact_solver");
}
