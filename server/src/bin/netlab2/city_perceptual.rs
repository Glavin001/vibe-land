//! One city client's run through the perceptual evaluator
//! (`vibe_land_destruction::netlab::perceptual`): every chunk the client drew,
//! seen through that client's own camera, against the truth at the frame's
//! render time.
//!
//! Per frame: the drawn tables (`drawn-chunks.bin`) give each chunk's
//! displayed pose, the encoder tape gives its true pose (`ChunkTruth`), and
//! the client's camera is its spec evaluated at the frame's time. Every
//! displayed chunk -- standing structures included, as occluders -- is
//! rasterised into a low-resolution object-ID buffer. A chunk is scored when
//! some of its pixels survive. Chunks that are standing and unbroken in both
//! the drawn and the true world cannot move, so they are occluders only.

use std::path::Path;

use glam::Vec3;

use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::cameras::{CameraSpec, PlayerTracks};
use vibe_land_destruction::netlab::perceptual::{IdBuffer, ItemSample, PerceptualEval, PerceptualReport};
use vibe_land_destruction::perception::{PerceptualModel, Projector};

use crate::chunks::{ChunkReader, ChunkTruth, DrawnTables};

/// The object-ID buffer's resolution: an eighth of the 1920x1080 pane each
/// way. A chunk smaller than a buffer pixel can still be scored when it is
/// on screen and nothing nearer covers its centre pixel.
const ID_WIDTH: usize = 240;
const ID_HEIGHT: usize = 135;

struct SlotInfo {
    half_extents: Vec3,
    mass: f32,
}

fn slot_table(manifest: &DestructionManifest) -> Vec<SlotInfo> {
    let mut slots = Vec::new();
    for structure in &manifest.structures {
        let n = structure.chunks.iter().map(|c| c.node_index + 1).max().unwrap_or(0) as usize;
        let mut table: Vec<SlotInfo> = (0..n).map(|_| SlotInfo { half_extents: Vec3::splat(0.1), mass: 0.0 }).collect();
        for chunk in &structure.chunks {
            table[chunk.node_index as usize] =
                SlotInfo { half_extents: Vec3::from_array(chunk.size) * 0.5, mass: chunk.mass };
        }
        slots.extend(table);
    }
    slots
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_client(
    chunks_path: &Path,
    tape_path: &Path,
    manifest: &DestructionManifest,
    checkpoint: Option<&vibe_land_destruction::encoder::EncoderCheckpoint>,
    camera: &CameraSpec,
    tracks: &PlayerTracks,
    origin_ms: f64,
    model: PerceptualModel,
) -> std::io::Result<PerceptualReport> {
    let mut reader = ChunkReader::open(chunks_path)?;
    let mut truth = ChunkTruth::open(tape_path, manifest, checkpoint)?;
    let slots = slot_table(manifest);
    if slots.len() as u32 != reader.chunk_count {
        return Err(std::io::Error::other("the chunk stream and the manifest disagree on the chunk count"));
    }
    let gravity = Vec3::new(0.0, -(vibe_netcode::movement::GRAVITY as f32), 0.0);
    let pane = model.pane;
    let mut eval = PerceptualEval::new(model, gravity);
    // NETLAB2_PERCEPTUAL_DUMP=<dir>: every event at or above threshold, one
    // JSON line each, per client (diagnosis; changes no score).
    let dump = std::env::var("NETLAB2_PERCEPTUAL_DUMP").ok().filter(|d| !d.is_empty());
    eval.record_events(dump.is_some());
    let worst = std::env::var("NETLAB2_WORST_CHUNKS").ok().filter(|_| chunks_path.parent().is_some_and(|p| p.ends_with("c01")));
    let mut worst_map: std::collections::HashMap<u32, (f64, u64, f64, f64, u32)> = std::collections::HashMap::new();
    let trace_body: Option<u32> = std::env::var("NETLAB2_PERCEPTUAL_TRACE").ok().and_then(|v| v.parse().ok());
    let mut tables = DrawnTables::new(reader.chunk_count);
    let mut buffer = IdBuffer::new(ID_WIDTH, ID_HEIGHT, pane);
    let mut changed = Vec::new();
    let mut items: Vec<ItemSample> = Vec::new();
    let Some(first_tick) = truth.first_tick else {
        return Ok(eval.report());
    };
    while let Some(frame) = reader.next_frame()? {
        changed.clear();
        tables.apply(&frame, &mut changed);
        truth.advance_to(frame.sim_tick)?;
        let render = if frame.render_tick >= 0.0 { frame.render_tick - frame.playout_delay_ticks } else { frame.sim_tick as f32 };
        if render < first_tick as f32 || frame.sim_tick > truth.last_tick || frame.sim_tick < first_tick {
            continue;
        }
        let seconds = ((frame.sample_ms - origin_ms) / 1000.0) as f32;
        let Some(cam) = camera.camera_in_run(frame.sim_tick, seconds, tracks) else {
            continue;
        };
        let projector = Projector::new(cam, pane);
        buffer.clear();
        items.clear();
        for slot in 0..reader.chunk_count {
            let drawn = tables.chunk(slot).filter(|d| d.drawn);
            let info = &slots[slot as usize];
            if let Some(d) = drawn {
                buffer.draw_box(&projector, slot, d.position, d.rotation, info.half_extents);
            }
            let true_chunk = truth.chunk_at(slot, render);
            let standing = |key: u32| ids::body_entity_parts(key).1 == 0;
            let both_standing = drawn.map_or(true, |d| standing(d.key)) && true_chunk.map_or(true, |t| standing(t.key));
            if both_standing {
                continue;
            }
            items.push(ItemSample {
                id: slot,
                body: true_chunk.map_or(drawn.map_or(0, |d| d.key), |t| t.key),
                half_extents: info.half_extents,
                mass: info.mass,
                displayed: drawn.map(|d| (d.position, d.rotation)),
                truth: true_chunk.map(|t| (t.position, t.rotation)),
                visibility: 0.0,
            });
        }
        let visible = buffer.visible_ids();
        for item in &mut items {
            item.visibility = if visible.contains(&item.id) { 1.0 } else { 0.0 };
        }
        if let Some(body) = trace_body {
            // NETLAB2_PERCEPTUAL_TRACE=<truth body key>: one line per frame
            // for that body's lowest slot (diagnosis only).
            if let Some(item) = items.iter().filter(|i| i.body == body).min_by_key(|i| i.id) {
                let px = |p: Vec3| projector.project(p).map(|(s, d)| (s.x, s.y, d));
                eprintln!(
                    "TRACE {} t={:.4} sim={} render={:.2} slot={} vis={} drawn={:?} truth={:?} d_px={:?} t_px={:?}",
                    chunks_path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    frame.sample_ms / 1000.0,
                    frame.sim_tick,
                    render,
                    item.id,
                    item.visibility,
                    item.displayed.map(|d| d.0),
                    item.truth.map(|t| t.0),
                    item.displayed.and_then(|d| px(d.0)),
                    item.truth.and_then(|t| px(t.0)),
                );
            }
        }
        if worst.is_some() {
            for item in &items {
                if let (Some(d), Some(t)) = (item.displayed, item.truth) {
                    let e = d.0.distance(t.0);
                    let entry = worst_map.entry(item.id).or_insert((0.0, 0u64, 0.0, 0.0, item.body));
                    entry.0 += f64::from(e);
                    entry.1 += 1;
                    if f64::from(e) > entry.2 {
                        entry.2 = f64::from(e);
                        entry.3 = f64::from(render);
                        entry.4 = item.body;
                    }
                }
            }
        }
        eval.frame(frame.sample_ms / 1000.0, cam, &items);
        truth.trim(render.floor().max(0.0) as u32);
    }
    if worst.is_some() {
        let mut rows: Vec<_> = worst_map.into_iter().map(|(slot, (sum, n, max, at, body))| (sum / n as f64, slot, n, max, at, body)).collect();
        rows.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (mean, slot, n, max, at, body) in rows.iter().take(25) {
            eprintln!("WORST slot={slot} mean={mean:.3} frames={n} max={max:.3} at_render={at:.1} truth_body={body} serial={}", body & 0xfffff);
        }
    }
    if let Some(dir) = dump {
        use std::io::Write;
        std::fs::create_dir_all(&dir)?;
        let name = chunks_path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mut file = std::io::BufWriter::new(std::fs::File::create(Path::new(&dir).join(format!("{name}-events.jsonl")))?);
        for (t, class, body, m) in eval.take_events() {
            writeln!(file, "{}", serde_json::json!({"t": t, "class": class.name(), "body": body, "m": m}))?;
        }
    }
    Ok(eval.report())
}
