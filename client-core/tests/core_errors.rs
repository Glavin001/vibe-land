//! A core that has failed reports why, not a consequence of the failure.

use vibe_client_core::coords::Space;
use vibe_client_core::ClientCore;
use vibe_land_shared::net_client::SessionConfig;

#[test]
fn a_wire_2_match_reports_the_wire_even_after_its_manifest_arrives() {
    // A server that streams this city on wire 2 (an old build): the core refuses at the session
    // config, and the manifest the transport fetches next must not replace that reason.
    let config = SessionConfig::from_json(
        br#"{"match_id":"citypp-old","url":"https://127.0.0.1:4002/game","sim_hz":60,"snapshot_hz":60,
            "interpolation_delay_ms":32,"protocol_version":3,"city_world":true,
            "city_manifest_hash":"00","city_wire_version":2}"#,
    )
    .unwrap();
    let mut core = ClientCore::new(Space::Server);
    core.on_session_config(config);
    core.on_manifest(b"not a manifest");
    let error = core.last_error().unwrap_or_default();
    assert!(error.contains("wire 2"), "{error}");
}
