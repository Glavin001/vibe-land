// The opaque scene behind the lab's optical glass: one extra render per frame
// with the glass hidden, colour and depth, for glass.ts to look through.
//
// Only imported behind __WEBGPU__.
import {
  RenderTarget,
  HalfFloatType,
  DepthTexture,
  UnsignedIntType,
  Matrix4,
  Mesh,
  Material,
  Vector2,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { MatterView } from './view';
export class GlassScenePass {
  referenceScene = uniform(1);
  target = new RenderTarget(1, 1, { type: HalfFloatType });
  viewProjection = uniform(new Matrix4());
  disposed = false;
  constructor() {
    this.target.depthTexture = new DepthTexture(1, 1, UnsignedIntType);
  }
  capture(engine: MatterView) {
    this.referenceScene.value = engine.sceneMode === 'sample' ? 1 : 0;
    const size = engine.renderer.getDrawingBufferSize(new Vector2());
    this.target.setSize(size.x, size.y);
    engine.camera.updateMatrixWorld();
    this.viewProjection.value.multiplyMatrices(
      engine.camera.projectionMatrix,
      engine.camera.matrixWorldInverse,
    );
    const hidden: Mesh[] = [];
    engine.group.traverse((o) => {
      if (
        o instanceof Mesh &&
        o.visible &&
        (o.material as Material).userData.recipe?.kind === 'glass'
      ) {
        hidden.push(o);
        o.visible = false;
      }
    });
    engine.renderer.setRenderTarget(this.target);
    engine.renderer.render(engine.scene, engine.camera);
    engine.renderer.setRenderTarget(null);
    hidden.forEach((m) => (m.visible = true));
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.target.dispose();
  }
}
