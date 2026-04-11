import { useMemo } from 'react';
import * as THREE from 'three';

const TERRAIN_GRID_SIZE = 129;
const TERRAIN_HALF_EXTENT_M = 80;
const PIT_X = 8;
const PIT_Z = 8;
const PIT_W = 8;
const PIT_D = 8;
const PIT_WALL_HEIGHT = 3;
const PIT_WALL_THICKNESS = 0.35;
const FLAT_CENTER_X = 10;
const FLAT_CENTER_Z = 8;
const FLAT_RADIUS_M = 16;
const BLEND_RADIUS_M = 28;

export function DemoTerrain() {
  const geometry = useMemo(() => {
    const size = TERRAIN_HALF_EXTENT_M * 2;
    const segments = TERRAIN_GRID_SIZE - 1;
    const geom = new THREE.PlaneGeometry(size, size, segments, segments);
    geom.rotateX(-Math.PI / 2);

    const positions = geom.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      positions.setY(i, sampleTerrainHeight(x, z));
    }
    positions.needsUpdate = true;
    geom.computeVertexNormals();
    return geom;
  }, []);

  const wallY = PIT_WALL_HEIGHT * 0.5;

  return (
    <group>
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial color={0x587344} roughness={0.95} metalness={0.02} />
      </mesh>

      <mesh
        position={[PIT_X + PIT_W * 0.5 - 0.5, wallY, PIT_Z + PIT_D - 0.5]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[PIT_W, PIT_WALL_HEIGHT, PIT_WALL_THICKNESS * 2]} />
        <meshStandardMaterial color={0x7c6850} roughness={0.9} metalness={0.04} />
      </mesh>

      <mesh
        position={[PIT_X, wallY, PIT_Z + PIT_D * 0.5 - 0.5]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[PIT_WALL_THICKNESS * 2, PIT_WALL_HEIGHT, PIT_D]} />
        <meshStandardMaterial color={0x7c6850} roughness={0.9} metalness={0.04} />
      </mesh>

      <mesh
        position={[PIT_X + PIT_W - 1, wallY, PIT_Z + PIT_D * 0.5 - 0.5]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[PIT_WALL_THICKNESS * 2, PIT_WALL_HEIGHT, PIT_D]} />
        <meshStandardMaterial color={0x7c6850} roughness={0.9} metalness={0.04} />
      </mesh>
    </group>
  );
}

function sampleTerrainHeight(x: number, z: number): number {
  const base = 0.55 * Math.sin(x * 0.05)
    + 0.35 * Math.cos(z * 0.07)
    + 0.18 * Math.sin((x + z) * 0.035)
    + 0.12 * Math.cos((x - z) * 0.08);

  const dx = x - FLAT_CENTER_X;
  const dz = z - FLAT_CENTER_Z;
  const dist = Math.hypot(dx, dz);
  const blend = smoothstep(FLAT_RADIUS_M, BLEND_RADIUS_M, dist);
  return clamp(base * blend, -1, 1);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
