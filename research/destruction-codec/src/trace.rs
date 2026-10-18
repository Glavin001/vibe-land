//! Streaming reader and writer for the little-endian `TWTRACE1` contract.
//!
//! Actor definitions are retained (needed for bounds and replay), but only one
//! tick of state is allocated at a time. Limits reject corrupt files before
//! attacker-controlled counts can cause unreasonable allocations.

use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::Path,
};

use anyhow::{ensure, Context, Result};
use glam::{Quat, Vec3};

pub const MAGIC: &[u8; 8] = b"TWTRACE1";
pub const VERSION: u32 = 1;
pub const CONTACT_GRAPH_VERSION: u32 = 2;
pub const TOPOLOGY_VERSION: u32 = 3;
const TICK: u8 = 2;
const END: u8 = 255;
const MAX_ACTORS: u32 = 1_000_000;
const MAX_SHAPES_PER_ACTOR: u32 = 65_536;
const MAX_TICKS: u32 = 100_000_000;

#[derive(Clone, Copy, Debug, Default)]
pub struct Pose {
    pub position: Vec3,
    pub rotation: Quat,
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub eye: Vec3,
    pub direction: Vec3,
    pub fov_degrees: f32,
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub kind: u8,
    pub params: Vec3,
    pub local: Pose,
}

#[derive(Clone, Debug)]
pub struct ActorDef {
    pub id: u32,
    pub part: u8,
    pub linear_damping: f32,
    pub angular_damping: f32,
    pub shapes: Vec<Shape>,
    pub bounding_radius: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct TopologyEdge {
    pub global_id: u64,
    pub first: u32,
    pub second: u32,
    pub kind: u8,
}

#[derive(Clone, Debug)]
pub struct TraceTopology {
    pub actor_global_ids: Vec<u64>,
    pub edges: Vec<TopologyEdge>,
}

#[derive(Clone, Debug, Default)]
pub struct TopologyTick {
    pub epoch: u32,
    pub broken_edges: Vec<u64>,
    pub changed_roots: Vec<(u32, u32)>,
    pub island_roots: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Header {
    pub physics_hz: u32,
    pub tick_count: u32,
    pub pane_width: u32,
    pub pane_height: u32,
    pub gravity: Vec3,
    pub cameras: [Camera; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct ActorState {
    pub pose: Pose,
    pub linear_velocity: Vec3,
    pub angular_velocity: Vec3,
    pub contacts: u16,
    pub intact_joints: u16,
    pub flags: u8,
}

impl ActorState {
    pub fn sleeping(self) -> bool {
        self.flags & 1 != 0
    }

    pub fn kinematic(self) -> bool {
        self.flags & 2 != 0
    }
}

#[derive(Clone, Debug)]
pub struct Tick {
    pub index: u32,
    pub simulation_time: f32,
    pub states: Vec<ActorState>,
    pub contact_pairs: Vec<(u32, u32)>,
    pub topology: TopologyTick,
}

pub struct TraceReader {
    reader: BufReader<File>,
    pub header: Header,
    pub actors: Vec<ActorDef>,
    pub topology: TraceTopology,
    version: u32,
    island_roots: Vec<u32>,
    topology_epoch: u32,
    next_tick: u32,
    previous_time: Option<f32>,
    ended: bool,
}

impl TraceReader {
    pub fn open(path: &Path) -> Result<Self> {
        let mut reader = BufReader::new(
            File::open(path).with_context(|| format!("open trace {}", path.display()))?,
        );
        let mut magic = [0; 8];
        reader
            .read_exact(&mut magic)
            .context("read TWTRACE1 magic")?;
        ensure!(
            &magic == MAGIC,
            "{} is not a TWTRACE1 trace",
            path.display()
        );
        let version = read_u32(&mut reader)?;
        ensure!(
            matches!(version, VERSION | CONTACT_GRAPH_VERSION | TOPOLOGY_VERSION),
            "unsupported TWTRACE1 version {version}"
        );
        let physics_hz = read_u32(&mut reader)?;
        let tick_count = read_u32(&mut reader)?;
        let pane_width = read_u32(&mut reader)?;
        let pane_height = read_u32(&mut reader)?;
        let actor_count = read_u32(&mut reader)?;
        let gravity = read_vec3(&mut reader)?;
        let camera_count = read_u32(&mut reader)?;
        ensure!(physics_hz > 0 && physics_hz <= 10_000, "invalid physics_hz");
        ensure!(tick_count <= MAX_TICKS, "tick_count exceeds safety limit");
        ensure!(
            pane_width > 0 && pane_height > 0,
            "viewport dimensions must be positive"
        );
        ensure!(
            actor_count <= MAX_ACTORS,
            "actor_count exceeds safety limit"
        );
        ensure!(gravity.is_finite(), "gravity contains non-finite values");
        ensure!(camera_count == 4, "TWTRACE1 requires exactly four cameras");

        let mut cameras = [Camera {
            eye: Vec3::ZERO,
            direction: Vec3::NEG_Z,
            fov_degrees: 45.0,
        }; 4];
        for camera in &mut cameras {
            camera.eye = read_vec3(&mut reader)?;
            camera.direction = read_vec3(&mut reader)?;
            camera.fov_degrees = read_f32(&mut reader)?;
            ensure!(
                camera.eye.is_finite()
                    && camera.direction.is_finite()
                    && camera.direction.length_squared() > 1e-12
                    && camera.fov_degrees > 1.0
                    && camera.fov_degrees < 179.0,
                "invalid camera definition"
            );
        }

        let mut actors = Vec::with_capacity(actor_count as usize);
        for expected_id in 0..actor_count {
            let id = read_u32(&mut reader)?;
            ensure!(
                id == expected_id,
                "actor IDs/order must be contiguous: expected {expected_id}, got {id}"
            );
            let part = read_u8(&mut reader)?;
            let linear_damping = read_f32(&mut reader)?;
            let angular_damping = read_f32(&mut reader)?;
            let shape_count = read_u32(&mut reader)?;
            ensure!(
                shape_count <= MAX_SHAPES_PER_ACTOR,
                "actor {id} shape count exceeds safety limit"
            );
            ensure!(
                linear_damping.is_finite()
                    && linear_damping >= 0.0
                    && angular_damping.is_finite()
                    && angular_damping >= 0.0,
                "actor {id} has invalid damping"
            );
            let mut shapes = Vec::with_capacity(shape_count as usize);
            let mut radius = 0.0_f32;
            for _ in 0..shape_count {
                let kind = read_u8(&mut reader)?;
                let params = read_vec3(&mut reader)?;
                let local = read_pose(&mut reader)?;
                ensure!(matches!(kind, 1 | 2), "actor {id} has unknown shape {kind}");
                ensure!(
                    params.is_finite() && params.min_element() >= 0.0,
                    "actor {id} has invalid shape parameters"
                );
                validate_pose(local, "shape local transform")?;
                let shape_radius = match kind {
                    1 => params.length(),
                    2 => params.x,
                    _ => unreachable!(),
                };
                radius = radius.max(local.position.length() + shape_radius);
                shapes.push(Shape {
                    kind,
                    params,
                    local,
                });
            }
            actors.push(ActorDef {
                id,
                part,
                linear_damping,
                angular_damping,
                shapes,
                bounding_radius: radius.max(0.01),
            });
        }
        let topology = if version >= TOPOLOGY_VERSION {
            let topology_actor_count = read_u32(&mut reader)?;
            ensure!(
                topology_actor_count == actor_count,
                "topology actor count mismatch"
            );
            let mut actor_global_ids = Vec::with_capacity(actor_count as usize);
            for _ in 0..actor_count {
                actor_global_ids.push(read_u64(&mut reader)?);
            }
            let edge_count = read_u32(&mut reader)?;
            ensure!(
                edge_count <= actor_count.saturating_mul(64),
                "topology edge count exceeds safety limit"
            );
            let mut edges = Vec::with_capacity(edge_count as usize);
            let mut previous_id = None;
            for _ in 0..edge_count {
                let edge = TopologyEdge {
                    global_id: read_u64(&mut reader)?,
                    first: read_u32(&mut reader)?,
                    second: read_u32(&mut reader)?,
                    kind: read_u8(&mut reader)?,
                };
                ensure!(
                    edge.first < edge.second && edge.second < actor_count,
                    "invalid topology edge endpoints"
                );
                ensure!(
                    previous_id.is_none_or(|id| id < edge.global_id),
                    "topology edge IDs must be sorted and unique"
                );
                ensure!(matches!(edge.kind, 1 | 2), "unknown topology edge kind");
                previous_id = Some(edge.global_id);
                edges.push(edge);
            }
            TraceTopology {
                actor_global_ids,
                edges,
            }
        } else {
            TraceTopology {
                actor_global_ids: (0..actor_count)
                    .map(|actor| 0x5457_4143_0000_0000_u64 | u64::from(actor))
                    .collect(),
                edges: Vec::new(),
            }
        };
        let island_roots: Vec<u32> = (0..actor_count).collect();

        Ok(Self {
            reader,
            header: Header {
                physics_hz,
                tick_count,
                pane_width,
                pane_height,
                gravity,
                cameras,
            },
            actors,
            topology,
            version,
            island_roots,
            topology_epoch: 0,
            next_tick: 0,
            previous_time: None,
            ended: false,
        })
    }

    pub fn next_tick(&mut self) -> Result<Option<Tick>> {
        if self.ended {
            return Ok(None);
        }
        let marker = read_u8(&mut self.reader).context("read tick/end marker")?;
        if marker == END {
            ensure!(
                self.next_tick == self.header.tick_count,
                "early end: read {} of {} declared ticks",
                self.next_tick,
                self.header.tick_count
            );
            let mut trailing = [0_u8; 1];
            ensure!(
                self.reader.read(&mut trailing)? == 0,
                "trailing data after end marker"
            );
            self.ended = true;
            return Ok(None);
        }
        ensure!(marker == TICK, "unknown trace record marker {marker}");
        ensure!(
            self.next_tick < self.header.tick_count,
            "more ticks than declared"
        );
        let index = read_u32(&mut self.reader)?;
        let simulation_time = read_f32(&mut self.reader)?;
        let actor_count = read_u32(&mut self.reader)?;
        ensure!(
            index == self.next_tick,
            "expected tick {}, got {index}",
            self.next_tick
        );
        ensure!(
            actor_count as usize == self.actors.len(),
            "tick {index} actor count mismatch"
        );
        ensure!(
            simulation_time.is_finite() && simulation_time >= 0.0,
            "tick {index} has invalid time"
        );
        if let Some(previous) = self.previous_time {
            ensure!(
                simulation_time > previous,
                "tick times must be strictly increasing"
            );
        }
        let mut states = Vec::with_capacity(actor_count as usize);
        for actor in 0..actor_count {
            let state = ActorState {
                pose: read_pose(&mut self.reader)?,
                linear_velocity: read_vec3(&mut self.reader)?,
                angular_velocity: read_vec3(&mut self.reader)?,
                contacts: read_u16(&mut self.reader)?,
                intact_joints: read_u16(&mut self.reader)?,
                flags: read_u8(&mut self.reader)?,
            };
            validate_pose(state.pose, "actor pose")
                .with_context(|| format!("tick {index}, actor {actor}"))?;
            ensure!(
                state.linear_velocity.is_finite() && state.angular_velocity.is_finite(),
                "tick {index}, actor {actor}: non-finite velocity"
            );
            ensure!(
                state.flags & !0x7f == 0,
                "tick {index}, actor {actor}: unknown flag bits"
            );
            states.push(state);
        }
        let contact_pairs = if self.version >= CONTACT_GRAPH_VERSION {
            let pair_count = read_u32(&mut self.reader)?;
            ensure!(
                pair_count <= actor_count.saturating_mul(64),
                "tick {index}: contact pair count exceeds safety limit"
            );
            let mut pairs = Vec::with_capacity(pair_count as usize);
            let mut previous = None;
            for _ in 0..pair_count {
                let first = read_u32(&mut self.reader)?;
                let second = read_u32(&mut self.reader)?;
                ensure!(
                    first < second && second < actor_count,
                    "tick {index}: invalid contact pair ({first}, {second})"
                );
                ensure!(
                    previous.is_none_or(|value| value < (first, second)),
                    "tick {index}: contact pairs must be sorted and unique"
                );
                previous = Some((first, second));
                pairs.push((first, second));
            }
            pairs
        } else {
            Vec::new()
        };
        let topology = if self.version >= TOPOLOGY_VERSION {
            let epoch = read_u32(&mut self.reader)?;
            ensure!(
                epoch >= self.topology_epoch,
                "tick {index}: topology epoch moved backward"
            );
            let broken_count = read_u32(&mut self.reader)?;
            ensure!(
                broken_count <= self.topology.edges.len() as u32,
                "tick {index}: too many broken topology edges"
            );
            let edge_ids: std::collections::BTreeSet<_> = self
                .topology
                .edges
                .iter()
                .map(|edge| edge.global_id)
                .collect();
            let mut broken_edges = Vec::with_capacity(broken_count as usize);
            let mut previous_edge = None;
            for _ in 0..broken_count {
                let edge = read_u64(&mut self.reader)?;
                ensure!(
                    edge_ids.contains(&edge)
                        && previous_edge.is_none_or(|previous| previous < edge),
                    "tick {index}: invalid or unsorted broken edge"
                );
                previous_edge = Some(edge);
                broken_edges.push(edge);
            }
            let changed_count = read_u32(&mut self.reader)?;
            ensure!(
                changed_count <= actor_count,
                "tick {index}: too many topology root changes"
            );
            let mut changed_roots = Vec::with_capacity(changed_count as usize);
            let mut previous_actor = None;
            for _ in 0..changed_count {
                let actor = read_u32(&mut self.reader)?;
                let root = read_u32(&mut self.reader)?;
                ensure!(
                    actor < actor_count
                        && root < actor_count
                        && previous_actor.is_none_or(|previous| previous < actor),
                    "tick {index}: invalid or unsorted topology root change"
                );
                previous_actor = Some(actor);
                self.island_roots[actor as usize] = root;
                changed_roots.push((actor, root));
            }
            if index == 0 {
                ensure!(
                    changed_count == actor_count,
                    "topology version 3 requires a complete tick-zero island map"
                );
            }
            self.topology_epoch = epoch;
            TopologyTick {
                epoch,
                broken_edges,
                changed_roots,
                island_roots: self.island_roots.clone(),
            }
        } else {
            TopologyTick {
                epoch: 0,
                broken_edges: Vec::new(),
                changed_roots: Vec::new(),
                island_roots: self.island_roots.clone(),
            }
        };
        self.next_tick += 1;
        self.previous_time = Some(simulation_time);
        Ok(Some(Tick {
            index,
            simulation_time,
            states,
            contact_pairs,
            topology,
        }))
    }

    pub fn finish(mut self) -> Result<()> {
        while self.next_tick()?.is_some() {}
        Ok(())
    }
}

fn validate_pose(pose: Pose, what: &str) -> Result<()> {
    ensure!(
        pose.position.is_finite() && pose.rotation.is_finite(),
        "{what} contains non-finite values"
    );
    let length = pose.rotation.length();
    ensure!(
        (0.5..=1.5).contains(&length),
        "{what} has invalid quaternion length {length}"
    );
    Ok(())
}

pub struct TraceWriter {
    writer: BufWriter<File>,
    version: u32,
    actor_count: u32,
    tick_count: u32,
    written_ticks: u32,
}

impl TraceWriter {
    #[allow(dead_code)]
    pub fn create(path: &Path, header: &Header, actors: &[ActorDef]) -> Result<Self> {
        Self::create_versioned(path, header, actors, VERSION, None)
    }

    pub fn create_with_topology(
        path: &Path,
        header: &Header,
        actors: &[ActorDef],
        topology: &TraceTopology,
    ) -> Result<Self> {
        Self::create_versioned(path, header, actors, TOPOLOGY_VERSION, Some(topology))
    }

    fn create_versioned(
        path: &Path,
        header: &Header,
        actors: &[ActorDef],
        version: u32,
        topology: Option<&TraceTopology>,
    ) -> Result<Self> {
        ensure!(header.tick_count <= MAX_TICKS);
        ensure!(actors.len() <= MAX_ACTORS as usize);
        let mut writer = BufWriter::new(
            File::create(path).with_context(|| format!("create trace {}", path.display()))?,
        );
        writer.write_all(MAGIC)?;
        write_u32(&mut writer, version)?;
        write_u32(&mut writer, header.physics_hz)?;
        write_u32(&mut writer, header.tick_count)?;
        write_u32(&mut writer, header.pane_width)?;
        write_u32(&mut writer, header.pane_height)?;
        write_u32(&mut writer, actors.len() as u32)?;
        write_vec3(&mut writer, header.gravity)?;
        write_u32(&mut writer, 4)?;
        for camera in &header.cameras {
            write_vec3(&mut writer, camera.eye)?;
            write_vec3(&mut writer, camera.direction)?;
            write_f32(&mut writer, camera.fov_degrees)?;
        }
        for (index, actor) in actors.iter().enumerate() {
            ensure!(actor.id as usize == index, "actor IDs must be contiguous");
            write_u32(&mut writer, actor.id)?;
            write_u8(&mut writer, actor.part)?;
            write_f32(&mut writer, actor.linear_damping)?;
            write_f32(&mut writer, actor.angular_damping)?;
            write_u32(&mut writer, actor.shapes.len() as u32)?;
            for shape in &actor.shapes {
                write_u8(&mut writer, shape.kind)?;
                write_vec3(&mut writer, shape.params)?;
                write_pose(&mut writer, shape.local)?;
            }
        }
        if version >= TOPOLOGY_VERSION {
            let topology = topology.context("topology version requires a topology manifest")?;
            ensure!(topology.actor_global_ids.len() == actors.len());
            write_u32(&mut writer, actors.len() as u32)?;
            for &global_id in &topology.actor_global_ids {
                write_u64(&mut writer, global_id)?;
            }
            write_u32(&mut writer, topology.edges.len() as u32)?;
            let mut previous = None;
            for edge in &topology.edges {
                ensure!(
                    edge.first < edge.second && edge.second < actors.len() as u32,
                    "invalid topology edge"
                );
                ensure!(
                    previous.is_none_or(|id| id < edge.global_id),
                    "topology edges must be sorted"
                );
                previous = Some(edge.global_id);
                write_u64(&mut writer, edge.global_id)?;
                write_u32(&mut writer, edge.first)?;
                write_u32(&mut writer, edge.second)?;
                write_u8(&mut writer, edge.kind)?;
            }
        }
        Ok(Self {
            writer,
            version,
            actor_count: actors.len() as u32,
            tick_count: header.tick_count,
            written_ticks: 0,
        })
    }

    pub fn write_tick(&mut self, tick: &Tick) -> Result<()> {
        ensure!(tick.index == self.written_ticks, "non-contiguous tick");
        ensure!(tick.states.len() == self.actor_count as usize);
        if self.version == VERSION {
            ensure!(
                tick.contact_pairs.is_empty(),
                "TraceWriter version 1 cannot write contact pairs"
            );
            ensure!(
                tick.topology.broken_edges.is_empty() && tick.topology.changed_roots.is_empty(),
                "TraceWriter version 1 cannot write topology"
            );
        }
        write_u8(&mut self.writer, TICK)?;
        write_u32(&mut self.writer, tick.index)?;
        write_f32(&mut self.writer, tick.simulation_time)?;
        write_u32(&mut self.writer, self.actor_count)?;
        for state in &tick.states {
            write_pose(&mut self.writer, state.pose)?;
            write_vec3(&mut self.writer, state.linear_velocity)?;
            write_vec3(&mut self.writer, state.angular_velocity)?;
            write_u16(&mut self.writer, state.contacts)?;
            write_u16(&mut self.writer, state.intact_joints)?;
            write_u8(&mut self.writer, state.flags)?;
        }
        if self.version >= CONTACT_GRAPH_VERSION {
            write_u32(&mut self.writer, tick.contact_pairs.len() as u32)?;
            for &(first, second) in &tick.contact_pairs {
                write_u32(&mut self.writer, first)?;
                write_u32(&mut self.writer, second)?;
            }
        }
        if self.version >= TOPOLOGY_VERSION {
            write_u32(&mut self.writer, tick.topology.epoch)?;
            write_u32(&mut self.writer, tick.topology.broken_edges.len() as u32)?;
            for &edge in &tick.topology.broken_edges {
                write_u64(&mut self.writer, edge)?;
            }
            write_u32(&mut self.writer, tick.topology.changed_roots.len() as u32)?;
            for &(actor, root) in &tick.topology.changed_roots {
                write_u32(&mut self.writer, actor)?;
                write_u32(&mut self.writer, root)?;
            }
        }
        self.written_ticks += 1;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        ensure!(
            self.written_ticks == self.tick_count,
            "wrote {} of {} ticks",
            self.written_ticks,
            self.tick_count
        );
        write_u8(&mut self.writer, END)?;
        self.writer.flush()?;
        Ok(())
    }
}

fn read_u8(reader: &mut impl Read) -> Result<u8> {
    let mut b = [0; 1];
    reader.read_exact(&mut b)?;
    Ok(b[0])
}
fn read_u16(reader: &mut impl Read) -> Result<u16> {
    let mut b = [0; 2];
    reader.read_exact(&mut b)?;
    Ok(u16::from_le_bytes(b))
}
fn read_u32(reader: &mut impl Read) -> Result<u32> {
    let mut b = [0; 4];
    reader.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64(reader: &mut impl Read) -> Result<u64> {
    let mut b = [0; 8];
    reader.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}
fn read_f32(reader: &mut impl Read) -> Result<f32> {
    let mut b = [0; 4];
    reader.read_exact(&mut b)?;
    Ok(f32::from_le_bytes(b))
}
fn read_vec3(reader: &mut impl Read) -> Result<Vec3> {
    Ok(Vec3::new(
        read_f32(reader)?,
        read_f32(reader)?,
        read_f32(reader)?,
    ))
}
fn read_pose(reader: &mut impl Read) -> Result<Pose> {
    Ok(Pose {
        position: read_vec3(reader)?,
        rotation: Quat::from_xyzw(
            read_f32(reader)?,
            read_f32(reader)?,
            read_f32(reader)?,
            read_f32(reader)?,
        ),
    })
}

pub fn write_u8(writer: &mut impl Write, value: u8) -> Result<()> {
    writer.write_all(&[value])?;
    Ok(())
}
pub fn write_u16(writer: &mut impl Write, value: u16) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}
pub fn write_u32(writer: &mut impl Write, value: u32) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}
pub fn write_u64(writer: &mut impl Write, value: u64) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}
pub fn write_f32(writer: &mut impl Write, value: f32) -> Result<()> {
    writer.write_all(&value.to_le_bytes())?;
    Ok(())
}
pub fn write_vec3(writer: &mut impl Write, value: Vec3) -> Result<()> {
    write_f32(writer, value.x)?;
    write_f32(writer, value.y)?;
    write_f32(writer, value.z)
}
pub fn write_pose(writer: &mut impl Write, pose: Pose) -> Result<()> {
    write_vec3(writer, pose.position)?;
    write_f32(writer, pose.rotation.x)?;
    write_f32(writer, pose.rotation.y)?;
    write_f32(writer, pose.rotation.z)?;
    write_f32(writer, pose.rotation.w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_layout_is_28_bytes() {
        let mut bytes = Vec::new();
        write_pose(
            &mut bytes,
            Pose {
                position: Vec3::ONE,
                rotation: Quat::IDENTITY,
            },
        )
        .unwrap();
        assert_eq!(bytes.len(), 28);
    }
}
