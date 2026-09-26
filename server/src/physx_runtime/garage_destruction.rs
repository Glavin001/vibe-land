//! Opt-in native destruction for the private garage car
//! (`VIBE_GARAGE_VEHICLE_DESTRUCTION=1`). Chunks keep rigid rest-pose stress
//! geometry; only the wheel and hub hulls follow Vehicle2's suspension each
//! step, excluded from terrain (they must not also stand on the road Vehicle2
//! drives on), so hits land where the wheel is drawn. See
//! docs/reports/vehicle-wheel-colliders-2026-09-26.
use super::bridge;
use crate::vehicle_assets::rig::{inputs_from_vehicle2, source_to_actor, AssetRig, Binding, Motion};
use crate::vehicle_assets::PreparedGeometry;

/// Native structure id of the garage car; must be below 255.
pub const STRUCTURE: u32 = 200;

pub fn requested() -> bool {
    std::env::var("VIBE_GARAGE_VEHICLE_DESTRUCTION").as_deref() == Ok("1")
}

pub struct GarageDestruction {
    pub entity: u32,
    rig: AssetRig,
    wheel_parts: Vec<(usize, u32)>,
    origin_height: f64,
    neutral_jounce: f32,
    configured: bool,
    pub broken_bonds: usize,
    pub rejected_steps: usize,
    detached_count: usize,
}

impl GarageDestruction {
    /// Register a car whose complete hull set is already installed.
    /// Configuration follows the next completed step (GPU identities).
    pub fn register(world: &mut bridge::World, entity: u32, geometry: &PreparedGeometry) -> Result<Self, String> {
        let rig = geometry.rig.clone().ok_or("prepared vehicle has no suspension rig")?;
        let asset = geometry.native_fracture_assembly()?;
        let wheel_parts = geometry.parts.iter().enumerate().filter_map(|(i, p)| {
            match Binding::from_motion(p.motion.as_ref()) {
                Ok(Binding::Corner(corner, Motion::Wheel)) => Some((corner, i as u32)),
                _ => None,
            }
        }).collect();
        world.native_attach().map_err(|e| e.to_string())?;
        world.native_register_vehicle(entity, STRUCTURE, &asset.parts, &asset.bonds,
            bridge::DestructibleSettings { materials: asset.materials, ..Default::default() })
            .map_err(|e| e.to_string())?;
        Ok(Self { entity, rig, wheel_parts, origin_height: geometry.origin_height,
            neutral_jounce: geometry.neutral_jounce, configured: false, broken_bonds: 0, rejected_steps: 0, detached_count: 0 })
    }

    /// Pose wheel and hub hulls from the last completed step's wheels.
    pub fn pose_wheels(&self, world: &mut bridge::World, wheels: Option<[[f32; 4]; 4]>) {
        let Some(wheels) = wheels else { return };
        let wheels: [[f32; 4]; 4] = std::array::from_fn(|i| [wheels[i][0], wheels[i][1], wheels[i][2], 0.]);
        let Ok(deltas) = self.rig.deltas(&inputs_from_vehicle2(&wheels), None) else { return };
        let poses: Vec<bridge::VehiclePartPose> = self.wheel_parts.iter().map(|&(corner, part)| {
            let m = source_to_actor(&deltas.get(Binding::Corner(corner, Motion::Wheel)), self.origin_height);
            let r = nalgebra::UnitQuaternion::from_matrix(&m.fixed_view::<3, 3>(0, 0).into_owned());
            bridge::VehiclePartPose { part_index: part,
                position: bridge::Vec3::new(m[(0, 3)] as f32, m[(1, 3)] as f32, m[(2, 3)] as f32),
                rotation: bridge::Quat { x: r.i as f32, y: r.j as f32, z: r.k as f32, w: r.w as f32 } }
        }).collect();
        if let Err(error) = world.native_pose_vehicle_parts(self.entity, &poses, super::GROUP_STATIC) {
            tracing::warn!(%error, "garage wheel hulls could not be posed");
        }
    }

    /// After a completed step: configure once, then observe and drain events.
    pub fn after_step(&mut self, world: &mut bridge::World) {
        if !self.configured {
            // Each unconverged tick runs to the cap; bound it while float does not
            // converge under road loads (VIBE_GARAGE_STRESS_ITERATIONS, default 128: ~15 ms/tick on M-series).
            let max_iterations = std::env::var("VIBE_GARAGE_STRESS_ITERATIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(128);
            match world.native_configure(bridge::NativeConfig { max_iterations, tolerance: 1e-5,
                warm_start: true, damage_rate: 2., bend_gain_max: 3., fibre_bending: true,
                reserved_contact_pairs: 4096, preserve_unchanged_contact_pairs: false,
                gpu_island_repair: true, verdict_sample_ticks: 1 }) {
                Ok(_) => { self.configured = true; tracing::info!(max_iterations, "garage vehicle destruction configured"); }
                Err(error) => tracing::error!(%error, "garage vehicle destruction could not configure"),
            }
            return;
        }
        match world.native_tick() {
            Ok(status) if status.error != 0 || !status.converged => {
                self.rejected_steps += 1;
                if self.rejected_steps % 60 == 1 {
                    tracing::warn!(error = status.error, converged = status.converged, iterations = status.iterations,
                        rejected = self.rejected_steps, "garage vehicle stress step did not converge (or was rejected)");
                }
            }
            Ok(_) => {}
            Err(error) => { tracing::error!(%error, "garage vehicle native tick failed"); return; }
        }
        if let Ok(broken) = world.native_take_broken_bonds() {
            if !broken.is_empty() {
                self.broken_bonds += broken.len();
                tracing::info!(broken = broken.len(), total = self.broken_bonds, "garage vehicle bonds broke");
            }
        }
        let _ = world.native_take_chunk_migrations();
        let _ = world.native_take_island_events();
        let parts = world.native_detached_vehicle_parts(self.entity).unwrap_or_default();
        if parts.len() != self.detached_count {
            let list: Vec<String> = parts.iter().map(|p| format!("{}@({:.2},{:.2},{:.2})", p.part_index, p.position.x, p.position.y, p.position.z)).collect();
            tracing::info!(detached = parts.len(), parts = %list.join(" "), "garage vehicle parts detached");
            self.detached_count = parts.len();
        }
    }

    pub fn neutral_jounce(&self) -> f32 { self.neutral_jounce }

    /// Parts no longer on the car: (part index, world position, world rotation)
    /// of the map from each part's authored actor-frame geometry to the world.
    pub fn detached_parts(&self, world: &mut bridge::World) -> Vec<bridge::VehiclePartPose> {
        if !self.configured { return Vec::new(); }
        world.native_detached_vehicle_parts(self.entity).unwrap_or_default()
    }
}
