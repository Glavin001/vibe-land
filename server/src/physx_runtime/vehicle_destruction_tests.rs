//! Destruction correctness on the garage's own path: `PhysxPhysicsArena` with
//! `enable_vehicle_destruction`, the same stepping, ball launch, wheel posing
//! and debug readback the /garage range uses. Each scene is checked, every
//! tick, against what must hold for rigid-chunk fracture:
//!
//! - bond graph = bodies: each connected group of intact bonds is exactly one
//!   rigid body, and no intact bond joins two bodies;
//! - every body's mass and centre of mass equal the sum of its parts;
//! - parts in one body keep their relative poses (rigid, not soft);
//! - loose bodies have gravity, fall like it (a ~ -g in free flight), never
//!   drift at constant velocity, and come to rest supported;
//! - loose bodies do not gain more kinetic energy than the ball brought;
//! - the parts streamed to clients as detached are exactly those off the car,
//!   and Vehicle2's wheel mask matches which wheels are still on it;
//! - a shot at a part breaks bonds at that part, near the ball.
//!
//! Stress convergence is not checked (float does not converge under road
//! loads yet; unconverged steps are published as in the garage). Suspension
//! is approximate by design: posed wheel hulls, rest-pose stress geometry;
//! resting and driving must still break nothing.
//!
//!   scripts/perf/garage-destruction-test.sh
use super::{bridge, tests::gpu_test_guard, InputCmd, MoveConfig, PhysxPhysicsArena, Vector3, WorldDocumentArena};
use crate::vehicle_assets::{rig::{Binding, Motion}, FractureLayout, PreparedGeometry};
use nalgebra::{Isometry3, Point3, Quaternion, Translation3, UnitQuaternion};
use serde::Deserialize;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap};

const CAR: u32 = 1001;
const DT: f32 = 1.0 / 60.0;
const G: f32 = 9.81;
/// 20 m/s moves the 0.4 m ball 0.33 m per 60 Hz tick, so it cannot pass
/// through a thin part between ticks (the stage forbids sweep CCD, and a
/// speculative contact delivers no fracture load). 3000 kg keeps the momentum
/// of the range's 1000 kg / 60 m/s default.
const BALL_MASS: f32 = 3000.0;
const BALL_SPEED: f32 = 20.0;
const SHOT_TICKS: u32 = 360;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hull { part: u32, ordinal: u32, actor: u32, rest: [f32; 3], rest_rotation: [f32; 4], position: [f32; 3], rotation: [f32; 4], terrain_excluded: bool }
impl Hull {
    /// World pose of the part's authored actor frame: hull world * rest^-1.
    fn part_pose(&self) -> Isometry3<f32> { iso(self.position, self.rotation) * iso(self.rest, self.rest_rotation).inverse() }
}
/// World points of a hull's authored vertices (authored in the part frame at
/// part.position + shape.position).
fn hull_points<'g>(geometry: &'g PreparedGeometry, h: &Hull) -> impl Iterator<Item = Vector3<f32>> + 'g {
    let pose = h.part_pose();
    let part = &geometry.parts[h.part as usize];
    let shape = &part.shapes[h.ordinal as usize];
    let origin = Vector3::new(part.position[0] + shape.position[0], part.position[1] + shape.position[1], part.position[2] + shape.position[2]);
    shape.vertices.iter().map(move |v| (pose * Point3::from(origin + Vector3::new(v[0], v[1], v[2]))).coords)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Actor { actor: u32, position: [f32; 3], rotation: [f32; 4], center_of_mass: [f32; 3], mass: f32,
    linear_velocity: [f32; 3], angular_velocity: [f32; 3], sleeping: bool, gravity_disabled: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bond { index: u32, a: u32, b: u32, broken: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VehicleState { wheel_mask: u32 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Readback { configured: bool, rejected_steps: usize, last_status: Option<serde_json::Value>, hulls: Vec<Hull>, actors: Vec<Actor>, bonds: Vec<Bond>, vehicle: VehicleState }

fn iso(p: [f32; 3], q: [f32; 4]) -> Isometry3<f32> {
    Isometry3::from_parts(Translation3::new(p[0], p[1], p[2]), UnitQuaternion::new_normalize(Quaternion::new(q[3], q[0], q[1], q[2])))
}
fn v3(v: [f32; 3]) -> Vector3<f32> { Vector3::new(v[0], v[1], v[2]) }

fn fixtures() -> Vec<(String, PreparedGeometry)> {
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(
        std::env::var("VIBE_VEHICLE_BUILD_FIXTURES").expect("VIBE_VEHICLE_BUILD_FIXTURES fixture manifest")).unwrap()).unwrap();
    let models = std::env::var("VIBE_DESTRUCTION_MODELS").unwrap_or("buggy".into());
    manifest.as_array().unwrap().iter().filter(|f| models.split(',').any(|m| m == f["name"].as_str().unwrap())).map(|f| {
        let mut geometry: PreparedGeometry = serde_json::from_slice(&std::fs::read(f["metadataPath"].as_str().unwrap()).unwrap()).unwrap();
        geometry.driving = Some(serde_json::from_value(f["driving"].clone()).unwrap());
        (f["name"].as_str().unwrap().to_owned(), geometry)
    }).collect()
}

struct Scene { arena: PhysxPhysicsArena, tick: u32 }
impl Scene {
    fn new(geometry: &PreparedGeometry, garage_world: bool) -> Self {
        // The garage's own switches: all hulls installed, unconverged steps published.
        std::env::set_var("VIBE_GARAGE_VEHICLE_DESTRUCTION", "1");
        std::env::set_var("PX_DESTRUCTION_ALLOW_UNCONVERGED", "1");
        let mut arena = PhysxPhysicsArena::new(MoveConfig::default()).unwrap();
        if garage_world {
            let world = crate::demo_world::garage_test_world();
            world.instantiate(&mut arena).unwrap();
            arena.set_spawn_areas(world.spawn_areas.clone());
        } else {
            WorldDocumentArena::add_static_cuboid(&mut arena, Vector3::new(0., -0.5, 0.), [0., 0., 0., 1.], Vector3::new(100., 0.5, 100.), 1);
        }
        arena.spawn_vehicle_asset(CAR, 0, Vector3::new(0., geometry.origin_height as f32 + 0.15, 3.), [0., 0., 0., 1.], Some(geometry)).unwrap();
        arena.enable_vehicle_destruction(CAR, geometry).unwrap();
        arena.reserve_ball_pool(8);
        Self { arena, tick: 0 }
    }
    fn step(&mut self) { self.arena.step_vehicles_and_dynamics(DT); self.tick += 1; }
    fn observe(&mut self) -> Readback { serde_json::from_value(self.arena.vehicle_destruction_debug(CAR).unwrap()).unwrap() }
}

/// One loose body over time, keyed by its part set.
#[derive(Default)]
struct Track { samples: Vec<(u32, Vector3<f32>, bool, f32, bool)> } // tick, velocity, sleeping, lowest hull point y, free flight

struct Checks<'a> {
    geometry: &'a PreparedGeometry,
    layout: &'a FractureLayout,
    posed: BTreeSet<u32>,
    violations: BTreeMap<String, (usize, String)>,
    warnings: BTreeMap<String, (usize, String)>,
    locals: HashMap<(u32, u32), (BTreeSet<u32>, Isometry3<f32>)>,
    tracks: BTreeMap<Vec<u32>, Track>,
    broken: BTreeSet<u32>,
    last_break: Option<u32>,
    max_loose_energy: f32,
    last: Option<Readback>,
    /// First carrier sample: (parts' COM, PhysX COM), both in the car frame.
    carrier_com: Option<(Vector3<f32>, Vector3<f32>)>,
    wheel_mask_mismatch: [u32; 4],
    free_flight_ticks: usize,
    /// Ground is the plane y = 0 (free-flight and rest checks need it).
    flat_ground: bool,
    streamed_cache: Vec<(u16, [f32; 3], [f32; 4])>,
    sunk_ticks: u32,
    /// Each part's centre at the previous sample, with the tick.
    part_centers: HashMap<u32, (u32, Vector3<f32>)>,
    part_speeds: HashMap<u32, f32>,
    /// Per-tick trace (part centres by body) while `tracing` is set.
    trace: Vec<serde_json::Value>,
    tracing: bool,
    /// Terrain the scene stands on (None: the plane y = 0).
    terrain: Option<vibe_land_shared::world_document::WorldDocument>,
}
fn streamed_poses(cache: &[(u16, [f32; 3], [f32; 4])]) -> Vec<(u16, [f32; 3], [f32; 4])> { cache.to_vec() }
impl<'a> Checks<'a> {
    fn new(geometry: &'a PreparedGeometry, layout: &'a FractureLayout) -> Self {
        let posed = geometry.parts.iter().enumerate().filter(|(_, p)|
            matches!(Binding::from_motion(p.motion.as_ref()), Ok(Binding::Corner(_, Motion::Wheel)))).map(|(i, _)| i as u32).collect();
        Self { geometry, layout, posed, violations: BTreeMap::new(), warnings: BTreeMap::new(), locals: HashMap::new(), tracks: BTreeMap::new(),
            broken: BTreeSet::new(), last_break: None, max_loose_energy: 0., last: None, carrier_com: None, wheel_mask_mismatch: [0; 4], free_flight_ticks: 0, flat_ground: true, streamed_cache: Vec::new(), sunk_ticks: 0, part_centers: HashMap::new(), part_speeds: HashMap::new(), trace: Vec::new(), tracing: false, terrain: None }
    }
    fn warn(&mut self, kind: &str, detail: String) {
        let entry = self.warnings.entry(kind.to_owned()).or_insert((0, detail));
        entry.0 += 1;
    }
    fn fail(&mut self, kind: &str, detail: String) {
        let entry = self.violations.entry(kind.to_owned()).or_insert((0, detail));
        entry.0 += 1;
    }
    fn ground(&self, x: f32, z: f32) -> f32 {
        self.terrain.as_ref().map_or(0.0, |w| w.sample_heightfield_surface_at_world_position(x, z))
    }
    fn name(&self, part: u32) -> String { format!("{}#{part}", self.geometry.parts[part as usize].id) }

    /// Returns bonds newly broken this sample.
    fn sample(&mut self, tick: u32, d: Readback, streamed: &[bridge::VehiclePartPose]) -> Vec<u32> {
        self.streamed_cache = streamed.iter().map(|p| (p.part_index as u16, [p.position.x, p.position.y, p.position.z], [p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w])).collect();
        let parts = self.geometry.parts.len();
        if !d.configured { return Vec::new(); }
        // Hull ownership: every hull present, all of a part's hulls on one body.
        let mut part_actor: Vec<Option<u32>> = vec![None; parts];
        let mut hull_count = vec![0usize; parts];
        for h in &d.hulls {
            hull_count[h.part as usize] += 1;
            if h.actor == u32::MAX { self.fail("hull without a body", self.name(h.part)); continue; }
            match part_actor[h.part as usize] {
                None => part_actor[h.part as usize] = Some(h.actor),
                Some(a) if a != h.actor => self.fail("part split across bodies", self.name(h.part)),
                _ => {}
            }
        }
        for (i, p) in self.geometry.parts.iter().enumerate() {
            if hull_count[i] != p.shapes.len() { self.fail("hull count changed", format!("{} has {} of {}", self.name(i as u32), hull_count[i], p.shapes.len())); }
        }
        let actors: BTreeMap<u32, &Actor> = d.actors.iter().map(|a| (a.actor, a)).collect();
        let mut members: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
        for (i, a) in part_actor.iter().enumerate() { if let Some(a) = a { members.entry(*a).or_default().insert(i as u32); } }

        // Broken bonds, and the bond graph against the bodies.
        let fresh: Vec<u32> = d.bonds.iter().filter(|b| b.broken && !self.broken.contains(&b.index)).map(|b| b.index).collect();
        if !fresh.is_empty() { self.last_break = Some(tick); self.broken.extend(&fresh); }
        if d.bonds.iter().any(|b| !b.broken && self.broken.contains(&b.index)) { self.fail("broken bond healed", String::new()); }
        let mut root: Vec<usize> = (0..parts).collect();
        fn find(root: &mut [usize], x: usize) -> usize { let mut x = x; while root[x] != x { root[x] = root[root[x]]; x = root[x]; } x }
        for b in &d.bonds {
            let expected = self.layout.bond_chunks.get(b.index as usize).copied();
            if expected.is_none_or(|[a, c]| !((a, c) == (b.a, b.b) || (a, c) == (b.b, b.a))) {
                self.fail("bond index does not match the authored bond", format!("row {} = {}-{}", b.index, b.a, b.b));
            }
            if b.broken { continue; }
            let (x, y) = (find(&mut root, b.a as usize), find(&mut root, b.b as usize));
            root[x] = y;
            if part_actor[b.a as usize] != part_actor[b.b as usize] && self.last_break.is_none_or(|t| tick > t + 2) {
                self.fail("intact bond joins two bodies", format!("{} - {}", self.name(b.a), self.name(b.b)));
            }
        }
        if !d.bonds.is_empty() && self.last_break.is_none_or(|t| tick > t + 2) {
            let mut component_actors: BTreeMap<usize, BTreeSet<u32>> = BTreeMap::new();
            let mut actor_components: BTreeMap<u32, BTreeSet<usize>> = BTreeMap::new();
            for (i, a) in part_actor.iter().enumerate() {
                let Some(a) = a else { continue };
                let c = find(&mut root, i);
                component_actors.entry(c).or_default().insert(*a);
                actor_components.entry(*a).or_default().insert(c);
            }
            for (a, cs) in &actor_components { if cs.len() > 1 {
                let groups: Vec<Vec<String>> = cs.iter().map(|c| (0..parts).filter(|&i| find(&mut root.clone(), i) == *c).take(3).map(|i| self.name(i as u32)).collect()).collect();
                self.fail("one body holds unconnected bond groups", format!("body {a}: {} groups, e.g. {groups:?}", cs.len()));
            } }
        }

        // World bounds of every body, for telling free flight from contact.
        let mut bounds: BTreeMap<u32, (Vector3<f32>, Vector3<f32>)> = BTreeMap::new();
        for h in &d.hulls {
            let entry = bounds.entry(h.actor).or_insert((Vector3::repeat(f32::INFINITY), Vector3::repeat(f32::NEG_INFINITY)));
            for p in hull_points(self.geometry, h) { entry.0 = entry.0.inf(&p); entry.1 = entry.1.sup(&p); }
        }
        let clearance: BTreeMap<u32, f32> = bounds.iter().map(|(a, (lo, hi))| (*a, lo.y - self.ground(0.5 * (lo.x + hi.x), 0.5 * (lo.z + hi.z)))).collect();
        let flat = self.flat_ground;
        let free = |a: u32| -> bool {
            let Some((lo, hi)) = bounds.get(&a) else { return false };
            flat && clearance.get(&a).is_some_and(|c| *c > 0.05) && bounds.iter().filter(|(b, _)| **b != a).all(|(_, (l, h))|
                (0..3).any(|k| lo[k] > h[k] + 0.05 || l[k] > hi[k] + 0.05))
        };
        // No part may move further in one tick than its body's motion allows.
        let mut centers: Vec<(u32, u32, Vector3<f32>)> = Vec::new();
        for h in d.hulls.iter().filter(|h| h.ordinal == 0) {
            let c = self.geometry.parts[h.part as usize].mass_properties.center.map(|x| x as f32);
            centers.push((h.part, h.actor, (h.part_pose() * Point3::new(c[0], c[1], c[2])).coords));
        }
        for &(part, actor, now) in &centers {
            let Some(a) = actors.get(&actor) else { continue };
            let r = (now - v3(a.center_of_mass)).norm();
            let speed_now = v3(a.linear_velocity).norm() + v3(a.angular_velocity).norm() * r;
            // A contact inside the tick changes velocity at once: bound by the
            // faster of the part's body before and after it.
            let speed = self.part_speeds.insert(part, speed_now).map_or(speed_now, |s| s.max(speed_now));
            if let Some(&(t0, before)) = self.part_centers.get(&part) {
                let dt = (tick - t0) as f32 * DT;
                let allowed = speed * dt * 2.0 + 0.05;
                let moved = (now - before).norm();
                // Contact depenetration moves a body in position, which its
                // velocity does not show: a few cm per tick against terrain.
                // The check is for jumps (the snap-back was metres).
                if moved > allowed && moved > 0.5 {
                    self.fail("part teleported", format!("{} moved {moved:.2} m in {} tick(s) (body allows {allowed:.2} m) at tick {tick}", self.name(part), tick - t0));
                }
            }
            self.part_centers.insert(part, (tick, now));
        }
        if self.tracing {
            self.trace.push(json!({"tick": tick, "bodies": d.actors.iter().map(|a| json!({"actor": a.actor, "com": a.center_of_mass,
                "v": a.linear_velocity, "w": a.angular_velocity})).collect::<Vec<_>>(),
                "parts": centers.iter().map(|(p, a, c)| json!([p, a, [c.x, c.y, c.z]])).collect::<Vec<_>>()}));
        }
        // Mass, centre of mass, gravity, rigidity, energy, rest support.
        let mut loose_energy = 0.;
        for (a, set) in &members {
            let Some(actor) = actors.get(a) else { self.fail("body missing from readback", format!("{a}")); continue };
            let mass: f64 = set.iter().map(|&p| self.geometry.parts[p as usize].mass).sum();
            if ((actor.mass as f64 - mass) / mass).abs() > 1e-3 {
                self.fail("body mass is not the sum of its parts", format!("body {a} ({} parts): {} vs {:.3}", set.len(), actor.mass, mass));
            }
            let mut com = Vector3::zeros();
            let mut lowest = f32::INFINITY;
            let actor_iso = iso(actor.position, actor.rotation);
            for h in d.hulls.iter().filter(|h| h.actor == *a) {
                let world = iso(h.position, h.rotation);
                for p in hull_points(self.geometry, h) { lowest = lowest.min(p.y - self.ground(p.x, p.z)); }
                if h.ordinal == 0 {
                    let part = &self.geometry.parts[h.part as usize];
                    let c = part.mass_properties.center.map(|x| x as f32);
                    com += (h.part_pose() * Point3::new(c[0], c[1], c[2])).coords * part.mass as f32;
                }
                // Posed wheel hulls move on the car by design; everything else is rigid.
                if *a == 0 && self.posed.contains(&h.part) { continue; }
                let local = actor_iso.inverse() * world;
                let key = (h.part, h.ordinal);
                let moved = match self.locals.get(&key) {
                    Some((before, pose)) if before == set => Some(pose.inverse() * local),
                    _ => None,
                };
                match moved {
                    Some(delta) => if delta.translation.vector.norm() > 1e-3 || delta.rotation.angle() > 1e-3 {
                        self.fail("part moved within its rigid body", format!("{} by {:.4} m", self.name(h.part), delta.translation.vector.norm()));
                    },
                    None => { self.locals.insert(key, (set.clone(), local)); }
                }
            }
            com /= mass as f32;
            if *a == 0 && self.carrier_com.is_none() {
                let local = |w: Vector3<f32>| (actor_iso.inverse() * Point3::from(w)).coords;
                self.carrier_com = Some((local(com), local(v3(actor.center_of_mass))));
            }
            // A loose wheel's mass frame is its rest-pose one while its hulls
            // keep the suspension pose they had: bounded by the travel.
            let tolerance = if set.iter().any(|p| self.posed.contains(p)) { self.geometry.suspension_travel + 0.02 } else { 0.02 };
            if (com - v3(actor.center_of_mass)).norm() > tolerance {
                self.fail("body centre of mass is not its parts'", format!("body {a} ({} parts) off by {:.3} m", set.len(), (com - v3(actor.center_of_mass)).norm()));
            }
            if *a != 0 {
                if actor.gravity_disabled { self.fail("loose body has gravity disabled", format!("{:?}", set.iter().take(3).map(|&p| self.name(p)).collect::<Vec<_>>())); }
                let velocity = v3(actor.linear_velocity);
                loose_energy += 0.5 * actor.mass * velocity.norm_squared();
                self.tracks.entry(set.iter().copied().collect()).or_default().samples.push((tick, velocity, actor.sleeping, lowest, free(*a)));
            }
        }
        self.max_loose_energy = self.max_loose_energy.max(loose_energy);

        // What clients are told is detached, and what Vehicle2 still drives.
        let off: BTreeSet<u32> = part_actor.iter().enumerate().filter(|(_, a)| **a != Some(0)).map(|(i, _)| i as u32).collect();
        let streamed: BTreeSet<u32> = streamed.iter().map(|p| p.part_index).collect();
        if off != streamed { self.fail("streamed detached parts differ from bodies", format!("{} off the car, {} streamed", off.len(), streamed.len())); }
        // Through the wire: one tick's packets from a fresh stream, merged as the client does.
        let tuples: Vec<(u16, [f32; 3], [f32; 4])> = streamed_poses(&self.streamed_cache);
        if !tuples.is_empty() {
            let wheels = [[0.; 4]; 4];
            let mut received = BTreeSet::new();
            for packet in crate::vehicle_assets::rig_packets_with_parts(0, 1, wheels, &tuples) {
                if packet.len() > crate::vehicle_assets::RIG_PACKET_BUDGET { self.fail("rig packet over the datagram budget", format!("{} bytes", packet.len())); }
                let mut o = 61;
                for _ in 0..packet[60] { let n = packet[o + 28] as usize; o += 29; for _ in 0..n { received.insert(u16::from_le_bytes([packet[o], packet[o + 1]]) as u32); o += 2; } }
            }
            if received != off { self.fail("rig packets do not carry every detached part", format!("{} off the car, {} on the wire", off.len(), received.len())); }
        }
        // Terrain exclusion only while Vehicle2 drives that corner's wheel.
        let corner_of = |p: u32| match Binding::from_motion(self.geometry.parts[p as usize].motion.as_ref()) {
            Ok(Binding::Corner(c, Motion::Wheel)) => Some(c), _ => None };
        for h in d.hulls.iter().filter(|h| h.terrain_excluded) {
            let Some(corner) = corner_of(h.part) else { self.fail("terrain-excluded hull that is not a wheel part", self.name(h.part)); continue };
            let wheel = crate::vehicle_assets::rig::SOURCE_CORNER_FOR_WHEEL.iter().position(|&c| c == corner).unwrap();
            if h.actor != 0 { self.fail("detached hull still excluded from terrain", self.name(h.part)); }
            else if d.vehicle.wheel_mask & (1 << wheel) == 0 && self.wheel_mask_mismatch[wheel] == 0 {
                self.fail("hull of a lost wheel's corner excluded from terrain", self.name(h.part));
            }
        }
        // Nothing that collides with the ground may stay sunk into it.
        if self.flat_ground {
            let sunk = d.hulls.iter().filter(|h| !h.terrain_excluded)
                .filter_map(|h| hull_points(self.geometry, h).map(|p| p.y - self.ground(p.x, p.z)).reduce(f32::min).filter(|&y| y < -0.05).map(|y| (h.part, y)))
                .fold(None::<(u32, f32)>, |a, b| if a.is_none_or(|a| b.1 < a.1) { Some(b) } else { a });
            // More than 15 cm is a failure. 5-15 cm is the known residual of a
            // thin hull on the car body (a 2.5 cm axle) slammed into a
            // heightfield: measured to 10.3 cm, settling at 6.6 cm (reported).
            match sunk {
                Some((part, y)) => {
                    self.sunk_ticks += 1;
                    if self.sunk_ticks > 10 {
                        if y < -0.15 { self.fail("hull sunk into the ground", format!("{} at {y:.3} m", self.name(part))); }
                        else { self.warn("hull slightly sunk into the ground", format!("{} at {y:.3} m", self.name(part))); }
                    }
                }
                None => self.sunk_ticks = 0,
            }
        }
        for w in 0..4 {
            let on = part_actor[self.layout.wheel_chunks[w][0] as usize] == Some(0);
            if on != (d.vehicle.wheel_mask & (1 << w) != 0) {
                self.wheel_mask_mismatch[w] += 1;
                if self.wheel_mask_mismatch[w] > 1 { self.fail("Vehicle2 wheel mask disagrees with the wheel chunk", format!("wheel {w} on car: {on}")); }
            } else { self.wheel_mask_mismatch[w] = 0; }
        }
        self.last = Some(d);
        fresh
    }

    /// Whole-history checks on loose bodies: free fall, no drift, supported rest.
    fn finish(&mut self, ball_energy: f32) {
        let tracks = std::mem::take(&mut self.tracks);
        for (parts, track) in &tracks {
            let label = format!("{:?}", parts.iter().take(3).map(|&p| self.name(p)).collect::<Vec<_>>());
            let s = &track.samples;
            // Constant velocity while awake: weightless, undamped drift.
            for w in s.windows(30) {
                if w.iter().all(|x| !x.2 && x.1.norm() > 0.3) && w.iter().all(|x| (x.1 - w[0].1).norm() < 0.02) {
                    self.fail("loose body drifts at constant velocity", format!("{label} at {:.2} m/s", w[0].1.norm())); break;
                }
            }
            // Free flight (clear of the ground and every other body): a_y ~ -g.
            let mut accel: Vec<f32> = s.windows(2).filter(|w| w[1].0 == w[0].0 + 1 && w[0].4 && w[1].4 && !w[0].2)
                .map(|w| (w[1].1.y - w[0].1.y) / DT).collect();
            self.free_flight_ticks += accel.len();
            // A median of fewer samples is decided by a single contact tick.
            if accel.len() >= 8 {
                accel.sort_by(f32::total_cmp);
                let median = accel[accel.len() / 2];
                if (median + G).abs() > 1.5 { self.fail("loose body does not fall at g", format!("{label}: median a_y {median:.2} over {} airborne ticks", accel.len())); }
            }
            // At the end: on the ground (rolling is fine), or resting on the car.
            if let Some(&(_, velocity, _, lowest, free)) = s.last() {
                if free { self.fail("loose body still in the air at the end", format!("{label} {:.2} m/s", velocity.norm())); }
                else if self.flat_ground && lowest > 0.15 && !self.rests_on_car(lowest) { self.fail("loose body at rest off the ground", format!("{label} lowest point {lowest:.2} m")); }
            }
        }
        self.tracks = tracks;
        if self.max_loose_energy > 1.1 * ball_energy + 500. {
            self.fail("loose bodies gained energy", format!("{:.0} J from a {:.0} J ball", self.max_loose_energy, ball_energy));
        }
    }
    /// A body may rest on the car: below the car's highest point.
    fn rests_on_car(&self, lowest: f32) -> bool {
        let Some(d) = &self.last else { return false };
        d.hulls.iter().filter(|h| h.actor == 0).flat_map(|h| hull_points(self.geometry, h)).any(|p| p.y - self.ground(p.x, p.z) >= lowest - 0.05)
    }
    fn report(&self) -> serde_json::Value {
        json!(self.violations.iter().map(|(k, (n, e))| json!({"check": k, "count": n, "example": e})).collect::<Vec<_>>())
    }
    fn warnings(&self) -> serde_json::Value {
        json!(self.warnings.iter().map(|(k, (n, e))| json!({"check": k, "count": n, "example": e})).collect::<Vec<_>>())
    }
}

fn bond_label(geometry: &PreparedGeometry, layout: &FractureLayout, index: u32) -> String {
    let [a, b] = layout.bond_chunks[index as usize];
    format!("{} - {}", geometry.parts[a as usize].id, geometry.parts[b as usize].id)
}

fn run_rest(geometry: &PreparedGeometry, layout: &FractureLayout) -> serde_json::Value {
    let mut scene = Scene::new(geometry, false);
    let mut checks = Checks::new(geometry, layout);
    for _ in 0..240 {
        scene.step();
        let streamed = scene.arena.vehicle_detached_parts(CAR);
        let d = scene.observe();
        checks.sample(scene.tick, d, &streamed);
    }
    checks.finish(0.);
    let broken: Vec<_> = checks.broken.iter().map(|&i| bond_label(geometry, layout, i)).collect();
    if !broken.is_empty() { checks.fail("bonds broke at rest (suspension approximation)", format!("{broken:?}")); }
    json!({"scenario": "rest", "brokenBonds": broken,
        "carrierCom": checks.carrier_com.map(|(parts, physx)| json!({"parts": [parts.x, parts.y, parts.z], "physx": [physx.x, physx.y, physx.z]})), "violations": checks.report(), "warnings": checks.warnings(), "failed": !checks.violations.is_empty()})
}

fn run_drive(geometry: &PreparedGeometry, layout: &FractureLayout) -> serde_json::Value {
    let mut scene = Scene::new(geometry, true);
    let mut checks = Checks::new(geometry, layout);
    checks.terrain = Some(crate::demo_world::garage_test_world());
    scene.arena.spawn_player(42);
    for _ in 0..30 { scene.step(); }
    scene.arena.enter_vehicle(42, CAR);
    let driving = scene.arena.player_vehicle_id(42) == Some(CAR);
    let start = scene.arena.current_vehicle_snapshots()[0].pose.position;
    let mut events = Vec::new();
    let mut farthest = 0f32;
    for tick in 0..720u32 {
        // Accelerate, then hold a steady turn: laps over hills, banks and the
        // washboard lane without reaching the perimeter walls.
        let mut input = InputCmd::default();
        let car = scene.arena.current_vehicle_snapshots()[0];
        let speed = (car.linear_velocity.x.powi(2) + car.linear_velocity.z.powi(2)).sqrt();
        input.move_y = if speed < 12. { 100 } else { 0 };
        if tick >= 150 { input.move_x = 60; }
        scene.arena.simulate_player_tick(42, &input, DT);
        scene.step();
        let p = scene.arena.current_vehicle_snapshots()[0].pose.position;
        farthest = farthest.max(p.x.abs().max(p.z.abs()));
        let streamed = scene.arena.vehicle_detached_parts(CAR);
        let d = scene.observe();
        let status = d.last_status.clone();
        let fresh = checks.sample(scene.tick, d, &streamed);
        if !fresh.is_empty() && events.len() < 12 {
            let car = scene.arena.current_vehicle_snapshots()[0];
            events.push(json!({"tick": scene.tick, "carY": car.pose.position.y, "speed": v3([car.linear_velocity.x, car.linear_velocity.y, car.linear_velocity.z]).norm(),
                "vy": car.linear_velocity.y, "wheelsOnRoad": car.wheels_on_road.count_ones(), "jounce": car.wheel_jounce, "status": status,
                "broke": fresh.iter().take(6).map(|&i| bond_label(geometry, layout, i)).collect::<Vec<_>>(), "count": fresh.len()}));
        }
    }
    let end = scene.arena.current_vehicle_snapshots()[0].pose.position;
    let distance = ((end.x - start.x).powi(2) + (end.z - start.z).powi(2)).sqrt();
    checks.finish(0.);
    let broken: Vec<_> = checks.broken.iter().map(|&i| bond_label(geometry, layout, i)).collect();
    if !broken.is_empty() { checks.fail("bonds broke while driving (suspension approximation)", format!("{broken:?}")); }
    if !driving || distance < 20. { checks.fail("drive did not cover the course", format!("driving {driving}, {distance:.1} m")); }
    if farthest > 100. { checks.fail("drive reached the perimeter walls", format!("{farthest:.0} m")); }
    json!({"scenario": "drive", "distanceM": distance, "farthestM": farthest, "breakEvents": events, "brokenBonds": broken, "violations": checks.report(), "warnings": checks.warnings(), "failed": !checks.violations.is_empty()})
}

/// `expect_break`: the part is authored to fail under this shot. A robust part
/// (an engine block welded to the frame) may survive; any break must be local.
fn run_shot(geometry: &PreparedGeometry, layout: &FractureLayout, label: &str, part: u32, expect_break: bool, heightfield: bool) -> serde_json::Value {
    let mut scene = Scene::new(geometry, heightfield);
    let mut checks = Checks::new(geometry, layout);
    if heightfield { checks.terrain = Some(crate::demo_world::garage_test_world()); }
    for _ in 0..90 {
        scene.step();
        let streamed = scene.arena.vehicle_detached_parts(CAR);
        let d = scene.observe();
        checks.sample(scene.tick, d, &streamed);
    }
    let settled_breaks = checks.broken.len();
    let (origin, direction, clear) = scene.arena.vehicle_clear_shot(CAR, part, None).expect("part is on the car");
    let time = 8.0 / BALL_SPEED;
    let ball = scene.arena.launch_ball_from_muzzle(origin, direction * BALL_SPEED + Vector3::new(0., 0.5 * G * time, 0.),
        crate::garage_bombardment::BALL_RADIUS, BALL_MASS, 600).expect("ball launched");
    let mut events = Vec::new();
    let mut first_break_distance = None;
    let target_at = v3(checks.last.as_ref().and_then(|d| d.hulls.iter().find(|h| h.part == part && h.ordinal == 0)).map(|h| h.position).unwrap());
    let mut near_target = false;
    let mut ball_speed_after = BALL_SPEED;
    let mut ball_closest = f32::INFINITY;
    for _ in 0..SHOT_TICKS {
        scene.step();
        let streamed = scene.arena.vehicle_detached_parts(CAR);
        if let Some(rig) = scene.arena.vehicle_rig(CAR, geometry.neutral_jounce) {
            if rig.iter().any(|w| !(w[0].abs() <= 1.0)) { checks.fail("rig travel out of range", format!("{:?}", rig.map(|w| w[0]))); }
        }
        let d = scene.observe();
        let ball_body = scene.arena.snapshot_dynamic_bodies().into_iter().find(|b| b.0 == ball);
        let ball_at = ball_body.as_ref().map(|b| v3(b.1));
        if let Some(b) = &ball_body {
            ball_closest = ball_closest.min((v3(b.1) - target_at).norm());
            if scene.tick < 90 + 60 { ball_speed_after = v3(b.4).norm(); }
        }
        // Where the first bonds broke, before the sample consumes the readback.
        let centroids: Vec<(u32, Vector3<f32>)> = d.bonds.iter().filter(|b| b.broken && !checks.broken.contains(&b.index)).filter_map(|b| {
            let hull = d.hulls.iter().find(|h| h.part == b.a && h.ordinal == 0)?;
            let bond = &geometry.bonds[b.index as usize];
            let pose = hull.part_pose();
            Some((b.index, (pose * Point3::new(bond.centroid[0] as f32, bond.centroid[1] as f32, bond.centroid[2] as f32)).coords))
        }).collect();
        near_target |= centroids.iter().any(|(_, c)| (c - target_at).norm() < 0.75);
        let fresh = checks.sample(scene.tick, d, &streamed);
        if !fresh.is_empty() {
            if first_break_distance.is_none() {
                first_break_distance = ball_at.map(|p| centroids.iter().map(|(_, c)| (c - p).norm()).fold(0f32, f32::max));
            }
            events.push(json!({"tick": scene.tick, "broke": fresh.iter().map(|&i| bond_label(geometry, layout, i)).collect::<Vec<_>>()}));
        }
    }
    checks.finish(0.5 * BALL_MASS * BALL_SPEED * BALL_SPEED);
    let d = checks.last.as_ref().unwrap();
    let target_off = d.hulls.iter().any(|h| h.part == part && h.actor != 0);
    let rejected = d.rejected_steps;
    let target_broken = checks.broken.iter().any(|&i| layout.bond_chunks[i as usize].contains(&part));
    let fragments: Vec<_> = checks.tracks.keys().map(|parts| {
        let mass: f64 = parts.iter().map(|&p| geometry.parts[p as usize].mass).sum();
        json!({"parts": parts.iter().map(|&p| checks.name(p)).collect::<Vec<_>>(), "massKg": mass})
    }).collect();
    if settled_breaks > 0 { checks.fail("bonds broke before the shot", format!("{settled_breaks}")); }
    if !clear { checks.fail("no clear line to the target", checks.name(part)); }
    let missed = ball_speed_after > 0.95 * BALL_SPEED && checks.broken.is_empty();
    if missed && ball_closest < 0.3 { checks.fail("the ball passed through the part", format!("{} (closest {ball_closest:.2} m, {ball_speed_after:.1} m/s after)", checks.name(part))); }
    else if missed { checks.fail("the ball missed the car", format!("{} (closest {ball_closest:.2} m)", checks.name(part))); }
    else if checks.broken.is_empty() { if expect_break { checks.fail("the shot broke nothing", checks.name(part)); } }
    else if !target_broken && !near_target { checks.fail("no bond broke at the target", checks.name(part)); }
    if first_break_distance.is_some_and(|m| m > 1.5) {
        checks.fail("first bonds broke far from the ball", format!("{:.2} m", first_break_distance.unwrap()));
    }
    json!({"scenario": format!("shot {label}{}", if heightfield { " on terrain" } else { "" }), "target": checks.name(part), "clearLine": clear,
        "origin": [origin.x, origin.y, origin.z], "direction": [direction.x, direction.y, direction.z],
        "brokenBondCount": checks.broken.len(), "targetDetached": target_off, "targetBondBroken": target_broken,
        "expectBreak": expect_break, "breakWithin75cmOfTarget": near_target, "ballSpeedAfter": ball_speed_after, "ballClosestToTargetM": ball_closest, "firstBreakFromBallM": first_break_distance,
        "breaks": events, "looseBodies": fragments, "maxLooseKineticJ": checks.max_loose_energy, "rejectedSteps": rejected,
        "freeFlightTicks": checks.free_flight_ticks,
        "carrierCom": checks.carrier_com.map(|(parts, physx)| json!({"parts": [parts.x, parts.y, parts.z], "physx": [physx.x, physx.y, physx.z]})),
        "violations": checks.report(), "warnings": checks.warnings(), "failed": !checks.violations.is_empty()})
}

/// One car, shot again and again (as the range video does): every check holds
/// while it loses its wheels and falls apart.
fn run_progressive(geometry: &PreparedGeometry, layout: &FractureLayout, targets: &[u32], heightfield: bool) -> serde_json::Value {
    let mut scene = Scene::new(geometry, heightfield);
    let mut checks = Checks::new(geometry, layout);
    if heightfield { checks.terrain = Some(crate::demo_world::garage_test_world()); }
    let mut shots = Vec::new();
    let mut max_travel = 0f32;
    let mut observe = |scene: &mut Scene, checks: &mut Checks| {
        scene.step();
        let streamed = scene.arena.vehicle_detached_parts(CAR);
        if let Some(rig) = scene.arena.vehicle_rig(CAR, geometry.neutral_jounce) { for w in rig { max_travel = max_travel.max(w[0].abs()); } }
        let d = scene.observe();
        checks.sample(scene.tick, d, &streamed)
    };
    for _ in 0..90 { observe(&mut scene, &mut checks); }
    for &part in targets {
        let on_car = checks.last.as_ref().is_some_and(|d| d.hulls.iter().any(|h| h.part == part && h.actor == 0));
        if on_car {
            if let Some((origin, direction, _)) = scene.arena.vehicle_clear_shot(CAR, part, None) {
                let time = 8.0 / BALL_SPEED;
                scene.arena.launch_ball_from_muzzle(origin, direction * BALL_SPEED + Vector3::new(0., 0.5 * G * time, 0.),
                    crate::garage_bombardment::BALL_RADIUS, BALL_MASS, 600);
            }
        }
        let before = checks.broken.len();
        for _ in 0..150 { observe(&mut scene, &mut checks); }
        shots.push(json!({"target": checks.name(part), "fired": on_car, "broke": checks.broken.len() - before,
            "wheelMask": checks.last.as_ref().map(|d| d.vehicle.wheel_mask)}));
    }
    for _ in 0..240 { observe(&mut scene, &mut checks); }
    checks.finish(0.5 * BALL_MASS * BALL_SPEED * BALL_SPEED);
    if max_travel > 1.0 { checks.fail("rig travel out of range", format!("{max_travel}")); }
    json!({"scenario": if heightfield { "progressive on terrain" } else { "progressive" }, "shots": shots, "brokenBondCount": checks.broken.len(), "maxRigTravelM": max_travel,
        "looseBodies": checks.tracks.len(), "freeFlightTicks": checks.free_flight_ticks, "violations": checks.report(), "warnings": checks.warnings(), "failed": !checks.violations.is_empty()})
}

/// The city's meteor (same tuning, arc and body) dropped on the parked car.
fn run_meteor(geometry: &PreparedGeometry, layout: &FractureLayout, heightfield: bool) -> serde_json::Value {
    let mut scene = Scene::new(geometry, heightfield);
    let mut checks = Checks::new(geometry, layout);
    if heightfield { checks.terrain = Some(crate::demo_world::garage_test_world()); }
    let observe = |scene: &mut Scene, checks: &mut Checks| {
        scene.step();
        let streamed = scene.arena.vehicle_detached_parts(CAR);
        let d = scene.observe();
        checks.sample(scene.tick, d, &streamed)
    };
    for _ in 0..90 { observe(&mut scene, &mut checks); }
    let car = scene.arena.current_vehicle_snapshots()[0].pose.position;
    let tuning = crate::meteor::MeteorTuning::from_env();
    let launch = crate::meteor::plan(glam::Vec3::new(car.x, car.y, car.z), glam::Vec3::new(0., -G, 0.), &tuning, &mut crate::meteor::Rng::new(7));
    let meteor = scene.arena.launch_meteor(Vector3::new(launch.start.x, launch.start.y, launch.start.z),
        Vector3::new(launch.velocity.x, launch.velocity.y, launch.velocity.z), tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks);
    let flight = (launch.flight_time_s * 60.) as u32;
    let mut closest = f32::INFINITY;
    for i in 0..flight + 480 {
        checks.tracing = i + 30 >= flight && i <= flight + 150;
        observe(&mut scene, &mut checks);
        if let Some(b) = scene.arena.snapshot_dynamic_bodies().into_iter().find(|b| Some(b.0) == meteor) {
            closest = closest.min((v3(b.1) - Vector3::new(car.x, car.y, car.z)).norm());
            if checks.tracing { if let Some(last) = checks.trace.last_mut() { last["meteor"] = json!({"p": b.1, "v": b.4}); } }
        }
    }
    checks.finish(0.5 * tuning.mass_kg * launch.velocity.length_squared());
    let trace_path = format!(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/meteor-trace{}.json"), if heightfield { "-terrain" } else { "" });
    std::fs::write(&trace_path, serde_json::to_vec(&checks.trace).unwrap()).unwrap();
    let bonds = layout.bond_chunks.len();
    let on_car = checks.last.as_ref().map_or(0, |d| d.hulls.iter().filter(|h| h.actor == 0).map(|h| h.part).collect::<BTreeSet<_>>().len());
    if meteor.is_none() || closest > tuning.radius_m + 3.0 { checks.fail("the meteor did not reach the car", format!("closest {closest:.1} m")); }
    json!({"scenario": if heightfield { "meteor on terrain" } else { "meteor" }, "meteorMassKg": tuning.mass_kg, "meteorSpeed": launch.velocity.length(),
        "closestToCarM": closest, "brokenBondCount": checks.broken.len(), "bondCount": bonds,
        "brokenFraction": checks.broken.len() as f32 / bonds as f32, "partsLeftOnCar": on_car, "parts": geometry.parts.len(),
        "looseBodies": checks.tracks.len(), "freeFlightTicks": checks.free_flight_ticks,
        "violations": checks.report(), "warnings": checks.warnings(), "failed": !checks.violations.is_empty()})
}

#[test]
#[ignore = "requires local GPU, coherent ABI 22 SDK with fragmentGravity and VIBE_VEHICLE_BUILD_FIXTURES"]
fn garage_vehicle_destruction_is_rigid_body_correct() {
    let _guard = gpu_test_guard();
    let only = std::env::var("VIBE_DESTRUCTION_SCENARIOS").ok();
    let wanted = |name: &str| only.as_ref().is_none_or(|o| o.split(',').any(|s| name.starts_with(s)));
    let mut report = Vec::new();
    for (model, geometry) in fixtures() {
        let layout = geometry.validate_vehicle2_fracture_layout().unwrap();
        assert_eq!(layout.chunk_count, geometry.parts.len());
        let named = |prefix: &str| geometry.parts.iter().position(|p| p.id.starts_with(prefix));
        let targets: Vec<(&str, Option<usize>, bool)> = vec![
            ("front-left tyre", Some(layout.wheel_chunks[0][0] as usize), true),
            ("rear-right tyre", Some(layout.wheel_chunks[3][0] as usize), true),
            ("engine", layout.powertrain_chunks.first().map(|&c| c as usize), false),
            ("body panel", named("body-"), true),
        ];
        let mut run = |name: String, result: serde_json::Value| {
            eprintln!("destruction {model} {name}: {}", serde_json::to_string(&result).unwrap());
            report.push(json!({"model": model, "result": result}));
        };
        if wanted("rest") { run("rest".into(), run_rest(&geometry, &layout)); }
        if wanted("drive") { run("drive".into(), run_drive(&geometry, &layout)); }
        if wanted("progressive") {
            let names = ["fuel", "cage", "bumper"];
            let mut sequence: Vec<u32> = (0..4).map(|w| layout.wheel_chunks[w][0]).collect();
            sequence.extend(names.iter().filter_map(|n| geometry.parts.iter().position(|p| p.visual_ids.iter().any(|v| v.contains(n)) || p.id.contains(n)).map(|i| i as u32)));
            sequence.extend(named("body-").map(|i| i as u32));
            // Cage tubes, the rear of the frame and the cabin: the shots that
            // flung small pieces hardest in the range recording.
            let frames: Vec<u32> = geometry.parts.iter().enumerate().filter(|(_, p)| p.id.starts_with("frame-")).map(|(i, _)| i as u32).collect();
            sequence.extend(frames.iter().step_by((frames.len() / 4).max(1)).copied());
            sequence.extend(geometry.parts.iter().position(|p| p.id.starts_with("cabin-")).map(|i| i as u32));
            for heightfield in [false, true] {
                run("progressive".into(), run_progressive(&geometry, &layout, &sequence, heightfield));
            }
        }
        if wanted("meteor") {
            for heightfield in [false, true] { run("meteor".into(), run_meteor(&geometry, &layout, heightfield)); }
        }
        let mut free_flight = 0;
        let mut shots = 0;
        for (label, part, expect_break) in targets {
            if !wanted(&format!("shot {label}")) && !wanted("shot") { continue; }
            let Some(part) = part else { continue };
            for heightfield in [false, true] {
                let result = run_shot(&geometry, &layout, label, part as u32, expect_break, heightfield);
                free_flight += result["freeFlightTicks"].as_u64().unwrap_or(0);
                shots += 1;
                run(format!("shot {label}"), result);
            }
        }
        // The fall-at-g check must have had something to measure.
        if shots > 1 && free_flight < 20 {
            run("gravity exercised".into(), json!({"scenario": "gravity exercised", "failed": true,
                "violations": [{"check": "too little free flight to verify gravity", "count": 1, "example": format!("{free_flight} ticks")}]}));
        }
    }
    let path = std::env::var("VIBE_VEHICLE_DESTRUCTION_REPORT")
        .unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/vehicle-destruction-report.json").into());
    std::fs::write(&path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    let failed: Vec<_> = report.iter().filter(|r| r["result"]["failed"] == true)
        .map(|r| format!("{} {}: {}", r["model"], r["result"]["scenario"], r["result"]["violations"])).collect();
    assert!(failed.is_empty(), "destruction invariants failed (report {path}):\n{}", failed.join("\n"));
}

/// Where the impact tick's time goes: the meteor scenario with no debug
/// readbacks, each step timed, and PhysX's own zones (VIBE_PHYSX_PROFILE) for
/// the slow ticks. The live server aims each meteor from its own RNG, and the
/// approach decides how much breaks, so VIBE_PROFILE_SEEDS (default "7") runs
/// one scene per seed; VIBE_PROFILE_TERRAIN=1 uses the garage heightfield.
/// Writes target/meteor-tick-profile.json.
#[test]
#[ignore = "requires local GPU, coherent ABI 22 SDK and VIBE_VEHICLE_BUILD_FIXTURES"]
fn garage_meteor_impact_tick_profile() {
    let _guard = gpu_test_guard();
    std::env::set_var("VIBE_PHYSX_PROFILE", "1");
    let (_, geometry) = fixtures().into_iter().next().expect("buggy fixture");
    let heightfield = std::env::var("VIBE_PROFILE_TERRAIN").is_ok_and(|v| v == "1");
    let seeds: Vec<u64> = std::env::var("VIBE_PROFILE_SEEDS").unwrap_or("7".into())
        .split(',').map(|s| s.trim().parse().expect("VIBE_PROFILE_SEEDS: comma-separated integers")).collect();
    // Ticks simulated after the meteor lands (VIBE_PROFILE_HOLD_TICKS, default 240).
    let hold: u32 = std::env::var("VIBE_PROFILE_HOLD_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(240);
    let mut rows = Vec::new();
    let mut summary = Vec::new();
    for seed in seeds {
        let mut scene = Scene::new(&geometry, heightfield);
        let first = rows.len();
        let mut step = |scene: &mut Scene, label: &str| {
            let started = std::time::Instant::now();
            let (vehicle_ms, dynamics_ms) = scene.arena.step_vehicles_and_dynamics(DT);
            let step_ms = started.elapsed().as_secs_f64() * 1000.;
            let detached_started = std::time::Instant::now();
            let detached = scene.arena.vehicle_detached_parts(CAR).len();
            let detached_ms = detached_started.elapsed().as_secs_f64() * 1000.;
            scene.tick += 1;
            let _ = scene.arena.world.native_stats();
            let mut spans: Vec<(String, f64)> = scene.arena.world.take_destruction_spans().into_iter()
                .filter(|s| s.kind != 2 && s.value > 0.05).map(|s| (s.name, s.value)).collect();
            spans.sort_by(|a, b| b.1.total_cmp(&a.1));
            rows.push(json!({"seed": seed, "tick": scene.tick, "phase": label, "stepMs": step_ms, "vehicleMs": vehicle_ms, "dynamicsMs": dynamics_ms,
                "detachedPartsMs": detached_ms, "detached": detached, "spans": spans}));
        };
        for _ in 0..120 { step(&mut scene, "settle"); }
        let car = scene.arena.current_vehicle_snapshots()[0].pose.position;
        let tuning = crate::meteor::MeteorTuning::from_env();
        let launch = crate::meteor::plan(glam::Vec3::new(car.x, car.y, car.z), glam::Vec3::new(0., -G, 0.), &tuning, &mut crate::meteor::Rng::new(seed));
        scene.arena.launch_meteor(Vector3::new(launch.start.x, launch.start.y, launch.start.z),
            Vector3::new(launch.velocity.x, launch.velocity.y, launch.velocity.z), tuning.radius_m, tuning.mass_kg, tuning.ttl_ticks);
        for _ in 0..((launch.flight_time_s * 60.) as u32 + hold) { step(&mut scene, "meteor"); }
        let bodies = scene.arena.vehicle_destruction_debug(CAR).ok().map(|d| d["actors"].as_array().map_or(0, |a| a.len()));
        let meteor: Vec<f64> = rows[first..].iter().filter(|r| r["phase"] == "meteor").map(|r| r["stepMs"].as_f64().unwrap()).collect();
        let mut sorted = meteor.clone();
        sorted.sort_by(f64::total_cmp);
        summary.push(json!({"seed": seed, "worstMs": sorted.last(), "overBudget": meteor.iter().filter(|&&m| m > 1000. / 60.).count(),
            "over50": meteor.iter().filter(|&&m| m > 50.).count(), "medianMs": sorted[sorted.len() / 2],
            "detached": rows.last().unwrap()["detached"], "bodies": bodies}));
        let mut worst: Vec<&serde_json::Value> = rows[first..].iter().collect();
        worst.sort_by(|a, b| b["stepMs"].as_f64().unwrap().total_cmp(&a["stepMs"].as_f64().unwrap()));
        for row in worst.iter().take(4) {
            eprintln!("seed {seed} tick {} step {:.1} ms (vehicle {:.1}, dynamics {:.1}, detached read {:.2}) detached {}: {:?}", row["tick"], row["stepMs"].as_f64().unwrap(),
                row["vehicleMs"].as_f64().unwrap(), row["dynamicsMs"].as_f64().unwrap(), row["detachedPartsMs"].as_f64().unwrap(), row["detached"],
                row["spans"].as_array().unwrap().iter().take(14).collect::<Vec<_>>());
        }
    }
    for s in &summary { eprintln!("summary {s}"); }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/meteor-tick-profile.json");
    std::fs::write(path, serde_json::to_vec_pretty(&json!({"summary": summary, "rows": rows})).unwrap()).unwrap();
}
