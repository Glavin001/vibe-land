//! The committed C header must be exactly what cbindgen generates from this crate, so the Unreal
//! plugin can never compile against a header that disagrees with the linked library.
//!
//! Regenerate after changing the ABI: `VL_UPDATE_HEADER=1 cargo test -p vibe-client-core-ffi --test header_current`

use std::path::PathBuf;

#[test]
fn committed_header_matches_cbindgen_output() {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let header_path = crate_dir.join("include/vibe_client_core.h");
    let config = cbindgen::Config::from_file(crate_dir.join("cbindgen.toml")).expect("cbindgen.toml");

    let mut generated = Vec::new();
    cbindgen::Builder::new()
        .with_crate(&crate_dir)
        .with_config(config)
        .generate()
        .expect("cbindgen failed to parse client-core-ffi")
        .write(&mut generated);
    let generated = String::from_utf8(generated).expect("header is UTF-8");

    if std::env::var_os("VL_UPDATE_HEADER").is_some() {
        std::fs::create_dir_all(header_path.parent().unwrap()).unwrap();
        std::fs::write(&header_path, &generated).unwrap();
        return;
    }

    let committed = std::fs::read_to_string(&header_path).unwrap_or_default();
    assert!(
        committed == generated,
        "{} is stale; regenerate with VL_UPDATE_HEADER=1 cargo test -p vibe-client-core-ffi --test header_current",
        header_path.display()
    );
}
