/**
 * Scenario 5a (docs/calibration/masonry-arch.md): a semicircular stone arch
 * of 21 voussoirs, at a range of thicknesses, under its own weight.
 *
 * The classic limit-analysis result (Heyman 1969, "The safety of masonry
 * arches", Int. J. Mech. Sci. 11; exact value Ochsendorf 2002, Milankovitch
 * 1907): a semicircular arch of no-tension masonry with friction enough to
 * prevent sliding stands under its own weight only if its thickness t is at
 * least 0.1075 of its centreline radius R. Thinner, a thrust line no longer
 * fits inside it: it forms four hinges (extrados at the crown and the
 * springings' neighbourhood, intrados at the haunches ~31 degrees above the
 * springing) and falls. This is the one structure whose stability is rigid-
 * block mechanics -- what the engine's rigid chunks are -- so it calibrates
 * the contact side of the engine, and the jamming the concrete deck showed
 * (bridge-piers.md) where for masonry it is right.
 *
 * Joints: lime mortar (EN 1998-3 / EN 1996-1-1 M1: initial shear strength
 * f_vko 0.1 MPa; tensile strength next to nothing, 0.05 MPa); once a joint
 * cracks the voussoirs bear on each other by contact (friction 0.5, the
 * world's). The stone: sandstone, 2,300 kg/m^3.
 *
 * The judge holds the arch to its shape, not its mortar: a cracked joint is
 * not a failure (`holdsByDrop`), a fallen arch is.
 */
import { Pack } from '../src/pack.mjs';
import { packMaterial } from '../src/materials.mjs';
import { stateOf } from '../src/scenario.mjs';

export const id = 'masonry-arch';
export const title = 'Calibration: semicircular masonry arch, thickness against Heyman\'s minimum';
export const ticks = 600;
export const spacing = 6;
export const band = 0.1;
export const holdsByDrop = true;
export const configModel = { default: 'real', section: 'real', rotation: 'real' };
export const models = { real: 'Heyman limit analysis: t/R >= 0.1075 stands (no tension, no sliding)' };
export const R = 5.0, DEPTH = 1.0, N = 21, T_MIN = 0.1075;
const RATIOS = [0.085, 0.1, 0.115, 0.13, 0.16];

export function build(tOverR) {
  const t = tOverR * R, pk = new Pack(`masonry-arch-${tOverR}`);
  const stone = packMaterial('sandstone', { density: 2300, E: 15e9, compression: 40e6, tension: 2e6, shear: 4e6, color: '#b9a98a', textureKey: 'stone' });
  const lime = packMaterial('lime-mortar-joint', { density: 1800, E: 1e9, compression: 3e6, tension: 0.05e6, shear: 0.1e6, color: '#cfc7b5' });
  const anchor = packMaterial('foundation', { density: 2400, E: 30e9, compression: 1e9, tension: 1e9, shear: 1e9, color: '#8d8a86', textureKey: 'concrete-wall' });
  const ri = R - t / 2, ro = R + t / 2, z0 = -DEPTH / 2, z1 = DEPTH / 2, ids = [], names = [];
  const at = (r, th) => [r * Math.cos(th), r * Math.sin(th)];
  for (let k = 0; k < N; k++) {
    const a = Math.PI * k / N, b = Math.PI * (k + 1) / N;
    ids.push(pk.prism({ poly: [at(ri, a), at(ro, a), at(ro, b), at(ri, b)], z0, z1, material: stone, type: 'voussoir', name: `voussoir-${k}` }));
  }
  const bonds = [];
  const joint = (i, j, th) => {
    const c = at(R, th), n = [-Math.sin(th), Math.cos(th)];   // tangential: from voussoir k to k+1
    pk.rawBond(i, j, { centroid: [c[0], c[1], 0], normal: [n[0], n[1], 0], area: t * DEPTH, material: lime });
  };
  for (let k = 0; k < N - 1; k++) { joint(ids[k], ids[k + 1], Math.PI * (k + 1) / N); bonds.push(`joint@${k + 1}`); }
  // Springers: anchored blocks under the ends, the bed joint horizontal at y 0.
  for (const [side, x0, x1, v] of [['east', ri, ro, ids[0]], ['west', -ro, -ri, ids.at(-1)]]) {
    const s = pk.box({ min: [x0 - 0.3, -1, z0], max: [x1 + 0.3, 0, z1], material: anchor, type: 'springer', name: `springer-${side}`, fixed: true });
    pk.rawBond(s, v, { centroid: [(x0 + x1) / 2, 0, 0], normal: [0, 1, 0], area: t * DEPTH, material: lime });
    bonds.push(`bed@${side}`);
  }
  return { pack: pk.build(), names: pk.names, bonds };
}

export function hand() {
  return { R, depth: DEPTH, voussoirs: N, tOverR_min: T_MIN, source: 'Heyman 1969; Ochsendorf 2002 (0.1075, semicircular, no tension, infinite friction)', cases: RATIOS.map((r) => ({ tOverR: r, t: +(r * R).toFixed(3), ratioToMin: +(r / T_MIN).toFixed(3) })) };
}

export function cases() {
  return RATIOS.map((r) => {
    const { pack, names, bonds } = build(r);
    // u: how far inside the minimum the arch is (T_MIN / t-over-R): above 1 it cannot stand.
    const u = T_MIN / r;
    const real = { state: stateOf(u, band), u: +u.toFixed(3), worst: 'thrust line (four-hinge mechanism)', over: [], bonds: {} };
    return { id: `t${Math.round(r * 1000)}`, label: `t/R = ${r} (${(r / T_MIN).toFixed(2)} x Heyman's minimum), t = ${(r * R).toFixed(2)} m`, removed: [], pack, names, bonds, predictions: { real } };
  });
}
