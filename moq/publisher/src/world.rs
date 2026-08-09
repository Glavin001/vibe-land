//! A stand-in for the authoritative destruction sim.
//!
//! The point of the demo is the transport, not the physics, so this is a cheap
//! simulation with the same *shape* as the real thing: a grid of destructible
//! chunks split across regions, blasts that damage whatever is nearby, and
//! debris that falls until it settles into rubble.
//!
//! Every mutation bumps a monotonic world version and stamps it on the chunk it
//! touched. That is what makes per-track deltas cheap: a track publishing region
//! 3 at 1 Hz just asks for "chunks in region 3 with version > the last one I
//! sent" and gets exactly the rows it needs, no diffing and no per-subscriber
//! bookkeeping.

use rand::{rngs::StdRng, Rng, SeedableRng};

use crate::wire::WireChunk;

pub const REGION_COUNT: usize = 4;
/// Regions are laid out as a 2x2 grid of city blocks.
pub const REGION_COLS: usize = 2;
pub const CHUNKS_PER_SIDE: usize = 8;
pub const CHUNKS_PER_REGION: usize = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;
pub const CHUNK_COUNT: usize = REGION_COUNT * CHUNKS_PER_REGION;

/// Metres between chunk centres.
const CHUNK_SPACING_M: f32 = 4.0;
const GRAVITY_M_S2: f32 = 9.81;
const FULL_HP: f32 = 255.0;

pub const STATE_INTACT: u8 = 0;
pub const STATE_DAMAGED: u8 = 1;
pub const STATE_FALLING: u8 = 2;
pub const STATE_RUBBLE: u8 = 3;

/// Rebuild the map once this much of it is rubble, so a long-running demo keeps
/// producing interesting deltas instead of settling into a flat plain.
const REBUILD_AT_DESTROYED_FRACTION: f32 = 0.7;

#[derive(Debug, Clone)]
pub struct Chunk {
    pub id: u16,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub vy: f32,
    pub spin: f32,
    pub hp: f32,
    pub state: u8,
    /// World version at the last mutation of this chunk.
    pub version: u64,
    base_y: f32,
}

impl Chunk {
    fn to_wire(&self) -> WireChunk {
        WireChunk {
            id: self.id,
            state: self.state,
            hp: self.hp.clamp(0.0, FULL_HP) as u8,
            x_cm: metres_to_cm(self.x),
            y_cm: metres_to_cm(self.y),
            z_cm: metres_to_cm(self.z),
            yaw_mrad: radians_to_mrad(self.yaw),
        }
    }
}

pub struct World {
    pub tick: u32,
    /// Monotonic counter bumped on every chunk mutation.
    pub version: u64,
    pub chunks: Vec<Chunk>,
    pub round: u16,
    pub players_alive: u16,
    pub headline: String,
    rng: StdRng,
    ticks_until_blast: u32,
}

impl World {
    pub fn new(seed: u64) -> Self {
        let mut world = Self {
            tick: 0,
            version: 1,
            chunks: Vec::with_capacity(CHUNK_COUNT),
            round: 1,
            players_alive: 24,
            headline: "match start".to_string(),
            rng: StdRng::seed_from_u64(seed),
            ticks_until_blast: 0,
        };
        world.build_city();
        world
    }

    fn build_city(&mut self) {
        self.chunks.clear();

        for region in 0..REGION_COUNT {
            let region_x = (region % REGION_COLS) as f32;
            let region_z = (region / REGION_COLS) as f32;

            for id in 0..CHUNKS_PER_REGION {
                let cx = (id % CHUNKS_PER_SIDE) as f32;
                let cz = (id / CHUNKS_PER_SIDE) as f32;

                // Offset so the whole 2x2 grid straddles the origin.
                let span = CHUNKS_PER_SIDE as f32 * CHUNK_SPACING_M;
                let x = region_x * span + cx * CHUNK_SPACING_M - span;
                let z = region_z * span + cz * CHUNK_SPACING_M - span;

                // A deterministic pseudo-skyline: varied heights read better in
                // the demo than a flat slab, and they stay stable across rounds.
                let base_y = 2.0 + ((id * 7 + region * 13) % 5) as f32 * 2.0;

                self.chunks.push(Chunk {
                    id: id as u16,
                    x,
                    y: base_y,
                    z,
                    yaw: 0.0,
                    vy: 0.0,
                    spin: 0.0,
                    hp: FULL_HP,
                    state: STATE_INTACT,
                    version: self.version,
                    base_y,
                });
            }
        }
    }

    /// Advance the simulation by one tick of `dt` seconds.
    pub fn step(&mut self, dt: f32) {
        self.tick = self.tick.wrapping_add(1);

        if self.ticks_until_blast == 0 {
            self.detonate();
            // Somewhere between a third of a second and two seconds at 60 Hz.
            self.ticks_until_blast = self.rng.gen_range(20..120);
        } else {
            self.ticks_until_blast -= 1;
        }

        self.settle_debris(dt);

        if self.destroyed_fraction() >= REBUILD_AT_DESTROYED_FRACTION {
            self.next_round();
        }
    }

    /// Damage everything within the blast radius of a random epicentre.
    fn detonate(&mut self) {
        let region = self.rng.gen_range(0..REGION_COUNT);
        let radius: f32 = self.rng.gen_range(6.0..14.0);

        // Aim at a real chunk so blasts always land on something.
        let anchor = region * CHUNKS_PER_REGION + self.rng.gen_range(0..CHUNKS_PER_REGION);
        let (ex, ez) = (self.chunks[anchor].x, self.chunks[anchor].z);

        let mut destroyed_here = 0usize;

        for index in 0..self.chunks.len() {
            if self.chunks[index].state == STATE_RUBBLE || self.chunks[index].state == STATE_FALLING
            {
                continue;
            }

            let dx = self.chunks[index].x - ex;
            let dz = self.chunks[index].z - ez;
            let distance = (dx * dx + dz * dz).sqrt();
            if distance > radius {
                continue;
            }

            let falloff = 1.0 - distance / radius;
            let damage = falloff * self.rng.gen_range(120.0..260.0);

            let version = self.next_version();
            let chunk = &mut self.chunks[index];
            chunk.hp -= damage;
            chunk.version = version;

            if chunk.hp <= 0.0 {
                chunk.hp = 0.0;
                chunk.state = STATE_FALLING;
                chunk.vy = 0.0;
                destroyed_here += 1;
            } else {
                chunk.state = STATE_DAMAGED;
            }
        }

        // The spin range needs the rng after the borrow above is released.
        for index in 0..self.chunks.len() {
            if self.chunks[index].state == STATE_FALLING && self.chunks[index].spin == 0.0 {
                let spin = self.rng.gen_range(-3.0..3.0);
                self.chunks[index].spin = spin;
            }
        }

        if destroyed_here > 0 {
            self.headline = format!("{destroyed_here} chunks down in region {region}");
        }
    }

    /// Move falling debris and park it as rubble once it hits the ground.
    fn settle_debris(&mut self, dt: f32) {
        for index in 0..self.chunks.len() {
            if self.chunks[index].state != STATE_FALLING {
                continue;
            }

            let version = self.next_version();
            let chunk = &mut self.chunks[index];

            chunk.vy -= GRAVITY_M_S2 * dt;
            chunk.y += chunk.vy * dt;
            chunk.yaw += chunk.spin * dt;
            chunk.version = version;

            if chunk.y <= 0.0 {
                chunk.y = 0.0;
                chunk.vy = 0.0;
                chunk.spin = 0.0;
                chunk.state = STATE_RUBBLE;
            }
        }
    }

    fn next_round(&mut self) {
        self.round = self.round.wrapping_add(1);
        self.players_alive = self.rng.gen_range(8..32);
        self.headline = format!("round {} — city rebuilt", self.round);

        let version = self.next_version();
        for chunk in &mut self.chunks {
            chunk.y = chunk.base_y;
            chunk.yaw = 0.0;
            chunk.vy = 0.0;
            chunk.spin = 0.0;
            chunk.hp = FULL_HP;
            chunk.state = STATE_INTACT;
            chunk.version = version;
        }
    }

    fn next_version(&mut self) -> u64 {
        self.version += 1;
        self.version
    }

    pub fn destroyed_fraction(&self) -> f32 {
        let rubble = self
            .chunks
            .iter()
            .filter(|c| c.state == STATE_RUBBLE)
            .count();
        rubble as f32 / self.chunks.len() as f32
    }

    pub fn destroyed_pct(&self) -> u8 {
        (self.destroyed_fraction() * 100.0).round() as u8
    }

    /// Every chunk in a region — the keyframe a subscriber needs before deltas
    /// mean anything.
    pub fn snapshot(&self, region: u8) -> Vec<WireChunk> {
        self.region_chunks(region).map(Chunk::to_wire).collect()
    }

    /// Only the chunks in a region that changed after `since`.
    pub fn delta(&self, region: u8, since: u64) -> Vec<WireChunk> {
        self.region_chunks(region)
            .filter(|c| c.version > since)
            .map(Chunk::to_wire)
            .collect()
    }

    fn region_chunks(&self, region: u8) -> impl Iterator<Item = &Chunk> {
        let start = region as usize * CHUNKS_PER_REGION;
        self.chunks[start..start + CHUNKS_PER_REGION].iter()
    }
}

fn metres_to_cm(metres: f32) -> i16 {
    (metres * 100.0)
        .round()
        .clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

fn radians_to_mrad(radians: f32) -> i16 {
    // Wrap into (-pi, pi] first so a long-spinning chunk doesn't saturate.
    let tau = std::f32::consts::TAU;
    let mut wrapped = radians % tau;
    if wrapped > std::f32::consts::PI {
        wrapped -= tau;
    } else if wrapped < -std::f32::consts::PI {
        wrapped += tau;
    }
    (wrapped * 1000.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn city_has_one_entry_per_region_chunk() {
        let world = World::new(1);
        assert_eq!(world.chunks.len(), CHUNK_COUNT);

        for region in 0..REGION_COUNT as u8 {
            assert_eq!(world.snapshot(region).len(), CHUNKS_PER_REGION);
        }
    }

    #[test]
    fn delta_only_reports_chunks_touched_since_the_watermark() {
        let mut world = World::new(7);
        let watermark = world.version;

        // Run long enough that at least one blast has landed.
        for _ in 0..600 {
            world.step(1.0 / 60.0);
        }

        let touched: usize = (0..REGION_COUNT as u8)
            .map(|r| world.delta(r, watermark).len())
            .sum();
        assert!(touched > 0, "expected some chunks to change");

        // Nothing has changed since the newest version, by definition.
        let after: usize = (0..REGION_COUNT as u8)
            .map(|r| world.delta(r, world.version).len())
            .sum();
        assert_eq!(after, 0);
    }

    #[test]
    fn debris_settles_into_rubble_on_the_ground() {
        let mut world = World::new(3);
        for _ in 0..3_000 {
            world.step(1.0 / 60.0);
        }

        assert!(
            world.chunks.iter().any(|c| c.state == STATE_RUBBLE),
            "expected debris to reach the ground"
        );
        assert!(
            world.chunks.iter().all(|c| c.y >= 0.0),
            "chunks must not fall through the floor"
        );
    }

    #[test]
    fn yaw_wraps_instead_of_saturating() {
        // Ten full turns should land back near zero, not pinned at i16::MAX.
        assert!(radians_to_mrad(std::f32::consts::TAU * 10.0).abs() < 10);
        assert_eq!(radians_to_mrad(std::f32::consts::PI), 3142);
    }

    #[test]
    fn positions_fit_the_wire_encoding() {
        let world = World::new(11);
        for chunk in &world.chunks {
            let wire = chunk.to_wire();
            assert_eq!(wire.x_cm as f32 / 100.0, (chunk.x * 100.0).round() / 100.0);
        }
    }
}
