//! Dynamics and impact: momentum, restitution, friction, a punched-out plate,
//! suddenly applied and dropped loads, tipping and sliding -- the closed forms
//! the impact solve and the hunt for walls that will not break depend on.
//!
//! Projectiles and loose blocks are plain PhysX bodies (group 1, which the
//! textbook structures collide with); targets are native destructible
//! structures on the GPU stage at the shipping settings (stage.rs).
//! Velocities are read every tick from the bodies' snapshots; bond stresses
//! from the stage's rows.
//!
//! What the stage cannot represent is measured and recorded as a known
//! limit: chunks are rigid, so a load applied suddenly or dropped is resisted
//! by the contact solver within one tick, not by an elastic structure that
//! deflects (no dynamic amplification from elasticity, no energy method).
//!
//! The struck-rod spin (Hibbeler, Dynamics, 19.2-19.4: omega / v = m d / I)
//! is in tests/fidelity_audit.rs.

use super::build::*;
use super::cases::{Tier, G};
use super::failure::row;
use super::model::{Config, Material, Structure, V3};
use super::stage::{self, GROUP_PLAIN};
use super::{Expectation, Output};
use vibe_land_physx_bridge::{
    DynamicBoxDesc, LaunchedBallDesc, Pose, Quat, StaticBoxDesc, Vec3, World, WorldConfig,
};

const ALL: u32 = u32::MAX;
const DT: f64 = 1.0 / 60.0;

fn v3(a: V3) -> Vec3 {
    Vec3::new(a[0] as f32, a[1] as f32, a[2] as f32)
}

fn restitution() -> f64 {
    WorldConfig::default().restitution as f64
}
fn friction() -> f64 {
    WorldConfig::default().dynamic_friction as f64
}

fn ball(world: &mut World, id: u32, at: V3, radius: f64, mass: f64, velocity: V3) {
    world
        .launch_dynamic_ball(LaunchedBallDesc {
            entity_id: id,
            user_id: id,
            pose: Pose { position: v3(at), rotation: Quat::IDENTITY },
            radius: radius as f32,
            mass: mass as f32,
            linear_velocity: v3(velocity),
            collision_group: GROUP_PLAIN,
            collision_mask: ALL,
        })
        .unwrap();
}

fn plain_velocity(world: &World, id: u32) -> Option<V3> {
    world.body_snapshots().ok()?.into_iter().find(|b| b.entity_id == id).map(|b| {
        [b.linear_velocity.x as f64, b.linear_velocity.y as f64, b.linear_velocity.z as f64]
    })
}

/// The stage's dynamic bodies: (node count, velocity, position, rotation).
fn native_bodies(world: &World) -> Vec<(u32, V3, V3, [f64; 4])> {
    world
        .native_chunk_body_snapshots()
        .map(|s| {
            s.iter()
                .filter(|b| !b.kinematic)
                .map(|b| {
                    (
                        b.node_count,
                        [b.linear_velocity.x as f64, b.linear_velocity.y as f64, b.linear_velocity.z as f64],
                        [b.position.x as f64, b.position.y as f64, b.position.z as f64],
                        [b.rotation.x as f64, b.rotation.y as f64, b.rotation.z as f64, b.rotation.w as f64],
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn yes(b: bool) -> f64 {
    if b {
        1.0
    } else {
        0.0
    }
}

pub fn run(config: Config, want: Tier, expected: &[Expectation], out: &mut Output) {
    let wanted = |name: &str| {
        if let Ok(filter) = std::env::var("VERIFY_CASES") {
            if !filter.is_empty() {
                return filter.split(',').any(|f| name.contains(f.trim()));
            }
        }
        let _ = want;
        true
    };
    if std::env::var("VERIFY_MODEL_ONLY").is_ok_and(|v| v == "1") {
        return;
    }
    if wanted("impact-momentum") {
        momentum(config, expected, out);
    }
    if wanted("impact-plate-punch") {
        plate_punch(config, expected, out);
    }
    if wanted("impact-restitution") {
        restitution_cases(config, expected, out);
    }
    if wanted("impact-glancing") {
        glancing(config, expected, out);
    }
    if wanted("impact-sudden-load") || wanted("impact-drop") || wanted("rest-load-asleep") {
        sudden_and_drop(config, expected, out);
    }
    if wanted("tip-or-slide") {
        tip_or_slide(config, expected, out);
    }
}

/// A two-chunk block in free flight (no anchor: a free stage body) struck
/// square by a ball: linear momentum is conserved, and the block leaves at
/// V = m v (1 + e) / (m + M) [Hibbeler, Dynamics, 15.4, central impact].
fn momentum(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Hibbeler Dynamics] 15.2-15.4: m v = m v' + M V; V = m v (1 + e) / (m + M)";
    println!("\nimpact-momentum -- a ball strikes a free block (central impact)\n  {source}");
    let mut s = Structure::new();
    let mat = strong(&mut s, E_CONCRETE);
    let a = s.chunk("block-a", [-0.25, 0.0, 0.0], [0.25, 0.25, 0.25], 100.0);
    let b = s.chunk("block-b", [0.25, 0.0, 0.0], [0.25, 0.25, 0.25], 100.0);
    s.rect_bond(a, b, [0.0, 0.0, 0.0], X, Y, 0.5, Z, 0.5, mat);
    let mut world = stage::build(&s);
    let (m, v, big_m) = (20.0, 10.0, 200.0);
    // Both start at rest vertically and fall together: the impact is horizontal.
    ball(&mut world, 9001, [-1.5, 20.0, 0.0], 0.1, m, [v, 0.0, 0.0]);
    let mut after: Option<(f64, f64)> = None;
    let mut hit_tick = None;
    stage::run_ticks(&mut world, 60, |t, _, _, w| {
        let vb = plain_velocity(w, 9001).map(|v| v[0]).unwrap_or(f64::NAN);
        let block = native_bodies(w).into_iter().find(|b| b.0 == 2).map(|b| b.1[0]).unwrap_or(0.0);
        if hit_tick.is_none() && block.abs() > 1e-3 {
            hit_tick = Some(t);
        }
        if let Some(h) = hit_tick {
            if t == h + 2 {
                after = Some((vb, block));
                return true;
            }
        }
        false
    });
    let (vb, vblock) = after.unwrap_or((f64::NAN, f64::NAN));
    let e = restitution();
    println!("  ball {v} -> {vb:.4} m/s, block 0 -> {vblock:.4} m/s (e = {e})");
    let p0 = m * v;
    row(config, "impact-momentum", "momentum after impact", "m v' + M V = m v", source, "N s", p0, p0, m * vb + big_m * vblock, p0, expected, out);
    let want = m * v * (1.0 + e) / (m + big_m);
    row(config, "impact-momentum", "block velocity", "m v (1+e)/(m+M)", source, "m/s", want, want, vblock, want, expected, out);
}

/// A 60 kg ball at 6 m/s into a 60 kg plug held in a frame by four brittle
/// joints (limits 40 kPa, capacity F = 4 x 40 kPa x 0.05 m^2 = 8 kN). If the
/// joints break, the ball and the freed plug collide as free bodies: the
/// ball exits at v (m - e m_p)/(m + m_p) [Hibbeler 15.4], less at most the
/// joints' capacity impulse F dt over the two (it neither bounces off nor
/// passes through for free).
fn plate_punch(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Hibbeler Dynamics] 15.4 with a capacity-bounded joint impulse: v' in [v_free - F dt/(m+m_p), v_free]";
    println!("\nimpact-plate-punch -- a ball punches a plug out of a framed plate\n  {source}");
    let limit = 40e3;
    let mut s = Structure::new();
    let joint = s.material(Material { modulus: E_CONCRETE, compression: limit, tension: limit, shear: limit });
    let mp = 60.0;
    let plug = s.chunk("plug", [0.0, 0.0, 0.0], [0.05, 0.25, 0.25], mp);
    let mut bonds = Vec::new();
    for (dir, axis) in [([0.0, 1.0, 0.0], Z), ([0.0, -1.0, 0.0], Z), ([0.0, 0.0, 1.0], Y), ([0.0, 0.0, -1.0], Y)] {
        let c = [0.0, dir[1] * 0.5, dir[2] * 0.5];
        let anchor = s.chunk("frame", c, [0.05, 0.25, 0.25], 0.0);
        let face = [0.0, dir[1] * 0.25, dir[2] * 0.25];
        bonds.push(s.rect_bond(plug, anchor, face, dir, X, 0.1, axis, 0.5, joint));
    }
    let mut world = stage::build(&s);
    // 6 m/s: 0.1 m a tick, under the ball's radius (no tunnelling without CCD).
    let (m, v) = (60.0, 6.0);
    ball(&mut world, 9002, [-0.5, 20.0, 0.0], 0.1, m, [v, 0.0, 0.0]);
    let mut broken = Vec::new();
    let mut samples: Vec<(f64, f64)> = Vec::new();
    let verbose = std::env::var_os("VERIFY_VERBOSE").is_some();
    stage::run_ticks(&mut world, 30, |t, st, b, w| {
        broken.extend_from_slice(b);
        if verbose && t < 8 {
            let all = w.native_chunk_body_snapshots().map(|s| s.iter().map(|b| (b.node_count, b.kinematic, b.sleeping, b.position.x, b.position.y, b.linear_velocity.x)).collect::<Vec<_>>()).unwrap_or_default();
            println!("    tick {t}: broke {b:?} contacts {} ball {:?} bodies {all:?}", st.normal_contacts, plain_velocity(w, 9002));
        }
        let vb = plain_velocity(w, 9002).map(|v| v[0]).unwrap_or(f64::NAN);
        let vp = native_bodies(w).into_iter().find(|b| b.0 == 1).map(|b| b.1[0]).unwrap_or(0.0);
        samples.push((vb, vp));
        false
    });
    // After the hit: the first sample whose plug moves, two ticks on.
    let k = samples.iter().position(|s| s.1.abs() > 1e-3 || s.0 < 0.99 * v).map(|k| (k + 2).min(samples.len() - 1));
    let (vb, vp) = k.map(|k| samples[k]).unwrap_or((f64::NAN, f64::NAN));
    let e = restitution();
    let free = v * (m - e * mp) / (m + mp);
    let cap = 4.0 * limit * 0.05 * DT;
    let lost = m * v - (m * vb + mp * vp);
    let tail = samples.last().copied().unwrap_or((f64::NAN, f64::NAN));
    println!("  joints broken {broken:?}; ball {v} -> {vb:.3} m/s, plug -> {vp:.3} m/s (at 0.5 s: ball {:.3}, plug {:.3}); momentum to the joints {lost:.1} N s (capacity impulse {cap:.1})", tail.0, tail.1);
    row(config, "impact-plate-punch", "the plug breaks free (joints broken)", "4", source, "bonds", 4.0, 4.0, broken.len() as f64, 4.0, expected, out);
    row(config, "impact-plate-punch", "ball exit speed", "v (m - e m_p)/(m + m_p)", source, "m/s", free, free, vb, free, expected, out);
    let within = vb > 0.0 && vb <= free + 1e-3 * free && vb >= free - cap / (m + mp) - 1e-3 * free;
    row(config, "impact-plate-punch", "exit speed within the joints' capacity bound (no bounce, not free)", "v_free - F dt/(m+m_p) <= v' <= v_free", source, "1=yes", 1.0, f64::NAN, yes(within), 1.0, expected, out);
}

/// A slab on an anchor. Unbreakable: a dropped ball rebounds at e times its
/// impact speed (the authored restitution). Joints below the impact force: it
/// breaks through instead of bouncing.
fn restitution_cases(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Hibbeler Dynamics] 15.4: e = v_out / v_in (WorldConfig restitution)";
    println!("\nimpact-restitution -- a ball dropped on a slab\n  {source}");
    let slab = |compression: f64| {
        let mut s = Structure::new();
        let m = s.material(Material { modulus: E_CONCRETE, compression, tension: 1e13, shear: 1e13 });
        let c = s.chunk("slab", [0.0, 0.0, 0.0], [0.5, 0.1, 0.5], CONCRETE * 0.2);
        let anchor = s.chunk("anchor", [0.0, -0.1, 0.0], [0.6, PLATE, 0.6], 0.0);
        s.rect_bond(anchor, c, [0.0, -0.1, 0.0], Y, X, 1.0, Z, 1.0, m);
        s
    };
    let drop = |s: &Structure, mass: f64| -> (f64, f64, usize) {
        let mut world = stage::build(s);
        ball(&mut world, 9003, [0.0, 22.2, 0.0], 0.1, mass, [0.0, 0.0, 0.0]);
        let (mut vin, mut vout, mut broken) = (0.0f64, f64::NEG_INFINITY, 0usize);
        let mut hit = false;
        stage::run_ticks(&mut world, 75, |_, _, b, w| {
            broken += b.len();
            let vy = plain_velocity(w, 9003).map(|v| v[1]).unwrap_or(0.0);
            if !hit && vy < vin {
                vin = vy;
            } else if vin < -1.0 && vy > vin + 1.0 {
                hit = true;
            }
            if hit {
                vout = vout.max(vy);
            }
            false
        });
        (vin, if hit { vout } else { f64::NAN }, broken)
    };
    // Unbreakable slab.
    let (vin, vout, _) = drop(&slab(1e13), 10.0);
    let e = restitution();
    println!("  unbreakable: impact {vin:.3} m/s, rebound {vout:.3} m/s");
    row(config, "impact-restitution", "rebound / impact speed on an unbreakable slab", "e", source, "-", e, e, vout / -vin, e, expected, out);
    // Joints that carry the slab's weight (4.7 kPa) twice over, not the impact.
    let (vin, vout, broken) = drop(&slab(10e3), 100.0);
    println!("  weak joints: impact {vin:.3} m/s, after {vout:.3} m/s, bonds broken {broken}");
    row(config, "impact-restitution", "breaks through a weak slab instead of bouncing", "joint broken, no rebound", source, "1=yes", 1.0, f64::NAN, yes(broken > 0 && !(vout > 0.0)), 1.0, expected, out);
}

/// A ball strikes an anchored slab at 45 degrees. The tangential impulse is
/// bounded by friction, |dv_t| <= mu dv_n, and for a solid sphere it stops at
/// rolling, dv_t = (2/7) v_t [Goldsmith, Impact, 1960, ch. 3; Hibbeler 19.4]:
/// here min(mu (1+e) v_n, 2 v_t / 7). The slab's bond to its anchor carries
/// both impulses over the tick (a rigid slab): shear m dv_t / dt.
fn glancing(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "Coulomb impulse |J_t| <= mu J_n; solid sphere stops slipping at dv_t = 2 v_t / 7 [Goldsmith ch. 3]";
    println!("\nimpact-glancing -- a ball strikes a slab at 45 degrees\n  {source}");
    let mut s = Structure::new();
    let m = strong(&mut s, E_CONCRETE);
    let c = s.chunk("slab", [0.0, 0.0, 0.0], [1.0, 0.1, 0.5], 1.0);
    let anchor = s.chunk("anchor", [0.0, -0.1, 0.0], [1.1, PLATE, 0.6], 0.0);
    let bond = s.rect_bond(anchor, c, [0.0, -0.1, 0.0], Y, X, 2.0, Z, 1.0, m);
    let mut world = stage::build(&s);
    let (mass, vt, vn) = (10.0, 7.0, 7.0);
    // Starts 0.3 m up and 0.3 m back, moving (vt, -vn): contact within 3 ticks.
    ball(&mut world, 9004, [-0.5, 20.4, 0.0], 0.1, mass, [vt, -vn, 0.0]);
    let mut before = None;
    let mut after = None;
    let mut peak_shear = 0.0f64;
    let mut prev = [vt, -vn, 0.0];
    stage::run_ticks(&mut world, 20, |_, _, _, w| {
        let v = plain_velocity(w, 9004).unwrap_or([f64::NAN; 3]);
        if before.is_none() && v[1] > prev[1] + 1.0 {
            before = Some(prev);
            after = Some(v);
        }
        prev = v;
        if let Some(r) = stage::rows(w, 1).get(bond) {
            peak_shear = peak_shear.max(r.shear * 2.0);
        }
        false
    });
    let (b, a) = (before.unwrap_or([f64::NAN; 3]), after.unwrap_or([f64::NAN; 3]));
    let dvn = a[1] - b[1];
    let dvt = b[0] - a[0];
    let e = restitution();
    let mu = friction();
    let want = (mu * (1.0 + e) * -b[1]).min(2.0 * b[0] / 7.0);
    println!("  before {b:?}, after {a:?}: dv_n {dvn:.3}, dv_t {dvt:.3} (mu dv_n {:.3}); bond peak shear force {peak_shear:.0} N", mu * dvn);
    row(config, "impact-glancing", "tangential impulse within friction (|dv_t| <= mu dv_n)", "mu J_n", source, "1=yes", 1.0, f64::NAN, yes(dvt.abs() <= mu * dvn * 1.001), 1.0, expected, out);
    row(config, "impact-glancing", "tangential velocity change", "min(mu (1+e) v_n, 2 v_t / 7)", source, "m/s", want, want, dvt, want, expected, out);
    // The shear the bond carries in the impact tick: the tangential impulse
    // over the tick (the slab is rigid and anchored).
    let want_shear = mass * dvt / DT;
    row(config, "impact-glancing", "bond shear force in the impact tick (friction reaches the bond)", "m dv_t / dt", source, "kN", want_shear * 1e-3, want_shear * 1e-3, peak_shear * 1e-3, want_shear * 1e-3, expected, out);
}

/// A 1 t block released onto a concrete cantilever's tip from zero height
/// (suddenly applied: dynamic amplification 2 [Gere 2.8]) and dropped from h
/// (energy method: 1 + sqrt(1 + 2 h / delta_st) [Gere 2.8; Hibbeler MoM 14.8]).
/// The stage's chunks are rigid, so there is no elastic deflection to store
/// the energy: the contact solver stops the block within a tick. Measured as
/// the peak root bending stress over the static one (both graded alike).
fn sudden_and_drop(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Gere] 2.8 impact loading: DAF = 1 + sqrt(1 + 2h/delta_st) (2 for h = 0); delta_st = P a^3 / 3EI";
    println!("\nimpact-sudden-load / impact-drop -- a 1 t block onto a cantilever's tip\n  {source}");
    let build = || {
        let mut s = Structure::new();
        let m = strong(&mut s, E_CONCRETE);
        let (c, _) = beam(&mut s, "beam", 0.0, 4.0, 0.0, 8, BEAM_D, CONCRETE, m);
        let root = fixed(&mut s, c[0], [0.0; 3], [-1.0, 0.0, 0.0], Y, BEAM_D, m);
        (s, root)
    };
    let (s, root) = build();
    let block = 1000.0;
    let (bx, half): (f64, f64) = (3.75, 0.1);
    let top = 20.0 + BEAM_D.d / 2.0;
    // (self-weight stress before the block, peak after it, at tick 10, at the end)
    let run = |h: f64, ticks: u32| -> (f64, f64, f64, f64) {
        let mut world = stage::build(&s);
        // Settle the beam under its own weight first.
        stage::run_ticks(&mut world, 5, |_, _, _, _| false);
        let base = stage::rows(&world, s.bonds.len())[root].bend;
        world
            .add_dynamic_box(DynamicBoxDesc {
                entity_id: 9005,
                user_id: 9005,
                pose: Pose { position: Vec3::new(bx as f32, (top + half + h.max(0.001)) as f32, 0.0), rotation: Quat::IDENTITY },
                half_extents: Vec3::new(half as f32, half as f32, half as f32),
                mass: block as f32,
                collision_group: GROUP_PLAIN,
                collision_mask: ALL,
            })
            .unwrap();
        let (mut peak, mut last, mut settled) = (0.0f64, 0.0, 0.0);
        let mut landed = None;
        let verbose = std::env::var_os("VERIFY_VERBOSE").is_some();
        stage::run_ticks(&mut world, ticks, |t, st, _, w| {
            last = stage::rows(w, s.bonds.len())[root].bend;
            peak = peak.max(last);
            if landed.is_none() && last > base * 1.01 {
                landed = Some(t);
            }
            if landed.is_some_and(|l| t == l + 10) {
                settled = last;
            }
            if verbose && (t < 12 || t % 30 == 0) {
                let snap = w.body_snapshots().ok().and_then(|b| b.into_iter().find(|b| b.entity_id == 9005));
                println!("    h {h}: tick {t} root {:.4} MPa contacts {} block vy {:?} asleep {:?}", last * 1e-6, st.normal_contacts,
                    snap.as_ref().map(|b| b.linear_velocity.y), snap.as_ref().map(|b| b.sleeping));
            }
            false
        });
        (base, peak, settled, last)
    };
    // The static answer: the block at rest on the tip, 10 ticks after it landed.
    let (base, _, settled, end) = run(0.0, 240);
    let static_rise = settled - base;
    let textbook_rise = block * G * bx / BEAM_D.modulus();
    let grade = static_rise / textbook_rise; // the configuration's grading of the same moment
    println!("  static: block adds {:.4} MPa (textbook {:.4}, graded x{grade:.3}); after 4 s: {:.4} MPa", static_rise * 1e-6, textbook_rise * 1e-6, (end - base) * 1e-6);
    // A resting load must keep loading the structure when the body resting on
    // it falls asleep (PhysX sleeps a body at rest within ~0.5 s).
    row(config, "rest-load-asleep", "a resting block still loads the beam after it sleeps (root stress rise, 4 s)", "W a / S (graded as at rest)", "statics: a resting load is a load", "MPa", static_rise * 1e-6, static_rise * 1e-6, (end - base) * 1e-6, static_rise * 1e-6, expected, out);
    let i = BEAM_D.inertia();
    let delta = block * G * bx.powi(3) / (3.0 * E_CONCRETE * i);
    for (name, h) in [("impact-sudden-load", 0.0), ("impact-drop", 0.1), ("impact-drop", 0.4)] {
        let (b, peak, _, _) = run(h, 60);
        let daf = (peak - b) / static_rise;
        let want = 1.0 + (1.0 + 2.0 * h / delta).sqrt();
        println!("  h {h} m: peak {:.4} MPa above self-weight -> {daf:.3} x static (textbook {want:.3}, delta_st {:.2} mm)", (peak - b) * 1e-6, delta * 1e3);
        row(config, name, &format!("dynamic amplification, h = {h} m"), "1 + sqrt(1 + 2h/delta_st)", source, "-", want, f64::NAN, daf, want, expected, out);
    }
}

const BEAM_D: Rect = Rect { b: 0.2, d: 0.4 };

/// A block on a plane tilted by theta: it tips when tan theta > b / h
/// (its weight's line leaves the base) and slides when tan theta > mu,
/// whichever comes first [Hibbeler Statics 8.2]. A tall block (b/h = 0.4,
/// mu = 0.5) tips first at 21.8 degrees; a squat one (b/h = 2) slides first
/// at 26.6 degrees. Found by bisection on theta, 2 s per trial.
fn tip_or_slide(config: Config, expected: &[Expectation], out: &mut Output) {
    let source = "[Hibbeler Statics] 8.2: tips at tan theta = b/h, slides at tan theta = mu";
    println!("\ntip-or-slide -- a block on a tilted plane\n  {source}");
    let mu = friction();
    // What happens in 2 s at `theta` (radians): (tipped, slid).
    let trial = |b: f64, h: f64, theta: f64| -> (bool, bool) {
        let q = [0.0, 0.0, (-theta / 2.0).sin(), (-theta / 2.0).cos()]; // down-slope toward +x
        let rot = |v: V3| super::model::rotate(q, v);
        let normal = rot([0.0, 1.0, 0.0]);
        let mut s = Structure::new();
        let m = strong(&mut s, E_CONCRETE);
        let lo = s.chunk("lower", [0.0, -h / 4.0, 0.0], [b / 2.0, h / 4.0, b / 2.0], 50.0);
        let hi = s.chunk("upper", [0.0, h / 4.0, 0.0], [b / 2.0, h / 4.0, b / 2.0], 50.0);
        s.rect_bond(lo, hi, [0.0; 3], Y, X, b, Z, b, m);
        s.rotation = q;
        let centre = [0.0, 10.0, 0.0];
        s.origin = [centre[0] + normal[0] * (h / 2.0 + 0.001), centre[1] + normal[1] * (h / 2.0 + 0.001), 0.0];
        let mut world = stage::build(&s);
        world
            .add_static_box(StaticBoxDesc {
                entity_id: 9006,
                user_id: 9006,
                pose: Pose { position: v3([centre[0] - normal[0] * 0.25, centre[1] - normal[1] * 0.25, 0.0]), rotation: Quat { x: 0.0, y: 0.0, z: q[2] as f32, w: q[3] as f32 } },
                half_extents: Vec3::new(5.0, 0.25, 2.0),
                collision_group: GROUP_PLAIN,
                collision_mask: ALL,
            })
            .unwrap();
        // The plane's top face passes through `centre`: its box centre is
        // 0.25 m below along the normal.
        let _ = centre;
        let start = s.origin;
        let mut end = (start, [0.0, 0.0, 0.0, 1.0]);
        stage::run_ticks(&mut world, 120, |_, _, _, w| {
            if let Some(body) = native_bodies(w).into_iter().find(|b| b.0 == 2) {
                end = (body.2, body.3);
            }
            false
        });
        let up = super::model::rotate(end.1, [0.0, 1.0, 0.0]);
        let tilt = super::model::dot(up, normal).clamp(-1.0, 1.0).acos();
        let moved = super::model::norm(super::model::sub(end.0, start));
        (tilt > 10f64.to_radians(), moved > 0.05 && tilt < 5f64.to_radians())
    };
    for (label, b, h) in [("tall block b/h = 0.4", 0.4, 1.0), ("squat block b/h = 2", 1.0, 0.5)] {
        let (want_angle, want_mode) = if b / h < mu { ((b / h).atan(), "tips") } else { (mu.atan(), "slides") };
        // Bisection: the lowest angle at which anything happens.
        let (mut lo, mut hi) = (0.5 * want_angle, 1.5 * want_angle);
        let mut mode = "";
        for _ in 0..9 {
            let mid = 0.5 * (lo + hi);
            let (tipped, slid) = trial(b, h, mid);
            if tipped || slid {
                hi = mid;
                mode = if tipped { "tips" } else { "slides" };
            } else {
                lo = mid;
            }
        }
        let got = hi.to_degrees();
        println!("  {label}: {mode} at {got:.2} deg (textbook {want_mode} at {:.2} deg)", want_angle.to_degrees());
        row(config, "tip-or-slide", &format!("{label}: angle at which it {want_mode}"), if want_mode == "tips" { "atan(b/h)" } else { "atan(mu)" }, source, "deg", want_angle.to_degrees(), f64::NAN, got, want_angle.to_degrees(), expected, out);
        row(config, "tip-or-slide", &format!("{label}: it {want_mode} (not the other)"), want_mode, source, "1=yes", 1.0, f64::NAN, yes(mode == want_mode), 1.0, expected, out);
    }
}
