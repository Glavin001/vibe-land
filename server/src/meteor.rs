//! The meteor shot: where it starts, and the velocity that carries it through
//! the aimed point.
//!
//! The shooter's ray picks a point on the world. The rock does not start at the
//! shooter: it starts somewhere high and far outside the city, chosen at
//! random, and flies a plain ballistic arc -- no drag, no damping, which is
//! exactly what a launched ball gets in the scene (`launch_dynamic_ball` zeroes
//! both) -- so the closed-form solve here is the trajectory PhysX integrates,
//! and the rock passes through the aimed point unless something is in the way.
//! Something usually is; that is the point of a meteor.
//!
//! Everything here is pure so it can be tested without a scene. The client
//! never sees these numbers: the rock is an important body, streamed to every
//! client from the tick it is launched, wherever it starts.

use glam::Vec3;

/// Shape of the meteor shot. Read from the environment once per shot, like
/// the cannonball's knobs, so a live server can be retuned without a rebuild.
#[derive(Clone, Copy, Debug)]
pub struct MeteorTuning {
    /// Radius of the rock, m. Derived from mass and density unless overridden.
    pub radius_m: f32,
    pub mass_kg: f32,
    /// Nominal speed along the arc, m/s. The flight time is the straight-line
    /// distance over this, so the true speed varies along the arc with gravity;
    /// it is a scale for "how fast it comes in", not a guarantee at impact.
    pub speed_ms: f32,
    /// Horizontal stand-off of the start from the aimed point, m: min and max.
    pub range_min_m: f32,
    pub range_max_m: f32,
    /// Height of the start above the aimed point, m: min and max.
    pub height_min_m: f32,
    pub height_max_m: f32,
    pub ttl_ticks: u32,
}

/// Density of a stony meteorite, kg/m^3. Ordinary chondrite is 3,000-3,700.
///
/// A real density, for the same reason the cannonball has one: a body whose
/// mass and volume disagree by orders of magnitude makes the contact solver
/// ill-conditioned, and the ejection faults that produced were measured, not
/// imagined (see `city_ball_density_kg_m3`). At 3,300 kg/m^3 a 2 m rock is
/// 110 t, which is a meteor and not a cannonball, without being osmium.
pub const DEFAULT_DENSITY_KG_M3: f32 = 3_300.0;
pub const DEFAULT_RADIUS_M: f32 = 2.0;
/// 140 m/s: 2.3 m per 60 Hz tick against a 4 m diameter, so nothing thinner
/// than the rock itself can be tunnelled, and a launch 300 m out is on the
/// ground in about three seconds -- long enough to see it coming.
pub const DEFAULT_SPEED_MS: f32 = 140.0;
pub const DEFAULT_RANGE_MIN_M: f32 = 240.0;
pub const DEFAULT_RANGE_MAX_M: f32 = 360.0;
pub const DEFAULT_HEIGHT_MIN_M: f32 = 180.0;
pub const DEFAULT_HEIGHT_MAX_M: f32 = 300.0;
/// Fifteen seconds. Longer than the cannonball's six because the flight alone
/// is three, and a rock that has landed is worth watching settle.
pub const DEFAULT_TTL_TICKS: u32 = 900;

impl MeteorTuning {
    /// Read the knobs. `VIBE_CITY_METEOR_RADIUS_M`, `_DENSITY_KGM3`,
    /// `_MASS_KG` (overrides the derived mass), `_SPEED_MS`, `_RANGE_MIN_M`,
    /// `_RANGE_MAX_M`, `_HEIGHT_MIN_M`, `_HEIGHT_MAX_M`, `_TTL_TICKS`.
    pub fn from_env() -> Self {
        let radius_m = env_positive_f32("VIBE_CITY_METEOR_RADIUS_M", DEFAULT_RADIUS_M);
        let density = env_positive_f32("VIBE_CITY_METEOR_DENSITY_KGM3", DEFAULT_DENSITY_KG_M3);
        let derived_mass = density * 4.0 / 3.0 * std::f32::consts::PI * radius_m.powi(3);
        let mass_kg = env_positive_f32("VIBE_CITY_METEOR_MASS_KG", derived_mass);
        let range_min_m = env_positive_f32("VIBE_CITY_METEOR_RANGE_MIN_M", DEFAULT_RANGE_MIN_M);
        let range_max_m =
            env_positive_f32("VIBE_CITY_METEOR_RANGE_MAX_M", DEFAULT_RANGE_MAX_M).max(range_min_m);
        let height_min_m =
            env_positive_f32("VIBE_CITY_METEOR_HEIGHT_MIN_M", DEFAULT_HEIGHT_MIN_M);
        let height_max_m = env_positive_f32("VIBE_CITY_METEOR_HEIGHT_MAX_M", DEFAULT_HEIGHT_MAX_M)
            .max(height_min_m);
        let ttl_ticks = std::env::var("VIBE_CITY_METEOR_TTL_TICKS")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_TTL_TICKS);
        Self {
            radius_m,
            mass_kg,
            speed_ms: env_positive_f32("VIBE_CITY_METEOR_SPEED_MS", DEFAULT_SPEED_MS),
            range_min_m,
            range_max_m,
            height_min_m,
            height_max_m,
            ttl_ticks,
        }
    }
}

fn env_positive_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(default)
}

/// A planned meteor: where it appears and how fast it leaves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeteorLaunch {
    pub start: Vec3,
    pub velocity: Vec3,
    /// Seconds from launch to the aimed point, on the unobstructed arc.
    pub flight_time_s: f32,
}

/// Where a meteor is at `t` seconds after launch, on the unobstructed arc.
pub fn position_at(launch: &MeteorLaunch, gravity: Vec3, t: f32) -> Vec3 {
    launch.start + launch.velocity * t + gravity * (0.5 * t * t)
}

/// Solve the arc from `start` through `target` under `gravity`, arriving
/// `flight_time_s` after launch.
///
/// The standard closed form: p(T) = s + vT + gT^2/2, so v = (p - s)/T - gT/2.
/// There is no drag in the scene, so this is exact.
pub fn solve_velocity(start: Vec3, target: Vec3, gravity: Vec3, flight_time_s: f32) -> Vec3 {
    (target - start) / flight_time_s - gravity * (0.5 * flight_time_s)
}

/// Plan a meteor that passes through `target`.
///
/// The start is a random point on a ring around the target: `range` metres out
/// horizontally at a random bearing, `height` metres up. Both ranges come from
/// the tuning. The bearing does not care where the shooter is, so the rock can
/// come in over the shooter's shoulder or straight at them -- that is what
/// makes it a meteor and not a mortar. The flight time is the straight-line
/// distance at the nominal speed.
pub fn plan(target: Vec3, gravity: Vec3, tuning: &MeteorTuning, rng: &mut Rng) -> MeteorLaunch {
    let bearing = rng.next_f32() * std::f32::consts::TAU;
    let range = tuning.range_min_m + (tuning.range_max_m - tuning.range_min_m) * rng.next_f32();
    let height =
        tuning.height_min_m + (tuning.height_max_m - tuning.height_min_m) * rng.next_f32();
    let start = target + Vec3::new(bearing.cos() * range, height, bearing.sin() * range);
    let flight_time_s = (start.distance(target) / tuning.speed_ms).max(0.25);
    MeteorLaunch {
        start,
        velocity: solve_velocity(start, target, gravity, flight_time_s),
        flight_time_s,
    }
}

/// A small deterministic generator, because the server has no `rand` and one
/// is not worth adding for a bearing. SplitMix64: fine for this and seedable,
/// so a test can pin the arc it checks.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: Vec3 = Vec3::new(0.0, -9.81, 0.0);

    fn tuning() -> MeteorTuning {
        MeteorTuning {
            radius_m: 2.0,
            mass_kg: 110_000.0,
            speed_ms: 140.0,
            range_min_m: 240.0,
            range_max_m: 360.0,
            height_min_m: 180.0,
            height_max_m: 300.0,
            ttl_ticks: 900,
        }
    }

    #[test]
    fn arc_passes_through_the_target() {
        let target = Vec3::new(12.0, 3.5, -40.0);
        for seed in 0..64 {
            let mut rng = Rng::new(seed);
            let launch = plan(target, G, &tuning(), &mut rng);
            let at = position_at(&launch, G, launch.flight_time_s);
            assert!(
                at.distance(target) < 1e-2,
                "seed {seed}: arrived at {at:?}, aimed at {target:?}"
            );
        }
    }

    #[test]
    fn start_is_high_and_far_out() {
        let target = Vec3::new(0.0, 0.0, 0.0);
        let tuning = tuning();
        for seed in 0..64 {
            let mut rng = Rng::new(seed);
            let launch = plan(target, G, &tuning, &mut rng);
            let horizontal = Vec3::new(launch.start.x, 0.0, launch.start.z).length();
            assert!(
                (tuning.range_min_m..=tuning.range_max_m).contains(&horizontal),
                "seed {seed}: stand-off {horizontal}"
            );
            assert!(
                (tuning.height_min_m..=tuning.height_max_m).contains(&launch.start.y),
                "seed {seed}: height {}",
                launch.start.y
            );
        }
    }

    #[test]
    fn bearings_are_not_all_the_same() {
        let target = Vec3::ZERO;
        let mut rng = Rng::new(7);
        let mut bearings: Vec<f32> = (0..16)
            .map(|_| {
                let launch = plan(target, G, &tuning(), &mut rng);
                launch.start.z.atan2(launch.start.x)
            })
            .collect();
        bearings.sort_by(|a, b| a.total_cmp(b));
        let spread = bearings.last().unwrap() - bearings.first().unwrap();
        assert!(spread > 3.0, "sixteen launches spanned only {spread} rad of bearing");
    }

    #[test]
    fn integrating_at_the_tick_rate_lands_where_the_closed_form_says() {
        // The scene integrates in 60 Hz steps; symplectic Euler on a constant
        // field lands within a step's drift of the closed form, which is what
        // lets a client draw the arc and trust the body to be on it.
        let target = Vec3::new(50.0, 10.0, 50.0);
        let mut rng = Rng::new(3);
        let launch = plan(target, G, &tuning(), &mut rng);
        let dt = 1.0 / 60.0;
        let mut p = launch.start;
        let mut v = launch.velocity;
        let steps = (launch.flight_time_s / dt).round() as u32;
        for _ in 0..steps {
            v += G * dt;
            p += v * dt;
        }
        // Half a step of velocity times the flight, roughly: a few metres at
        // most, and a 4 m rock. Good enough for the eye and for the solver.
        assert!(p.distance(target) < 5.0, "landed {} m off", p.distance(target));
    }
}
