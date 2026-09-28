//! Repeatable, opt-in physical projectile schedule shared by gameplay and tests.
//! This does not issue fracture commands: contacts are the only impact source.
use nalgebra::Vector3;
use serde::{Deserialize, Serialize};

/// Towers on the 100 m ring. The first eight keep their original places; the
/// second eight stand halfway between them.
pub const CANNON_COUNT: usize = 16;
pub const BALL_RADIUS: f32 = 0.20;
pub const BALL_MASS: f32 = 30.0;
pub const BALL_TTL: u32 = 600;
pub const INTERVAL: u32 = 150;
pub const WARNING_TICKS: u32 = 120;
/// Ticks between the rounds of one volley, so a volley is heard as a salvo.
pub const VOLLEY_STAGGER: u32 = 6;
/// Ticks between meteors when they are in the mix, and before the first.
pub const METEOR_INTERVAL: u32 = 600;
pub const METEOR_WARNING_TICKS: u32 = 300;

pub fn mount(index: usize) -> [f32; 3] {
    let ring = CANNON_COUNT / 2;
    let step = (index % ring) as f32 + if index < ring { 0.0 } else { 0.5 };
    let angle = step * std::f32::consts::TAU / ring as f32;
    [100.0 * angle.cos(), 9.0, 100.0 * angle.sin()]
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub shots_fired: u32,
    /// Towers that fire in each volley, 1..=CANNON_COUNT.
    pub towers: u32,
    /// Whether meteors are dropped on the car between volleys.
    pub meteors: bool,
    pub meteors_fired: u32,
    // Explicit until native Vehicle2 constraint ownership is implemented.
    pub vehicle_fracture_ready: bool,
}
impl Default for Status {
    fn default() -> Self {
        Self { enabled: false, shots_fired: 0, towers: 1, meteors: false, meteors_fired: 0, vehicle_fracture_ready: false }
    }
}
/// Omitted options keep their current setting.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub enabled: bool,
    #[serde(default)]
    pub towers: Option<u32>,
    #[serde(default)]
    pub meteors: Option<bool>,
}

pub struct Bombardment {
    pub status: Status,
    next_tick: u32,
    next_meteor_tick: u32,
    /// Rounds of the current volley still to fire: (tick, tower).
    volley: Vec<(u32, usize)>,
    seed: u32,
}
impl Default for Bombardment {
    fn default() -> Self {
        Self { status: Status::default(), next_tick: 0, next_meteor_tick: 0, volley: Vec::new(), seed: 0x61726167 }
    }
}
fn due(tick: u32, at: u32) -> bool { tick.wrapping_sub(at) < (1 << 31) }
impl Bombardment {
    pub fn set_enabled(&mut self, enabled: bool, tick: u32) -> Status {
        if enabled != self.status.enabled {
            self.status.enabled = enabled;
            self.next_tick = tick.wrapping_add(WARNING_TICKS);
            self.next_meteor_tick = tick.wrapping_add(METEOR_WARNING_TICKS);
            self.volley.clear();
        }
        self.status
    }
    pub fn configure(&mut self, request: &Request, tick: u32) -> Status {
        if let Some(towers) = request.towers { self.status.towers = towers.clamp(1, CANNON_COUNT as u32); }
        if let Some(meteors) = request.meteors {
            // Switching meteors on mid-bombardment still gives the warning.
            if meteors && !self.status.meteors { self.next_meteor_tick = tick.wrapping_add(METEOR_WARNING_TICKS); }
            self.status.meteors = meteors;
        }
        self.set_enabled(request.enabled, tick)
    }
    fn random(&mut self) -> f32 {
        self.seed ^= self.seed << 13; self.seed ^= self.seed >> 17; self.seed ^= self.seed << 5;
        self.seed as f32 / u32::MAX as f32
    }
    /// Every round due this tick, each aimed at the car as it is now.
    pub fn next_shots(&mut self, tick: u32, target: Option<(Vector3<f32>, Vector3<f32>)>) -> Vec<Shot> {
        if !self.status.enabled { return Vec::new(); }
        let Some((position, velocity)) = target else {
            // Nobody driving: hold fire and restart the warning.
            self.next_tick = tick.wrapping_add(WARNING_TICKS);
            self.next_meteor_tick = tick.wrapping_add(METEOR_WARNING_TICKS);
            self.volley.clear();
            return Vec::new();
        };
        if due(tick, self.next_tick) {
            self.next_tick = tick.wrapping_add(INTERVAL);
            // Distinct towers, in a random order.
            let mut towers: Vec<usize> = (0..CANNON_COUNT).collect();
            for round in 0..self.status.towers as usize {
                let left = CANNON_COUNT - round;
                let pick = round + (self.random() * left as f32) as usize % left;
                towers.swap(round, pick);
                self.volley.push((tick.wrapping_add(round as u32 * VOLLEY_STAGGER), towers[round]));
            }
        }
        let mut shots = Vec::new();
        let mut pending = std::mem::take(&mut self.volley);
        pending.retain(|&(at, cannon)| {
            if !due(tick, at) { return true; }
            let origin = Vector3::from(mount(cannon));
            let time = ((position-origin).norm()/55.0).clamp(1.0, 3.2);
            // Aim once on firing. Players can dodge; rounds never home in flight.
            let spread = Vector3::new((self.random()-0.5)*4.0, (self.random()-0.5)*0.8, (self.random()-0.5)*4.0);
            shots.push(aimed_shot(origin, position + velocity*time + spread, time));
            false
        });
        self.volley = pending;
        shots
    }
    /// When meteors are in the mix and one is due: the car's position and
    /// velocity to lead it by (the caller knows the meteor's flight time).
    pub fn next_meteor(&mut self, tick: u32, target: Option<(Vector3<f32>, Vector3<f32>)>) -> Option<(Vector3<f32>, Vector3<f32>)> {
        if !self.status.enabled || !self.status.meteors { return None; }
        let target = target?;
        if !due(tick, self.next_meteor_tick) { return None; }
        self.next_meteor_tick = tick.wrapping_add(METEOR_INTERVAL);
        Some(target)
    }
    pub fn record_launch(&mut self) { self.status.shots_fired += 1; }
    pub fn record_meteor(&mut self) { self.status.meteors_fired += 1; }
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
        assert!(b.next_shots(1000,car).is_empty());
        b.set_enabled(true,1000);
        assert!(b.next_shots(1119,car).is_empty());
        assert_eq!(b.next_shots(1120,car).len(),1);
        assert!(b.next_shots(1121,car).is_empty());
        b.set_enabled(true,1121); // Idempotent requests cannot reset the timer.
        assert_eq!(b.next_shots(1270,car).len(),1);
        b.next_shots(1420,None);
        assert!(b.next_shots(1539,car).is_empty());
        assert_eq!(b.next_shots(1540,car).len(),1);
        b.set_enabled(false,1540);
        assert!(b.next_shots(5000,car).is_empty());
    }
    #[test]
    fn a_volley_fires_distinct_towers_staggered() {
        let mut b=Bombardment::default();
        let car=Some((Vector3::zeros(),Vector3::zeros()));
        b.configure(&Request{enabled:true,towers:Some(6),meteors:None},0);
        let mut fired=Vec::new();
        for tick in WARNING_TICKS..WARNING_TICKS+INTERVAL {
            for shot in b.next_shots(tick,car) { fired.push((tick,shot.origin)); }
        }
        assert_eq!(fired.len(),6);
        for (k,(tick,_)) in fired.iter().enumerate() { assert_eq!(*tick,WARNING_TICKS+k as u32*VOLLEY_STAGGER); }
        for (i,a) in fired.iter().enumerate() { for b in &fired[i+1..] { assert!((a.1-b.1).norm()>1.0,"towers repeat in a volley"); } }
        // Every tower at once is allowed; more is clamped.
        b.configure(&Request{enabled:true,towers:Some(99),meteors:None},0);
        assert_eq!(b.status.towers,CANNON_COUNT as u32);
    }
    #[test]
    fn meteors_are_opt_in_and_warned() {
        let mut b=Bombardment::default();
        let car=Some((Vector3::new(1.0,0.0,2.0),Vector3::new(3.0,0.0,0.0)));
        b.configure(&Request{enabled:true,towers:None,meteors:None},0);
        assert!((0..2000).all(|t| b.next_meteor(t,car).is_none()));
        b.configure(&Request{enabled:true,towers:None,meteors:Some(true)},2000);
        assert!(b.next_meteor(2000+METEOR_WARNING_TICKS-1,car).is_none());
        assert_eq!(b.next_meteor(2000+METEOR_WARNING_TICKS,car),car);
        assert!(b.next_meteor(2000+METEOR_WARNING_TICKS+1,car).is_none());
        assert!(b.next_meteor(2000+METEOR_WARNING_TICKS+METEOR_INTERVAL,car).is_some());
        assert!(b.next_meteor(9000,None).is_none());
    }
    #[test]
    fn original_towers_keep_their_places() {
        for i in 0..8 {
            let angle=i as f32*std::f32::consts::TAU/8.0;
            let [x,y,z]=mount(i);
            assert!((x-100.0*angle.cos()).abs()<1e-4 && y==9.0 && (z-100.0*angle.sin()).abs()<1e-4);
        }
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
