import { useMemo } from 'react';
import * as THREE from 'three';
import type { Chunk, Destructible, WorldDocument } from '../world/worldDocument';
import { expandFactoryKindToChunks } from '../world/destructibleFactory';
import type { SelectedTarget } from '../pages/godModeEditorDocument';

type Props = {
  world: WorldDocument;
  selected: SelectedTarget;
  onSelect: (target: SelectedTarget) => void;
  registerSelectableObject: (key: string, object: THREE.Object3D | null) => void;
};

const STRUCTURE_COLOR = 0x8c94a0;
const WALL_COLOR = 0x9ca3a8;
const TOWER_COLOR = 0xb89460;
const SELECTED_COLOR = 0xffd86e;
const ANCHOR_COLOR = 0x4a5160;

function baseColor(doc: Destructible): number {
  if (doc.kind === 'wall') return WALL_COLOR;
  if (doc.kind === 'tower') return TOWER_COLOR;
  return STRUCTURE_COLOR;
}

function chunksFor(doc: Destructible): Chunk[] {
  if (doc.kind === 'structure') return doc.chunks;
  return expandFactoryKindToChunks(doc.kind);
}

export function DestructibleAuthoringPreview({
  world,
  selected,
  onSelect,
  registerSelectableObject,
}: Props) {
  const docs = world.destructibles;
  if (docs.length === 0) return null;

  return (
    <group>
      {docs.map((doc) => (
        <DestructibleNode
          key={doc.id}
          doc={doc}
          isSelected={selected?.kind === 'destructible' && selected.id === doc.id}
          onSelect={onSelect}
          registerSelectableObject={registerSelectableObject}
        />
      ))}
    </group>
  );
}

function DestructibleNode({
  doc,
  isSelected,
  onSelect,
  registerSelectableObject,
}: {
  doc: Destructible;
  isSelected: boolean;
  onSelect: (target: SelectedTarget) => void;
  registerSelectableObject: (key: string, object: THREE.Object3D | null) => void;
}) {
  const quaternion = useMemo(() => new THREE.Quaternion(...doc.rotation), [doc.rotation]);
  const chunks = useMemo(() => chunksFor(doc), [doc]);
  const highlight = isSelected ? SELECTED_COLOR : baseColor(doc);

  return (
    <group
      ref={(object) => registerSelectableObject(`destructible:${doc.id}`, object)}
      position={doc.position}
      quaternion={quaternion}
    >
      {chunks.map((chunk, index) => (
        <ChunkMesh
          key={index}
          chunk={chunk}
          color={chunk.anchor ? ANCHOR_COLOR : highlight}
          onPointerDown={(event) => {
            event.stopPropagation();
            onSelect({ kind: 'destructible', id: doc.id });
          }}
        />
      ))}
    </group>
  );
}

function ChunkMesh({
  chunk,
  color,
  onPointerDown,
}: {
  chunk: Chunk;
  color: number;
  onPointerDown: (event: THREE.Event & { stopPropagation: () => void }) => void;
}) {
  const quaternion = useMemo(
    () => new THREE.Quaternion(...chunk.rotation),
    [chunk.rotation],
  );
  return (
    <mesh
      position={chunk.position}
      quaternion={quaternion}
      castShadow
      receiveShadow
      onPointerDown={onPointerDown as never}
    >
      {chunk.shape === 'box' && (
        <boxGeometry
          args={[
            (chunk.halfExtents?.[0] ?? 0.25) * 2,
            (chunk.halfExtents?.[1] ?? 0.25) * 2,
            (chunk.halfExtents?.[2] ?? 0.25) * 2,
          ]}
        />
      )}
      {chunk.shape === 'sphere' && (
        <sphereGeometry args={[chunk.radius ?? 0.25, 16, 12]} />
      )}
      {chunk.shape === 'capsule' && (
        <capsuleGeometry args={[chunk.radius ?? 0.25, chunk.height ?? 0.5, 6, 12]} />
      )}
      <meshStandardMaterial color={color} roughness={0.82} metalness={0.06} />
    </mesh>
  );
}
