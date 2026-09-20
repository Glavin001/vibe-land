// The fire on a falling meteor: a raymarched density field, drawn as a frame
// pipeline stage so it can read the scene's depth and wrap the rock and
// whatever it is about to hit.
//
// Ported from the Meteor Lab studio's volume pass. Two departures from it:
// several meteors are marched in one pass (the studio supported one per
// pipeline), and the field is evaluated in units of the rock's radius rather
// than metres, so the same look scales from the studio's two-metre rock to
// whatever the server launches. The output is premultiplied emission laid
// over the stage before it, in the linear HDR space the composite tone-maps;
// the studio's bloom is not reproduced, ACES on the composite does most of
// what it did.

import * as THREE from 'three';

import type { PipelineStage, PipelineStageContext, StageOutput } from '../graphics/framePipelineStages';
import { renderStats } from '../city/renderStats';
import { NOISE_GLSL, ROCK_SCALE } from './meteorRock';
import { UPSAMPLE_GLSL } from './dustVolumeShaders';

export const MAX_FIRE_METEORS = 4;

export interface MeteorFireInstance {
  /** World centre of the rock. */
  center: THREE.Vector3;
  /** Unit; the way the flames point (against the motion, plus buoyancy). */
  direction: THREE.Vector3;
  radiusM: number;
  /** Speed through the air, m/s, for the trail length. */
  airSpeed: number;
  /** World -> unit-rock space, for hollowing the fire out around the rock. */
  inverseRock: THREE.Matrix4;
  seed: number;
  /** 0 hides the fire; 1 is the studio's default. */
  intensity: number;
}

const VOLUME_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tUnder;
/** 0 none; 1 tUnder is full-res; 2 tUnder is half-res and laid up here. */
uniform float uUnderOn;
uniform vec2 uUnderHalfSize;
uniform float uNear, uFar;
uniform mat4 uInvProjection, uCameraWorld;
${UPSAMPLE_GLSL}
uniform vec3 uCamera;
uniform float uTime, uTurbulence, uTrail;
uniform int uSteps;
uniform int uCount;
uniform vec3 uCenter[${MAX_FIRE_METEORS}];
uniform vec3 uDirection[${MAX_FIRE_METEORS}];
uniform float uRadius[${MAX_FIRE_METEORS}];
uniform float uWind[${MAX_FIRE_METEORS}];
uniform float uSeed[${MAX_FIRE_METEORS}];
uniform float uIntensity[${MAX_FIRE_METEORS}];
uniform mat4 uInverseRock[${MAX_FIRE_METEORS}];
${NOISE_GLSL}

vec2 sphereHit(vec3 ro, vec3 rd, vec3 center, float r) {
  vec3 oc = ro - center;
  float b = dot(oc, rd), c = dot(oc, oc) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  return vec2(-b - sqrt(d), -b + sqrt(d));
}

// One meteor's contribution along the ray, in rock units: emission and the
// transmittance left after it.
void marchMeteor(int m, vec3 ray, float maxDepthM, inout vec3 emission, inout float trans) {
  float R = uRadius[m];
  vec3 center = uCenter[m];
  vec3 dir = uDirection[m];
  float intensity = uIntensity[m];
  if (intensity <= 0.0) return;
  // Everything below is in rock radii, centred on the rock.
  vec3 ro = (uCamera - center) / R;
  float maxDepth = maxDepthM / R;
  float trail = uTrail * (0.72 + min(uWind[m], 50.0) * 0.022);
  vec3 envelopeCenter = dir * trail * 0.35;
  vec2 hit = sphereHit(ro, ray, envelopeCenter, 1.8 + trail * 0.55);
  if (hit.y <= 0.0) return;
  float near = max(hit.x, 0.0), far = min(hit.y, maxDepth);
  float stepSize = (far - near) / float(uSteps);
  if (stepSize <= 0.0) return;
  float jitter = 0.4 + 0.2 * hash13(vec3(gl_FragCoord.xy, 17.0));
  float t = near + jitter * stepSize;
  float seed = uSeed[m];
  mat4 inverseRock = uInverseRock[m];
  for (int i = 0; i < 112; i++) {
    if (i >= uSteps || trans < 0.025) break;
    vec3 p = ro + ray * t;
    float h = dot(p, dir);
    vec3 radial = p - dir * h;
    if (h > -0.95 && h < trail + 1.3) {
      float rise = max(h, 0.0);
      float speed = 1.1 + uWind[m] * 0.05;
      vec3 flow = p * 2.6 - dir * uTime * speed + vec3(seed * 0.17);
      vec3 curl = vec3(noise3(flow * 0.68 + 3.0), noise3(flow * 0.71 + 17.0), noise3(flow * 0.73 + 41.0)) - 0.5;
      vec3 wobble = curl * (0.27 + rise * 0.24) * uTurbulence;
      wobble -= dir * dot(wobble, dir);
      float r = length(radial + wobble);
      float taper = clamp(1.0 - max(h - 0.25, 0.0) / (trail + 0.3), 0.0, 1.0);
      float radius = 1.05 * pow(taper, 0.65);
      float n = fbm(flow + curl * uTurbulence * 1.8);
      float fine = noise3(flow * 3.1 - dir * uTime * 0.9);
      float field = radius - r + (n - 0.5) * (0.82 + rise * 0.2) * uTurbulence;
      float envelope = smoothstep(-1.0, -0.45, h) * (1.0 - smoothstep(trail * 0.78, trail + 0.2, h));
      vec3 rockLocal = (inverseRock * vec4(p * R + center, 1.0)).xyz;
      float hollow = smoothstep(0.85, 1.15, length(rockLocal / vec3(${ROCK_SCALE[0]}, ${ROCK_SCALE[1]}, ${ROCK_SCALE[2]})));
      float tongues = smoothstep(0.36, 0.72, n) * smoothstep(-0.1, 0.23, field);
      float density = tongues * envelope * hollow * (0.65 + fine * 0.65) * intensity;
      float heat = clamp(density * 0.92 * mix(1.0, 0.65, smoothstep(0.8, trail, h)), 0.0, 1.0);
      vec3 color = mix(vec3(0.7, 0.028, 0.003), vec3(3.2, 0.30, 0.008), smoothstep(0.04, 0.35, heat));
      color = mix(color, vec3(6.0, 1.4, 0.09), smoothstep(0.35, 0.75, heat));
      color = mix(color, vec3(8.0, 4.5, 1.4), smoothstep(0.75, 1.0, heat));
      float alpha = 1.0 - exp(-density * 2.6 * stepSize);
      emission += trans * alpha * color;
      trans *= 1.0 - alpha;
      float smokeN = noise3(flow * 0.7);
      float smoke = smoothstep(0.25, 0.7, h / trail)
        * smoothstep(-0.2, 0.5, radius + 0.25 - r + (smokeN - 0.5) * 0.8)
        * (0.12 + 0.22 * uTurbulence) * (1.0 - envelope * 0.7) * smoothstep(0.0, 0.6, h) * hollow;
      float sa = 1.0 - exp(-smoke * stepSize);
      emission += trans * sa * vec3(0.033, 0.03, 0.029);
      trans *= 1.0 - sa;
    }
    t += stepSize;
  }
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  vec4 clip = uInvProjection * vec4(uv, 1.0, 1.0);
  vec3 ray = normalize((uCameraWorld * vec4(clip.xyz / clip.w, 0.0)).xyz);
  float depth = texture2D(tDepth, vUv).x;
  vec4 view = uInvProjection * vec4(uv, depth * 2.0 - 1.0, 1.0);
  vec3 world = (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
  float maxDepth = length(world - uCamera);
  vec3 emission = vec3(0.0);
  float trans = 1.0;
  for (int m = 0; m < ${MAX_FIRE_METEORS}; m++) {
    if (m >= uCount) break;
    marchMeteor(m, ray, maxDepth, emission, trans);
  }
  vec4 under = uUnderOn > 1.5 ? dustUpsample(tUnder, tDepth, vUv, uUnderHalfSize, uNear, uFar)
    : uUnderOn > 0.5 ? texture2D(tUnder, vUv) : vec4(0.0);
  // Premultiplied over: the fire in front of whatever the earlier stages drew.
  gl_FragColor = vec4(emission + under.rgb * trans, 1.0 - trans * (1.0 - under.a));
}
`;

const VOLUME_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class MeteorFireStage implements PipelineStage {
  readonly order = 10;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.PlaneGeometry;
  private instances: MeteorFireInstance[] = [];
  private time = 0;
  /** Samples per pixel inside a meteor's envelope. The studio's "high" is 68. */
  steps = 56;
  /** Studio defaults. */
  turbulence = 0.65;
  trail = 3.2;

  constructor() {
    const arr = (fill: () => unknown) => Array.from({ length: MAX_FIRE_METEORS }, fill);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tUnder: { value: null },
        uUnderOn: { value: 0 },
        uUnderHalfSize: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 200 },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uCamera: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uTurbulence: { value: this.turbulence },
        uTrail: { value: this.trail },
        uSteps: { value: this.steps },
        uCount: { value: 0 },
        uCenter: { value: arr(() => new THREE.Vector3()) },
        uDirection: { value: arr(() => new THREE.Vector3(0, 1, 0)) },
        uRadius: { value: arr(() => 1) },
        uWind: { value: arr(() => 0) },
        uSeed: { value: arr(() => 42) },
        uIntensity: { value: arr(() => 0) },
        uInverseRock: { value: arr(() => new THREE.Matrix4()) },
      },
      vertexShader: VOLUME_VERTEX,
      fragmentShader: VOLUME_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new THREE.PlaneGeometry(2, 2);
    this.scene.add(new THREE.Mesh(this.quad, this.material));
  }

  /** What to draw this frame. Called by the layer before the pipeline runs. */
  setInstances(instances: MeteorFireInstance[]): void {
    this.instances = instances;
  }

  output(): StageOutput | null {
    return this.target ? { texture: this.target.texture, halfSize: null } : null;
  }

  resize(width: number, height: number): void {
    if (this.target && this.target.width === width && this.target.height === height) return;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  render(ctx: PipelineStageContext): boolean {
    const count = Math.min(this.instances.length, MAX_FIRE_METEORS);
    if (count === 0) return false;
    const { renderer, camera, beauty, width, height, dt, under } = ctx;
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.resize(width, height);
    }
    const started = performance.now();
    this.time += dt;
    const u = this.material.uniforms;
    u.tDepth.value = beauty.depthTexture;
    u.tUnder.value = under?.texture ?? null;
    u.uUnderOn.value = under ? (under.halfSize ? 2 : 1) : 0;
    if (under?.halfSize) (u.uUnderHalfSize.value as THREE.Vector2).copy(under.halfSize);
    const perspective = camera as THREE.PerspectiveCamera;
    u.uNear.value = perspective.near ?? 0.1;
    u.uFar.value = perspective.far ?? 200;
    camera.updateMatrixWorld();
    (u.uInvProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (u.uCamera.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    u.uTime.value = this.time;
    u.uTurbulence.value = this.turbulence;
    u.uTrail.value = this.trail;
    u.uSteps.value = this.steps;
    u.uCount.value = count;
    for (let i = 0; i < count; i += 1) {
      const inst = this.instances[i];
      (u.uCenter.value as THREE.Vector3[])[i].copy(inst.center);
      (u.uDirection.value as THREE.Vector3[])[i].copy(inst.direction);
      (u.uRadius.value as number[])[i] = inst.radiusM;
      (u.uWind.value as number[])[i] = inst.airSpeed;
      (u.uSeed.value as number[])[i] = inst.seed;
      (u.uIntensity.value as number[])[i] = inst.intensity;
      (u.uInverseRock.value as THREE.Matrix4[])[i].copy(inst.inverseRock);
    }
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.quadCamera);
    renderer.setRenderTarget(null);
    renderStats.meteorFireMs = performance.now() - started;
    return true;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
    this.quad.dispose();
  }
}
