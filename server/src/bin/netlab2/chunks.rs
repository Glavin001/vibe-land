//! Every city chunk, as CityChunksLayer draws it, against frozen truth.
//!
//! **Drawn.** The client stage runs the layer's own pose step
//! (client/src/city/cityPoseStore.ts `advanceCityPoses`) every frame and
//! writes what changed in the two tables the vertex shader composes from
//! (drawn-chunks.bin, VLCHNK01; client/netlab/v2/chunkFormat.ts). A chunk is
//! drawn at `body[index].pose ∘ record(slot)` -- position `p + rotate(q, l)`,
//! rotation `normalize(q * lq)` -- and not drawn at all without a record or
//! composed below `CHUNK_HIDE_Y_M` (the shader's hide rule). The layer's
//! distance stride is left out: it is a render-rate choice (a deferred body
//! is written later at that later frame's pose).
//!
//! **Truth.** The encoder tape (every awake island's pose every tick, plus
//! the topology and settle events) and the manifest, replayed into a per-chunk
//! model: which island each chunk is on at each tick, the island's pose, and
//! the island frame's rest centre of mass. Per the wire contract
//! (netcode/src/destruction_backend.rs `IslandPromotion`):
//! `chunk_world = island_pose ∘ (rest_local - island_com)`, the com being the
//! mass-weighted rest centroid of the island's members (the same rule the
//! client uses, topology.ts `restCentreOfMassOf`); a chunk still on its
//! structure is at `structure_pose ∘ rest_local`; a chunk whose island was
//! retired is gone. The state at capture start comes from the encoder
//! checkpoint's ledger.
//!
//! Render time is the city presentation's sample tick (`render_tick -
//! playout_delay`), "now" the tick the server had completed at the frame
//! (the timeline). Each chunk-frame weighs 1. Error only changes when the
//! drawn record or body, or the truth island, changes; the scorer keeps each
//! chunk's last measure and adds it with the number of frames it held
//! (exact, and it keeps a 24k-chunk, 40k-frame run to seconds).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read};
use std::path::Path;

use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};

use vibe_land_destruction::encoder::ChunkStreamEncoder;
use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::DestructionManifest;
use vibe_land_destruction::netlab::tape::TapeReader;
use vibe_land_destruction::types::Pose;

use crate::unified::{AllDrawsAcc, DrawErrors, FirstDrawAcc, JoinWindows};

/// The client stage's chunk stream in a run directory.
pub const CHUNKS_FILE: &str = "drawn-chunks.bin";
/// The shader's hide depth (client/src/city/cityPoseStore.ts CHUNK_HIDE_Y_M).
pub const CHUNK_HIDE_Y_M: f32 = -4.0;
/// Truth history kept per island and per chunk, ticks (covers any render lag).
const TRUTH_HISTORY_TICKS: u32 = 1_800;
const GONE: u32 = u32::MAX;
/// A body counts as moving for first-draw coverage above this speed.
const MOVING_MPS: f32 = 0.5;

// ── VLCHNK01 ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct ChunkFrame {
    pub sample_ms: f64,
    pub sim_tick: u32,
    pub render_tick: f32,
    pub playout_delay_ticks: f32,
    /// (index, key, [px py pz qx qy qz qw])
    pub bodies: Vec<(u32, u32, [f32; 7])>,
    /// (slot, index, [lx ly lz qx qy qz qw])
    pub records: Vec<(u32, i32, [f32; 7])>,
}

pub struct ChunkReader {
    input: Box<dyn Read>,
    pub header: serde_json::Value,
    pub chunk_count: u32,
}

fn read_exact<const N: usize>(input: &mut dyn Read) -> std::io::Result<[u8; N]> {
    let mut b = [0u8; N];
    input.read_exact(&mut b)?;
    Ok(b)
}

impl ChunkReader {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        use std::io::{Seek, SeekFrom};
        let mut file = std::fs::File::open(path)?;
        let mut head = [0u8; 2];
        let sniffed = file.read(&mut head)?;
        file.seek(SeekFrom::Start(0))?;
        let input: Box<dyn Read> = if sniffed == 2 && head == [0x1f, 0x8b] {
            Box::new(BufReader::with_capacity(1 << 20, flate2::read::MultiGzDecoder::new(BufReader::new(file))))
        } else {
            Box::new(BufReader::with_capacity(1 << 20, file))
        };
        Self::from_reader(input)
    }

    pub fn from_reader(mut input: Box<dyn Read>) -> std::io::Result<Self> {
        let magic = read_exact::<8>(&mut *input)?;
        if &magic != b"VLCHNK01" {
            return Err(std::io::Error::other("not a VLCHNK01 chunk stream"));
        }
        let len = u32::from_le_bytes(read_exact::<4>(&mut *input)?) as usize;
        let mut json = vec![0u8; len];
        input.read_exact(&mut json)?;
        let header: serde_json::Value = serde_json::from_slice(&json)?;
        let chunk_count = header["chunkCount"].as_u64().unwrap_or(0) as u32;
        Ok(Self { input, header, chunk_count })
    }

    pub fn next_frame(&mut self) -> std::io::Result<Option<ChunkFrame>> {
        let mut first = [0u8; 8];
        match self.input.read_exact(&mut first) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let input = &mut *self.input;
        let u32_ = |i: &mut dyn Read| -> std::io::Result<u32> { Ok(u32::from_le_bytes(read_exact::<4>(i)?)) };
        let f32_ = |i: &mut dyn Read| -> std::io::Result<f32> { Ok(f32::from_le_bytes(read_exact::<4>(i)?)) };
        let mut frame = ChunkFrame {
            sample_ms: f64::from_le_bytes(first),
            sim_tick: u32_(input)?,
            render_tick: f32_(input)?,
            playout_delay_ticks: f32_(input)?,
            ..Default::default()
        };
        let n = u32_(input)? as usize;
        let mut buf = vec![0u8; n * 36];
        input.read_exact(&mut buf)?;
        frame.bodies = buf
            .chunks_exact(36)
            .map(|e| {
                let f = |o: usize| f32::from_le_bytes(e[o..o + 4].try_into().unwrap());
                (
                    u32::from_le_bytes(e[0..4].try_into().unwrap()),
                    u32::from_le_bytes(e[4..8].try_into().unwrap()),
                    [f(8), f(12), f(16), f(20), f(24), f(28), f(32)],
                )
            })
            .collect();
        let n = u32_(input)? as usize;
        let mut buf = vec![0u8; n * 36];
        input.read_exact(&mut buf)?;
        frame.records = buf
            .chunks_exact(36)
            .map(|e| {
                let f = |o: usize| f32::from_le_bytes(e[o..o + 4].try_into().unwrap());
                (
                    u32::from_le_bytes(e[0..4].try_into().unwrap()),
                    i32::from_le_bytes(e[4..8].try_into().unwrap()),
                    [f(8), f(12), f(16), f(20), f(24), f(28), f(32)],
                )
            })
            .collect();
        Ok(Some(frame))
    }
}

// ── the drawn tables ────────────────────────────────────────────────────────

/// The layer's two tables, as of the last frame applied.
#[derive(Default)]
pub struct DrawnTables {
    /// index -> (key, pose)
    bodies: Vec<(u32, [f32; 7])>,
    /// slot -> (index, local)
    records: Vec<(i32, [f32; 7])>,
    /// index -> slots whose record names it
    slots_of: HashMap<u32, HashSet<u32>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawnChunk {
    pub position: Vec3,
    pub rotation: Quat,
    /// The body key the record's index was last given.
    pub key: u32,
    /// The shader draws it (a record, not below the hide depth).
    pub drawn: bool,
}

impl DrawnTables {
    pub fn new(chunk_count: u32) -> Self {
        Self { bodies: Vec::new(), records: vec![(-1, [0.0; 7]); chunk_count as usize], slots_of: HashMap::new() }
    }

    /// Applies a frame; returns the slots whose drawn pose may have changed.
    pub fn apply(&mut self, frame: &ChunkFrame, changed: &mut Vec<u32>) {
        for &(slot, index, local) in &frame.records {
            let Some(record) = self.records.get_mut(slot as usize) else { continue };
            if record.0 >= 0 && record.0 != index {
                if let Some(set) = self.slots_of.get_mut(&(record.0 as u32)) {
                    set.remove(&slot);
                }
            }
            if index >= 0 {
                self.slots_of.entry(index as u32).or_default().insert(slot);
            }
            *record = (index, local);
            changed.push(slot);
        }
        for &(index, key, pose) in &frame.bodies {
            let i = index as usize;
            if self.bodies.len() <= i {
                self.bodies.resize(i + 1, (GONE, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]));
            }
            self.bodies[i] = (key, pose);
            if let Some(slots) = self.slots_of.get(&index) {
                changed.extend(slots.iter().copied());
            }
        }
    }

    /// The chunk as the vertex shader composes it (citySlotMatrix).
    pub fn chunk(&self, slot: u32) -> Option<DrawnChunk> {
        let (index, l) = *self.records.get(slot as usize)?;
        if index < 0 {
            return None;
        }
        let (key, b) = self.bodies.get(index as usize).copied().unwrap_or((GONE, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]));
        let (qx, qy, qz, qw) = (b[3], b[4], b[5], b[6]);
        let (lx, ly, lz) = (l[0], l[1], l[2]);
        // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
        let cx = qy * lz - qz * ly + qw * lx;
        let cy = qz * lx - qx * lz + qw * ly;
        let cz = qx * ly - qy * lx + qw * lz;
        let position = Vec3::new(
            b[0] + lx + 2.0 * (qy * cz - qz * cy),
            b[1] + ly + 2.0 * (qz * cx - qx * cz),
            b[2] + lz + 2.0 * (qx * cy - qy * cx),
        );
        let rotation = (Quat::from_xyzw(qx, qy, qz, qw) * Quat::from_xyzw(l[3], l[4], l[5], l[6])).normalize();
        Some(DrawnChunk { position, rotation, key, drawn: position.y >= CHUNK_HIDE_Y_M })
    }
}

// ── truth ───────────────────────────────────────────────────────────────────

struct Island {
    /// (tick, pose): promotions, stream samples, settles.
    history: VecDeque<(u32, Pose)>,
    /// (tick, settled)
    settled: VecDeque<(u32, bool)>,
    /// (tick, rest com) at every membership change.
    com: VecDeque<(u32, Vec3)>,
    members: HashSet<u32>,
    last_event: u32,
    retired: Option<u32>,
}

impl Island {
    fn new() -> Self {
        Self {
            history: VecDeque::new(),
            settled: VecDeque::new(),
            com: VecDeque::new(),
            members: HashSet::new(),
            last_event: 0,
            retired: None,
        }
    }

    fn pose_at(&self, tick: f32) -> Option<Pose> {
        let first = self.history.front()?;
        if tick <= first.0 as f32 {
            return Some(first.1);
        }
        let last = self.history.back()?;
        if tick >= last.0 as f32 {
            return Some(last.1);
        }
        let i = self.history.partition_point(|s| (s.0 as f32) <= tick);
        let (a, b) = (self.history[i - 1], self.history[i]);
        let t = ((tick - a.0 as f32) / (b.0 - a.0).max(1) as f32).clamp(0.0, 1.0);
        Some(Pose { position: a.1.position.lerp(b.1.position, t), rotation: a.1.rotation.slerp(b.1.rotation, t) })
    }

    fn at<T: Copy>(list: &VecDeque<(u32, T)>, tick: u32) -> Option<T> {
        let i = list.partition_point(|s| s.0 <= tick);
        if i == 0 {
            list.front().map(|s| s.1)
        } else {
            Some(list[i - 1].1)
        }
    }

    fn trim(&mut self, floor: u32) {
        fn keep_one_before<T>(list: &mut VecDeque<(u32, T)>, floor: u32) {
            while list.len() > 1 && list[1].0 <= floor {
                list.pop_front();
            }
        }
        keep_one_before(&mut self.history, floor);
        keep_one_before(&mut self.settled, floor);
        keep_one_before(&mut self.com, floor);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TruthChunk {
    pub position: Vec3,
    pub rotation: Quat,
    /// The island (or support body) key it is on.
    pub key: u32,
    pub settled: bool,
}

/// Per-chunk truth, advanced tick by tick through the encoder tape.
pub struct ChunkTruth {
    tape: TapeReader,
    pending: Option<vibe_land_destruction::netlab::tape::TapeTick>,
    pub first_tick: Option<u32>,
    pub last_tick: u32,
    slot_base: HashMap<u32, u32>,
    structure_of: Vec<u32>,
    rest: Vec<Vec3>,
    mass: Vec<f32>,
    support: HashMap<u32, Pose>,
    /// slot -> (tick, key) membership changes; GONE after a retire.
    membership: Vec<VecDeque<(u32, u32)>>,
    islands: HashMap<u32, Island>,
    /// (tick, slot) membership changes not yet behind the render window.
    pub recent_members: VecDeque<(u32, u32)>,
    pub chunk_count: u32,
    /// Island key -> the first tick truth had it moving faster than 0.5 m/s.
    pub first_moving: HashMap<u32, u32>,
}

impl ChunkTruth {
    pub fn open(
        tape_path: &Path,
        manifest: &DestructionManifest,
        checkpoint: Option<&vibe_land_destruction::encoder::EncoderCheckpoint>,
    ) -> std::io::Result<Self> {
        let mut tape = TapeReader::open(tape_path)?;
        if tape.manifest_hash != manifest.hash() {
            return Err(std::io::Error::other("the encoder tape was recorded against a different manifest"));
        }
        let (mut slot_base, mut structure_of, mut rest, mut mass, mut support) =
            (HashMap::new(), Vec::new(), Vec::new(), Vec::new(), HashMap::new());
        // Slot order: structures in manifest order, node index within (topology.ts).
        for structure in &manifest.structures {
            let base = structure_of.len() as u32;
            slot_base.insert(structure.structure_id, base);
            let mut chunks: Vec<_> = structure.chunks.iter().collect();
            chunks.sort_by_key(|c| c.node_index);
            let n = chunks.last().map_or(0, |c| c.node_index + 1) as usize;
            let (mut r, mut m) = (vec![Vec3::ZERO; n], vec![0.0f32; n]);
            for chunk in chunks {
                r[chunk.node_index as usize] = Vec3::from_array(chunk.centroid);
                m[chunk.node_index as usize] = chunk.mass;
            }
            structure_of.extend(std::iter::repeat(structure.structure_id).take(n));
            rest.extend(r);
            mass.extend(m);
            support.insert(
                structure.structure_id,
                Pose {
                    position: Vec3::from_array(structure.world_position),
                    rotation: Quat::from_array(structure.world_rotation).normalize(),
                },
            );
        }
        let chunk_count = rest.len() as u32;
        let membership = (0..chunk_count)
            .map(|slot| {
                let structure = structure_of[slot as usize];
                VecDeque::from([(0u32, ids::body_entity(structure, 0))])
            })
            .collect();
        let pending = tape.next_tick()?;
        let first_tick = pending.as_ref().map(|t| t.tick);
        let mut truth = Self {
            tape,
            pending,
            first_tick,
            last_tick: first_tick.unwrap_or(0),
            slot_base,
            structure_of,
            rest,
            mass,
            support,
            membership,
            islands: HashMap::new(),
            recent_members: VecDeque::new(),
            chunk_count,
            first_moving: HashMap::new(),
        };
        // The ledger at capture start (a capture can open mid-match).
        if let (Some(checkpoint), Some(first)) = (checkpoint, first_tick) {
            if let Ok(encoder) = ChunkStreamEncoder::from_checkpoint(manifest, checkpoint.clone()) {
                let boot = encoder.ledger().bootstrap(0, [0; 32], 0, 0, &|_, _| None);
                let start = first.saturating_sub(1);
                for island in boot.islands {
                    let key = ids::body_entity(island.structure_id, island.island_id);
                    let slots: Vec<u32> = island
                        .nodes
                        .iter()
                        .filter_map(|&n| truth.slot_of(island.structure_id, n))
                        .collect();
                    let entry = truth.islands.entry(key).or_insert_with(Island::new);
                    entry.history.push_back((start, island.pose));
                    entry.settled.push_back((start, island.settled));
                    entry.last_event = start;
                    for &slot in &slots {
                        truth.membership[slot as usize] = VecDeque::from([(0, key)]);
                    }
                    entry.members.extend(slots);
                    truth.refresh_com(key, start);
                }
            }
        }
        Ok(truth)
    }

    fn slot_of(&self, structure: u32, node: u32) -> Option<u32> {
        let base = *self.slot_base.get(&structure)?;
        let slot = base + node;
        (slot < self.chunk_count && self.structure_of[slot as usize] == structure).then_some(slot)
    }

    /// Mass-weighted rest centroid of the island's members (topology.ts
    /// `restCentreOfMassOf`: massless members are skipped; no mass at all
    /// falls back to the plain centroid).
    fn refresh_com(&mut self, key: u32, tick: u32) {
        let Some(island) = self.islands.get_mut(&key) else { return };
        let (mut sum, mut mass, mut plain, mut n) = (Vec3::ZERO, 0.0f32, Vec3::ZERO, 0.0f32);
        for &slot in &island.members {
            let m = self.mass[slot as usize];
            let r = self.rest[slot as usize];
            if m > 0.0 {
                sum += r * m;
                mass += m;
            }
            plain += r;
            n += 1.0;
        }
        let com = if mass > 0.0 { sum / mass } else if n > 0.0 { plain / n } else { Vec3::ZERO };
        if island.com.back().is_some_and(|c| c.0 == tick) {
            island.com.back_mut().unwrap().1 = com;
        } else {
            island.com.push_back((tick, com));
        }
        island.last_event = island.last_event.max(tick);
    }

    fn move_slot(&mut self, slot: u32, to: u32, tick: u32, touched: &mut HashSet<u32>) {
        let history = &mut self.membership[slot as usize];
        let from = history.back().map_or(GONE, |e| e.1);
        if from == to {
            return;
        }
        if history.back().is_some_and(|e| e.0 == tick) {
            history.back_mut().unwrap().1 = to;
        } else {
            history.push_back((tick, to));
        }
        if let Some(island) = self.islands.get_mut(&from) {
            island.members.remove(&slot);
            touched.insert(from);
        }
        if let Some(island) = self.islands.get_mut(&to) {
            island.members.insert(slot);
            touched.insert(to);
        }
        self.recent_members.push_back((tick, slot));
    }

    /// Applies every tick up to and including `tick`.
    pub fn advance_to(&mut self, tick: u32) -> std::io::Result<()> {
        while self.pending.as_ref().is_some_and(|t| t.tick <= tick) {
            let t = self.pending.take().unwrap();
            self.apply(&t);
            self.last_tick = t.tick;
            self.pending = self.tape.next_tick()?;
        }
        Ok(())
    }

    fn apply(&mut self, t: &vibe_land_destruction::netlab::tape::TapeTick) {
        let tick = t.tick;
        let mut touched: HashSet<u32> = HashSet::new();
        for batch in &t.output.batches {
            // The ledger's order (topology.rs apply_batch): promotions,
            // migrations, retires.
            for promotion in &batch.promoted_islands {
                let key = ids::body_entity(promotion.structure_id, promotion.island_id);
                let island = self.islands.entry(key).or_insert_with(Island::new);
                island.retired = None;
                island.history.push_back((
                    tick,
                    Pose {
                        position: Vec3::from_array(promotion.position),
                        rotation: Quat::from_array(promotion.rotation).normalize(),
                    },
                ));
                island.settled.push_back((tick, false));
                island.last_event = tick;
                if Vec3::from_array(promotion.linear_velocity).length() > MOVING_MPS {
                    self.first_moving.entry(key).or_insert(tick);
                }
                let slots: Vec<u32> = promotion
                    .chunks
                    .iter()
                    .filter_map(|&c| {
                        let (s, n) = ids::chunk_id_parts(c);
                        self.slot_of(s, n)
                    })
                    .collect();
                for slot in slots {
                    self.move_slot(slot, key, tick, &mut touched);
                }
                touched.insert(key);
            }
            for migration in &batch.migrations {
                let (s, n) = ids::chunk_id_parts(migration.chunk_id);
                let to = ids::body_entity(batch.structure_id, migration.to_island_id);
                if let Some(slot) = self.slot_of(s, n) {
                    if self.islands.contains_key(&to) {
                        self.move_slot(slot, to, tick, &mut touched);
                    } else {
                        // The ledger drops a node migrating to an island it
                        // does not have: out of its source, into nothing.
                        self.move_slot(slot, GONE, tick, &mut touched);
                    }
                }
            }
            for &retired in &batch.retired_island_ids {
                let key = ids::body_entity(batch.structure_id, retired);
                let members: Vec<u32> = self.islands.get(&key).map(|i| i.members.iter().copied().collect()).unwrap_or_default();
                for slot in members {
                    self.move_slot(slot, GONE, tick, &mut touched);
                }
                if let Some(island) = self.islands.get_mut(&key) {
                    island.retired = Some(tick);
                    island.last_event = tick;
                }
            }
        }
        for key in touched {
            self.refresh_com(key, tick);
        }
        for snapshot in &t.snapshots {
            let island = self.islands.entry(snapshot.body_entity).or_insert_with(Island::new);
            island.history.push_back((
                tick,
                Pose {
                    position: Vec3::from_array(snapshot.position),
                    rotation: Quat::from_array(snapshot.rotation).normalize(),
                },
            ));
            if island.settled.back().map_or(true, |s| s.1) {
                island.settled.push_back((tick, false));
            }
            island.last_event = tick;
            if Vec3::from_array(snapshot.linear_velocity).length() > MOVING_MPS {
                self.first_moving.entry(snapshot.body_entity).or_insert(tick);
            }
        }
        for settle in &t.output.settled {
            let key = ids::body_entity(settle.structure_id, settle.island_id);
            if let Some(island) = self.islands.get_mut(&key) {
                island.history.push_back((
                    tick,
                    Pose {
                        position: Vec3::from_array(settle.position),
                        rotation: Quat::from_array(settle.rotation).normalize(),
                    },
                ));
                island.settled.push_back((tick, true));
                island.last_event = tick;
            }
        }
        for &(structure, serial) in &t.output.wakes {
            if let Some(island) = self.islands.get_mut(&ids::body_entity(structure, serial)) {
                island.settled.push_back((tick, false));
                island.last_event = tick;
            }
        }
    }

    /// Forget what no render time can reach any more.
    pub fn trim(&mut self, render_floor: u32) {
        let floor = render_floor.saturating_sub(TRUTH_HISTORY_TICKS);
        for island in self.islands.values_mut() {
            island.trim(floor);
        }
        self.islands.retain(|_, i| i.retired.map_or(true, |r| r >= floor));
        for history in &mut self.membership {
            while history.len() > 1 && history[1].0 <= floor {
                history.pop_front();
            }
        }
        while self.recent_members.front().is_some_and(|e| e.0 + 2 < render_floor) {
            self.recent_members.pop_front();
        }
    }

    pub fn key_at(&self, slot: u32, tick: u32) -> u32 {
        Island::at(&self.membership[slot as usize], tick).unwrap_or(GONE)
    }

    /// Keys the chunk was on from `from` to `to` inclusive.
    pub fn keys_between(&self, slot: u32, from: u32, to: u32) -> Vec<u32> {
        let history = &self.membership[slot as usize];
        let mut keys = vec![self.key_at(slot, from)];
        for &(tick, key) in history {
            if tick > from && tick <= to && !keys.contains(&key) {
                keys.push(key);
            }
        }
        keys
    }

    /// The chunk's truth pose at a (fractional) tick; None when gone.
    pub fn chunk_at(&self, slot: u32, tick: f32) -> Option<TruthChunk> {
        let whole = tick.floor().max(0.0) as u32;
        let key = self.key_at(slot, whole);
        if key == GONE {
            return None;
        }
        let rest = self.rest[slot as usize];
        let (_, serial) = ids::body_entity_parts(key);
        if serial == 0 {
            let pose = self.support.get(&self.structure_of[slot as usize])?;
            return Some(TruthChunk {
                position: pose.position + pose.rotation * rest,
                rotation: pose.rotation,
                key,
                settled: true,
            });
        }
        let island = self.islands.get(&key)?;
        let pose = island.pose_at(tick)?;
        let com = Island::at(&island.com, whole).unwrap_or(rest);
        Some(TruthChunk {
            position: pose.position + pose.rotation * (rest - com),
            rotation: pose.rotation,
            key,
            settled: Island::at(&island.settled, whole).unwrap_or(false),
        })
    }

    /// Islands truth has moving (streamed, not settled, not retired) around
    /// `tick`.
    pub fn moving_islands(&self, tick: u32) -> impl Iterator<Item = u32> + '_ {
        self.islands.iter().filter_map(move |(key, island)| {
            let streaming = island.last_event + 2 >= tick && island.retired.map_or(true, |r| r > tick);
            let settled = Island::at(&island.settled, tick).unwrap_or(false);
            (streaming && !settled).then_some(*key)
        })
    }

    /// Islands with a truth event at or after `tick`, and their members now.
    pub fn islands_active_since(&self, tick: u32) -> impl Iterator<Item = &HashSet<u32>> {
        self.islands.values().filter(move |i| i.last_event >= tick).map(|i| &i.members)
    }
}

// ── scoring ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Measure {
    class: Option<&'static str>,
    errors: Option<DrawErrors>,
    missing: bool,
    extra: bool,
    wrong_identity: bool,
}

impl Measure {
    fn add(&self, acc: &mut AllDrawsAcc, weight: f32) {
        let Some(class) = self.class else { return };
        if weight <= 0.0 {
            return;
        }
        if let Some(errors) = self.errors {
            acc.draw(class, errors, weight);
        }
        if self.missing {
            acc.missing(class, weight);
        }
        if self.extra {
            acc.extra(class, weight);
        }
        if self.wrong_identity {
            acc.wrong_identity(class, weight);
        }
    }
}

impl Measure {
    fn add_to(&self, all: &mut AllDrawsAcc, join: Option<&mut AllDrawsAcc>, in_join: bool, weight: f32) {
        self.add(all, weight);
        if in_join {
            if let Some(join) = join {
                self.add(join, weight);
            }
        }
    }
}

fn truth_class(truth: &TruthChunk) -> &'static str {
    let (_, serial) = ids::body_entity_parts(truth.key);
    if serial == 0 {
        "chunk_intact"
    } else if truth.settled {
        "chunk_rubble"
    } else {
        "chunk_debris"
    }
}

fn angle_deg(a: Quat, b: Quat) -> f32 {
    (2.0 * a.dot(b).abs().min(1.0).acos()).to_degrees()
}

fn measure(tables: &DrawnTables, truth: &ChunkTruth, slot: u32, render: f32, now: u32) -> Measure {
    let drawn = tables.chunk(slot).filter(|d| d.drawn);
    let at_render = truth.chunk_at(slot, render).filter(|t| t.position.y >= CHUNK_HIDE_Y_M);
    match (drawn, at_render) {
        (None, None) => Measure::default(),
        (None, Some(t)) => Measure { class: Some(truth_class(&t)), missing: true, ..Default::default() },
        (Some(d), None) => {
            let (_, serial) = ids::body_entity_parts(d.key);
            Measure {
                class: Some(if serial == 0 { "chunk_intact" } else { "chunk_debris" }),
                extra: true,
                ..Default::default()
            }
        }
        (Some(d), Some(t)) => {
            let at_now = truth.chunk_at(slot, now as f32);
            let whole = render.floor().max(0.0) as u32;
            let wrong_identity = d.key != t.key && !truth.keys_between(slot, whole, now.max(whole)).contains(&d.key);
            Measure {
                class: Some(truth_class(&t)),
                errors: Some(DrawErrors {
                    pos_render: Some(d.position.distance(t.position)),
                    rot_render: Some(angle_deg(d.rotation, t.rotation)),
                    pos_now: at_now.map(|n| d.position.distance(n.position)),
                    rot_now: at_now.map(|n| angle_deg(d.rotation, n.rotation)),
                }),
                wrong_identity,
                ..Default::default()
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChunkStats {
    pub frames: u64,
    pub frames_scored: u64,
    pub frames_outside_truth: u64,
    pub chunk_count: u32,
    /// Chunk measures recomputed (the rest held from the frame before).
    pub recomputed: u64,
}

/// Scores drawn-chunks.bin into `acc`.
pub fn score_chunks(
    chunks_path: &Path,
    tape_path: &Path,
    manifest: &DestructionManifest,
    checkpoint: Option<&vibe_land_destruction::encoder::EncoderCheckpoint>,
    acc: &mut AllDrawsAcc,
    mut join: Option<(&mut AllDrawsAcc, &JoinWindows)>,
    tick_end_ms: &HashMap<u32, f64>,
) -> std::io::Result<ChunkStats> {
    let mut reader = ChunkReader::open(chunks_path)?;
    let origin = reader.header["clockOriginMs"].as_f64().unwrap_or(0.0);
    let mut islands = FirstDrawAcc::default();
    // Join windows split the run into spans that are wholly in or out of
    // one; every chunk is re-measured where a span starts.
    let mut span_in_join = false;
    let mut truth = ChunkTruth::open(tape_path, manifest, checkpoint)?;
    if reader.chunk_count != truth.chunk_count {
        return Err(std::io::Error::other(format!(
            "the chunk stream has {} chunks, the manifest {}",
            reader.chunk_count, truth.chunk_count
        )));
    }
    let n = truth.chunk_count as usize;
    let mut tables = DrawnTables::new(truth.chunk_count);
    let mut current: Vec<Measure> = vec![Measure::default(); n];
    let mut since: Vec<u64> = vec![0; n];
    let mut stats = ChunkStats { chunk_count: truth.chunk_count, ..Default::default() };
    let mut counted = 0u64;
    let mut first_scored = true;
    let mut prev_render_floor = 0u32;
    let mut changed: Vec<u32> = Vec::new();
    let mut dirty = vec![false; n];
    let mut dirty_list: Vec<u32> = Vec::new();
    let Some(first_tick) = truth.first_tick else {
        return Ok(stats);
    };
    while let Some(frame) = reader.next_frame()? {
        stats.frames += 1;
        changed.clear();
        tables.apply(&frame, &mut changed);
        truth.advance_to(frame.sim_tick)?;
        // First draw of an island body: the first frame a record names it.
        let tape_ms = frame.sample_ms - origin;
        for &(index, key, _) in &frame.bodies {
            if ids::body_entity_parts(key).1 != 0 && tables.slots_of.get(&index).is_some_and(|s| !s.is_empty()) {
                islands.drawn(key, tape_ms);
            }
        }
        for &(_, index, _) in &frame.records {
            if let Some(&(key, _)) = (index >= 0).then(|| tables.bodies.get(index as usize)).flatten() {
                if key != GONE && ids::body_entity_parts(key).1 != 0 {
                    islands.drawn(key, tape_ms);
                }
            }
        }
        // Before the first city pose datagram the presentation clock is
        // unanchored (render tick -1): nothing is moving, the layer draws the
        // ledger as it stands, and the presented tick is the server's.
        let render = if frame.render_tick >= 0.0 {
            frame.render_tick - frame.playout_delay_ticks
        } else {
            frame.sim_tick as f32
        };
        let render_floor = render.floor().max(0.0) as u32;
        if render < first_tick as f32 || frame.sim_tick > truth.last_tick || frame.sim_tick < first_tick {
            // Outside the captured truth: drawn state is kept, nothing scored.
            stats.frames_outside_truth += 1;
            // Every chunk is re-measured at the next scored frame.
            first_scored = true;
            continue;
        }
        for key in truth.moving_islands(render_floor) {
            islands.moving_frame(key);
        }
        let in_join = join.as_ref().is_some_and(|(_, windows)| windows.contains(frame.sample_ms));
        if in_join != span_in_join {
            first_scored = true;
        }
        // Which chunks' measure can have changed since the last scored frame.
        dirty_list.clear();
        let mark = |slot: u32, dirty: &mut Vec<bool>, list: &mut Vec<u32>| {
            if !dirty[slot as usize] {
                dirty[slot as usize] = true;
                list.push(slot);
            }
        };
        if first_scored {
            for slot in 0..n as u32 {
                mark(slot, &mut dirty, &mut dirty_list);
            }
        } else {
            for &slot in &changed {
                mark(slot, &mut dirty, &mut dirty_list);
            }
            let since_tick = prev_render_floor.min(render_floor).saturating_sub(2);
            for &(_, slot) in &truth.recent_members {
                mark(slot, &mut dirty, &mut dirty_list);
            }
            let active: Vec<u32> = truth.islands_active_since(since_tick).flatten().copied().collect();
            for slot in active {
                mark(slot, &mut dirty, &mut dirty_list);
            }
        }
        for &slot in &dirty_list {
            let s = slot as usize;
            dirty[s] = false;
            let weight = counted - since[s];
            current[s].add_to(acc, join.as_mut().map(|(j, _)| &mut **j), span_in_join, weight as f32);
            current[s] = measure(&tables, &truth, slot, render, frame.sim_tick);
            since[s] = counted;
        }
        span_in_join = in_join;
        stats.recomputed += dirty_list.len() as u64;
        counted += 1;
        stats.frames_scored += 1;
        first_scored = false;
        prev_render_floor = render_floor;
        truth.trim(render_floor);
    }
    for s in 0..n {
        current[s].add_to(acc, join.as_mut().map(|(j, _)| &mut **j), span_in_join, (counted - since[s]) as f32);
    }
    for (key, tick) in &truth.first_moving {
        if let Some(ms) = tick_end_ms.get(tick) {
            islands.moved(*key, *ms);
        }
    }
    acc.first_draw.insert("island", islands);
    Ok(stats)
}

// ── calibration: the lab's tables against the live layer's samples ───────

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CityLiveCalibration {
    pub samples: u64,
    pub chunks_compared: u64,
    /// Live chunk poses vs the lab's at the frame nearest the live layer's
    /// frame time, metres / degrees, by class of the live body (intact =
    /// support body, debris = any island).
    pub pos_m: BTreeMap<String, crate::report::Pct>,
    pub rot_deg: BTreeMap<String, crate::report::Pct>,
    /// Chunks drawn by one and not the other.
    pub drawn_mismatch: u64,
    /// Chunks drawn on a different body key.
    pub key_mismatch: u64,
    /// |live frame time - matched lab frame time|, ms.
    pub frame_offset_ms: crate::report::Pct,
    /// Live samples with no lab frame within MAX_FRAME_OFFSET_MS.
    pub unmatched_samples: u64,
}

/// A live city sample is compared with a lab frame at most this far away.
pub const MAX_FRAME_OFFSET_MS: f64 = 17.0;

/// Compares the live city layer's samples (`city` in client-<n>-drawn.jsonl)
/// with the lab's drawn tables at the nearest lab frame.
pub fn city_vs_live(chunks_path: &Path, live_samples: &Path) -> std::io::Result<CityLiveCalibration> {
    #[derive(Deserialize)]
    struct Live {
        #[serde(rename = "atMs")]
        at_ms: f64,
        slots: Vec<u32>,
        bodies: Vec<f64>,
        positions: Vec<f32>,
        rotations: Vec<f32>,
        drawn: Vec<u8>,
    }
    let text = std::fs::read_to_string(live_samples)?;
    let mut live: Vec<Live> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|v| serde_json::from_value::<Live>(v.get("city")?.clone()).ok())
        .collect();
    live.sort_by(|a, b| a.at_ms.total_cmp(&b.at_ms));
    let mut out = CityLiveCalibration::default();
    if live.is_empty() {
        return Ok(out);
    }
    let mut reader = ChunkReader::open(chunks_path)?;
    let mut tables = DrawnTables::new(reader.chunk_count);
    let mut scratch = Vec::new();
    let (mut pos, mut rot, mut offsets): (BTreeMap<String, Vec<f32>>, BTreeMap<String, Vec<f32>>, Vec<f32>) =
        Default::default();
    let mut next = 0usize;
    // The previous frame's composed chunks for the next live sample (its
    // time, the sample's index, the chunks), kept when that frame could be
    // the nearer one.
    let mut previous: Option<(f64, usize, Vec<Option<DrawnChunk>>)> = None;
    let compare = |lab: &dyn Fn(usize, u32) -> Option<DrawnChunk>, frame_ms: f64, sample: &Live, out: &mut CityLiveCalibration,
                   pos: &mut BTreeMap<String, Vec<f32>>, rot: &mut BTreeMap<String, Vec<f32>>, offsets: &mut Vec<f32>| {
        let offset = (sample.at_ms - frame_ms).abs();
        if offset > MAX_FRAME_OFFSET_MS {
            // No lab frame near it (before the lab's first frame, or a
            // recording gap): nothing to compare.
            out.unmatched_samples += 1;
            return;
        }
        out.samples += 1;
        offsets.push(offset as f32);
        for (i, &slot) in sample.slots.iter().enumerate() {
            let live_drawn = sample.drawn.get(i) == Some(&1);
            let Some(lab) = lab(i, slot) else {
                if live_drawn {
                    out.drawn_mismatch += 1;
                }
                continue;
            };
            if lab.drawn != live_drawn {
                out.drawn_mismatch += 1;
            }
            let key = sample.bodies.get(i).copied().unwrap_or(-1.0);
            if (key as i64) != i64::from(lab.key) {
                out.key_mismatch += 1;
            }
            if i * 3 + 2 >= sample.positions.len() || i * 4 + 3 >= sample.rotations.len() {
                continue;
            }
            let p = Vec3::new(sample.positions[i * 3], sample.positions[i * 3 + 1], sample.positions[i * 3 + 2]);
            let q = Quat::from_xyzw(
                sample.rotations[i * 4],
                sample.rotations[i * 4 + 1],
                sample.rotations[i * 4 + 2],
                sample.rotations[i * 4 + 3],
            )
            .normalize();
            let class = if (key as u64) & 0x0f_ffff == 0 { "chunk_intact" } else { "chunk_debris" };
            pos.entry(class.into()).or_default().push(p.distance(lab.position));
            rot.entry(class.into()).or_default().push(angle_deg(q, lab.rotation));
            out.chunks_compared += 1;
        }
    };
    while let Some(frame) = reader.next_frame()? {
        scratch.clear();
        tables.apply(&frame, &mut scratch);
        while next < live.len() && live[next].at_ms <= frame.sample_ms {
            let sample = &live[next];
            match &previous {
                Some((prev_ms, index, chunks))
                    if *index == next && (sample.at_ms - prev_ms).abs() < (frame.sample_ms - sample.at_ms).abs() =>
                {
                    compare(&|i, _| chunks[i], *prev_ms, sample, &mut out, &mut pos, &mut rot, &mut offsets);
                }
                _ => compare(&|_, slot| tables.chunk(slot), frame.sample_ms, sample, &mut out, &mut pos, &mut rot, &mut offsets),
            }
            next += 1;
        }
        if next >= live.len() {
            break;
        }
        // The next sample within 50 ms: this frame may be its nearest.
        previous = (live[next].at_ms - frame.sample_ms < 50.0).then(|| {
            (frame.sample_ms, next, live[next].slots.iter().map(|&slot| tables.chunk(slot)).collect())
        });
    }
    out.pos_m = pos.into_iter().map(|(k, v)| (k, crate::report::Pct::of(v))).collect();
    out.rot_deg = rot.into_iter().map(|(k, v)| (k, crate::report::Pct::of(v))).collect();
    out.frame_offset_ms = crate::report::Pct::of(offsets);
    Ok(out)
}

/// Lab vs reference (the same client on the recorded tape): the drawn tables
/// must agree chunk for chunk at every frame both drew.
pub fn chunks_diff(a: &Path, b: &Path) -> std::io::Result<(crate::report::Pct, u64)> {
    let (mut ra, mut rb) = (ChunkReader::open(a)?, ChunkReader::open(b)?);
    let (mut ta, mut tb) = (DrawnTables::new(ra.chunk_count), DrawnTables::new(rb.chunk_count));
    let (mut sa, mut sb) = (Vec::new(), Vec::new());
    let mut diffs = Vec::new();
    let mut drawn_mismatch = 0u64;
    let (mut fa, mut fb) = (ra.next_frame()?, rb.next_frame()?);
    let mut frame_index = 0u64;
    while let (Some(x), Some(y)) = (&fa, &fb) {
        let (kx, ky) = ((x.sample_ms * 1000.0).round() as i64, (y.sample_ms * 1000.0).round() as i64);
        if kx < ky {
            sa.clear();
            ta.apply(x, &mut sa);
            fa = ra.next_frame()?;
            continue;
        }
        if ky < kx {
            sb.clear();
            tb.apply(y, &mut sb);
            fb = rb.next_frame()?;
            continue;
        }
        sa.clear();
        sb.clear();
        ta.apply(x, &mut sa);
        tb.apply(y, &mut sb);
        // Every 30th common frame, every chunk (a full compare per frame is
        // 24k x 40k); the tables are cumulative, so a divergence persists.
        if frame_index % 30 == 0 {
            for slot in 0..ta.records.len() as u32 {
                match (ta.chunk(slot), tb.chunk(slot)) {
                    (Some(p), Some(q)) => {
                        if p.drawn != q.drawn {
                            drawn_mismatch += 1;
                        }
                        diffs.push(p.position.distance(q.position));
                    }
                    (None, None) => {}
                    _ => drawn_mismatch += 1,
                }
            }
        }
        frame_index += 1;
        fa = ra.next_frame()?;
        fb = rb.next_frame()?;
    }
    Ok((crate::report::Pct::of(diffs), drawn_mismatch))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(bodies: Vec<(u32, u32, [f32; 7])>, records: Vec<(u32, i32, [f32; 7])>) -> ChunkFrame {
        ChunkFrame { bodies, records, ..Default::default() }
    }

    #[test]
    fn tables_compose_like_the_shader_and_hide_below_the_floor() {
        let mut t = DrawnTables::new(3);
        let q = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
        let mut changed = Vec::new();
        t.apply(
            &frame(
                vec![(0, 0x8000_0001, [1.0, 2.0, 3.0, q.x, q.y, q.z, q.w]), (1, 0x8000_0002, [0.0, -10.0, 0.0, 0.0, 0.0, 0.0, 1.0])],
                vec![(0, 0, [2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]), (1, 1, [0.0; 3].into_iter().chain([0.0, 0.0, 0.0, 1.0]).collect::<Vec<_>>().try_into().unwrap())],
            ),
            &mut changed,
        );
        let c = t.chunk(0).unwrap();
        let expected = Vec3::new(1.0, 2.0, 3.0) + q * Vec3::new(2.0, 0.0, 0.0);
        assert!(c.position.distance(expected) < 1e-5, "{c:?}");
        assert!(c.drawn);
        assert_eq!(c.key, 0x8000_0001);
        assert!(!t.chunk(1).unwrap().drawn, "below the hide depth");
        assert!(t.chunk(2).is_none(), "no record");
        // Moving body 0 marks slot 0 changed.
        changed.clear();
        t.apply(&frame(vec![(0, 0x8000_0001, [5.0, 2.0, 3.0, q.x, q.y, q.z, q.w])], vec![]), &mut changed);
        assert_eq!(changed, vec![0]);
    }

    // ── the scorer against a synthetic tape: a perfect client, and the
    //    negative controls (a wrong pose per chunk class, a missing, an
    //    extra and a wrong-identity draw are each detected) ──────────────

    use vibe_land_destruction::city::{build_city_scene, CitySceneDesc};
    use vibe_land_destruction::encoder::BodySnapshotInput;
    use vibe_land_destruction::netlab::tape::{TapeCamera, TapeWriter};
    use vibe_land_destruction::scene_pack::parse_scene_pack;
    use vibe_netcode::destruction_backend::{
        DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
    };

    fn manifest() -> DestructionManifest {
        let pack = parse_scene_pack(
            r#"{
            "version": 1, "title": "tiny",
            "scenario": {
                "nodes": [
                    {"centroid": {"x": 0, "y": 0, "z": 0}, "mass": 0, "volume": 1},
                    {"centroid": {"x": 0, "y": 1, "z": 0}, "mass": 10, "volume": 1},
                    {"centroid": {"x": 0, "y": 2, "z": 0}, "mass": 30, "volume": 1}
                ],
                "bonds": [
                    {"node0": 0, "node1": 1, "centroid": {"x": 0, "y": 0.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0},
                    {"node0": 1, "node1": 2, "centroid": {"x": 0, "y": 1.5, "z": 0}, "normal": {"x": 0, "y": 1, "z": 0}, "area": 1.0}
                ],
                "nodeSizes": [{"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}, {"x": 1, "y": 1, "z": 1}],
                "nodeColliders": [
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}},
                    {"kind": "cuboid", "halfExtents": {"x": 0.5, "y": 0.5, "z": 0.5}}
                ]
            }
        }"#,
        )
        .expect("pack");
        DestructionManifest::from_city(
            &build_city_scene(&pack, CitySceneDesc { grid: 1, pitch_m: 10.0, varied_heights: false }).expect("city"),
        )
    }

    const ISLAND_TICK: u32 = 10;
    const SETTLE_TICK: u32 = 40;
    const RETIRE_TICK: u32 = 60;
    const LAST_TICK: u32 = 80;

    /// The island's pose at a tick: promoted at its rest com, falls 0.1 m a
    /// tick while it streams, then rests where it settled.
    fn island_pose(m: &DestructionManifest, tick: u32) -> Pose {
        let s = &m.structures[0];
        let world = Pose { position: Vec3::from_array(s.world_position), rotation: Quat::from_array(s.world_rotation) };
        let rest = |n: u32| Vec3::from_array(s.chunks.iter().find(|c| c.node_index == n).unwrap().centroid);
        // Mass-weighted: node 1 (10 kg), node 2 (30 kg).
        let com = (rest(1) * 10.0 + rest(2) * 30.0) / 40.0;
        let t = tick.min(SETTLE_TICK).saturating_sub(ISLAND_TICK) as f32;
        Pose {
            position: world.position + world.rotation * com + Vec3::new(0.3 * t, -0.02 * t, 0.0),
            rotation: world.rotation * Quat::from_rotation_y(0.01 * t),
        }
    }

    fn write_tape(path: &Path, m: &DestructionManifest) {
        let camera = TapeCamera { eye: [0.0, 5.0, -20.0], direction: [0.0, 0.0, 1.0], fov_degrees: 60.0 };
        let mut w = TapeWriter::create(path, 60, m.hash(), camera).unwrap();
        let key = ids::body_entity(0, 1);
        for tick in 0..=LAST_TICK {
            let mut output = DestructionTickOutput::default();
            let mut snapshots = Vec::new();
            let pose = island_pose(m, tick);
            if tick == ISLAND_TICK {
                output.batches.push(FractureBatch {
                    structure_id: 0,
                    broken_bond_ids: vec![ids::bond_id(0, 0)],
                    migrations: vec![],
                    promoted_islands: vec![IslandPromotion {
                        structure_id: 0,
                        island_id: 1,
                        chunks: vec![ids::chunk_id(0, 1), ids::chunk_id(0, 2)],
                        position: pose.position.to_array(),
                        rotation: pose.rotation.to_array(),
                        ..Default::default()
                    }],
                    retired_island_ids: vec![],
                });
            }
            if tick > ISLAND_TICK && tick < SETTLE_TICK {
                snapshots.push(BodySnapshotInput {
                    body_entity: key,
                    position: pose.position.to_array(),
                    rotation: pose.rotation.to_array(),
                    linear_velocity: [18.0, -1.2, 0.0],
                    angular_velocity: [0.0, 0.6, 0.0],
                    contacts: 0,
                    flags: 0,
                });
            }
            if tick == SETTLE_TICK {
                output.settled.push(SettleEvent {
                    structure_id: 0,
                    island_id: 1,
                    position: pose.position.to_array(),
                    rotation: pose.rotation.to_array(),
                });
            }
            if tick == RETIRE_TICK {
                output.batches.push(FractureBatch { structure_id: 0, retired_island_ids: vec![1], ..Default::default() });
            }
            w.push(tick, &snapshots, &output).unwrap();
        }
        w.finish().unwrap();
    }

    #[derive(Clone, Copy, Default)]
    struct Faults {
        /// Added to the drawn x of every chunk on an island body.
        island_offset: f32,
        /// Added to the drawn x of every chunk on the support body.
        intact_offset: f32,
        /// Node 2 is never given a record for its island (stays undrawn).
        drop_record: bool,
        /// Node 2 is drawn on a body key truth never had it on.
        wrong_key: bool,
        /// The island's chunks are hidden when truth retires it (else they
        /// stay drawn at the last pose: extra draws).
        hide_on_retire: bool,
        /// Node 0 never gets a record: never drawn.
        undrawn_intact: bool,
    }

    /// A client stream that draws exactly the truth (at render tick = sim
    /// tick, no playout delay), with `faults` applied.
    fn write_stream(path: &Path, m: &DestructionManifest, f: Faults) {
        use std::io::Write;
        let s = &m.structures[0];
        let world = Pose { position: Vec3::from_array(s.world_position), rotation: Quat::from_array(s.world_rotation) };
        let rest = |n: u32| Vec3::from_array(s.chunks.iter().find(|c| c.node_index == n).unwrap().centroid);
        let com = (rest(1) * 10.0 + rest(2) * 30.0) / 40.0;
        let mut out = Vec::new();
        let header = serde_json::json!({"chunkCount": 3, "structures": [{"structureId": 0, "slotBase": 0, "chunks": 3}]});
        let json = serde_json::to_vec(&header).unwrap();
        out.extend_from_slice(b"VLCHNK01");
        out.extend_from_slice(&(json.len() as u32).to_le_bytes());
        out.extend_from_slice(&json);
        let pose7 = |p: Vec3, q: Quat, dx: f32| [p.x + dx, p.y, p.z, q.x, q.y, q.z, q.w];
        for tick in 0..=LAST_TICK {
            let mut bodies: Vec<(u32, u32, [f32; 7])> = Vec::new();
            let mut records: Vec<(u32, i32, [f32; 7])> = Vec::new();
            if tick == 0 {
                bodies.push((0, ids::body_entity(0, 0), pose7(world.position, world.rotation, f.intact_offset)));
                for n in 0..3u32 {
                    if n == 0 && f.undrawn_intact {
                        continue;
                    }
                    let r = rest(n);
                    records.push((n, 0, [r.x, r.y, r.z, 0.0, 0.0, 0.0, 1.0]));
                }
            }
            if tick >= ISLAND_TICK {
                let pose = island_pose(m, tick);
                let mut p = pose.position;
                if f.hide_on_retire && tick >= RETIRE_TICK {
                    p.y = -100.0;
                }
                bodies.push((1, ids::body_entity(0, 1), pose7(p, pose.rotation, f.island_offset)));
                if f.wrong_key {
                    bodies.push((2, ids::body_entity(0, 7), pose7(pose.position, pose.rotation, 0.0)));
                }
            }
            if tick == ISLAND_TICK {
                for n in [1u32, 2] {
                    if n == 2 && f.drop_record {
                        continue;
                    }
                    let l = rest(n) - com;
                    let index = if n == 2 && f.wrong_key { 2 } else { 1 };
                    records.push((n, index, [l.x, l.y, l.z, 0.0, 0.0, 0.0, 1.0]));
                }
            }
            out.extend_from_slice(&(f64::from(tick) * 1000.0 / 60.0).to_le_bytes());
            out.extend_from_slice(&tick.to_le_bytes());
            // The first frames come before any city pose datagram: the
            // presentation clock is unanchored (-1) and still scored.
            let render_tick = if tick < 5 { -1.0f32 } else { tick as f32 };
            out.extend_from_slice(&render_tick.to_le_bytes());
            out.extend_from_slice(&(if tick < 5 { 6.0f32 } else { 0.0 }).to_le_bytes());
            out.extend_from_slice(&(bodies.len() as u32).to_le_bytes());
            for (i, k, v) in &bodies {
                out.extend_from_slice(&i.to_le_bytes());
                out.extend_from_slice(&k.to_le_bytes());
                v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
            }
            out.extend_from_slice(&(records.len() as u32).to_le_bytes());
            for (slot, i, v) in &records {
                out.extend_from_slice(&slot.to_le_bytes());
                out.extend_from_slice(&i.to_le_bytes());
                v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
            }
        }
        std::fs::File::create(path).unwrap().write_all(&out).unwrap();
    }

    fn score_with(f: Faults) -> crate::unified::AllDraws {
        let dir = std::env::temp_dir().join(format!("netlab2-chunks-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let m = manifest();
        let (tape, stream) = (dir.join("encoder.tape"), dir.join("drawn-chunks.bin"));
        write_tape(&tape, &m);
        write_stream(&stream, &m, f);
        let mut acc = AllDrawsAcc::default();
        let stats = score_chunks(&stream, &tape, &m, None, &mut acc, None, &HashMap::new()).unwrap();
        assert_eq!(stats.frames_scored, u64::from(LAST_TICK) + 1);
        let _ = std::fs::remove_dir_all(&dir);
        acc.report()
    }

    #[test]
    fn a_client_drawing_the_truth_scores_zero_in_every_chunk_class() {
        let r = score_with(Faults { hide_on_retire: true, ..Default::default() });
        for class in ["chunk_intact", "chunk_debris", "chunk_rubble"] {
            let c = &r.classes[class];
            assert!(c.scored > 0.0, "{class} scored");
            assert!(c.pos_render_m.max < 1e-3, "{class} {:?}", c.pos_render_m);
            assert!(c.rot_render_deg.max < 0.1, "{class} {:?}", c.rot_render_deg);
            assert_eq!((c.missing, c.extra, c.wrong_identity), (0.0, 0.0, 0.0), "{class}");
        }
        // Intact: node 0 all 81 frames, nodes 1-2 until the promotion.
        assert_eq!(r.classes["chunk_intact"].scored, 81.0 + 2.0 * f64::from(ISLAND_TICK));
        // Debris while it streams, rubble once settled, gone after the retire.
        assert_eq!(r.classes["chunk_debris"].scored, 2.0 * f64::from(SETTLE_TICK - ISLAND_TICK));
        assert_eq!(r.classes["chunk_rubble"].scored, 2.0 * f64::from(RETIRE_TICK - SETTLE_TICK));
        // "Now" equals render time here (no delay), so it is zero too.
        assert!(r.overall.pos_now_m.max < 1e-3);
    }

    #[test]
    fn a_wrong_pose_is_detected_per_chunk_class() {
        let r = score_with(Faults { island_offset: 0.5, hide_on_retire: true, ..Default::default() });
        for class in ["chunk_debris", "chunk_rubble"] {
            let p = &r.classes[class].pos_render_m;
            assert!((p.p50 - 0.5).abs() < 0.05 && (p.max - 0.5).abs() < 1e-3, "{class} {p:?}");
        }
        assert!(r.classes["chunk_intact"].pos_render_m.max < 1e-3);
        let r = score_with(Faults { intact_offset: 0.25, hide_on_retire: true, ..Default::default() });
        let p = &r.classes["chunk_intact"].pos_render_m;
        assert!((p.p50 - 0.25).abs() < 0.03, "{p:?}");
        assert!(r.classes["chunk_debris"].pos_render_m.max < 1e-3);
    }

    #[test]
    fn missing_extra_and_wrong_identity_chunks_are_counted() {
        // Node 2 never gets its island record: drawn on the support body at
        // its rest pose while truth has it on the island.
        let r = score_with(Faults { drop_record: true, hide_on_retire: true, ..Default::default() });
        let debris = &r.classes["chunk_debris"];
        assert_eq!(debris.wrong_identity, f64::from(SETTLE_TICK - ISLAND_TICK));
        assert!(debris.pos_render_m.max > 0.5);
        // Kept drawn after truth retired the island: extra.
        let r = score_with(Faults::default());
        assert_eq!(r.classes["chunk_debris"].extra, 2.0 * f64::from(LAST_TICK + 1 - RETIRE_TICK));
        // Never drawn while truth has it standing: missing.
        let r = score_with(Faults { undrawn_intact: true, hide_on_retire: true, ..Default::default() });
        assert_eq!(r.classes["chunk_intact"].missing, f64::from(LAST_TICK + 1));
        // Drawn on a body truth never had.
        let r = score_with(Faults { wrong_key: true, hide_on_retire: true, ..Default::default() });
        assert_eq!(
            r.classes["chunk_debris"].wrong_identity + r.classes["chunk_rubble"].wrong_identity,
            f64::from(RETIRE_TICK - ISLAND_TICK)
        );
    }
}
