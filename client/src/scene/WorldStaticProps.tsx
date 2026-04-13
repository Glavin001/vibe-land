import * as THREE from 'three';
import type { WorldDocument } from '../world/worldDocument';

type WorldStaticPropsProps = {
  world: WorldDocument;
};

export function WorldStaticProps({ world }: WorldStaticPropsProps) {
  return (
    <group>
      {world.staticProps.map((prop) => (
        <mesh
          key={prop.id}
          position={prop.position}
          quaternion={new THREE.Quaternion(...prop.rotation)}
          castShadow
          receiveShadow
        >
          <boxGeometry args={prop.halfExtents.map((value) => value * 2) as [number, number, number]} />
          <meshStandardMaterial color={prop.material === 'pit-wall' ? 0x7c6850 : 0x7f8a96} roughness={0.88} metalness={0.04} />
        </mesh>
      ))}
    </group>
  );
}
