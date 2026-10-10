//! Convert a PhysX destruction recording (TWSTATE1) into a netlab city capture.
//!
//!   twstate-to-capture --twstate <file|-> --out <capture dir>
//!                      [--scene <scene pack.json>] [--density 1000]
//!                      [--frames N] [--region x0,z0,x1,z1] [--hz 60]
//!                      [--name <label>] [--source <what - was piped from>]
//!
//! `-` reads the recording from stdin, so a gzipped one streams through
//! `gzip -dc rec.twstate.gz | twstate-to-capture --twstate - ...`.
//!
//! The owner's large recordings (`native_destruction_demo`, `blast_stress_demo`
//! in the PhysX repo, demos/blast-stress-demo) hold up to 113,664 chunks and
//! ~97k bodies, far beyond the lab's live captures. A TWSTATE1 file is a
//! renderer's trajectory, not an encoder tape: per chunk (one visual actor per
//! chunk) it stores a world pose each recorded frame, delta-encoded, plus a
//! PhysX sleep bit, and nothing else -- no bonds, no body membership, no
//! fracture, settle or wake events (format: state_writer.cpp and the Rust
//! reader in recorder/src/state.rs). Everything the capture needs beyond the
//! poses is derived below by the rules listed here, each from physics or from
//! the recording's own authoring, and each counted in `conversion.json`.
//!
//! # Derivation rules
//!
//! **R1 Chunks.** The destructible chunks are the leading run of non-sphere
//! actors defined before the first frame. Both writers define every building
//! chunk first, then projectiles (spheres) and dust; nothing else is kept.
//! Each chunk's rest pose is its pose in frame 0, which the delta encoder
//! always writes in full.
//!
//! **R2 Bonds and supports (the manifest).** With `--scene`, from the scene
//! pack the recording was authored from: building `b` is actors
//! `[b*N, (b+1)*N)` of an `N`-node pack (`visualBases` in mini_city_main.cpp),
//! with its bonds, masses, volumes, colliders and zero-mass supports exactly as
//! authored. Without one, for cuboid chunks: two chunks are bonded when their
//! rest boxes are face-adjacent -- their extents overlap with positive length
//! on two axes and the gap between their faces on the third is less than half
//! the thinner box along that axis (nothing of either box could fit in it).
//! On a regular lattice this is exactly the authoring of
//! native_destruction_main.cpp (unit cells of half 0.48, bonded to the six
//! face neighbours). The bond's area is the overlap of the two faces, its
//! centroid the patch centre, its normal the axis from node0 to node1. Mass is
//! `--density` x box volume (1000 kg/m^3 is native_destruction_main.cpp's
//! `massPerChunk`), and the support chunks are the bottom layer: a chunk whose
//! rest bottom face is within that same half-thickness gap of the lowest
//! chunk bottom in the scene (the ground). As authored, supports are massless.
//!
//! **R3 Structures.** The wire ids give eight bits to a structure (at most 255,
//! ids.rs) and sixteen to a node. A building is one connected component of the
//! rest bond graph (one scene-pack instance with `--scene`). Structures are as
//! fine as that id space allows, as in production, where one building is one
//! structure: if there are more than 254 buildings, buildings are grouped into
//! k x k tiles of the city grid (columns and rows from the building centres),
//! k the smallest that fits. Every structure is at the world origin with
//! identity rotation, so a chunk's manifest centroid is its rest world position.
//!
//! **R4 Bond failure (fracture).** Chunks joined by an intact bond belong to
//! one rigid body and keep their rest relative transform exactly, up to the
//! f32 rounding of the recording. So a bond is broken at the first recorded
//! frame in which either chunk, carried by the other's rigid motion
//! (`p_j' = p_i + R_i (p_j0 - p_i0)` and the reverse), misses its recorded
//! position by more than the rounding bound `TOL_ULPS` f32 units in the last
//! place of the coordinates involved (see `bond_tolerance`). Once broken a
//! bond stays broken. The fracture is therefore dated to when the separation
//! first becomes observable: a piece that breaks and stays put rigidly against
//! its old neighbours is, in the recording, indistinguishable from intact and
//! is kept intact until it moves. `conversion.json` records the largest
//! residual each still-intact bond ever showed (`intact_bond_peak_ratio`), so
//! the margin over the rounding noise is measured on every conversion.
//!
//! **R5 Islands (bodies).** An island is a connected component of the intact
//! bonds that holds no support; a component with a support is the standing
//! (anchored) structure, never streamed -- the derivation `derive-check`
//! checks clients against. Since bonds only break, components only split.
//! When an island splits, its largest child (most chunks, then lowest node)
//! keeps the island's serial, as the physics keeps the parent actor for one
//! child; every other child is promoted with a new serial. Children leaving
//! the anchored structure are promoted. A body's wire pose is its centre-of-
//! mass frame (destruction_backend.rs `IslandPromotion`): rotation
//! `R = q_ref q_ref0^-1` from its lowest chunk, position the mass-weighted mean
//! of its chunks' recorded positions, the same weights the client's
//! `restCentreOfMassOf` uses (massless supports excluded, plain mean if no
//! mass), which for a rigid body is exactly its centre of mass.
//!
//! **R6 Removed chunks.** A chunk the recording parks at (0, -10000, 0)
//! (`kRetiredVisualDepth`, mini_city_main.cpp: crushed to dust) is removed:
//! its bonds break, it joins no island, and the island it left is retired and
//! its remaining children re-promoted, so no node list keeps it. A crushed
//! chunk still in its standing structure is promoted as a one-chunk island
//! and retired in the same batch (production's crush), so the tape's
//! membership drops it too. derive-check reports these as removed components.
//!
//! **R7 Velocities and the tick clock.** Velocities are central differences of
//! the island pose over the neighbouring recorded frames (exact for the
//! constant-acceleration motion of free fall), one-sided where the island did
//! not yet or no longer exist rigidly. The tape runs at `--hz` (60, the
//! production rate). A 30 fps recording gets one tick between frames: position
//! by cubic Hermite interpolation with those velocities (exact for free fall),
//! rotation by slerp (exact at constant angular velocity). Topology detected
//! at a frame is placed on that in-between tick, the midpoint of the interval
//! in which it happened; the new islands' poses there interpolate between
//! their poses at the two frames, both well defined because a child moved
//! rigidly with its parent until the split.
//!
//! **R8 Settle and wake.** An island is at rest in a frame when PhysX reports
//! every one of its chunks asleep, or when its speed is below production's
//! settle floors (settle.rs `SettleConfig::validated`: 0.05 m/s, 0.1 rad/s).
//! It settles (a `SettleEvent` with its pose, and no more snapshots) at once on
//! PhysX sleep, else after production's quiet period of `hz/2` ticks at rest.
//! Production's 5 s force-sleep deadline is not applied: it is a command to the
//! engine, which a recording cannot obey. A settled island wakes (a wake event
//! and `FLAG_WAKE_EVENT` on its snapshot) when it is no longer at rest or when
//! it loses chunks to a fracture. A body the floors settled while PhysX kept
//! it awake can creep while parked; how far (the jump in the truth at its
//! wake) is reported as `wake_jump_after_floor_settle_m`. Snapshots carry
//! every awake island each
//! tick, as the native runtime streams them; `contacts` is 0 as there
//! (not reported).
//!
//! # Not converted
//!
//! Projectiles and dust are not chunks and are not streamed; each projectile's
//! first appearance is written to `events.jsonl`. There are no recorded
//! players, so `cameras.jsonl` is empty and the lab generates its cameras.
//! The capture starts at tick 1 with the intact city, so it needs no encoder
//! checkpoint; `--frames` cuts the end, `--region` keeps the buildings whose
//! centre is inside it.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};

use glam::{DQuat, DVec3};

use vibe_land_destruction::encoder::BodySnapshotInput;
use vibe_land_destruction::ids;
use vibe_land_destruction::manifest::{
    BondDef, ChunkDef, ChunkGeometry, DestructionManifest, StructureManifest, MANIFEST_VERSION,
};
use vibe_land_destruction::netlab::capture::{
    self, CaptureMeta, TickStats, CAMERAS_FILE, EVENTS_FILE, MANIFEST_FILE, META_FILE, STATS_FILE,
    TAPE_FILE,
};
use vibe_land_destruction::netlab::tape::TapeWriter;
use vibe_land_destruction::types::FLAG_WAKE_EVENT;
use vibe_netcode::destruction_backend::{
    DestructionTickOutput, FractureBatch, IslandPromotion, SettleEvent,
};

/// mini_city_main.cpp `kRetiredVisualDepth`: where a crushed chunk's visual
/// is parked.
const RETIRED_VISUAL_DEPTH: f32 = -10_000.0;
/// settle.rs `SettleConfig::validated`: production's settle floors.
const SETTLE_LINEAR_FLOOR: f64 = 0.05;
const SETTLE_ANGULAR_FLOOR: f64 = 0.1;
/// Rounding bound of a recorded relative pose, in f32 ulps of the magnitudes
/// involved; see `bond_tolerance`.
const TOL_ULPS: f64 = 16.0;
const UNOWNED_ANCHORED: u32 = u32::MAX - 1;
const UNOWNED_REMOVED: u32 = u32::MAX;

type Result<T> = std::result::Result<T, String>;

// ── TWSTATE1 ────────────────────────────────────────────────────────────────

const RECORD_ACTOR: u8 = 1;
const RECORD_FRAME: u8 = 2;
const RECORD_END: u8 = 255;

#[derive(Clone, Debug)]
struct TwActor {
    /// 1 box, 2 sphere, 3 mesh (state_writer.h `VisualActor::Shape`).
    shape: u8,
    parameters: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
struct Update {
    id: u32,
    p: [f32; 3],
    q: [f32; 4],
    sleeping: bool,
}

struct TwReader {
    input: Box<dyn Read>,
    version: u32,
    fps: u32,
    declared_frames: u32,
    buildings: u32,
    actors: Vec<TwActor>,
    ended: bool,
}

impl TwReader {
    fn open(path: &str) -> Result<Self> {
        let input: Box<dyn Read> = if path == "-" {
            Box::new(BufReader::with_capacity(1 << 22, std::io::stdin()))
        } else {
            Box::new(BufReader::with_capacity(
                1 << 22,
                std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?,
            ))
        };
        let mut reader = Self {
            input,
            version: 0,
            fps: 0,
            declared_frames: 0,
            buildings: 0,
            actors: Vec::new(),
            ended: false,
        };
        let magic = reader.bytes::<8>()?;
        if &magic != b"TWSTATE1" {
            return Err(format!("{path} is not a TWSTATE1 recording"));
        }
        reader.version = reader.u32()?;
        if reader.version != 2 && reader.version != 3 {
            return Err(format!(
                "TWSTATE version {} unsupported (2 or 3: version 1 predates the sleep bit)",
                reader.version
            ));
        }
        reader.fps = reader.u32()?;
        reader.declared_frames = reader.u32()?;
        let _pane_w = reader.u32()?;
        let _pane_h = reader.u32()?;
        reader.buildings = reader.u32()?;
        let cameras = reader.u32()?;
        let _duration = reader.f32()?;
        let _settle = reader.f32()?;
        for _ in 0..cameras {
            for _ in 0..7 {
                reader.f32()?;
            }
        }
        Ok(reader)
    }

    fn bytes<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut buffer = [0u8; N];
        self.input.read_exact(&mut buffer).map_err(|e| format!("twstate read: {e}"))?;
        Ok(buffer)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes::<1>()?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }
    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.bytes::<4>()?))
    }
    fn skip(&mut self, mut n: u64) -> Result<()> {
        let mut buffer = [0u8; 4096];
        while n > 0 {
            let take = n.min(buffer.len() as u64) as usize;
            self.input.read_exact(&mut buffer[..take]).map_err(|e| format!("twstate read: {e}"))?;
            n -= take as u64;
        }
        Ok(())
    }

    fn read_actor(&mut self) -> Result<()> {
        let id = self.u32()? as usize;
        if id != self.actors.len() {
            return Err(format!("actor ids must be contiguous: got {id}, expected {}", self.actors.len()));
        }
        let _part = self.u8()?;
        let shapes = self.u32()?;
        let mut actor = TwActor { shape: 0, parameters: [0.0; 3] };
        for index in 0..shapes {
            let kind = self.u8()?;
            let parameters = [self.f32()?, self.f32()?, self.f32()?];
            for _ in 0..7 {
                self.f32()?; // local pose: identity in both writers
            }
            if kind == 3 {
                let vertices = self.u32()? as u64;
                self.skip(vertices * 24)?;
                let indices = self.u32()? as u64;
                self.skip(indices * 4)?;
            }
            if index == 0 {
                actor.shape = kind;
                actor.parameters = parameters;
            }
        }
        self.actors.push(actor);
        Ok(())
    }

    /// The next frame's updates; `None` at the end.
    fn next_frame(&mut self, updates: &mut Vec<Update>) -> Result<Option<u32>> {
        updates.clear();
        if self.ended {
            return Ok(None);
        }
        loop {
            let record = match self.u8() {
                Ok(r) => r,
                // A recording cut short (a killed run) ends without RECORD_END.
                Err(_) => {
                    self.ended = true;
                    return Ok(None);
                }
            };
            match record {
                RECORD_ACTOR => self.read_actor()?,
                RECORD_FRAME => {
                    let frame = self.u32()?;
                    let count = self.u32()?;
                    updates.reserve(count as usize);
                    for _ in 0..count {
                        let id = self.u32()?;
                        let p = [self.f32()?, self.f32()?, self.f32()?];
                        let q = [self.f32()?, self.f32()?, self.f32()?, self.f32()?];
                        let sleeping = self.u8()? != 0;
                        if self.version >= 3 {
                            self.u32()?;
                        }
                        updates.push(Update { id, p, q, sleeping });
                    }
                    return Ok(Some(frame));
                }
                RECORD_END => {
                    self.ended = true;
                    return Ok(None);
                }
                other => return Err(format!("unknown TWSTATE record {other}")),
            }
        }
    }
}

// ── geometry helpers ────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default)]
struct Pose {
    p: [f32; 3],
    q: [f32; 4],
    sleeping: bool,
}

impl Pose {
    fn dp(&self) -> DVec3 {
        DVec3::new(self.p[0] as f64, self.p[1] as f64, self.p[2] as f64)
    }
    fn dq(&self) -> DQuat {
        DQuat::from_xyzw(self.q[0] as f64, self.q[1] as f64, self.q[2] as f64, self.q[3] as f64)
            .normalize()
    }
}

fn ulp(x: f64) -> f64 {
    let x = (x.abs() as f32).max(f32::MIN_POSITIVE);
    (f32::from_bits(x.to_bits() + 1) - x) as f64
}

/// The largest disagreement f32 rounding can put between two chunks of one
/// rigid body. The writer forms each chunk's pose as `body ∘ local` in f32
/// (`pose*PxTransform(position)`, native_destruction_main.cpp; the shape
/// global pose in the Blast adapter): each component is rounded once per
/// operation of a quaternion rotate and an add, a handful of roundings of at
/// most half an ulp of the magnitudes involved -- the chunk positions and the
/// lever between the chunks -- and the quaternion itself is unit only to a few
/// ulps. `TOL_ULPS` ulps of the larger magnitude bounds that sum with margin;
/// at 250 m it is 0.24 mm, three orders of magnitude below anything a viewer
/// could see, and a separating piece crosses it within a frame.
fn bond_tolerance(pi: DVec3, pj: DVec3, lever: f64) -> f64 {
    let magnitude = pi.abs().max_element().max(pj.abs().max_element()).max(lever);
    TOL_ULPS * ulp(magnitude)
}

/// How far the rigid motion of `i` misses `j` (and vice versa), metres.
fn bond_residual(rest_i: &Pose, rest_j: &Pose, now_i: &Pose, now_j: &Pose) -> (f64, f64) {
    let (ri, rj) = (rest_i.dp(), rest_j.dp());
    let (ni, nj) = (now_i.dp(), now_j.dp());
    let rot_i = now_i.dq() * rest_i.dq().inverse();
    let rot_j = now_j.dq() * rest_j.dq().inverse();
    let ij = (nj - (ni + rot_i * (rj - ri))).length();
    let ji = (ni - (nj + rot_j * (ri - rj))).length();
    let tolerance = bond_tolerance(ni, nj, (rj - ri).length());
    (ij.max(ji), tolerance)
}

/// World AABB of a box with half extents `h` rotated by `q`.
fn box_aabb(center: DVec3, q: DQuat, h: [f32; 3]) -> (DVec3, DVec3) {
    let m = glam::DMat3::from_quat(q);
    let half = DVec3::new(h[0] as f64, h[1] as f64, h[2] as f64);
    let extent = DVec3::new(
        m.x_axis.x.abs() * half.x + m.y_axis.x.abs() * half.y + m.z_axis.x.abs() * half.z,
        m.x_axis.y.abs() * half.x + m.y_axis.y.abs() * half.y + m.z_axis.y.abs() * half.z,
        m.x_axis.z.abs() * half.x + m.y_axis.z.abs() * half.y + m.z_axis.z.abs() * half.z,
    );
    (center - extent, center + extent)
}

// ── union-find ──────────────────────────────────────────────────────────────

struct Dsu(Vec<u32>);
impl Dsu {
    fn new(n: usize) -> Self {
        Self((0..n as u32).collect())
    }
    fn find(&mut self, mut x: u32) -> u32 {
        while self.0[x as usize] != x {
            let parent = self.0[x as usize];
            self.0[x as usize] = self.0[parent as usize];
            x = parent;
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            let (lo, hi) = (a.min(b), a.max(b));
            self.0[hi as usize] = lo;
        }
    }
}

// ── the authored city (manifest side) ───────────────────────────────────────

struct Chunk {
    structure: u32,
    /// Node index within its structure.
    node: u32,
    rest: Pose,
    mass: f64,
    support: bool,
}

struct Bond {
    a: u32,
    b: u32,
    structure: u32,
    index: u32,
    /// Frame the bond broke at; `u32::MAX` while intact.
    broken_frame: u32,
}

struct ChunkGeom {
    volume: f32,
    size: [f32; 3],
    geometry: ChunkGeometry,
    radius: f32,
    mass: f32,
    support: bool,
}

struct Authored {
    /// Buildings as lists of chunk-candidate indices (into the leading chunk
    /// actors).
    buildings: Vec<Vec<u32>>,
    geoms: Vec<ChunkGeom>,
    /// (a, b, area, centroid, normal) over chunk-candidate indices.
    bonds: Vec<(u32, u32, f32, [f32; 3], [f32; 3])>,
    source: String,
}

/// The fields of a blast-stress-solver scene pack (v1-v3, `scenario`) this
/// converter needs. Read directly: the crate's `scene_pack` parser stops at
/// v2, and the reference packs the recordings were made from are v3 (v3 adds
/// crush laws, which a recording has already applied).
struct PackNode {
    centroid: DVec3,
    mass: f32,
    volume: f32,
    size: [f32; 3],
    geometry: ChunkGeometry,
    radius: f32,
}

struct PackBond {
    node0: u32,
    node1: u32,
    centroid: DVec3,
    normal: [f32; 3],
    area: f32,
}

fn load_pack(path: &Path) -> Result<(Vec<PackNode>, Vec<PackBond>)> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let root: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let scenario = root.get("scenario").unwrap_or(&root);
    let vec3 = |v: &serde_json::Value| -> DVec3 {
        DVec3::new(
            v["x"].as_f64().unwrap_or(0.0),
            v["y"].as_f64().unwrap_or(0.0),
            v["z"].as_f64().unwrap_or(0.0),
        )
    };
    let empty = Vec::new();
    let nodes_json = scenario["nodes"].as_array().ok_or("scene pack has no scenario.nodes")?;
    let sizes = scenario["nodeSizes"].as_array().unwrap_or(&empty);
    let colliders = scenario["nodeColliders"].as_array().unwrap_or(&empty);
    let mut nodes = Vec::new();
    for (i, node) in nodes_json.iter().enumerate() {
        let size = sizes.get(i).map(vec3).unwrap_or(DVec3::ONE);
        let collider = colliders.get(i);
        let (geometry, radius) = match collider.and_then(|c| c["kind"].as_str()) {
            Some("cuboid") | None => {
                let half = collider.map(|c| vec3(&c["halfExtents"])).unwrap_or(size * 0.5);
                (ChunkGeometry::Cuboid { half_extents: half.as_vec3().to_array() }, half.length() as f32)
            }
            Some(other) => return Err(format!("node {i}: collider kind {other} is not supported")),
        };
        nodes.push(PackNode {
            centroid: vec3(&node["centroid"]),
            mass: node["mass"].as_f64().unwrap_or(0.0) as f32,
            volume: node["volume"].as_f64().unwrap_or(0.0) as f32,
            size: size.as_vec3().to_array(),
            geometry,
            radius,
        });
    }
    let mut bonds = Vec::new();
    for bond in scenario["bonds"].as_array().ok_or("scene pack has no scenario.bonds")? {
        bonds.push(PackBond {
            node0: bond["node0"].as_u64().ok_or("bond without node0")? as u32,
            node1: bond["node1"].as_u64().ok_or("bond without node1")? as u32,
            centroid: vec3(&bond["centroid"]),
            normal: vec3(&bond["normal"]).as_vec3().to_array(),
            area: bond["area"].as_f64().unwrap_or(0.0) as f32,
        });
    }
    Ok((nodes, bonds))
}

fn author_from_scene(path: &Path, rest: &[Pose]) -> Result<(Authored, f64)> {
    let (pack, pack_bonds) = load_pack(path)?;
    let n = pack.len();
    if n == 0 || rest.len() % n != 0 {
        return Err(format!("{} chunk actors is not a multiple of the pack's {n} nodes", rest.len()));
    }
    let buildings: Vec<Vec<u32>> =
        (0..rest.len() / n).map(|b| ((b * n) as u32..((b + 1) * n) as u32).collect()).collect();
    let mut geoms = Vec::with_capacity(rest.len());
    let mut offsets = Vec::with_capacity(buildings.len());
    let mut worst_fit = 0.0f64;
    for building in &buildings {
        // The building's offset: rest pose minus authored centroid, averaged;
        // the fit is how far any chunk sits from its authored place.
        let mut offset = DVec3::ZERO;
        for (node, &chunk) in building.iter().enumerate() {
            offset += rest[chunk as usize].dp() - pack[node].centroid;
        }
        offset /= n as f64;
        offsets.push(offset);
        for (node, &chunk) in building.iter().enumerate() {
            let fit = (rest[chunk as usize].dp() - pack[node].centroid - offset).length();
            worst_fit = worst_fit.max(fit);
            let p = &pack[node];
            geoms.push(ChunkGeom {
                volume: p.volume,
                size: p.size,
                geometry: p.geometry.clone(),
                radius: p.radius,
                mass: p.mass,
                support: p.mass == 0.0,
            });
        }
    }
    let mut bonds = Vec::new();
    for (building, offset) in buildings.iter().zip(&offsets) {
        for bond in &pack_bonds {
            bonds.push((
                building[bond.node0 as usize],
                building[bond.node1 as usize],
                bond.area,
                (bond.centroid + *offset).as_vec3().to_array(),
                bond.normal,
            ));
        }
    }
    Ok((Authored { buildings, geoms, bonds, source: format!("scene pack {}", path.display()) }, worst_fit))
}

fn author_from_geometry(actors: &[TwActor], rest: &[Pose], density: f64) -> Result<Authored> {
    let mut boxes = Vec::with_capacity(rest.len());
    for (i, pose) in rest.iter().enumerate() {
        let actor = &actors[i];
        if actor.shape != 1 {
            return Err(format!(
                "chunk actor {i} is not a box (shape {}): a non-cuboid recording needs --scene",
                actor.shape
            ));
        }
        boxes.push(box_aabb(pose.dp(), pose.dq(), actor.parameters));
    }
    // Spatial hash on the largest box size: every face neighbour shares a cell
    // or a neighbouring cell.
    let cell = boxes.iter().map(|(lo, hi)| (*hi - *lo).max_element()).fold(0.0f64, f64::max).max(1e-3);
    let key = |p: DVec3| ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64, (p.z / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();
    for (i, (lo, hi)) in boxes.iter().enumerate() {
        grid.entry(key((*lo + *hi) * 0.5)).or_default().push(i as u32);
    }
    let mut bonds = Vec::new();
    for (i, (lo_i, hi_i)) in boxes.iter().enumerate() {
        let (cx, cy, cz) = key((*lo_i + *hi_i) * 0.5);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(list) = grid.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                    for &j in list {
                        if j as usize <= i {
                            continue;
                        }
                        let (lo_j, hi_j) = boxes[j as usize];
                        // Per axis: >0 overlap length, <0 gap between faces.
                        let overlap = hi_i.min(hi_j) - lo_i.max(lo_j);
                        let thin = (*hi_i - *lo_i).min(hi_j - lo_j) * 0.5;
                        // The contact axis is the one of least overlap; the
                        // others must overlap with positive length, and the
                        // gap (or interpenetration) along it must be under
                        // half the thinner box.
                        let axis = (0..3).min_by(|&a, &b| overlap[a].total_cmp(&overlap[b])).expect("three axes");
                        let others: Vec<usize> = (0..3).filter(|&b| b != axis).collect();
                        if others.iter().any(|&b| overlap[b] <= 0.0) || overlap[axis].abs() >= thin[axis] {
                            continue;
                        }
                        let area = (overlap[others[0]] * overlap[others[1]]) as f32;
                        let (ci, cj) = ((*lo_i + *hi_i) * 0.5, (lo_j + hi_j) * 0.5);
                        let mut centroid = DVec3::ZERO;
                        for &b in &others {
                            centroid[b] = (hi_i[b].min(hi_j[b]) + lo_i[b].max(lo_j[b])) * 0.5;
                        }
                        centroid[axis] = (ci[axis] + cj[axis]) * 0.5;
                        let mut normal = [0.0f32; 3];
                        normal[axis] = if cj[axis] > ci[axis] { 1.0 } else { -1.0 };
                        bonds.push((i as u32, j, area, centroid.as_vec3().to_array(), normal));
                    }
                }
            }
        }
    }
    // Buildings: components of the rest bond graph.
    let mut dsu = Dsu::new(rest.len());
    for &(a, b, ..) in &bonds {
        dsu.union(a, b);
    }
    let mut by_root: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for i in 0..rest.len() as u32 {
        let root = dsu.find(i);
        by_root.entry(root).or_default().push(i);
    }
    let buildings: Vec<Vec<u32>> = by_root.into_values().collect();
    // Supports: the bottom layer, against the scene's lowest chunk bottom.
    let ground = boxes.iter().map(|(lo, _)| lo.y).fold(f64::INFINITY, f64::min);
    let geoms = rest
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let h = actors[i].parameters;
            let (lo, hi) = boxes[i];
            let support = lo.y - ground < (hi.y - lo.y) * 0.5;
            let volume = 8.0 * h[0] * h[1] * h[2];
            ChunkGeom {
                volume,
                size: [2.0 * h[0], 2.0 * h[1], 2.0 * h[2]],
                geometry: ChunkGeometry::Cuboid { half_extents: h },
                radius: (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt(),
                mass: if support { 0.0 } else { (density * volume as f64) as f32 },
                support,
            }
        })
        .collect();
    Ok(Authored { buildings, geoms, bonds, source: "face-adjacent boxes".into() })
}

/// Group buildings into at most 254 structures (R3).
fn group_structures(buildings: &[Vec<u32>], rest: &[Pose]) -> (Vec<Vec<usize>>, u32) {
    if buildings.len() <= 254 {
        return ((0..buildings.len()).map(|b| vec![b]).collect(), 1);
    }
    let centres: Vec<DVec3> = buildings
        .iter()
        .map(|b| b.iter().map(|&c| rest[c as usize].dp()).sum::<DVec3>() / b.len() as f64)
        .collect();
    let extents: Vec<f64> = buildings
        .iter()
        .zip(&centres)
        .map(|(b, c)| {
            b.iter()
                .map(|&i| {
                    let d = rest[i as usize].dp() - *c;
                    d.x.abs().max(d.z.abs())
                })
                .fold(0.0, f64::max)
        })
        .collect();
    let half = extents.iter().copied().fold(0.0, f64::max).max(1e-3);
    // Columns and rows: building centres closer than a building half-width
    // along an axis are in the same column/row.
    let rank = |axis: fn(&DVec3) -> f64| -> Vec<u32> {
        let mut order: Vec<usize> = (0..centres.len()).collect();
        order.sort_by(|&a, &b| axis(&centres[a]).total_cmp(&axis(&centres[b])));
        let mut ranks = vec![0u32; centres.len()];
        let mut current = 0u32;
        let mut last = f64::NEG_INFINITY;
        for (n, &i) in order.iter().enumerate() {
            let v = axis(&centres[i]);
            if n > 0 && v - last > half {
                current += 1;
            }
            last = v;
            ranks[i] = current;
        }
        ranks
    };
    let cols = rank(|c| c.x);
    let rows = rank(|c| c.z);
    let (nc, nr) = (cols.iter().max().unwrap() + 1, rows.iter().max().unwrap() + 1);
    let max_nodes = buildings.iter().map(Vec::len).max().unwrap_or(1) as u32;
    let mut k = 1u32;
    while nc.div_ceil(k) * nr.div_ceil(k) > 254 {
        k += 1;
    }
    assert!(k * k * max_nodes < ids::MAX_NODES_PER_STRUCTURE, "tile of {k}x{k} buildings exceeds the node id space");
    let mut tiles: BTreeMap<(u32, u32), Vec<usize>> = BTreeMap::new();
    for b in 0..buildings.len() {
        tiles.entry((rows[b] / k, cols[b] / k)).or_default().push(b);
    }
    (tiles.into_values().collect(), k)
}

// ── islands ─────────────────────────────────────────────────────────────────

struct Island {
    structure: u32,
    serial: u32,
    /// Global chunk indices, ascending by node.
    chunks: Vec<u32>,
    reference: u32,
    weights: Vec<f64>,
    weight_sum: f64,
    settled: bool,
    quiet_ticks: u32,
    /// Where it settled, and whether PhysX put it to sleep (else the floors).
    settle_pose: DVec3,
    settled_by_physx: bool,
}

#[derive(Clone, Copy, Debug)]
struct IslandMotion {
    p: DVec3,
    q: DQuat,
    v: DVec3,
    w: DVec3,
}

struct Frames {
    /// Ring of the last four recorded frames' chunk poses: frame g at g % 4.
    ring: [Vec<Pose>; 4],
    /// Last frame each chunk's pose was written.
    changed: Vec<u32>,
}

impl Frames {
    fn at(&self, frame: u32) -> &Vec<Pose> {
        &self.ring[(frame % 4) as usize]
    }
}

fn island_pose(island: &Island, poses: &[Pose], rest: &[Pose]) -> (DVec3, DQuat) {
    let reference = island.reference as usize;
    let q = (poses[reference].dq() * rest[reference].dq().inverse()).normalize();
    let mut p = DVec3::ZERO;
    for (&chunk, &w) in island.chunks.iter().zip(&island.weights) {
        p += poses[chunk as usize].dp() * w;
    }
    (p / island.weight_sum, q)
}

fn angular_velocity(q0: DQuat, q1: DQuat, dt: f64) -> DVec3 {
    let mut d = (q1 * q0.inverse()).normalize();
    if d.w < 0.0 {
        d = -d;
    }
    let (axis, angle) = d.to_axis_angle();
    if angle.is_finite() && angle > 0.0 {
        axis * (angle / dt)
    } else {
        DVec3::ZERO
    }
}

fn slerp_half(q0: DQuat, q1: DQuat) -> DQuat {
    let q1 = if q0.dot(q1) < 0.0 { -q1 } else { q1 };
    q0.slerp(q1, 0.5).normalize()
}

fn f3(v: DVec3) -> [f32; 3] {
    [v.x as f32, v.y as f32, v.z as f32]
}
fn f4(q: DQuat) -> [f32; 4] {
    [q.x as f32, q.y as f32, q.z as f32, q.w as f32]
}

// ── the converter ───────────────────────────────────────────────────────────

struct Options {
    twstate: String,
    out: PathBuf,
    scene: Option<PathBuf>,
    density: f64,
    frames: Option<u32>,
    region: Option<[f64; 4]>,
    hz: u32,
    name: String,
    /// What `--twstate -` was piped from, for the metadata.
    source: Option<String>,
}

fn parse_args() -> Options {
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let twstate = value("--twstate").unwrap_or_else(|| usage());
    let out = PathBuf::from(value("--out").unwrap_or_else(|| usage()));
    let region = value("--region").map(|r| {
        let v: Vec<f64> = r.split(',').map(|x| x.parse().expect("--region x0,z0,x1,z1")).collect();
        assert_eq!(v.len(), 4, "--region x0,z0,x1,z1");
        [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])]
    });
    Options {
        name: value("--name").unwrap_or_else(|| {
            out.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        }),
        twstate,
        out,
        scene: value("--scene").map(PathBuf::from),
        density: value("--density").map(|d| d.parse().expect("--density")).unwrap_or(1000.0),
        frames: value("--frames").map(|f| f.parse().expect("--frames")),
        region,
        hz: value("--hz").map(|h| h.parse().expect("--hz")).unwrap_or(60),
        source: value("--source"),
    }
}

fn usage() -> ! {
    eprintln!("twstate-to-capture --twstate <file|-> --out <dir> [--scene pack.json] [--density 1000] [--frames N] [--region x0,z0,x1,z1] [--hz 60] [--name label] [--source <path piped in>]");
    std::process::exit(2);
}

#[derive(Default, serde::Serialize)]
struct Report {
    source: String,
    authoring: String,
    twstate_version: u32,
    fps: u32,
    hz: u32,
    ticks_per_frame: u32,
    declared_frames: u32,
    frames_converted: u32,
    ticks: u32,
    chunk_actors: usize,
    chunks: usize,
    buildings: usize,
    structures: usize,
    tile_buildings: u32,
    bonds: usize,
    support_chunks: usize,
    scene_fit_max_m: f64,
    region: Option<[f64; 4]>,
    bonds_broken: u64,
    promotions: u64,
    retirements: u64,
    settles: u64,
    settles_physx_sleep: u64,
    wakes: u64,
    removed_chunks: u64,
    support_chunks_moved: u64,
    peak_awake: usize,
    /// How far an island had drifted from its settle pose by the frame before
    /// it woke (the jump in the truth at the wake), m:
    /// [p50, p99, max, count], after a PhysX sleep and after the floors.
    wake_jump_after_physx_sleep_m: [f64; 4],
    wake_jump_after_floor_settle_m: [f64; 4],
    peak_live_islands: usize,
    live_islands_at_end: usize,
    snapshots_total: u64,
    projectiles: u64,
    /// Every bond evaluation, intact or not, by residual over its tolerance:
    /// key = floor(log2(residual / tolerance)) (>= 0 broke the bond), with
    /// residual 0 under "zero".
    residual_histogram: BTreeMap<String, u64>,
    /// Largest residual among evaluations that stayed under tolerance, and the
    /// smallest that broke a bond.
    max_intact_residual_m: f64,
    min_breaking_residual_m: f64,
    /// Bonds intact at the end, by the largest residual/tolerance they ever
    /// showed (floor log2): the noise floor the tolerance must clear.
    intact_bond_peak_ratio: BTreeMap<String, u64>,
    tol_ulps: f64,
    rules: Vec<&'static str>,
}

fn main() {
    if let Err(error) = run(parse_args()) {
        eprintln!("twstate-to-capture: {error}");
        std::process::exit(1);
    }
}

fn run(options: Options) -> Result<()> {
    let started = std::time::Instant::now();
    let mut reader = TwReader::open(&options.twstate)?;
    let mut updates = Vec::new();
    let first = reader.next_frame(&mut updates)?.ok_or("recording has no frames")?;
    if first != 0 {
        return Err(format!("first frame is {first}, expected 0"));
    }
    // R1: the leading run of non-sphere actors.
    let chunk_actors = reader.actors.iter().take_while(|a| a.shape != 2).count();
    let mut rest_all = vec![Pose::default(); chunk_actors];
    let mut seen = vec![false; chunk_actors];
    for u in &updates {
        if (u.id as usize) < chunk_actors {
            rest_all[u.id as usize] = Pose { p: u.p, q: u.q, sleeping: u.sleeping };
            seen[u.id as usize] = true;
        }
    }
    if let Some(missing) = seen.iter().position(|s| !s) {
        return Err(format!("frame 0 has no pose for chunk actor {missing}"));
    }
    let fps = reader.fps;
    if options.hz % fps != 0 {
        return Err(format!("--hz {} is not a multiple of the recording's {fps} fps", options.hz));
    }
    let u = options.hz / fps;
    if u > 2 {
        return Err(format!("{fps} fps to {} Hz: only one in-between tick is supported", options.hz));
    }
    eprintln!(
        "twstate v{} {} fps, {} frames declared, {} buildings, {} chunk actors ({} actors)",
        reader.version, fps, reader.declared_frames, reader.buildings, chunk_actors, reader.actors.len()
    );

    // R2: the authored graph.
    let mut scene_fit = 0.0;
    let authored = match &options.scene {
        Some(path) => {
            let (authored, fit) = author_from_scene(path, &rest_all)?;
            scene_fit = fit;
            authored
        }
        None => author_from_geometry(&reader.actors[..chunk_actors], &rest_all, options.density)?,
    };
    // Region cut: buildings whose centre lies inside.
    let mut buildings: Vec<Vec<u32>> = authored.buildings.clone();
    if let Some([x0, z0, x1, z1]) = options.region {
        buildings.retain(|b| {
            let c = b.iter().map(|&i| rest_all[i as usize].dp()).sum::<DVec3>() / b.len() as f64;
            c.x >= x0 && c.x <= x1 && c.z >= z0 && c.z <= z1
        });
    }
    let (structures, tile) = group_structures(&buildings, &rest_all);
    eprintln!(
        "authored ({}): {} buildings, {} bonds; {} structures of up to {t}x{t} buildings",
        authored.source,
        buildings.len(),
        authored.bonds.len(),
        structures.len(),
        t = tile
    );

    // Global chunk table, structure-major.
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut chunk_of_actor: Vec<u32> = vec![u32::MAX; chunk_actors];
    let mut manifest_structures = Vec::new();
    for (sid, members) in structures.iter().enumerate() {
        let sid = sid as u32;
        let mut defs = Vec::new();
        for &b in members {
            for &candidate in &buildings[b] {
                let node = defs.len() as u32;
                let g = &authored.geoms[candidate as usize];
                let rest = rest_all[candidate as usize];
                chunk_of_actor[candidate as usize] = chunks.len() as u32;
                chunks.push(Chunk {
                    structure: sid,
                    node,
                    rest,
                    mass: g.mass as f64,
                    support: g.support,
                });
                defs.push(ChunkDef {
                    node_index: node,
                    centroid: rest.p,
                    mass: g.mass,
                    volume: g.volume,
                    size: g.size,
                    geometry: g.geometry.clone(),
                    radius: g.radius,
                    support: g.support,
                    material: 0,
                    mass_offset: [0.0; 3],
                });
            }
        }
        manifest_structures.push(StructureManifest {
            structure_id: sid,
            world_position: [0.0; 3],
            world_rotation: [0.0, 0.0, 0.0, 1.0],
            chunks: defs,
            bonds: Vec::new(),
        });
    }
    let mut bonds: Vec<Bond> = Vec::new();
    for &(a, b, area, centroid, normal) in &authored.bonds {
        let (ga, gb) = (chunk_of_actor[a as usize], chunk_of_actor[b as usize]);
        if ga == u32::MAX || gb == u32::MAX {
            continue; // outside the region
        }
        let sid = chunks[ga as usize].structure;
        if chunks[gb as usize].structure != sid {
            return Err("a bond spans two structures".into());
        }
        let structure = &mut manifest_structures[sid as usize];
        let index = structure.bonds.len() as u32;
        structure.bonds.push(BondDef {
            bond_index: index,
            node0: chunks[ga as usize].node,
            node1: chunks[gb as usize].node,
            centroid,
            normal,
            area,
            material: 0,
        });
        bonds.push(Bond { a: ga, b: gb, structure: sid, index, broken_frame: u32::MAX });
    }
    for s in &manifest_structures {
        assert!((s.chunks.len() as u32) < ids::MAX_NODES_PER_STRUCTURE);
        assert!((s.bonds.len() as u32) < ids::MAX_BONDS_PER_STRUCTURE);
    }
    let manifest = DestructionManifest {
        version: MANIFEST_VERSION,
        structures: manifest_structures,
        materials: Vec::new(),
        material_appearance: Vec::new(),
        shape_library: Vec::new(),
    };
    let n = chunks.len();
    let mut adjacency: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (i, bond) in bonds.iter().enumerate() {
        adjacency[bond.a as usize].push(i as u32);
        adjacency[bond.b as usize].push(i as u32);
    }
    let rest: Vec<Pose> = chunks.iter().map(|c| c.rest).collect();
    let structure_chunks: Vec<std::ops::Range<u32>> = {
        let mut ranges = Vec::new();
        let mut start = 0u32;
        for s in &manifest.structures {
            ranges.push(start..start + s.chunks.len() as u32);
            start += s.chunks.len() as u32;
        }
        ranges
    };

    // Output.
    std::fs::create_dir_all(&options.out).map_err(|e| e.to_string())?;
    std::fs::write(options.out.join(MANIFEST_FILE), serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut tape = TapeWriter::create_zstd(
        &options.out.join(TAPE_FILE),
        options.hz,
        manifest.hash(),
        capture::overview_camera(&manifest),
    )
    .map_err(|e| e.to_string())?;
    let mut stats_out = std::io::BufWriter::new(
        std::fs::File::create(options.out.join(STATS_FILE)).map_err(|e| e.to_string())?,
    );
    let mut events_out = std::io::BufWriter::new(
        std::fs::File::create(options.out.join(EVENTS_FILE)).map_err(|e| e.to_string())?,
    );
    std::fs::File::create(options.out.join(CAMERAS_FILE)).map_err(|e| e.to_string())?;

    let mut report = Report {
        source: options.source.clone().unwrap_or_else(|| options.twstate.clone()),
        authoring: authored.source.clone(),
        twstate_version: reader.version,
        fps,
        hz: options.hz,
        ticks_per_frame: u,
        declared_frames: reader.declared_frames,
        chunk_actors,
        chunks: n,
        buildings: buildings.len(),
        structures: manifest.structures.len(),
        tile_buildings: tile,
        bonds: bonds.len(),
        support_chunks: chunks.iter().filter(|c| c.support).count(),
        scene_fit_max_m: scene_fit,
        region: options.region,
        min_breaking_residual_m: f64::INFINITY,
        tol_ulps: TOL_ULPS,
        rules: vec![
            "R1 chunks: leading non-sphere actors; rest = frame 0",
            "R2 bonds/supports: scene pack, else face-adjacent boxes; supports = bottom layer, massless",
            "R3 structures: one building each, else k x k tiles, k minimal for 254 structures",
            "R4 bond breaks: rigid relative pose violated beyond TOL_ULPS f32 ulps",
            "R5 islands: components of intact bonds without support; largest child keeps serial",
            "R6 removed: chunks parked at y=-10000 (crushed)",
            "R7 velocities: central differences; Hermite/slerp in-between tick; topology at the interval midpoint",
            "R8 settle: PhysX sleep, or below 0.05 m/s and 0.1 rad/s for hz/2 ticks; wake on motion or split",
        ],
        ..Report::default()
    };

    // State.
    let mut frames = Frames {
        ring: [rest.clone(), rest.clone(), rest.clone(), rest.clone()],
        changed: vec![0; n],
    };
    let mut owner: Vec<u32> = vec![UNOWNED_ANCHORED; n];
    let mut peak_ratio: Vec<f32> = vec![0.0; bonds.len()];
    let mut wake_jumps: (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    // Frame each chunk was removed at (R6); `u32::MAX` while present.
    let mut removed: Vec<u32> = vec![u32::MAX; n];
    let mut islands: Vec<Option<Island>> = Vec::new();
    let mut free_slots: Vec<u32> = Vec::new();
    let mut next_serial: Vec<u32> = vec![1; manifest.structures.len()];
    // Per frame: broken bond ids and removed chunks, detected on read.
    let mut pending: BTreeMap<u32, (Vec<u32>, Vec<u32>)> = BTreeMap::new();
    let mut seen_projectiles: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let dt = 1.0 / fps as f64;
    let quiet_needed = options.hz / 2;
    let tick_of = |frame: u32| 1 + frame * u;

    // Tick 1: the intact city.
    tape.push(1, &[], &DestructionTickOutput::default()).map_err(|e| e.to_string())?;
    write_stats(&mut stats_out, 1, 0)?;
    let mut last_tick = 1u32;
    let mut ticks = 1u32;

    // Read frame g, detect its breaks; then emit frame g-1 (lookahead of one).
    let limit = options.frames.unwrap_or(u32::MAX);
    let mut read_frame = 0u32; // newest frame in the ring
    let mut emitted_through = 0u32;
    loop {
        let next = if read_frame + 1 < limit { reader.next_frame(&mut updates)? } else { None };
        let have_next = next.is_some();
        if let Some(frame) = next {
            if frame != read_frame + 1 {
                return Err(format!("frame {frame} follows {read_frame}"));
            }
            read_frame = frame;
            let (prev, cur) = ((frame + 3) % 4, frame % 4);
            let copy = frames.ring[prev as usize].clone();
            frames.ring[cur as usize] = copy;
            let mut broken_now = Vec::new();
            let mut removed_now = Vec::new();
            let mut dirty = Vec::new();
            for update in &updates {
                let id = update.id as usize;
                if id >= chunk_actors {
                    if reader.actors.get(id).is_some_and(|a| a.shape == 2) && seen_projectiles.insert(update.id) {
                        report.projectiles += 1;
                        let line = serde_json::json!({"kind": "projectile", "actor": update.id, "position": update.p, "tick": tick_of(frame)});
                        writeln!(events_out, "{line}").map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                let c = chunk_of_actor[id];
                if c == u32::MAX {
                    continue;
                }
                frames.ring[cur as usize][c as usize] =
                    Pose { p: update.p, q: update.q, sleeping: update.sleeping };
                frames.changed[c as usize] = frame;
                dirty.push(c);
                if removed[c as usize] == u32::MAX && update.p == [0.0, RETIRED_VISUAL_DEPTH, 0.0] {
                    removed[c as usize] = frame;
                    removed_now.push(c);
                    report.removed_chunks += 1;
                }
            }
            let now = &frames.ring[cur as usize];
            for &c in &dirty {
                for &b in &adjacency[c as usize] {
                    let bond = &bonds[b as usize];
                    if bond.broken_frame != u32::MAX {
                        continue;
                    }
                    let (a, bb) = (bond.a as usize, bond.b as usize);
                    let breaks = if removed[a] != u32::MAX || removed[bb] != u32::MAX {
                        true
                    } else {
                        let (residual, tolerance) = bond_residual(&rest[a], &rest[bb], &now[a], &now[bb]);
                        let bucket = if residual == 0.0 { "zero".to_string() } else { format!("{:+03}", (residual / tolerance).log2().floor() as i32) };
                        *report.residual_histogram.entry(bucket).or_default() += 1;
                        let ratio = (residual / tolerance) as f32;
                        if ratio > peak_ratio[b as usize] {
                            peak_ratio[b as usize] = ratio;
                        }
                        if residual > tolerance {
                            report.min_breaking_residual_m = report.min_breaking_residual_m.min(residual);
                            true
                        } else {
                            report.max_intact_residual_m = report.max_intact_residual_m.max(residual);
                            false
                        }
                    };
                    if breaks {
                        bonds[b as usize].broken_frame = frame;
                        broken_now.push(b);
                    }
                }
            }
            report.bonds_broken += broken_now.len() as u64;
            if !broken_now.is_empty() || !removed_now.is_empty() {
                pending.insert(frame, (broken_now, removed_now));
            }
        }
        // Emit frame f = read_frame - 1 (or read_frame at the end).
        let f = if have_next { read_frame - 1 } else { read_frame };
        if f > emitted_through || (!have_next && f == read_frame && emitted_through < f) {
            emit_frame(
                f,
                have_next,
                u,
                dt,
                quiet_needed,
                &chunks,
                &rest,
                &frames,
                &bonds,
                &structure_chunks,
                &mut owner,
                &removed,
                &mut islands,
                &mut free_slots,
                &mut next_serial,
                &mut pending,
                &mut tape,
                &mut stats_out,
                &mut report,
                &mut wake_jumps,
                &mut last_tick,
                &mut ticks,
            )?;
            emitted_through = f;
            if f % 60 == 0 {
                let live = islands.iter().filter(|i| i.is_some()).count();
                eprintln!(
                    "frame {f}: {} bonds broken, {live} islands, peak awake {}, {:.0}s",
                    report.bonds_broken,
                    report.peak_awake,
                    started.elapsed().as_secs_f64()
                );
            }
        }
        if !have_next {
            break;
        }
    }
    let written = tape.finish().map_err(|e| e.to_string())?;
    stats_out.flush().map_err(|e| e.to_string())?;
    events_out.flush().map_err(|e| e.to_string())?;
    report.frames_converted = emitted_through + 1;
    report.ticks = written;
    report.live_islands_at_end = islands.iter().filter(|i| i.is_some()).count();
    let summary = |v: &mut Vec<f64>| -> [f64; 4] {
        if v.is_empty() {
            return [0.0; 4];
        }
        v.sort_by(f64::total_cmp);
        let q = |x: f64| v[((v.len() as f64 * x) as usize).min(v.len() - 1)];
        [q(0.5), q(0.99), v[v.len() - 1], v.len() as f64]
    };
    report.wake_jump_after_physx_sleep_m = summary(&mut wake_jumps.0);
    report.wake_jump_after_floor_settle_m = summary(&mut wake_jumps.1);
    for (bond, &ratio) in bonds.iter().zip(&peak_ratio) {
        if bond.broken_frame == u32::MAX {
            let key = if ratio == 0.0 { "zero".to_string() } else { format!("{:+03}", ratio.log2().floor() as i32) };
            *report.intact_bond_peak_ratio.entry(key).or_default() += 1;
        }
    }
    report.support_chunks_moved = chunks
        .iter()
        .enumerate()
        .filter(|(i, c)| c.support && frames.changed[*i] > 0 && {
            let now = frames.at(emitted_through)[*i];
            (now.dp() - c.rest.dp()).length() > bond_tolerance(now.dp(), c.rest.dp(), 0.0)
        })
        .count() as u64;

    let meta = CaptureMeta {
        hz: options.hz,
        scene: options.name.clone(),
        backend: format!("twstate:{}", options.name),
        wire: 2,
        manifest_hash: manifest.hash_hex(),
        first_tick: Some(1),
        last_tick: Some(last_tick),
        ticks: written,
        dropped_ticks: 0,
        created_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        fingerprint: serde_json::json!({
            "converter": "twstate-to-capture",
            "source": options.source.clone().unwrap_or_else(|| options.twstate.clone()),
            "scene": options.scene.as_ref().map(|p| p.display().to_string()),
            "frames_limit": options.frames,
            "region": options.region,
            "git": git_head(),
        }),
    };
    std::fs::write(options.out.join(META_FILE), serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::write(
        options.out.join("conversion.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    eprintln!(
        "done in {:.0}s: {} ticks, {} bonds broken, {} promotions, {} settles, {} wakes, peak awake {}",
        started.elapsed().as_secs_f64(),
        written,
        report.bonds_broken,
        report.promotions,
        report.settles,
        report.wakes,
        report.peak_awake
    );
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    Ok(())
}

fn git_head() -> Option<String> {
    let out = std::process::Command::new("git").args(["rev-parse", "--short", "HEAD"]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn write_stats(out: &mut impl Write, tick: u32, awake: u32) -> Result<()> {
    let stats = TickStats { tick, awake, players: 0, ..TickStats::default() };
    let line = serde_json::to_string(&stats).map_err(|e| e.to_string())?;
    writeln!(out, "{line}").map_err(|e| e.to_string())
}

fn new_island(structure: u32, serial: u32, mut members: Vec<u32>, chunks: &[Chunk]) -> Island {
    members.sort_unstable_by_key(|&c| chunks[c as usize].node);
    let massive = members.iter().any(|&c| chunks[c as usize].mass > 0.0);
    let weights: Vec<f64> = members
        .iter()
        .map(|&c| if massive { chunks[c as usize].mass.max(0.0) } else { 1.0 })
        .collect();
    let weight_sum = weights.iter().sum();
    Island {
        structure,
        serial,
        reference: members[0],
        chunks: members,
        weights,
        weight_sum,
        settled: false,
        settle_pose: DVec3::ZERO,
        settled_by_physx: false,
        quiet_ticks: 0,
    }
}

/// One recorded frame's topology, settle/wake and snapshots, as one or two
/// ticks (R5-R8).
#[allow(clippy::too_many_arguments)]
fn emit_frame(
    f: u32,
    have_next: bool,
    u: u32,
    dt: f64,
    quiet_needed: u32,
    chunks: &[Chunk],
    rest: &[Pose],
    frames: &Frames,
    bonds: &[Bond],
    structure_chunks: &[std::ops::Range<u32>],
    owner: &mut [u32],
    removed: &[u32],
    islands: &mut Vec<Option<Island>>,
    free_slots: &mut Vec<u32>,
    next_serial: &mut [u32],
    pending: &mut BTreeMap<u32, (Vec<u32>, Vec<u32>)>,
    tape: &mut TapeWriter,
    stats_out: &mut impl Write,
    report: &mut Report,
    wake_jumps: &mut (Vec<f64>, Vec<f64>),
    last_tick: &mut u32,
    ticks: &mut u32,
) -> Result<()> {
    if f == 0 {
        return Ok(()); // rest frame: tick 1 already written
    }
    // ── topology (R5, R6) ──
    let (broken, removed_now) = pending.remove(&f).unwrap_or_default();
    let mut dirty_structures: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for &b in &broken {
        dirty_structures.entry(bonds[b as usize].structure).or_default().push(b);
    }
    for &c in &removed_now {
        dirty_structures.entry(chunks[c as usize].structure).or_default();
    }
    let mut batches: Vec<FractureBatch> = Vec::new();
    let mut woken_slots: Vec<u32> = Vec::new();
    let mut promoted_slots: Vec<u32> = Vec::new();
    // The intact bonds of each dirty structure at frame f. Breaks are detected
    // a frame ahead (on read), so a bond broken at f+1 is still intact here.
    let mut bonds_of_structure: HashMap<u32, Vec<u32>> = HashMap::new();
    if !dirty_structures.is_empty() {
        for (i, bond) in bonds.iter().enumerate() {
            if bond.broken_frame > f && dirty_structures.contains_key(&bond.structure) {
                bonds_of_structure.entry(bond.structure).or_default().push(i as u32);
            }
        }
    }
    for (&sid, broken_here) in &dirty_structures {
        let range = structure_chunks[sid as usize].clone();
        let base = range.start;
        let count = (range.end - range.start) as usize;
        let mut dsu = Dsu::new(count);
        for &b in bonds_of_structure.get(&sid).map(Vec::as_slice).unwrap_or(&[]) {
            let bond = &bonds[b as usize];
            dsu.union(bond.a - base, bond.b - base);
        }
        let mut components: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for local in 0..count as u32 {
            let global = base + local;
            if removed[global as usize] <= f {
                continue;
            }
            let root = dsu.find(local);
            components.entry(root).or_default().push(global);
        }
        // Children per previous owner.
        let mut by_owner: BTreeMap<u32, Vec<Vec<u32>>> = BTreeMap::new();
        for (_, members) in components {
            let o = owner[members[0] as usize];
            if members.iter().any(|&m| owner[m as usize] != o) {
                return Err(format!("structure {sid}: a component spans two owners (components only split)"));
            }
            by_owner.entry(o).or_default().push(members);
        }
        // Owners that lost a removed chunk.
        let mut lost_removed: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut crushed_standing: Vec<u32> = Vec::new();
        for &c in &removed_now {
            if chunks[c as usize].structure == sid {
                let o = owner[c as usize];
                lost_removed.insert(o);
                owner[c as usize] = UNOWNED_REMOVED;
                if o == UNOWNED_ANCHORED {
                    crushed_standing.push(c);
                }
                if o != UNOWNED_ANCHORED && o != UNOWNED_REMOVED && !by_owner.contains_key(&o) {
                    by_owner.insert(o, Vec::new()); // island fully removed
                }
            }
        }
        let mut batch = FractureBatch {
            structure_id: sid,
            broken_bond_ids: broken_here.iter().map(|&b| ids::bond_id(sid, bonds[b as usize].index)).collect(),
            ..FractureBatch::default()
        };
        // A crushed chunk still in its standing structure leaves it the way
        // production expresses a crush: promoted as a one-chunk island and
        // retired in the same batch (the ledger applies promotions, then
        // retires). Without it the tape keeps the chunk standing.
        for &c in &crushed_standing {
            let serial = next_serial[sid as usize];
            next_serial[sid as usize] += 1;
            assert!(serial < ids::MAX_ISLAND_SERIALS, "island serials exhausted");
            let chunk = &chunks[c as usize];
            batch.promoted_islands.push(IslandPromotion {
                structure_id: sid,
                island_id: serial,
                chunks: vec![ids::chunk_id(sid, chunk.node)],
                mass: chunk.mass as f32,
                center_of_mass: chunk.rest.p,
                inertia_diagonal: [0.0; 3],
                position: chunk.rest.p,
                rotation: chunk.rest.q,
                linear_velocity: [0.0; 3],
                angular_velocity: [0.0; 3],
                split_impulse: [0.0; 3],
            });
            batch.retired_island_ids.push(serial);
            report.retirements += 1;
        }
        for (o, mut children) in by_owner {
            if o == UNOWNED_REMOVED {
                continue;
            }
            let mut promote: Vec<Vec<u32>> = Vec::new();
            if o == UNOWNED_ANCHORED {
                for child in children {
                    if !child.iter().any(|&c| chunks[c as usize].support) {
                        promote.push(child);
                    }
                }
            } else {
                let island = islands[o as usize].as_ref().expect("live island");
                let unchanged = !lost_removed.contains(&o)
                    && children.len() == 1
                    && children[0].len() == island.chunks.len();
                if unchanged {
                    continue;
                }
                if lost_removed.contains(&o) || children.is_empty() {
                    // Retire, re-promote every child (R6).
                    batch.retired_island_ids.push(island.serial);
                    report.retirements += 1;
                    islands[o as usize] = None;
                    free_slots.push(o);
                    promote = children;
                } else {
                    // Largest child keeps the serial.
                    children.sort_by_key(|c| (std::cmp::Reverse(c.len()), c.iter().map(|&m| chunks[m as usize].node).min()));
                    let keep = children.remove(0);
                    let island = islands[o as usize].as_mut().expect("live island");
                    let replacement = new_island(sid, island.serial, keep, chunks);
                    let was_settled = island.settled;
                    *island = replacement;
                    if was_settled {
                        woken_slots.push(o);
                    }
                    promote = children;
                }
            }
            for child in promote {
                let serial = next_serial[sid as usize];
                next_serial[sid as usize] += 1;
                assert!(serial < ids::MAX_ISLAND_SERIALS, "island serials exhausted");
                let island = new_island(sid, serial, child, chunks);
                let slot = match free_slots.pop() {
                    Some(slot) => slot,
                    None => {
                        islands.push(None);
                        (islands.len() - 1) as u32
                    }
                };
                for &c in &island.chunks {
                    owner[c as usize] = slot;
                }
                islands[slot as usize] = Some(island);
                promoted_slots.push(slot);
                report.promotions += 1;
            }
        }
        batches.push(batch);
    }

    // ── motion (R7) ──
    // An island is rigid at every frame up to f; at f+1 only if none of its
    // internal bonds broke and none of its chunks was removed there.
    let next_breaks: std::collections::HashSet<u32> = if have_next {
        pending
            .get(&(f + 1))
            .map(|(b, r)| {
                let mut slots: std::collections::HashSet<u32> = std::collections::HashSet::new();
                for &bond in b {
                    let bond = &bonds[bond as usize];
                    let (oa, ob) = (owner[bond.a as usize], owner[bond.b as usize]);
                    if oa == ob && oa < UNOWNED_ANCHORED {
                        slots.insert(oa);
                    }
                }
                for &c in r {
                    if owner[c as usize] < UNOWNED_ANCHORED {
                        slots.insert(owner[c as usize]);
                    }
                }
                slots
            })
            .unwrap_or_default()
    } else {
        Default::default()
    };
    let promoted: std::collections::HashSet<u32> = promoted_slots.iter().copied().collect();
    let mut woken: std::collections::HashSet<u32> = woken_slots.iter().copied().collect();
    let mut mid_snapshots: Vec<BodySnapshotInput> = Vec::new();
    let mut snapshots: Vec<BodySnapshotInput> = Vec::new();
    let mut settled_events: Vec<SettleEvent> = Vec::new();
    let mut motions: HashMap<u32, (IslandMotion, IslandMotion)> = HashMap::new();
    let changed_since = |island: &Island, from: u32| island.chunks.iter().any(|&c| frames.changed[c as usize] >= from);
    for (slot, island) in islands.iter_mut().enumerate() {
        let Some(island) = island.as_mut() else { continue };
        let slot = slot as u32;
        // A settled island nothing touched (no chunk written since f-1, none
        // at f+1) is still at rest: skip the arithmetic.
        let fresh = promoted.contains(&slot) || woken.contains(&slot);
        if island.settled && !fresh && !changed_since(island, f) {
            continue;
        }
        let pose_at = |g: u32| island_pose(island, frames.at(g), rest);
        let (p_f, q_f) = pose_at(f);
        let (p_m1, q_m1) = pose_at(f - 1);
        let next_ok = have_next && !next_breaks.contains(&slot);
        let (v_f, w_f) = if next_ok {
            let (p_p1, q_p1) = pose_at(f + 1);
            ((p_p1 - p_m1) / (2.0 * dt), angular_velocity(q_m1, q_p1, 2.0 * dt))
        } else {
            ((p_f - p_m1) / dt, angular_velocity(q_m1, q_f, dt))
        };
        let (v_m1, w_m1) = if f >= 2 {
            let (p_m2, q_m2) = pose_at(f - 2);
            ((p_f - p_m2) / (2.0 * dt), angular_velocity(q_m2, q_f, 2.0 * dt))
        } else {
            ((p_f - p_m1) / dt, angular_velocity(q_m1, q_f, dt))
        };
        let at_f = IslandMotion { p: p_f, q: q_f, v: v_f, w: w_f };
        let mid = if u == 2 {
            IslandMotion {
                p: (p_m1 + p_f) * 0.5 + (v_m1 - v_f) * (dt / 8.0),
                q: slerp_half(q_m1, q_f),
                v: (p_f - p_m1) * (1.5 / dt) - (v_m1 + v_f) * 0.25,
                w: (w_m1 + w_f) * 0.5,
            }
        } else {
            at_f
        };
        motions.insert(slot, (mid, at_f));
        // ── settle / wake (R8) ──
        let physx_asleep = island.chunks.iter().all(|&c| frames.at(f)[c as usize].sleeping);
        let quiet = physx_asleep || (v_f.length() < SETTLE_LINEAR_FLOOR && w_f.length() < SETTLE_ANGULAR_FLOOR);
        if island.settled {
            if !quiet && !fresh {
                woken.insert(slot);
                // The truth jumps by however far it drifted while parked:
                // up to the last frame it was still at rest.
                let jump = (p_m1 - island.settle_pose).length();
                if island.settled_by_physx { &mut wake_jumps.0 } else { &mut wake_jumps.1 }.push(jump);
            }
            if !woken.contains(&slot) {
                continue;
            }
            island.settled = false;
            island.quiet_ticks = 0;
        }
        island.quiet_ticks = if quiet { island.quiet_ticks + u } else { 0 };
        let settle_now = !promoted.contains(&slot) && (physx_asleep || island.quiet_ticks >= quiet_needed);
        let entity = ids::body_entity(island.structure, island.serial);
        let flags = if woken.contains(&slot) { FLAG_WAKE_EVENT } else { 0 };
        if u == 2 {
            mid_snapshots.push(snapshot(entity, &mid, flags));
        }
        if settle_now {
            island.settled = true;
            island.settle_pose = p_f;
            island.settled_by_physx = physx_asleep;
            report.settles += 1;
            if physx_asleep {
                report.settles_physx_sleep += 1;
            }
            settled_events.push(SettleEvent {
                structure_id: island.structure,
                island_id: island.serial,
                position: f3(p_f),
                rotation: f4(q_f),
            });
        } else {
            snapshots.push(snapshot(entity, &at_f, if u == 2 { 0 } else { flags }));
        }
    }
    let mut woken_sorted: Vec<u32> = woken.iter().copied().collect();
    woken_sorted.sort_unstable();
    let wakes: Vec<(u32, u32)> = woken_sorted
        .iter()
        .filter_map(|&slot| islands[slot as usize].as_ref().map(|i| (i.structure, i.serial)))
        .collect();
    report.wakes += wakes.len() as u64;
    for &slot in &promoted_slots {
        let island = islands[slot as usize].as_ref().expect("promoted island");
        let (mid, _) = motions[&slot];
        let batch = batches.iter_mut().find(|b| b.structure_id == island.structure).expect("batch");
        batch.promoted_islands.push(IslandPromotion {
            structure_id: island.structure,
            island_id: island.serial,
            chunks: island.chunks.iter().map(|&c| ids::chunk_id(island.structure, chunks[c as usize].node)).collect(),
            mass: island.chunks.iter().map(|&c| chunks[c as usize].mass).sum::<f64>() as f32,
            center_of_mass: f3(mid.p),
            inertia_diagonal: [0.0; 3],
            position: f3(mid.p),
            rotation: f4(mid.q),
            linear_velocity: f3(mid.v),
            angular_velocity: f3(mid.w),
            split_impulse: [0.0; 3],
        });
    }
    let topology = DestructionTickOutput { batches, settled: Vec::new(), wakes };
    if u == 2 {
        let tick = 2 * f;
        report.peak_awake = report.peak_awake.max(mid_snapshots.len());
        report.snapshots_total += mid_snapshots.len() as u64;
        tape.push(tick, &mid_snapshots, &topology).map_err(|e| e.to_string())?;
        write_stats(stats_out, tick, mid_snapshots.len() as u32)?;
        let tick = 2 * f + 1;
        let output = DestructionTickOutput { batches: Vec::new(), settled: settled_events, wakes: Vec::new() };
        report.peak_awake = report.peak_awake.max(snapshots.len());
        report.snapshots_total += snapshots.len() as u64;
        tape.push(tick, &snapshots, &output).map_err(|e| e.to_string())?;
        write_stats(stats_out, tick, snapshots.len() as u32)?;
        *last_tick = tick;
        *ticks += 2;
    } else {
        let tick = 1 + f;
        let output = DestructionTickOutput { settled: settled_events, ..topology };
        report.peak_awake = report.peak_awake.max(snapshots.len());
        report.snapshots_total += snapshots.len() as u64;
        tape.push(tick, &snapshots, &output).map_err(|e| e.to_string())?;
        write_stats(stats_out, tick, snapshots.len() as u32)?;
        *last_tick = tick;
        *ticks += 1;
    }
    report.peak_live_islands = report.peak_live_islands.max(islands.iter().filter(|i| i.is_some()).count());
    Ok(())
}

fn snapshot(entity: u32, motion: &IslandMotion, flags: u8) -> BodySnapshotInput {
    BodySnapshotInput {
        body_entity: entity,
        position: f3(motion.p),
        rotation: f4(motion.q),
        linear_velocity: f3(motion.v),
        angular_velocity: f3(motion.w),
        contacts: 0,
        flags,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(p: [f32; 3]) -> Pose {
        Pose { p, q: [0.0, 0.0, 0.0, 1.0], sleeping: false }
    }

    /// Two chunks of one rigid body keep their relative pose through any rigid
    /// motion, to within the rounding bound, and a separation of a millimetre
    /// is a break.
    #[test]
    fn rigid_motion_is_intact_and_separation_breaks() {
        let (a0, b0) = (pose([100.0, 0.5, 200.0]), pose([101.0, 0.5, 200.0]));
        let turn = glam::Quat::from_rotation_y(0.7) * glam::Quat::from_rotation_x(0.3);
        let carry = |p: &Pose| {
            let moved = glam::Vec3::new(3.0, 1.0, -2.0) + turn * (glam::Vec3::from_array(p.p) - glam::Vec3::new(100.0, 0.5, 200.0));
            Pose { p: (moved + glam::Vec3::new(100.0, 0.5, 200.0)).to_array(), q: turn.to_array(), sleeping: false }
        };
        let (a1, b1) = (carry(&a0), carry(&b0));
        let (residual, tolerance) = bond_residual(&a0, &b0, &a1, &b1);
        assert!(residual <= tolerance, "rigid motion read as a break: {residual} > {tolerance}");
        let mut b2 = b1;
        b2.p[1] += 1e-3;
        let (residual, tolerance) = bond_residual(&a0, &b0, &a1, &b2);
        assert!(residual > tolerance, "a 1 mm separation went unseen: {residual} <= {tolerance}");
    }

    /// The native lattice (native_destruction_main.cpp): unit cells of half
    /// 0.48 bond to their six face neighbours and nothing else.
    #[test]
    fn face_adjacency_reproduces_the_native_lattice() {
        let mut rest = Vec::new();
        let mut actors = Vec::new();
        for y in 0..3 {
            for z in 0..3 {
                for x in 0..3 {
                    rest.push(pose([x as f32, 0.5 + y as f32, z as f32]));
                    actors.push(TwActor { shape: 1, parameters: [0.48; 3] });
                }
            }
        }
        let authored = author_from_geometry(&actors, &rest, 1000.0).expect("authored");
        // 3x3x3 lattice: 3 axes x 2 gaps x 9 lines = 54 face pairs.
        assert_eq!(authored.bonds.len(), 54);
        assert_eq!(authored.buildings.len(), 1);
        assert_eq!(authored.geoms.iter().filter(|g| g.support).count(), 9, "bottom layer only");
        for &(a, b, area, _, _) in &authored.bonds {
            let d = (rest[a as usize].dp() - rest[b as usize].dp()).length();
            assert!((d - 1.0).abs() < 1e-6, "bond between non-neighbours {a} {b}");
            assert!((area - 0.96 * 0.96).abs() < 1e-5);
        }
    }

    /// The centre-of-mass frame reproduces every chunk:
    /// chunk_world = P + R (c_i - com).
    #[test]
    fn island_pose_is_the_centre_of_mass_frame() {
        let rest = vec![pose([0.0, 1.0, 0.0]), pose([1.0, 1.0, 0.0]), pose([1.0, 2.0, 0.0])];
        let chunks: Vec<Chunk> = rest
            .iter()
            .enumerate()
            .map(|(i, r)| Chunk { structure: 0, node: i as u32, rest: *r, mass: [1.0, 2.0, 5.0][i], support: false })
            .collect();
        let island = new_island(0, 1, vec![2, 0, 1], &chunks);
        let turn = DQuat::from_rotation_z(0.4);
        let shift = DVec3::new(5.0, -1.0, 2.0);
        let now: Vec<Pose> = rest
            .iter()
            .map(|r| {
                let p = shift + turn * r.dp();
                Pose { p: f3(p), q: f4(turn), sleeping: false }
            })
            .collect();
        let (p, q) = island_pose(&island, &now, &rest);
        let com = (rest[0].dp() * 1.0 + rest[1].dp() * 2.0 + rest[2].dp() * 5.0) / 8.0;
        for (i, r) in rest.iter().enumerate() {
            let rebuilt = p + q * (r.dp() - com);
            assert!((rebuilt - now[i].dp()).length() < 1e-5);
        }
    }

    /// A synthetic recording, end to end: a 2x2x2 lattice whose top corner
    /// chunk lifts off and comes to rest. The converter must break exactly its
    /// three bonds, promote it as one island, settle it after the quiet
    /// period, and leave a ledger a bonds-only client derives exactly.
    #[test]
    fn a_chunk_that_lifts_off_is_one_promotion_and_one_settle() {
        use vibe_land_destruction::netlab::tape::TapeReader;
        use vibe_land_destruction::topology::CityLedger;
        let dir = std::env::temp_dir().join(format!("twstate-to-capture-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("lift.twstate");
        let mut bytes: Vec<u8> = Vec::new();
        let u32le = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
        let f32le = |b: &mut Vec<u8>, v: f32| b.extend_from_slice(&v.to_le_bytes());
        bytes.extend_from_slice(b"TWSTATE1");
        for v in [2u32, 60, 120, 960, 540, 1, 4] {
            u32le(&mut bytes, v);
        }
        f32le(&mut bytes, 2.0);
        f32le(&mut bytes, 0.0);
        for _ in 0..4 {
            for v in [0.0f32, 10.0, 10.0, 0.0, 0.0, -1.0, 60.0] {
                f32le(&mut bytes, v);
            }
        }
        let mut rest = Vec::new();
        for y in 0..2 {
            for z in 0..2 {
                for x in 0..2 {
                    rest.push([x as f32, 0.48 + y as f32, z as f32]);
                }
            }
        }
        for (id, _) in rest.iter().enumerate() {
            bytes.push(RECORD_ACTOR);
            u32le(&mut bytes, id as u32);
            bytes.push(0);
            u32le(&mut bytes, 1);
            bytes.push(1);
            for v in [0.48f32, 0.48, 0.48, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0] {
                f32le(&mut bytes, v);
            }
        }
        let frame = |b: &mut Vec<u8>, index: u32, poses: &[(u32, [f32; 3])]| {
            b.push(RECORD_FRAME);
            b.extend_from_slice(&index.to_le_bytes());
            b.extend_from_slice(&(poses.len() as u32).to_le_bytes());
            for (id, p) in poses {
                b.extend_from_slice(&id.to_le_bytes());
                for v in [p[0], p[1], p[2], 0.0, 0.0, 0.0, 1.0] {
                    b.extend_from_slice(&v.to_le_bytes());
                }
                b.push(0);
            }
        };
        let all: Vec<(u32, [f32; 3])> = rest.iter().enumerate().map(|(i, p)| (i as u32, *p)).collect();
        frame(&mut bytes, 0, &all);
        // Chunk 7 (top, x=1 z=1) rises 2 cm a frame for 10 frames, then rests.
        let mut top = rest[7];
        for index in 1..120u32 {
            if index <= 10 {
                top[1] += 0.02;
                frame(&mut bytes, index, &[(7, top)]);
            } else {
                frame(&mut bytes, index, &[]);
            }
        }
        bytes.push(RECORD_END);
        std::fs::write(&path, &bytes).expect("write twstate");

        let out = dir.join("capture");
        run(Options {
            twstate: path.display().to_string(),
            out: out.clone(),
            scene: None,
            density: 1000.0,
            frames: None,
            region: None,
            hz: 60,
            name: "lift".into(),
            source: None,
        })
        .expect("convert");

        let manifest: DestructionManifest =
            serde_json::from_slice(&std::fs::read(out.join(MANIFEST_FILE)).expect("manifest")).expect("parse");
        assert_eq!(manifest.structures.len(), 1);
        assert_eq!(manifest.structures[0].bonds.len(), 12, "a 2x2x2 lattice has 12 face pairs");
        let mut ledger = CityLedger::from_manifest(&manifest);
        let mut tape = TapeReader::open(&out.join(TAPE_FILE)).expect("tape");
        let (mut broken, mut promoted, mut settled, mut streamed) = (0, Vec::new(), 0, 0);
        while let Some(tick) = tape.next_tick().expect("read") {
            for batch in &tick.output.batches {
                ledger.apply_batch(batch);
                broken += batch.broken_bond_ids.len();
                promoted.extend(batch.promoted_islands.iter().map(|p| p.chunks.clone()));
                let check = ledger.derive_check(&manifest, batch.structure_id);
                assert_eq!(check.disagreements(), 0, "tick {}: {check:?}", tick.tick);
            }
            settled += tick.output.settled.len();
            streamed += tick.snapshots.len();
            for snapshot in &tick.snapshots {
                // The wire pose is the chunk's own centre (a one-chunk island).
                assert!((snapshot.position[0] - 1.0).abs() < 1e-5 && (snapshot.position[2] - 1.0).abs() < 1e-5);
            }
        }
        assert_eq!(broken, 3, "the corner's three bonds");
        assert_eq!(promoted, vec![vec![ids::chunk_id(0, 7)]]);
        assert_eq!(settled, 1, "it comes to rest once");
        assert!(streamed > 0 && streamed < 60, "streamed while moving, then parked: {streamed}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
