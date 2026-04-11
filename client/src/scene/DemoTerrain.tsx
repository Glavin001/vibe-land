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

    const normals = geom.attributes.normal;
    const colors = new Float32Array(positions.count * 3);
    const lowColor = new THREE.Color(0x365846);
    const midColor = new THREE.Color(0x7fa164);
    const highColor = new THREE.Color(0xd6c08d);
    const steepColor = new THREE.Color(0x87684a);
    const ridgeColor = new THREE.Color(0xf0e3be);
    const vertexColor = new THREE.Color();

    for (let i = 0; i < positions.count; i++) {
      const height01 = clamp((positions.getY(i) + 1) * 0.5, 0, 1);
      const slope01 = clamp(1 - normals.getY(i), 0, 1);

      if (height01 < 0.58) {
        vertexColor.copy(lowColor).lerp(midColor, smoothstep(0, 0.58, height01));
      } else {
        vertexColor.copy(midColor).lerp(highColor, smoothstep(0.58, 1, height01));
      }

      vertexColor.lerp(steepColor, slope01 * 0.5);
      vertexColor.lerp(ridgeColor, smoothstep(0.72, 1, height01) * 0.45);
      vertexColor.multiplyScalar(0.92 + height01 * 0.12 - slope01 * 0.08);

      colors[i * 3] = vertexColor.r;
      colors[i * 3 + 1] = vertexColor.g;
      colors[i * 3 + 2] = vertexColor.b;
    }

    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geom;
  }, []);

  const terrainMaterial = useMemo(() => {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.98,
      metalness: 0.02,
      dithering: true,
    });

    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosition;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPosition = worldPosition.xyz;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosition;')
        .replace(
          '#include <dithering_fragment>',
          `
            float contourHeight = vWorldPosition.y * 4.75 + 0.075 * (vWorldPosition.x + vWorldPosition.z);
            float contourBand = min(fract(contourHeight), 1.0 - fract(contourHeight));
            float contourLine = 1.0 - smoothstep(0.03, 0.11, contourBand);
            float slopeShade = clamp(1.0 - normal.y, 0.0, 1.0);
            gl_FragColor.rgb *= 1.0 - contourLine * (0.16 + slopeShade * 0.28);
            gl_FragColor.rgb += vec3(0.05, 0.04, 0.02) * slopeShade;
            #include <dithering_fragment>
          `,
        );
    };
    material.customProgramCacheKey = () => 'demo-terrain-contours-v1';

    return material;
  }, []);

  const wallY = PIT_WALL_HEIGHT * 0.5;

  return (
    <group>
      <mesh geometry={geometry} material={terrainMaterial} receiveShadow />

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
