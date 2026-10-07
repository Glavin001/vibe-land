//! The infinite-wall probe: what an impactor (a projectile or a car) met when
//! it hit a structure, grounded in momentum and strength.
//!
//! Hooked into the vehicle test bed (server/src/vehicle_testbed.rs) for any
//! trial with `"probe": true` -- the wall matrix, structures/vehicle-lab/
//! wall-matrix.mjs -- it records the impactor's velocity along its approach
//! every tick with the stage's status, and at the tick that took the most
//! momentum out of it:
//!
//!   - the peak contact force, F = m dv / dt (the impulse that tick);
//!   - the chunks of the struck structure it touched (pack geometry: node
//!     boxes against the impactor's sphere swept over the tick, or the car's
//!     bounds), less supports;
//!   - the most that set's bonds can hold it with: every bond with one end in
//!     the set at its fatal limits, sqrt(max(tension, compression)^2 + shear^2)
//!     x area, plus the set's weight. A contact force above that has no static
//!     equilibrium: some bond on the set's boundary must break;
//!   - whether the set was still on the anchored body after that tick.
//!
//! A set that took more than its bonds can carry and stayed anchored is an
//! infinite wall: the anchored body is kinematic, so it stops whatever hits it
//! at any force. `node structures/vehicle-lab/wall-report.mjs` judges a report.
#![cfg(all(test, feature = "native-destruction"))]

use nalgebra::Vector3;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

const G: f32 = vibe_netcode::movement::GRAVITY as f32;

/// The pack's bonds and materials, for the capacity of a set of chunks.
pub struct Strength {
    centroid: Vec<Vector3<f32>>,
    half: Vec<Vector3<f32>>,
    mass: Vec<f32>,
    /// Per node: (bond index, other node, upper-bound capacity N).
    bonds: Vec<Vec<(u32, u32, f32)>>,
    pub types: Vec<String>,
    pub groups: Vec<String>,
}

impl Strength {
    pub fn load(path: &str) -> Self {
        let pack: Value = serde_json::from_slice(&std::fs::read(path).expect("pack")).unwrap();
        let s = &pack["scenario"];
        let nodes = s["nodes"].as_array().unwrap();
        let v3 = |v: &Value| Vector3::new(v["x"].as_f64().unwrap_or(0.) as f32, v["y"].as_f64().unwrap_or(0.) as f32, v["z"].as_f64().unwrap_or(0.) as f32);
        let centroid: Vec<_> = nodes.iter().map(|n| v3(&n["centroid"])).collect();
        let half: Vec<_> = s["nodeSizes"].as_array().unwrap().iter().map(|v| v3(v) * 0.5).collect();
        let mass: Vec<f32> = nodes.iter().map(|n| n["mass"].as_f64().unwrap_or(0.) as f32).collect();
        let materials = pack["defaults"]["solver"]["materials"].as_array().unwrap();
        let cap = |m: usize| {
            let f = |k: &str| materials[m][k].as_f64().unwrap_or(0.) as f32;
            (f("tensionFatal").max(f("compressionFatal")).powi(2) + f("shearFatal").powi(2)).sqrt()
        };
        let mut bonds = vec![Vec::new(); nodes.len()];
        for (i, b) in s["bonds"].as_array().unwrap().iter().enumerate() {
            let (a, c) = (b["node0"].as_u64().unwrap() as u32, b["node1"].as_u64().unwrap() as u32);
            let capacity = cap(b["m"].as_u64().unwrap_or(0) as usize) * b["area"].as_f64().unwrap_or(0.) as f32;
            bonds[a as usize].push((i as u32, c, capacity));
            bonds[c as usize].push((i as u32, a, capacity));
        }
        let strings = |k: &str| s[k].as_array().map_or(Vec::new(), |v| v.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect());
        Self { centroid, half, mass, bonds, types: strings("nodeTypes"), groups: strings("nodeGroups") }
    }

    /// Whether node `i` is a candidate: not a support, and in the struck structure.
    fn candidate(&self, i: usize, group: &str) -> bool {
        self.mass[i] > 0. && self.groups.get(i).map_or(true, |g| g.starts_with(group))
    }

    /// Non-support nodes of `group` whose box comes within `reach` of a sphere
    /// swept from `a` to `b` over the tick (an impactor moves a metre or more a tick).
    pub fn touching_sphere(&self, a: Vector3<f32>, b: Vector3<f32>, r: f32, reach: f32, group: &str) -> Vec<u32> {
        let steps = (((b - a).norm() / (0.5 * r).max(0.05)).ceil() as usize).clamp(1, 64);
        (0..self.centroid.len()).filter(|&i| self.candidate(i, group) && (0..=steps).any(|k| {
            let c = a + (b - a) * (k as f32 / steps as f32);
            let d = (c - self.centroid[i]).abs() - self.half[i];
            d.map(|x| x.max(0.)).norm() < r + reach
        })).map(|i| i as u32).collect()
    }

    /// Non-support nodes whose box comes within `reach` of a box (`lo`..`hi`
    /// in a frame at `p` rotated by `q`): the node box's bounding sphere
    /// against the oriented box.
    pub fn touching_box(&self, p: Vector3<f32>, q: &nalgebra::UnitQuaternion<f32>, lo: [f32; 3], hi: [f32; 3], reach: f32, group: &str) -> Vec<u32> {
        (0..self.centroid.len()).filter(|&i| self.candidate(i, group) && {
            let local = q.inverse() * (self.centroid[i] - p);
            let d = Vector3::from_fn(|k, _| (lo[k] - local[k]).max(local[k] - hi[k]).max(0.));
            d.norm() < self.half[i].norm() + reach
        }).map(|i| i as u32).collect()
    }

    /// The most the bonds leaving `set` (and its weight) can resist (N), and how many bonds that is.
    pub fn capacity(&self, set: &[u32]) -> (f32, u32, f32) {
        let inside: BTreeSet<u32> = set.iter().copied().collect();
        let (mut total, mut count, mut weight) = (0f32, 0u32, 0f32);
        for &n in set {
            weight += self.mass[n as usize] * G;
            for &(_, other, c) in &self.bonds[n as usize] {
                if !inside.contains(&other) { total += c; count += 1; }
            }
        }
        (total + weight, count, weight)
    }
}

/// Per tick: [tick, past the aim point along the approach (m), v along it, v up,
/// speed, bonds broken (evaluations), broken after the correction, corrections, converged].
pub struct Probe {
    pub mass: f32,
    pub radius: f32,
    /// Depth of the struck layer behind the aim point (m).
    pub layer: f32,
    pub trace: Vec<[f32; 9]>,
    /// The set touched at each tick's end, kept for the hardest tick.
    pub touched: HashMap<u32, Vec<u32>>,
    /// Whether each touched node was on the anchored body after that tick.
    pub anchored_after: HashMap<u32, Vec<bool>>,
}

impl Probe {
    pub fn new(mass: f32, radius: f32, layer: f32) -> Self { Self { mass, radius, layer, trace: Vec::new(), touched: HashMap::new(), anchored_after: HashMap::new() } }

    pub fn summary(&self, strength: &Strength, dt: f32) -> Value {
        let t = &self.trace;
        if t.len() < 3 { return Value::Null; }
        // First contact: the first tick the approach speed fell by more than
        // 2% (or 0.3 m/s) -- a free flight or a car at constant throttle loses nothing.
        let first = (1..t.len()).find(|&k| t[k - 1][2] > 0.5 && t[k - 1][2] - t[k][2] > (0.02 * t[k - 1][2]).max(0.3));
        let Some(first) = first else {
            return json!({"contact": false, "vIn": t.iter().map(|r| r[2]).fold(0f32, f32::max), "pastMax": t.iter().map(|r| r[1]).fold(f32::MIN, f32::max)});
        };
        let v_in = t[first - 1][2];
        // The hardest tick at the struck layer: the largest drop in approach
        // speed while the impactor's centre (a car's front) is between one
        // reach in front of the face and one reach behind the layer, within
        // 1 s of first contact (what it hits after -- the ground, the next
        // house -- is another case).
        let reach = if self.radius > 0. { 2. * self.radius } else { 1. } + 0.5;
        let at_layer = |k: usize| t[k][1] > -reach - t[k - 1][2] * dt && t[k - 1][1] < self.layer + reach;
        let (mut peak, mut drop) = (first, 0f32);
        for k in first..t.len().min(first + 60) {
            let d = t[k - 1][2] - t[k][2];
            if at_layer(k) && d > drop { drop = d; peak = k; }
        }
        let after = &t[first..];
        let v_min = after.iter().map(|r| r[2]).fold(f32::MAX, f32::min);
        let v_out = t.last().unwrap()[2];
        let past_max = t.iter().map(|r| r[1]).fold(f32::MIN, f32::max);
        // How long the impactor took to lose 90% of its approach speed (ticks), if it did.
        let stop_ticks = after.iter().position(|r| r[2] < 0.1 * v_in).map(|p| p as u32);
        let force = self.mass * drop / dt;
        let tick = t[peak][0] as u32;
        let set = self.touched.get(&tick).cloned().unwrap_or_default();
        let held = self.anchored_after.get(&tick).cloned().unwrap_or_default();
        let held_set: Vec<u32> = set.iter().zip(held.iter()).filter(|(_, &h)| h).map(|(&n, _)| n).collect();
        let (capacity, boundary, weight) = strength.capacity(&set);
        let (held_capacity, _, _) = strength.capacity(&held_set);
        let mut types: Vec<String> = set.iter().map(|&n| strength.types.get(n as usize).cloned().unwrap_or_default()).collect();
        types.sort(); types.dedup();
        let row = |k: usize| json!({"tick": t[k][0], "past": t[k][1], "v": t[k][2], "broken": t[k][5], "brokenAfterCorrection": t[k][6], "corrections": t[k][7], "converged": t[k][8]});
        // The momentum the hit took (kg m/s) and the energy (J) along the approach.
        let dp = self.mass * (v_in - v_out);
        json!({
            "contact": true, "mass": self.mass, "radius": self.radius,
            "firstContactTick": t[first][0], "vIn": v_in, "vMin": v_min, "vOut": v_out, "pastMax": past_max,
            "stopTicks": stop_ticks, "momentumLost": dp, "energyLost": 0.5 * self.mass * (v_in * v_in - v_out.max(0.).powi(2)),
            "peak": row(peak), "peakDrop": drop, "peakForceN": force,
            "touched": set.len(), "touchedTypes": types, "touchedHeldAnchored": held_set.len(),
            "touchedCapacityN": capacity, "touchedBoundaryBonds": boundary, "touchedWeightN": weight,
            "heldCapacityN": held_capacity,
            // The hardest tick asked more of the anchored chunks it touched than
            // their bonds can give, and they stayed anchored: an infinite wall.
            "infiniteWall": !set.is_empty() && held_set.len() == set.len() && force > capacity,
            // Some of the set was freed, but what stayed anchored took more than its bonds can.
            "partialHold": !held_set.is_empty() && held_set.len() < set.len() && force > held_capacity,
            "window": (first.saturating_sub(2)..t.len().min(first + 8)).map(row).collect::<Vec<_>>(),
        })
    }
}
