// The Fracture Lab's 3D view: one specimen drawn twice, "today" (the flat
// colliders, every face in the outer texture, as /city draws chunks now) and
// "enhanced" (the material-driven broken surfaces), moving identically.
//
// WebGPU only: imported lazily by pages/FractureLab.tsx behind __WEBGPU__.

import { addAfterEffect, Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { assembleBroken, assembleToday, type AssembleStats } from '../city/fracture/assemble';
import { findContacts } from '../city/fracture/contacts';
import { FRACTURE_LOOKS } from '../city/fracture/looks';
import { FractureClass } from '../city/fracture/materialClass';
import type { Specimen } from '../city/fracture/specimens';
import { maxDpr } from '../app/renderQuality';
import { SkyEnvironment } from '../graphics/SkyEnvironment';
import { getFogSettings, resolveFogColor } from '../graphics/fogSettings';
import { withRenderBackend } from '../graphics/webgpu/rendererBackend';
import { SunLight } from '../scene/SunLight';
import { loadCityTextures } from '../scene/cityTextures';
import { Blast, brokenInMode, explodedPose, type ExplodeMode } from './explode';
import {
  FractureLookUniforms, LabPoses, SHADOW_LAYER, buildColliderGeometry, buildLabGeometry, colliderMaterial, ghostMaterial,
  glassMaterial, labMaterial, shadowProxyMaterial,
} from './labMesh';
import type { PackSpecimen } from './packSpecimen';
import { TieredStage, type TierStats } from './TieredStage';
import { layerCodes, labTriplanar } from './labShared';

export type Compare = 'split' | 'enhanced' | 'today';
export type Bodies = 'visual' | 'collider' | 'both';

export interface LabState {
  compare: Compare;
  mode: ExplodeMode;
  amount: number;
  spin: number;
  /** Bumped by the Blast button; restarts the throw. */
  blastToken: number;
  blastStrength: number;
  timeScale: number;
  bodies: Bodies;
  shading: boolean;
  rough: boolean;
  /** Round and chip the original outer edges. */
  wear: boolean;
  rebar: boolean;
  density: number;
  debugKinds: boolean;
  wireframe: boolean;
  /** Outer faces: procedural skins, or the city's photo texture layers. */
  skin: 'procedural' | 'city';
  copies: number;
  seed: number;
  /**
   * Scene scale: copies become ONE scene of distinct pieces, every piece
   * shading-only, and only those within `tierRadius` of the camera get the
   * detailed geometry, built `tierBudgetMs` per frame into a fixed pool.
   */
  tiered: boolean;
  tierRadius: number;
  tierBudgetMs: number;
  /** Sun shadows at all; and re-rendered every Nth frame (1 = every frame). */
  shadows: boolean;
  shadowEvery: number;
  /** Scene scale: skip copies outside the camera frustum (as /city culls cells). */
  cull: boolean;
  /**
   * Scene scale: the shading-only tier in the compact vertex layout (shared
   * corners, flat derivative normals, 20 bytes a vertex). Procedural skins.
   */
  compact: boolean;
  /** Compact tier: one shader per (class, skin/cut) group, not one uber-shader. */
  specialise: boolean;
  /** Render resolution as a fraction of the display's (upscaled to fit). */
  scale: number;
  /** Multisample anti-aliasing (a new renderer when it changes). */
  aa: boolean;
  /** Value noise from the precomputed 3D table, or hashed per call. */
  noise: 'texture' | 'hash';
  /** Bench cost probe for the scene-scale materials (labMaterial `probe`). */
  probe: '' | 'unlit' | 'lit';
  /** Bumped when a geometry look parameter changes. */
  lookVersion: number;
}

export interface LabStats {
  pieces: number;
  build: AssembleStats | null;
  todayTriangles: number;
  enhancedTriangles: number;
  frameMs: number;
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
  /** Scene-scale mode only. */
  tier?: TierStats;
}

export interface LabCameraApi {
  setCamera(position: [number, number, number], target: [number, number, number]): void;
  frame(): void;
  /** Where piece i of the enhanced (or only) variant is drawn now. */
  pieceCenter(i: number): [number, number, number] | null;
  /** Bounding radius of piece i about its centre. */
  pieceRadius(i: number): number;
}

interface SceneProps {
  specimen: Specimen;
  state: LabState;
  onStats: (stats: LabStats) => void;
  onCamera: (api: LabCameraApi) => void;
}

export function FractureLabCanvas(props: SceneProps) {
  const fogColor = resolveFogColor(getFogSettings());
  useEffect(() => { loadCityTextures(); }, []);
  const scale = props.state.scale;
  const dpr: number | [number, number] = scale === 1 ? [1, maxDpr()] : Math.min(window.devicePixelRatio || 1, maxDpr()) * scale;
  return (
    <Canvas
      key={props.state.aa ? 'msaa' : 'single'}
      {...withRenderBackend({
        shadows: true,
        dpr,
        gl: { antialias: props.state.aa, powerPreference: 'high-performance', trackTimestamp: true } as never,
        camera: { fov: 45, near: 0.03, far: 600, position: [0, 2, 9] },
        frameloop: 'always',
      })}
      style={{ position: 'absolute', inset: 0 }}
    >
      <SkyEnvironment fogColor={fogColor} />
      <SunLight fogColor={fogColor} shadowHalfExtent={14} shadowMapSize={4096} castShadow={props.state.shadows} />
      <ShadowCadence every={props.state.shadowEvery} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#6b6e63" roughness={1} metalness={0} />
      </mesh>
      {props.state.tiered ? <TieredStage {...props} /> : <LabStage {...props} />}
      <GpuSampler />
    </Canvas>
  );
}

const TRIPLANAR = labTriplanar;

declare global {
  interface Window {
    /** Bench hook: the GPU time of each of the next `frames` frames, ms. */
    __VIBE_FRACTURE_GPU__?: (frames: number) => Promise<number[]>;
  }
}

/**
 * Re-render the sun's shadow map only every Nth frame. Shadows move with
 * debris, but a shadow a frame or three old is invisible at 120 Hz, and the
 * shadow pass re-draws every piece's geometry: at scene scale it is the
 * biggest single pass after the main one.
 */
function ShadowCadence({ every }: { every: number }) {
  const scene = useThree((s) => s.scene);
  const frame = useRef(0);
  useFrame(() => {
    frame.current += 1;
    const due = every <= 1 || frame.current % Math.round(every) === 0;
    scene.traverse((object) => {
      const light = object as THREE.DirectionalLight;
      if (!light.isDirectionalLight || !light.castShadow) return;
      // The shadow camera sees the shadow proxies' layer (labMesh.ts).
      light.shadow.camera.layers.enable(SHADOW_LAYER);
      light.shadow.autoUpdate = every <= 1;
      if (due) light.shadow.needsUpdate = true;
    });
  });
  return null;
}

/**
 * Per-frame GPU time for the bench (tools/fracture-bench.mjs): resolves the
 * timestamp queries after every frame, so a sample is one frame's passes
 * (main and shadow), not a reading every half second.
 */
function GpuSampler() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const resolve = (gl as { resolveTimestampsAsync?: (type?: string) => Promise<number | undefined> }).resolveTimestampsAsync;
    window.__VIBE_FRACTURE_GPU__ = async (frames: number) => {
      const out: number[] = [];
      for (let i = 0; i < frames; i += 1) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const ms = resolve ? await resolve.call(gl, 'render') : undefined;
        if (typeof ms === 'number' && ms > 0) out.push(ms);
      }
      return out;
    };
    return () => { delete window.__VIBE_FRACTURE_GPU__; };
  }, [gl]);
  return null;
}

function LabStage({ specimen, state, onStats, onCamera }: SceneProps) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const root = useMemo(() => new THREE.Group(), []);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.add(root);
    return () => { scene.remove(root); };
  }, [scene, root]);

  const looks = useMemo(() => new FractureLookUniforms(), []);
  useEffect(() => { looks.setRebar(specimen.rebar); }, [looks, specimen]);
  const pieces = specimen.pieces;
  const table = useMemo(
    () => findContacts(pieces, { bondMaterial: (specimen as Partial<PackSpecimen>).bondMaterial }),
    [specimen, pieces],
  );
  const broken = useMemo(() => brokenInMode(specimen, table.contacts, state.mode), [specimen, table, state.mode]);
  const codes = useMemo(() => layerCodes(specimen), [specimen]);

  // Glass draws in its own see-through mesh; everything else in one opaque one.
  const isGlass = (p: { cls: number }): boolean => p.cls === FractureClass.Glass;
  const opaque = (p: { cls: number }): boolean => !isGlass(p);
  const hasGlass = useMemo(() => pieces.some(isGlass), [pieces]);
  const today = useMemo(() => {
    const meshes = assembleToday(pieces);
    return {
      geometry: buildLabGeometry(pieces, meshes, codes, opaque),
      glass: hasGlass ? buildLabGeometry(pieces, meshes, codes, isGlass) : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces, codes, hasGlass]);
  const todayGeometry = today.geometry;
  const enhanced = useMemo(() => {
    const built = assembleBroken(pieces, table, {
      broken, rough: state.rough, wear: state.wear, rebar: state.rebar, density: state.density,
      looks: FRACTURE_LOOKS, families: specimen.rebar, seed: state.seed,
    });
    return {
      geometry: buildLabGeometry(pieces, built.meshes, codes, opaque),
      glass: hasGlass ? buildLabGeometry(pieces, built.meshes, codes, isGlass) : null,
      stats: built.stats,
    };
    // lookVersion: a geometry parameter changed in the look table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces, table, broken, state.rough, state.wear, state.rebar, state.density, state.seed, codes, specimen, state.lookVersion]);
  const colliderGeometry = useMemo(() => buildColliderGeometry(pieces), [pieces]);

  const posesToday = useMemo(() => new LabPoses(pieces.length), [pieces]);
  const posesEnhanced = useMemo(() => new LabPoses(pieces.length), [pieces]);

  const materials = useMemo(() => {
    const triplanar = TRIPLANAR();
    return {
      today: labMaterial(posesToday, looks, {
        triplanar, fracture: false, debugKinds: false, wireframe: state.wireframe, skin: 'city',
      }),
      enhanced: labMaterial(posesEnhanced, looks, {
        triplanar, fracture: state.shading, debugKinds: state.debugKinds, wireframe: state.wireframe, skin: state.skin,
        noise: state.noise,
      }),
      todayLines: colliderMaterial(posesToday, '#40d0ff'),
      enhancedLines: colliderMaterial(posesEnhanced, '#40d0ff'),
      todayGhost: ghostMaterial(posesToday),
      enhancedGhost: ghostMaterial(posesEnhanced),
      todayShadow: shadowProxyMaterial(posesToday),
      enhancedShadow: shadowProxyMaterial(posesEnhanced),
      todayGlass: glassMaterial(posesToday, { fracture: false, wireframe: state.wireframe }),
      enhancedGlass: glassMaterial(posesEnhanced, { fracture: state.shading, wireframe: state.wireframe }),
    };
  }, [posesToday, posesEnhanced, looks, state.shading, state.debugKinds, state.wireframe, state.skin, state.noise]);

  // Build the draw objects: variants x copies, visual and/or collider.
  const variants = useRef<Array<{ group: THREE.Group; side: -1 | 0 | 1 }>>([]);
  useEffect(() => {
    const created: THREE.Object3D[] = [];
    variants.current = [];
    const sides: Array<{ which: 'today' | 'enhanced'; side: -1 | 0 | 1 }> = state.compare === 'split'
      ? [{ which: 'today', side: -1 }, { which: 'enhanced', side: 1 }]
      : [{ which: state.compare, side: 0 }];
    for (const { which, side } of sides) {
      for (let copy = 0; copy < Math.max(1, state.copies); copy += 1) {
        const group = new THREE.Group();
        group.userData.copy = copy;
        if (state.bodies !== 'collider') {
          const mesh = new THREE.Mesh(which === 'today' ? todayGeometry : enhanced.geometry,
            which === 'today' ? materials.today : materials.enhanced);
          mesh.castShadow = false;
          mesh.receiveShadow = state.shadows;
          mesh.frustumCulled = false;
          group.add(mesh);
          if (state.shadows) {
            // Shadows from the flat collider shape, in a bare material (labMesh.ts).
            const proxy = new THREE.Mesh(todayGeometry, which === 'today' ? materials.todayShadow : materials.enhancedShadow);
            proxy.castShadow = true;
            proxy.frustumCulled = false;
            proxy.layers.set(SHADOW_LAYER);
            group.add(proxy);
          }
          const glass = which === 'today' ? today.glass : enhanced.glass;
          if (glass) {
            const pane = new THREE.Mesh(glass, which === 'today' ? materials.todayGlass : materials.enhancedGlass);
            pane.frustumCulled = false;
            pane.renderOrder = 1;
            group.add(pane);
          }
        }
        if (state.bodies !== 'visual') {
          const lines = new THREE.LineSegments(colliderGeometry, which === 'today' ? materials.todayLines : materials.enhancedLines);
          lines.frustumCulled = false;
          group.add(lines);
          if (state.bodies === 'collider') {
            const ghost = new THREE.Mesh(todayGeometry, which === 'today' ? materials.todayGhost : materials.enhancedGhost);
            ghost.frustumCulled = false;
            group.add(ghost);
          }
        }
        root.add(group);
        created.push(group);
        variants.current.push({ group, side });
      }
    }
    return () => {
      for (const object of created) root.remove(object);
    };
  }, [root, state.compare, state.copies, state.bodies, state.shadows, today, enhanced, colliderGeometry, materials]);

  useEffect(() => () => {
    today.geometry.dispose();
    today.glass?.dispose();
  }, [today]);
  useEffect(() => () => {
    enhanced.geometry.dispose();
    enhanced.glass?.dispose();
  }, [enhanced]);

  // Blast simulation.
  const blast = useRef<Blast | null>(null);
  useEffect(() => {
    blast.current = state.mode === 'blast' ? new Blast(specimen, state.seed, state.blastStrength) : null;
  }, [specimen, state.mode, state.blastToken, state.seed, state.blastStrength]);

  // Camera framing.
  const span = useMemo(() => {
    const size = [0, 1, 2].map((k) => specimen.max[k] - specimen.min[k]);
    return { width: size[0], height: size[1], depth: size[2], radius: Math.hypot(size[0], size[1], size[2]) / 2 };
  }, [specimen]);
  const centre = useMemo<[number, number, number]>(() => [
    (specimen.min[0] + specimen.max[0]) / 2, (specimen.min[1] + specimen.max[1]) / 2, (specimen.min[2] + specimen.max[2]) / 2,
  ], [specimen]);
  const offsetX = (state.compare === 'split' ? 1 : 0) * (span.width * (1 + 0.9 * state.amount) / 2 + Math.max(0.5, span.width * 0.2));

  useEffect(() => {
    const api: LabCameraApi = {
      setCamera(position, target) {
        camera.position.set(...position);
        controlsRef.current?.target.set(...target);
        camera.lookAt(new THREE.Vector3(...target));
        controlsRef.current?.update();
      },
      pieceCenter(i) {
        const entry = variants.current.find((v) => v.side >= 0);
        const pose = posesEnhanced.data;
        if (!entry || i < 0 || i >= pieces.length) return null;
        const g = entry.group.position;
        return [pose[i * 8] + g.x, pose[i * 8 + 1] + g.y, pose[i * 8 + 2] + g.z];
      },
      pieceRadius(i) {
        const piece = pieces[i];
        if (!piece) return 0;
        return Math.max(...piece.poly.verts.map((v) => Math.hypot(v[0], v[1], v[2])));
      },
      frame() {
        const wide = state.compare === 'split' ? offsetX * 2 + span.width * 1.6 : span.width * 1.6;
        const distance = Math.max(2.5, Math.max(wide, span.height * 1.8) * 1.05);
        api.setCamera([centre[0], centre[1] + span.height * 0.25, centre[2] + distance], centre);
      },
    };
    onCamera(api);
    // Frame on specimen change only, not on every slider move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimen, camera]);
  useEffect(() => {
    const t = setTimeout(() => {
      const wide = state.compare === 'split' ? offsetX * 2 + span.width * 1.6 : span.width * 1.6;
      const distance = Math.max(2.5, Math.max(wide, span.height * 1.8) * 1.05);
      camera.position.set(centre[0], centre[1] + span.height * 0.25, centre[2] + distance);
      controlsRef.current?.target.set(...centre);
      controlsRef.current?.update();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimen]);

  // Stats sampling. Draw calls and triangles are read right after the frame
  // rendered (three resets them at the start of each render).
  const frames = useRef({ count: 0, total: 0, last: performance.now(), gpu: null as number | null, emitted: 0, draws: 0, tris: 0 });
  useEffect(() => addAfterEffect(() => {
    const render = (gl as unknown as { info: { render: { drawCalls?: number; triangles: number } } }).info?.render;
    if (!render) return;
    frames.current.draws = render.drawCalls ?? 0;
    frames.current.tris = render.triangles;
  }), [gl]);
  const enhancedTriangles = enhanced.stats.triangles;
  const todayTriangles = useMemo(() => (todayGeometry.index?.count ?? 0) / 3, [todayGeometry]);

  useFrame((_, dt) => {
    looks.refresh();
    // Poses.
    const sim = blast.current;
    if (sim) sim.step(Math.min(dt, 1 / 30) * state.timeScale);
    for (let i = 0; i < pieces.length; i += 1) {
      const pose = sim ? sim.pose(i) : explodedPose(specimen, i, state.mode, state.amount, state.spin, state.seed);
      posesToday.set(i, pose.p, pose.q);
      posesEnhanced.set(i, pose.p, pose.q);
    }
    posesToday.upload();
    posesEnhanced.upload();
    // Layout: split sides, copies in rows behind.
    for (const { group, side } of variants.current) {
      const copy = group.userData.copy as number;
      const cols = Math.ceil(Math.sqrt(Math.max(1, state.copies)));
      const row = Math.floor(copy / cols);
      const col = copy % cols;
      const pitchX = span.width * 1.4 + 0.6;
      const pitchZ = Math.max(span.depth, 1) * 1.8 + 1.5;
      group.position.set(side * offsetX + (col - (cols - 1) / 2) * (state.copies > 1 ? pitchX : 0), 0, -row * pitchZ);
    }
    // Timing.
    const f = frames.current;
    const now = performance.now();
    f.count += 1;
    f.total += now - f.last;
    f.last = now;
    if (now - f.emitted > 500) {
      const resolve = (gl as { resolveTimestampsAsync?: (type?: string) => Promise<number | undefined> }).resolveTimestampsAsync;
      if (resolve) {
        void resolve.call(gl, 'render').then((ms) => { if (typeof ms === 'number' && ms > 0) f.gpu = ms; }).catch(() => {});
      }
      onStats({
        pieces: pieces.length,
        build: enhanced.stats,
        todayTriangles,
        enhancedTriangles,
        frameMs: f.total / Math.max(1, f.count),
        gpuMs: f.gpu,
        drawCalls: f.draws,
        triangles: f.tris,
      });
      f.count = 0;
      f.total = 0;
      f.emitted = now;
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      target={centre}
      enableDamping
      maxPolarAngle={Math.PI / 2 - 0.01}
      minDistance={0.3}
      maxDistance={200}
    />
  );
}
