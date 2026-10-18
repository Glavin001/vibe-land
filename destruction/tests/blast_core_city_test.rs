//! `/city` destruction driven by the standardized blast-stress-solver core,
//! inside the PxScene the game already owns.
//!
//! This is the integration the upgrade is for. The library borrows the scene
//! that players and vehicles live in, instantiates the city from the same scene
//! pack `/city` ships, and fractures it — with none of the snapshot diffing,
//! hand-rolled island serials or copied thread pool the bespoke path needs.

#![cfg(feature = "blast-core")]

use std::path::PathBuf;

use vibe_land_destruction::core_runtime::CoreCityDestruction;
use vibe_land_physx_bridge::{World, WorldConfig};

const G: [f32; 3] = [0.0, -9.81, 0.0];

fn scene_pack(name: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("assets/scenes");
    p.push(name);
    p
}

/// The game's world. Requires a GPU scene, as `/city` does in production.
fn host_world() -> Option<World> {
    World::new(WorldConfig::default()).ok()
}

#[test]
fn the_core_attaches_to_the_games_own_scene() {
    let Some(world) = host_world() else {
        eprintln!("no GPU PhysX scene available; skipping");
        return;
    };
    let scene = world.scene_ptr().expect("scene ptr");
    let physics = world.physics_ptr().expect("physics ptr");
    assert_ne!(scene, 0, "the game's scene pointer must be real");
    assert_ne!(physics, 0);

    let d = unsafe {
        CoreCityDestruction::attach(scene, physics, &scene_pack("high-rise-3f-local.json"), G)
    }
    .expect("core must attach to the host scene");

    // One body per solver actor is the invariant the whole pipeline rests on.
    assert_eq!(
        d.body_count(),
        d.actor_count() as usize,
        "attach must leave one body per actor"
    );
    assert!(d.actor_count() >= 1);
    // Attached to a GPU scene, the backend should report GPU.
    assert!(d.gpu_active(), "the host scene is GPU, so the attached backend should say so");
}

#[test]
fn an_authored_building_stands_in_the_games_scene() {
    let Some(mut world) = host_world() else {
        eprintln!("no GPU PhysX scene available; skipping");
        return;
    };
    let (scene, physics) = (world.scene_ptr().unwrap(), world.physics_ptr().unwrap());
    let mut d = unsafe {
        CoreCityDestruction::attach(scene, physics, &scene_pack("high-rise-3f-local.json"), G)
    }
    .expect("attach");

    // The GAME drives the clock; the library never steps the shared scene.
    for _ in 0..90 {
        world.step().expect("host step");
        d.post_step(1.0 / 60.0);
    }

    let t = d.totals();
    assert_eq!(
        t.fractures, 0,
        "an authored high-rise must not collapse under its own weight: {t:?}"
    );
    assert_eq!(d.actor_count(), 1, "structure fragmented with no load applied");
    assert_eq!(d.body_count(), d.actor_count() as usize);
}

#[test]
fn a_load_fractures_the_building_in_the_games_scene() {
    let Some(mut world) = host_world() else {
        eprintln!("no GPU PhysX scene available; skipping");
        return;
    };
    let (scene, physics) = (world.scene_ptr().unwrap(), world.physics_ptr().unwrap());
    let mut d = unsafe {
        CoreCityDestruction::attach(scene, physics, &scene_pack("high-rise-3f-local.json"), G)
    }
    .expect("attach");

    for f in 0..90 {
        if f == 5 {
            // The hitscan path exactly: pick the node nearest the impact point,
            // then drive the load through it. Aiming at a support node would be
            // silently absorbed, which is why the lookup skips them.
            let at = [0.0, 6.0, 0.0];
            let node = d.nearest_node(at).expect("a load-bearing node near the impact");
            d.apply_force_at_node(node, at, [0.0, 0.0, 3.0e9]);
        }
        world.step().expect("host step");
        d.post_step(1.0 / 60.0);
    }

    let t = d.totals();
    eprintln!("[blast-core] {t:?} actors={} bodies={}", d.actor_count(), d.body_count());
    assert!(t.fractures > 0, "the load did not break anything: {t:?}");
    assert!(t.splits > 0, "fractures produced no split events: {t:?}");
    assert!(t.bodies_created > 0, "no fragment bodies were created: {t:?}");
    assert_eq!(
        d.body_count(),
        d.actor_count() as usize,
        "body/actor bookkeeping diverged after fracture"
    );
}

/// The output netcode already consumes, produced natively instead of by
/// diffing snapshots.
///
/// This is the migration's actual claim. `runtime.rs::post_step` builds a
/// `DestructionTickOutput` by comparing this tick's PhysX snapshot against
/// last tick's -- ~500 lines and an O(bonds) scan over 74k bonds -- to
/// rediscover what the split path already knew. Here the pipeline emits it and
/// the adapter only renames fields. Netcode is untouched either way.
#[test]
fn the_core_path_produces_the_stream_netcode_consumes() {
    let Some(world) = host_world() else {
        eprintln!("no GPU PhysX scene available; skipping");
        return;
    };
    let scene = world.scene_ptr().expect("scene ptr");
    let physics = world.physics_ptr().expect("physics ptr");
    let mut city = unsafe {
        CoreCityDestruction::attach(scene, physics, &scene_pack("high-rise-3f-local.json"), G)
    }
    .expect("attach to the host scene");
    // 1083 bonds in this pack. Read from the file so the bound below is the
    // real one rather than a copied number that rots.
    let total_bonds = {
        let text = std::fs::read_to_string(scene_pack("high-rise-3f-local.json")).unwrap();
        text.matches("\"node0\"").count()
    };
    assert!(total_bonds > 0, "could not count the pack's bonds");

    let mut promoted: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    let mut retired: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    let mut settled: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    let mut migrations = 0usize;
    let mut any_mass = false;
    let mut broken = 0usize;
    let mut bond_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();

    for f in 0..240 {
        if f == 5 {
            // Without a load the strong pack barely fractures and the stream is
            // never really exercised: the first version of this test saw one
            // break and one promotion, and would have passed with migrations,
            // retirements and settles all permanently empty.
            let at = [0.0, 6.0, 0.0];
            let node = city.nearest_node(at).expect("a load-bearing node");
            city.apply_force_at_node(node, at, [0.0, 0.0, 3.0e9]);
        }
        let (_, out, overflow) = city.post_step_output(1.0 / 60.0);
        assert_eq!(
            (overflow.islands, overflow.chunks),
            (0, 0),
            "ids overflowed the wire fields; they are dropped, never truncated, \
             so this is lost events rather than corrupted ones"
        );
        for b in &out.batches {
            broken += b.broken_bond_ids.len();
            for id in &b.broken_bond_ids {
                assert!(
                    bond_ids.insert(*id),
                    "bond {id} reported broken twice -- a bond cannot break again"
                );
            }
            migrations += b.migrations.len();
            for p in &b.promoted_islands {
                assert!(
                    promoted.insert((p.structure_id, p.island_id)),
                    "island {} promoted twice",
                    p.island_id
                );
                assert!(!p.chunks.is_empty(), "an island was promoted with no chunks");
                // Zero is legitimate and specifically means "anchored": the
                // library identifies a support node by its zero mass, so an
                // island made only of support nodes sums to zero. Those never
                // go on the wire. What must never happen is a negative or
                // non-finite mass, and at least one island must carry some.
                assert!(
                    p.mass >= 0.0 && p.mass.is_finite(),
                    "island {} has mass {}",
                    p.island_id,
                    p.mass
                );
                if p.mass > 0.0 {
                    any_mass = true;
                }
                assert!(
                    p.position.iter().all(|v| v.is_finite())
                        && p.rotation.iter().all(|v| v.is_finite()),
                    "island {} has a non-finite pose",
                    p.island_id
                );
                // COM-frame, so the promotion pose sits inside the structure
                // rather than at the actor origin down at ground level.
                assert!(
                    p.center_of_mass == p.position,
                    "center_of_mass must be the COM-frame pose translation"
                );
            }
            for m in &b.migrations {
                assert!(
                    promoted.contains(&(b.structure_id, m.to_island_id)),
                    "chunk {} migrated onto island {} which was never promoted",
                    m.chunk_id,
                    m.to_island_id
                );
            }
            for id in &b.retired_island_ids {
                assert!(
                    promoted.contains(&(b.structure_id, *id)),
                    "island {id} retired without ever being promoted"
                );
                assert!(retired.insert((b.structure_id, *id)), "island {id} retired twice");
            }
        }
        for s in &out.settled {
            assert!(
                promoted.contains(&(s.structure_id, s.island_id)),
                "island {} settled without ever being promoted",
                s.island_id
            );
            assert!(
                s.position.iter().all(|v| v.is_finite()),
                "settle record for island {} has a non-finite pose",
                s.island_id
            );
            settled.insert((s.structure_id, s.island_id));
        }
        for (structure, island) in &out.wakes {
            assert!(
                settled.contains(&(*structure, *island)),
                "island {island} woke without having settled -- a wake is only \
                 meaningful against a settle the client already acted on"
            );
            settled.remove(&(*structure, *island));
        }
    }

    assert!(broken > 0, "the building never fractured, so the stream was never exercised");
    assert!(
        broken <= total_bonds,
        "{broken} bond breaks reported against {total_bonds} bonds -- a bond \
         cannot break more than once, so this is damage being counted as breakage"
    );
    assert!(!promoted.is_empty(), "nothing was promoted");
    assert!(any_mass, "every promoted island reported zero mass");
    assert!(migrations > 0, "no chunk ever changed island");
    assert!(
        retired.is_subset(&promoted),
        "a retired island was never promoted"
    );
    println!(
        "[core->netcode] {broken} bond breaks, {} promotions, {migrations} migrations, \
         {} retirements, {} settles",
        promoted.len(),
        retired.len(),
        settled.len()
    );
}
