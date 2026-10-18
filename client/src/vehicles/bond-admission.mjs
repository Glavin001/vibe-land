/** Which measured contacts become stress bonds, and at what area.
 *
 * Runtime (the bridge's floored stiffness): physx-bridge append_bonds stiffens
 * a bond at max(area, SOLVER_MIN_BOND_AREA_M2) but checks its strength at the
 * true area, so a smaller interface draws load it cannot carry. Such grazes
 * are excluded, except where one is a part's only link: then the geometry
 * barely meets its mount (an authoring gap to fix), and the mount is
 * represented at the solver minimum rather than disconnecting the part.
 *
 * True stiffness (VIBE_BOND_TRUE_STIFFNESS=1, implied by VIBE_SECTION_ROTATION;
 * docs/verification/FIDELITY_AUDIT.md A1, H1): the bridge stiffens every bond
 * at E A / L of its own area, so a graze carries only its own share. Every
 * measured contact is a bond at its measured area: nothing is excluded and no
 * area is raised.
 */
import { SOLVER_MIN_BOND_AREA_M2 } from './strength-profile.mjs';

/** The bridge's flags, read the same way (a nonzero number). */
export function trueBondStiffness(env = globalThis.process?.env ?? {}) {
  const on = (k) => { const v = Number.parseFloat(env[k] ?? ''); return Number.isFinite(v) && v !== 0; };
  return on('VIBE_BOND_TRUE_STIFFNESS') || on('VIBE_SECTION_ROTATION');
}

/** Admit `bonds` (in place). Returns { excluded, mounts }: the grazes dropped
 * and the sole links raised to the solver minimum (both empty under true
 * stiffness). */
export function admitBonds(bonds, { trueStiffness = trueBondStiffness() } = {}) {
  if (trueStiffness) return { excluded: [], mounts: [] };
  const linked = new Map(), find = id => { let r = id; while (linked.has(r) && linked.get(r) !== r) r = linked.get(r); return r; };
  const link = (a, b) => { linked.set(find(a), find(b)); };
  const grazes = bonds.filter(b => b.area < SOLVER_MIN_BOND_AREA_M2).sort((x, y) => y.area - x.area);
  for (const b of bonds) if (b.area >= SOLVER_MIN_BOND_AREA_M2) link(b.a, b.b);
  const mounts = new Set();
  for (const b of grazes) if (find(b.a) !== find(b.b)) { link(b.a, b.b); mounts.add(b); b.area = SOLVER_MIN_BOND_AREA_M2; b.areaSource = 'minimum-mount'; }
  const excluded = grazes.filter(b => !mounts.has(b));
  bonds.splice(0, bonds.length, ...bonds.filter(b => !excluded.includes(b)));
  return { excluded, mounts: [...mounts] };
}
