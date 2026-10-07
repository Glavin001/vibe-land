// What the lab's extra passes (scattering.ts, glass-scene.ts) need of a view:
// the renderer, the scene and camera it draws, and the group holding the
// specimens. specimens.ts's MatterStage is one.
import type { Group, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

export interface MatterView {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  group: Group;
  /** 'sample' draws the lab's reference backdrop the glass ray tracer intersects. */
  sceneMode: 'sample' | 'interior' | 'courtyard';
}
