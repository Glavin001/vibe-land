/**
 * In-scene debug overlay for practice-mode bots.
 *
 * Mounted as a child of the R3F Canvas (alongside the rest of GameWorld),
 * this component polls {@link PracticeBotRuntime.getBotDebugInfos} every
 * frame and renders, per bot:
 *
 * - A vertical pole + capsule highlight at the bot's position.
 * - A polyline tracing the navcat steering corners from the bot to its
 *   current target (the "path it intends to take").
 * - A magenta sphere at the target position.
 * - A green arrow showing the crowd's desiredVelocity (where the bot
 *   wants to go *this tick*).
 * - An HTML billboard above the bot's head with: id, behavior, mode,
 *   target distance, current speed, and HP icons.
 *
 * Designed to be cheap: one shared LineSegments and a small pool of
 * meshes, allocated once and updated in-place each frame.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { BotDebugInfo, BotObstacleDebugInfo, PracticeBotRuntime } from '../bots';

interface BotsDebugOverlayProps {
  runtime: PracticeBotRuntime;
}

const MAX_BOTS = 32;
const MAX_PATH_POINTS_PER_BOT = 9; // start + up to 8 corners
// Each segment = 2 vertices * 3 floats. (MAX_PATH_POINTS - 1) segments per bot.
const MAX_PATH_SEGMENTS = MAX_BOTS * (MAX_PATH_POINTS_PER_BOT - 1);
const MAX_PATH_VERTICES = MAX_PATH_SEGMENTS * 2;

const PATH_COLOR_HARASS = new THREE.Color(0xffae42);
const PATH_COLOR_WANDER = new THREE.Color(0x6bd8ff);
const PATH_COLOR_HOLD = new THREE.Color(0xc586ff);
const TARGET_COLOR = new THREE.Color(0xff5fb1);
const VEL_COLOR = new THREE.Color(0x6bff7c);

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
  targetMesh: THREE.Mesh;
  velArrow: THREE.ArrowHelper;
  ringMesh: THREE.Mesh;
  /** Most recent debug info to drive the HTML label. */
  info: BotDebugInfo | null;
}

interface ObstacleSlot {
  group: THREE.Group;
  ring: THREE.Mesh;
  pillar: THREE.Mesh;
}

const OBSTACLE_COLOR = new THREE.Color(0xff5050);

export function BotsDebugOverlay({ runtime }: BotsDebugOverlayProps) {
  const rootRef = useRef<THREE.Group>(null);
  const pathLinesRef = useRef<THREE.LineSegments | null>(null);
  const slotsRef = useRef<Map<number, BotSlot>>(new Map());
  const obstacleSlotsRef = useRef<Map<number, ObstacleSlot>>(new Map());
  // Latest debug infos written by useFrame each frame. Mirrored into
  // React state at 10Hz for the HTML labels (they don't need 60Hz).
  const latestInfosRef = useRef<BotDebugInfo[]>([]);
  const [labelInfos, setLabelInfos] = useState<BotDebugInfo[]>([]);

  useEffect(() => {
    const interval = setInterval(() => {
      setLabelInfos(latestInfosRef.current.slice());
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Pre-allocate the line buffer geometry once. We update its xyz floats
  // and `drawRange.count` in place every frame.
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

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      pathGeometry.dispose();
      pathMaterial.dispose();
      const slots = slotsRef.current;
      for (const slot of slots.values()) {
        slot.group.removeFromParent();
        slot.targetMesh.geometry.dispose();
        (slot.targetMesh.material as THREE.Material).dispose();
        slot.ringMesh.geometry.dispose();
        (slot.ringMesh.material as THREE.Material).dispose();
      }
      slots.clear();
      const obstacleSlots = obstacleSlotsRef.current;
      for (const slot of obstacleSlots.values()) {
        slot.group.removeFromParent();
        slot.ring.geometry.dispose();
        (slot.ring.material as THREE.Material).dispose();
        slot.pillar.geometry.dispose();
        (slot.pillar.material as THREE.Material).dispose();
      }
      obstacleSlots.clear();
    };
  }, [pathGeometry, pathMaterial]);

  // Per-frame update: read live bot state and push it into the THREE
  // objects without allocating per-bot.
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
        // Target marker is parented to the scene root so its position is
        // in world space, independent of the bot's per-frame position.
        root.add(slot.targetMesh);
      }
      slot.info = info;

      // Position the per-bot group at the bot's feet.
      slot.group.position.set(info.position[0], info.position[1], info.position[2]);

      // Selection ring color follows behavior.
      const color = pathColor(info.behaviorKind);
      const ringMat = slot.ringMesh.material as THREE.MeshBasicMaterial;
      ringMat.color.copy(color);

      // Target marker: hide when no target. (World-space positioning.)
      if (info.target) {
        slot.targetMesh.visible = true;
        slot.targetMesh.position.set(info.target[0], info.target[1] + 0.1, info.target[2]);
      } else {
        slot.targetMesh.visible = false;
      }

      // Desired velocity arrow.
      const dv = info.desiredVelocity;
      const dvLen = Math.hypot(dv[0], dv[1], dv[2]);
      if (dvLen > 0.05) {
        slot.velArrow.visible = true;
        slot.velArrow.position.set(0, 1.2, 0); // local to bot group
        slot.velArrow.setDirection(
          new THREE.Vector3(dv[0] / dvLen, dv[1] / dvLen, dv[2] / dvLen),
        );
        slot.velArrow.setLength(Math.min(dvLen * 0.8, 4), 0.25, 0.15);
      } else {
        slot.velArrow.visible = false;
      }

      // Path polyline: emit one segment per pair of consecutive corners.
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

    // Garbage-collect slots for bots that no longer exist.
    for (const [id, slot] of slots) {
      if (!seen.has(id)) {
        slot.group.removeFromParent();
        slot.targetMesh.removeFromParent();
        slot.targetMesh.geometry.dispose();
        (slot.targetMesh.material as THREE.Material).dispose();
        slot.ringMesh.geometry.dispose();
        (slot.ringMesh.material as THREE.Material).dispose();
        slots.delete(id);
      }
    }

    pathGeometry.attributes.position.needsUpdate = true;
    pathGeometry.attributes.color.needsUpdate = true;
    pathGeometry.setDrawRange(0, vertexCount);
    pathGeometry.computeBoundingSphere();

    // Update obstacle markers (currently: vehicles). Shows the bots the
    // footprint of every vehicle pseudo-agent, so you can see what their
    // crowd-level avoidance is actually steering around.
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
      // Scale the ring in X/Z to the obstacle's radius (it was created
      // with radius 1 so we can scale it here without rebuilding the
      // geometry).
      slot.ring.scale.set(obs.radius, 1, obs.radius);
      slot.pillar.scale.set(obs.radius, obs.height / 2, obs.radius);
      slot.pillar.position.y = obs.height / 2;
    }
    for (const [id, slot] of obstacleSlots) {
      if (!seenObstacles.has(id)) {
        slot.group.removeFromParent();
        slot.ring.geometry.dispose();
        (slot.ring.material as THREE.Material).dispose();
        slot.pillar.geometry.dispose();
        (slot.pillar.material as THREE.Material).dispose();
        obstacleSlots.delete(id);
      }
    }
  });

  return (
    <group ref={rootRef}>
      <lineSegments
        ref={pathLinesRef}
        geometry={pathGeometry}
        material={pathMaterial}
        frustumCulled={false}
      />
      {labelInfos.map((info) => (
        <Html
          key={info.id}
          position={[info.position[0], info.position[1] + 2.4, info.position[2]]}
          center
          distanceFactor={10}
          occlude={false}
          style={{ pointerEvents: 'none' }}
        >
          <div style={labelBoxStyle}>
            <div style={labelTitleStyle}>
              <span style={{ color: '#ffae42' }}>bot</span>{' '}
              {info.id - 1_000_000 + 1}
            </div>
            <div style={labelRowStyle}>
              <span style={labelKeyStyle}>behavior</span>
              <span>{info.behaviorKind}</span>
            </div>
            <div style={labelRowStyle}>
              <span style={labelKeyStyle}>mode</span>
              <span>{info.mode}</span>
            </div>
            <div style={labelRowStyle}>
              <span style={labelKeyStyle}>target</span>
              <span>{describeTarget(info)}</span>
            </div>
            <div style={labelRowStyle}>
              <span style={labelKeyStyle}>speed</span>
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

  // Selection ring at the bot's feet.
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

  // Velocity arrow (hidden until updated). Lives in bot-local space.
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

  // Target marker — separate mesh, attached by the caller to the scene
  // root (not this group) so it can sit at an absolute world position.
  const targetGeometry = new THREE.SphereGeometry(0.18, 12, 8);
  const targetMaterial = new THREE.MeshBasicMaterial({
    color: TARGET_COLOR,
    transparent: true,
    opacity: 0.85,
  });
  const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
  targetMesh.visible = false;

  return { group, targetMesh, velArrow, ringMesh, info: null };
}

function makeObstacleSlot(): ObstacleSlot {
  const group = new THREE.Group();
  group.name = 'bot-obstacle-slot';
  // Unit-radius ring; the overlay update loop scales this per frame to
  // match each obstacle's real radius.
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
  // Subtle translucent pillar so the obstacle reads as a volume from a
  // first-person camera, not just a floor ring.
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

const labelBoxStyle: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.78)',
  border: '1px solid rgba(255, 174, 66, 0.5)',
  borderRadius: 4,
  padding: '4px 8px',
  color: '#fff',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: 11,
  lineHeight: 1.35,
  whiteSpace: 'nowrap',
  userSelect: 'none',
  pointerEvents: 'none',
  boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
};

const labelTitleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 12,
  marginBottom: 2,
};

const labelRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  justifyContent: 'space-between',
};

const labelKeyStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.55)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  fontSize: 10,
};
