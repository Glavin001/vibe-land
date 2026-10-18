//! Offline "exact island while intact" proxy.
//!
//! Rewrites a TWTRACE1 v3 D6 tower into a Blast-style exact-compound trace:
//! unbroken welded components keep fixed child locals baked at membership
//! time, edge kinds become 2, and child poses are snapped to
//! `compose(root, local)` until the island splits. This answers "how much
//! would hierarchy win if joints were true rigid compounds?" — it changes
//! ground truth relative to PhysX solver drift.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use anyhow::{ensure, Result};
use serde::Serialize;

use crate::{
    hierarchy::{compose_pose, relative_pose},
    trace::{Pose, TopologyEdge, TraceReader, TraceTopology, TraceWriter},
};

#[derive(Clone, Debug, Serialize)]
pub struct ExactIslandProxyReport {
    pub source_trace: String,
    pub output_trace: String,
    pub actors: usize,
    pub durable_edges: usize,
    pub ticks: u32,
    pub snapped_child_pose_samples: u64,
    pub free_or_root_pose_samples: u64,
    pub max_snap_shell_m: f64,
    pub mean_snap_shell_m: f64,
    pub note: &'static str,
}

pub fn write_exact_island_proxy(source: &Path, output: &Path) -> Result<ExactIslandProxyReport> {
    let mut reader = TraceReader::open(source)?;
    ensure!(
        !reader.topology.edges.is_empty(),
        "exact-island proxy requires TWTRACE1 v3 topology edges"
    );
    let header = reader.header.clone();
    let actors = reader.actors.clone();
    let mut edges: Vec<TopologyEdge> = reader
        .topology
        .edges
        .iter()
        .map(|edge| TopologyEdge {
            global_id: edge.global_id,
            first: edge.first,
            second: edge.second,
            kind: 2,
        })
        .collect();
    edges.sort_by_key(|edge| edge.global_id);
    let topology = TraceTopology {
        actor_global_ids: reader.topology.actor_global_ids.clone(),
        edges: edges.clone(),
    };
    let edge_by_id: BTreeMap<u64, &TopologyEdge> = topology
        .edges
        .iter()
        .map(|edge| (edge.global_id, edge))
        .collect();

    let mut writer = TraceWriter::create_with_topology(output, &header, &actors, &topology)?;
    let mut broken = BTreeSet::<u64>::new();
    let mut baked_locals = vec![Pose::default(); actors.len()];
    let mut has_local = vec![false; actors.len()];
    let mut component_root = vec![0_u32; actors.len()];
    let mut parent = vec![0_u32; actors.len()];
    let mut snapped = 0_u64;
    let mut free = 0_u64;
    let mut snap_shell_sum = 0.0_f64;
    let mut max_snap_shell = 0.0_f32;

    while let Some(mut tick) = reader.next_tick()? {
        for &edge_id in &tick.topology.broken_edges {
            broken.insert(edge_id);
        }
        let prev_roots = tick.topology.island_roots.clone();
        rebuild_components(
            actors.len(),
            &topology.edges,
            &broken,
            &prev_roots,
            &mut parent,
            &mut component_root,
        );
        // Hierarchy encode keys off island_roots; keep them aligned with the
        // unbroken durable components we snap against. Tick 0 must emit a
        // complete actor→root map (TWTRACE1 v3).
        let mut changed_roots = Vec::new();
        for actor in 0..actors.len() {
            let root = component_root[actor];
            if tick.index == 0 || prev_roots[actor] != root {
                changed_roots.push((actor as u32, root));
            }
            tick.topology.island_roots[actor] = root;
        }
        tick.topology.changed_roots = changed_roots;

        for actor in 0..actors.len() {
            let root = component_root[actor];
            if actor as u32 == root {
                has_local[actor] = false;
                free += 1;
                continue;
            }
            let needs_bake = !has_local[actor]
                || prev_roots[actor] != root
                || tick
                    .topology
                    .changed_roots
                    .iter()
                    .any(|&(changed, _)| changed == actor as u32);
            if needs_bake {
                baked_locals[actor] =
                    relative_pose(tick.states[root as usize].pose, tick.states[actor].pose);
                has_local[actor] = true;
            }
            let exact = compose_pose(tick.states[root as usize].pose, baked_locals[actor]);
            let shell = rigid_shell_proxy(
                tick.states[actor].pose,
                exact,
                actors[actor].bounding_radius,
            );
            max_snap_shell = max_snap_shell.max(shell);
            snap_shell_sum += shell as f64;
            tick.states[actor].pose = exact;
            // Keep velocity of the root so the glued child tracks the compound.
            tick.states[actor].linear_velocity = tick.states[root as usize].linear_velocity;
            tick.states[actor].angular_velocity = tick.states[root as usize].angular_velocity;
            snapped += 1;
        }
        // Validate broken-edge IDs still refer to manifest edges.
        for &edge_id in &tick.topology.broken_edges {
            ensure!(
                edge_by_id.contains_key(&edge_id),
                "unknown broken edge {edge_id} at tick {}",
                tick.index
            );
        }
        writer.write_tick(&tick)?;
    }
    reader.finish()?;
    writer.finish()?;

    let samples = snapped.max(1);
    Ok(ExactIslandProxyReport {
        source_trace: source.display().to_string(),
        output_trace: output.display().to_string(),
        actors: actors.len(),
        durable_edges: topology.edges.len(),
        ticks: header.tick_count,
        snapped_child_pose_samples: snapped,
        free_or_root_pose_samples: free,
        max_snap_shell_m: max_snap_shell as f64,
        mean_snap_shell_m: snap_shell_sum / samples as f64,
        note: "Proxy changes ground truth: children are rigidly glued while unbroken. Use for hierarchy upside measurement, not PhysX fidelity.",
    })
}

fn rebuild_components(
    actor_count: usize,
    edges: &[TopologyEdge],
    broken: &BTreeSet<u64>,
    island_roots: &[u32],
    parent: &mut [u32],
    component_root: &mut [u32],
) {
    debug_assert_eq!(parent.len(), actor_count);
    debug_assert_eq!(component_root.len(), actor_count);
    debug_assert_eq!(island_roots.len(), actor_count);
    for (i, slot) in parent.iter_mut().enumerate() {
        *slot = i as u32;
    }
    for edge in edges {
        if broken.contains(&edge.global_id) {
            continue;
        }
        union(parent, edge.first, edge.second);
    }
    for (actor, slot) in component_root.iter_mut().enumerate() {
        let rep = find(parent, actor as u32);
        let preferred = island_roots[actor];
        *slot = if find(parent, preferred) == rep {
            preferred
        } else {
            // Prefer the lowest actor id in the unbroken durable component.
            rep
        };
    }
    // Collapse every member onto one canonical root (min preferred root in set).
    let mut canon = vec![u32::MAX; actor_count];
    for (actor, &root) in component_root.iter().enumerate() {
        let rep = find(parent, actor as u32) as usize;
        canon[rep] = canon[rep].min(root);
    }
    for (actor, slot) in component_root.iter_mut().enumerate() {
        let rep = find(parent, actor as u32) as usize;
        *slot = canon[rep];
    }
}

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        let p = parent[x as usize];
        parent[x as usize] = parent[p as usize];
        x = p;
    }
    x
}

fn union(parent: &mut [u32], a: u32, b: u32) {
    let ra = find(parent, a);
    let rb = find(parent, b);
    if ra == rb {
        return;
    }
    // Keep the lower id as representative for stable roots.
    if ra < rb {
        parent[rb as usize] = ra;
    } else {
        parent[ra as usize] = rb;
    }
}

fn rigid_shell_proxy(truth: Pose, predicted: Pose, radius: f32) -> f32 {
    let translation = truth.position.distance(predicted.position);
    let angle = truth
        .rotation
        .normalize()
        .angle_between(predicted.rotation.normalize());
    translation + angle * radius
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::write_topology_fixture;

    #[test]
    fn exact_proxy_marks_edges_kind_two() {
        let dir = std::env::temp_dir().join(format!("exact-island-proxy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("d6.towertrace");
        let output = dir.join("exact.towertrace");
        write_topology_fixture(&source, 60, 3.0, false, 4, 2).unwrap();
        let report = write_exact_island_proxy(&source, &output).unwrap();
        assert!(report.durable_edges > 0);
        let mut reader = TraceReader::open(&output).unwrap();
        assert!(reader.topology.edges.iter().all(|edge| edge.kind == 2));
        while reader.next_tick().unwrap().is_some() {}
        reader.finish().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
