//! Opt-in native destruction for the private garage car
//! (`VIBE_GARAGE_VEHICLE_DESTRUCTION=1`). Chunks keep rigid rest-pose stress
//! geometry; only the wheel and hub hulls follow Vehicle2's suspension each
//! step, excluded from terrain (they must not also stand on the road Vehicle2
//! drives on), so hits land where the wheel is drawn. See
//! docs/reports/vehicle-wheel-colliders-2026-09-26.
use super::bridge;
use crate::vehicle_assets::rig::{inputs_from_vehicle2, source_to_actor, AssetRig, Binding, Motion, SOURCE_CORNER_FOR_WHEEL};
use crate::vehicle_assets::PreparedGeometry;
use std::collections::VecDeque;

/// Debug event log length (see `debug`).
const EVENT_LOG: usize = 64;

/// Native structure id of the first garage car; each further car takes the
/// next id. Ids must be below 255.
pub const STRUCTURE: u32 = 200;
/// Destructible cars one scene can hold (structure ids 200..=254).
pub const MAX_CARS: usize = 55;

pub fn requested() -> bool {
    std::env::var("VIBE_GARAGE_VEHICLE_DESTRUCTION").as_deref() == Ok("1")
}

pub struct GarageDestruction {
    pub entity: u32,
    /// Native structure id of this car's bond graph.
    pub structure: u32,
    /// The stage is configured and ticked by another owner (the city); this
    /// car only reads its own parts back.
    pub external: bool,
    rig: AssetRig,
    wheel_parts: Vec<(usize, u32)>,
    origin_height: f64,
    neutral_jounce: f32,
    configured: bool,
    pub broken_bonds: usize,
    pub rejected_steps: usize,
    detached_count: usize,
    steps: u64,
    /// Authored bond indices broken so far (from fracture events; the stress
    /// readback's own flag is a per-step verdict, not persistent state).
    broken: std::collections::BTreeSet<u32>,
    last_status: Option<(u32, bool, u32)>,
    events: VecDeque<(u64, String)>,
}

impl GarageDestruction {
    /// Register a car whose complete hull set is already installed, as native
    /// structure `structure`. Every car must be registered before the first
    /// completed step, which configures the stage for all of them.
    pub fn register(world: &mut bridge::World, entity: u32, structure: u32, geometry: &PreparedGeometry) -> Result<Self, String> {
        let rig = geometry.rig.clone().ok_or("prepared vehicle has no suspension rig")?;
        let asset = geometry.native_fracture_assembly()?;
        let wheel_parts = geometry.parts.iter().enumerate().filter_map(|(i, p)| {
            match Binding::from_motion(p.motion.as_ref()) {
                Ok(Binding::Corner(corner, Motion::Wheel)) => Some((corner, i as u32)),
                _ => None,
            }
        }).collect();
        world.native_attach().map_err(|e| e.to_string())?;
        world.native_register_vehicle(entity, structure, &asset.parts, &asset.bonds,
            bridge::DestructibleSettings { materials: asset.materials, ..Default::default() })
            .map_err(|e| e.to_string())?;
        Ok(Self { entity, structure, external: false, rig, wheel_parts, origin_height: geometry.origin_height,
            neutral_jounce: geometry.neutral_jounce, configured: false, broken_bonds: 0, rejected_steps: 0, detached_count: 0,
            steps: 0, broken: Default::default(), last_status: None, events: VecDeque::new() })
    }

    /// Pose wheel and hub hulls from the last completed step's wheels. Hulls of
    /// a wheel Vehicle2 drives are excluded from terrain (its road query
    /// stands on it); a corner whose wheel is gone (state -1) sits at neutral
    /// and collides with terrain like any other part.
    pub fn pose_wheels(&self, world: &mut bridge::World, wheels: Option<[[f32; 4]; 4]>) {
        let Some(wheels) = wheels else { return };
        let inputs: [[f32; 4]; 4] = std::array::from_fn(|i| [wheels[i][0], wheels[i][1], wheels[i][2], 0.]);
        let Ok(deltas) = self.rig.deltas(&inputs_from_vehicle2(&inputs), None) else { return };
        let driven: [bool; 4] = std::array::from_fn(|corner| {
            let wheel = SOURCE_CORNER_FOR_WHEEL.iter().position(|&c| c == corner).unwrap();
            wheels[wheel][3] >= 0.0
        });
        let pose = |corner: usize, part: u32| {
            let m = source_to_actor(&deltas.get(Binding::Corner(corner, Motion::Wheel)), self.origin_height);
            let r = nalgebra::UnitQuaternion::from_matrix(&m.fixed_view::<3, 3>(0, 0).into_owned());
            bridge::VehiclePartPose { part_index: part,
                position: bridge::Vec3::new(m[(0, 3)] as f32, m[(1, 3)] as f32, m[(2, 3)] as f32),
                rotation: bridge::Quat { x: r.i as f32, y: r.j as f32, z: r.k as f32, w: r.w as f32 } }
        };
        for (on_road, exclude) in [(true, super::GROUP_STATIC), (false, 0)] {
            let poses: Vec<_> = self.wheel_parts.iter().filter(|&&(corner, _)| driven[corner] == on_road)
                .map(|&(corner, part)| pose(corner, part)).collect();
            if poses.is_empty() { continue; }
            if let Err(error) = world.native_pose_vehicle_parts(self.entity, &poses, exclude) {
                tracing::warn!(%error, "garage wheel hulls could not be posed");
            }
        }
    }

    fn observe_detached(&mut self, world: &mut bridge::World) {
        let parts = world.native_detached_vehicle_parts(self.entity).unwrap_or_default();
        if parts.len() != self.detached_count {
            let list: Vec<String> = parts.iter().map(|p| format!("{}@({:.2},{:.2},{:.2})", p.part_index, p.position.x, p.position.y, p.position.z)).collect();
            let parts_now: Vec<String> = parts.iter().map(|p| p.part_index.to_string()).collect();
            self.log(format!("{} part(s) off the carrier: {}", parts.len(), parts_now.join(" ")));
            tracing::info!(structure = self.structure, detached = parts.len(), parts = %list.join(" "), "garage vehicle parts detached");
            self.detached_count = parts.len();
        }
    }

    pub fn neutral_jounce(&self) -> f32 { self.neutral_jounce }
    pub fn configured(&self) -> bool { self.configured }
    pub fn mark_configured(&mut self) { self.configured = true; }

    /// A clear shot at one part: a line whose first stage chunk is that part.
    /// Tries `from` (e.g. the shooter's eye) first, then from 8 m out along the
    /// car's sides, front, back and from above. Returns (origin, unit
    /// direction, whether the line is clear); an unclear line is the eye line.
    pub fn clear_shot(&self, world: &bridge::World, part: u32, from: Option<nalgebra::Vector3<f32>>)
        -> Option<(nalgebra::Vector3<f32>, nalgebra::Vector3<f32>, bool)> {
        use nalgebra::{UnitQuaternion, Quaternion, Vector3};
        let aim = world.native_chunk_aim(self.structure, part).ok().filter(|a| a.found)?;
        let target = Vector3::new(aim.center.x, aim.center.y, aim.center.z);
        let car = world.vehicle_snapshots().ok()?.into_iter().find(|v| v.entity_id == self.entity)?;
        let q = car.pose.rotation;
        let rotation = UnitQuaternion::new_normalize(Quaternion::new(q.w, q.x, q.y, q.z));
        let mut lines: Vec<Vector3<f32>> = from.map(|e| target - e).filter(|d| d.norm() > 0.5).map(|d| d.normalize()).into_iter().collect();
        lines.extend([Vector3::x(), -Vector3::x(), Vector3::z(), -Vector3::z()].map(|axis| -(rotation * axis)));
        lines.push(-Vector3::y());
        for direction in &lines {
            let origin = target - direction * 8.0;
            let ray = world.native_raycast_chunk(bridge::Vec3::new(origin.x, origin.y, origin.z),
                bridge::Vec3::new(direction.x, direction.y, direction.z), 9.0).ok()?;
            if ray.hit && ray.chunk_id == aim.chunk_id { return Some((origin, *direction, true)); }
        }
        let direction = lines[0];
        Some((target - direction * 8.0, direction, false))
    }

    fn log(&mut self, text: String) {
        if self.events.len() == EVENT_LOG { self.events.pop_front(); }
        self.events.push_back((self.steps, text));
    }

    /// Everything PhysX and the stress stage hold for this car right now:
    /// each hull's world pose, owning actor and filter, each actor's mass
    /// frame, every bond's verdict, and recent events. Read between steps.
    pub fn debug(&self, world: &mut bridge::World) -> Result<serde_json::Value, String> {
        use serde_json::json;
        macro_rules! v3 { ($v:expr) => {{ let v = &$v; [v.x, v.y, v.z] }} }
        macro_rules! q4 { ($q:expr) => {{ let q = &$q; [q.x, q.y, q.z, q.w] }} }
        let vehicle = world.native_vehicle_debug(self.entity).map_err(|e| e.to_string())?;
        let hulls: Vec<_> = vehicle.hulls.iter().map(|h| json!({
            "part": h.part_index, "ordinal": h.ordinal, "actor": h.actor, "rest": v3!(h.rest), "restRotation": q4!(h.rest_rotation),
            "position": v3!(h.position), "rotation": q4!(h.rotation),
            "filter": [h.filter_word0, h.filter_word1], "authoredWord1": h.authored_word1,
            "terrainExcluded": h.authored_word1 & super::GROUP_STATIC != 0 && h.filter_word1 & super::GROUP_STATIC == 0,
        })).collect();
        let actors: Vec<_> = vehicle.actors.iter().map(|a| json!({
            "actor": a.actor, "position": v3!(a.position), "rotation": q4!(a.rotation),
            "centerOfMass": v3!(a.center_of_mass), "mass": a.mass,
            "linearVelocity": v3!(a.linear_velocity), "angularVelocity": v3!(a.angular_velocity),
            "sleeping": a.sleeping, "kinematic": a.kinematic, "gravityDisabled": a.gravity_disabled, "shapes": a.shapes,
        })).collect();
        let wheel_loads: Vec<_> = vehicle.wheel_loads.iter().map(|w| json!({
            "wheel": w.wheel, "suspension": v3!(w.suspension), "tire": v3!(w.tire), "couple": v3!(w.couple), "constraintForce": v3!(w.constraint_force),
        })).collect();
        let bonds: Vec<_> = if self.configured {
            world.native_bond_stress_rows(self.structure).unwrap_or_default().iter().map(|b| json!({
                "index": b.bond_index, "a": b.node0, "b": b.node1, "area": b.area,
                "utilisation": b.utilisation, "compression": b.compression, "tension": b.tension, "shear": b.shear,
                "damage": b.damage, "remainingArea": b.remaining_area,
                "broken": self.broken.contains(&b.bond_index), "verdictBroken": b.broken,
            })).collect()
        } else { Vec::new() };
        // Vehicle2's own view of the car: where it thinks the body and wheels are.
        let vehicle2 = world.vehicle_snapshots().ok().and_then(|cars| cars.into_iter().find(|c| c.entity_id == self.entity)).map(|c| json!({
            "position": [c.pose.position.x, c.pose.position.y, c.pose.position.z],
            "rotation": [c.pose.rotation.x, c.pose.rotation.y, c.pose.rotation.z, c.pose.rotation.w],
            "linearVelocity": [c.linear_velocity.x, c.linear_velocity.y, c.linear_velocity.z],
            "angularVelocity": [c.angular_velocity.x, c.angular_velocity.y, c.angular_velocity.z],
            "sleeping": c.sleeping, "wheelJounce": c.wheel_jounce, "wheelSteer": c.wheel_steer,
            "wheelRotationSpeed": c.wheel_rotation_speed, "wheelsOnRoad": c.wheels_on_road, "driveConnectionMask": c.drive_connection_mask,
        }));
        let events: Vec<_> = self.events.iter().rev().map(|(step, text)| json!({"step": step, "text": text})).collect();
        Ok(json!({
            "configured": self.configured, "steps": self.steps, "rejectedSteps": self.rejected_steps,
            "brokenBonds": self.broken_bonds, "wheelLoads": wheel_loads,
            "lastStatus": self.last_status.map(|(error, converged, iterations)| json!({"error": error, "converged": converged, "iterations": iterations})),
            "vehicle": {"wheelMask": vehicle.wheel_mask, "driveMask": vehicle.drive_mask, "engineConnected": vehicle.engine_connected},
            "vehicle2": vehicle2, "hulls": hulls, "actors": actors, "bonds": bonds, "events": events,
        }))
    }

    /// Parts no longer on the car: (part index, world position, world rotation)
    /// of the map from each part's authored actor-frame geometry to the world.
    pub fn detached_parts(&self, world: &mut bridge::World) -> Vec<bridge::VehiclePartPose> {
        if !self.configured { return Vec::new(); }
        world.native_detached_vehicle_parts(self.entity).unwrap_or_default()
    }
}

/// After a completed step, for every destructible car in the scene: configure
/// the stage once (all cars share it), then tick it once and hand each car
/// its own broken bonds and detached parts.
pub fn after_step(cars: &mut [GarageDestruction], world: &mut bridge::World) {
    let Some(first) = cars.first() else { return };
    if first.external {
        // The owner ticks the stage and drains its events; ticking or draining
        // here would take the frame from it. Only this car's parts are read.
        for car in cars.iter_mut().filter(|c| c.configured) { car.steps += 1; car.observe_detached(world); }
        return;
    }
    if !first.configured {
        // Each unconverged tick runs to the cap; bound it while float does not
        // converge (VIBE_GARAGE_STRESS_ITERATIONS). Measured on the meteor
        // profile (garage_meteor_impact_tick_profile, M-series): 128 kept
        // 238 ticks over the 16.7 ms budget once the car was in pieces
        // (post-split median 19.4 ms, idle 10.8 ms); 64 kept 8 (14.0 ms,
        // idle 6.3 ms). Preserving unchanged contact pairs cut the split
        // tick from ~140 to 97 ms.
        let max_iterations = std::env::var("VIBE_GARAGE_STRESS_ITERATIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(64);
        let flag = |name: &str, default: bool| std::env::var(name).map_or(default, |v| v == "1");
        // The city's tolerance (1e-3, native_runtime::stress_tolerance, owner
        // decision 2026-09-21); this stage had kept the old 1e-5.
        // VIBE_GARAGE_STRESS_TOLERANCE overrides for A/B.
        let tolerance = std::env::var("VIBE_GARAGE_STRESS_TOLERANCE").ok().and_then(|v| v.parse().ok())
            .unwrap_or_else(vibe_land_destruction::native_runtime::stress_tolerance);
        match world.native_configure(bridge::NativeConfig { max_iterations, tolerance,
            warm_start: true, damage_rate: 2., bend_gain_max: 3., fibre_bending: true,
            // A car split into ~50 bodies holds ~24k contact pairs; growing
            // the graph mid-impact waited 78 ms on the GPU (measured). Meteor
            // splits on terrain reached 37-41k pairs (PX_DESTRUCTION_LOG_GRAPH_GROWTH,
            // seeds 1 and 4), still growing on the worst tick at 32768.
            reserved_contact_pairs: 65536,
            preserve_unchanged_contact_pairs: flag("VIBE_GARAGE_PRESERVE_PAIRS", true),
            gpu_island_repair: flag("VIBE_GARAGE_GPU_ISLAND_REPAIR", true),
            verdict_sample_ticks: std::env::var("VIBE_GARAGE_VERDICT_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(1) }) {
            Ok(_) => {
                for car in cars.iter_mut() { car.configured = true; }
                tracing::info!(max_iterations, cars = cars.len(), "garage vehicle destruction configured");
            }
            Err(error) => tracing::error!(%error, "garage vehicle destruction could not configure"),
        }
        return;
    }
    let tick = world.native_tick();
    for car in cars.iter_mut() {
        car.steps += 1;
        if let Ok(status) = &tick { car.last_status = Some((status.error, status.converged, status.iterations)); }
    }
    match tick {
        Ok(status) if status.error != 0 || !status.converged => {
            for car in cars.iter_mut() { car.rejected_steps += 1; }
            if cars[0].rejected_steps % 60 == 1 {
                tracing::warn!(error = status.error, converged = status.converged, iterations = status.iterations,
                    rejected = cars[0].rejected_steps, "garage vehicle stress step did not converge (or was rejected)");
            }
        }
        Ok(_) => {}
        Err(error) => { tracing::error!(%error, "garage vehicle native tick failed"); return; }
    }
    if let Ok(broken) = world.native_take_broken_bonds() {
        for car in cars.iter_mut() {
            let mine: Vec<u32> = broken.iter().filter(|b| b.structure_id == car.structure).map(|b| b.bond_id & ((1 << 20) - 1)).collect();
            if mine.is_empty() { continue; }
            car.broken_bonds += mine.len();
            car.broken.extend(mine.iter().copied());
            let ids: Vec<String> = mine.iter().map(|b| b.to_string()).collect();
            car.log(format!("broke {} bond(s): {}", mine.len(), ids.join(" ")));
            tracing::info!(structure = car.structure, broken = mine.len(), total = car.broken_bonds, "garage vehicle bonds broke");
        }
    }
    let _ = world.native_take_chunk_migrations();
    let _ = world.native_take_island_events();
    for car in cars.iter_mut() { car.observe_detached(world); }
}
