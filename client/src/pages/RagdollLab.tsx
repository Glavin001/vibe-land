// Ragdoll Lab — a standalone demo route (/ragdoll-lab) for exercising the
// animated → ragdoll death transition in controlled scenarios, without having to
// play the game (shoot / drive / get hit). It reuses the real production pieces:
//   • createRemotePlayer()  — the animated character rig + Ragdoll
//   • CosmeticPhysicsWorld  — the client-local Rapier (WASM) physics world
// so what you see here is exactly what runs in-game on death.
//
// Scenarios: idle collapse, run & tumble, fall from height, hit by a "car".
// Extras: freeze toggle (pause physics to inspect the snapshot precision),
// animate↔ragdoll↔respawn, slow-mo time scale, and orbit camera.
import { type CSSProperties, type MutableRefObject, useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, Sky } from '@react-three/drei';
import * as THREE from 'three';
import { CosmeticPhysicsWorld } from '../runtime/cosmeticPhysicsWorld';
import { createRemotePlayer, type RemotePlayerHandle } from '../scene/characterAnim/CharacterFactory';
import { STATE } from '../scene/characterAnim/types';
import type { GameRuntimeClient } from '../runtime/gameRuntime';

// Spawn on the flat centre of the demo heightfield (terrain height ≈ 0 within a
// 16 m radius of this point — see shared/src/terrain.rs).
//
// `handle.root` marks the physics-capsule *centre*, not the ground: CharacterModel
// places the feet ~0.7 m below the root (capsule bottom is at -0.8 from centre).
// So to stand the body on the y=0 terrain the root must sit ~0.8 m up, otherwise
// the whole rig — and every spawned ragdoll body — starts sunk into the ground and
// collides immediately.
const STAND_Y = 0.8;
const SPAWN = new THREE.Vector3(10, STAND_Y, 8);
// A "car" body id that can't collide with the player's ragdoll body ids.
const CAR_ID = 0xc0ff_0001;
const CAR_HALF = new THREE.Vector3(1.0, 0.5, 1.7);

type ScenarioKey = 'idle' | 'run' | 'fall' | 'car';

export interface LabApi {
  run(scenario: ScenarioKey): void;
  respawn(): void;
}

interface SceneState {
  world: CosmeticPhysicsWorld | null;
  handle: RemotePlayerHandle | null;
  group: THREE.Group | null;
  ready: boolean;
  /** 'animate' = mixer-driven; 'ragdoll' = physics-driven. */
  mode: 'animate' | 'ragdoll';
  preState: typeof STATE.idle | typeof STATE.move;
  preSpeed: number;
  carMesh: THREE.Mesh | null;
  carActive: boolean;
  // Deferred actions (so "run" can show a stride before collapsing, and the car
  // can arrive a beat after the ragdoll spawns). Absolute performance.now() ms.
  convertAt: number | null;
  convertVel: THREE.Vector3;
  carAt: number | null;
}

function newSceneState(): SceneState {
  return {
    world: null,
    handle: null,
    group: null,
    ready: false,
    mode: 'animate',
    preState: STATE.idle,
    preSpeed: 0,
    carMesh: null,
    carActive: false,
    convertAt: null,
    convertVel: new THREE.Vector3(),
    carAt: null,
  };
}

function RagdollScene({
  apiRef,
  frozenRef,
  timeScaleRef,
  onStatus,
}: {
  apiRef: MutableRefObject<LabApi | null>;
  frozenRef: MutableRefObject<boolean>;
  timeScaleRef: MutableRefObject<number>;
  onStatus: (s: string) => void;
}) {
  const { scene } = useThree();
  const stRef = useRef<SceneState>(newSceneState());

  useEffect(() => {
    const st = stRef.current;
    let disposed = false;

    const group = new THREE.Group();
    scene.add(group);
    st.group = group;

    // Car proxy mesh (positioned from physics each frame when active).
    const carMesh = new THREE.Mesh(
      new THREE.BoxGeometry(CAR_HALF.x * 2, CAR_HALF.y * 2, CAR_HALF.z * 2),
      new THREE.MeshStandardMaterial({ color: 0xd23b3b, metalness: 0.3, roughness: 0.5 }),
    );
    carMesh.castShadow = true;
    carMesh.visible = false;
    scene.add(carMesh);
    st.carMesh = carMesh;

    onStatus('Loading physics + character…');
    CosmeticPhysicsWorld.create()
      .then((world) => {
        if (disposed) {
          world.dispose();
          return;
        }
        st.world = world;
        const handle = createRemotePlayer(group, {
          runtime: world as unknown as GameRuntimeClient,
          playerId: 1,
          tint: 0x4aa3ff,
        });
        handle.root.position.copy(SPAWN);
        st.handle = handle;
        st.ready = true;
        onStatus('Ready — pick a scenario');
      })
      .catch((err) => {
        console.error('[RagdollLab] failed to init', err);
        onStatus('Failed to initialise physics (see console)');
      });

    // ── Imperative API used by the UI buttons ──────────────────────────────
    const removeCar = () => {
      if (st.carActive && st.world) st.world.removeRagdollBody(CAR_ID);
      st.carActive = false;
      if (st.carMesh) st.carMesh.visible = false;
      st.carAt = null;
    };

    const toRagdoll = (vel: THREE.Vector3) => {
      if (!st.handle) return;
      st.handle.setRagdoll(true, vel.clone());
      st.mode = 'ragdoll';
    };

    const resetToSpawn = (y: number) => {
      if (!st.handle) return;
      st.handle.setRagdoll(false);
      st.handle.root.position.set(SPAWN.x, y, SPAWN.z);
      st.handle.root.quaternion.identity();
      st.mode = 'animate';
      st.preState = STATE.idle;
      st.preSpeed = 0;
      st.convertAt = null;
      removeCar();
    };

    const api: LabApi = {
      run(scenario) {
        if (!st.ready) return;
        switch (scenario) {
          case 'idle':
            resetToSpawn(STAND_Y);
            toRagdoll(new THREE.Vector3(0, 0, 0));
            onStatus('Idle collapse — crumples straight down');
            break;
          case 'run':
            // Show a running stride, then collapse forward with momentum.
            resetToSpawn(STAND_Y);
            st.preState = STATE.move;
            st.preSpeed = 7;
            st.convertAt = performance.now() + 750;
            st.convertVel.set(6, 1.5, 0);
            onStatus('Run & tumble — running, then collapses forward…');
            break;
          case 'fall':
            resetToSpawn(3.5);
            toRagdoll(new THREE.Vector3(0, 0, 0));
            onStatus('Fall from height — drops and settles on the ground');
            break;
          case 'car': {
            resetToSpawn(STAND_Y);
            toRagdoll(new THREE.Vector3(0, 0, 0));
            st.carAt = performance.now() + 120;
            onStatus('Hit by a "car" — incoming!');
            break;
          }
        }
      },
      respawn() {
        if (!st.ready) return;
        resetToSpawn(STAND_Y);
        onStatus('Respawned — back to live animation');
      },
    };
    apiRef.current = api;

    return () => {
      disposed = true;
      apiRef.current = null;
      removeCar();
      st.handle?.dispose();
      st.world?.dispose();
      if (st.group) scene.remove(st.group);
      if (st.carMesh) {
        scene.remove(st.carMesh);
        st.carMesh.geometry.dispose();
        (st.carMesh.material as THREE.Material).dispose();
      }
      stRef.current = newSceneState();
    };
  }, [scene, apiRef, onStatus]);

  useFrame((_, dtRaw) => {
    const st = stRef.current;
    if (!st.ready || !st.world || !st.handle) return;

    const now = performance.now();
    // Fire any deferred actions.
    if (st.convertAt != null && now >= st.convertAt) {
      st.convertAt = null;
      st.handle.setRagdoll(true, st.convertVel.clone());
      st.mode = 'ragdoll';
    }
    if (st.carAt != null && now >= st.carAt) {
      st.carAt = null;
      // spawn car via closure-free path: replicate spawnCar inline
      const w = st.world;
      w.removeRagdollBody(CAR_ID);
      const px = SPAWN.x - 8;
      const py = CAR_HALF.y + 0.05;
      const pz = SPAWN.z;
      w.spawnRagdollBody(
        CAR_ID,
        CAR_HALF.x, CAR_HALF.y, CAR_HALF.z,
        px, py, pz,
        0, 0, 0, 1,
        16, 0, 0,
        0, 0, 0,
      );
      st.carActive = true;
      if (st.carMesh) {
        st.carMesh.position.set(px, py, pz);
        st.carMesh.quaternion.identity();
        st.carMesh.visible = true;
      }
    }

    const dt = Math.min(dtRaw, 1 / 30) * timeScaleRef.current;

    // Physics step (skipped while frozen so you can inspect the exact snapshot).
    if (!frozenRef.current) st.world.advance(dt);

    // Drive the character. While ragdoll is active, update() reads physics and
    // ignores the state/speed args; otherwise it plays the requested animation.
    if (st.mode === 'ragdoll') {
      st.handle.update(dt, 'dead', 0, false);
    } else {
      st.handle.update(dt, st.preState, st.preSpeed, true);
    }

    // Sync the car proxy mesh from its physics body.
    if (st.carActive && st.carMesh) {
      const s = st.world.getRagdollBodyState(CAR_ID);
      if (s) {
        st.carMesh.position.set(s[0], s[1], s[2]);
        st.carMesh.quaternion.set(s[3], s[4], s[5], s[6]);
      }
    }
  });

  return null;
}

export function RagdollLabPage() {
  const apiRef = useRef<LabApi | null>(null);
  const frozenRef = useRef(false);
  const timeScaleRef = useRef(1);
  const [status, setStatus] = useState('Loading…');
  const [frozen, setFrozen] = useState(false);
  const [timeScale, setTimeScale] = useState(1);

  useEffect(() => {
    frozenRef.current = frozen;
  }, [frozen]);
  useEffect(() => {
    timeScaleRef.current = timeScale;
  }, [timeScale]);

  const btn: CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    marginBottom: 6,
    borderRadius: 6,
    border: '1px solid #3a4a63',
    background: '#1b2638',
    color: '#dce6f5',
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'left',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b1018' }}>
      <Canvas shadows camera={{ position: [SPAWN.x + 5, 3, SPAWN.z + 6], fov: 50 }}>
        <Sky sunPosition={[20, 30, 10]} />
        <ambientLight intensity={0.6} />
        <directionalLight
          position={[15, 25, 10]}
          intensity={1.4}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        {/* Visual ground at y=0 to match the flat physics terrain. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[SPAWN.x, 0, SPAWN.z]} receiveShadow>
          <planeGeometry args={[80, 80]} />
          <meshStandardMaterial color={0x2a3344} />
        </mesh>
        <Grid
          position={[SPAWN.x, 0.01, SPAWN.z]}
          args={[80, 80]}
          cellSize={1}
          cellColor={0x3a4660}
          sectionSize={5}
          sectionColor={0x556688}
          infiniteGrid={false}
          fadeDistance={60}
        />
        <RagdollScene
          apiRef={apiRef}
          frozenRef={frozenRef}
          timeScaleRef={timeScaleRef}
          onStatus={setStatus}
        />
        <OrbitControls makeDefault target={[SPAWN.x, 1, SPAWN.z]} maxDistance={40} minDistance={2} />
      </Canvas>

      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          width: 240,
          padding: 12,
          borderRadius: 10,
          background: 'rgba(10,16,26,0.86)',
          border: '1px solid #26344a',
          color: '#dce6f5',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Ragdoll Lab</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10, minHeight: 30 }}>{status}</div>

        <button style={btn} onClick={() => apiRef.current?.run('idle')}>💥 Idle collapse</button>
        <button style={btn} onClick={() => apiRef.current?.run('run')}>🏃 Run &amp; tumble</button>
        <button style={btn} onClick={() => apiRef.current?.run('fall')}>🪂 Fall from height</button>
        <button style={btn} onClick={() => apiRef.current?.run('car')}>🚗 Hit by a car</button>
        <button style={{ ...btn, background: '#16321f', borderColor: '#2f5e3c' }} onClick={() => apiRef.current?.respawn()}>
          ♻️ Respawn (animate)
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={frozen} onChange={(e) => setFrozen(e.target.checked)} />
          Freeze physics (inspect snapshot)
        </label>

        <div style={{ marginTop: 10, fontSize: 13 }}>
          <div style={{ marginBottom: 4 }}>Time scale: {timeScale.toFixed(2)}×</div>
          <input
            type="range"
            min={0.1}
            max={1.5}
            step={0.05}
            value={timeScale}
            onChange={(e) => setTimeScale(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 10 }}>Drag to orbit · scroll to zoom</div>
      </div>
    </div>
  );
}
