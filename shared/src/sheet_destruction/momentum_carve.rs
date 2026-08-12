//! Soft breaker↔sheet carving via Rapier `PhysicsHooks`.
//!
//! Thin sheets (drywall / wood / plaster) hard-stop a vehicle in the impulse
//! solver *before* a post-step carve can open a hole. Instead:
//!
//! 1. Sheet colliders opt into `ActiveHooks::MODIFY_SOLVER_CONTACTS`.
//! 2. During the dynamics step, [`SoftSheetHook`] recognizes breaker↔sheet
//!    pairs that can cut, records impact data, then
//!    `solver_contacts.clear()` so that pair is sensor-like for the solve.
//! 3. After the step, the same deterministic [`CarveEvent`] path as bullets
//!    opens the hole (and rebuilds coarse collision).
//!
//! A short velocity ray sweep remains only as a tunneling fallback when a
//! discrete step never produces a contact manifold through a ~16 cm wall.
//!
//! Feature flag: built-in `SHEET_MOMENTUM_CARVE` (default **on**). Set env
//! `SHEET_MOMENTUM_CARVE=0`/`false`/`off` to disable.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use nalgebra::Vector3;
use rapier3d::prelude::{
    ActiveHooks, ColliderHandle, ContactModificationContext, PhysicsHooks, RigidBodyHandle,
};
use vibe_netcode::sim_world::SimWorld;

use crate::physics_arena::TerrainMaterialHook;
use crate::world_document::TerrainMaterialField;

use super::carve::CarveEvent;
use super::registry::{SheetInstance, SheetRegistry};

/// Built-in default. Flip to `false` to disable at source.
pub const SHEET_MOMENTUM_CARVE: bool = true;

/// High bit on sheet collider `user_data` (bit 126). Terrain uses bit 127.
/// Low 32 bits remain the sheet id.
pub const SHEET_SOFT_USER_DATA_FLAG: u128 = 1u128 << 126;

/// Effective mass encoded on the wire (≤ 65.535 kg u16 grams). Tuned so a
/// car at ~8–15 m/s punches a doorway-sized hole in drywall without needing
/// true chassis mass on the protocol.
pub const VEHICLE_CARVE_EFF_MASS_KG: f32 = 48.0;
pub const VEHICLE_CARVE_FOOTPRINT_M: f32 = 0.28;
pub const VEHICLE_CARVE_MIN_SPEED_MPS: f32 = 4.0;

pub const DYNAMIC_CARVE_EFF_MASS_KG: f32 = 28.0;
pub const DYNAMIC_CARVE_FOOTPRINT_M: f32 = 0.16;
pub const DYNAMIC_CARVE_MIN_SPEED_MPS: f32 = 5.0;

/// Ticks between carves for the same (striker, sheet) pair @ 60 Hz.
pub const MOMENTUM_CARVE_COOLDOWN_TICKS: u32 = 6;
/// Hard cap per sim tick (map-scale spam guard).
pub const MOMENTUM_CARVE_MAX_PER_TICK: usize = 6;

pub fn sheet_momentum_carve_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        if !SHEET_MOMENTUM_CARVE {
            return false;
        }
        #[cfg(target_arch = "wasm32")]
        {
            true
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            match std::env::var("SHEET_MOMENTUM_CARVE") {
                Ok(v) => {
                    let v = v.trim().to_ascii_lowercase();
                    !matches!(v.as_str(), "0" | "false" | "off" | "no")
                }
                Err(_) => true,
            }
        }
    })
}

#[inline]
pub fn tag_sheet_soft_user_data(sheet_id: u32) -> u128 {
    (sheet_id as u128) | SHEET_SOFT_USER_DATA_FLAG
}

#[inline]
pub fn is_sheet_soft_collider(user_data: u128) -> bool {
    user_data & SHEET_SOFT_USER_DATA_FLAG != 0
}

#[inline]
pub fn sheet_id_from_user_data(user_data: u128) -> u32 {
    (user_data & 0xffff_ffff) as u32
}

/// Active hooks required on every soft-sheet collider.
pub const SHEET_SOFT_ACTIVE_HOOKS: ActiveHooks = ActiveHooks::MODIFY_SOLVER_CONTACTS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MomentumStrikerKind {
    Vehicle = 0,
    Dynamic = 1,
}

#[derive(Clone, Debug)]
pub struct MomentumSheetImpact {
    pub sheet_id: u32,
    pub striker_kind: MomentumStrikerKind,
    pub striker_id: u32,
    pub point: [f32; 3],
    pub normal_sheet_out: [f32; 3],
    pub velocity: [f32; 3],
    pub normal_speed: f32,
    pub mass_or_energy: f32,
    pub footprint_radius: f32,
}

pub struct MomentumCarveCooldown {
    /// (kind as u8, striker_id, sheet_id) → next allowed tick.
    next_allowed: HashMap<(u8, u32, u32), u32>,
}

impl Default for MomentumCarveCooldown {
    fn default() -> Self {
        Self {
            next_allowed: HashMap::new(),
        }
    }
}

impl MomentumCarveCooldown {
    pub fn allow(
        &mut self,
        kind: MomentumStrikerKind,
        striker_id: u32,
        sheet_id: u32,
        tick: u32,
    ) -> bool {
        let key = (kind as u8, striker_id, sheet_id);
        if let Some(&next) = self.next_allowed.get(&key) {
            if tick < next {
                return false;
            }
        }
        self.next_allowed
            .insert(key, tick.saturating_add(MOMENTUM_CARVE_COOLDOWN_TICKS));
        true
    }

    pub fn retain_recent(&mut self, tick: u32) {
        self.next_allowed.retain(|_, next| *next + 120 > tick);
    }
}

/// Build reverse map collider handle → sheet id.
pub fn sheet_collider_index(
    sheet_colliders: &HashMap<u32, Vec<ColliderHandle>>,
) -> HashMap<ColliderHandle, u32> {
    let mut out = HashMap::new();
    for (&sheet_id, handles) in sheet_colliders {
        for &h in handles {
            out.insert(h, sheet_id);
        }
    }
    out
}

#[derive(Clone, Copy)]
pub struct StrikerRef {
    pub kind: MomentumStrikerKind,
    pub id: u32,
    pub collider: ColliderHandle,
    pub body: RigidBodyHandle,
}

/// Convert a contact impact into a carve event for the given sheet.
pub fn impact_to_carve_event(sheet: &SheetInstance, impact: &MomentumSheetImpact) -> CarveEvent {
    let uv = sheet.frame.world_to_uv(impact.point);
    let au = sheet.frame.axis_u;
    let av = sheet.frame.axis_v;
    let dir_uv = [
        impact.velocity[0] * au[0] + impact.velocity[1] * au[1] + impact.velocity[2] * au[2],
        impact.velocity[0] * av[0] + impact.velocity[1] * av[1] + impact.velocity[2] * av[2],
    ];
    let seed = (impact.striker_id)
        .wrapping_mul(0x9e37_79b9)
        .wrapping_add(impact.sheet_id)
        .wrapping_add(impact.uv_seed_bits().wrapping_mul(0x85eb_ca6b));
    CarveEvent {
        sheet_id: impact.sheet_id,
        seq: sheet.mask.seq.saturating_add(1),
        uv,
        dir_uv,
        normal_speed: impact.normal_speed,
        mass_or_energy: impact.mass_or_energy,
        footprint_radius: impact.footprint_radius,
        seed,
    }
}

impl MomentumSheetImpact {
    fn uv_seed_bits(&self) -> u32 {
        let x = (self.point[0] * 100.0).round() as i32 as u32;
        let y = (self.point[1] * 100.0).round() as i32 as u32;
        let z = (self.point[2] * 100.0).round() as i32 as u32;
        x.wrapping_mul(73856093)
            .wrapping_add(y.wrapping_mul(19349663))
            .wrapping_add(z.wrapping_mul(83492791))
    }
}

fn striker_params(kind: MomentumStrikerKind) -> (f32, f32, f32) {
    match kind {
        MomentumStrikerKind::Vehicle => (
            VEHICLE_CARVE_MIN_SPEED_MPS,
            VEHICLE_CARVE_EFF_MASS_KG,
            VEHICLE_CARVE_FOOTPRINT_M,
        ),
        MomentumStrikerKind::Dynamic => (
            DYNAMIC_CARVE_MIN_SPEED_MPS,
            DYNAMIC_CARVE_EFF_MASS_KG,
            DYNAMIC_CARVE_FOOTPRINT_M,
        ),
    }
}

/// Clears solver contacts for breaker↔sheet pairs that can cut, recording
/// carve inputs. Compose with [`TerrainAndSoftSheetHook`] when a terrain
/// material field is present.
pub struct SoftSheetHook<'a> {
    pub breakers: &'a HashMap<ColliderHandle, StrikerRef>,
    pub impacts: &'a Mutex<Vec<MomentumSheetImpact>>,
}

impl PhysicsHooks for SoftSheetHook<'_> {
    fn modify_solver_contacts(&self, context: &mut ContactModificationContext) {
        if self.breakers.is_empty() {
            return;
        }
        let Some(c1) = context.colliders.get(context.collider1) else {
            return;
        };
        let Some(c2) = context.colliders.get(context.collider2) else {
            return;
        };

        let (sheet_ud, striker_handle, sheet_is_c1) = if is_sheet_soft_collider(c1.user_data) {
            (c1.user_data, context.collider2, true)
        } else if is_sheet_soft_collider(c2.user_data) {
            (c2.user_data, context.collider1, false)
        } else {
            return;
        };

        let Some(&striker) = self.breakers.get(&striker_handle) else {
            // Player / non-breaker vs sheet: keep hard contacts.
            return;
        };

        let Some(rb) = context.bodies.get(striker.body) else {
            return;
        };
        let vel = *rb.linvel();
        let speed = vel.norm();
        let (min_speed, mass, footprint) = striker_params(striker.kind);
        if speed < min_speed {
            return;
        }

        let mut n = *context.normal;
        if !sheet_is_c1 {
            n = -n;
        }
        let n_len = n.norm();
        if n_len < 1e-5 {
            return;
        }
        let n = n / n_len;
        let normal_speed = vel.dot(&n).abs().max(speed * 0.35);
        if normal_speed < min_speed {
            return;
        }

        let sheet_id = sheet_id_from_user_data(sheet_ud);
        let point = context
            .solver_contacts
            .iter()
            .max_by(|a, b| {
                (-a.dist)
                    .partial_cmp(&(-b.dist))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|sc| [sc.point.x, sc.point.y, sc.point.z])
            .unwrap_or_else(|| {
                // Degenerate: still soft-pass using body translation.
                let p = *rb.translation();
                [p.x, p.y, p.z]
            });

        if let Ok(mut impacts) = self.impacts.lock() {
            impacts.push(MomentumSheetImpact {
                sheet_id,
                striker_kind: striker.kind,
                striker_id: striker.id,
                point,
                normal_sheet_out: [n.x, n.y, n.z],
                velocity: [vel.x, vel.y, vel.z],
                normal_speed,
                mass_or_energy: mass,
                footprint_radius: footprint,
            });
        }

        // Sensor-like for this pair only: no hard stop this substep.
        context.solver_contacts.clear();
    }
}

/// Terrain friction rewrite + soft sheet pass-through in one hook object.
pub struct TerrainAndSoftSheetHook<'a> {
    pub terrain: Option<TerrainMaterialHook<'a>>,
    pub soft: SoftSheetHook<'a>,
}

impl<'a> TerrainAndSoftSheetHook<'a> {
    pub fn new(
        field: Option<&'a TerrainMaterialField>,
        breakers: &'a HashMap<ColliderHandle, StrikerRef>,
        impacts: &'a Mutex<Vec<MomentumSheetImpact>>,
    ) -> Self {
        Self {
            terrain: field.map(TerrainMaterialHook::new),
            soft: SoftSheetHook { breakers, impacts },
        }
    }
}

impl PhysicsHooks for TerrainAndSoftSheetHook<'_> {
    fn modify_solver_contacts(&self, context: &mut ContactModificationContext) {
        if let Some(terrain) = &self.terrain {
            terrain.modify_solver_contacts(context);
        }
        self.soft.modify_solver_contacts(context);
    }
}

/// Dedup + cooldown filter for impacts recorded during the dynamics step.
pub fn finalize_soft_sheet_impacts(
    raw: Vec<MomentumSheetImpact>,
    sheets: &SheetRegistry,
    cooldown: &mut MomentumCarveCooldown,
    tick: u32,
) -> Vec<MomentumSheetImpact> {
    cooldown.retain_recent(tick);
    let mut out = Vec::new();
    let mut seen: HashSet<(u8, u32, u32)> = HashSet::new();
    for impact in raw {
        if !sheets.contains(impact.sheet_id) {
            continue;
        }
        let key = (
            impact.striker_kind as u8,
            impact.striker_id,
            impact.sheet_id,
        );
        if !seen.insert(key) {
            continue;
        }
        if !cooldown.allow(
            impact.striker_kind,
            impact.striker_id,
            impact.sheet_id,
            tick,
        ) {
            continue;
        }
        out.push(impact);
        if out.len() >= MOMENTUM_CARVE_MAX_PER_TICK {
            break;
        }
    }
    out
}

/// Tunneling fallback: velocity ray when soft contacts never fired for a
/// fast breaker (thin wall crossed in one discrete step).
pub fn sample_tunnel_sheet_impacts(
    sim: &SimWorld,
    sheet_by_handle: &HashMap<ColliderHandle, u32>,
    strikers: &[StrikerRef],
    sheets: &SheetRegistry,
    already: &HashSet<(u8, u32, u32)>,
    cooldown: &mut MomentumCarveCooldown,
    tick: u32,
    dt: f32,
    budget: usize,
) -> Vec<MomentumSheetImpact> {
    if budget == 0 || strikers.is_empty() || sheet_by_handle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut seen = already.clone();

    for striker in strikers {
        let Some(rb) = sim.rigid_bodies.get(striker.body) else {
            continue;
        };
        let vel = *rb.linvel();
        let speed = vel.norm();
        let (min_speed, mass, footprint) = striker_params(striker.kind);
        if speed < min_speed {
            continue;
        }
        let dir = vel / speed;
        let pos = *rb.translation();
        let sweep = (speed * dt * 2.5).max(0.45).min(4.0);
        let origin = [
            pos.x - dir.x * 0.25,
            pos.y - dir.y * 0.25,
            pos.z - dir.z * 0.25,
        ];
        let Some(hit) = sim.cast_ray_detailed(
            origin,
            [dir.x, dir.y, dir.z],
            sweep + 0.25,
            Some(striker.collider),
        ) else {
            continue;
        };
        let Some(&sheet_id) = sheet_by_handle.get(&hit.handle) else {
            continue;
        };
        if !sheets.contains(sheet_id) {
            continue;
        }
        let key = (striker.kind as u8, striker.id, sheet_id);
        if !seen.insert(key) {
            continue;
        }
        if !cooldown.allow(striker.kind, striker.id, sheet_id, tick) {
            continue;
        }
        let n = Vector3::new(hit.normal[0], hit.normal[1], hit.normal[2]);
        let n_len = n.norm();
        let n = if n_len > 1e-5 { n / n_len } else { -dir };
        let normal_speed = vel.dot(&n).abs().max(speed * 0.5);
        if normal_speed < min_speed {
            continue;
        }
        let point = [
            origin[0] + dir.x * hit.toi,
            origin[1] + dir.y * hit.toi,
            origin[2] + dir.z * hit.toi,
        ];
        out.push(MomentumSheetImpact {
            sheet_id,
            striker_kind: striker.kind,
            striker_id: striker.id,
            point,
            normal_sheet_out: [n.x, n.y, n.z],
            velocity: [vel.x, vel.y, vel.z],
            normal_speed,
            mass_or_energy: mass,
            footprint_radius: footprint,
        });
        if out.len() >= budget {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_document::{StaticProp, StaticPropKind};

    fn drywall_sheet() -> SheetInstance {
        let prop = StaticProp {
            id: 1,
            kind: StaticPropKind::Cuboid,
            position: [0.0, 1.4, 0.0],
            rotation: [0.0, 0.0, 0.0, 1.0],
            half_extents: [0.08, 1.4, 2.0],
            material: Some("drywall".into()),
        };
        SheetRegistry::from_static_props(&[prop])
            .get(1)
            .cloned()
            .expect("sheet")
    }

    #[test]
    fn vehicle_impact_builds_event_with_blunt_footprint() {
        let sheet = drywall_sheet();
        let impact = MomentumSheetImpact {
            sheet_id: 1,
            striker_kind: MomentumStrikerKind::Vehicle,
            striker_id: 3,
            point: sheet.frame.uv_to_world([2.0, 1.2]),
            normal_sheet_out: sheet.frame.axis_thickness,
            velocity: [
                sheet.frame.axis_thickness[0] * -12.0,
                sheet.frame.axis_thickness[1] * -12.0,
                sheet.frame.axis_thickness[2] * -12.0,
            ],
            normal_speed: 12.0,
            mass_or_energy: VEHICLE_CARVE_EFF_MASS_KG,
            footprint_radius: VEHICLE_CARVE_FOOTPRINT_M,
        };
        let event = impact_to_carve_event(&sheet, &impact);
        assert_eq!(event.sheet_id, 1);
        assert!(event.footprint_radius > 0.1);
        assert!(event.mass_or_energy * event.normal_speed > 100.0);
        assert!((event.uv[0] - 2.0).abs() < 0.1);
        assert!((event.uv[1] - 1.2).abs() < 0.1);
    }

    #[test]
    fn cooldown_blocks_scrape_spam() {
        let mut cd = MomentumCarveCooldown::default();
        assert!(cd.allow(MomentumStrikerKind::Vehicle, 1, 10, 100));
        assert!(!cd.allow(MomentumStrikerKind::Vehicle, 1, 10, 101));
        assert!(cd.allow(
            MomentumStrikerKind::Vehicle,
            1,
            10,
            100 + MOMENTUM_CARVE_COOLDOWN_TICKS
        ));
    }

    #[test]
    fn sheet_user_data_roundtrip() {
        let ud = tag_sheet_soft_user_data(42);
        assert!(is_sheet_soft_collider(ud));
        assert_eq!(sheet_id_from_user_data(ud), 42);
        assert!(!is_sheet_soft_collider(42));
    }
}
