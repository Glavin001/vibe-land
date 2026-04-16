import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { computeCustomStencilDiff, type CustomStencilDefinition } from '../../ai/customStencil';
import type { WorldDocument } from '../../world/worldDocument';

const RAISE_COLOR = new THREE.Color(0x4ca5ff);
const LOWER_COLOR = new THREE.Color(0xffb25c);
const QUANTIZE_STEP = 0.5;

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function ignorePointerRaycast(): void {}

export function CustomStencilPreview({
  world,
  stencilDef,
  params,
  centerX,
  centerZ,
}: {
  world: WorldDocument;
  stencilDef: CustomStencilDefinition;
  params: Record<string, unknown>;
  centerX: number;
  centerZ: number;
}) {
  const qx = quantize(centerX, QUANTIZE_STEP);
  const qz = quantize(centerZ, QUANTIZE_STEP);
  const paramsKey = JSON.stringify(params);

  const geometry = useMemo(() => {
    let diff;
    try {
      diff = computeCustomStencilDiff(world, stencilDef, params, qx, qz);
    } catch {
      return null;
    }
    if (diff.samples.length === 0 || diff.maxAbsDelta === 0) return null;

    // Build a quad mesh: one small quad per affected sample.
    // Quad size is based on the terrain sample spacing.
    const gridSize = world.terrain.tileGridSize;
    const side = world.terrain.tileHalfExtentM * 2;
    const sampleSpacing = gridSize > 1 ? side / (gridSize - 1) : 1;
    const halfQuad = sampleSpacing * 0.5;

    const vertCount = diff.samples.length * 4;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const indices: number[] = [];

    for (let i = 0; i < diff.samples.length; i += 1) {
      const s = diff.samples[i];
      const y = s.afterY + 0.06; // slightly above terrain
      const base = i * 4;

      // Four vertices of a small quad centered at (s.x, y, s.z)
      positions[base * 3 + 0] = s.x - halfQuad;
      positions[base * 3 + 1] = y;
      positions[base * 3 + 2] = s.z - halfQuad;

      positions[(base + 1) * 3 + 0] = s.x + halfQuad;
      positions[(base + 1) * 3 + 1] = y;
      positions[(base + 1) * 3 + 2] = s.z - halfQuad;

      positions[(base + 2) * 3 + 0] = s.x - halfQuad;
      positions[(base + 2) * 3 + 1] = y;
      positions[(base + 2) * 3 + 2] = s.z + halfQuad;

      positions[(base + 3) * 3 + 0] = s.x + halfQuad;
      positions[(base + 3) * 3 + 1] = y;
      positions[(base + 3) * 3 + 2] = s.z + halfQuad;

      // Color based on direction and intensity
      const color = s.deltaY > 0 ? RAISE_COLOR : LOWER_COLOR;
      for (let v = 0; v < 4; v += 1) {
        colors[(base + v) * 3 + 0] = color.r;
        colors[(base + v) * 3 + 1] = color.g;
        colors[(base + v) * 3 + 2] = color.b;
      }

      // Two triangles per quad
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, stencilDef.id, stencilDef.applyFn, paramsKey, qx, qz]);

  // Compute opacity based on the diff
  const opacity = useMemo(() => {
    let diff;
    try {
      diff = computeCustomStencilDiff(world, stencilDef, params, qx, qz);
    } catch {
      return 0.3;
    }
    if (diff.maxAbsDelta === 0) return 0.3;
    return Math.min(0.6, 0.15 + diff.maxAbsDelta * 0.05);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, stencilDef.id, stencilDef.applyFn, paramsKey, qx, qz]);

  useEffect(() => {
    return () => {
      if (geometry) geometry.dispose();
    };
  }, [geometry]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} raycast={ignorePointerRaycast} renderOrder={2}>
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={opacity}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}
