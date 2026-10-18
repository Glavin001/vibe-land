//! The probe scene: a tower of dynamic boxes falling onto a ground plane,
//! stepped on its own thread at 60 Hz. It proves the in-process path end to
//! end -- PhysX (CuMetal on macOS) stepping in the same process as the
//! renderer, frames handed to JS through shared memory -- before the real
//! city sim moves behind the same interface.
//!
//! Slot layout (u32 words; poses are f32 bit patterns):
//!   [0] tick  [1] body count  [2] step time in microseconds  [3] reserved
//!   then per body: x, y, z, qx, qy, qz, qw

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::frame::Writer;

pub const HEADER_WORDS: usize = 4;
pub const WORDS_PER_BODY: usize = 7;
pub const TICK_HZ: f64 = 60.0;

pub struct Probe {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<(), String>>>,
}

impl Probe {
    pub fn spawn(boxes: usize, writer: Writer) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("vibe-sim-probe".into())
            .spawn(move || run(boxes, writer, flag))
            .expect("spawn sim thread");
        Self { stop, thread: Some(thread) }
    }

    /// Stops the sim thread and returns its error, if it failed.
    pub fn stop(&mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Release);
        match self.thread.take() {
            Some(thread) => thread.join().unwrap_or_else(|_| Err("sim thread panicked".into())),
            None => Ok(()),
        }
    }
}

/// Initial position of box `i`: a 2 x 2 column, slightly offset per level so
/// it topples once it lands.
fn initial_position(i: usize) -> [f32; 3] {
    let level = (i / 4) as f32;
    let x = (i % 2) as f32 * 1.02 + level * 0.03;
    let z = ((i / 2) % 2) as f32 * 1.02;
    [x, 0.5 + level * 1.02 + 2.0, z]
}

fn run(boxes: usize, mut writer: Writer, stop: Arc<AtomicBool>) -> Result<(), String> {
    let mut scene = Scene::new(boxes)?;
    let period = Duration::from_secs_f64(1.0 / TICK_HZ);
    let mut next = Instant::now();
    let mut tick: u32 = 0;
    while !stop.load(Ordering::Acquire) {
        let started = Instant::now();
        scene.step()?;
        tick = tick.wrapping_add(1);
        let slot = writer.slot();
        let count = scene.write_poses(&mut slot[HEADER_WORDS..]);
        slot[0] = tick;
        slot[1] = count as u32;
        slot[2] = started.elapsed().as_micros().min(u32::MAX as u128) as u32;
        writer.publish();

        next += period;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now; // fell behind: do not try to catch up in a burst
        }
    }
    Ok(())
}

#[cfg(feature = "physx")]
struct Scene {
    world: vibe_land_physx_bridge::World,
    ids: Vec<u32>,
}

#[cfg(feature = "physx")]
impl Scene {
    fn new(boxes: usize) -> Result<Self, String> {
        use vibe_land_physx_bridge::{DynamicBoxDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig};
        const GROUP_STATIC: u32 = 1 << 0;
        const GROUP_DYNAMIC: u32 = 1 << 1;
        const ALL_GROUPS: u32 = u32::MAX;

        let mut world = World::new(WorldConfig::default()).map_err(|e| e.to_string())?;
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 1,
                user_id: 0,
                pose: Pose { position: Vec3::new(0.0, -10.0, 0.0), rotation: Quat::IDENTITY },
                half_extents: Vec3::new(200.0, 10.0, 200.0),
                collision_group: GROUP_STATIC,
                collision_mask: ALL_GROUPS,
            })
            .map_err(|e| e.to_string())?;
        let mut ids = Vec::with_capacity(boxes);
        for i in 0..boxes {
            let [x, y, z] = initial_position(i);
            let entity_id = 2 + i as u32;
            world
                .add_dynamic_box(DynamicBoxDesc {
                    entity_id,
                    user_id: 0,
                    pose: Pose { position: Vec3::new(x, y, z), rotation: Quat::IDENTITY },
                    half_extents: Vec3::new(0.5, 0.5, 0.5),
                    mass: 100.0,
                    collision_group: GROUP_DYNAMIC,
                    collision_mask: ALL_GROUPS,
                })
                .map_err(|e| e.to_string())?;
            ids.push(entity_id);
        }
        Ok(Self { world, ids })
    }

    fn step(&mut self) -> Result<(), String> {
        self.world.step().map_err(|e| e.to_string())
    }

    fn write_poses(&self, out: &mut [u32]) -> usize {
        let Ok(snapshots) = self.world.body_snapshots() else { return 0 };
        let mut written = 0;
        for snapshot in snapshots {
            let Ok(index) = self.ids.binary_search(&snapshot.entity_id) else { continue };
            let p = snapshot.pose;
            let words = &mut out[index * WORDS_PER_BODY..(index + 1) * WORDS_PER_BODY];
            for (word, value) in words.iter_mut().zip([
                p.position.x, p.position.y, p.position.z,
                p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w,
            ]) {
                *word = value.to_bits();
            }
            written += 1;
        }
        debug_assert!(written <= self.ids.len());
        self.ids.len()
    }
}

/// CPU stand-in without PhysX: boxes fall and stop on the ground. Only for
/// exercising the module plumbing on machines without the PhysX SDK.
#[cfg(not(feature = "physx"))]
struct Scene {
    bodies: Vec<([f32; 3], f32)>,
}

#[cfg(not(feature = "physx"))]
impl Scene {
    fn new(boxes: usize) -> Result<Self, String> {
        Ok(Self { bodies: (0..boxes).map(|i| (initial_position(i), 0.0)).collect() })
    }

    fn step(&mut self) -> Result<(), String> {
        let dt = (1.0 / TICK_HZ) as f32;
        for (position, velocity) in &mut self.bodies {
            *velocity -= 9.81 * dt;
            position[1] = (position[1] + *velocity * dt).max(0.5);
            if position[1] <= 0.5 {
                *velocity = 0.0;
            }
        }
        Ok(())
    }

    fn write_poses(&self, out: &mut [u32]) -> usize {
        for (i, (p, _)) in self.bodies.iter().enumerate() {
            let words = &mut out[i * WORDS_PER_BODY..(i + 1) * WORDS_PER_BODY];
            for (word, value) in words.iter_mut().zip([p[0], p[1], p[2], 0.0, 0.0, 0.0, 1.0]) {
                *word = value.to_bits();
            }
        }
        self.bodies.len()
    }
}
