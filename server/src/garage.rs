//! Private test drives reuse the multiplayer match, terrain and transport.
use crate::vehicle_assets::{self, PrepareRequest, PreparedGeometry, PreparedVehicle};
use axum::{http::StatusCode, Json};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use vibe_land_shared::world_document::WorldDocument;

pub const VEHICLE_ID: u32 = 1001;
const PREFIX: &str = "garage-";
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(Default::default)
}
pub struct Session {
    pub vehicle: PreparedVehicle,
    pub geometry: PreparedGeometry,
    pub world: WorldDocument,
    created: Instant,
    closing: AtomicBool,
}
impl Session {
    pub fn closing(&self) -> bool {
        self.closing.load(Ordering::Relaxed)
    }
}
pub fn is_garage(id: &str) -> bool {
    id.starts_with(PREFIX)
}
pub fn lookup(id: &str) -> Option<Arc<Session>> {
    sessions().lock().unwrap().get(id).cloned()
}
pub fn close(id: &str) {
    if let Some(session) = sessions().lock().unwrap().remove(id) {
        session.closing.store(true, Ordering::Relaxed);
    }
}
pub async fn close_handler(axum::extract::Path(id): axum::extract::Path<String>) -> StatusCode {
    if !is_garage(&id) {
        return StatusCode::NOT_FOUND;
    }
    close(&id);
    StatusCode::NO_CONTENT
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    match_id: String,
    world_document: WorldDocument,
    vehicle: PreparedVehicle,
}

pub async fn create(
    request: PrepareRequest,
) -> Result<Json<SessionResponse>, (StatusCode, String)> {
    let asset = vehicle_assets::prepare_drivable(request).await?;
    let vehicle = asset.vehicle;
    let geometry = asset.geometry;
    let mut token = [0u8; 24];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut token))
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Session creation is unavailable".into(),
            )
        })?;
    let match_id = format!("{PREFIX}{}", hex::encode(token));
    let world = crate::demo_world::garage_test_world();
    let mut registry = sessions().lock().unwrap();
    registry
        .retain(|_, s| Arc::strong_count(s) > 1 || s.created.elapsed() < Duration::from_secs(900));
    if registry.len() >= 4 {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "All test drive slots are in use. Please try again later.".into(),
        ));
    }
    registry.insert(
        match_id.clone(),
        Arc::new(Session {
            vehicle: vehicle.clone(),
            geometry,
            world: world.clone(),
            created: Instant::now(),
            closing: AtomicBool::new(false),
        }),
    );
    Ok(Json(SessionResponse {
        match_id,
        world_document: world,
        vehicle,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rig_wire_layout_preserves_all_four_authoritative_wheels() {
        let wheels = std::array::from_fn(|i| [i as f32 * 0.01, -0.2, 2.5, (i % 2) as f32]);
        let packet = vehicle_assets::rig_packet(0x12345678, 7, wheels);
        assert_eq!(packet.len(), 58);
        assert_eq!(packet[0], vibe_land_shared::constants::PKT_VEHICLE_RIG);
        assert_eq!(&packet[1..5], &0x12345678u32.to_le_bytes());
        assert_eq!(packet[5], 7);
        for (i, wheel) in wheels.iter().enumerate() {
            for (j, value) in wheel[..3].iter().enumerate() {
                let offset = 6 + i * 13 + j * 4;
                assert_eq!(
                    f32::from_le_bytes(packet[offset..offset + 4].try_into().unwrap()),
                    *value
                );
            }
            assert_eq!(packet[6 + i * 13 + 12], wheel[3] as u8);
        }
    }

    #[test]
    fn closing_unknown_session_does_not_remove_other_matches() {
        close("garage-nonexistent-test");
        assert!(lookup("garage-nonexistent-test").is_none());
        assert!(!is_garage("city"));
        assert!(!is_garage("default"));
    }
}
