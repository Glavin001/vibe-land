// Scene layer for garage destruction debugging. Draws what the server's PhysX
// scene holds, not what the client renders: every vehicle hull at its actual
// world pose coloured by owning actor, each actor's centre of mass and
// velocity, and the bond graph coloured by stress utilisation.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { actorColor, useDebugState, type Assembly, type DebugHull } from './destructionDebug';

const EXCLUDED = new THREE.Color('#ffb000');
function utilisationColor(u: number, out: THREE.Color) {
  if (u > 1) return out.set('#ff30ff');
  return out.setHSL((1 - Math.min(1, Math.max(0, u))) * 0.33, 1, 0.5);
}
function pose(position: number[], rotation: number[], out = new THREE.Matrix4()) {
  return out.compose(new THREE.Vector3(...position), new THREE.Quaternion(...rotation), new THREE.Vector3(1, 1, 1));
}

/** Edges of each authored hull in its shape frame, keyed part:ordinal. */
function hullEdges(assembly: Assembly) {
  const edges = new Map<string, { geometry: THREE.BufferGeometry; rest: THREE.Vector3 }>();
  assembly.parts.forEach((part, index) => part.shapes.forEach((shape, ordinal) => {
    try {
      const convex = new ConvexGeometry(shape.vertices.map(v => new THREE.Vector3(...v)));
      edges.set(`${index}:${ordinal}`, { geometry: new THREE.EdgesGeometry(convex, 20), rest: new THREE.Vector3(...part.position).add(new THREE.Vector3(...shape.position)) });
      convex.dispose();
    } catch { /* degenerate hull: nothing to outline */ }
  }));
  return edges;
}

export function DestructionDebugScene() {
  const { layers, data, assembly, selectedPart } = useDebugState();
  const edges = useMemo(() => assembly ? hullEdges(assembly) : null, [assembly]);
  useEffect(() => () => edges?.forEach(e => e.geometry.dispose()), [edges]);
  const group = useMemo(() => new THREE.Group(), []);

  useEffect(() => {
    // Hull edge geometries are cached per asset; everything else is per poll.
    const shared = new Set([...(edges?.values() ?? [])].map(e => e.geometry));
    group.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry && !shared.has(mesh.geometry)) mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(m) ? m : m ? [m] : []).forEach(x => x.dispose());
    });
    group.clear();
    if (!data || !assembly || !edges) return;
    // Part pose = hull world * rest^-1 (rests are pure translations).
    const partPose = new Map<number, { matrix: THREE.Matrix4; actor: number }>();
    for (const hull of data.hulls) if (!partPose.has(hull.part)) {
      const m = pose(hull.position, hull.rotation).multiply(new THREE.Matrix4().makeTranslation(-hull.rest[0], -hull.rest[1], -hull.rest[2]));
      partPose.set(hull.part, { matrix: m, actor: hull.actor });
    }
    if (layers.colliders) {
      const byColor = new Map<string, THREE.LineBasicMaterial>();
      const material = (hull: DebugHull) => {
        const selected = selectedPart === hull.part;
        const key = selected ? 'selected' : hull.terrainExcluded ? 'excluded' : String(hull.actor);
        let m = byColor.get(key);
        if (!m) byColor.set(key, m = new THREE.LineBasicMaterial({ color: selected ? '#ffffff' : hull.terrainExcluded ? EXCLUDED : actorColor(hull.actor), depthTest: false, transparent: true, opacity: selected ? 1 : .85 }));
        return m;
      };
      for (const hull of data.hulls) {
        const e = edges.get(`${hull.part}:${hull.ordinal}`);
        if (!e) continue;
        const lines = new THREE.LineSegments(e.geometry, material(hull));
        lines.matrixAutoUpdate = false; lines.matrix.copy(pose(hull.position, hull.rotation)); lines.renderOrder = 999;
        group.add(lines);
      }
    }
    if (layers.centers) {
      for (const actor of data.actors) {
        const color = actorColor(actor.actor);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(actor.actor === 0 ? .12 : .06, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        dot.position.set(...actor.centerOfMass); dot.renderOrder = 1000; group.add(dot);
        const v = new THREE.Vector3(...actor.linearVelocity), speed = v.length();
        if (speed > .05) {
          const arrow = new THREE.ArrowHelper(v.normalize(), new THREE.Vector3(...actor.centerOfMass), Math.min(4, .15 + speed * .25), color, .12, .08);
          arrow.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.depthTest = false; o.renderOrder = 1000; });
          group.add(arrow);
        }
      }
    }
    if (layers.bonds) {
      const index = new Map(assembly.parts.map((p, i) => [p.id, i]));
      const positions: number[] = [], colors: number[] = [], c = new THREE.Color();
      const center = (part: number) => { const p = partPose.get(part), a = assembly.parts[part]; return p && a ? new THREE.Vector3(...a.massProperties.center).applyMatrix4(p.matrix) : null; };
      for (const row of data.bonds) {
        const bond = assembly.bonds[row.index];
        if (!bond || row.broken) continue;
        const a = index.get(bond.a) ?? row.a, b = index.get(bond.b) ?? row.b;
        const pa = partPose.get(a), ca = center(a), cb = center(b);
        if (!pa || !ca || !cb) continue;
        const mid = new THREE.Vector3(...bond.centroid).applyMatrix4(pa.matrix);
        // Intact bond across two actors means the graph and bodies disagree.
        if (partPose.get(b)?.actor !== pa.actor) c.set('#ff0000'); else utilisationColor(row.utilisation, c);
        for (const [p, q] of [[ca, mid], [mid, cb]]) { positions.push(p.x, p.y, p.z, q.x, q.y, q.z); colors.push(c.r, c.g, c.b, c.r, c.g, c.b); }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: .9 }));
      lines.renderOrder = 998; group.add(lines);
    }
  }, [group, data, assembly, edges, layers, selectedPart]);

  return <primitive object={group} />;
}
