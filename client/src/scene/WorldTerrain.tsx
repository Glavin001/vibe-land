import { forwardRef, useMemo } from 'react';
import type { MeshProps } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldDocument } from '../world/worldDocument';
import { getTerrainWorldPosition } from '../world/worldDocument';

type WorldTerrainProps = MeshProps & {
  world: WorldDocument;
};

export const WorldTerrain = forwardRef<THREE.Mesh, WorldTerrainProps>(function WorldTerrain(
  { world, ...meshProps },
  ref,
) {
  const geometry = useMemo(() => buildTerrainGeometry(world), [world]);
  const material = useMemo(() => buildTerrainMaterial(), []);
  return <mesh ref={ref} geometry={geometry} material={material} receiveShadow {...meshProps} />;
});

export function buildTerrainGeometry(world: WorldDocument): THREE.BufferGeometry {
  const size = world.terrain.halfExtentM * 2;
  const segments = world.terrain.gridSize - 1;
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  for (let row = 0; row < world.terrain.gridSize; row += 1) {
    for (let col = 0; col < world.terrain.gridSize; col += 1) {
      const vertexIndex = row * world.terrain.gridSize + col;
      positions.setY(vertexIndex, world.terrain.heights[vertexIndex] ?? 0);
      const [x, z] = getTerrainWorldPosition(world, row, col);
      positions.setX(vertexIndex, x);
      positions.setZ(vertexIndex, z);
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();

  const normals = geometry.attributes.normal;
  const colors = new Float32Array(positions.count * 3);
  const lowColor = new THREE.Color(0x365846);
  const midColor = new THREE.Color(0x7fa164);
  const highColor = new THREE.Color(0xd6c08d);
  const steepColor = new THREE.Color(0x87684a);
  const ridgeColor = new THREE.Color(0xf0e3be);
  const vertexColor = new THREE.Color();

  for (let index = 0; index < positions.count; index += 1) {
    const height01 = clamp((positions.getY(index) + 1) * 0.5, 0, 1);
    const slope01 = clamp(1 - normals.getY(index), 0, 1);

    if (height01 < 0.58) {
      vertexColor.copy(lowColor).lerp(midColor, smoothstep(0, 0.58, height01));
    } else {
      vertexColor.copy(midColor).lerp(highColor, smoothstep(0.58, 1, height01));
    }

    vertexColor.lerp(steepColor, slope01 * 0.5);
    vertexColor.lerp(ridgeColor, smoothstep(0.72, 1, height01) * 0.45);
    vertexColor.multiplyScalar(0.92 + height01 * 0.12 - slope01 * 0.08);

    colors[index * 3] = vertexColor.r;
    colors[index * 3 + 1] = vertexColor.g;
    colors[index * 3 + 2] = vertexColor.b;
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function buildTerrainMaterial(): THREE.MeshStandardMaterial {
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
  material.customProgramCacheKey = () => 'world-terrain-contours-v1';
  return material;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
