import * as T from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
export const SHAPES = [
  'Sphere',
  'Box',
  'Rounded box',
  'Cylinder',
  'Cone',
  'Capsule',
  'Torus',
  'Torus knot',
  'Dodecahedron',
  'Icosahedron',
  'Convex hull I',
  'Convex hull II',
  'Lathed vessel',
  'Extruded arch',
  'Compound pedestal',
  'Pipe assembly',
] as const;
export const INSPECT_SHAPES = [
  ...SHAPES,
  'Section block',
  'Thin slab',
  'Architectural pane',
] as const;
export type ShapeName = (typeof INSPECT_SHAPES)[number];
function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
}
export function makeShape(
  name: ShapeName,
  material: T.Material,
  wall = 0.006,
): T.Group {
  const g = new T.Group();
  const add = (geo: T.BufferGeometry, x = 0, y = 0, z = 0) => {
    setManufacturingTangents(geo);
    const m = new T.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  switch (name) {
    case 'Section block':
      add(new T.BoxGeometry(0.18, 0.18, 0.18, 48, 48, 48));
      break;
    case 'Thin slab':
      add(new T.BoxGeometry(0.19, 0.19, 0.002, 48, 48, 1));
      break;
    case 'Architectural pane':
      add(new RoundedBoxGeometry(0.21, 0.19, wall, 4, 0.0007));
      break;
    case 'Sphere':
      add(new T.SphereGeometry(0.1, 80, 56));
      break;
    case 'Box':
      add(new T.BoxGeometry(0.17, 0.17, 0.17, 24, 24, 24));
      break;
    case 'Rounded box':
      add(new RoundedBoxGeometry(0.18, 0.18, 0.18, 5, 0.013));
      break;
    case 'Cylinder':
      add(new T.CylinderGeometry(0.082, 0.082, 0.19, 80, 12));
      break;
    case 'Cone':
      add(new T.ConeGeometry(0.105, 0.21, 80, 12));
      break;
    case 'Capsule':
      add(new T.CapsuleGeometry(0.065, 0.095, 12, 56));
      break;
    case 'Torus':
      add(new T.TorusGeometry(0.078, 0.03, 28, 96)).rotation.x = 0.22;
      break;
    case 'Torus knot':
      add(new T.TorusKnotGeometry(0.065, 0.023, 160, 24));
      break;
    case 'Dodecahedron':
      add(new T.DodecahedronGeometry(0.116, 0));
      break;
    case 'Icosahedron':
      add(new T.IcosahedronGeometry(0.116, 0));
      break;
    case 'Convex hull I':
    case 'Convex hull II': {
      const random = rng(name.endsWith('II') ? 916 : 127);
      const points = Array.from(
        { length: 30 },
        () =>
          new T.Vector3(
            (random() - 0.5) * 0.22,
            (random() - 0.5) * 0.23,
            (random() - 0.5) * 0.21,
          ),
      );
      add(new ConvexGeometry(points));
      break;
    }
    case 'Lathed vessel': {
      const points: T.Vector2[] = [];
      const thickness = Math.min(wall, 0.02);
      // A single closed profile includes outer wall, lip, inner wall and solid base.
      points.push(new T.Vector2(0, 0), new T.Vector2(0.065, 0));
      for (let i = 0; i <= 32; i++) {
        const t = i / 32;
        points.push(
          new T.Vector2(
            0.064 + 0.014 * Math.sin(t * Math.PI) - 0.009 * t,
            t * 0.19,
          ),
        );
      }
      for (let i = 32; i >= 0; i--) {
        const t = i / 32;
        points.push(
          new T.Vector2(
            0.064 + 0.014 * Math.sin(t * Math.PI) - 0.009 * t - thickness,
            thickness + t * (0.19 - thickness),
          ),
        );
      }
      points.push(new T.Vector2(0, thickness), new T.Vector2(0, 0));
      add(new T.LatheGeometry(points, 88));
      break;
    }
    case 'Extruded arch': {
      const s = new T.Shape();
      s.moveTo(-0.1, 0);
      s.lineTo(-0.1, 0.1);
      s.absarc(0, 0.1, 0.1, Math.PI, 0, true);
      s.lineTo(0.1, 0);
      s.lineTo(0.062, 0);
      s.lineTo(0.062, 0.1);
      s.absarc(0, 0.1, 0.062, 0, Math.PI, false);
      s.lineTo(-0.062, 0);
      s.closePath();
      add(
        new T.ExtrudeGeometry(s, {
          depth: 0.055,
          bevelEnabled: true,
          bevelSize: 0.002,
          bevelThickness: 0.002,
          bevelSegments: 3,
          steps: 1,
          curveSegments: 40,
        }),
      );
      break;
    }
    case 'Compound pedestal':
      add(new RoundedBoxGeometry(0.18, 0.025, 0.15, 3, 0.003), 0, 0, 0);
      add(new T.CylinderGeometry(0.042, 0.052, 0.15, 64), 0, 0.085, 0);
      add(new RoundedBoxGeometry(0.16, 0.03, 0.14, 3, 0.004), 0, 0.17, 0);
      break;
    case 'Pipe assembly': {
      const ring = (r: number, h: number) => {
        const pts = [
          new T.Vector2(r - wall, -h / 2),
          new T.Vector2(r, -h / 2),
          new T.Vector2(r, h / 2),
          new T.Vector2(r - wall, h / 2),
          new T.Vector2(r - wall, -h / 2),
        ];
        return new T.LatheGeometry(pts, 56);
      };
      add(ring(0.032, 0.18));
      add(ring(0.042, 0.016), 0, 0.075);
      add(ring(0.042, 0.016), 0, -0.075);
      const cross = add(ring(0.026, 0.16), 0.032, 0.015);
      cross.rotation.z = Math.PI / 2;
      const flange = add(ring(0.035, 0.015), 0.106, 0.015);
      flange.rotation.z = Math.PI / 2;
      break;
    }
  }
  const bounds = new T.Box3().setFromObject(g);
  const center = bounds.getCenter(new T.Vector3());
  g.position.set(-center.x, -bounds.min.y, -center.z);
  g.userData.height = bounds.max.y - bounds.min.y;
  return g;
}
export function disposeObject(root: T.Object3D, materials = false) {
  root.traverse((o) => {
    if (o instanceof T.Mesh) {
      o.geometry.dispose();
      if (materials) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          m.dispose();
      }
    }
  });
}

export function setManufacturingTangents(geo: T.BufferGeometry) {
  const normal = geo.getAttribute('normal');
  if (!normal) return;
  const values = new Float32Array(normal.count * 4);
  const n = new T.Vector3(),
    t = new T.Vector3();
  for (let i = 0; i < normal.count; i++) {
    n.fromBufferAttribute(normal, i);
    t.crossVectors(
      n,
      Math.abs(n.y) < 0.98 ? new T.Vector3(0, 1, 0) : new T.Vector3(0, 0, 1),
    ).normalize();
    values.set([t.x, t.y, t.z, 1], i * 4);
  }
  geo.setAttribute('tangent', new T.BufferAttribute(values, 4));
}
