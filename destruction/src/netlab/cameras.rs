//! Where the replayed clients are looking.
//!
//! Interest and the pixel error budget are both camera-dependent, so a
//! replay is only a measurement of the recorded match when it uses the
//! recorded cameras. `player:<id>` does that from the capture's camera
//! sidecar. The synthetic specs exist for the question the recording cannot
//! answer -- what the same collapse costs to stream to fifty or a hundred
//! viewers -- and every output names which kind each client was.

use std::collections::HashMap;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::manifest::DestructionManifest;
use crate::netlab::capture::CameraSample;
use crate::types::Camera;

/// Eye height of a standing player, matching the server's interest camera.
pub const EYE_HEIGHT_M: f32 = 1.6;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CameraSpec {
    /// A recorded player's track, held between samples.
    Player { id: u32 },
    Static { eye: [f32; 3], look: [f32; 3], fov: f32 },
    /// A walker circling `centre` at `radius`, always looking inward.
    Walker { centre: [f32; 2], radius: f32, speed: f32, height: f32, phase: f32, fov: f32 },
    /// An orbit camera above the scene, looking at `centre`.
    Orbit { centre: [f32; 3], radius: f32, height: f32, period_s: f32, phase: f32, fov: f32 },
}

impl CameraSpec {
    /// `player:7`, `static:eye=x,y,z;look=x,y,z[;fov=80]`,
    /// `walker:centre=x,z;radius=r[;speed=1.5;height=1.6;phase=0;fov=80]`,
    /// `orbit:centre=x,y,z;radius=r;height=h[;period=60;phase=0;fov=80]`.
    pub fn parse(text: &str) -> Result<Self, String> {
        let (kind, rest) = text.split_once(':').unwrap_or((text, ""));
        let fields: HashMap<&str, &str> = rest
            .split(';')
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.split_once('='))
            .collect();
        let vec3 = |key: &str| -> Result<[f32; 3], String> {
            let value = fields.get(key).ok_or_else(|| format!("{text}: missing {key}"))?;
            let parts: Vec<f32> = value
                .split(',')
                .map(|v| v.trim().parse::<f32>().map_err(|e| format!("{text}: {key}: {e}")))
                .collect::<Result<_, _>>()?;
            if parts.len() != 3 {
                return Err(format!("{text}: {key} needs x,y,z"));
            }
            Ok([parts[0], parts[1], parts[2]])
        };
        let vec2 = |key: &str| -> Result<[f32; 2], String> {
            let value = fields.get(key).ok_or_else(|| format!("{text}: missing {key}"))?;
            let parts: Vec<f32> = value
                .split(',')
                .map(|v| v.trim().parse::<f32>().map_err(|e| format!("{text}: {key}: {e}")))
                .collect::<Result<_, _>>()?;
            if parts.len() != 2 {
                return Err(format!("{text}: {key} needs x,z"));
            }
            Ok([parts[0], parts[1]])
        };
        let num = |key: &str, default: f32| -> Result<f32, String> {
            match fields.get(key) {
                Some(value) => value.trim().parse::<f32>().map_err(|e| format!("{text}: {key}: {e}")),
                None => Ok(default),
            }
        };
        match kind {
            "player" => Ok(Self::Player {
                id: rest.trim().parse().map_err(|e| format!("{text}: player id: {e}"))?,
            }),
            "static" => Ok(Self::Static { eye: vec3("eye")?, look: vec3("look")?, fov: num("fov", 80.0)? }),
            "walker" => Ok(Self::Walker {
                centre: vec2("centre")?,
                radius: num("radius", 30.0)?,
                speed: num("speed", 1.5)?,
                height: num("height", EYE_HEIGHT_M)?,
                phase: num("phase", 0.0)?,
                fov: num("fov", 80.0)?,
            }),
            "orbit" => Ok(Self::Orbit {
                centre: vec3("centre")?,
                radius: num("radius", 80.0)?,
                height: num("height", 40.0)?,
                period_s: num("period", 60.0)?,
                phase: num("phase", 0.0)?,
                fov: num("fov", 80.0)?,
            }),
            other => Err(format!("unknown camera spec kind {other:?} in {text:?}")),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Player { id } => format!("player:{id}"),
            Self::Static { .. } => "static".into(),
            Self::Walker { .. } => "walker".into(),
            Self::Orbit { .. } => "orbit".into(),
        }
    }

    /// The camera at `tick`, or `None` for a recorded player with no sample
    /// yet (the client has not joined).
    pub fn camera_at(&self, tick: u32, hz: u32, tracks: &PlayerTracks) -> Option<Camera> {
        let seconds = tick as f32 / hz.max(1) as f32;
        match self {
            Self::Player { id } => tracks.camera_at(*id, tick),
            Self::Static { eye, look, fov } => Some(Camera {
                eye: Vec3::from_array(*eye),
                direction: (Vec3::from_array(*look) - Vec3::from_array(*eye)).normalize_or_zero(),
                fov_degrees: *fov,
            }),
            Self::Walker { centre, radius, speed, height, phase, fov } => {
                let angle = phase + seconds * speed / radius.max(0.1);
                let eye = Vec3::new(
                    centre[0] + radius * angle.cos(),
                    *height,
                    centre[1] + radius * angle.sin(),
                );
                let target = Vec3::new(centre[0], *height, centre[1]);
                Some(Camera {
                    eye,
                    direction: (target - eye).normalize_or_zero(),
                    fov_degrees: *fov,
                })
            }
            Self::Orbit { centre, radius, height, period_s, phase, fov } => {
                let angle = phase + seconds * std::f32::consts::TAU / period_s.max(0.1);
                let eye = Vec3::new(
                    centre[0] + radius * angle.cos(),
                    centre[1] + height,
                    centre[2] + radius * angle.sin(),
                );
                Some(Camera {
                    eye,
                    direction: (Vec3::from_array(*centre) - eye).normalize_or_zero(),
                    fov_degrees: *fov,
                })
            }
        }
    }
}

/// Recorded per-player camera tracks, one sample per send tick.
#[derive(Clone, Debug, Default)]
pub struct PlayerTracks {
    per_player: HashMap<u32, Vec<(u32, Camera)>>,
}

impl PlayerTracks {
    pub fn from_samples(samples: &[CameraSample]) -> Self {
        let mut per_player: HashMap<u32, Vec<(u32, Camera)>> = HashMap::new();
        for sample in samples {
            per_player.entry(sample.player).or_default().push((
                sample.tick,
                Camera {
                    eye: Vec3::from_array(sample.eye),
                    direction: Vec3::from_array(sample.dir).normalize_or_zero(),
                    fov_degrees: sample.fov,
                },
            ));
        }
        for track in per_player.values_mut() {
            track.sort_by_key(|(tick, _)| *tick);
        }
        Self { per_player }
    }

    pub fn players(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self.per_player.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// First tick a player has a camera sample at.
    pub fn first_tick(&self, player: u32) -> Option<u32> {
        self.per_player.get(&player)?.first().map(|(tick, _)| *tick)
    }

    /// The most recent sample at or before `tick`; none before the first.
    pub fn camera_at(&self, player: u32, tick: u32) -> Option<Camera> {
        let track = self.per_player.get(&player)?;
        let index = track.partition_point(|(sample_tick, _)| *sample_tick <= tick);
        if index == 0 {
            return None;
        }
        Some(track[index - 1].1)
    }
}

/// One replayed client: who it is, where it looks, what link it has.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClientSpec {
    pub id: u64,
    pub camera: CameraSpec,
    /// Impairment profile name from `client/netlab/netemProfiles.json`, or
    /// "none". Applied by the TS replay, recorded here so the output is
    /// self-describing.
    pub profile: String,
}

/// The scene's horizontal extent, for placing synthetic cameras.
pub struct SceneExtent {
    pub min: Vec3,
    pub max: Vec3,
}

impl SceneExtent {
    pub fn of(manifest: &DestructionManifest) -> Self {
        let mut min = Vec3::splat(f32::MAX);
        let mut max = Vec3::splat(f32::MIN);
        for structure in &manifest.structures {
            let origin = Vec3::from_array(structure.world_position);
            for chunk in &structure.chunks {
                let centre = origin + Vec3::from_array(chunk.centroid);
                min = min.min(centre - chunk.radius);
                max = max.max(centre + chunk.radius);
            }
        }
        if min.x > max.x {
            min = Vec3::new(-50.0, 0.0, -50.0);
            max = Vec3::new(50.0, 20.0, 50.0);
        }
        Self { min, max }
    }

    pub fn centre(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }
}

/// Deterministic mulberry32, so a client set is a function of its seed.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }
    pub fn next_f32(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(1 | t);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
        ((t ^ (t >> 14)) as f32) / 4_294_967_296.0
    }
}

/// `count` clients: every recorded player first, then synthetic viewers
/// spread over the scene -- walkers on the streets, a few static overlooks,
/// one orbit -- with impairment profiles dealt round-robin from `profiles`.
pub fn build_client_set(
    count: usize,
    tracks: &PlayerTracks,
    manifest: &DestructionManifest,
    profiles: &[String],
    seed: u32,
) -> Vec<ClientSpec> {
    let mut rng = Rng::new(seed);
    let extent = SceneExtent::of(manifest);
    let centre = extent.centre();
    let span = extent.max - extent.min;
    let mut out = Vec::new();
    let profile = |index: usize| -> String {
        if profiles.is_empty() {
            "none".to_string()
        } else {
            profiles[index % profiles.len()].clone()
        }
    };
    for player in tracks.players() {
        if out.len() >= count {
            break;
        }
        let index = out.len();
        out.push(ClientSpec {
            id: u64::from(player),
            camera: CameraSpec::Player { id: player },
            profile: profile(index),
        });
    }
    let mut next_id: u64 = 10_000;
    while out.len() < count {
        let index = out.len();
        let pick = rng.next_f32();
        let camera = if index % 10 == 9 {
            CameraSpec::Orbit {
                centre: centre.to_array(),
                radius: span.x.max(span.z) * 0.6,
                height: span.y.max(10.0) * 2.0,
                period_s: 90.0,
                phase: rng.next_f32() * std::f32::consts::TAU,
                fov: 80.0,
            }
        } else if pick < 0.25 {
            let eye = Vec3::new(
                extent.min.x + rng.next_f32() * span.x,
                extent.min.y + span.y * (0.5 + rng.next_f32() * 0.8),
                extent.min.z + rng.next_f32() * span.z,
            );
            let look = Vec3::new(
                extent.min.x + rng.next_f32() * span.x,
                extent.min.y + span.y * 0.3,
                extent.min.z + rng.next_f32() * span.z,
            );
            CameraSpec::Static { eye: eye.to_array(), look: look.to_array(), fov: 80.0 }
        } else {
            let c = Vec3::new(
                extent.min.x + rng.next_f32() * span.x,
                0.0,
                extent.min.z + rng.next_f32() * span.z,
            );
            CameraSpec::Walker {
                centre: [c.x, c.z],
                radius: 15.0 + rng.next_f32() * 40.0,
                speed: 1.0 + rng.next_f32() * 3.0,
                height: extent.min.y + EYE_HEIGHT_M,
                phase: rng.next_f32() * std::f32::consts::TAU,
                fov: 80.0,
            }
        };
        out.push(ClientSpec { id: next_id, camera, profile: profile(index) });
        next_id += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_parse_and_evaluate() {
        let spec = CameraSpec::parse("static:eye=0,10,0;look=0,0,-10").expect("static");
        let camera = spec.camera_at(0, 60, &PlayerTracks::default()).expect("camera");
        assert_eq!(camera.eye, Vec3::new(0.0, 10.0, 0.0));
        assert!((camera.direction.length() - 1.0).abs() < 1e-5);
        assert!(camera.direction.z < 0.0 && camera.direction.y < 0.0);

        let walker = CameraSpec::parse("walker:centre=5,5;radius=10;speed=2").expect("walker");
        let a = walker.camera_at(0, 60, &PlayerTracks::default()).expect("a");
        let b = walker.camera_at(60, 60, &PlayerTracks::default()).expect("b");
        assert!((a.eye.distance(Vec3::new(5.0, EYE_HEIGHT_M, 5.0)) - 10.0).abs() < 1e-4);
        assert!(a.eye.distance(b.eye) > 1.0, "a walker moves");
        assert!(CameraSpec::parse("bogus:x=1").is_err());
        assert!(CameraSpec::parse("static:eye=1,2").is_err());
    }

    /// Recorded tracks are held between samples and absent before the first
    /// one, which is when that player had not joined.
    #[test]
    fn player_tracks_hold_the_last_sample() {
        let samples = vec![
            CameraSample { tick: 10, player: 1, eye: [0.0; 3], dir: [0.0, 0.0, -1.0], fov: 80.0 },
            CameraSample { tick: 12, player: 1, eye: [1.0, 0.0, 0.0], dir: [0.0, 0.0, -1.0], fov: 80.0 },
        ];
        let tracks = PlayerTracks::from_samples(&samples);
        let spec = CameraSpec::Player { id: 1 };
        assert!(spec.camera_at(9, 60, &tracks).is_none());
        assert_eq!(spec.camera_at(11, 60, &tracks).expect("held").eye.x, 0.0);
        assert_eq!(spec.camera_at(50, 60, &tracks).expect("held").eye.x, 1.0);
        assert_eq!(tracks.first_tick(1), Some(10));
    }

    #[test]
    fn a_client_set_is_deterministic_and_leads_with_recorded_players() {
        let manifest: DestructionManifest =
            serde_json::from_str(r#"{"version":1,"structures":[]}"#).expect("manifest");
        let samples = vec![CameraSample {
            tick: 0, player: 4, eye: [0.0; 3], dir: [0.0, 0.0, -1.0], fov: 80.0,
        }];
        let tracks = PlayerTracks::from_samples(&samples);
        let profiles = vec!["none".to_string(), "lte".to_string()];
        let a = build_client_set(12, &tracks, &manifest, &profiles, 7);
        let b = build_client_set(12, &tracks, &manifest, &profiles, 7);
        assert_eq!(a.len(), 12);
        assert_eq!(a[0].camera, CameraSpec::Player { id: 4 });
        assert_eq!(a[0].profile, "none");
        assert_eq!(a[1].profile, "lte");
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.camera, y.camera);
        }
        assert!(matches!(a[9].camera, CameraSpec::Orbit { .. }));
    }
}
