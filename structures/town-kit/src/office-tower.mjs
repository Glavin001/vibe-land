import { Builder, composeScene, nativeColliders } from './geometry.mjs';
import { townStaircase } from './stairs.mjs';
import { buildPropRaw } from './props.mjs';
import { M } from './materials.mjs';

/**
 * A glass office tower, built as one is: a steel column grid on concrete
 * footings, reinforced-concrete floor slabs, a concrete core round a
 * switchback stair on every floor (walkable: town stairs, 0.18 m risers,
 * landings), and a curtain wall -- clear glass in steel mullions, metal
 * spandrel panels over each slab edge -- hung off the slabs and columns, which
 * carries nothing; the perimeter columns come out to its face between bays. Open-plan offices on every floor: desks, chairs and
 * shelving, loose, as furniture is.
 *
 *   buildOfficeTower({ storeys = 10, furnished = true })
 *   -> { pack, metadata }: 14 x 14 m, its street face local -z.
 *
 * Load path: slab -> columns -> footings; the core walls stiffen it, and its
 * stairs are concrete. The glass
 * is bonded through glazing joints (geometry.mjs: glass against anything) and
 * comes away long before the frame; the spandrels are fixed to the slab edges.
 * Materials beyond the kit's own table are this building's: the slab's are
 * the authored skyline towers' reinforced concrete (destruction/assets/scenes
 * fractured-highrise-10f.json `concrete-slab`), with rebar's residual area.
 */
export function buildOfficeTower(options = {}) {
  const C = { storeys: 10, furnished: true, palette: 'slate', storeyHeight: 3.6, ...options };
  const b = new Builder('office-tower', C), placements = [], rooms = [], route = [];
  const table = b.table;
  const material = (base, fields) => table.push({ ...table[base], ...fields }) - 1;
  const concrete = material(M.footing, {
    name: 'office-slab-concrete', compressionElastic: 12e6, compressionFatal: 120e6, tensionElastic: 1.2e6, tensionFatal: 12e6,
    shearElastic: 1.6e6, shearFatal: 16e6, elasticModulus: 30e9, residualAreaFraction: 0.1, density: 2400,
    color: '#c9c6bf', textureKey: 'white-concrete', roughness: 0.9,
  });
  // The core and its stairs are cast in place and reinforced: the authored
  // towers' `reinforced-concrete` (fractured-highrise-10f.json), not the slab's plain mix.
  const core = material(concrete, {
    name: 'office-core-concrete', compressionElastic: 48e6, compressionFatal: 480e6, tensionElastic: 6e6, tensionFatal: 60e6,
    shearElastic: 11.6e6, shearFatal: 116e6, color: '#b4b0a7', textureKey: 'concrete-wall',
  });
  const steel = material(M.metal, { name: 'office-steel', color: '#3d4247', roughness: 0.45, metalness: 0.7 });
  const spandrel = material(M.metal, { name: 'office-spandrel', color: '#56606a', roughness: 0.35, metalness: 0.6, density: 2700 });
  const box = (min, max, m, type, split = [1, 1, 1], fixed = false) => b.box({ min, max, material: m, type, split, fixed });

  const half = 6.78, col = 0.18, grid = [-6.6, -2.2, 2.2, 6.6], slabT = 0.25, H = C.storeyHeight;
  const level = (k) => 0.3 + k * H; // the top of floor k's slab
  // The stair core: a switchback stair in a 2.62 x 4.25 m well, walled on three sides.
  const stairAt = [-1.31, -1.25];
  const stair0 = townStaircase(new Builder('probe', C), { at: stairAt, y0: 0, y1: H, width: 1.25, material: M.oak });
  const well = stair0.void;

  // ---- foundations: a pad under each column, the ground slab on grade.
  for (const x of grid) for (const z of grid) box([x - 0.6, -0.9, z - 0.6], [x + 0.6, -0.3, z + 0.6], M.footing, 'foundation', [1, 1, 1], true);
  box([-half, -0.3, -half], [half, 0, half], concrete, 'foundation', [6, 1, 6], true);
  // The lobby floor on it.
  box([-half, 0, -half], [half, 0.3, half], concrete, 'floor', [6, 1, 6]);

  // ---- every storey: columns, the next slab (cut for the stair), core walls, the stair.
  const slab = (y) => {
    const xs = [-half, well.x0, well.x1, half].sort((p, q) => p - q), zs = [-half, well.z0, well.z1, half].sort((p, q) => p - q);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
      if (i === 1 && j === 1) continue; // the stair well
      const split = [Math.max(1, Math.round((xs[i + 1] - xs[i]) / 2.3)), 1, Math.max(1, Math.round((zs[j + 1] - zs[j]) / 2.3))];
      box([xs[i], y - slabT, zs[j]], [xs[i + 1], y, zs[j + 1]], concrete, 'slab', split);
    }
  };
  // A perimeter column runs out to the curtain wall's face (the skin's 4 cm),
  // so it shows between the glass as the frame it is: no cladding plate glued
  // over its face (a 1.2 m² steel-on-steel bond 0.24 m long, a thousand times
  // stiffer than the glazing beside it).
  const SKIN = 0.04;
  const out = (c) => (c <= -6.6 ? [c - col - SKIN, c + col] : c >= 6.6 ? [c - col, c + col + SKIN] : [c - col, c + col]);
  for (let k = 0; k < C.storeys; k += 1) {
    const y0 = level(k), y1 = level(k + 1);
    for (const x of grid) for (const z of grid) {
      const [xa, xb] = out(x), [za, zb] = out(z);
      box([xa, y0, za], [xb, y1 - slabT, zb], steel, 'column');
    }
    slab(y1);
    // Core walls: either side of the well and across its far end.
    box([well.x0 - 0.2, y0, well.z0 + 0.3], [well.x0, y1 - slabT, well.z1 + 0.2], core, 'core-wall', [1, 2, 2]);
    box([well.x1, y0, well.z0 + 0.3], [well.x1 + 0.2, y1 - slabT, well.z1 + 0.2], core, 'core-wall', [1, 2, 2]);
    box([well.x0, y0, well.z1], [well.x1, y1 - slabT, well.z1 + 0.2], core, 'core-wall', [2, 2, 1]);
    // Concrete stairs, as an office core's are (and as heavy as the slabs they land on, near enough).
    townStaircase(b, { at: stairAt, y0, y1, width: 1.25, material: core });
    route.push({ name: `stair-${k}`, at: [stairAt[0] + 0.6, y0, stairAt[1] - 0.2] }, { name: `floor-${k + 1}`, at: [stairAt[0] + 1.9, y1, stairAt[1] - 0.6] });
    rooms.push({ name: k === 0 ? 'lobby' : `office-${k}`, floor: k, bounds: [[-half, y0, -half], [half, y1 - slabT, half]] });
  }
  // Roof parapet.
  const roof = level(C.storeys);
  for (const z of [-half, half - 0.2]) box([-half, roof, z], [half, roof + 1.1, z + 0.2], spandrel, 'parapet', [6, 1, 1]);
  for (const x of [-half, half - 0.2]) box([x, roof, -half + 0.2], [x + 0.2, roof + 1.1, half - 0.2], spandrel, 'parapet', [1, 1, 6]);

  // ---- the curtain wall: per bay and storey, a spandrel over the slab edge, then glass in a mullion.
  const bays = [[-6.42, -2.38], [-2.02, 2.02], [2.38, 6.42]];
  const skin = (face, u0, u1, y0, y1, m, type, split = [1, 1, 1]) => {
    // face: 'front' (-z), 'back' (+z), 'left' (-x), 'right' (+x); the skin sits just outside the frame.
    const t = 0.04;
    if (face === 'front') return box([u0, y0, -half - t], [u1, y1, -half], m, type, split);
    if (face === 'back') return box([u0, y0, half], [u1, y1, half + t], m, type, split);
    if (face === 'left') return box([-half - t, y0, u0], [-half, y1, u1], m, type, [split[2], split[1], split[0]]);
    return box([half, y0, u0], [half + t, y1, u1], m, type, [split[2], split[1], split[0]]);
  };
  for (const face of ['front', 'back', 'left', 'right']) {

    for (let k = 0; k < C.storeys; k += 1) {
      const y0 = level(k), y1 = level(k + 1);
      for (const [u0, u1] of bays) {
        // The lobby's middle bay on the street is its entrance: open.
        const entrance = k === 0 && face === 'front' && u0 < 0 && u1 > 0;
        // Every storey's glass stands on a spandrel fixed to the slab edge below it
        // (the lobby's on its floor's edge): glass hung by its joints alone falls out.
        const glassFrom = y0 + 0.65, glassTo = y1 - slabT;
        if (!entrance) skin(face, u0, u1, k === 0 ? 0 : y0 - slabT, y0 + 0.65, spandrel, 'spandrel', [2, 1, 1]);
        if (entrance) { skin(face, u0, u1, y1 - slabT - 0.5, y1 - slabT, spandrel, 'canopy-fascia', [2, 1, 1]); continue; }
        const mid = (u0 + u1) / 2;
        skin(face, mid - 0.04, mid + 0.04, glassFrom, glassTo, steel, 'mullion');
        skin(face, u0, mid - 0.04, glassFrom, glassTo, M.glass, 'glazing');
        skin(face, mid + 0.04, u1, glassFrom, glassTo, M.glass, 'glazing');
      }
    }
  }

  // ---- open-plan offices: two desk clusters a floor and shelving by the core.
  const prop = (type, x, y, z, yaw = 0) => placements.push({ pack: buildPropRaw(type, C).pack, position: [x, y, z], yaw, group: `${type}-${placements.length}` });
  if (C.furnished) for (let k = 1; k < C.storeys; k += 1) {
    const y = level(k);
    for (const [x, z] of [[-4.4, -4.3], [4.0, -4.3], [4.0, 3.6]]) {
      prop('table', x, y, z);
      prop('chair', x, y, z - 0.85);
      prop('chair', x, y, z + 0.85, 180);
    }
    prop('shelf', -4.9, y, 4.6);
    prop('shelf', 4.9, y, 0.4, 270);
  }

  let pack = composeScene([{ pack: b.build() }, ...placements], { key: 'office-tower', title: 'Office tower' });
  pack = nativeColliders(pack);
  return {
    pack,
    metadata: { kind: 'building', buildingType: 'office-tower', options: C, rooms, route, entrances: [{ name: 'lobby', at: [0, 0.3, -half], clearWidth: 4 }] },
  };
}
