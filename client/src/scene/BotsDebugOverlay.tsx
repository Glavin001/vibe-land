import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NavMesh } from 'navcat';
import * as THREE from 'three';

import { MAX_PRACTICE_BOTS, type BotDebugInfo, type BotObstacleDebugInfo, type PracticeBotRuntime } from '../bots';

interface BotsDebugOverlayProps {
  runtime: PracticeBotRuntime;
  showLabels?: boolean;
}

const MAX_BOTS = MAX_PRACTICE_BOTS;
const MAX_PATH_POINTS_PER_BOT = 9;
const MAX_PATH_SEGMENTS = MAX_BOTS * (MAX_PATH_POINTS_PER_BOT - 1);
const MAX_PATH_VERTICES = MAX_PATH_SEGMENTS * 2;

const PATH_COLOR_HARASS = new THREE.Color(0xffae42);
const PATH_COLOR_WANDER = new THREE.Color(0x6bd8ff);
const PATH_COLOR_HOLD = new THREE.Color(0xc586ff);
const TARGET_COLOR = new THREE.Color(0xff5fb1);
const RAW_TARGET_COLOR = new THREE.Color(0x66d9ff);
const SNAP_TRACE_GOOD_COLOR = new THREE.Color(0x12e6ff);
const SNAP_TRACE_BAD_COLOR = new THREE.Color(0xff2d7a);
const SNAP_TRACE_HALO_COLOR = new THREE.Color(0xffffff);
const VEL_COLOR = new THREE.Color(0x6bff7c);
const OBSTACLE_COLOR = new THREE.Color(0xff5050);
const NAVMESH_COLOR = new THREE.Color(0x7cf7ff);
const SNAP_BOX_COLOR = new THREE.Color(0x66d9ff);
const TRACE_UP = new THREE.Vector3(0, 1, 0);
const TRACE_START = new THREE.Vector3();
const TRACE_END = new THREE.Vector3();
const TRACE_DELTA = new THREE.Vector3();
const TRACE_MID = new THREE.Vector3();

function pathColor(behavior: BotDebugInfo['behaviorKind']): THREE.Color {
  switch (behavior) {
    case 'wander':
      return PATH_COLOR_WANDER;
    case 'hold':
      return PATH_COLOR_HOLD;
    case 'harass':
    default:
      return PATH_COLOR_HARASS;
  }
}

interface BotSlot {
  group: THREE.Group;
  targetGroup: THREE.Group;
  targetMesh: THREE.Mesh;
  rawTargetMesh: THREE.Mesh;
  snapTraceGroup: THREE.Group;
  snapTraceHalo: THREE.Mesh;
  snapTraceCore: THREE.Mesh;
  snapBox: THREE.LineSegments;
  velArrow: THREE.ArrowHelper;
  ringMesh: THREE.Mesh;
  info: BotDebugInfo | null;
}

interface ObstacleSlot {
  group: THREE.Group;
  ring: THREE.Mesh;
  pillar: THREE.Mesh;
}

export function BotsDebugOverlay({ runtime, showLabels = false }: BotsDebugOverlayProps) {
  const rootRef = useRef<THREE.Group>(null);
  const pathLinesRef = useRef<THREE.LineSegments | null>(null);
  const slotsRef = useRef<Map<number, BotSlot>>(new Map());
  const obstacleSlotsRef = useRef<Map<number, ObstacleSlot>>(new Map());
  const latestInfosRef = useRef<BotDebugInfo[]>([]);
  const [labelInfos, setLabelInfos] = useState<BotDebugInfo[]>([]);
  const snapHalfExtents = runtime.crowd.debugSnapHalfExtents;

  useEffect(() => {
    if (!showLabels) {
      setLabelInfos([]);
      return undefined;
    }
    const interval = setInterval(() => {
      setLabelInfos(latestInfosRef.current.slice());
    }, 100);
    return () => clearInterval(interval);
  }, [showLabels]);

  const pathGeometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_PATH_VERTICES * 3);
    const colors = new Float32Array(MAX_PATH_VERTICES * 3);
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setDrawRange(0, 0);
    return geom;
  }, []);

  const pathMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
    [],
  );

  const navMeshGeometry = useMemo(
    () => buildNavMeshWireframeGeometry(runtime.crowd.navMesh),
    [runtime],
  );
  const navMeshMaterial = useMemo(
    () => new THREE.LineBasicMaterial({
      color: NAVMESH_COLOR,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
    [],
  );

  useEffect(() => {
    return () => {
      pathGeometry.dispose();
      pathMaterial.dispose();
      navMeshGeometry.dispose();
      navMeshMaterial.dispose();
      const slots = slotsRef.current;
      for (const slot of slots.values()) {
        disposeBotSlot(slot);
      }
      slots.clear();
      const obstacleSlots = obstacleSlotsRef.current;
      for (const slot of obstacleSlots.values()) {
        disposeObstacleSlot(slot);
      }
      obstacleSlots.clear();
    };
  }, [navMeshGeometry, navMeshMaterial, pathGeometry, pathMaterial]);

  useFrame(() => {
    const root = rootRef.current;
    const lineSegs = pathLinesRef.current;
    if (!root || !lineSegs) return;

    const infos = runtime.getBotDebugInfos();
    latestInfosRef.current = infos;
    const slots = slotsRef.current;
    const seen = new Set<number>();

    const positions = pathGeometry.attributes.position.array as Float32Array;
    const colors = pathGeometry.attributes.color.array as Float32Array;
    let vertexCount = 0;

    for (const info of infos) {
      seen.add(info.id);
      let slot = slots.get(info.id);
      if (!slot) {
        slot = makeSlot();
        slots.set(info.id, slot);
        root.add(slot.group);
        root.add(slot.targetGroup);
      }
      slot.info = info;
      slot.group.position.set(info.position[0], info.position[1], info.position[2]);

      const color = pathColor(info.behaviorKind);
      const ringMat = slot.ringMesh.material as THREE.MeshBasicMaterial;
      ringMat.color.copy(color);

      if (info.target) {
        slot.targetMesh.visible = true;
        slot.targetMesh.position.set(info.target[0], info.target[1] + 0.1, info.target[2]);
      } else {
        slot.targetMesh.visible = false;
      }

      if (info.rawTarget) {
        slot.rawTargetMesh.visible = true;
        slot.rawTargetMesh.position.set(info.rawTarget[0], info.rawTarget[1] + 0.14, info.rawTarget[2]);
        slot.snapBox.visible = true;
        slot.snapBox.position.set(info.rawTarget[0], info.rawTarget[1], info.rawTarget[2]);
        slot.snapBox.scale.set(
          snapHalfExtents[0] * 2,
          snapHalfExtents[1] * 2,
          snapHalfExtents[2] * 2,
        );
      } else {
        slot.rawTargetMesh.visible = false;
        slot.snapBox.visible = false;
      }

      if (info.rawTarget && info.target) {
        const colorForSnap = (info.targetSnapDistanceM ?? 0) >= 0.75
          ? SNAP_TRACE_BAD_COLOR
          : SNAP_TRACE_GOOD_COLOR;
        updateTraceSegment(
          slot.snapTraceGroup,
          slot.snapTraceCore,
          info.rawTarget,
          info.target,
          colorForSnap,
        );
      } else {
        slot.snapTraceGroup.visible = false;
      }

      const dv = info.desiredVelocity;
      const dvLen = Math.hypot(dv[0], dv[1], dv[2]);
      if (dvLen > 0.05) {
        slot.velArrow.visible = true;
        slot.velArrow.position.set(0, 1.2, 0);
        slot.velArrow.setDirection(
          new THREE.Vector3(dv[0] / dvLen, dv[1] / dvLen, dv[2] / dvLen),
        );
        slot.velArrow.setLength(Math.min(dvLen * 0.8, 4), 0.25, 0.15);
      } else {
        slot.velArrow.visible = false;
      }

      const points = info.pathPoints;
      const segCount = Math.min(points.length - 1, MAX_PATH_POINTS_PER_BOT - 1);
      for (let i = 0; i < segCount; i += 1) {
        if (vertexCount + 2 > MAX_PATH_VERTICES) break;
        const a = points[i];
        const b = points[i + 1];
        const aOffset = vertexCount * 3;
        positions[aOffset + 0] = a[0];
        positions[aOffset + 1] = a[1] + 0.1;
        positions[aOffset + 2] = a[2];
        colors[aOffset + 0] = color.r;
        colors[aOffset + 1] = color.g;
        colors[aOffset + 2] = color.b;
        const bOffset = (vertexCount + 1) * 3;
        positions[bOffset + 0] = b[0];
        positions[bOffset + 1] = b[1] + 0.1;
        positions[bOffset + 2] = b[2];
        colors[bOffset + 0] = color.r;
        colors[bOffset + 1] = color.g;
        colors[bOffset + 2] = color.b;
        vertexCount += 2;
      }
    }

    for (const [id, slot] of slots) {
      if (!seen.has(id)) {
        disposeBotSlot(slot);
        slots.delete(id);
      }
    }

    pathGeometry.attributes.position.needsUpdate = true;
    pathGeometry.attributes.color.needsUpdate = true;
    pathGeometry.setDrawRange(0, vertexCount);
    pathGeometry.computeBoundingSphere();

    const obstacles: BotObstacleDebugInfo[] = runtime.getObstacleDebugInfos();
    const obstacleSlots = obstacleSlotsRef.current;
    const seenObstacles = new Set<number>();
    for (const obs of obstacles) {
      seenObstacles.add(obs.sourceId);
      let slot = obstacleSlots.get(obs.sourceId);
      if (!slot) {
        slot = makeObstacleSlot();
        obstacleSlots.set(obs.sourceId, slot);
        root.add(slot.group);
      }
      slot.group.position.set(obs.position[0], obs.position[1], obs.position[2]);
      slot.ring.scale.set(obs.radius, 1, obs.radius);
      slot.pillar.scale.set(obs.radius, obs.height / 2, obs.radius);
      slot.pillar.position.y = obs.height / 2;
    }
    for (const [id, slot] of obstacleSlots) {
      if (!seenObstacles.has(id)) {
        disposeObstacleSlot(slot);
        obstacleSlots.delete(id);
      }
    }
  });

  return (
    <group ref={rootRef}>
      <lineSegments
        geometry={navMeshGeometry}
        material={navMeshMaterial}
        frustumCulled={false}
      />
      <lineSegments
        ref={pathLinesRef}
        geometry={pathGeometry}
        material={pathMaterial}
        frustumCulled={false}
      />
      {showLabels && labelInfos.map((info) => (
        <Html
          key={info.id}
          position={[info.position[0], info.position[1] + 2.4, info.position[2]]}
          center
          distanceFactor={10}
          occlude={false}
          wrapperClass="pointer-events-none"
        >
          <div className="pointer-events-none select-none whitespace-nowrap rounded border border-orange-300/50 bg-black/80 px-2 py-1 text-[11px] leading-[1.35] text-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]">
            <div className="mb-0.5 text-xs font-bold">
              <span className="text-orange-300">bot</span>{' '}
              {info.id - 1_000_000 + 1}
            </div>
            <div className="flex justify-between gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.04em] text-white/[0.55]">behavior</span>
              <span>{info.behaviorKind}</span>
            </div>
            <div className="flex justify-between gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.04em] text-white/[0.55]">mode</span>
              <span>{info.mode}</span>
            </div>
            <div className="flex justify-between gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.04em] text-white/[0.55]">target</span>
              <span>{describeTarget(info)}</span>
            </div>
            <div className="flex justify-between gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.04em] text-white/[0.55]">snap</span>
              <span>{describeSnap(info)}</span>
            </div>
            <div className="flex justify-between gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.04em] text-white/[0.55]">replan</span>
              <span>
                {info.ticksSinceReplan}t · {describeMoveAccepted(info.lastMoveAccepted)}
              </span>
            </div>
            <div className="flex justify-between gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.04em] text-white/[0.55]">speed</span>
              <span>
                {Math.hypot(info.velocity[0], info.velocity[2]).toFixed(1)} /{' '}
                {info.maxSpeed.toFixed(1)} m/s
              </span>
            </div>
          </div>
        </Html>
      ))}
    </group>
  );
}

function makeSlot(): BotSlot {
  const group = new THREE.Group();
  group.name = 'bot-debug-slot';

  const targetGroup = new THREE.Group();
  targetGroup.name = 'bot-target-debug-slot';

  const ringGeometry = new THREE.RingGeometry(0.55, 0.65, 32);
  ringGeometry.rotateX(-Math.PI / 2);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: PATH_COLOR_HARASS,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const ringMesh = new THREE.Mesh(ringGeometry, ringMaterial);
  ringMesh.position.y = 0.05;
  group.add(ringMesh);

  const velArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 1.2, 0),
    1,
    VEL_COLOR.getHex(),
    0.25,
    0.15,
  );
  velArrow.visible = false;
  group.add(velArrow);

  const targetGeometry = new THREE.SphereGeometry(0.18, 12, 8);
  const targetMaterial = new THREE.MeshBasicMaterial({
    color: TARGET_COLOR,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
  targetMesh.visible = false;
  targetGroup.add(targetMesh);

  const rawTargetGeometry = new THREE.OctahedronGeometry(0.18, 0);
  const rawTargetMaterial = new THREE.MeshBasicMaterial({
    color: RAW_TARGET_COLOR,
    transparent: true,
    opacity: 0.9,
    wireframe: true,
    depthWrite: false,
  });
  const rawTargetMesh = new THREE.Mesh(rawTargetGeometry, rawTargetMaterial);
  rawTargetMesh.visible = false;
  targetGroup.add(rawTargetMesh);

  const snapTraceGroup = new THREE.Group();
  snapTraceGroup.visible = false;
  const snapTraceGeometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  const snapTraceHaloMaterial = new THREE.MeshBasicMaterial({
    color: SNAP_TRACE_HALO_COLOR,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    depthTest: false,
  });
  const snapTraceHalo = new THREE.Mesh(snapTraceGeometry, snapTraceHaloMaterial);
  snapTraceHalo.scale.set(0.12, 1, 0.12);
  snapTraceGroup.add(snapTraceHalo);

  const snapTraceCoreMaterial = new THREE.MeshBasicMaterial({
    color: SNAP_TRACE_GOOD_COLOR,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: false,
  });
  const snapTraceCore = new THREE.Mesh(snapTraceGeometry, snapTraceCoreMaterial);
  snapTraceCore.scale.set(0.065, 1, 0.065);
  snapTraceGroup.add(snapTraceCore);
  targetGroup.add(snapTraceGroup);

  const snapBoxGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const snapBoxMaterial = new THREE.LineBasicMaterial({
    color: SNAP_BOX_COLOR,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const snapBox = new THREE.LineSegments(snapBoxGeometry, snapBoxMaterial);
  snapBox.visible = false;
  targetGroup.add(snapBox);

  return {
    group,
    targetGroup,
    targetMesh,
    rawTargetMesh,
    snapTraceGroup,
    snapTraceHalo,
    snapTraceCore,
    snapBox,
    velArrow,
    ringMesh,
    info: null,
  };
}

function disposeBotSlot(slot: BotSlot): void {
  slot.group.removeFromParent();
  slot.targetGroup.removeFromParent();
  slot.targetMesh.geometry.dispose();
  (slot.targetMesh.material as THREE.Material).dispose();
  slot.rawTargetMesh.geometry.dispose();
  (slot.rawTargetMesh.material as THREE.Material).dispose();
  slot.snapTraceCore.geometry.dispose();
  (slot.snapTraceCore.material as THREE.Material).dispose();
  (slot.snapTraceHalo.material as THREE.Material).dispose();
  (slot.snapBox.geometry as THREE.BufferGeometry).dispose();
  (slot.snapBox.material as THREE.Material).dispose();
  slot.ringMesh.geometry.dispose();
  (slot.ringMesh.material as THREE.Material).dispose();
}

function makeObstacleSlot(): ObstacleSlot {
  const group = new THREE.Group();
  group.name = 'bot-obstacle-slot';
  const ringGeometry = new THREE.RingGeometry(0.96, 1.0, 48);
  ringGeometry.rotateX(-Math.PI / 2);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: OBSTACLE_COLOR,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.position.y = 0.05;
  group.add(ring);

  const pillarGeometry = new THREE.CylinderGeometry(1.0, 1.0, 2, 24, 1, true);
  const pillarMaterial = new THREE.MeshBasicMaterial({
    color: OBSTACLE_COLOR,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  });
  const pillar = new THREE.Mesh(pillarGeometry, pillarMaterial);
  pillar.position.y = 1;
  group.add(pillar);
  return { group, ring, pillar };
}

function disposeObstacleSlot(slot: ObstacleSlot): void {
  slot.group.removeFromParent();
  slot.ring.geometry.dispose();
  (slot.ring.material as THREE.Material).dispose();
  slot.pillar.geometry.dispose();
  (slot.pillar.material as THREE.Material).dispose();
}

function updateTraceSegment(
  group: THREE.Group,
  core: THREE.Mesh,
  start: [number, number, number],
  end: [number, number, number],
  color: THREE.Color,
): void {
  TRACE_START.set(start[0], start[1] + 0.08, start[2]);
  TRACE_END.set(end[0], end[1] + 0.08, end[2]);
  TRACE_DELTA.subVectors(TRACE_END, TRACE_START);
  const length = TRACE_DELTA.length();
  if (length <= 0.001) {
    group.visible = false;
    return;
  }
  group.visible = true;
  TRACE_MID.copy(TRACE_START).add(TRACE_END).multiplyScalar(0.5);
  group.position.copy(TRACE_MID);
  group.quaternion.setFromUnitVectors(TRACE_UP, TRACE_DELTA.normalize());
  group.scale.set(1, length, 1);
  const coreMaterial = core.material as THREE.MeshBasicMaterial;
  coreMaterial.color.copy(color);
}

function buildNavMeshWireframeGeometry(navMesh: NavMesh): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const tile of Object.values(navMesh.tiles)) {
    const vertices = tile.vertices;
    for (const poly of tile.polys) {
      const polyVerts = poly.vertices;
      if (polyVerts.length < 2) continue;
      for (let i = 0; i < polyVerts.length; i += 1) {
        const aIndex = polyVerts[i] * 3;
        const bIndex = polyVerts[(i + 1) % polyVerts.length] * 3;
        positions.push(
          vertices[aIndex] ?? 0,
          (vertices[aIndex + 1] ?? 0) + 0.02,
          vertices[aIndex + 2] ?? 0,
          vertices[bIndex] ?? 0,
          (vertices[bIndex + 1] ?? 0) + 0.02,
          vertices[bIndex + 2] ?? 0,
        );
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function describeTarget(info: BotDebugInfo): string {
  if (info.targetPlayerId !== null) {
    return `player #${info.targetPlayerId}`;
  }
  if (info.target) {
    const dx = info.target[0] - info.position[0];
    const dz = info.target[2] - info.position[2];
    return `${Math.hypot(dx, dz).toFixed(1)}m away`;
  }
  return '—';
}

function describeSnap(info: BotDebugInfo): string {
  if (!info.rawTarget) return '—';
  if (!info.target) return 'no snap';
  if ((info.targetSnapDistanceM ?? 0) < 0.05) return 'locked';
  return `${(info.targetSnapDistanceM ?? 0).toFixed(2)}m`;
}

function describeMoveAccepted(value: boolean | null): string {
  if (value == null) return '—';
  return value ? 'ok' : 'reject';
}
