//! The client stage for the per-player stream (city wire 4): the shared
//! client core (`vibe_land_perplayer::client::Client`, the code the browser
//! runs through WASM) fed every packet of a lab tape at its arrival time,
//! drawn at 60 frames/s into the same pose tables the city layer composes
//! (`drawn-chunks.bin`, VLCHNK01), so the scorers read it like any other run.
//!
//! The browser adds a thin facade over the same core (rendering only); the
//! parity of the two is a test of its own.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use glam::{Quat, Vec3};

use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::per_player::{body_entity, structure_defs, PerPlayerConfig};
use vibe_land_perplayer::client::Client;
use vibe_land_perplayer::predict::Physics;
use vibe_land_perplayer::structure::REMOVED;
use vibe_land_perplayer::wire::BodyKey;

use crate::vltape::ClientTape;

const FRAME_MS: f64 = 1000.0 / 60.0;

struct Writer {
    out: std::io::BufWriter<std::fs::File>,
    emitted_bodies: HashMap<u32, (u32, [f32; 7])>,
    emitted_slots: HashMap<u32, (i32, [f32; 7])>,
}

impl Writer {
    fn frame(
        &mut self,
        sample_ms: f64,
        sim_tick: u32,
        render_tick: f32,
        bodies: &[(u32, u32, [f32; 7])],
        slots: &[(u32, i32, [f32; 7])],
    ) -> std::io::Result<()> {
        let bodies: Vec<_> = bodies
            .iter()
            .filter(|&&(index, key, pose)| {
                let fresh = self.emitted_bodies.get(&index) != Some(&(key, pose));
                if fresh {
                    self.emitted_bodies.insert(index, (key, pose));
                }
                fresh
            })
            .collect();
        let slots: Vec<_> = slots
            .iter()
            .filter(|&&(slot, index, local)| {
                let fresh = self.emitted_slots.get(&slot) != Some(&(index, local));
                if fresh {
                    self.emitted_slots.insert(slot, (index, local));
                }
                fresh
            })
            .collect();
        let o = &mut self.out;
        o.write_all(&sample_ms.to_le_bytes())?;
        o.write_all(&sim_tick.to_le_bytes())?;
        o.write_all(&render_tick.to_le_bytes())?;
        o.write_all(&0f32.to_le_bytes())?;
        o.write_all(&(bodies.len() as u32).to_le_bytes())?;
        for &&(index, key, pose) in &bodies {
            o.write_all(&index.to_le_bytes())?;
            o.write_all(&key.to_le_bytes())?;
            for v in pose {
                o.write_all(&v.to_le_bytes())?;
            }
        }
        o.write_all(&(slots.len() as u32).to_le_bytes())?;
        for &&(slot, index, local) in &slots {
            o.write_all(&slot.to_le_bytes())?;
            o.write_all(&index.to_le_bytes())?;
            for v in local {
                o.write_all(&v.to_le_bytes())?;
            }
        }
        Ok(())
    }
}

/// Run the per-player client over `dir/lab.vltape`, writing
/// `dir/drawn-chunks.bin` and `dir/client-stats.json`.
pub fn run(dir: &Path, manifest: &DestructionManifest, config: PerPlayerConfig, timeline_ms: &[(u32, f64)]) -> std::io::Result<()> {
    let tape = ClientTape::read(&dir.join("lab.vltape"))?;
    let defs = structure_defs(manifest);
    // Slots as the scorer numbers them: structures in manifest order, nodes
    // by index.
    let mut slot_base: HashMap<u32, u32> = HashMap::new();
    let mut structures_json = Vec::new();
    let mut count = 0u32;
    for def in &defs {
        slot_base.insert(def.id, count);
        structures_json.push(serde_json::json!({"structureId": def.id, "slotBase": count, "chunks": def.node_count()}));
        count += def.node_count();
    }
    let physics = Physics::at_hz(config.sim_hz, config.gravity_y);
    let mut client = Client::new(defs.clone(), physics, config.sim_hz, config.delay_ticks);
    let mut writer = Writer {
        out: std::io::BufWriter::new(std::fs::File::create(dir.join(crate::chunks::CHUNKS_FILE))?),
        emitted_bodies: HashMap::new(),
        emitted_slots: HashMap::new(),
    };
    let header = serde_json::to_vec(&serde_json::json!({
        "format": "VLCHNK01",
        "chunkCount": count,
        "structures": structures_json,
        "simHz": config.sim_hz,
        "clockOriginMs": 0.0,
        "stride": "none (every body every frame)",
        "tables": "perplayer::client::Client (city wire 4), drawn as the city layer composes",
    }))?;
    writer.out.write_all(b"VLCHNK01")?;
    writer.out.write_all(&(header.len() as u32).to_le_bytes())?;
    writer.out.write_all(&header)?;

    // Body indices: one per structure for its standing chunks, then one per
    // dynamic body key, reused after it ends.
    let mut index_of: HashMap<u32, u32> = HashMap::new();
    let mut free: Vec<u32> = Vec::new();
    let mut next_index = 0u32;
    let mut index_for = |key: u32, index_of: &mut HashMap<u32, u32>, free: &mut Vec<u32>| -> u32 {
        *index_of.entry(key).or_insert_with(|| {
            free.pop().unwrap_or_else(|| {
                next_index += 1;
                next_index - 1
            })
        })
    };
    let sim_tick_at = |ms: f64| -> u32 {
        let i = timeline_ms.partition_point(|&(_, end)| end <= ms);
        timeline_ms[i.saturating_sub(1)].0
    };
    let mut packet = 0;
    let first_ms = tape.packets.first().map_or(0.0, |p| p.t_ms);
    let end_ms = tape.packets.last().map_or(0.0, |p| p.t_ms);
    let mut t = first_ms;
    let mut frames = 0u64;
    // Gate G7: frames showing a moment the server had not simulated yet when
    // they were drawn (the server's own tick timeline): no data can exist
    // for them, so they are prediction alone. A healthy render clock stays
    // its playout delay plus the path's latency behind.
    let (mut frames_ahead, mut max_ahead) = (0u64, f32::MIN);
    let mut live_keys: HashMap<u32, ()> = HashMap::new();
    let started = std::time::Instant::now();
    // NETLAB2_PP_TRACE=structure:node (diagnosis): that chunk's body and its
    // keyframes every frame, for client c01 (NETLAB2_PP_TRACE_CLIENT=cNN).
    let trace: Option<(u32, u32)> = std::env::var("NETLAB2_PP_TRACE").ok().and_then(|v| {
        let (a, b) = v.split_once(':')?;
        Some((a.parse().ok()?, b.parse().ok()?))
    });
    while t <= end_ms {
        while packet < tape.packets.len() && tape.packets[packet].t_ms <= t {
            let p = &tape.packets[packet];
            client.ingest(&p.bytes, p.t_ms);
            packet += 1;
        }
        let Some(render) = client.advance(t) else {
            t += FRAME_MS;
            continue;
        };
        let ahead = render - sim_tick_at(t) as f32;
        if ahead > 0.0 {
            frames_ahead += 1;
        }
        max_ahead = max_ahead.max(ahead);
        if !client.started() {
            t += FRAME_MS;
            continue;
        }
        let mut body_entries: Vec<(u32, u32, [f32; 7])> = Vec::new();
        let mut slot_entries: Vec<(u32, i32, [f32; 7])> = Vec::new();
        // Standing structures: one body each at its authored pose.
        for def in &defs {
            let key = ids::body_entity(def.id, 0);
            let index = index_for(key, &mut index_of, &mut free);
            let (p, q) = (def.world_position, def.world_rotation);
            body_entries.push((index, key, [p.x, p.y, p.z, q.x, q.y, q.z, q.w]));
        }
        // Dynamic bodies at the render tick.
        let mut now_live: HashMap<u32, ()> = HashMap::new();
        for (key, p, q, _) in client.body_poses() {
            let entity = body_entity(key);
            let index = index_for(entity, &mut index_of, &mut free);
            body_entries.push((index, entity, [p.x, p.y, p.z, q.x, q.y, q.z, q.w]));
            now_live.insert(entity, ());
        }
        // Indices are never reused: a record may still name a body that has
        // no pose this frame, and a reused index would draw its chunks on
        // another body.
        live_keys = now_live;
        // Records whose body changed.
        let changes = client.drain_slot_changes();
        let all = frames == 0;
        let slots: Vec<(u32, u32)> = if all {
            defs.iter().flat_map(|d| (0..d.node_count()).map(move |n| (d.id, n))).collect()
        } else {
            changes
        };
        for (structure, node) in slots {
            let slot = slot_base[&structure] + node;
            let local = client.chunk_local(structure, node);
            let index = match client.chunk_body(structure, node) {
                None => index_for(ids::body_entity(structure, 0), &mut index_of, &mut free) as i32,
                Some(REMOVED) => -1,
                Some(body) => index_for(body_entity(BodyKey { structure, body }), &mut index_of, &mut free) as i32,
            };
            let q = Quat::IDENTITY;
            let l: Vec3 = local;
            slot_entries.push((slot, index, [l.x, l.y, l.z, q.x, q.y, q.z, q.w]));
        }
        if let Some((ts, tn)) = trace {
            if dir.ends_with(std::env::var("NETLAB2_PP_TRACE_CLIENT").unwrap_or_else(|_| "c01".into())) {
                let body = client.chunk_body(ts, tn);
                let track = body.and_then(|b| client.track(BodyKey { structure: ts, body: b }));
                let pose = track.map(|t| t.pose_at(render, physics));
                eprintln!(
                    "PPTRACE r={render:.2} body={body:?} pose={pose:?} chunk={:?} local={:?} kfs={:?}",
                    pose.map(|(p, q)| p + q * client.chunk_local(ts, tn)),
                    client.chunk_local(ts, tn),
                    track.map(|t| t.keyframes().iter().map(|k| (k.tick, k.position, k.mode as u8)).collect::<Vec<_>>()),
                );
            }
        }
        writer.frame(t, sim_tick_at(t), render, &body_entries, &slot_entries)?;
        frames += 1;
        t += FRAME_MS;
    }
    writer.out.flush()?;
    let s = &client.stats;
    std::fs::write(
        dir.join("client-stats.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "label": "per-player",
            "framesSampled": frames,
            "clientCpuMs": started.elapsed().as_secs_f64() * 1000.0,
            "city": {
                "hashChecks": s.hash_checks,
                "hashMismatches": s.hash_mismatches,
                "eventsApplied": s.events_applied,
                "eventsAppliedEarly": 0,
                "eventsLate": s.events_late,
                "missingBaselines": s.missing_baselines,
                "keyframes": s.keyframes,
                "lateKeyframes": s.late_keyframes,
                "heldKeyframes": s.held_keyframes,
                "heldDropped": s.held_dropped,
                "decodeErrors": s.decode_errors,
                "bootstraps": s.bootstraps,
                "framesAheadOfServer": frames_ahead,
                "maxTicksAheadOfServer": max_ahead,
            }
        }))?,
    )?;
    Ok(())
}
