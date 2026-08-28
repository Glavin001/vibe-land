/**
 * Standalone viewer for an authored ScenePack.
 *
 *   /structure?pack=algedra-tower
 *
 * The city renders every chunk through ONE material, because its buildings are
 * all the same concrete and per-building variety comes from hashing a building
 * id into the texture array. An authored structure is the opposite case: its
 * pieces know they are brick or stone or steel or glass, and the whole point of
 * looking at one is to see that. So this page groups nodes BY MATERIAL and
 * gives each group its own material — including a transparent one for glass,
 * which the game's destructible path cannot express at all.
 *
 * Nothing here talks to the server. It reads the pack JSON, builds static
 * geometry, and renders it under the real sky and sun, which makes the
 * regenerate-and-look loop a few seconds long.
 *
 * Static is the other simplification worth stating: the pieces never move, so a
 * merged mesh per material replaces the instanced/batched machinery the live
 * city needs, and one draw call covers a few thousand chunks.
 */
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  antialiasEnabled, cityPbrLighting, cityTextureDetail, flatToneMapping,
  heroTilingEnabled, maxDpr,
} from '../app/renderQuality';
import { buildBoxGeometry, buildHullGeometry } from '../city/chunkGeometry';
import { applyCityTriplanar } from '../scene/cityMaterialShader';
import { loadCityTextures } from '../scene/cityTextures';
import { SkyEnvironment } from '../graphics/SkyEnvironment';
import { SunLight } from '../scene/SunLight';
import { getFogSettings, resolveFogColor } from '../graphics/fogSettings';
import {
  layerCodeForMaterial, loadScenePack, packBounds,
  type PackMaterial, type ScenePack,
} from '../structures/structurePack';

const IDENTITY = new THREE.Matrix4();

/** A camera pose the screenshot tool can ask for by name. */
export type ViewPreset = {
  position: [number, number, number];
  target: [number, number, number];
};

declare global {
  interface Window {
    __VIBE_STRUCTURE__?: {
      ready: boolean;
      error: string | null;
      bounds: () => ReturnType<typeof packBounds> | null;
      stats: () => { nodes: number; groups: number; materials: string[] } | null;
      setCamera: (pose: ViewPreset) => void;
    };
  }
}

/** One merged mesh per material. */
type MaterialGroup = {
  name: string;
  geometry: THREE.BufferGeometry;
  material: PackMaterial | undefined;
  count: number;
};

function buildGroups(pack: ScenePack): MaterialGroup[] {
  const { nodes, nodeColliders, nodeSizes, nodeMaterials } = pack.scenario;
  const library = pack.scenario.shapeLibrary ?? [];
  const table = pack.defaults?.solver?.materials ?? [];
  const byName = new Map<string, THREE.BufferGeometry[]>();

  for (let i = 0; i < nodes.length; i += 1) {
    // Resolve a shape-library reference to the hull it names. Authored packs
    // bound their fracture patterns, so most shards ARE references now -- and
    // the ones that repeat most are exactly the ring segments a wall is made
    // of, so skipping them makes whole walls silently vanish from a render.
    const raw = nodeColliders[i];
    const collider = raw.kind === 'shape' ? library[raw.shape] : raw;
    if (!collider) continue;
    let geometry: THREE.BufferGeometry;
    if (collider.kind === 'cuboid') {
      const s = nodeSizes[i];
      geometry = buildBoxGeometry();
      geometry.scale(s.x, s.y, s.z);
    } else if (collider.kind === 'convex_hull') {
      geometry = buildHullGeometry(Float32Array.from(collider.points));
    } else {
      continue;
    }
    const c = nodes[i].centroid;
    geometry.translate(c.x, c.y, c.z);

    const name = nodeMaterials?.[i] ?? table[nodes[i].m ?? 0]?.name ?? 'unknown';
    const list = byName.get(name) ?? [];
    list.push(geometry);
    byName.set(name, list);
  }

  const groups: MaterialGroup[] = [];
  for (const [name, list] of byName) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    const spec = table.find((m) => m.name === name);

    // The triplanar shader reads its projection anchor and its texture LAYER
    // out of a `cityAnchor` attribute — but only on the instanced and batched
    // paths. A plain Mesh takes the shader's third branch, which hardcodes
    // layer 0, so every material would render as cracked concrete no matter
    // what it is made of. Rendering each merged group as an InstancedMesh of
    // count 1 puts it on the instanced path, where
    // `anchor.xyz + restScale * position` with anchor 0 and restScale 1
    // reduces to the world position already baked into the merged geometry.
    merged.setAttribute('cityAnchor', new THREE.InstancedBufferAttribute(
      Float32Array.of(0, 0, 0, layerCodeForMaterial(spec)), 4,
    ));
    merged.setAttribute('cityRestScale', new THREE.InstancedBufferAttribute(
      Float32Array.of(1, 1, 1), 3,
    ));
    groups.push({ name, geometry: merged, material: spec, count: list.length });
  }
  // Opaque first, transparent last: three sorts transparent objects among
  // themselves but always draws them after opaques, and glass in front of an
  // unwritten depth buffer shows whatever happened to be drawn first.
  groups.sort((a, b) => Number(a.material?.opacity != null) - Number(b.material?.opacity != null));
  return groups;
}

function materialFor(group: MaterialGroup): THREE.Material {
  const spec = group.material;
  const opacity = spec?.opacity;

  if (opacity != null) {
    // Glass. Deliberately simple — a flat blue tint at partial opacity, no
    // transmission and no refraction. Those cost a extra render pass and buy
    // nothing at the distances these structures are looked at.
    return new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(spec?.color ?? '#6fa8d6'),
      transparent: true,
      opacity,
      roughness: spec?.roughness ?? 0.06,
      metalness: spec?.metalness ?? 0,
      // Glazing is read almost entirely off what it REFLECTS. Without a strong
      // environment contribution the panes show only the unlit interior behind
      // them and the facade goes flat navy; turning the sky up makes them look
      // like glass.
      reflectivity: 0.7,
      envMapIntensity: 2.2,
      side: THREE.DoubleSide,
      // Depth IS written, unusually for a transparent material. All the glass
      // is one merged draw, so without it every pane on the far side of the
      // building blends through every pane on the near side and a curtain wall
      // five panes deep comes out opaque navy. Writing depth keeps only the
      // nearest glass surface, which is what looking at a glazed facade
      // actually gives you.
      depthWrite: true,
    });
  }

  const pbr = cityPbrLighting();
  const material = new THREE.MeshStandardMaterial({
    // White where a texture carries the colour: the shader multiplies the base
    // colour over the sampled albedo, so a tinted base would tint every layer.
    // Untextured materials (timber) keep their authored colour instead.
    // Tinted even when textured. The base colour multiplies the sampled
    // albedo, which is how near-white architectural concrete comes out of a
    // texture array whose palest entry is a mid-tone plaster.
    color: new THREE.Color(spec?.color ?? '#b8b4ad'),
    roughness: spec?.textureKey ? 1 : (spec?.roughness ?? 0.9),
    metalness: spec?.textureKey ? 0 : (spec?.metalness ?? 0),
  });
  if (spec?.textureKey) {
    // MUST be applied to the object that is used. `Material.clone()` copies no
    // function properties, so a cloned city material silently loses
    // onBeforeCompile and renders untextured with no error anywhere.
    applyCityTriplanar(material, pbr, cityTextureDetail(), heroTilingEnabled());
  }
  return material;
}

function Structure({ pack }: { pack: ScenePack }) {
  const groups = useMemo(() => buildGroups(pack), [pack]);
  const materials = useMemo(() => groups.map(materialFor), [groups]);
  const setIdentity = (mesh: THREE.InstancedMesh | null) => {
    if (!mesh) return;
    mesh.setMatrixAt(0, IDENTITY);
    mesh.instanceMatrix.needsUpdate = true;
  };
  useEffect(() => () => {
    for (const g of groups) g.geometry.dispose();
    for (const m of materials) m.dispose();
  }, [groups, materials]);

  return (
    <>
      {groups.map((group, i) => (
        <instancedMesh
          key={group.name}
          args={[group.geometry, materials[i], 1]}
          castShadow
          receiveShadow
          renderOrder={materials[i].transparent ? 1 : 0}
          frustumCulled={false}
          ref={setIdentity}
        />
      ))}
    </>
  );
}

/** Exposes camera control to the screenshot tool. */
function ViewerBridge({ pack }: { pack: ScenePack }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const bounds = packBounds(pack);
    window.__VIBE_STRUCTURE__ = {
      ready: true,
      error: null,
      bounds: () => bounds,
      stats: () => ({
        nodes: pack.scenario.nodes.length,
        groups: new Set(pack.scenario.nodeMaterials ?? []).size,
        materials: [...new Set(pack.scenario.nodeMaterials ?? [])],
      }),
      setCamera: ({ position, target }) => {
        camera.position.set(...position);
        camera.lookAt(new THREE.Vector3(...target));
        camera.updateMatrixWorld(true);
      },
    };
    return () => { delete window.__VIBE_STRUCTURE__; };
  }, [camera, pack]);
  return null;
}

export default function StructureViewerPage({ pack: packName }: { pack: string }) {
  const [pack, setPack] = useState<ScenePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fogColor = resolveFogColor(getFogSettings());

  useEffect(() => {
    loadCityTextures();
    let cancelled = false;
    loadScenePack(packName)
      .then((p) => { if (!cancelled) setPack(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        window.__VIBE_STRUCTURE__ = {
          ready: false, error: message,
          bounds: () => null, stats: () => null, setCamera: () => {},
        };
      });
    return () => { cancelled = true; };
  }, [packName]);

  const bounds = pack ? packBounds(pack) : null;
  // Frame the whole thing on first paint so a screenshot taken before any
  // setCamera call still shows the building rather than the inside of a wall.
  const start: [number, number, number] = bounds
    ? [bounds.radiusM * 2.2, bounds.topM * 0.8, bounds.radiusM * 2.2]
    : [40, 20, 40];

  return (
    <div style={{ position: 'fixed', inset: 0, background: fogColor }}>
      {error && (
        <div style={{ position: 'absolute', zIndex: 2, padding: 16, color: '#fff', fontFamily: 'monospace' }}>
          failed to load pack &quot;{packName}&quot;: {error}
        </div>
      )}
      <Canvas
        shadows
        dpr={[1, maxDpr()]}
        flat={flatToneMapping()}
        gl={{
          antialias: antialiasEnabled(),
          powerPreference: 'high-performance',
          // The screenshot tool grabs the canvas directly, and without this the
          // buffer is undefined by the time it reads.
          preserveDrawingBuffer: true,
        }}
        // `far` is generous: the city canvas caps at 200 m, which clips a wide
        // framing of a 34 m building seen from 90 m back.
        camera={{ fov: 55, near: 0.1, far: 2000, position: start }}
        data-testid="structure-canvas"
      >
        <SkyEnvironment fogColor={fogColor} />
        <SunLight fogColor={fogColor} shadowHalfExtent={bounds ? Math.max(40, bounds.radiusM * 2.5) : 60} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
          <planeGeometry args={[600, 600]} />
          <meshStandardMaterial color="#5d6350" roughness={1} metalness={0} />
        </mesh>
        {pack && <Structure pack={pack} />}
        {pack && <ViewerBridge pack={pack} />}
      </Canvas>
    </div>
  );
}
