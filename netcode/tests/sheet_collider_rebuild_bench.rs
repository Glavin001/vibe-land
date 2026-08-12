
//! Perf probe: how expensive is swapping sheet colliders in Rapier?
//! Run: cargo test -p vibe-netcode --release --test sheet_collider_rebuild_bench -- --nocapture

use nalgebra::Point3;
use std::time::Instant;
use vibe_netcode::movement::MoveConfig;
use vibe_netcode::sim_world::SimWorld;

fn new_sim() -> SimWorld {
    SimWorld::new(MoveConfig::default())
}

fn make_wall_boxes(nx: usize, ny: usize, cell: f32, thickness: f32) -> Vec<([f32; 3], [f32; 3])> {
    // Returns (center, half_extents) for solid cells missing a doorway hole in the middle.
    let mut out = Vec::new();
    let hx = cell * 0.5;
    let hy = cell * 0.5;
    let hz = thickness * 0.5;
    let hole_x0 = nx / 3;
    let hole_x1 = (2 * nx) / 3;
    let hole_y0 = ny / 4;
    let hole_y1 = (3 * ny) / 4;
    for y in 0..ny {
        for x in 0..nx {
            let in_hole = x >= hole_x0 && x < hole_x1 && y >= hole_y0 && y < hole_y1;
            if in_hole {
                continue;
            }
            let cx = (x as f32 + 0.5) * cell;
            let cy = (y as f32 + 0.5) * cell;
            out.push(([cx, cy, 0.0], [hx, hy, hz]));
        }
    }
    out
}

fn greedy_merge(nx: usize, ny: usize, cell: f32, thickness: f32) -> Vec<([f32; 3], [f32; 3])> {
    let hole_x0 = nx / 3;
    let hole_x1 = (2 * nx) / 3;
    let hole_y0 = ny / 4;
    let hole_y1 = (3 * ny) / 4;
    let mut solid = vec![true; nx * ny];
    for y in hole_y0..hole_y1 {
        for x in hole_x0..hole_x1 {
            solid[y * nx + x] = false;
        }
    }
    let mut visited = vec![false; nx * ny];
    let mut boxes = Vec::new();
    let hz = thickness * 0.5;
    for y0 in 0..ny {
        let mut x0 = 0;
        while x0 < nx {
            let i = y0 * nx + x0;
            if !solid[i] || visited[i] {
                x0 += 1;
                continue;
            }
            let mut x1 = x0 + 1;
            while x1 < nx && solid[y0 * nx + x1] && !visited[y0 * nx + x1] {
                x1 += 1;
            }
            let mut y1 = y0 + 1;
            'grow: while y1 < ny {
                for x in x0..x1 {
                    if !solid[y1 * nx + x] || visited[y1 * nx + x] {
                        break 'grow;
                    }
                }
                y1 += 1;
            }
            for y in y0..y1 {
                for x in x0..x1 {
                    visited[y * nx + x] = true;
                }
            }
            let min_u = x0 as f32 * cell;
            let max_u = x1 as f32 * cell;
            let min_v = y0 as f32 * cell;
            let max_v = y1 as f32 * cell;
            boxes.push((
                [(min_u + max_u) * 0.5, (min_v + max_v) * 0.5, 0.0],
                [(max_u - min_u) * 0.5, (max_v - min_v) * 0.5, hz],
            ));
            x0 = x1;
        }
    }
    boxes
}

fn trimesh_from_boxes(boxes: &[([f32; 3], [f32; 3])]) -> (Vec<Point3<f32>>, Vec<[u32; 3]>) {
    let mut verts = Vec::new();
    let mut tris = Vec::new();
    for &(c, h) in boxes {
        let base = verts.len() as u32;
        let corners = [
            [c[0] - h[0], c[1] - h[1], c[2] - h[2]],
            [c[0] + h[0], c[1] - h[1], c[2] - h[2]],
            [c[0] + h[0], c[1] + h[1], c[2] - h[2]],
            [c[0] - h[0], c[1] + h[1], c[2] - h[2]],
            [c[0] - h[0], c[1] - h[1], c[2] + h[2]],
            [c[0] + h[0], c[1] - h[1], c[2] + h[2]],
            [c[0] + h[0], c[1] + h[1], c[2] + h[2]],
            [c[0] - h[0], c[1] + h[1], c[2] + h[2]],
        ];
        for p in corners {
            verts.push(Point3::new(p[0], p[1], p[2]));
        }
        const FACES: [[u32; 3]; 12] = [
            [0, 1, 2], [0, 2, 3],
            [4, 6, 5], [4, 7, 6],
            [0, 4, 5], [0, 5, 1],
            [2, 6, 7], [2, 7, 3],
            [0, 3, 7], [0, 7, 4],
            [1, 5, 6], [1, 6, 2],
        ];
        for f in FACES {
            tris.push([base + f[0], base + f[1], base + f[2]]);
        }
    }
    (verts, tris)
}

fn bench_cuboid_swap(iters: usize, boxes: &[([f32; 3], [f32; 3])]) -> f64 {
    let mut sim = new_sim();
    let mut handles = Vec::new();
    for &(c, h) in boxes {
        handles.push(sim.add_static_cuboid(
            nalgebra::Vector3::new(c[0], c[1], c[2]),
            nalgebra::Vector3::new(h[0], h[1], h[2]),
            1,
        ));
    }
    sim.rebuild_broad_phase();
    let t0 = Instant::now();
    for _ in 0..iters {
        for h in handles.drain(..) {
            sim.remove_collider(h);
        }
        for &(c, h) in boxes {
            handles.push(sim.add_static_cuboid(
                nalgebra::Vector3::new(c[0], c[1], c[2]),
                nalgebra::Vector3::new(h[0], h[1], h[2]),
                1,
            ));
        }
        sim.rebuild_broad_phase();
    }
    t0.elapsed().as_secs_f64() * 1000.0 / iters as f64
}

fn bench_trimesh_swap(iters: usize, boxes: &[([f32; 3], [f32; 3])]) -> f64 {
    let (verts, tris) = trimesh_from_boxes(boxes);
    let mut sim = new_sim();
    let mut handle = sim.add_static_trimesh(verts.clone(), tris.clone(), 1);
    sim.rebuild_broad_phase();
    let t0 = Instant::now();
    for _ in 0..iters {
        sim.remove_collider(handle);
        handle = sim.add_static_trimesh(verts.clone(), tris.clone(), 1);
        sim.rebuild_broad_phase();
    }
    t0.elapsed().as_secs_f64() * 1000.0 / iters as f64
}

#[test]
fn report_sheet_collider_rebuild_costs() {
    let cases = [
        ("coarse 8x6 doorway, per-cell boxes", 8, 6, 0.35, false),
        ("coarse 8x6 doorway, greedy boxes", 8, 6, 0.35, true),
        ("coarse 16x12 doorway, greedy boxes", 16, 12, 0.25, true),
        ("coarse 24x16 doorway, greedy boxes", 24, 16, 0.20, true),
        ("fine-ish 40x28 doorway, greedy boxes", 40, 28, 0.10, true),
    ];
    println!("\n=== Sheet collider rebuild bench (ms / rebuild, release) ===");
    for (label, nx, ny, cell, greedy) in cases {
        let boxes = if greedy {
            greedy_merge(nx, ny, cell, 0.16)
        } else {
            make_wall_boxes(nx, ny, cell, 0.16)
        };
        let iters = 80;
        let cuboid_ms = bench_cuboid_swap(iters, &boxes);
        let trimesh_ms = bench_trimesh_swap(iters, &boxes);
        println!(
            "{label}: boxes={} | cuboid-set swap={cuboid_ms:.3} ms | trimesh swap={trimesh_ms:.3} ms",
            boxes.len()
        );
    }
    println!("=== end ===\n");
}
