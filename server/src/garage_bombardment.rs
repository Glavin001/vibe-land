//! Repeatable, opt-in physical projectile schedule shared by gameplay and tests.
//! This does not issue fracture commands: contacts are the only impact source.
use nalgebra::Vector3;
use serde::{Deserialize, Serialize};

pub const CANNON_COUNT: usize = 8;
pub const BALL_RADIUS: f32 = 0.20;
pub const BALL_MASS: f32 = 30.0;
pub const BALL_TTL: u32 = 600;
pub const INTERVAL: u32 = 150;
pub const WARNING_TICKS: u32 = 120;

pub fn mount(index: usize) -> [f32; 3] {
    let angle = index as f32 * std::f32::consts::TAU / CANNON_COUNT as f32;
    [100.0 * angle.cos(), 9.0, 100.0 * angle.sin()]
}

#[derive(Default, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub shots_fired: u32,
    // Explicit until native Vehicle2 constraint ownership is implemented.
    pub vehicle_fracture_ready: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request { pub enabled: bool }

pub struct Bombardment {
    pub status: Status,
    next_tick: u32,
    seed: u32,
}
impl Default for Bombardment {
    fn default() -> Self { Self { status: Status::default(), next_tick: 0, seed: 0x61726167 } }
}
impl Bombardment {
    pub fn set_enabled(&mut self, enabled: bool, tick: u32) -> Status {
        if enabled != self.status.enabled {
            self.status.enabled = enabled;
            self.next_tick = tick.wrapping_add(WARNING_TICKS);
        }
        self.status
    }
    fn random(&mut self) -> f32 {
        self.seed ^= self.seed << 13; self.seed ^= self.seed >> 17; self.seed ^= self.seed << 5;
        self.seed as f32 / u32::MAX as f32
    }
    pub fn next_shot(&mut self, tick: u32, target: Option<(Vector3<f32>, Vector3<f32>)>) -> Option<Shot> {
        if !self.status.enabled { return None; }
        let Some((position, velocity)) = target else {
            self.next_tick = tick.wrapping_add(WARNING_TICKS);
            return None;
        };
        if tick.wrapping_sub(self.next_tick) >= (1 << 31) { return None; }
        self.next_tick = tick.wrapping_add(INTERVAL);
        let cannon = (self.random() * CANNON_COUNT as f32) as usize % CANNON_COUNT;
        let origin = Vector3::from(mount(cannon));
        let time = ((position-origin).norm()/55.0).clamp(1.0, 3.2);
        // Aim once on firing. Players can dodge; rounds never home in flight.
        let spread = Vector3::new((self.random()-0.5)*4.0, (self.random()-0.5)*0.8, (self.random()-0.5)*4.0);
        Some(aimed_shot(origin, position + velocity*time + spread, time))
    }
    pub fn record_launch(&mut self) { self.status.shots_fired += 1; }
}
#[derive(Clone, Copy, Debug)]
pub struct Shot { pub origin: Vector3<f32>, pub velocity: Vector3<f32> }
pub fn aimed_shot(origin: Vector3<f32>, target: Vector3<f32>, flight_time: f32) -> Shot {
    Shot { origin, velocity: (target-origin)/flight_time + Vector3::new(0.0, 9.81*flight_time*0.5, 0.0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_cadence_stop_and_driver_grace() {
        let mut b=Bombardment::default();
        let car=Some((Vector3::zeros(),Vector3::zeros()));
        assert!(b.next_shot(1000,car).is_none());
        b.set_enabled(true,1000);
        assert!(b.next_shot(1119,car).is_none());
        assert!(b.next_shot(1120,car).is_some());
        assert!(b.next_shot(1121,car).is_none());
        b.set_enabled(true,1121); // Idempotent requests cannot reset the timer.
        assert!(b.next_shot(1270,car).is_some());
        b.next_shot(1420,None);
        assert!(b.next_shot(1539,car).is_none());
        assert!(b.next_shot(1540,car).is_some());
        b.set_enabled(false,1540);
        assert!(b.next_shot(5000,car).is_none());
    }
    #[test]
    fn ballistic_aim_reaches_the_requested_point() {
        for i in 0..CANNON_COUNT {
            let origin=Vector3::from(mount(i));
            let target=Vector3::new(-23.0,1.0,14.0); let t=2.3;
            let shot=aimed_shot(origin,target,t);
            let end=origin+shot.velocity*t+Vector3::new(0.0,-4.905*t*t,0.0);
            assert!((end-target).norm()<1e-4);
            assert!(shot.velocity.norm()<80.0);
        }
    }
}
