//! Destruction audio policy, shared by every renderer: which sounds play, how loud, at what pitch.
//!
//! A port of the web client's audio model (client/src/audio: `model.ts`, `director.ts`,
//! `destructionMix.ts`, `gameEvents.ts` and the voice choices of `engine.ts`) with its default
//! settings (the "cinematic" mix, balanced dynamics, the original palette). Renderers keep only
//! playback: given a [`VlSound`] they play its clip at its position with its gain and rate, with
//! no distance attenuation of their own (the gain already carries the web's `sourceAttenuation`).
//!
//! Positions are in server space here; the core converts them for the renderer.

use std::collections::HashMap;

use glam::Vec3;

/// The clip catalog the web plays from (client/public/audio/destruction/catalog.json), by id.
pub const CLIP_CATALOG_JSON: &str = include_str!("../../client/public/audio/destruction/catalog.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AcousticMaterial {
    Concrete,
    Stone,
    Metal,
    Sheet,
    Wood,
    Glass,
    Earth,
}

impl AcousticMaterial {
    pub fn name(self) -> &'static str {
        match self {
            Self::Concrete => "concrete",
            Self::Stone => "stone",
            Self::Metal => "metal",
            Self::Sheet => "sheet",
            Self::Wood => "wood",
            Self::Glass => "glass",
            Self::Earth => "earth",
        }
    }
}

/// `acousticMaterial(name, metalness)` (model.ts): a material's sound from its name.
pub fn acoustic_material(name: &str, metalness: f32) -> AcousticMaterial {
    let n = name.to_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if any(&["glass", "window"]) {
        AcousticMaterial::Glass
    } else if any(&["wood", "timber", "plank", "bark", "tree"]) {
        AcousticMaterial::Wood
    } else if any(&["sheet", "tin", "mailbox", "panel"]) {
        AcousticMaterial::Sheet
    } else if any(&["metal", "steel", "iron", "alumin", "vehicle", "car"]) || metalness > 0.6 {
        AcousticMaterial::Metal
    } else if any(&["soil", "dirt", "sand", "grass", "earth"]) {
        AcousticMaterial::Earth
    } else if any(&["stone", "rock", "granite", "marble"]) {
        AcousticMaterial::Stone
    } else {
        AcousticMaterial::Concrete
    }
}

fn clamp01(n: f32) -> f32 {
    if n.is_finite() {
        n.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// `physicalIntensity(impulse, mass)` (model.ts): kinetic energy lost, compressed perceptually.
pub fn physical_intensity(impulse: f32, mass: f32) -> f32 {
    if !(impulse.is_finite() && mass.is_finite()) || impulse <= 0.0 || mass <= 0.0 {
        return 0.0;
    }
    let energy = impulse * impulse / (2.0 * mass);
    (1.0 - (-(energy / 2500.0).powf(0.35)).exp()).clamp(0.0, 0.98)
}

/// `seedRandom(seed)` (model.ts): xorshift32, bit-identical to the web's.
pub struct SeedRandom(u32);

impl SeedRandom {
    pub fn new(seed: u32) -> Self {
        Self(if seed == 0 { 1 } else { seed })
    }
    pub fn next(&mut self) -> f32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        (f64::from(s) / 4294967296.0) as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SoundKind {
    Impact,
    Fracture,
    Collapse,
    Shot,
}

/// One sound-worthy event (model.ts `SoundEvent`). `id` groups duplicates; `atMs` is on the
/// caller's presentation clock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SoundEvent {
    pub id: u64,
    pub kind: SoundKind,
    pub position: Vec3,
    pub material: AcousticMaterial,
    /// Perceptual intensity, 0..1.
    pub intensity: f32,
    pub size: f32,
    pub seed: u32,
    pub at_ms: f64,
    pub protected: bool,
}

/// The web's default mix (settings.ts DEFAULT_AUDIO: the cinematic preset, balanced range).
#[derive(Clone, Copy, Debug)]
pub struct Mix {
    pub impact: f32,
    pub detail: f32,
    pub bass: f32,
}

pub const DEFAULT_MIX: Mix = Mix { impact: 1.0, detail: 0.8, bass: 0.9 };

/// `eventMix` (destructionMix.ts), balanced dynamic range.
pub fn event_mix(e: &SoundEvent, s: Mix) -> (f32, f32, f32, f32) {
    let i = clamp01(e.intensity);
    let amount = 1.85 * i.powf(1.15);
    let weight = if e.material == AcousticMaterial::Glass {
        0.0
    } else {
        clamp01(((1.0 + e.size.max(0.0)).log2() - 0.55) / 1.45) * clamp01((i - 0.2) / 0.5)
    };
    (
        amount * s.impact * (1.0 - 0.28 * weight),
        amount * weight * 0.95 * s.bass,
        amount * 0.3 * s.detail * (1.0 - 0.35 * weight),
        weight,
    )
}

/// `sourceAttenuation` (destructionMix.ts): gain ≤ 1 over distance, wider sources carry further.
pub fn source_attenuation(distance: f32, size: f32) -> f32 {
    let radius = size.clamp(1.0, 8.0);
    1.0 / (1.0 + (distance - radius).max(0.0) / (16.0 + radius * 2.5)).powf(1.35)
}

/// `propagationDelayMs` (destructionMix.ts): sound arrives late beyond 35 m.
pub fn propagation_delay_ms(distance: f32) -> f32 {
    if distance > 35.0 {
        ((distance - 35.0) / 343.0 * 1000.0).min(650.0)
    } else {
        0.0
    }
}

/// One clip to play: a renderer plays `clip` at `position` with `gain` (attenuation included,
/// no further distance falloff) and playback `rate`, `delay_s` from now.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VlSound {
    /// Index into the clip table (`clip_id`).
    pub clip: u32,
    pub position: [f32; 3],
    pub gain: f32,
    pub rate: f32,
    pub delay_s: f32,
    /// `VL_SOUND_*` bits.
    pub flags: u32,
}

pub const VL_SOUND_PROTECTED: u32 = 1;

/// The clip table: catalog ids, sorted (stable indices for a given catalog).
pub struct Clips {
    pub ids: Vec<String>,
    by_id: HashMap<String, u32>,
}

impl Clips {
    pub fn get() -> &'static Clips {
        static CLIPS: std::sync::OnceLock<Clips> = std::sync::OnceLock::new();
        CLIPS.get_or_init(|| {
            let v: serde_json::Value = serde_json::from_str(CLIP_CATALOG_JSON).expect("audio clip catalog");
            let mut ids: Vec<String> = v["clips"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            ids.sort();
            let by_id = ids.iter().enumerate().map(|(i, id)| (id.clone(), i as u32)).collect();
            Clips { ids, by_id }
        })
    }
    pub fn index(&self, id: &str) -> Option<u32> {
        self.by_id.get(id).copied()
    }
}

/// The voices one event plays (engine.ts `play`, original palette), relative to `listener`.
pub fn voices(e: &SoundEvent, listener: Vec3, now_ms: f64, mix: Mix, out: &mut Vec<VlSound>) {
    let clips = Clips::get();
    let mut r = SeedRandom::new(e.seed);
    let d = e.position.distance(listener);
    let intensity = clamp01(e.intensity);
    let (hit, body, detail, _) = event_mix(e, mix);
    let delay_s = (((e.at_ms + f64::from(propagation_delay_ms(d))) - now_ms) / 1000.0).max(0.0) as f32;
    let rate = (1.04 - (e.size.max(0.0)).ln_1p() * 0.065 + (r.next() - 0.5) * 0.13).clamp(0.57, 1.2);
    let variant = (r.next() * 5.0).floor() as u32;
    let flags = if e.protected { VL_SOUND_PROTECTED } else { 0 };
    let attenuation = source_attenuation(d, e.size);
    let mut push = |id: String, level: f32, rate: f32, extra_delay: f32| {
        if level < 0.005 {
            return;
        }
        if let Some(clip) = clips.index(&id) {
            out.push(VlSound {
                clip,
                position: e.position.to_array(),
                gain: level * attenuation,
                rate,
                delay_s: delay_s + extra_delay,
                flags,
            });
        }
    };
    let m = e.material.name();
    match e.kind {
        SoundKind::Shot => {
            let gun = if e.size <= 0.2 { "rifle" } else { "cannon" };
            push(format!("shot-{gun}-{}", variant % 3), hit, rate, 0.0);
            return;
        }
        SoundKind::Collapse => push(format!("collapse-{}", variant % 4), hit, rate, 0.0),
        SoundKind::Fracture => push(format!("{m}-fracture-{}", variant % 3), hit, rate, 0.0),
        SoundKind::Impact => push(format!("{m}-impact-{variant}"), hit, rate, 0.0),
    }
    if body > 0.01 {
        push(format!("heavy-{m}"), body, rate.clamp(0.68, 1.1), 0.009);
    }
    if intensity > 0.4 {
        push(format!("{m}-fracture-{}", (variant + 1) % 3), detail, rate * 1.11, 0.025);
    }
}

/// Bounded event reduction before playback (director.ts `AudioDirector`): duplicates grouped,
/// nearby same-kind events in a 5 m / 65 ms cell merged, the weakest dropped past capacity, at
/// most `per_frame` played a frame, stale (300 ms) and distant (450 m) ones dropped.
pub struct AudioDirector {
    capacity: usize,
    per_frame: usize,
    pending: HashMap<u64, (SoundEvent, u64)>,
    recent: HashMap<u64, f64>,
    order: u64,
    pub listener: Vec3,
    pub received: u64,
    pub grouped: u64,
    pub dropped: u64,
    pub stale: u64,
    pub selected: u64,
}

impl Default for AudioDirector {
    fn default() -> Self {
        Self::new(256, 12)
    }
}

impl AudioDirector {
    pub fn new(capacity: usize, per_frame: usize) -> Self {
        Self {
            capacity,
            per_frame,
            pending: HashMap::new(),
            recent: HashMap::new(),
            order: 0,
            listener: Vec3::ZERO,
            received: 0,
            grouped: 0,
            dropped: 0,
            stale: 0,
            selected: 0,
        }
    }

    fn score(&self, e: &SoundEvent) -> f32 {
        let d = e.position.distance(self.listener);
        (if e.protected { 12.0 } else { 0.0 })
            + (if e.kind == SoundKind::Collapse { 2.0 } else { 0.0 })
            + e.intensity * 4.0
            - d.ln_1p() * 1.4
    }

    fn cell(e: &SoundEvent) -> u64 {
        if e.protected || e.kind == SoundKind::Shot {
            return e.id;
        }
        let f = |v: f32| ((v / 5.0).floor() as i64) as u64;
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for part in [
            e.kind as u64,
            e.material as u64,
            f(e.position.x),
            f(e.position.y),
            f(e.position.z),
            (e.at_ms / 65.0).floor() as i64 as u64,
        ] {
            h = (h ^ part).wrapping_mul(0x0100_0000_01b3);
        }
        h | 1 << 63
    }

    pub fn enqueue(&mut self, e: SoundEvent) {
        self.received += 1;
        if !(e.at_ms.is_finite() && e.position.is_finite() && e.intensity.is_finite()) {
            self.dropped += 1;
            return;
        }
        if self.recent.contains_key(&e.id) {
            self.grouped += 1;
            return;
        }
        let cell = Self::cell(&e);
        if let Some((old, _)) = self.pending.get_mut(&cell) {
            self.grouped += 1;
            if e.intensity > old.intensity {
                *old = SoundEvent { intensity: clamp01(e.intensity + 0.035), ..e };
            }
            return;
        }
        if self.pending.len() >= self.capacity {
            self.dropped += 1;
            let score = self.score(&e);
            let weakest = self
                .pending
                .iter()
                .min_by(|a, b| self.score(&a.1 .0).total_cmp(&self.score(&b.1 .0)).then(a.1 .1.cmp(&b.1 .1)))
                .map(|(k, (ev, _))| (*k, self.score(ev)));
            match weakest {
                Some((key, weakest_score)) if score > weakest_score => {
                    self.pending.remove(&key);
                }
                _ => return,
            }
        }
        self.order += 1;
        self.pending.insert(cell, (e, self.order));
    }

    /// Events due by `now_ms`, strongest first, at most `per_frame`.
    pub fn drain(&mut self, now_ms: f64, mut play: impl FnMut(&SoundEvent)) {
        let mut due: Vec<(SoundEvent, u64, f32)> = Vec::new();
        let keys: Vec<u64> = self.pending.keys().copied().collect();
        for key in keys {
            let (e, order) = self.pending[&key];
            if e.at_ms > now_ms + 35.0 {
                continue;
            }
            self.pending.remove(&key);
            if now_ms - e.at_ms > 300.0 {
                self.stale += 1;
                continue;
            }
            if e.position.distance(self.listener) > 450.0 && !e.protected {
                self.dropped += 1;
                continue;
            }
            let score = self.score(&e);
            due.push((e, order, score));
        }
        due.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.seed.cmp(&b.0.seed)).then(a.1.cmp(&b.1)));
        for (i, (e, _, _)) in due.iter().enumerate() {
            if i >= self.per_frame {
                self.dropped += 1;
                continue;
            }
            self.recent.insert(e.id, now_ms);
            self.selected += 1;
            play(e);
        }
        self.recent.retain(|_, t| now_ms - *t <= 2500.0);
    }

    pub fn queued(&self) -> usize {
        self.pending.len()
    }
}

/// `soundFromShot` (gameEvents.ts): rifle and cannon shots (meteors are silent until impact).
pub fn sound_from_shot(shooter: u32, shot_id: u32, weapon: u8, origin: Vec3, at_ms: f64) -> Option<SoundEvent> {
    use vibe_land_shared::constants::{WEAPON_CANNONBALL, WEAPON_METEOR};
    if weapon == WEAPON_METEOR {
        return None;
    }
    let cannon = weapon == WEAPON_CANNONBALL;
    Some(SoundEvent {
        id: (u64::from(shooter) << 32 | u64::from(shot_id)) ^ 0x5307_0000_0000_0000,
        kind: SoundKind::Shot,
        position: origin,
        material: AcousticMaterial::Metal,
        intensity: if cannon { 0.85 } else { 0.3 },
        size: if cannon { 1.0 } else { 0.1 },
        seed: shot_id,
        at_ms,
        protected: false,
    })
}

/// One server audio contact (packet 131, server/src/contact_audio.rs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioContact {
    pub sim_tick: u32,
    pub entity_a: u32,
    pub entity_b: u32,
    pub scrape: bool,
    pub position: Vec3,
    pub normal: Vec3,
    pub normal_speed: f32,
    pub tangent_speed: f32,
    pub intensity: f32,
    pub size: f32,
}

pub const AUDIO_CONTACT_RECORD_BYTES: usize = 52;
pub const AUDIO_CONTACT_MAX_RECORDS: usize = 16;

/// `decodeAudioContacts` (contactStream.ts): the whole packet or nothing, with the same checks.
pub fn decode_audio_contacts(bytes: &[u8]) -> Option<Vec<AudioContact>> {
    use vibe_land_shared::constants::PKT_AUDIO_CONTACTS;
    if bytes.len() < 8 || bytes[0] != PKT_AUDIO_CONTACTS || bytes[1] != 1 || bytes[3] != 0 {
        return None;
    }
    let count = usize::from(bytes[2]);
    if count > AUDIO_CONTACT_MAX_RECORDS || bytes.len() != 8 + count * AUDIO_CONTACT_RECORD_BYTES {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let sim_tick = u32_at(4);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let o = 8 + i * AUDIO_CONTACT_RECORD_BYTES;
        if bytes[o + 8] > 1 || bytes[o + 9] != 0 || u16::from_le_bytes([bytes[o + 10], bytes[o + 11]]) != 0 {
            return None;
        }
        let f: Vec<f32> = (0..10).map(|n| f32_at(o + 12 + n * 4)).collect();
        let normal = Vec3::new(f[3], f[4], f[5]);
        if !f.iter().all(|x| x.is_finite()) || f[6..].iter().any(|x| *x < 0.0) || f[8] > 1.0 || f[9] > 100.0 || f[6] > 10000.0 || f[7] > 10000.0 || normal.length() > 1.01 {
            return None;
        }
        out.push(AudioContact {
            sim_tick,
            entity_a: u32_at(o),
            entity_b: u32_at(o + 4),
            scrape: bytes[o + 8] == 1,
            position: Vec3::new(f[0], f[1], f[2]),
            normal,
            normal_speed: f[6],
            tangent_speed: f[7],
            intensity: f[8],
            size: f[9],
        });
    }
    Some(out)
}

/// An impact contact as a sound (GameAudioLayer.tsx): concrete unless the caller knows better, a
/// meteor's hard hit (> 12 m/s) as a protected collapse.
pub fn sound_from_contact(c: &AudioContact, material: AcousticMaterial, meteor: bool, at_ms: f64) -> Option<SoundEvent> {
    if c.scrape {
        return None; // continuous scrapes are not one-shots (not ported yet)
    }
    let hard = meteor && c.normal_speed > 12.0;
    let (lo, hi) = (c.entity_a.min(c.entity_b), c.entity_a.max(c.entity_b));
    Some(SoundEvent {
        id: (u64::from(lo) << 32 | u64::from(hi)) ^ (u64::from(c.sim_tick) << 17) ^ 0xC047_0000_0000_0000,
        kind: if hard { SoundKind::Collapse } else { SoundKind::Impact },
        position: c.position,
        material,
        intensity: c.intensity,
        size: c.size,
        seed: c.sim_tick ^ c.entity_a,
        at_ms,
        protected: hard,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures from the TypeScript (client/src/audio: model.ts, destructionMix.ts, settings.ts),
    // computed with tsx.
    #[test]
    fn seed_random_matches_the_web() {
        let mut r = SeedRandom::new(42);
        for web in [0.002643892541527748f32, 0.660311977379024, 0.11095708678476512] {
            assert!((r.next() - web).abs() < 1e-6);
        }
    }

    #[test]
    fn intensity_mix_and_attenuation_match_the_web() {
        for ((impulse, mass), web) in [((100.0, 20.0), 0.3602537029958145f32), ((6000.0, 1000.0), 0.8640634813191876), ((0.5, 2.0), 0.02420852781712335)] {
            assert!((physical_intensity(impulse, mass) - web).abs() < 1e-5, "{impulse} {mass}");
        }
        let e = |intensity: f32, size: f32, material| SoundEvent { id: 0, kind: SoundKind::Impact, position: Vec3::ZERO, material, intensity, size, seed: 1, at_ms: 0.0, protected: false };
        for (ev, web) in [
            (e(0.5, 2.0, AcousticMaterial::Concrete), [0.7336904908668845f32, 0.3052538925934075, 0.1700877465851643, 0.42826034512599565]),
            (e(0.9, 6.0, AcousticMaterial::Metal), [1.1800029979520743, 1.4012535600680884, 0.25566731622294947, 1.0]),
            (e(0.7, 3.0, AcousticMaterial::Glass), [1.2275366695007313, 0.0, 0.2946088006801755, 0.0]),
        ] {
            let (h, b, d, w) = event_mix(&ev, DEFAULT_MIX);
            for (got, want) in [h, b, d, w].iter().zip(web) {
                assert!((got - want).abs() < 1e-5, "{got} vs {want}");
            }
        }
        for ((d, s), web) in [((10.0, 1.0), 0.5855752286723703f32), ((80.0, 4.0), 0.15798061053718054), ((300.0, 8.0), 0.05064991105283304)] {
            assert!((source_attenuation(d, s) - web).abs() < 1e-6);
        }
    }

    #[test]
    fn acoustic_materials_follow_names() {
        assert_eq!(acoustic_material("glass", 0.0), AcousticMaterial::Glass);
        assert_eq!(acoustic_material("wood-frame", 0.0), AcousticMaterial::Wood);
        assert_eq!(acoustic_material("steel", 0.0), AcousticMaterial::Metal);
        assert_eq!(acoustic_material("reinforced-concrete", 0.0), AcousticMaterial::Concrete);
        assert_eq!(acoustic_material("anything", 0.9), AcousticMaterial::Metal);
        assert_eq!(acoustic_material("stone", 0.0), AcousticMaterial::Stone);
    }

    #[test]
    fn every_voice_names_a_clip_in_the_catalog() {
        let clips = Clips::get();
        for kind in [SoundKind::Impact, SoundKind::Fracture, SoundKind::Collapse, SoundKind::Shot] {
            for material in [
                AcousticMaterial::Concrete,
                AcousticMaterial::Stone,
                AcousticMaterial::Metal,
                AcousticMaterial::Sheet,
                AcousticMaterial::Wood,
                AcousticMaterial::Glass,
                AcousticMaterial::Earth,
            ] {
                for seed in 1..40u32 {
                    for (intensity, size) in [(0.1, 0.2), (0.9, 5.0)] {
                        let e = SoundEvent { id: 1, kind, position: Vec3::ZERO, material, intensity, size, seed, at_ms: 0.0, protected: false };
                        let mut out = Vec::new();
                        voices(&e, Vec3::new(3.0, 0.0, 0.0), 0.0, DEFAULT_MIX, &mut out);
                        assert!(!out.is_empty(), "{kind:?} {material:?} seed {seed}: no voice");
                        for v in &out {
                            assert!((v.clip as usize) < clips.ids.len());
                            assert!(v.gain > 0.0 && v.gain <= 3.0 && v.rate > 0.5 && v.rate < 1.5);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn director_groups_nearby_events_and_caps_per_frame() {
        let mut d = AudioDirector::default();
        for i in 0..40u64 {
            // 40 impacts spread over 200 m: none share a 5 m cell.
            d.enqueue(SoundEvent {
                id: i,
                kind: SoundKind::Impact,
                position: Vec3::new(i as f32 * 5.0, 0.0, 0.0),
                material: AcousticMaterial::Concrete,
                intensity: 0.5,
                size: 1.0,
                seed: i as u32,
                at_ms: 0.0,
                protected: false,
            });
        }
        // Two more in the first event's cell merge into it.
        for id in [100, 101] {
            d.enqueue(SoundEvent {
                id,
                kind: SoundKind::Impact,
                position: Vec3::new(1.0, 0.0, 0.0),
                material: AcousticMaterial::Concrete,
                intensity: 0.9,
                size: 1.0,
                seed: 7,
                at_ms: 10.0,
                protected: false,
            });
        }
        assert_eq!(d.queued(), 40);
        assert_eq!(d.grouped, 2);
        let mut played = Vec::new();
        d.drain(20.0, |e| played.push(*e));
        assert_eq!(played.len(), 12, "per-frame cap");
        // Nearest (and the merged, louder one) first.
        assert!(played[0].position.x < 10.0);
        // Already played ids are grouped if they come again.
        d.enqueue(played[0]);
        assert_eq!(d.grouped, 3);
    }

    #[test]
    fn audio_contacts_decode_and_reject_malformed() {
        let mut b = vec![131u8, 1, 1, 0];
        b.extend_from_slice(&77u32.to_le_bytes());
        b.extend_from_slice(&5u32.to_le_bytes());
        b.extend_from_slice(&9u32.to_le_bytes());
        b.extend_from_slice(&[0, 0, 0, 0]);
        for f in [1.0f32, 2.0, 3.0, 0.0, 1.0, 0.0, 6.0, 0.5, 0.7, 1.2] {
            b.extend_from_slice(&f.to_le_bytes());
        }
        let c = decode_audio_contacts(&b).expect("valid");
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].sim_tick, c[0].entity_a, c[0].entity_b), (77, 5, 9));
        assert_eq!(c[0].position, Vec3::new(1.0, 2.0, 3.0));
        let mut bad = b.clone();
        bad[8 + 12 + 8 * 4..8 + 12 + 9 * 4].copy_from_slice(&1.5f32.to_le_bytes()); // intensity > 1
        assert!(decode_audio_contacts(&bad).is_none());
        assert!(decode_audio_contacts(&b[..b.len() - 1]).is_none());
    }
}
