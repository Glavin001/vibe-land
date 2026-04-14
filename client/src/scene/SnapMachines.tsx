import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldDocument } from '../world/worldDocument';

type SnapMachinesProps = {
  world: WorldDocument;
  /** Flat `[px, py, pz, qx, qy, qz, qw]` per body, in body-id alphabetical order. */
  getBodyPoses: (machineId: number) => Float32Array;
};

// ── Envelope types (only the fields we actually read for rendering) ──
type Vec3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };
type Transform = { position: Vec3; rotation: Quat };

type Geometry = {
  id: string;
  kind: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'mesh';
  transform: Transform;
  size?: Vec3;
  radius?: number;
  halfHeight?: number;
  axis?: 'x' | 'y' | 'z';
};

type Mount = {
  id: string;
  bodyId: string;
  blockTypeId?: string;
  localTransform: Transform;
  geometry?: Geometry[];
};

type Envelope = {
  plan: {
    bodies: { id: string }[];
    mounts: Mount[];
  };
};

// Colors keyed by block-type prefix so wheels, beams, and joints look
// distinct. Close enough for an MVP render until the renderer learns to
// read `materials` / `metadata.color` from the envelope.
const DEFAULT_COLOR = 0xc0c8d0;
const TYPE_COLORS: Array<{ match: RegExp; color: number }> = [
  { match: /wheel/, color: 0x26323c },
  { match: /hinge/, color: 0xbfae5a },
  { match: /motor/, color: 0xe2a447 },
  { match: /frame|beam/, color: 0x9aa4b0 },
  { match: /thruster/, color: 0xde5a3a },
];

function colorForMount(mount: Mount): number {
  const key = mount.blockTypeId ?? '';
  for (const entry of TYPE_COLORS) {
    if (entry.match.test(key)) return entry.color;
  }
  return DEFAULT_COLOR;
}

/**
 * Mirror of `rapier3d::prelude::Collider::local_shape_isometry` for
 * Y-aligned shapes (capsule / cylinder). An `axis: "x"` entry rotates
 * the shape so its Y axis ends up aligned with X — i.e. a wheel lying
 * flat with its axle along the world X axis.
 */
function axisRotation(axis: Geometry['axis']): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (!axis || axis === 'y') return q;
  if (axis === 'x') {
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  } else if (axis === 'z') {
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  }
  return q;
}

function applyTransform(obj: THREE.Object3D, t: Transform): void {
  obj.position.set(t.position.x, t.position.y, t.position.z);
  obj.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
}

function buildGeometryMesh(geo: Geometry, color: number): THREE.Mesh | null {
  let three: THREE.BufferGeometry;
  switch (geo.kind) {
    case 'box': {
      const s = geo.size ?? { x: 0.1, y: 0.1, z: 0.1 };
      three = new THREE.BoxGeometry(s.x, s.y, s.z);
      break;
    }
    case 'sphere': {
      three = new THREE.SphereGeometry(geo.radius ?? 0.1, 24, 16);
      break;
    }
    case 'capsule': {
      const r = geo.radius ?? 0.1;
      const hh = geo.halfHeight ?? 0.1;
      three = new THREE.CapsuleGeometry(r, hh * 2, 8, 16);
      break;
    }
    case 'cylinder': {
      const r = geo.radius ?? 0.1;
      const hh = geo.halfHeight ?? 0.1;
      three = new THREE.CylinderGeometry(r, r, hh * 2, 24);
      break;
    }
    default:
      return null;
  }

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(three, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // geometry.transform is local to the mount. Compose stored rotation
  // with the axis-alignment for Y-aligned shapes so wheels end up
  // horizontal.
  mesh.position.set(geo.transform.position.x, geo.transform.position.y, geo.transform.position.z);
  const stored = new THREE.Quaternion(
    geo.transform.rotation.x,
    geo.transform.rotation.y,
    geo.transform.rotation.z,
    geo.transform.rotation.w,
  );
  stored.multiply(axisRotation(geo.axis));
  mesh.quaternion.copy(stored);
  return mesh;
}

/**
 * Renders every `snapMachine` in the world document by walking the
 * envelope `plan.mounts[]`. The render hierarchy is:
 *
 * ```
 * root
 *  └── machineRoot
 *        └── bodyGroup (pose updated each frame from WASM)
 *              └── mountGroup (static `localTransform`)
 *                    └── geometryMesh (static `transform` + axis)
 * ```
 *
 * Every frame we read `getBodyPoses(machineId)` — a flat
 * `[px, py, pz, qx, qy, qz, qw]` array in body-id alphabetical order —
 * and write the values onto the body groups.
 */
export function SnapMachines({ world, getBodyPoses }: SnapMachinesProps) {
  const groupRef = useRef<THREE.Group>(null);
  // machineId → { bodyGroupsByIndex, disposables }.
  const machineDataRef = useRef<
    Map<number, { bodyGroups: THREE.Group[]; disposables: THREE.Object3D[] }>
  >(new Map());

  const snapMachines = useMemo(
    () => world.dynamicEntities.filter((e) => e.kind === 'snapMachine' && e.envelope),
    [world],
  );

  useEffect(() => {
    const root = groupRef.current;
    if (!root) return;

    // Clear any previously-built meshes.
    for (const data of machineDataRef.current.values()) {
      for (const obj of data.disposables) disposeObject(obj);
    }
    while (root.children.length > 0) root.remove(root.children[0]);
    machineDataRef.current.clear();

    for (const entity of snapMachines) {
      const envelope = entity.envelope as Envelope | undefined;
      if (!envelope?.plan?.bodies?.length) continue;

      // Alphabetical body-id ordering — matches `SnapMachine::body_ids()`
      // on the Rust side, which is what the flat pose buffer indexes by.
      const sortedBodyIds = envelope.plan.bodies.map((b) => b.id).sort();
      const bodyIndexById = new Map<string, number>();
      sortedBodyIds.forEach((id, idx) => bodyIndexById.set(id, idx));

      const machineRoot = new THREE.Group();
      machineRoot.name = `snapMachine:${entity.id}`;

      const bodyGroups: THREE.Group[] = sortedBodyIds.map((bodyId) => {
        const g = new THREE.Group();
        g.name = `snapMachine:${entity.id}:${bodyId}`;
        machineRoot.add(g);
        return g;
      });

      for (const mount of envelope.plan.mounts ?? []) {
        const idx = bodyIndexById.get(mount.bodyId);
        if (idx === undefined) continue;
        const bodyGroup = bodyGroups[idx];

        const mountGroup = new THREE.Group();
        mountGroup.name = mount.id;
        applyTransform(mountGroup, mount.localTransform);
        bodyGroup.add(mountGroup);

        const color = colorForMount(mount);
        for (const geo of mount.geometry ?? []) {
          const mesh = buildGeometryMesh(geo, color);
          if (mesh) mountGroup.add(mesh);
        }
      }

      // Initial pose from the authored world entity — this displays the
      // machine immediately while we wait for the first physics tick.
      // After poses arrive the machineRoot is reset to identity so the
      // body-group world transforms are authoritative.
      machineRoot.position.set(entity.position[0], entity.position[1], entity.position[2]);
      machineRoot.quaternion.set(
        entity.rotation[0], entity.rotation[1], entity.rotation[2], entity.rotation[3],
      );

      root.add(machineRoot);
      machineDataRef.current.set(entity.id, {
        bodyGroups,
        disposables: [machineRoot],
      });
    }

    return () => {
      for (const data of machineDataRef.current.values()) {
        for (const obj of data.disposables) disposeObject(obj);
      }
      machineDataRef.current.clear();
      while (root.children.length > 0) root.remove(root.children[0]);
    };
  }, [snapMachines]);

  // Run after parent `GameWorld` `useFrame` (priority 0): R3F calls lower
  // priorities first, so we must read `getBodyPoses` *after* wasm ticks
  // (`updateSnapMachine` / `syncRemoteSnapMachine`) or we alternate one
  // frame of stale poses with the authored `machineRoot` layout — visible
  // as pose flicker in the recording.
  useFrame(() => {
    for (const [machineId, data] of machineDataRef.current) {
      const poses = getBodyPoses(machineId);
      if (!poses || poses.length === 0) continue;

      // Reset the per-machine root to identity now that body transforms
      // are authoritative world poses. (No-op after the first real pose.)
      const machineRoot = data.bodyGroups[0]?.parent as THREE.Group | null;
      if (machineRoot && machineRoot.position.lengthSq() !== 0) {
        machineRoot.position.set(0, 0, 0);
        machineRoot.quaternion.set(0, 0, 0, 1);
      }

      const bodyCount = Math.min(data.bodyGroups.length, Math.floor(poses.length / 7));
      for (let i = 0; i < bodyCount; i++) {
        const group = data.bodyGroups[i];
        const o = i * 7;
        group.position.set(poses[o + 0], poses[o + 1], poses[o + 2]);
        group.quaternion.set(poses[o + 3], poses[o + 4], poses[o + 5], poses[o + 6]);
      }
    }
  }, 1);

  return <group ref={groupRef} />;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => m.dispose?.());
      } else {
        mat?.dispose?.();
      }
    }
  });
}
