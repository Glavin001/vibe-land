// Marble's subsurface scattering for the material lab: the scene into four
// half-float targets (output, diffuse, normal+depth, material id), then a
// separable 9-tap bilateral blur of the diffuse term only, then composite.
//
// Only imported behind __WEBGPU__.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  RenderTarget,
  HalfFloatType,
  NodeMaterial,
  QuadMesh,
  Vector2,
  Vector4,
} from 'three/webgpu';
import {
  texture,
  wgslFn,
  uniform,
  uv,
  mrt,
  output,
  property,
  vec4,
  normalView,
  positionView,
} from 'three/tsl';
import profiles from './data/diffusion-profiles.json';
import type { MatterView } from './view';
const bilateral: any =
  wgslFn(`fn marbleFilter(d:texture_2d<f32>,dSampler:sampler,nd:texture_2d<f32>,surfaceData:texture_2d<f32>,uv:vec2f,step:vec2f,projection:f32)->vec4f{
 let size=vec2i(textureDimensions(d));let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);let center=textureLoad(d,pixel,0);let info=textureLoad(surfaceData,pixel,0);if(info.x<.5){return center;}
 let surface=textureLoad(nd,pixel,0);let sigma=info.z*.001;let radius=clamp(sigma*projection/max(-surface.w,.001),.1,24.);var sum=vec3f(0.);var total=0.;
 for(var i=-4;i<=4;i++){
  let x=f32(i)*.65;let q=clamp(uv+step*x*radius,vec2f(.0001),vec2f(.9999));let ip=clamp(vec2i(q*vec2f(size)),vec2i(0),size-1);let s=textureLoad(nd,ip,0);let m=textureLoad(surfaceData,ip,0);
  let weight=exp(-x*x*.5)*exp(-abs(s.w-surface.w)/max(sigma*2.,.00001))*pow(max(dot(s.xyz,surface.xyz),0.),24.)*m.x*exp(-abs(m.y-info.y)*3.);
  sum+=textureSampleLevel(d,dSampler,q,0.).rgb*weight;total+=weight;
 }return vec4f(sum/max(total,.00001),1.);
}`);
export class ScatteringPass {
  target = new RenderTarget(1, 1, { count: 4, type: HalfFloatType });
  blur = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  horizontal = new NodeMaterial();
  composite = new NodeMaterial();
  quad = new QuadMesh();
  stepX = uniform(new Vector2(1, 0));
  stepY = uniform(new Vector2(0, 1));
  projection = uniform(1);
  mrt: any;
  disposed = false;
  constructor() {
    ['output', 'diffuse', 'normalDepth', 'scatter'].forEach(
      (n, i) => (this.target.textures[i].name = n),
    );
    this.mrt = mrt({
      output,
      diffuse: vec4(property('vec3', 'totalDiffuse'), 1),
      normalDepth: vec4(normalView, positionView.z),
      scatter: uniform(new Vector4()).onObjectUpdate(({ material }: any) => {
        const r = material.userData.recipe;
        return new Vector4(
          r?.kind === 'marble' ? 1 : 0,
          0,
          r?.kind === 'marble' ? r.finish[0] * diffusionScale : 0,
          1,
        );
      }),
    });
    const d = texture(this.target.textures[1]),
      nd = texture(this.target.textures[2]),
      surfaceData = texture(this.target.textures[3]);
    this.horizontal.fragmentNode = bilateral(
      d,
      d,
      nd,
      surfaceData,
      uv(),
      this.stepX,
      this.projection,
    );
    const filtered = bilateral(
      texture(this.blur.texture),
      texture(this.blur.texture),
      nd,
      surfaceData,
      uv(),
      this.stepY,
      this.projection,
    );
    this.composite.fragmentNode = vec4(
      texture(this.target.textures[0]).rgb.sub(d.rgb).add(filtered.rgb).max(0),
      1,
    );
    this.horizontal.depthTest = false;
    this.horizontal.depthWrite = false;
    this.composite.depthTest = false;
    this.composite.depthWrite = false;
  }
  render(engine: MatterView) {
    const r = engine.renderer;
    const size = r.getDrawingBufferSize(new Vector2());
    this.target.setSize(size.x, size.y);
    this.blur.setSize(size.x, size.y);
    this.stepX.value.set(1 / size.x, 0);
    this.stepY.value.set(0, 1 / size.y);
    this.projection.value =
      size.y / (2 * Math.tan((engine.camera.fov * Math.PI) / 360));
    r.setRenderTarget(this.target);
    r.setMRT(this.mrt);
    r.render(engine.scene, engine.camera);
    r.setMRT(null);
    r.setRenderTarget(this.blur);
    this.quad.material = this.horizontal;
    this.quad.render(r);
    r.setRenderTarget(null);
    this.quad.material = this.composite;
    this.quad.render(r);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.target.dispose();
    this.blur.dispose();
    this.horizontal.dispose();
    this.composite.dispose();
  }
}
export const diffusionScale = profiles.profiles[0].rms_radius_m / 0.001;
