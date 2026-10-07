// The Fracture Lab at scene scale: many copies of a specimen (one hundred
// houses is ~190k pieces), every piece drawn shading-only by default, and the
// pieces NEAR THE CAMERA rebuilt with full detail -- rough cracks, worn
// edges, rebar -- into a fixed-size pool, a few per frame, within a time
// budget. This is the runtime shape the city would use: the cost of the
// detailed tier depends on what is near the camera, not on how much of the
// scene is broken.
//
//   base   one InstancedMesh: the specimen's flat collider geometry (with its
//          cut faces marked, so the procedural shading still reads broken),
//          one instance per copy; piece p of copy c is global piece
//          p + c * N in the pose texture.
//   pool   SkinPool: the detailed meshes of the pieces within the radius.
//   flag   a pose's fourth component: 1 drawn by the base, 2 by the pool.
//
// WebGPU only: imported by FractureLabScene behind __WEBGPU__.

import { addAfterEffect, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { FractureBuilder } from '../city/fracture/assemble';
import { findContacts } from '../city/fracture/contacts';
import { FRACTURE_LOOKS } from '../city/fracture/looks';
import { FractureClass } from '../city/fracture/materialClass';
import type { Specimen } from '../city/fracture/specimens';
import { Blast, brokenInMode, explodedPose, type Pose } from './explode';
import { copyOffset, labTriplanar, layerCodes } from './labShared';
import { FractureLookUniforms, LabPoses, buildLabGeometry, glassMaterial, labMaterial } from './labMesh';
import type { LabCameraApi, LabState, LabStats } from './FractureLabScene';
import type { PackSpecimen } from './packSpecimen';
import { SkinPool } from './skinPool';

const POOL_VERTICES = 1_500_000;
const POOL_INDICES = 4_500_000;

export interface TierStats {
  chunks: number;
  skinned: number;
  poolVertices: number;
  poolCapacity: number;
  queue: number;
  buildMs: number;
  builtTotal: number;
}

export function TieredStage({ specimen, state, onStats, onCamera }: {
  specimen: Specimen;
  state: LabState;
  onStats: (stats: LabStats) => void;
  onCamera: (api: LabCameraApi) => void;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const pieces = specimen.pieces;
  const n = pieces.length;
  const copies = Math.max(1, state.copies);
  const size = useMemo(() => [0, 1, 2].map((k) => specimen.max[k] - specimen.min[k]), [specimen]);
  const offsets = useMemo(() => Array.from({ length: copies }, (_, c) => copyOffset(c, copies, size)), [copies, size]);

  const looks = useMemo(() => new FractureLookUniforms(), []);
  useEffect(() => { looks.setRebar(specimen.rebar); }, [looks, specimen]);
  const table = useMemo(
    () => findContacts(pieces, { bondMaterial: (specimen as Partial<PackSpecimen>).bondMaterial }),
    [specimen, pieces],
  );
  const broken = useMemo(() => brokenInMode(specimen, table.contacts, state.mode), [specimen, table, state.mode]);
  const codes = useMemo(() => layerCodes(specimen), [specimen]);
  const builder = useMemo(() => new FractureBuilder(pieces, table, {
    broken, rough: state.rough, wear: state.wear, rebar: state.rebar, density: state.density,
    looks: FRACTURE_LOOKS, families: specimen.rebar, seed: state.seed,
  }), [pieces, table, broken, state.rough, state.wear, state.rebar, state.density, state.seed, specimen, state.lookVersion]);

  // Shading-only base: built once for the specimen, drawn once per copy.
  const isGlass = (p: { cls: number }): boolean => p.cls === FractureClass.Glass;
  const base = useMemo(() => {
    const meshes = pieces.map((_, p) => builder.flatMesh(p));
    return {
      opaque: buildLabGeometry(pieces, meshes, codes, (p) => !isGlass(p)),
      glass: pieces.some(isGlass) ? buildLabGeometry(pieces, meshes, codes, isGlass) : null,
      triangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0),
    };
  }, [pieces, builder, codes]);

  const poses = useMemo(() => new LabPoses(n * copies), [n, copies]);
  const pool = useMemo(() => new SkinPool(POOL_VERTICES, POOL_INDICES), []);
  useEffect(() => () => pool.dispose(), [pool]);

  const materials = useMemo(() => {
    const triplanar = labTriplanar();
    const common = { triplanar, fracture: state.shading, debugKinds: state.debugKinds, wireframe: state.wireframe, skin: state.skin };
    return {
      base: labMaterial(poses, looks, { ...common, tier: 'base', instanceStride: n }),
      pool: labMaterial(poses, looks, { ...common, tier: 'skin' }),
      glass: glassMaterial(poses, { fracture: state.shading, wireframe: state.wireframe, instanceStride: n }),
    };
  }, [poses, looks, n, state.shading, state.debugKinds, state.wireframe, state.skin]);

  // Draw objects.
  useEffect(() => {
    const group = new THREE.Group();
    const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, material, copies);
      for (let c = 0; c < copies; c += 1) mesh.setMatrixAt(c, new THREE.Matrix4());
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };
    group.add(instanced(base.opaque, materials.base));
    if (base.glass) group.add(instanced(base.glass, materials.glass));
    const detail = new THREE.Mesh(pool.geometry, materials.pool);
    detail.frustumCulled = false;
    detail.castShadow = true;
    detail.receiveShadow = true;
    group.add(detail);
    scene.add(group);
    return () => { scene.remove(group); };
  }, [scene, base, materials, pool, copies]);
  useEffect(() => () => {
    base.opaque.dispose();
    base.glass?.dispose();
  }, [base]);

  // Whatever the pool holds was built for the old builder or copies: empty it.
  const flags = useMemo(() => new Uint8Array(n * copies).fill(1), [n, copies]);
  const detailOf = useRef(new Map<number, number>());
  useEffect(() => {
    for (const g of [...detailOf.current.keys()]) pool.free(g);
    detailOf.current.clear();
    flags.fill(1);
  }, [builder, pool, flags]);

  // Base poses: static layouts are computed once per parameter change; a
  // blast simulates the specimen's pieces once and every copy replays it.
  const basePoses = useRef<Pose[]>([]);
  const blast = useRef<Blast | null>(null);
  const posesDirty = useRef(true);
  useEffect(() => {
    blast.current = state.mode === 'blast' ? new Blast(specimen, state.seed, state.blastStrength) : null;
    basePoses.current = pieces.map((_, p) => explodedPose(specimen, p, state.mode, state.amount, state.spin, state.seed));
    posesDirty.current = true;
  }, [specimen, pieces, state.mode, state.amount, state.spin, state.seed, state.blastStrength, state.blastToken]);

  const stats = useRef({
    count: 0, total: 0, last: performance.now(), emitted: 0, gpu: null as number | null,
    buildMs: 0, builtTotal: 0, queue: 0, draws: 0, tris: 0,
  });
  // Draw calls and triangles right after the frame rendered (three resets
  // them at the start of each render).
  useEffect(() => addAfterEffect(() => {
    const render = (gl as unknown as { info: { render: { drawCalls?: number; triangles: number } } }).info?.render;
    if (!render) return;
    stats.current.draws = render.drawCalls ?? 0;
    stats.current.tris = render.triangles;
  }), [gl]);

  useFrame((_, dt) => {
    looks.refresh();
    const sim = blast.current;
    if (sim) {
      sim.step(Math.min(dt, 1 / 30) * state.timeScale);
      for (let p = 0; p < n; p += 1) basePoses.current[p] = sim.pose(p);
      posesDirty.current = true;
    }

    // --- Tier scheduling ---------------------------------------------------
    const started = performance.now();
    const cam = camera.position;
    const radius = state.tierRadius;
    const evictBeyond = radius * 1.25;
    const reach = Math.hypot(size[0], size[1], size[2]) * (0.6 + state.amount);
    const centre = [(specimen.min[0] + specimen.max[0]) / 2, (specimen.min[1] + specimen.max[1]) / 2, (specimen.min[2] + specimen.max[2]) / 2];
    const wanted: Array<{ g: number; d: number }> = [];
    let changed = false;
    for (let c = 0; c < copies; c += 1) {
      const o = offsets[c];
      // Whole copies beyond reach are skipped (and anything of theirs evicted).
      const dc = Math.hypot(centre[0] + o[0] - cam.x, centre[1] + o[1] - cam.y, centre[2] + o[2] - cam.z);
      if (dc - reach > evictBeyond) {
        if (detailOf.current.size > 0) {
          for (let p = 0; p < n; p += 1) {
            const g = c * n + p;
            if (flags[g] === 2) {
              pool.free(g);
              detailOf.current.delete(g);
              flags[g] = 1;
              changed = true;
            }
          }
        }
        continue;
      }
      for (let p = 0; p < n; p += 1) {
        const g = c * n + p;
        const pose = basePoses.current[p];
        const d = Math.hypot(pose.p[0] + o[0] - cam.x, pose.p[1] + o[1] - cam.y, pose.p[2] + o[2] - cam.z);
        if (d < radius && !isGlass(pieces[p])) wanted.push({ g, d });
        else if (flags[g] === 2 && d > evictBeyond) {
          pool.free(g);
          detailOf.current.delete(g);
          flags[g] = 1;
          changed = true;
        }
      }
    }
    wanted.sort((x, y) => x.d - y.d);
    let queue = 0;
    for (const { g, d } of wanted) {
      const detail = d < radius * 0.4 ? 1 : 0.5;
      if (detailOf.current.get(g) === detail) continue;
      if (performance.now() - started > state.tierBudgetMs) {
        queue += 1;
        continue;
      }
      const p = g % n;
      const mesh = builder.pieceMesh(p, detail);
      let ok = pool.write(g, pieces[p], mesh, codes[p]);
      if (!ok) {
        // Full: give up the farthest held piece, once.
        let far = -1;
        let farD = -1;
        for (const [held] of detailOf.current) {
          const hp = basePoses.current[held % n].p;
          const ho = offsets[Math.floor(held / n)];
          const hd = Math.hypot(hp[0] + ho[0] - cam.x, hp[1] + ho[1] - cam.y, hp[2] + ho[2] - cam.z);
          if (hd > farD) {
            farD = hd;
            far = held;
          }
        }
        if (far >= 0 && farD > d) {
          pool.free(far);
          detailOf.current.delete(far);
          flags[far] = 1;
          ok = pool.write(g, pieces[p], mesh, codes[p]);
        }
      }
      if (!ok) {
        queue += 1;
        continue;
      }
      detailOf.current.set(g, detail);
      flags[g] = 2;
      changed = true;
      stats.current.builtTotal += 1;
    }
    const buildMs = performance.now() - started;

    // --- Poses (only when something moved or swapped) ----------------------
    if (posesDirty.current || changed) {
      for (let c = 0; c < copies; c += 1) {
        const o = offsets[c];
        for (let p = 0; p < n; p += 1) {
          const pose = basePoses.current[p];
          const g = c * n + p;
          poses.set(g, [pose.p[0] + o[0], pose.p[1] + o[1], pose.p[2] + o[2]], pose.q, flags[g]);
        }
      }
      poses.upload();
      posesDirty.current = false;
    }

    // --- Stats ---------------------------------------------------------------
    const f = stats.current;
    f.buildMs = f.buildMs * 0.9 + buildMs * 0.1;
    f.queue = queue;
    const now = performance.now();
    f.count += 1;
    f.total += now - f.last;
    f.last = now;
    if (now - f.emitted > 500) {
      const resolve = (gl as { resolveTimestampsAsync?: (type?: string) => Promise<number | undefined> }).resolveTimestampsAsync;
      if (resolve) void resolve.call(gl, 'render').then((ms) => { if (typeof ms === 'number' && ms > 0) f.gpu = ms; }).catch(() => {});
      onStats({
        pieces: n * copies,
        build: null,
        todayTriangles: base.triangles * copies,
        enhancedTriangles: base.triangles * copies,
        frameMs: f.total / Math.max(1, f.count),
        gpuMs: f.gpu,
        drawCalls: f.draws,
        triangles: f.tris,
        tier: {
          chunks: n * copies,
          skinned: pool.pieces,
          poolVertices: pool.verticesUsed,
          poolCapacity: POOL_VERTICES,
          queue: f.queue,
          buildMs: f.buildMs,
          builtTotal: f.builtTotal,
        },
      });
      f.count = 0;
      f.total = 0;
      f.emitted = now;
    }
  });

  // Camera: start at street level beside the first copy, looking along the row.
  useEffect(() => {
    const api: LabCameraApi = {
      setCamera(position, target) {
        camera.position.set(...position);
        controlsRef.current?.target.set(...target);
        camera.lookAt(new THREE.Vector3(...target));
        controlsRef.current?.update();
      },
      frame() {
        const c = [(specimen.min[0] + specimen.max[0]) / 2, (specimen.min[1] + specimen.max[1]) / 2, specimen.max[2]];
        api.setCamera([c[0] + size[0] * 0.8, 1.7, c[2] + Math.max(4, size[0] * 0.6)], [c[0], c[1], c[2] - size[2]]);
      },
      pieceCenter(i) {
        const pose = basePoses.current[i % n];
        const o = offsets[Math.floor(i / n)];
        return pose && o ? [pose.p[0] + o[0], pose.p[1] + o[1], pose.p[2] + o[2]] : null;
      },
      pieceRadius(i) {
        const piece = pieces[i % n];
        return piece ? Math.max(...piece.poly.verts.map((v) => Math.hypot(v[0], v[1], v[2]))) : 0;
      },
    };
    onCamera(api);
    const t = setTimeout(() => api.frame(), 0);
    return () => clearTimeout(t);
    // Frame on specimen change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimen, camera]);

  return (
    <OrbitControls ref={controlsRef} makeDefault enableDamping maxPolarAngle={Math.PI / 2 - 0.01} minDistance={0.3} maxDistance={600} />
  );
}
