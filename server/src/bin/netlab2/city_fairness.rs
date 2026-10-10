//! Sightline fairness (F2, F3): whether the debris each player draws blocks
//! the line between two players where the truth does.
//!
//! Each frame, for every pair of lab clients within `MAX_RANGE_M` of each
//! other, the segment between their eyes is tested against chunk boxes:
//!
//! - **F2, per player:** that player's drawn world against the truth at the
//!   frame the player draws. A *phantom* frame is drawn blocked where the
//!   truth is clear (the player hides behind, or cannot see through,
//!   debris that is not there). A *see-through* frame is drawn clear where
//!   the truth is blocked (the player sees, and may shoot at, someone the
//!   server says is hidden).
//! - **F3, per pair:** the two players' drawn worlds disagree. One sees the
//!   other while the other sees a wall, so one of them has the advantage.
//!
//! Only frames where something is near the line can differ, so the counts
//! are rates over the pair-frames where any chunk crossed the line in any of
//! the worlds. Standing structures are drawn the same in every world, so
//! these counts are about debris, which is what the netcode decides.
//! Segment ends within `EYE_CLEAR_M` of an eye are ignored: a player
//! standing in rubble is not blocked by the piece at their feet.

use std::path::Path;

use glam::{Quat, Vec3};
use serde::Serialize;

use vibe_land_destruction::netlab::cameras::{ClientSpec, PlayerTracks};

use crate::chunks::ChunkTruth;
use crate::city_clips::DrawnRun;
use crate::city_lab::{client_dir, CityCapture, ORIGIN_MS};
use crate::city_perceptual::slot_table;

/// Pairs further apart than this are not in each other's play.
const MAX_RANGE_M: f32 = 150.0;
/// The part of the line next to each eye that does not count.
const EYE_CLEAR_M: f32 = 0.5;
const FRAME_MS: f64 = 1000.0 / 60.0;

#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Fairness {
    /// Pairs of clients scored, and pair-frames in range.
    pub pairs: u32,
    pub pair_frames: u64,
    /// Pair-frames where some chunk crossed the line in any world.
    pub contested_pair_frames: u64,
    /// F2, summed over both players of each pair: drawn blocked, truth
    /// clear; drawn clear, truth blocked.
    pub f2_phantom_frames: u64,
    pub f2_see_through_frames: u64,
    /// F3: the pair's two drawn worlds disagree.
    pub f3_asymmetric_frames: u64,
    /// Per pair-minute in range.
    pub f2_per_pair_minute: f64,
    pub f3_per_pair_minute: f64,
}

/// A chunk as a box, with its bounding radius for a quick cull.
#[derive(Clone, Copy)]
struct Solid {
    position: Vec3,
    rotation: Quat,
    half: Vec3,
    radius: f32,
}

/// Whether the segment a..b (less `EYE_CLEAR_M` at each end) passes through
/// any solid.
fn blocked(solids: &[Solid], a: Vec3, b: Vec3) -> bool {
    let len = a.distance(b);
    if len <= 2.0 * EYE_CLEAR_M {
        return false;
    }
    let dir = (b - a) / len;
    let (t0, t1) = (EYE_CLEAR_M, len - EYE_CLEAR_M);
    solids.iter().any(|s| {
        // Cull: the sphere's distance from the segment.
        let along = (s.position - a).dot(dir).clamp(t0, t1);
        if (a + dir * along).distance(s.position) > s.radius {
            return false;
        }
        // Slab test in the box's frame.
        let inv = s.rotation.conjugate();
        let o = inv * (a - s.position);
        let d = inv * dir;
        let (mut lo, mut hi) = (t0, t1);
        for axis in 0..3 {
            let (oa, da, h) = (o[axis], d[axis], s.half[axis]);
            if da.abs() < 1e-9 {
                if oa.abs() > h {
                    return false;
                }
                continue;
            }
            let (mut ta, mut tb) = ((-h - oa) / da, (h - oa) / da);
            if ta > tb {
                std::mem::swap(&mut ta, &mut tb);
            }
            lo = lo.max(ta);
            hi = hi.min(tb);
            if lo > hi {
                return false;
            }
        }
        true
    })
}

/// Sightlines for every pair of a run's clients.
pub fn evaluate(capture: &CityCapture, clients: &[ClientSpec], out: &Path) -> std::io::Result<Fairness> {
    let slots = slot_table(&capture.manifest);
    let mut runs: Vec<DrawnRun> = Vec::new();
    for index in 0..clients.len() {
        let path = client_dir(out, index).join(crate::chunks::CHUNKS_FILE);
        if !path.is_file() {
            return Ok(Fairness::default());
        }
        runs.push(DrawnRun::open(&path)?);
    }
    let mut truth = ChunkTruth::open(&capture.tape_path(), &capture.manifest, capture.checkpoint.as_ref())?;
    let pairs: Vec<(usize, usize)> = (0..clients.len()).flat_map(|a| (a + 1..clients.len()).map(move |b| (a, b))).collect();
    let mut report = Fairness { pairs: pairs.len() as u32, ..Default::default() };
    if pairs.is_empty() {
        return Ok(report);
    }
    let tracks: &PlayerTracks = &capture.tracks;
    let first_tick = truth.first_tick.unwrap_or(0);
    let mut t = ORIGIN_MS;
    let mut drawn: Vec<Vec<Solid>> = vec![Vec::new(); runs.len()];
    let mut truth_solids: Vec<Vec<Solid>> = vec![Vec::new(); runs.len()];
    loop {
        let mut frames = Vec::with_capacity(runs.len());
        for run in &mut runs {
            frames.push(run.advance(t)?);
        }
        let Some((sim_tick, _)) = frames[0] else {
            if t > ORIGIN_MS + 3_600_000.0 {
                break;
            }
            t += FRAME_MS;
            continue;
        };
        if frames.iter().all(Option::is_some) && runs.iter().all(|r| r.finished()) && t > ORIGIN_MS + 1000.0 {
            break;
        }
        truth.advance_to(sim_tick)?;
        let seconds = ((t - ORIGIN_MS) / 1000.0) as f32;
        let eyes: Vec<Option<Vec3>> = clients
            .iter()
            .map(|c| c.camera.camera_in_run(sim_tick, seconds, tracks).map(|cam| cam.eye))
            .collect();
        let in_range: Vec<(usize, usize)> = pairs
            .iter()
            .copied()
            .filter(|&(a, b)| matches!((eyes[a], eyes[b]), (Some(ea), Some(eb)) if ea.distance(eb) <= MAX_RANGE_M))
            .collect();
        if !in_range.is_empty() && sim_tick >= first_tick {
            // Each client's drawn world and the truth at its render tick.
            for (i, run) in runs.iter().enumerate() {
                drawn[i].clear();
                truth_solids[i].clear();
                let render = frames[i].map_or(sim_tick as f32, |f| f.1);
                for slot in 0..slots.len() as u32 {
                    let half = slots[slot as usize].half_extents;
                    let radius = half.length();
                    if let Some(d) = run.tables.chunk(slot).filter(|d| d.drawn) {
                        drawn[i].push(Solid { position: d.position, rotation: d.rotation, half, radius });
                    }
                    if let Some(c) = truth.chunk_at(slot, render) {
                        truth_solids[i].push(Solid { position: c.position, rotation: c.rotation, half, radius });
                    }
                }
            }
            for (a, b) in in_range {
                let (ea, eb) = (eyes[a].unwrap(), eyes[b].unwrap());
                report.pair_frames += 1;
                let (da, db) = (blocked(&drawn[a], ea, eb), blocked(&drawn[b], eb, ea));
                let (ta, tb) = (blocked(&truth_solids[a], ea, eb), blocked(&truth_solids[b], eb, ea));
                if da || db || ta || tb {
                    report.contested_pair_frames += 1;
                }
                for (d, tr) in [(da, ta), (db, tb)] {
                    match (d, tr) {
                        (true, false) => report.f2_phantom_frames += 1,
                        (false, true) => report.f2_see_through_frames += 1,
                        _ => {}
                    }
                }
                if da != db {
                    report.f3_asymmetric_frames += 1;
                }
            }
        }
        truth.trim(frames.iter().flatten().map(|f| f.1).fold(f32::MAX, f32::min).floor().max(0.0) as u32);
        t += FRAME_MS;
    }
    let minutes = report.pair_frames as f64 * FRAME_MS / 60_000.0;
    if minutes > 0.0 {
        report.f2_per_pair_minute = (report.f2_phantom_frames + report.f2_see_through_frames) as f64 / 2.0 / minutes;
        report.f3_per_pair_minute = report.f3_asymmetric_frames as f64 / minutes;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_box_on_the_line_blocks_and_one_beside_it_or_at_the_eye_does_not() {
        let wall = |x: f32, z: f32| Solid { position: Vec3::new(x, 1.6, z), rotation: Quat::IDENTITY, half: Vec3::new(0.3, 1.0, 1.0), radius: 1.5 };
        let (a, b) = (Vec3::new(0.0, 1.6, 0.0), Vec3::new(20.0, 1.6, 0.0));
        assert!(blocked(&[wall(10.0, 0.0)], a, b));
        assert!(!blocked(&[wall(10.0, 3.0)], a, b), "beside the line");
        assert!(!blocked(&[Solid { half: Vec3::splat(0.2), radius: 0.35, ..wall(0.1, 0.0) }], a, b), "at the eye");
        let turned = Solid { rotation: Quat::from_rotation_y(0.7), ..wall(10.0, 0.8) };
        assert!(blocked(&[turned], a, b), "a rotated wall reaching the line");
    }
}
