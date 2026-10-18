//! Demolition charges for the calibration structures (structures/calibration,
//! docs/calibration/demolition.md), opt-in: VIBE_CALIB_CHARGES names a JSON
//! file, a list of firings `[{"tick": t, "boxes": [[min, max], ...]}, ...]`.
//! Every box is a member section a charge will cut: a plain static PhysX box
//! (not a stage chunk) that the structure stands on from the first tick, and
//! that is removed at its firing's tick -- the member gone in one tick, as a
//! cutting charge takes it. The structure above loses that support and the
//! stage's stress solve sees it through the contact loads that stop.
//!
//! Coordinates are the scene pack's plus `offset` (the city places a
//! one-structure scene at the origin: offset zero in the app; the GPU harness
//! measures it). Used by the match loop (main.rs, before the city step) and by
//! server/src/calibration.rs.
#![cfg(feature = "physx-city")]

use serde_json::Value;

const FIRST_ID: u32 = 0x00ca_1b00;

pub struct Charges {
    /// (tick, actor ids) per firing.
    firings: Vec<(u32, Vec<u32>)>,
    boxes: Vec<(u32, [f32; 3], [f32; 3])>,
    placed: bool,
}

impl Charges {
    /// From VIBE_CALIB_CHARGES, if set.
    pub fn from_env() -> Option<Self> {
        let path = std::env::var("VIBE_CALIB_CHARGES").ok()?;
        let spec: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("VIBE_CALIB_CHARGES {path}: {e}"))).expect("charges json");
        let (mut firings, mut boxes, mut id) = (Vec::new(), Vec::new(), FIRST_ID);
        for c in spec.as_array().expect("charges: a list") {
            let mut ids = Vec::new();
            for b in c["boxes"].as_array().expect("charge boxes") {
                let v = |k: usize| -> [f32; 3] { let a = b[k].as_array().expect("[min, max]"); [0, 1, 2].map(|i| a[i].as_f64().unwrap() as f32) };
                id += 1;
                boxes.push((id, v(0), v(1)));
                ids.push(id);
            }
            firings.push((c["tick"].as_u64().expect("charge tick") as u32, ids));
        }
        Some(Self { firings, boxes, placed: false })
    }

    /// Place every box (once), then remove those whose firing is at `tick`.
    /// Returns how many supports this tick's firings removed.
    pub fn apply(&mut self, tick: u32, offset: [f32; 3], world: &mut vibe_land_physx_bridge::World) -> usize {
        use vibe_land_physx_bridge::{Pose, Quat, StaticBoxDesc, Vec3};
        if !self.placed {
            for (id, lo, hi) in &self.boxes {
                world.add_static_box(StaticBoxDesc {
                    entity_id: *id,
                    user_id: 0,
                    pose: Pose { position: Vec3::new((lo[0] + hi[0]) / 2. + offset[0], (lo[1] + hi[1]) / 2. + offset[1], (lo[2] + hi[2]) / 2. + offset[2]), rotation: Quat::IDENTITY },
                    half_extents: Vec3::new((hi[0] - lo[0]) / 2., (hi[1] - lo[1]) / 2., (hi[2] - lo[2]) / 2.),
                    collision_group: vibe_land_destruction::bridge_authoring::GROUP_STATIC,
                    collision_mask: u32::MAX,
                }).expect("charge: support box");
            }
            self.placed = true;
        }
        let mut removed = 0;
        for (at, ids) in &self.firings {
            if *at != tick { continue; }
            for id in ids { world.remove_actor(*id).expect("charge: remove support"); removed += 1; }
            world.wake_bodies_near(Vec3::new(offset[0], offset[1], offset[2]), 1.0e4).ok();
            eprintln!("[charges] tick {tick}: fired, {} supports cut", ids.len());
        }
        removed
    }
}

thread_local! {
    static MATCH: std::cell::RefCell<Option<Option<Charges>>> = const { std::cell::RefCell::new(None) };
}

/// The match loop's hook: VIBE_CALIB_CHARGES read once, applied every tick.
pub fn apply_in_match(tick: u32, world: Option<&mut vibe_land_physx_bridge::World>) {
    let Some(world) = world else { return };
    MATCH.with(|m| {
        let mut m = m.borrow_mut();
        if let Some(charges) = m.get_or_insert_with(Charges::from_env).as_mut() {
            charges.apply(tick, [0.0; 3], world);
        }
    });
}
