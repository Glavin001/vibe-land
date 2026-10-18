//! P1 measurement census: where residual bytes actually go.
//!
//! Two questions this answers, both measurement-only and env-gated so the
//! encoder is byte-identical with `CODEC_CENSUS` unset:
//!
//! - **Occlusion (P1a).** How many residual bytes are spent on bodies that are
//!   *both* occluded and moving? Interior bodies in a settled pile are asleep
//!   and already cost nothing, so the interior-coarsening idea (P5) only has a
//!   win if the churning interior of an active collapse is expensive. The test
//!   is deliberately viewer-independent -- a body surrounded by other debris is
//!   hidden from *every* camera, which is the only occlusion cue legal on an
//!   omniscient broadcast.
//! - **Error anatomy (P1b).** How do those bytes split by error axis (vertical
//!   vs horizontal) and by speed? Sizes the perceptual-quantization work (P6),
//!   which rests on vertical error being more detectable than horizontal
//!   (Reitsma & Pollard 2003) and on speed discrimination being logarithmic.

use std::sync::{Mutex, OnceLock};

use glam::Vec3;

use crate::trace::{ActorDef, ActorState};

/// Occlusion is sampled rather than computed every tick: it needs a spatial
/// index per tick, and the census only needs a stable distribution.
const TICK_STRIDE: u32 = 8;
/// Voxel edge, in multiples of the mean body radius. One body should occupy
/// roughly one voxel: too coarse and the pile looks solid, too fine and gaps
/// between touching fragments read as free space.
const VOXEL_SCALE: f32 = 2.0;
/// Depth (in voxels below the reachable surface) at which a body is treated as
/// genuinely interior rather than merely surface-adjacent.
const INTERIOR_DEPTH: u8 = 2;

pub(crate) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("CODEC_CENSUS").is_ok())
}

/// Occupancy voxels for one tick, with each body's burial depth below the
/// nearest free space that connects to the outside world.
///
/// Depth, not local neighbour count, is the right test. A fragment on the
/// surface of a pile has debris on nearly every side and would look "covered"
/// to any local probe, yet it is plainly visible. What makes a body invisible
/// to *every* camera is that no unobstructed path to it exists at all -- so the
/// measurement floods free space inward from outside the scene and asks how
/// many layers of debris a body sits behind.
pub(crate) struct Grid {
    depth: Vec<u8>,
    dims: [i32; 3],
    origin: [i32; 3],
    cell: f32,
    bodies: Vec<Vec3>,
    tick_counter: u32,
}

impl Grid {
    pub(crate) fn build(states: &[ActorState], actors: &[ActorDef]) -> Option<Self> {
        static TICKS: OnceLock<Mutex<u32>> = OnceLock::new();
        let seen = {
            let mut guard = TICKS.get_or_init(|| Mutex::new(0)).lock().ok()?;
            *guard += 1;
            *guard
        };
        if seen % TICK_STRIDE != 0 {
            return None;
        }

        let mut bodies = Vec::with_capacity(states.len());
        let mut mean_radius = 0.0_f32;
        for (index, state) in states.iter().enumerate() {
            bodies.push(state.pose.position);
            mean_radius += actors[index].bounding_radius;
        }
        let cell = (mean_radius / states.len().max(1) as f32).max(0.05) * VOXEL_SCALE;

        // Bounding box with one voxel of margin, so the flood always starts in
        // free space that surrounds the scene.
        let (mut lo, mut hi) = ([i32::MAX; 3], [i32::MIN; 3]);
        for position in &bodies {
            let voxel = key(*position, cell);
            for axis in 0..3 {
                lo[axis] = lo[axis].min(voxel[axis] - 1);
                hi[axis] = hi[axis].max(voxel[axis] + 1);
            }
        }
        let dims = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
        let total = dims[0] as i64 * dims[1] as i64 * dims[2] as i64;
        if total <= 0 || total > 40_000_000 {
            return None;
        }

        // 0 = free, 1 = occupied. Then: free space reachable from the boundary
        // becomes depth 0, and occupied voxels take depth = layers inward.
        let mut depth = vec![0_u8; total as usize];
        let index_of = |voxel: [i32; 3]| -> usize {
            ((voxel[0] - lo[0]) as i64 * dims[1] as i64 * dims[2] as i64
                + (voxel[1] - lo[1]) as i64 * dims[2] as i64
                + (voxel[2] - lo[2]) as i64) as usize
        };
        for position in &bodies {
            depth[index_of(key(*position, cell))] = 1;
        }

        // Flood free space inward from the margin; anything it cannot reach is
        // either debris or a sealed pocket (which is also invisible).
        const FREE: u8 = 0;
        const OUTSIDE: u8 = 255;
        let mut queue = std::collections::VecDeque::new();
        let start = index_of(lo);
        if depth[start] == FREE {
            depth[start] = OUTSIDE;
            queue.push_back(lo);
        }
        while let Some(voxel) = queue.pop_front() {
            for (axis, step) in [(0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1)] {
                let mut next = voxel;
                next[axis] += step;
                if (0..3).any(|a| next[a] < lo[a] || next[a] > hi[a]) {
                    continue;
                }
                let at = index_of(next);
                if depth[at] == FREE {
                    depth[at] = OUTSIDE;
                    queue.push_back(next);
                }
            }
        }

        // Layer the debris: occupied voxels touching outside air are depth 1,
        // those touching depth 1 are depth 2, and so on.
        let mut frontier: Vec<[i32; 3]> = Vec::new();
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    let voxel = [x, y, z];
                    if depth[index_of(voxel)] != 1 {
                        continue;
                    }
                    let exposed = [(0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1)]
                        .iter()
                        .any(|(axis, step)| {
                            let mut next = voxel;
                            next[*axis] += step;
                            (0..3).all(|a| next[a] >= lo[a] && next[a] <= hi[a])
                                && depth[index_of(next)] == OUTSIDE
                        });
                    if exposed {
                        frontier.push(voxel);
                    }
                }
            }
        }
        for voxel in &frontier {
            depth[index_of(*voxel)] = 2;
        }
        let mut layer = 2_u8;
        while !frontier.is_empty() && layer < 200 {
            let mut next_layer = Vec::new();
            for voxel in &frontier {
                for (axis, step) in [(0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1)] {
                    let mut next = *voxel;
                    next[axis] += step;
                    if (0..3).any(|a| next[a] < lo[a] || next[a] > hi[a]) {
                        continue;
                    }
                    let at = index_of(next);
                    if depth[at] == 1 {
                        depth[at] = layer + 1;
                        next_layer.push(next);
                    }
                }
            }
            frontier = next_layer;
            layer = layer.saturating_add(1);
        }

        Some(Grid {
            depth,
            dims,
            origin: lo,
            cell,
            bodies,
            tick_counter: seen,
        })
    }

    /// Layers of debris between this body and open air. 0 = exposed surface.
    fn burial_depth(&self, actor: usize) -> u8 {
        let voxel = key(self.bodies[actor], self.cell);
        if (0..3).any(|a| voxel[a] < self.origin[a] || voxel[a] - self.origin[a] >= self.dims[a]) {
            return 0;
        }
        let at = ((voxel[0] - self.origin[0]) as i64 * self.dims[1] as i64 * self.dims[2] as i64
            + (voxel[1] - self.origin[1]) as i64 * self.dims[2] as i64
            + (voxel[2] - self.origin[2]) as i64) as usize;
        // Stored value is 2 for the exposed layer, so shift back to 0-based.
        self.depth[at].saturating_sub(2)
    }
}

fn key(position: Vec3, cell: f32) -> [i32; 3] {
    [
        (position.x / cell).floor() as i32,
        (position.y / cell).floor() as i32,
        (position.z / cell).floor() as i32,
    ]
}

#[derive(Default)]
struct Totals {
    ticks: u32,
    records: u64,
    bytes: u64,
    /// Indexed [occluded][moving]: bytes and records.
    by_state: [[(u64, u64); 2]; 2],
    /// Bytes whose dominant position-error axis is vertical.
    vertical_bytes: u64,
    vertical_records: u64,
    /// Sum of |error| per axis, metres -- the raw anisotropy signal.
    error_axis: [f64; 3],
    /// Bytes by speed octave, index = log2(speed) clamped to 0..7.
    by_speed: [(u64, u64); 8],
    /// Bytes by burial depth in voxels, last bucket is "deeper than".
    by_depth: [(u64, u64); 6],
    depth_sum: f64,
}

static TOTALS: OnceLock<Mutex<Totals>> = OnceLock::new();

pub(crate) fn record(
    grid: &Grid,
    actor: usize,
    state: &ActorState,
    radius: f32,
    position_error: Vec3,
    bytes: usize,
) {
    let burial = grid.burial_depth(actor);
    let speed = crate::mask::motion_magnitude(state.linear_velocity, state.angular_velocity, radius);
    // "Occluded" means buried behind at least INTERIOR_DEPTH layers of debris;
    // "moving" reuses the masking threshold so the buckets line up with the
    // mechanism P5 would actually change.
    let occluded = usize::from(burial >= INTERIOR_DEPTH);
    let moving = usize::from(speed > 0.5);

    let Ok(mut totals) = TOTALS.get_or_init(|| Mutex::new(Totals::default())).lock() else {
        return;
    };
    totals.ticks = totals.ticks.max(grid.tick_counter);
    totals.records += 1;
    totals.bytes += bytes as u64;
    totals.depth_sum += burial as f64;
    let bucket = (burial as usize).min(5);
    totals.by_depth[bucket].0 += bytes as u64;
    totals.by_depth[bucket].1 += 1;
    let slot = &mut totals.by_state[occluded][moving];
    slot.0 += bytes as u64;
    slot.1 += 1;

    let error = position_error.abs();
    totals.error_axis[0] += error.x as f64;
    totals.error_axis[1] += error.y as f64;
    totals.error_axis[2] += error.z as f64;
    if error.y >= error.x && error.y >= error.z {
        totals.vertical_bytes += bytes as u64;
        totals.vertical_records += 1;
    }

    let octave = if speed <= 1.0 {
        0
    } else {
        (speed.log2().floor() as usize + 1).min(7)
    };
    totals.by_speed[octave].0 += bytes as u64;
    totals.by_speed[octave].1 += 1;
}

/// R6 sizing: how many root records in a delta block merely restate what the
/// previous block already established? Those are what cross-block span
/// continuation would remove, so this bounds the mechanism before it is built.
#[derive(Default)]
pub(crate) struct SegmentContinuity {
    pub(crate) first_in_block: u64,
    pub(crate) static_repeat: u64,
    pub(crate) same_model: u64,
    pub(crate) total_records: u64,
}

static CONTINUITY: OnceLock<Mutex<SegmentContinuity>> = OnceLock::new();

pub(crate) fn record_continuity(
    first_in_block: u64,
    static_repeat: u64,
    same_model: u64,
    total: u64,
) {
    let Ok(mut totals) = CONTINUITY
        .get_or_init(|| Mutex::new(SegmentContinuity::default()))
        .lock()
    else {
        return;
    };
    totals.first_in_block += first_in_block;
    totals.static_repeat += static_repeat;
    totals.same_model += same_model;
    totals.total_records += total;
}

pub fn report() {
    if !enabled() {
        return;
    }
    let Some(totals) = TOTALS.get().and_then(|cell| cell.lock().ok()) else {
        eprintln!("census: no residuals recorded");
        return;
    };
    let bytes = totals.bytes.max(1) as f64;
    eprintln!("\n=== P1 census ({} residual records sampled) ===", totals.records);

    eprintln!("\nP1a occlusion x motion (share of residual bytes):");
    for (occluded, label_o) in [(0, "visible "), (1, "occluded")] {
        for (moving, label_m) in [(0, "still "), (1, "moving")] {
            let (b, n) = totals.by_state[occluded][moving];
            eprintln!(
                "  {label_o} {label_m}: {:>6.2}%  ({n} records, {:.1} B/record)",
                100.0 * b as f64 / bytes,
                b as f64 / n.max(1) as f64
            );
        }
    }
    eprintln!(
        "  mean burial depth across repaired bodies: {:.2} voxels",
        totals.depth_sum / totals.records.max(1) as f64
    );
    eprintln!("  bytes by burial depth (0 = exposed surface):");
    for (depth, (b, n)) in totals.by_depth.iter().enumerate() {
        if *n == 0 {
            continue;
        }
        let label = if depth == 5 { ">=5".to_string() } else { depth.to_string() };
        eprintln!(
            "    depth {label:>3}: {:>6.2}%  ({n} records)",
            100.0 * *b as f64 / bytes
        );
    }

    if let Some(continuity) = CONTINUITY.get().and_then(|cell| cell.lock().ok()) {
        if continuity.total_records > 0 {
            let first = continuity.first_in_block.max(1) as f64;
            eprintln!("\nR6 root-record continuity across delta blocks:");
            eprintln!(
                "  records total {}, first-for-root in block {} ({:.1}% of records)",
                continuity.total_records,
                continuity.first_in_block,
                100.0 * first / continuity.total_records as f64
            );
            eprintln!(
                "  of those firsts: {:.1}% restate a static root unchanged, {:.1}% keep the same model pair",
                100.0 * continuity.static_repeat as f64 / first,
                100.0 * continuity.same_model as f64 / first
            );
        }
    }

    eprintln!("\nP1b error anatomy:");
    let axis_total: f64 = totals.error_axis.iter().sum::<f64>().max(1e-9);
    eprintln!(
        "  |error| by axis: x {:.1}%  y(vertical) {:.1}%  z {:.1}%",
        100.0 * totals.error_axis[0] / axis_total,
        100.0 * totals.error_axis[1] / axis_total,
        100.0 * totals.error_axis[2] / axis_total
    );
    eprintln!(
        "  bytes whose dominant error axis is vertical: {:.1}%",
        100.0 * totals.vertical_bytes as f64 / bytes
    );
    eprintln!("  bytes by speed octave:");
    for (octave, (b, n)) in totals.by_speed.iter().enumerate() {
        if *n == 0 {
            continue;
        }
        let lo = if octave == 0 { 0.0 } else { (1 << (octave - 1)) as f32 };
        let hi = (1 << octave) as f32;
        eprintln!(
            "    {lo:>5.0}-{hi:<5.0} m/s: {:>6.2}%  ({n} records)",
            100.0 * *b as f64 / bytes
        );
    }
}
