import { forwardRef, memo, useEffect, useMemo } from 'react';
import type { MeshProps } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldDocument, WorldTerrainTile, TerrainMaterial } from '../world/worldDocument';
import {
  getTerrainTileKey,
  getTerrainMaterials,
  getOrGenerateTileMaterialWeights,
  sortTerrainTiles,
  MAX_MATERIAL_CHANNELS,
} from '../world/worldDocument';

type WorldTerrainProps = Omit<MeshProps, 'geometry' | 'material'> & {
  world: WorldDocument;
};

type TerrainTileGeometry = {
  key: string;
  tileX: number;
  tileZ: number;
  geometry: THREE.BufferGeometry;
};

export const WorldTerrain = forwardRef<THREE.Group, WorldTerrainProps>(function WorldTerrain(
  { world, ...meshProps },
  ref,
) {
  const materials = useMemo(() => getTerrainMaterials(world), [world]);
  const material = useMemo(() => buildTerrainMaterial(materials), [materials]);

  useEffect(() => () => {
    material.dispose();
  }, [material]);

  return (
    <group ref={ref}>
      {sortTerrainTiles(world.terrain.tiles).map((tile) => (
        <TerrainTileMesh
          key={getTerrainTileKey(tile.tileX, tile.tileZ)}
          tile={tile}
          tileGridSize={world.terrain.tileGridSize}
          tileHalfExtentM={world.terrain.tileHalfExtentM}
          materials={materials}
          material={material}
          meshProps={meshProps}
        />
      ))}
    </group>
  );
});

export function buildTerrainTileGeometries(world: WorldDocument): TerrainTileGeometry[] {
  const materials = getTerrainMaterials(world);
  return sortTerrainTiles(world.terrain.tiles).map((tile) => ({
    key: getTerrainTileKey(tile.tileX, tile.tileZ),
    tileX: tile.tileX,
    tileZ: tile.tileZ,
    geometry: buildTerrainTileGeometry(world, tile, materials),
  }));
}

export function buildTerrainTileGeometry(
  world: WorldDocument,
  tile: WorldTerrainTile,
  materials?: TerrainMaterial[],
): THREE.BufferGeometry {
  return buildTerrainTileGeometryFromDimensions(
    world.terrain.tileGridSize,
    world.terrain.tileHalfExtentM,
    tile,
    materials ?? getTerrainMaterials(world),
  );
}

function buildTerrainTileGeometryFromDimensions(
  tileGridSize: number,
  tileHalfExtentM: number,
  tile: WorldTerrainTile,
  materials: TerrainMaterial[],
): THREE.BufferGeometry {
  const side = tileHalfExtentM * 2;
  const last = tileGridSize - 1;
  const size = side;
  const segments = tileGridSize - 1;
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  for (let row = 0; row < tileGridSize; row += 1) {
    for (let col = 0; col < tileGridSize; col += 1) {
      const vertexIndex = row * tileGridSize + col;
      positions.setY(vertexIndex, tile.heights[vertexIndex] ?? 0);
      const centerX = tile.tileX * side;
      const centerZ = tile.tileZ * side;
      const x = last <= 0 ? centerX : centerX - tileHalfExtentM + side * (col / last);
      const z = last <= 0 ? centerZ : centerZ - tileHalfExtentM + side * (row / last);
      positions.setX(vertexIndex, x);
      positions.setZ(vertexIndex, z);
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();

  const normals = geometry.attributes.normal;
  const numMaterials = materials.length;

  // Generate or load material splatmap weights
  const weights = getOrGenerateTileMaterialWeights(tile, numMaterials, tileGridSize, normals, positions);
  const matColors = materials.map((m) => new THREE.Color(m.color));

  // Blend vertex colors from material weights
  const colors = new Float32Array(positions.count * 3);
  const vertexColor = new THREE.Color();

  for (let i = 0; i < positions.count; i += 1) {
    const base = i * numMaterials;
    vertexColor.set(0, 0, 0);

    for (let m = 0; m < numMaterials; m += 1) {
      const w = weights[base + m];
      if (w > 0.001) {
        vertexColor.r += matColors[m].r * w;
        vertexColor.g += matColors[m].g * w;
        vertexColor.b += matColors[m].b * w;
      }
    }

    const height01 = clamp((positions.getY(i) + 1) * 0.5, 0, 1);
    const slope01 = clamp(1 - normals.getY(i), 0, 1);
    vertexColor.multiplyScalar(0.88 + height01 * 0.16 - slope01 * 0.06);

    colors[i * 3] = vertexColor.r;
    colors[i * 3 + 1] = vertexColor.g;
    colors[i * 3 + 2] = vertexColor.b;
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  // Store weights as vec4 for potential shader use
  const weightsVec4 = new Float32Array(positions.count * MAX_MATERIAL_CHANNELS);
  for (let i = 0; i < positions.count; i += 1) {
    const srcBase = i * numMaterials;
    const dstBase = i * MAX_MATERIAL_CHANNELS;
    for (let m = 0; m < Math.min(numMaterials, MAX_MATERIAL_CHANNELS); m += 1) {
      weightsVec4[dstBase + m] = weights[srcBase + m];
    }
  }
  geometry.setAttribute('materialWeights', new THREE.Float32BufferAttribute(weightsVec4, MAX_MATERIAL_CHANNELS));

  return geometry;
}

const TerrainTileMesh = memo(function TerrainTileMesh({
  tile,
  tileGridSize,
  tileHalfExtentM,
  materials,
  material,
  meshProps,
}: {
  tile: WorldTerrainTile;
  tileGridSize: number;
  tileHalfExtentM: number;
  materials: TerrainMaterial[];
  material: THREE.Material;
  meshProps: Omit<MeshProps, 'geometry' | 'material'>;
}) {
  const geometry = useMemo(
    () => buildTerrainTileGeometryFromDimensions(tileGridSize, tileHalfExtentM, tile, materials),
    [tile, tileGridSize, tileHalfExtentM, materials],
  );

  useEffect(() => () => {
    geometry.dispose();
  }, [geometry]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      receiveShadow
      userData={{ terrainTileX: tile.tileX, terrainTileZ: tile.tileZ }}
      {...meshProps}
    />
  );
});

function buildTerrainMaterial(materials: TerrainMaterial[]): THREE.MeshStandardMaterial {
  const avgRoughness = materials.length > 0
    ? materials.reduce((sum, m) => sum + m.roughness, 0) / materials.length
    : 0.95;
  const avgMetalness = materials.length > 0
    ? materials.reduce((sum, m) => sum + m.metalness, 0) / materials.length
    : 0.02;

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: avgRoughness,
    metalness: avgMetalness,
    dithering: true,
  });

  mat.onBeforeCompile = (shader) => {
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
          gl_FragColor.rgb *= 1.0 - contourLine * (0.12 + slopeShade * 0.22);
          gl_FragColor.rgb += vec3(0.04, 0.03, 0.015) * slopeShade;
          #include <dithering_fragment>
        `,
      );
  };
  mat.customProgramCacheKey = () => 'world-terrain-splatmap-v2';
  return mat;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
