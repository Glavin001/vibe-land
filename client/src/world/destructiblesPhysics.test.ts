import { beforeAll, describe, expect, it } from 'vitest';
import { initWasmForTests, WasmSimWorld } from '../wasm/testInit';
import { serializeWorldDocument, type WorldDocument } from './worldDocument';

/** Mirror of `shared/src/constants.rs :: BTN_FORWARD`. */
const BTN_FORWARD = 1 << 0;

/**
 * Stride of the chunk transforms SoA produced by
 * `WasmSimWorld::getDestructibleChunkTransforms`.  Must stay in sync with
 * `CHUNK_TRANSFORM_STRIDE` in `shared/src/destructibles.rs`.
 */
const CHUNK_TRANSFORM_STRIDE = 11;

beforeAll(() => {
  initWasmForTests();
});

function makeFlatTileHeights(gridSize: number): number[] {
  return Array.from({ length: gridSize * gridSize }, () => 0);
}

function makeWallWorld(): WorldDocument {
  const gridSize = 9;
  return {
    version: 2,
    meta: {
      name: 'Wall Destructible Test World',
      description: 'Flat tile with a single Blast wall scenario placed above it.',
    },
    terrain: {
      tileGridSize: gridSize,
      tileHalfExtentM: 16,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights: makeFlatTileHeights(gridSize),
      }],
    },
    staticProps: [],
    dynamicEntities: [],
    destructibles: [
      {
        id: 7001,
        kind: 'wall',
        position: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
      },
    ],
  };
}

function makeTowerWorld(): WorldDocument {
  const gridSize = 9;
  return {
    version: 2,
    meta: {
      name: 'Tower Destructible Test World',
      description: 'Flat tile with a single Blast tower scenario placed above it.',
    },
    terrain: {
      tileGridSize: gridSize,
      tileHalfExtentM: 16,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights: makeFlatTileHeights(gridSize),
      }],
    },
    staticProps: [],
    dynamicEntities: [],
    destructibles: [
      {
        id: 7002,
        kind: 'tower',
        position: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
      },
    ],
  };
}

describe('Destructible scenarios (Blast stress solver)', () => {
  it('loads a wall from a world document and produces chunk transforms', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));
    sim.rebuildBroadPhase();

    expect(sim.getDestructibleInstanceCount()).toBe(1);

    // Priming step so the registry fills its chunk-transform buffer from
    // the initial Rapier body poses.  Before the first step the buffer is
    // empty by design.
    sim.stepDestructibles();

    const count = sim.getDestructibleChunkCount();
    expect(count).toBeGreaterThan(0);

    const transforms = sim.getDestructibleChunkTransforms();
    expect(transforms.length).toBe(count * CHUNK_TRANSFORM_STRIDE);

    // Every row should reference our destructible id in slot 0 and a
    // unit-ish quaternion in slots 5..8.
    const ids = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      const base = i * CHUNK_TRANSFORM_STRIDE;
      ids.add(transforms[base]);
      const qx = transforms[base + 5];
      const qy = transforms[base + 6];
      const qz = transforms[base + 7];
      const qw = transforms[base + 8];
      const qLen = Math.hypot(qx, qy, qz, qw);
      expect(Math.abs(qLen - 1)).toBeLessThan(1e-3);
    }
    expect([...ids]).toEqual([7001]);

    sim.free();
  });

  it('loads a tower with more chunks than a wall', () => {
    const wallSim = new WasmSimWorld();
    wallSim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));
    wallSim.stepDestructibles();
    const wallCount = wallSim.getDestructibleChunkCount();
    wallSim.free();

    const towerSim = new WasmSimWorld();
    towerSim.loadWorldDocument(serializeWorldDocument(makeTowerWorld()));
    towerSim.stepDestructibles();
    const towerCount = towerSim.getDestructibleChunkCount();
    towerSim.free();

    expect(wallCount).toBeGreaterThan(0);
    expect(towerCount).toBeGreaterThan(0);
    // Default TowerOptions produce more cells than default WallOptions
    // (tower is a full 3D grid, wall is a single-thickness slab).
    expect(towerCount).toBeGreaterThan(wallCount);
  });

  it('stepping the sim leaves bonded wall chunks near their spawn pose', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));
    sim.rebuildBroadPhase();

    sim.stepDestructibles();
    const count = sim.getDestructibleChunkCount();
    expect(count).toBeGreaterThan(0);
    const startTransforms = Float32Array.from(sim.getDestructibleChunkTransforms());

    // Run 60 ticks of the main dynamics pipeline.  With no external
    // contacts and no vehicle slamming into them, the stress solver
    // should keep every bonded chunk within a tiny epsilon of its
    // starting pose (supports hold it up; gravity is balanced by the
    // bond network).
    for (let step = 0; step < 60; step += 1) {
      sim.stepDynamics(1 / 60);
    }

    const endTransforms = sim.getDestructibleChunkTransforms();
    expect(endTransforms.length).toBe(startTransforms.length);

    let maxDelta = 0;
    for (let i = 0; i < count; i += 1) {
      const base = i * CHUNK_TRANSFORM_STRIDE;
      const dx = endTransforms[base + 2] - startTransforms[base + 2];
      const dy = endTransforms[base + 3] - startTransforms[base + 3];
      const dz = endTransforms[base + 4] - startTransforms[base + 4];
      const delta = Math.hypot(dx, dy, dz);
      if (delta > maxDelta) maxDelta = delta;
    }
    expect(maxDelta).toBeLessThan(0.25);

    sim.free();
  });

  it('driving a vehicle into a wall actually collides (not phased through)', () => {
    // Regression test for the `ActiveHooks::FILTER_CONTACT_PAIRS` bug.
    // Blast tags every chunk collider with `FILTER_CONTACT_PAIRS` so the
    // caller's `PhysicsHooks` can veto contacts; vibe-land passes `&()`
    // whose default impl rejects every pair, which made debug draw show
    // the chunks in the right place but let vehicles sail straight
    // through them.  This test spawns a destructible wall in the
    // vehicle's forward path, drives the vehicle forward for several
    // seconds, and compares against a control run with no wall.  If the
    // fix regresses, the vehicle travels roughly the same distance in
    // both sims and the assertion fires loudly.
    //
    // We deliberately *don't* assert that chunks get visibly displaced
    // from the impact: Blast's stress solver holds bonded chunks rigid
    // under non-fatal forces, so a single vehicle nudge can leave every
    // cell pinned at its spawn pose even though the collision reached
    // the solver.  "The vehicle stopped" is the real collision signal.

    // Identity rotation → chassis +Z is forward (see
    // `create_vehicle_physics` in shared/src/vehicle.rs:
    // `controller.index_forward_axis = 2`).
    const VEHICLE_ID = 91;
    const WALL_ID = 9001;
    const WALL_POSITION: [number, number, number] = [0, 0.5, 8];
    const VEHICLE_SPAWN: [number, number, number] = [0, 1.2, 0];
    const DT = 1 / 60;
    const DRIVE_TICKS = 240; // 4 seconds of driving

    function buildBase(): WorldDocument {
      const gridSize = 9;
      return {
        version: 2,
        meta: {
          name: 'Vehicle ramming a destructible wall',
          description: 'Flat tile with optional wall 8m in front of the vehicle.',
        },
        terrain: {
          tileGridSize: gridSize,
          tileHalfExtentM: 16,
          tiles: [{
            tileX: 0,
            tileZ: 0,
            heights: makeFlatTileHeights(gridSize),
          }],
        },
        staticProps: [],
        dynamicEntities: [],
        destructibles: [],
      };
    }

    function driveForwardFor(
      world: WorldDocument,
      ticks: number,
    ): { finalZ: number } {
      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(world));
      sim.rebuildBroadPhase();
      sim.spawnVehicle(
        VEHICLE_ID,
        0,
        VEHICLE_SPAWN[0],
        VEHICLE_SPAWN[1],
        VEHICLE_SPAWN[2],
        0, 0, 0, 1,
      );
      sim.setLocalVehicle(VEHICLE_ID);
      // Let gravity settle the chassis on the ground for a few ticks
      // before applying throttle — matches how practice spawn works.
      for (let t = 0; t < 10; t += 1) {
        sim.tickVehicle(t, 0, 0, 0, 0, 0, DT);
      }
      let finalZ = VEHICLE_SPAWN[2];
      for (let t = 0; t < ticks; t += 1) {
        const state = sim.tickVehicle(10 + t, BTN_FORWARD, 0, 0, 0, 0, DT);
        finalZ = state[2];
      }
      sim.free();
      return { finalZ };
    }

    // ── Control run: no wall in the way ─────────────────────────────
    const control = driveForwardFor(buildBase(), DRIVE_TICKS);

    // Sanity check that the vehicle actually accelerated forward at
    // all.  If this fails the test setup is broken, not the collision
    // path.
    expect(control.finalZ).toBeGreaterThan(2);

    // ── Wall run: same scenario, wall 8m ahead ──────────────────────
    const wallWorld = buildBase();
    wallWorld.destructibles = [
      {
        id: WALL_ID,
        kind: 'wall',
        position: WALL_POSITION,
        rotation: [0, 0, 0, 1],
      },
    ];

    const impact = driveForwardFor(wallWorld, DRIVE_TICKS);

    // ── Assertions ──────────────────────────────────────────────────
    // 1. The wall must have stopped / slowed the vehicle — its final
    //    Z with the wall present must be meaningfully smaller than
    //    the control run's final Z.  Before the fix both runs ended
    //    at essentially the same Z (the vehicle phased through the
    //    wall); this assertion fires within millimetres in that
    //    degenerate case.
    const travelDelta = control.finalZ - impact.finalZ;
    expect(travelDelta).toBeGreaterThan(1.0);

    // 2. The vehicle must not have ended up significantly past the
    //    wall's front face (wall centre at Z=8, ~0.5m thick).  If it
    //    did, the chassis phased through.
    expect(impact.finalZ).toBeLessThan(9.0);
  });

  it('a falling ball comes to rest on top of a destructible wall', () => {
    // Regression probe for the player / ball / vehicle contact path.
    // The vehicle case is covered by the `driving a vehicle into a wall`
    // test above — this one adds ball coverage because the user
    // reported that balls rolled straight through the wall.  A ball
    // dropped from well above the wall's top face should collide with
    // the chunk colliders and settle near the top, not pass straight
    // through to the terrain.
    const SHAPE_BALL = 1;
    const BALL_ID = 9100;
    const BALL_RADIUS = 0.3;
    const WALL_ID = 9101;
    // Wall default dims from shared/src/scenarios/wall.rs: span=6, height=3,
    // thickness=0.32.  Place it at y=0.5 so its top face is at ~y=3.5.
    const WALL_POSITION: [number, number, number] = [0, 0.5, 0];
    const DROP_HEIGHT = 8.0;
    const DT = 1 / 60;
    const STEPS = 240;

    function buildBase(): WorldDocument {
      const gridSize = 9;
      return {
        version: 2,
        meta: {
          name: 'Ball onto destructible wall',
          description: 'Flat tile with optional wall under the ball drop.',
        },
        terrain: {
          tileGridSize: gridSize,
          tileHalfExtentM: 16,
          tiles: [{
            tileX: 0,
            tileZ: 0,
            heights: makeFlatTileHeights(gridSize),
          }],
        },
        staticProps: [],
        dynamicEntities: [],
        destructibles: [],
      };
    }

    function dropBall(world: WorldDocument): { restY: number } {
      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(world));
      // Spawn ball directly above the wall centre.  `syncDynamicBody`
      // creates a dynamic rigid body at the first call.
      sim.syncDynamicBody(
        BALL_ID,
        SHAPE_BALL,
        BALL_RADIUS, 0, 0,
        0, DROP_HEIGHT, 0,
        0, 0, 0, 1,
        0, 0, 0,
        0, 0, 0,
      );
      sim.rebuildBroadPhase();
      for (let t = 0; t < STEPS; t += 1) {
        sim.stepDynamics(DT);
      }
      const state = sim.getDynamicBodyState(BALL_ID);
      const restY = state[1];
      sim.free();
      return { restY };
    }

    // Control: no wall — ball should fall all the way to the terrain.
    const control = dropBall(buildBase());
    expect(control.restY).toBeLessThan(1.0);

    // With wall: ball should land on or very close to the wall top
    // face (~y=3.5).  If the chunks silently reject contacts the ball
    // falls past them and ends up near the terrain just like the
    // control.
    const wallWorld = buildBase();
    wallWorld.destructibles = [
      {
        id: WALL_ID,
        kind: 'wall',
        position: WALL_POSITION,
        rotation: [0, 0, 0, 1],
      },
    ];
    const impact = dropBall(wallWorld);
    expect(impact.restY).toBeGreaterThan(2.5);
  });

  it('a player walking forward is stopped by a destructible wall', () => {
    // Regression probe for the player-capsule / KCC path.  The player
    // uses Rapier's `KinematicCharacterController` via shape-casts
    // through the query pipeline, which is a completely different
    // code path from the dynamic rigid-body pipeline the ball and
    // vehicle use.  At `yaw=0` the player's forward direction is +Z
    // (see `build_wish_dir` in shared/src/movement.rs).
    const BTN_FORWARD = 1 << 0;
    const WALL_ID = 9201;
    // Wall default thickness=0.32 → front face at z ≈ 4.84.  The
    // player spawn at z=0 has a clear 4m run-up.
    const WALL_POSITION: [number, number, number] = [0, 0.5, 5];
    const DT = 1 / 60;
    const STEPS = 240;

    function buildBase(): WorldDocument {
      const gridSize = 9;
      return {
        version: 2,
        meta: {
          name: 'Player walking into destructible wall',
          description: 'Flat tile with optional wall 5m in front of spawn.',
        },
        terrain: {
          tileGridSize: gridSize,
          tileHalfExtentM: 16,
          tiles: [{
            tileX: 0,
            tileZ: 0,
            heights: makeFlatTileHeights(gridSize),
          }],
        },
        staticProps: [],
        dynamicEntities: [],
        destructibles: [],
      };
    }

    function walkForward(world: WorldDocument): { finalZ: number } {
      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(world));
      sim.spawnPlayer(0, 2, 0);
      sim.rebuildBroadPhase();
      // Settle player onto the ground for a few ticks with no input.
      for (let t = 0; t < 10; t += 1) {
        sim.tick(t, 0, 0, 0, 0, 0, DT);
      }
      // Walk forward for the remainder of the budget.
      let finalZ = 0;
      for (let t = 0; t < STEPS; t += 1) {
        const state = sim.tick(10 + t, BTN_FORWARD, 0, 0, 0, 0, DT);
        finalZ = state[2];
      }
      sim.free();
      return { finalZ };
    }

    const control = walkForward(buildBase());
    // Player should have walked at least a few metres forward in the
    // control run — if not, test setup is broken.
    expect(control.finalZ).toBeGreaterThan(2);

    const wallWorld = buildBase();
    wallWorld.destructibles = [
      {
        id: WALL_ID,
        kind: 'wall',
        position: WALL_POSITION,
        rotation: [0, 0, 0, 1],
      },
    ];
    const impact = walkForward(wallWorld);

    // With the wall in place the player must stop short of the wall.
    // The wall front face is at ~z=4.84, minus a capsule radius of
    // ~0.4 → the capsule should halt somewhere around z ≤ 4.5.
    // Give a generous upper bound: 4.6 fires loudly if the KCC lets
    // the capsule walk straight through.
    expect(impact.finalZ).toBeLessThan(4.6);
  });

  it('despawn removes the destructible and clears the chunk buffer', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));

    expect(sim.getDestructibleInstanceCount()).toBe(1);
    const despawned = sim.despawnDestructible(7001);
    expect(despawned).toBe(true);
    expect(sim.getDestructibleInstanceCount()).toBe(0);

    sim.stepDestructibles();
    expect(sim.getDestructibleChunkCount()).toBe(0);
    expect(sim.getDestructibleChunkTransforms().length).toBe(0);

    sim.free();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Practice-mode placement regression tests
  //
  // The `/practice` route places destructibles at the coordinates in
  // `PRACTICE_DESTRUCTIBLES` inside `client/src/scene/GameWorld.tsx`:
  //
  //   Wall:  id=2000 kind=wall  position=(-6, 0, -6)
  //   Tower: id=2001 kind=tower position=(10, 0.5, -5)
  //
  // The tests above use origin-adjacent placements, which means a
  // translate-then-propagate bug in `spawn_scenario` could silently pass
  // them if the origin-aligned code path short-circuits.  These tests
  // mirror the exact production positions so we catch the same bug the
  // user hit in their browser.
  // ─────────────────────────────────────────────────────────────────────
  describe('practice-mode placement', () => {
    const PRACTICE_WALL_POSITION: [number, number, number] = [-6, 0, -6];
    const PRACTICE_TOWER_POSITION: [number, number, number] = [10, 0.5, -5];

    function buildPracticeBase(): WorldDocument {
      const gridSize = 9;
      return {
        version: 2,
        meta: {
          name: 'Practice-mode destructible placement',
          description: 'Mirrors client/src/scene/GameWorld.tsx PRACTICE_DESTRUCTIBLES.',
        },
        terrain: {
          tileGridSize: gridSize,
          tileHalfExtentM: 16,
          tiles: [{
            tileX: 0,
            tileZ: 0,
            heights: makeFlatTileHeights(gridSize),
          }],
        },
        staticProps: [],
        dynamicEntities: [],
        destructibles: [
          { id: 2000, kind: 'wall', position: PRACTICE_WALL_POSITION, rotation: [0, 0, 0, 1] },
          { id: 2001, kind: 'tower', position: PRACTICE_TOWER_POSITION, rotation: [0, 0, 0, 1] },
        ],
      };
    }

    it('chunk AABB wraps the requested world position (not origin)', () => {
      // The phase-through bug surfaced because Rapier collider world
      // positions stayed at origin after `rb.set_position` until the
      // next physics step.  If the fix regresses, every chunk's
      // reported world position will sit near (0, 0, 0) instead of
      // near the requested pose — this test pins that.
      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(buildPracticeBase()));
      sim.stepDestructibles();

      const transforms = sim.getDestructibleChunkTransforms();
      expect(transforms.length).toBeGreaterThan(0);

      // Partition by destructible id and compute per-instance AABB.
      const aabbs = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
      for (let i = 0; i < transforms.length; i += CHUNK_TRANSFORM_STRIDE) {
        const id = transforms[i];
        const px = transforms[i + 2];
        const py = transforms[i + 3];
        const pz = transforms[i + 4];
        let aabb = aabbs.get(id);
        if (!aabb) {
          aabb = {
            min: [px, py, pz],
            max: [px, py, pz],
          };
          aabbs.set(id, aabb);
        } else {
          if (px < aabb.min[0]) aabb.min[0] = px;
          if (py < aabb.min[1]) aabb.min[1] = py;
          if (pz < aabb.min[2]) aabb.min[2] = pz;
          if (px > aabb.max[0]) aabb.max[0] = px;
          if (py > aabb.max[1]) aabb.max[1] = py;
          if (pz > aabb.max[2]) aabb.max[2] = pz;
        }
      }

      const wallAabb = aabbs.get(2000);
      const towerAabb = aabbs.get(2001);
      expect(wallAabb).toBeDefined();
      expect(towerAabb).toBeDefined();

      // Wall: default WallOptions → span=6 along +X, thickness ≈ 0.32
      // along ±Z, height=3 along +Y.  Centered at X=-6, Z=-6, Y=0.
      // Chunk centroids span roughly:
      //   x ∈ [-6-3, -6+3] = [-9, -3]
      //   z ≈ -6 ± 0.16
      expect(wallAabb!.min[0]).toBeLessThan(-5);
      expect(wallAabb!.max[0]).toBeGreaterThan(-7);
      expect(wallAabb!.min[2]).toBeLessThan(-5);
      expect(wallAabb!.max[2]).toBeGreaterThan(-7);
      // Must NOT be at origin.
      expect(Math.abs(wallAabb!.min[0])).toBeGreaterThan(1);
      expect(Math.abs(wallAabb!.min[2])).toBeGreaterThan(1);

      // Tower: centered at X=10, Z=-5.
      expect(towerAabb!.min[0]).toBeGreaterThan(8);
      expect(towerAabb!.max[0]).toBeLessThan(12);
      expect(towerAabb!.min[2]).toBeGreaterThan(-7);
      expect(towerAabb!.max[2]).toBeLessThan(-3);

      sim.free();
    });

    it('describeDestructibles reports collider AABB at the practice pose', () => {
      // `describe` walks the actual Rapier collider set and reports
      // each instance's world-space AABB via `col.compute_aabb()`.
      // That's the exact buffer the broad-phase BVH indexes, so if
      // the described AABB is at origin while chunk *transforms* are
      // at the correct pose, the collider world positions are stale
      // and the KCC / broad-phase still can't see the chunks — the
      // phase-through we hit in production.
      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(buildPracticeBase()));
      const describe = sim.describeDestructibles();
      expect(describe.length).toBeGreaterThan(0);

      // The describe string embeds `aabb=(minX,minY,minZ)..(maxX,maxY,maxZ)`
      // per instance.  Parse each line and assert the wall/tower AABBs
      // straddle their requested pose.
      const lines = describe.trim().split('\n');
      // eslint-disable-next-line no-control-regex
      const aabbRe = /id=(\d+).*aabb=\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)\.\.\((-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)\)/;
      const parsed = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
      for (const line of lines) {
        const m = line.match(aabbRe);
        if (!m) continue;
        const id = parseInt(m[1], 10);
        parsed.set(id, {
          min: [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])],
          max: [parseFloat(m[5]), parseFloat(m[6]), parseFloat(m[7])],
        });
      }
      const wall = parsed.get(2000);
      const tower = parsed.get(2001);
      expect(wall).toBeDefined();
      expect(tower).toBeDefined();

      // Wall default span=6 in X, thickness≈0.32 in Z, centred at
      // (-6, *, -6).  AABB should roughly wrap
      //   x ∈ [-9 ± pad, -3 ± pad]
      //   z ∈ [-6.16 ± pad, -5.84 ± pad]
      // Assert the AABB is centred near (-6, *, -6) and cannot reach
      // origin (+/- 1m).
      const wallCentreX = (wall!.min[0] + wall!.max[0]) / 2;
      const wallCentreZ = (wall!.min[2] + wall!.max[2]) / 2;
      expect(Math.abs(wallCentreX - -6)).toBeLessThan(0.5);
      expect(Math.abs(wallCentreZ - -6)).toBeLessThan(0.5);
      expect(wall!.max[0]).toBeLessThan(-2); // never reaches origin
      expect(wall!.max[2]).toBeLessThan(-5); // never reaches origin

      // Tower centred at (10, *, -5).  AABB should wrap that.
      const towerCentreX = (tower!.min[0] + tower!.max[0]) / 2;
      const towerCentreZ = (tower!.min[2] + tower!.max[2]) / 2;
      expect(Math.abs(towerCentreX - 10)).toBeLessThan(1.5);
      expect(Math.abs(towerCentreZ - -5)).toBeLessThan(1.5);
      expect(tower!.min[0]).toBeGreaterThan(8);
      expect(tower!.max[2]).toBeLessThan(-3);

      sim.free();
    });

    it('a player walking toward the practice wall is stopped before passing through', () => {
      // Mirrors the exact practice placement to rule out any
      // position-dependent bug: the production wall is centred at
      // (-6, 0, -6).  Spawn the player near the +X side of the wall
      // and walk them in -X towards it.  At yaw=-π/2 the player's
      // forward direction is -X.  Assert the capsule can't push
      // through past the wall's east face.
      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(buildPracticeBase()));
      // Spawn player east of the wall, level with its Z.
      sim.spawnPlayer(0, 2, -6);
      sim.rebuildBroadPhase();
      // Settle.
      for (let t = 0; t < 10; t += 1) {
        sim.tick(t, 0, 0, 0, 0, 0, 1 / 60);
      }
      // yaw = -π/2 → wish_dir ≈ (-1, 0, 0) in world space.
      // `sim.tick(frame, buttons, dyaw, dpitch, yaw, pitch, dt)` —
      // see WasmSimWorld in netcode.  We use dyaw to set absolute
      // yaw via the mouse delta integrator, which isn't appropriate
      // here.  Instead spawn player with `spawnPlayer` then rely on
      // `setYaw`/`setPitch` if exposed, otherwise accept that the
      // default yaw walks in +Z.  Fall back to walking in +Z from a
      // shifted spawn so the wall at (-6, 0, -6) is straight ahead.
      sim.free();

      // Do the actual collision check with a spawn directly south of
      // the wall at (-6, 2, -10), walking +Z so we drive towards
      // (-6, *, -6).  This is the production geometry the user hits.
      const sim2 = new WasmSimWorld();
      sim2.loadWorldDocument(serializeWorldDocument(buildPracticeBase()));
      sim2.spawnPlayer(-6, 2, -10);
      sim2.rebuildBroadPhase();
      for (let t = 0; t < 10; t += 1) {
        sim2.tick(t, 0, 0, 0, 0, 0, 1 / 60);
      }
      let maxZ = -10;
      for (let t = 0; t < 300; t += 1) {
        const state = sim2.tick(10 + t, BTN_FORWARD, 0, 0, 0, 0, 1 / 60);
        const z = state[2];
        if (z > maxZ) maxZ = z;
      }
      // Wall centre Z=-6, half thickness ≈ 0.16 → front face at z ≈ -6.16.
      // Minus capsule radius ≈ 0.4 → capsule must stop at z ≤ -6.5.
      // Generous upper bound rules out phasing.
      expect(maxZ).toBeLessThan(-6.0);
      sim2.free();
    });

    it('a ball dropped on the practice wall rests on top (never below wall base)', () => {
      // Non-penetration assertion: track the ball's minimum Y across
      // the whole drop simulation.  If the ball phases through, its
      // y will dip below the wall's top face.  With wall at y=0,
      // height=3, top face ≈ y=3.  Ball radius 0.3 → ball centre at
      // rest should sit near y ≈ 3.3.
      const SHAPE_BALL = 1;
      const BALL_ID = 9500;
      const BALL_RADIUS = 0.3;
      const DROP_HEIGHT = 6.0;
      const DT = 1 / 60;

      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(buildPracticeBase()));
      // Drop the ball directly above the wall centre at (-6, *, -6).
      sim.syncDynamicBody(
        BALL_ID, SHAPE_BALL,
        BALL_RADIUS, 0, 0,
        -6, DROP_HEIGHT, -6,
        0, 0, 0, 1,
        0, 0, 0,
        0, 0, 0,
      );
      sim.rebuildBroadPhase();

      let minY = DROP_HEIGHT;
      for (let t = 0; t < 300; t += 1) {
        sim.stepDynamics(DT);
        const state = sim.getDynamicBodyState(BALL_ID);
        if (state[1] < minY) minY = state[1];
      }
      const finalState = sim.getDynamicBodyState(BALL_ID);
      const restY = finalState[1];

      // Strict non-penetration: ball must never dip below the wall's
      // top face more than a small penetration margin.  Wall top
      // sits at y ≈ 3 (position y=0, height=3).  Allow 0.35 of soft
      // penetration for numerical settling.
      expect(minY).toBeGreaterThan(2.6);
      // Rest position must be at or above the wall top.
      expect(restY).toBeGreaterThan(2.8);

      sim.free();
    });

    it('a ball dropped on the practice tower rests above the tower base', () => {
      // Same non-penetration probe but for the tower.  Default
      // TowerOptions produce a block roughly 2m×4m×2m placed at
      // (10, 0.5, -5).  Drop above the top face.
      const SHAPE_BALL = 1;
      const BALL_ID = 9501;
      const BALL_RADIUS = 0.3;
      const DROP_HEIGHT = 10.0;
      const DT = 1 / 60;

      const sim = new WasmSimWorld();
      sim.loadWorldDocument(serializeWorldDocument(buildPracticeBase()));
      sim.syncDynamicBody(
        BALL_ID, SHAPE_BALL,
        BALL_RADIUS, 0, 0,
        10, DROP_HEIGHT, -5,
        0, 0, 0, 1,
        0, 0, 0,
        0, 0, 0,
      );
      sim.rebuildBroadPhase();

      let minY = DROP_HEIGHT;
      for (let t = 0; t < 300; t += 1) {
        sim.stepDynamics(DT);
        const state = sim.getDynamicBodyState(BALL_ID);
        if (state[1] < minY) minY = state[1];
      }
      const finalState = sim.getDynamicBodyState(BALL_ID);
      const restY = finalState[1];

      // Tower base y=0.5, height ≈ 4 → top ≈ y=4.5.  Ball must rest
      // above the tower base (conservatively above y=1).  Strict:
      // never dips near the terrain (y=0).
      expect(minY).toBeGreaterThan(0.5);
      expect(restY).toBeGreaterThan(1.0);

      sim.free();
    });
  });
});
