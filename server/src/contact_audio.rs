//! Bounded summaries of existing PhysX contact reports. No extra scene query,
//! GPU readback, or event per contact on the wire. Native GPU chunks suppress
//! CPU reports and intentionally retain client pose/destruction fallbacks.

use std::collections::HashMap;
use vibe_land_shared::constants::PKT_AUDIO_CONTACTS;

pub const MAX_CONTACTS_PER_TICK: usize = 8192;
const MAX_CLUSTERS: usize = 512;
const MAX_PAIR_HISTORY: usize = 2048;
const MAX_RECORDS: usize = 16;
const RECORD_BYTES: usize = 52;

#[derive(Clone, Copy, Debug, Default)]
pub struct ContactSample {
    pub entity_a: u32,
    pub entity_b: u32,
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub normal_speed: f32,
    pub tangent_speed: f32,
    pub impulse: f32,
    /// Reduced translational mass. Used for perceptual scale, not a full
    /// rotational effective-mass solve or a material classification.
    pub effective_mass: f32,
}

#[derive(Clone, Copy)]
struct Cluster {
    cell: [i32; 3],
    kind: u8,
    sample: ContactSample,
    energy: f32,
}

pub struct ContactAudioReducer {
    // Direct-mapped cells keep both memory and overload insertion O(1).
    // Hash collisions keep the more energetic region during this 50 ms window.
    clusters: Vec<Option<Cluster>>,
    pair_history: HashMap<(u32, u32), u32>,
}
impl Default for ContactAudioReducer {
    fn default() -> Self {
        Self { clusters: vec![None; MAX_CLUSTERS], pair_history: HashMap::new() }
    }
}

impl ContactAudioReducer {
    pub fn ingest(&mut self, tick: u32, samples: impl IntoIterator<Item = ContactSample>) {
        self.pair_history.retain(|_, last| tick.wrapping_sub(*last) < 12);
        for s in samples.into_iter().take(MAX_CONTACTS_PER_TICK) {
            if !s.position.iter().chain(s.normal.iter()).all(|x| x.is_finite())
                || ![s.normal_speed, s.tangent_speed, s.impulse, s.effective_mass].iter().all(|x| x.is_finite() && *x >= 0.)
                || s.impulse <= 0.05 || s.effective_mass <= 0.
            { continue; }
            // Gravity adds ~0.164 m/s per 60 Hz step even to a resting body.
            // Support impulse alone is never an impact signal.
            let kind = if s.normal_speed >= 0.7 { 0 } else if s.tangent_speed >= 0.25 { 1 } else { continue; };
            let pair = (s.entity_a.min(s.entity_b), s.entity_a.max(s.entity_b));
            if kind == 0 {
                if self.pair_history.get(&pair).is_some_and(|last| tick.wrapping_sub(*last) < 6) { continue; }
                if self.pair_history.len() < MAX_PAIR_HISTORY || self.pair_history.contains_key(&pair) {
                    self.pair_history.insert(pair, tick);
                }
            }
            let speed = if kind == 0 { s.normal_speed } else { s.tangent_speed * 0.3 };
            let energy = (0.5 * s.effective_mass.min(1e7) * speed.min(1e4).powi(2)).min(1e10);
            let cell = s.position.map(|x| (x / 6.).floor() as i32);
            let hash = (cell[0] as u32).wrapping_mul(73856093) ^ (cell[1] as u32).wrapping_mul(19349663) ^ (cell[2] as u32).wrapping_mul(83492791) ^ (kind as u32).wrapping_mul(2654435761);
            let slot = &mut self.clusters[hash as usize % MAX_CLUSTERS];
            match slot {
                Some(c) if c.cell == cell && c.kind == kind => {
                    // Keep a real position and participant IDs, never fabricate
                    // a centroid floating between two actual surfaces.
                    if energy > c.energy { c.sample = s; }
                    c.energy = (c.energy + energy * 0.2).min(1e10);
                }
                Some(c) if c.energy >= energy => {}
                _ => *slot = Some(Cluster { cell, kind, sample: s, energy }),
            }
        }
    }

    /// Called at 20 Hz. At most 840 bytes/recipient. Selecting after reduction
    /// keeps per-listener cost independent of the original contact count.
    pub fn packet_for(&self, tick: u32, listener: [f32; 3]) -> Option<Vec<u8>> {
        if !listener.iter().all(|x| x.is_finite()) { return None; }
        let mut ranked: Vec<_> = self.clusters.iter().flatten().filter_map(|c| {
            let distance_sq: f32 = c.sample.position.iter().zip(listener).map(|(a,b)| (a-b).powi(2)).sum();
            if distance_sq > 200. * 200. { return None; }
            Some((c.energy.ln_1p() / (1. + distance_sq / 64.), c))
        }).collect();
        ranked.sort_by(|a,b| b.0.total_cmp(&a.0).then_with(|| a.1.sample.entity_a.cmp(&b.1.sample.entity_a)));
        ranked.truncate(MAX_RECORDS);
        if ranked.is_empty() { return None; }
        let mut out = Vec::with_capacity(8 + ranked.len() * RECORD_BYTES);
        out.extend_from_slice(&[PKT_AUDIO_CONTACTS, 1, ranked.len() as u8, 0]);
        out.extend_from_slice(&tick.to_le_bytes());
        for (_, c) in ranked {
            let s = c.sample;
            out.extend_from_slice(&s.entity_a.to_le_bytes());
            out.extend_from_slice(&s.entity_b.to_le_bytes());
            out.extend_from_slice(&[c.kind, 0, 0, 0]); // Material unknown, reserved.
            let normal_length = s.normal.iter().map(|x| x*x).sum::<f32>().sqrt();
            let normal = if normal_length > 1e-6 { s.normal.map(|x| x/normal_length) } else { [0.,1.,0.] };
            let intensity = (c.energy.ln_1p() / 16.).clamp(0.,1.);
            let size = (s.effective_mass / 1000.).cbrt().clamp(0.05,100.);
            for f in s.position.into_iter().chain(normal).chain([s.normal_speed.min(1e4), s.tangent_speed.min(1e4), intensity, size]) {
                out.extend_from_slice(&f.to_le_bytes());
            }
        }
        Some(out)
    }

    pub fn clear_window(&mut self) { self.clusters.fill(None); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(x: f32, normal_speed: f32, tangent_speed: f32) -> ContactSample {
        ContactSample { entity_a: x.abs() as u32 + 1, entity_b: 0, position: [x,0.,0.], normal: [0.,1.,0.], normal_speed, tangent_speed, impulse: 1000., effective_mass: 100., }
    }
    #[test]
    fn standing_load_is_silent_even_for_huge_impulses() {
        let mut r = ContactAudioReducer::default();
        let mut s = sample(0., 0.164, 0.01); s.impulse = 1e8;
        r.ingest(1, [s]);
        assert!(r.packet_for(3, [0.;3]).is_none());
    }
    #[test]
    fn moving_contacts_survive_but_nan_never_does() {
        let mut r = ContactAudioReducer::default();
        r.ingest(1, [sample(0., 0., 2.), sample(10., 8., 0.), sample(f32::NAN, 8., 0.)]);
        let p = r.packet_for(3, [0.;3]).unwrap();
        assert_eq!(p[2],2);
        assert_eq!(p.len(), 8 + 2*52);
        assert_eq!(&p[..2], &[131, 1]);
    }
    #[test]
    fn packet_and_internal_work_are_bounded() {
        let mut r = ContactAudioReducer::default();
        r.ingest(1, (0..100_000).map(|i| sample((i % 1000) as f32, 3., 0.)));
        let p = r.packet_for(3, [50.,0.,0.]).unwrap();
        assert!(p[2] <= 16 && p.len() <= 1100);
        assert!(r.pair_history.len() <= MAX_PAIR_HISTORY);
        assert!(r.clusters.len() <= MAX_CLUSTERS);
    }
    #[test]
    fn spatial_groups_reduce_dense_manifolds_and_cooldown_stops_machine_gun() {
        let mut r = ContactAudioReducer::default();
        r.ingest(1, (0..100).map(|_| sample(0., 3., 0.)));
        assert_eq!(r.packet_for(3,[0.;3]).unwrap()[2],1);
        r.clear_window();
        r.ingest(4,[sample(0.,3.,0.)]);
        assert!(r.packet_for(6,[0.;3]).is_none());
        r.ingest(10,[sample(0.,3.,0.)]);
        assert!(r.packet_for(12,[0.;3]).is_some());
    }
    #[test]
    fn listener_interest_prefers_nearby_and_window_clear_expires_loops() {
        let mut r = ContactAudioReducer::default();
        r.ingest(1,[sample(-50.,0.,3.),sample(50.,0.,3.)]);
        let p = r.packet_for(3,[49.,0.,0.]).unwrap();
        assert_eq!(f32::from_le_bytes(p[20..24].try_into().unwrap()),50.);
        r.clear_window();
        assert!(r.packet_for(6,[49.,0.,0.]).is_none());
    }
}
