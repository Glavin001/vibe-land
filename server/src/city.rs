//! Destructible-city match runtime: destruction backend + stream encoder.
//!
//! A match whose id starts with `city` gets a 4×4 grid of destructible
//! buildings. v1 drives the synthetic backend (scripted ballistic collapse, no
//! GPU); the PhysX/Blast backend slots in behind the same
//! `DestructionBackend` trait once the physx-bridge destruction FFI lands.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::Context;
use glam::Vec3;

use vibe_land_destruction::city::{build_city_scene, CityScene, CitySceneDesc};
use vibe_land_destruction::encoder::{ChunkStreamEncoder, EncoderConfig, SharedRecords};
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::scene_pack::load_scene_pack_file;
use vibe_land_destruction::synthetic::SyntheticDestruction;
use vibe_land_destruction::types::Camera;
use vibe_netcode::destruction_backend::DestructionBackend;

pub const CITY_MATCH_PREFIX: &str = "city";
/// Impulse handed to the synthetic backend per rifle hit.
const SHOT_IMPULSE: f32 = 400.0;
const SHOT_BLAST_RADIUS_M: f32 = 3.0;

pub fn is_city_match(match_id: &str) -> bool {
    match_id.starts_with(CITY_MATCH_PREFIX)
}

fn asset_path() -> PathBuf {
    if let Ok(dir) = std::env::var("VIBE_DESTRUCTION_ASSET_DIR") {
        return PathBuf::from(dir).join("fractured-tower.json");
    }
    // Workspace-relative default (make dev runs from the repo root); fall back
    // to the crate-relative path for `cargo run -p web-fps-server` from
    // anywhere inside the workspace.
    let candidates = [
        PathBuf::from("destruction/assets/scenes/fractured-tower.json"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../destruction/assets/scenes/fractured-tower.json"),
    ];
    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }
    candidates[0].clone()
}

fn build_scene() -> anyhow::Result<CityScene> {
    let path = asset_path();
    let pack = load_scene_pack_file(&path)
        .map_err(|error| anyhow::anyhow!("{error}"))
        .with_context(|| format!("loading city scene pack from {}", path.display()))?;
    build_city_scene(&pack, CitySceneDesc::default())
        .map_err(|error| anyhow::anyhow!("building city scene: {error}"))
}

/// Process-wide manifest asset: (hash hex, canonical JSON, gzipped JSON).
/// Deterministic from the committed scene pack, so it is shared by the HTTP
/// handler and every city match.
pub fn manifest_asset() -> Option<&'static (String, Arc<DestructionManifest>, Vec<u8>)> {
    static ASSET: OnceLock<Option<(String, Arc<DestructionManifest>, Vec<u8>)>> = OnceLock::new();
    ASSET
        .get_or_init(|| match build_scene() {
            Ok(scene) => {
                let manifest = DestructionManifest::from_city(&scene);
                let json = manifest.to_json_bytes();
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                use std::io::Write;
                encoder.write_all(&json).ok()?;
                let gzipped = encoder.finish().ok()?;
                Some((manifest.hash_hex(), Arc::new(manifest), gzipped))
            }
            Err(error) => {
                tracing::warn!(%error, "city manifest asset unavailable");
                None
            }
        })
        .as_ref()
}

pub struct CityRuntime {
    backend: SyntheticDestruction,
    encoder: ChunkStreamEncoder,
    pub manifest: Arc<DestructionManifest>,
    send_interval_ticks: u32,
    pub last_encode_ms: f32,
    structure_centers: Vec<(Vec3, f32)>,
    sent_records: u64,
    sent_bytes: u64,
    sent_packets: u64,
}

impl CityRuntime {
    pub fn synthetic(sim_hz: u32) -> anyhow::Result<Self> {
        let (_, manifest, _) = manifest_asset()
            .context("city scene asset unavailable (destruction/assets/scenes)")?;
        let manifest = manifest.clone();
        let backend = SyntheticDestruction::from_manifest(&manifest, sim_hz);
        let mut config = EncoderConfig::validated(sim_hz);
        config.send_interval_ticks = (sim_hz
            / u32::from(vibe_land_shared::constants::CITY_CHUNK_STREAM_HZ))
        .max(1);
        config.client_ceiling_bytes =
            usize::from(vibe_land_shared::constants::CITY_CLIENT_CEILING_BYTES_PER_SEND);
        // The whole 4×4 city fits in ~80 m; proximity interest covers it all
        // and the byte ceiling does the bounding. Frustum culling tightens
        // once the client camera convention is verified end-to-end.
        config.interest.proximity_meters = 120.0;
        let encoder = ChunkStreamEncoder::new(&manifest, config);
        let structure_centers = manifest
            .structures
            .iter()
            .map(|structure| {
                let center = Vec3::from_array(structure.world_position);
                let mut top = 0.0_f32;
                let mut footprint = 0.0_f32;
                for chunk in &structure.chunks {
                    let centroid = Vec3::from_array(chunk.centroid);
                    top = top.max(centroid.y);
                    let horizontal = (centroid.x * centroid.x + centroid.z * centroid.z).sqrt();
                    footprint = footprint.max(horizontal + chunk.radius);
                }
                let mid = center + Vec3::new(0.0, top * 0.5, 0.0);
                let radius = footprint.max(top * 0.55).max(2.0);
                (mid, radius)
            })
            .collect();
        Ok(Self {
            backend,
            encoder,
            manifest,
            send_interval_ticks: config.send_interval_ticks,
            last_encode_ms: 0.0,
            structure_centers,
            sent_records: 0,
            sent_bytes: 0,
            sent_packets: 0,
        })
    }

    pub fn send_interval_ticks(&self) -> u32 {
        self.send_interval_ticks
    }

    pub fn add_client(&mut self, client: u64) {
        self.encoder.add_client(client);
    }

    pub fn remove_client(&mut self, client: u64) {
        self.encoder.remove_client(client);
    }

    /// Route a hitscan ray into city damage: first building bounding sphere
    /// the ray enters takes an explosion at the entry point. (The synthetic
    /// backend has no colliders in the movement arena, so damage is resolved
    /// analytically; the PhysX backend will use real raycasts.)
    pub fn apply_shot_ray(&mut self, origin: Vec3, direction: Vec3) -> bool {
        let direction = direction.normalize_or_zero();
        if direction == Vec3::ZERO {
            return false;
        }
        let mut best: Option<(f32, Vec3)> = None;
        for (center, radius) in &self.structure_centers {
            let to_center = *center - origin;
            let along = to_center.dot(direction);
            if along <= 0.0 {
                continue;
            }
            let closest = origin + direction * along;
            let miss = closest.distance(*center);
            if miss > *radius {
                continue;
            }
            let entry = along - (radius * radius - miss * miss).sqrt().max(0.0);
            let point = origin + direction * entry.max(0.0);
            if best.is_none_or(|(distance, _)| entry < distance) {
                best = Some((entry, point));
            }
        }
        if let Some((_, point)) = best {
            self.backend
                .apply_explosion(point.to_array(), SHOT_BLAST_RADIUS_M, SHOT_IMPULSE);
            true
        } else {
            false
        }
    }

    /// 60 Hz step: destruction tick + encoder ingest. Returns reliable
    /// broadcast packets (topology, scheduled baselines).
    pub fn step(&mut self, sim_tick: u32, dt: f32, gravity: [f32; 3]) -> Vec<Vec<u8>> {
        let started = std::time::Instant::now();
        let mut reliable = Vec::new();
        match self.backend.tick_after_fetch(dt, gravity) {
            Ok(output) => {
                let snapshots = self.backend.body_snapshots();
                self.encoder.ingest_tick(sim_tick, &snapshots, &output, &[]);
                reliable.extend(self.encoder.take_topology_messages());
            }
            Err(error) => {
                tracing::error!(%error, "city destruction tick failed; topology frozen");
            }
        }
        if let Some(baselines) = self.encoder.maybe_emit_baseline(sim_tick) {
            reliable.extend(baselines);
        }
        self.last_encode_ms = started.elapsed().as_secs_f32() * 1000.0;
        reliable
    }

    pub fn encode_shared(&mut self, sim_tick: u32) -> SharedRecords {
        self.encoder.encode_send(sim_tick)
    }

    pub fn client_datagrams(
        &mut self,
        client: u64,
        camera: Camera,
        shared: &SharedRecords,
    ) -> Vec<Vec<u8>> {
        let packets = self.encoder.client_datagrams(client, camera, shared);
        self.sent_packets += packets.len() as u64;
        for packet in &packets {
            self.sent_bytes += packet.len() as u64;
        }
        self.sent_records += packets.len() as u64;
        packets
    }

    pub fn bootstrap(&self, sim_tick: u32) -> Vec<u8> {
        self.encoder.bootstrap_message(sim_tick)
    }

    pub fn stats(&self) -> vibe_netcode::destruction_backend::DestructionStats {
        self.backend.stats()
    }

    pub fn encoder_stats(&self) -> vibe_land_destruction::encoder::EncoderStats {
        self.encoder.stats()
    }

    /// Records selected + bytes sent since the last call (per-tick telemetry).
    pub fn take_stream_counters(&mut self) -> (u64, u64, u64) {
        let counters = (self.sent_records, self.sent_bytes, self.sent_packets);
        self.sent_records = 0;
        self.sent_bytes = 0;
        self.sent_packets = 0;
        counters
    }
}
