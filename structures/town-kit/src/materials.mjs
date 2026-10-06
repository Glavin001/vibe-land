import { materialTable } from './dependencies.mjs';
const base=materialTable();
export const PALETTES={sage:'#698477',blue:'#667f91',ochre:'#b99b73',cream:'#d3c59e',rose:'#ac7568',slate:'#60746f'};
export function materials(palette='sage') {
 if(!PALETTES[palette]) throw Error(`Unknown palette ${palette}`);
 const mat=(name,source,color,textureKey,density,extra={})=>({...structuredClone(base.find(m=>m.name===source)),name,color,textureKey,density,...extra});
 const table = [
  mat('structure-timber','wood-frame','#986d43','aged-timber',600),
  mat('painted-siding','wood-frame',PALETTES[palette],'white-concrete',600),
  mat('ivory-trim','wood-frame','#e7dec8',null,600),
  mat('plaster','facade-panel','#e3d9bf','white-concrete',950),
  mat('brick-plinth','brick','#986449','brick',1900),
  mat('footing','footing-anchor','#86877b','concrete-wall',2400),
  mat('window-glass','glass','#b8d7da',null,2500,{opacity:.24,roughness:.08,metalness:0}),
  mat('slate-roof','stone','#404b50','roof-slate',2100),
  mat('dark-joinery','wood-frame','#314c45','white-concrete',600),
  mat('warm-oak','wood-frame','#c6b794','aged-timber',600),
  mat('porcelain','stone','#e6e4d4',null,2100,{roughness:.25,metalness:0}),
  mat('metal','steel','#687776','metal',7850),
  mat('upholstery','wood-frame','#9b7258',null,80),
  mat('bedding','wood-frame','#c6c5ad',null,65),
  mat('glazing-joint','glazing-clip','#ffffff',null,2500,{compressionElastic:2e6,compressionFatal:4e6,tensionElastic:2e5,tensionFatal:4e5,shearElastic:3e5,shearFatal:6e5}),
  mat('plastered-timber-wall','wood-frame','#e6dfcb','white-concrete',320,{compressionElastic:6e6,compressionFatal:12e6,tensionElastic:6e5,tensionFatal:1.2e6,shearElastic:1e6,shearFatal:2e6,elasticModulus:2e9}),
  mat('timber-joint','wood-frame','#986d43',null,600,{compressionElastic:8e6,compressionFatal:16e6,tensionElastic:5e5,tensionFatal:1e6,shearElastic:1e6,shearFatal:2e6,elasticModulus:1e9}),
  mat('furniture-joinery','wood-frame','#986d43',null,600,{compressionElastic:3e6,compressionFatal:6e6,tensionElastic:5e4,tensionFatal:1e5,shearElastic:1e5,shearFatal:2e5,elasticModulus:2.5e8}),
  mat('cladding-fastener','wood-frame','#e7dec8',null,600,{compressionElastic:3e6,compressionFatal:6e6,tensionElastic:1e5,tensionFatal:2e5,shearElastic:2.5e5,shearFatal:5e5,elasticModulus:5e8}),
  mat('insulated-appliance-panel','wood-frame','#e6e4d4',null,280,{compressionElastic:8e6,compressionFatal:16e6,tensionElastic:5e5,tensionFatal:1e6,shearElastic:1e6,shearFatal:2e6,elasticModulus:1e9,roughness:.25,metalness:.15}),
 ];
 table.push(mortarMaterial(table[4]));
 return table;
}
export const M={frame:0,siding:1,trim:2,plaster:3,brick:4,footing:5,glass:6,roof:7,dark:8,oak:9,ceramic:10,metal:11,fabric:12,bedding:13,glassJoint:14,wall:15,joint:16,furnitureJoint:17,fastener:18,appliance:19,mortar:20};

/**
 * Masonry fails at its joints, not through its bricks: Eurocode 6 puts the
 * flexural tensile strength of brick masonry at 0.1-0.7 MPa and the initial
 * shear strength at 0.1-0.3 MPa plus friction under load, where the `brick`
 * material carries the brick unit's own 4.4 / 8.8 MPa. So a bond between two
 * masonry pieces, or masonry bedded on concrete or a footing, is a mortar
 * joint and gets these limits (the `mortar-joint` material). The bricks keep
 * their strength, and timber, trim and glass fixed to masonry keep the joint
 * they had: those are fixings, not mortar (made mortar-weak, a grocery's trim
 * hung on 7 cm2 slivers broke at rest). At the brick's own strength a monster
 * truck at 78 km/h into a house broke 10 bonds and freed nothing, so no
 * corrected solve ran and it stopped dead (2026-10-06, the vehicle lab).
 * VIBE_BRICK_JOINTS=unit builds with the brick's strength in its joints.
 */
export const MORTAR_JOINT = { tensionElastic: 0.2e6, tensionFatal: 0.6e6, shearElastic: 0.33e6, shearFatal: 1.0e6 };
export const mortarJointsEnabled = () => (globalThis.process?.env?.VIBE_BRICK_JOINTS ?? 'mortar') !== 'unit';
/** Masonry by name: a concrete facade with a brick texture is still concrete. */
export const isMasonry = (name) => /^brick(-|$)/.test(name) || /masonry/.test(name) && !/connection|seam/.test(name);
/** What masonry is bedded on (its bed joint is mortar too). */
export const isBed = (name) => /concrete|footing|slab/.test(name);
/** The mortar-joint material, from a brick material. */
export const mortarMaterial = (brick) => ({ ...structuredClone(brick), name: 'mortar-joint', ...(mortarJointsEnabled() ? MORTAR_JOINT : {}) });
/**
 * A pack's masonry bonds as mortar joints (in place): the pack gains a
 * `mortar-joint` material and every bond between two masonry nodes, or
 * masonry and its bed, uses it. Returns how many bonds changed.
 */
export function mortarJoints(pack) {
  if (!mortarJointsEnabled()) return 0;
  const table = pack.defaults.solver.materials, s = pack.scenario;
  const brick = table.find((m) => isMasonry(m.name));
  if (!brick) return 0;
  const names = s.nodeMaterials ?? s.nodes.map((n) => table[n.m ?? 0].name);
  let index = table.findIndex((m) => m.name === 'mortar-joint');
  if (index < 0) { index = table.length; table.push(mortarMaterial(brick)); }
  let changed = 0;
  for (const b of s.bonds) {
    const x = names[b.node0], y = names[b.node1];
    if ((isMasonry(x) && (isMasonry(y) || isBed(y))) || (isMasonry(y) && isBed(x))) { b.m = index; changed += 1; }
  }
  return changed;
}
