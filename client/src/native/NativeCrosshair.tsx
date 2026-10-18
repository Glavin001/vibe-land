// The crosshair (the web client's is DOM, which the native app does not
// have): a small cross at the centre of the view, in the screen-space overlay
// (NativeOverlay), so it stays put however the camera moves.

const ARM_PX = 9;
const THICKNESS_PX = 2;

export function NativeCrosshair() {
  return (
    <group>
      {[[ARM_PX * 2, THICKNESS_PX], [THICKNESS_PX, ARM_PX * 2]].map(([w, h], i) => (
        <mesh key={i} renderOrder={1000} frustumCulled={false}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent opacity={0.9} fog={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
