use std::path::Path;

use anyhow::{ensure, Result};
use glam::{Quat, Vec3};

use crate::trace::{
    ActorDef, ActorState, Camera, Header, Pose, Shape, Tick, TopologyEdge, TopologyTick,
    TraceTopology, TraceWriter,
};

#[allow(dead_code)]
pub fn write_fixture(path: &Path, physics_hz: u32, seconds: f32) -> Result<()> {
    write_topology_fixture(path, physics_hz, seconds, false, 4, 2)
}

/// Deterministic TWTRACE1 v3 fixture.
///
/// When `exact_islands` is true, children stay rigidly glued to their island
/// roots until durable edges break. That models the Blast pre-fractured
/// shared-manifest case: server and client both know stable global IDs and baked
/// local offsets.
pub fn write_topology_fixture(
    path: &Path,
    physics_hz: u32,
    seconds: f32,
    exact_islands: bool,
    actor_count: u32,
    island_size: u32,
) -> Result<()> {
    ensure!((1..=1000).contains(&physics_hz));
    ensure!((3.0..=120.0).contains(&seconds));
    ensure!((2..=256).contains(&actor_count));
    ensure!((2..=64).contains(&island_size));
    let tick_count = (seconds * physics_hz as f32).round() as u32;
    let cameras = [
        Camera {
            eye: Vec3::new(0.0, 4.0, -12.0),
            direction: Vec3::new(0.0, -0.15, 1.0),
            fov_degrees: 55.0,
        },
        Camera {
            eye: Vec3::new(14.0, 7.0, -20.0),
            direction: Vec3::new(-0.5, -0.2, 1.0),
            fov_degrees: 50.0,
        },
        Camera {
            eye: Vec3::new(-35.0, 14.0, -45.0),
            direction: Vec3::new(0.55, -0.2, 1.0),
            fov_degrees: 45.0,
        },
        Camera {
            eye: Vec3::new(0.0, 55.0, 2.0),
            direction: Vec3::new(0.0, -1.0, 0.05),
            fov_degrees: 60.0,
        },
    ];
    let actors = (0..actor_count)
        .map(|id| ActorDef {
            id,
            part: id as u8,
            linear_damping: 0.08 + (id % 8) as f32 * 0.02,
            angular_damping: 0.1,
            shapes: vec![Shape {
                kind: if id % 4 == 3 { 2 } else { 1 },
                params: if id % 4 == 3 {
                    Vec3::splat(0.35)
                } else {
                    Vec3::new(0.45, 0.25, 0.35)
                },
                local: Pose::default(),
            }],
            bounding_radius: 0.65,
        })
        .collect::<Vec<_>>();
    let header = Header {
        physics_hz,
        tick_count,
        pane_width: 960,
        pane_height: 540,
        gravity: Vec3::new(0.0, -9.81, 0.0),
        cameras,
    };
    let topology = TraceTopology {
        actor_global_ids: (0..actor_count)
            .map(|actor| 0x5457_4143_0000_0000_u64 | u64::from(actor))
            .collect(),
        edges: durable_edges(actor_count, exact_islands, island_size),
    };
    let mut writer = TraceWriter::create_with_topology(path, &header, &actors, &topology)?;
    let dt = 1.0 / physics_hz as f32;
    let locals: Vec<_> = (0..actor_count)
        .map(|id| {
            let island = id / island_size.max(1);
            let slot = id % island_size.max(1);
            if slot == 0 {
                Pose::default()
            } else {
                Pose {
                    position: Vec3::new(slot as f32 * 0.5, (island % 3) as f32 * 0.05, 0.0),
                    rotation: Quat::IDENTITY,
                }
            }
        })
        .collect();
    let mut previous_roots: Vec<u32> = (0..actor_count).collect();
    let mut epoch = 0_u32;
    let break_time = if exact_islands { 4.5 } else { 1.8 };
    for index in 0..tick_count {
        let t = index as f32 * dt;
        let edges_broken = t >= break_time;
        let broken_edge_ids: Vec<u64> = if edges_broken {
            topology.edges.iter().map(|edge| edge.global_id).collect()
        } else {
            Vec::new()
        };
        let island_roots = island_roots_from_edges(actor_count, &topology.edges, &broken_edge_ids);
        let mut broken_edges = Vec::new();
        if index > 0 && previous_roots != island_roots {
            epoch += 1;
            if edges_broken {
                broken_edges = broken_edge_ids.clone();
            }
        }
        let changed_roots: Vec<(u32, u32)> = if index == 0 {
            island_roots
                .iter()
                .enumerate()
                .map(|(actor, &root)| (actor as u32, root))
                .collect()
        } else {
            island_roots
                .iter()
                .enumerate()
                .filter_map(|(actor, &root)| {
                    (previous_roots[actor] != root).then_some((actor as u32, root))
                })
                .collect()
        };
        let mut states = Vec::with_capacity(actor_count as usize);
        for id in 0..actor_count {
            let root = island_roots[id as usize];
            let root_state = synthetic_state(root, t, dt, exact_islands, island_size);
            if id == root {
                states.push(root_state);
            } else if !edges_broken && exact_islands {
                states.push(ActorState {
                    pose: compose_pose(root_state.pose, locals[id as usize]),
                    linear_velocity: root_state.linear_velocity,
                    angular_velocity: root_state.angular_velocity,
                    contacts: root_state.contacts,
                    intact_joints: 1,
                    flags: root_state.flags,
                });
            } else if !edges_broken {
                // Approximate D6 cluster: mostly follows the root with a tiny
                // residual that hierarchy coding must either omit or repair.
                let mut child = synthetic_state(id, t, dt, exact_islands, island_size);
                let predicted = compose_pose(root_state.pose, locals[id as usize]);
                child.pose.position = predicted.position + Vec3::new(0.001, 0.0, 0.0);
                child.pose.rotation = predicted.rotation;
                child.intact_joints = 1;
                states.push(child);
            } else {
                states.push(synthetic_state(id, t, dt, exact_islands, island_size));
            }
        }
        writer.write_tick(&Tick {
            index,
            simulation_time: t,
            states,
            contact_pairs: Vec::new(),
            topology: TopologyTick {
                epoch,
                broken_edges,
                changed_roots,
                island_roots: island_roots.clone(),
            },
        })?;
        previous_roots = island_roots;
    }
    writer.finish()
}

fn island_roots_from_edges(
    actor_count: u32,
    edges: &[TopologyEdge],
    broken_edge_ids: &[u64],
) -> Vec<u32> {
    let broken: std::collections::BTreeSet<_> = broken_edge_ids.iter().copied().collect();
    let mut parent: Vec<u32> = (0..actor_count).collect();
    let find = |parent: &mut [u32], mut actor: u32| {
        let mut root = actor;
        while parent[root as usize] != root {
            root = parent[root as usize];
        }
        while parent[actor as usize] != actor {
            let next = parent[actor as usize];
            parent[actor as usize] = root;
            actor = next;
        }
        root
    };
    for edge in edges {
        if broken.contains(&edge.global_id) {
            continue;
        }
        let first = find(&mut parent, edge.first);
        let second = find(&mut parent, edge.second);
        if first != second {
            parent[first.max(second) as usize] = first.min(second);
        }
    }
    (0..actor_count)
        .map(|actor| find(&mut parent, actor))
        .collect()
}

fn durable_edges(actor_count: u32, exact_islands: bool, island_size: u32) -> Vec<TopologyEdge> {
    let mut edges = Vec::new();
    if exact_islands {
        let mut edge_id = 0_u64;
        let mut root = 0_u32;
        while root < actor_count {
            let end = (root + island_size).min(actor_count);
            for child in (root + 1)..end {
                edges.push(TopologyEdge {
                    global_id: 0x5457_4544_0000_0000_u64 | edge_id,
                    first: root,
                    second: child,
                    kind: 2, // exact Blast-style bond / compound island
                });
                edge_id += 1;
            }
            root = end;
        }
    } else {
        for (index, &(first, second)) in [(0, 1), (1, 2)].iter().enumerate() {
            if second >= actor_count {
                break;
            }
            edges.push(TopologyEdge {
                global_id: 0x5457_4544_0000_0000_u64 | index as u64,
                first,
                second,
                kind: 1, // approximate D6 weld
            });
        }
    }
    edges
}

fn compose_pose(parent: Pose, local: Pose) -> Pose {
    Pose {
        position: parent.position + parent.rotation * local.position,
        rotation: (parent.rotation * local.rotation).normalize(),
    }
}

fn synthetic_state(id: u32, t: f32, dt: f32, exact_islands: bool, island_size: u32) -> ActorState {
    let island = id / island_size.max(1);
    let offset = Vec3::new(
        (island as f32 - 1.5) * 2.4,
        0.0,
        (id % island_size.max(1)) as f32 * 0.15,
    );
    let impact_time = 1.2 + (island % 5) as f32 * 0.08;
    let settle_time = 3.3 + (island % 5) as f32 * 0.12;
    let wake_time = 5.2;
    let mut flags = 0;
    let (position, linear_velocity, angular_velocity, contacts, intact_joints) = if t < impact_time
    {
        let initial = Vec3::new(1.5 - (island % 4) as f32 * 0.2, 2.0, 0.3);
        let start = offset + Vec3::new(0.0, 4.5 + (island % 6) as f32, 0.0);
        (
            start + initial * t + Vec3::Y * (-4.905 * t * t),
            initial + Vec3::Y * (-9.81 * t),
            Vec3::new(0.7, 1.3, 0.2 + (island % 3) as f32 * 0.1),
            0,
            if exact_islands { 1 } else { 0 },
        )
    } else if t < settle_time {
        let s = t - impact_time;
        if s < dt * 1.5 {
            flags |= 4; // contact_begin
        }
        let decay = (-1.4 * s).exp();
        (
            offset
                + Vec3::new(
                    1.5 * (1.0 - decay),
                    0.32 + 0.12 * decay * (s * 15.0).sin().abs(),
                    0.25 * (s * 4.0).sin() * decay,
                ),
            Vec3::new(
                2.1 * decay,
                0.8 * (s * 15.0).cos() * decay,
                (s * 4.0).cos() * decay,
            ),
            Vec3::new(0.2, 2.0 * decay, 0.4),
            if s < 0.7 { 3 } else { 1 },
            if s < 0.35 { 1 } else { 0 },
        )
    } else if id == 0 && t >= wake_time && t < wake_time + 0.8 {
        let s = t - wake_time;
        if s < dt * 1.5 {
            flags |= 64; // wake event
        }
        (
            offset + Vec3::new(1.5 + 0.8 * s, 0.32 + 1.8 * s - 4.0 * s * s, 0.0),
            Vec3::new(0.8, 1.8 - 8.0 * s, 0.0),
            Vec3::new(0.0, 2.0, 0.0),
            if s < 0.05 { 1 } else { 0 },
            0,
        )
    } else {
        if (t - settle_time).abs() < dt * 1.5 {
            flags |= 32; // informational native sleep event; classifier ignores sleep bit.
        }
        flags |= 1; // native sleeping state for static-root suppression coverage.
        (
            offset + Vec3::new(1.5, 0.32, 0.0),
            Vec3::ZERO,
            Vec3::ZERO,
            1,
            0,
        )
    };
    let angle = t * angular_velocity.y * 0.4 + (island % 7) as f32 * 0.2;
    ActorState {
        pose: Pose {
            position,
            rotation: Quat::from_euler(glam::EulerRot::XYZ, angle * 0.3, angle, angle * 0.1),
        },
        linear_velocity,
        angular_velocity,
        contacts,
        intact_joints,
        flags,
    }
}
