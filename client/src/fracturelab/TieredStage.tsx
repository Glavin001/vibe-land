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
import {
  FractureLookUniforms, LabPoses, PieceInfo, SHADOW_LAYER, buildCompactGeometry, buildLabGeometry, glassMaterial, labGroups, labMaterial,
  shadowProxyMaterial,
} from './labMesh';
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
  /** Shading-only tier vertices, all copies. */
  baseVertices: number;
  /** Copies drawn by the view, and into the sun's shadow map. */
  viewCopies: number;
  shadowCopies: number;
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
  // The compact layout needs the procedural skin (it has no texture
  // anchors or normals for the city triplanar).
  const compact = state.compact && state.shading && state.skin === 'procedural';
  const base = useMemo(() => {
    const meshes = pieces.map((_, p) => builder.flatMesh(p));
    const opaque = compact
      ? buildCompactGeometry(pieces, table.faceKind, (p) => !isGlass(p))
      : buildLabGeometry(pieces, meshes, codes, (p) => !isGlass(p));
    return {
      opaque,
      glass: pieces.some(isGlass) ? buildLabGeometry(pieces, meshes, codes, isGlass) : null,
      info: compact ? new PieceInfo(pieces, codes) : null,
      triangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0),
      vertices: opaque.getAttribute('position').count,
    };
  }, [pieces, builder, codes, compact, table]);

  const poses = useMemo(() => new LabPoses(n * copies), [n, copies]);
  // The pool's index budget, shared out by how many pieces each class has.
  const pool = useMemo(() => {
    const share = new Map<number, number>();
    for (const piece of pieces) if (!isGlass(piece)) share.set(piece.cls, (share.get(piece.cls) ?? 0) + 1);
    return new SkinPool(POOL_VERTICES, POOL_INDICES, share);
  }, [pieces]);
  useEffect(() => () => pool.dispose(), [pool]);

  const materials = useMemo(() => {
    const triplanar = labTriplanar();
    const common = {
      triplanar, fracture: state.shading, debugKinds: state.debugKinds, wireframe: state.wireframe, skin: state.skin,
      probe: state.probe || undefined, noise: state.noise,
    };
    return {
      // Compact: one specialised material per (class, skin/cut) group --
      // material sorting instead of an uber-shader's branches.
      base: base.info && state.specialise && labGroups(base.opaque).length > 0
        ? labGroups(base.opaque).map((only) => labMaterial(poses, looks, {
          ...common, tier: 'base', instanceStride: n, compact: base.info ?? undefined, only,
        }))
        : labMaterial(poses, looks, { ...common, tier: 'base', instanceStride: n, compact: base.info ?? undefined }),
      // The pool draws a mesh per class: specialised to it, or all the
      // uber-shader.
      pool: (() => {
        const uber = state.specialise ? null : labMaterial(poses, looks, { ...common, tier: 'skin' });
        const byClass = new Map<number, THREE.Material>();
        return (cls: number): THREE.Material => {
          if (uber) return uber;
          let material = byClass.get(cls);
          if (!material) byClass.set(cls, material = labMaterial(poses, looks, { ...common, tier: 'skin', only: { cls } }));
          return material;
        };
      })(),
      glass: glassMaterial(poses, { fracture: state.shading, wireframe: state.wireframe, instanceStride: n }),
      shadow: shadowProxyMaterial(poses, n),
    };
  }, [poses, looks, n, state.shading, state.debugKinds, state.wireframe, state.skin, state.probe, state.specialise, state.noise, base]);

  // Copy index per drawn instance (InstancedBufferAttribute, step mode instance).
  const copyAttribute = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(copies), 1);
    for (let c = 0; c < copies; c += 1) a.setX(c, c);
    return a;
  }, [copies]);
  // The shadow proxy's own list: the sun's shadow camera follows the view
  // and covers tens of metres, so it needs far fewer copies than the view.
  const shadowCopyAttribute = useMemo(() => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(copies), 1);
    for (let c = 0; c < copies; c += 1) a.setX(c, c);
    return a;
  }, [copies]);
  const instancedMeshes = useRef<THREE.InstancedMesh[]>([]);
  // Pool meshes, one per class part, added as parts appear.
  const poolGroup = useRef<THREE.Group | null>(null);
  const poolDrawn = useRef(new Map<number, THREE.Mesh>());
  const poolSeen = useRef(-1);
  const syncPool = (): void => {
    const into = poolGroup.current;
    if (!into || pool.partsVersion === poolSeen.current) return;
    for (const part of pool.parts) {
      if (poolDrawn.current.has(part.cls)) continue;
      const mesh = new THREE.Mesh(part.geometry, materials.pool(part.cls));
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = state.shadows;
      poolDrawn.current.set(part.cls, mesh);
      into.add(mesh);
    }
    poolSeen.current = pool.partsVersion;
  };
  const shadowMesh = useRef<THREE.InstancedMesh | null>(null);
  const sun = useRef<THREE.DirectionalLight | null>(null);
  const copyCount = useRef(-1);
  const frustum = useMemo(() => new THREE.Frustum(), []);
  const projScreen = useMemo(() => new THREE.Matrix4(), []);
  const sphere = useMemo(() => new THREE.Sphere(), []);

  // Draw objects.
  useEffect(() => {
    const group = new THREE.Group();
    const instanced = (
      geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], copiesOf = copyAttribute,
    ): THREE.InstancedMesh => {
      // Which copy each drawn instance is: the culler packs the visible
      // copies to the front and draws only those.
      geometry.setAttribute('labCopy', copiesOf);
      const mesh = new THREE.InstancedMesh(geometry, material, copies);
      for (let c = 0; c < copies; c += 1) mesh.setMatrixAt(c, new THREE.Matrix4());
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = state.shadows;
      return mesh;
    };
    const meshes = [instanced(base.opaque, materials.base)];
    if (base.glass) meshes.push(instanced(base.glass, materials.glass));
    // Shadows: every piece's flat shape, bare material, its own layer.
    shadowMesh.current = null;
    if (state.shadows) {
      // Same buffers, its own copy list.
      const shape = new THREE.BufferGeometry();
      shape.setIndex(base.opaque.index);
      shape.setAttribute('position', base.opaque.getAttribute('position'));
      shape.setAttribute('labPiece', base.opaque.getAttribute('labPiece'));
      shape.boundingSphere = base.opaque.boundingSphere;
      const proxy = instanced(shape, materials.shadow, shadowCopyAttribute);
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      proxy.layers.set(SHADOW_LAYER);
      shadowMesh.current = proxy;
      group.add(proxy);
    }
    instancedMeshes.current = meshes;
    for (const m of meshes) group.add(m);
    const detail = new THREE.Group();
    group.add(detail);
    poolGroup.current = detail;
    poolDrawn.current.clear();
    poolSeen.current = -1;
    syncPool();
    scene.add(group);
    return () => {
      scene.remove(group);
      poolGroup.current = null;
    };
  }, [scene, base, materials, pool, copies, copyAttribute, shadowCopyAttribute, state.shadows]);
  useEffect(() => () => {
    base.opaque.dispose();
    base.glass?.dispose();
    base.info?.dispose();
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
    buildMs: 0, builtTotal: 0, queue: 0, draws: 0, tris: 0, shadowCopies: 0,
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
    // Detail by projected size: each level halves the tessellation, chosen
    // so an edge segment stays ~7 px whatever the distance, display and
    // field of view (a Retina display earns twice the detail at a range).
    // Full detail's worn-edge segments are ~1.4 cm: 7 px at 2.5 m on a
    // 1000 px tall 45-degree view.
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
    const pixelsTall = gl.domElement.height || 1000;
    const metresPerPixelAt1m = (2 * Math.tan((fov * Math.PI) / 360)) / pixelsTall;
    const fullDetailWithin = 0.014 / (7 * metresPerPixelAt1m);
    const detailAt = (d: number): number => {
      const level = Math.min(3, Math.max(0, Math.round(Math.log2(Math.max(d, 1e-3) / fullDetailWithin))));
      return 1 / (1 << level);
    };
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
      const detail = detailAt(d);
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

    // A class's first detailed piece brings its part (and mesh) into being.
    syncPool();

    // --- Culling: only copies the camera can see are drawn ------------------
    {
      let visible = 0;
      const arr = copyAttribute.array as Float32Array;
      if (state.cull) {
        projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreen);
        for (let c = 0; c < copies; c += 1) {
          const o = offsets[c];
          // Generous: exploded pieces spread, and shadows reach past the edge.
          sphere.center.set(centre[0] + o[0], centre[1] + o[1], centre[2] + o[2]);
          sphere.radius = reach + 2;
          if (frustum.intersectsSphere(sphere)) arr[visible++] = c;
        }
      } else {
        for (let c = 0; c < copies; c += 1) arr[visible++] = c;
      }
      if (visible !== copyCount.current || state.cull) {
        copyAttribute.needsUpdate = true;
        copyAttribute.addUpdateRange(0, visible);
        for (const m of instancedMeshes.current) m.count = visible;
        copyCount.current = visible;
      }
      // Shadow casters: the copies inside the sun's shadow box, whether or
      // not the view sees them (an off-screen house still shades the street).
      const proxy = shadowMesh.current;
      if (proxy) {
        if (!sun.current?.parent) {
          sun.current = null;
          scene.traverse((o) => { if (!sun.current && (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) sun.current = o as THREE.DirectionalLight; });
        }
        const light = sun.current;
        const sarr = shadowCopyAttribute.array as Float32Array;
        let cast = 0;
        if (state.cull && light) {
          light.updateMatrixWorld();
          light.target.updateMatrixWorld();
          light.shadow.updateMatrices(light);
          const box = light.shadow.getFrustum();
          for (let c = 0; c < copies; c += 1) {
            const o = offsets[c];
            sphere.center.set(centre[0] + o[0], centre[1] + o[1], centre[2] + o[2]);
            sphere.radius = reach + 2;
            if (box.intersectsSphere(sphere)) sarr[cast++] = c;
          }
        } else {
          for (let c = 0; c < copies; c += 1) sarr[cast++] = c;
        }
        shadowCopyAttribute.needsUpdate = true;
        shadowCopyAttribute.addUpdateRange(0, cast);
        proxy.count = cast;
        stats.current.shadowCopies = cast;
      }
    }

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
          baseVertices: base.vertices * copies,
          viewCopies: Math.max(0, copyCount.current),
          shadowCopies: f.shadowCopies,
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
