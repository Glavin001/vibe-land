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
 table.push(concreteFooting());
 return table;
}
export const M={frame:0,siding:1,trim:2,plaster:3,brick:4,footing:5,glass:6,roof:7,dark:8,oak:9,ceramic:10,metal:11,fabric:12,bedding:13,glassJoint:14,wall:15,joint:16,furnitureJoint:17,fastener:18,appliance:19,mortar:20,concrete:21};

/**
 * Concrete above grade (TOWN_KIT_BURIED_ANCHORS=1, geometry.mjs): a footing,
 * kerb, step, ramp or deck standing proud of the ground is a member, not the
 * ground. C30/37 plain concrete (EN 1992-1-1 Table 3.1): fck 30 MPa, fctm
 * 2.9 MPa, Ecm 33 GPa; shear at the tensile strength (no stirrups); the
 * elastic limits at 40% (the linear range of the stress-strain curve). The
 * `footing` material keeps the anchor grade's limits (1 GPa): it is only for
 * what never moves. Crushes as concrete (materials.mjs CRUSH, by name).
 */
export const concreteFooting = () => ({ ...structuredClone(base.find((m) => m.name === 'footing-anchor')), name: 'concrete-footing', color: '#86877b', textureKey: 'concrete-wall', density: 2400,
  compressionFatal: 30e6, compressionElastic: 12e6, tensionFatal: 2.9e6, tensionElastic: 1.16e6, shearFatal: 2.9e6, shearElastic: 1.16e6, elasticModulus: 33e9, residualAreaFraction: 0 });

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
/**
 * Mohr-Coulomb shear of a masonry mortar joint (FIDELITY_AUDIT C11; the stage
 * reads it under VIBE_MOHR_COULOMB_SHEAR, PhysX PX_DESTRUCTION_MOHR_COULOMB_SHEAR):
 * EN 1996-1-1 3.6.2 eq. 3.5, all joints filled, general-purpose mortar:
 * f_vk = f_vk0 + 0.4 sigma_d, but not greater than 0.065 f_b (or the
 * nationally determined f_vlt). sigma_d is the compression across the joint;
 * f_vk0 is the joint's authored shear strength, 0.4 its friction coefficient
 * (the code's, from triplet tests: EN 1052-3). The cap 0.065 f_b (Pa) is where
 * the units split in tension rather than the joint sliding, so it is the unit's:
 * clay brick f_b 20 MPa (CRUSH.brickVeneer) 1.3 MPa, natural stone f_b 50 MPa
 * (CRUSH.stone) 3.25 MPa. High-profile packs only (VIBE_REAL_CAPACITIES=1):
 * runtime packs stay byte-identical.
 */
export const MASONRY_FRICTION = 0.4;
/**
 * A masonry joint's shear stiffness over its normal stiffness (FIDELITY_AUDIT
 * D11; the stage reads it under VIBE_SHEAR_STIFFNESS, PhysX
 * PX_DESTRUCTION_SHEAR_STIFFNESS): EN 1996-1-1 3.8.3, the shear modulus G of
 * masonry may be taken as 40% of its elastic modulus E. A bond's stiffness is
 * the wall's E A / L along its normal, G A / L across it. With one stiffness in
 * every direction a head joint drew 2.5x its share of a pier stone's load in
 * vertical shear (docs/calibration/house-headers.md "Stone").
 */
export const MASONRY_SHEAR_STIFFNESS = 0.4;
export const masonryShear = (fb) => (globalThis.process?.env?.VIBE_REAL_CAPACITIES ?? '0') === '1'
  ? { shearFriction: MASONRY_FRICTION, shearCapacityLimit: 0.065 * fb, shearStiffnessRatio: MASONRY_SHEAR_STIFFNESS } : {};
export const BRICK_FB = 20e6, STONE_FB = 50e6;
/** Masonry by name: a concrete facade with a brick texture is still concrete. */
export const isMasonry = (name) => /^brick(-|$)/.test(name) || /masonry/.test(name) && !/connection|seam/.test(name);
/** What masonry is bedded on (its bed joint is mortar too). */
export const isBed = (name) => /concrete|footing|slab/.test(name);
/** The mortar-joint material, from a brick material. */
export const mortarMaterial = (brick) => ({ ...structuredClone(brick), name: 'mortar-joint', ...(mortarJointsEnabled() ? { ...MORTAR_JOINT, ...masonryShear(BRICK_FB) } : {}) });
/**
 * Natural-stone masonry's mortar joints: opt-in, VIBE_STONE_JOINTS=mortar on a
 * high-profile pack build (VIBE_REAL_CAPACITIES=1); off, the joints keep the
 * stone's own strength (the asset as it was). Off by default because at rest a
 * skyline stone house cracks 10 of its 1,652 joints (0.61%, nothing falls):
 * head joints at the window sills, sheared past f_vk0 with no compression on
 * them, where the stage's intact-joint shear has no f_vk0 + 0.4 sigma_d
 * friction term (FIDELITY_AUDIT C11; docs/calibration/house-headers.md "Stone"). A stone wall is units in mortar, and fails at its joints as brick does:
 * EN 1996-1-1 Table 3.4, dimensioned natural stone in general-purpose mortar
 * M2.5-M9: initial shear strength f_vk0 0.15 MPa (its friction term 0.4 sigma_d
 * is masonryShear's, graded under VIBE_MOHR_COULOMB_SHEAR: FIDELITY_AUDIT C11;
 * with it the house cracks 8 joints, 0.48%, the rest D11's: one stiffness per
 * bond in every direction, where masonry's G is 0.4 E); flexural tension across the bed joint
 * f_xk1 0.1 MPa (EN 1996-1-1 3.6.3, nationally determined; 0.05-0.1 for natural
 * stone and aggregate units in general-purpose mortar); in compression the
 * masonry's f_k = 0.45 f_b^0.7 f_m^0.3 = 10.5 MPa (eq. 3.1, the crush law's);
 * stiffness E = 1000 f_k = 10.5 GPa (3.7.2), the wall's, mortar included.
 * Characteristic, short-term values: elastic = fatal (masonry has no k_mod).
 * A bed or head joint is a bearing contact with a weak tensile bond: once the
 * bond cracks it bears on in compression and slides on friction, which is how
 * masonry stands over openings (arching) and under a slab's end rotation. So it
 * is a bearing joint (bearingJoint: PX_DESTRUCTION_BEARING_JOINTS grading, and
 * under VIBE_REBEARING a cracked joint re-bears; FIDELITY_AUDIT C9). What stays
 * approximate: the stage grades a bearing joint's tension as fasteners at its
 * centre, T = M/d + N, so the crack moment of a bed joint in pure bending reads
 * 3x the flexural f_xk1 W (exact in direct tension). Re-bearing's friction is
 * the material's mu under VIBE_MOHR_COULOMB_SHEAR (masonry 0.4, EN 1996-1-1
 * 3.6.2), timber's 0.23 without it.
 */
export const STONE_MORTAR_JOINT = { tensionElastic: 0.1e6, tensionFatal: 0.1e6, shearElastic: 0.15e6, shearFatal: 0.15e6,
  compressionElastic: 10.5e6, compressionFatal: 10.5e6, elasticModulus: 10.5e9, bearingJoint: 1 };
export const stoneJointsEnabled = () => (globalThis.process?.env?.VIBE_REAL_CAPACITIES ?? '0') === '1' && (globalThis.process?.env?.VIBE_STONE_JOINTS ?? 'unit') === 'mortar';
const isStone = (name) => name === 'stone';
/**
 * The head joints inside a stone lintel. A stone wall spans an opening on a
 * lintel (a single stone, or a timber or steel lintel) bearing >= 150 mm each
 * side (BS 5628-3 / BS EN 1996-2 practice, as the veneer's lintel course), not
 * on stones hung from their mortar. The skyline assets' course over each
 * window or door is cut into wall-sized stones: their head joints within the
 * opening's width plus 150 mm bearing each side, in the course above its head,
 * are the inside of one lintel stone and keep the stone's strength. Returns a
 * predicate on bonds.
 */
function lintelJoints(s, names) {
  const box = (i) => { const c = s.nodes[i].centroid, z = s.nodeSizes?.[i]; return z ? [[c.x - z.x / 2, c.y - z.y / 2, c.z - z.z / 2], [c.x + z.x / 2, c.y + z.y / 2, c.z + z.z / 2]] : null; };
  const openings = [];
  for (let i = 0; i < s.nodes.length; i++) {
    if (!/glass|door/.test(names[i] ?? '') && !/glazing|door/.test(s.nodeTypes?.[i] ?? '')) continue;
    const b = box(i); if (!b) continue;
    const thin = [0, 2].reduce((k, j) => (b[1][j] - b[0][j] < b[1][k] - b[0][k] ? j : k));   // the wall's normal axis
    openings.push({ along: thin === 0 ? 2 : 0, normal: thin, lo: b[0], hi: b[1] });
  }
  const k = ['x', 'y', 'z'];
  return (bond) => {
    const n = bond.normal, c = [bond.centroid.x, bond.centroid.y, bond.centroid.z];
    return openings.some((o) => Math.abs(n[k[o.along]]) > 0.5 && c[1] > o.hi[1] && c[1] < o.hi[1] + 0.7
      && c[o.along] > o.lo[o.along] - 0.15 && c[o.along] < o.hi[o.along] + 0.15 && Math.abs(c[o.normal] - (o.lo[o.normal] + o.hi[o.normal]) / 2) < 0.4);
  };
}
/**
 * A pack's masonry bonds as mortar joints (in place): the pack gains a
 * `mortar-joint` material and every bond between two masonry nodes, or
 * masonry and its bed, uses it; with stone joints on, a `stone-mortar-joint`
 * likewise for stone on stone or on its bed. Returns how many bonds changed.
 */
export function mortarJoints(pack) {
  const table = pack.defaults.solver.materials, s = pack.scenario;
  const names = s.nodeMaterials ?? s.nodes.map((n) => table[n.m ?? 0].name);
  let changed = 0;
  const brick = mortarJointsEnabled() && table.find((m) => isMasonry(m.name));
  if (brick) {
    let index = table.findIndex((m) => m.name === 'mortar-joint');
    if (index < 0) { index = table.length; table.push(mortarMaterial(brick)); }
    for (const b of s.bonds) {
      const x = names[b.node0], y = names[b.node1];
      if ((isMasonry(x) && (isMasonry(y) || isBed(y))) || (isMasonry(y) && isBed(x))) { b.m = index; changed += 1; }
    }
  }
  const stone = stoneJointsEnabled() && table.find((m) => isStone(m.name));
  if (stone) {
    let index = table.findIndex((m) => m.name === 'stone-mortar-joint');
    if (index < 0) { index = table.length; table.push({ ...structuredClone(stone), name: 'stone-mortar-joint', residualAreaFraction: 0, ...STONE_MORTAR_JOINT, ...masonryShear(STONE_FB) }); delete table[index].crush; }
    const lintel = lintelJoints(s, names);
    for (const b of s.bonds) {
      const x = names[b.node0], y = names[b.node1];
      if (isStone(x) && isStone(y) && lintel(b)) continue;
      // Stone on stone, on its bed, or with brick laid on it (a mortar bed too, the weaker unit's).
      if ((isStone(x) && (isStone(y) || isBed(y) || isMasonry(y))) || (isStone(y) && (isBed(x) || isMasonry(x)))) { b.m = index; changed += 1; }
    }
  }
  return changed;
}

/*
 * Brick-veneer timber-frame houses (veneer-houses.mjs): the materials and the
 * connections a house of that kind is actually made of. Only those builders
 * add these to their table, so no other asset's material table changes.
 *
 * Units: Pa, kg/m^3. Convention, for every entry below:
 *   fatal   = the characteristic (5th-percentile, short-term) strength or
 *             connection capacity from the cited standard or test data;
 *   elastic = 0.6 x fatal. 0.6 is EN 1995-1-1 Table 3.1's k_mod for
 *             permanent actions (service class 1): the share of its short-term
 *             strength timber, and a timber connection, carries indefinitely.
 *             The solver damages a bond only above `elastic`, so that is the
 *             line between a house that stands for decades and one that is
 *             failing; a design-load house sits at 0.6 / (1.35 x 1.3) ~ 0.35
 *             of fatal, under it.
 */
export const LONG_TERM = 0.6;
const limits = ({ compression, tension, shear }) => ({
  compressionElastic: LONG_TERM * compression, compressionFatal: compression,
  tensionElastic: LONG_TERM * tension, tensionFatal: tension,
  shearElastic: LONG_TERM * shear, shearFatal: shear,
});

/**
 * Structural softwood, EN 338:2016 strength class C24 (the usual European
 * stud/joist/rafter grade; AS/NZS MGP10-12 and US No.2 SPF are close):
 * mean density 420 kg/m^3, E0,mean 11 GPa, characteristic f_c,0,k 21 MPa,
 * f_m,k 24 MPa, f_v,k 4.0 MPa. `tension` is the bending strength f_m,k, not the
 * axial f_t,0,k (14.5 MPa): the solver checks one fibre tension, axial plus
 * bending (NvBlastExtStressMaterialFormula extStressFibre), and studs, joists
 * and rafters break in bending. No member here is a pure tie loaded near either.
 * Residual 0: a broken stud carries nothing (no reinforcement).
 */
export const C24 = { density: 420, elasticModulus: 11e9, ...limits({ compression: 21e6, tension: 24e6, shear: 4.0e6 }), residualAreaFraction: 0 };

/**
 * The doubled top plate (revision 2, veneer-houses.mjs): two 45 x 90 C24 plies
 * face-nailed one 16d per 406 mm (IRC R602.3(1) item 12), modelled as one
 * 90 x 90 member. Nailed plies are a mechanically jointed beam (EN 1995-1-1
 * Annex B): gamma = 1 / (1 + pi^2 E A s / (K L^2)) = 0.01-0.07 over spans of
 * 1.4-4.3 m (E A 4.5e7 N, s 0.406 m, K_ser 0.72 kN/mm), so the plies bend
 * almost independently: in the wall's plane the plate's moment capacity is
 * 2 f_m,k b t^2 / 6 = 1.46 kN m, half the solid section's. The stage grades a
 * bond's fibre stress M / S with S of the 90 x 90 section, so the member's
 * bending strength is f_m,k x 2 W_ply / W_90x90 = 12 MPa; f_c,0,k, f_v,k as
 * C24 (axially the two plies carry together: f_t,0,k 14.5 MPa on the full
 * area is within 20% of it). What stays approximate: its bending stiffness
 * (the stage's 90 x 90 is 4x the plies'; one stiffness per bond cannot be
 * both the plies' bearing and their slip), and its out-of-plane bending,
 * where the plies stand side by side and the solid section is the real one
 * (the plate is braced there by a joist or rafter seat every 0.6 m).
 */
export const DOUBLE_TOP_PLATE = { density: 420, elasticModulus: 11e9, ...limits({ compression: 21e6, tension: 24e6 * (2 * 0.045 ** 2) / 0.09 ** 2, shear: 4.0e6 }), residualAreaFraction: 0 };

/**
 * Perpendicular-to-grain bearing of C24 (EN 338: f_c,90,k 2.5 MPa, E90,mean
 * 0.37 GPa): what a stud end does to the plate it stands on, a joist to the
 * plate it sits on. Every timber connection's compression limit, and its
 * stiffness: a nailed joint is as stiff as the cross-grain wood it bears on
 * (the nails slip; EN 1995-1-1 7.1 K_ser ~ 0.7 kN/mm per 3.1 mm nail).
 */
export const BEARING = { compression: 2.5e6, elasticModulus: 0.37e9 };

/**
 * One 3.15 x 90 mm smooth common nail (the AS 1684 / 16d framing nail) in
 * C24, rho_k 350 kg/m^3, 45 mm members, EN 1995-1-1:
 *   lateral, single shear (8.2.2, Johansen mode f): M_y,Rk = 0.3 f_u d^2.6 =
 *     3.5 N m (f_u 600 MPa); f_h,k = 0.082 rho_k d^-0.3 = 20.3 MPa;
 *     F_v,Rk = 1.15 sqrt(2 M_y,Rk f_h,k d) = 0.77 kN;
 *   withdrawal, side grain (8.3.2): f_ax,k = 20e-6 rho_k^2 = 2.45 MPa,
 *     F_ax,Rk = f_ax,k d l_pen = 2.45 x 3.15 x 45 = 0.35 kN; none from end
 *     grain (8.3.1.1(4)).
 * Toe-nailing: NDS 2018 12.5.4 factors 0.83 lateral, 0.67 withdrawal.
 */
export const NAIL = { lateral: 770, withdrawal: 347, toeLateral: 0.83, toeWithdrawal: 0.67 };

/**
 * Slip moduli, N/m per fastener: EN 1995-1-1 Table 7.1 K_ser with rho_m
 * 420 kg/m^3 -- nails rho_m^1.5 d^0.8 / 30 (3.15 mm: 0.72 kN/mm; 4.5 mm
 * screws the same rule: 0.96 kN/mm), bolts rho_m^1.5 d / 23 (M12: 4.5 kN/mm);
 * a screw through 13 mm gypsum ~0.5 kN/mm (sheathing-connection tests, e.g.
 * Fiorino et al. 2006). A connection is as stiff as its fasteners in slip.
 * Where it also bears (a stud on its plate) it is far stiffer in compression
 * (E90 A / t, ~33 kN/mm for a stud on a 45 mm plate), but the solver gives a
 * bond one stiffness for every direction and shares load by it: rated by its
 * bearing, a toe-nailed joist seat took the roof's thrust off the bolted heel
 * and tore in tension (2026-10-06), so every joint is rated by its fasteners.
 */
export const SLIP = { nail: 719e3, screw: 955e3, bolt: 4.49e6, gypsumScrew: 0.5e6 };

/**
 * Ultimate slip of a dowel-type connection in timber (nails, screws, bolts,
 * gypsum-board screws), m: the stage's impact capacity (PhysX
 * PxDestructionMaterial::ductileSlip, opt-in) lets a joint of such a
 * material yield at its capacity and break only when its slip over a tick
 * passes this; a material without it is brittle (mortar, glass, wall ties
 * pulling out of their bed, timber within a member) and fractures at capacity.
 * EN 12512 classes a joint "high ductility" at D = v_u / v_y >= 6; with v_y =
 * F / K_ser (EN 1995-1-1 7.1, 16d nail ~770 N at 719 N/mm: ~1.1 mm) that is
 * ~6.4 mm, and nailed and bolted timber joints in test reach their ultimate
 * load at 10-15 mm of slip (Ehlbeck & Larsen 1993, STEP lecture C14; Folz &
 * Filiatrault 2001, J. Struct. Eng. 127(4): sheathing connectors hold their
 * peak well past 10-15 mm). 15 mm, as in the impact study
 * (scripts/impact-study.py ULTIMATE_SLIP). At impact speeds a yielded joint
 * slips 0.1-0.4 m in one tick, so verdicts there do not depend on it.
 */
export const ULTIMATE_SLIP = 0.015;

/**
 * The house's connections, each as its real fasteners. `per: 'joint'`: a
 * capacity in newtons for the joint, which the builder spreads over the
 * measured contact area of that kind of joint (veneer-houses.mjs
 * jointMaterials); `per: 'area'`: fasteners at a spacing, a capacity per m^2
 * of contact. `compression` is bearing in Pa. Schedules: IRC 2021 Table
 * R602.3(1) (the fastening schedule), AS 1684.2 (nominal fixings).
 */
/**
 * A joint of a few discrete fasteners twists (about its contact normal) on
 * the fasteners alone: each slips K_ser per unit of its own displacement,
 * r_i theta, so the joint's rotational stiffness is K_ser sum r_i^2 (the
 * elastic method for fastener groups, EN 1995-1-1 7.1 with AISC Manual Part 8),
 * and the joint's translational stiffness n K_ser. Its radius of gyration in
 * twist is therefore the fasteners' rms distance from their centroid, not the
 * contact patch's: a single bolt is a pin in the plane of its lap. `reach`,
 * the farthest fastener, gives the most loaded one (F = T reach / sum r^2).
 * Fasteners in one row of length L: rms L / (n - 1) sqrt((n^2 - 1) / 12),
 * reach L / 2. The row spans the member less an end/edge distance of 5 d each
 * side (EN 1995-1-1 Table 8.2, a_4,c for nails; 3.15 mm: 16 mm), across a 90 mm
 * member: 58 mm. One dowel twists on its own section: rms d / (2 sqrt 2), reach d / 2.
 */
export const fastenerRow = (n, length) => n < 2
  ? { gyration: length / (2 * Math.SQRT2), reach: length / 2 }
  : { gyration: length / (n - 1) * Math.sqrt((n * n - 1) / 12), reach: length / 2 };
const NAIL_ROW = 0.09 - 2 * 5 * 3.15e-3;
const toe = (n) => ({ tension: n * NAIL.withdrawal * NAIL.toeWithdrawal, shear: n * NAIL.lateral * NAIL.toeLateral });
/**
 * A rafter or ceiling-joist tie-down: a framing anchor / hurricane tie at
 * every seat (AS 1684.2 Section 9 tie-down for N2 wind and up; IRC R802.11).
 * Simpson H2.5A: allowable uplift 2.65 kN, lateral 0.5-0.7 kN (Cd 1.6, its
 * catalogue); the catalogue's allowable is the tested ultimate over 3, and
 * the characteristic about twice the allowable: 5.3 kN uplift, 1.2 kN lateral.
 */
export const TIE_DOWN = { tension: 5300, shear: 1200 };
const tied = (n) => { const t = toe(n); return { tension: t.tension + TIE_DOWN.tension, shear: t.shear + TIE_DOWN.shear }; };
export const CONNECTIONS = {
  // Stud (king, jack, cripple) to plate, header or sill trimmer: 2 end nails
  // (R602.3(1) "2-16d end nail"), lateral in end grain at NDS 12.5.2's 0.67;
  // end-grain withdrawal is not relied on, so tension is that of the 4-8d
  // toe-nail alternative, as 2 toe nails.
  // Real capacities (VIBE_REAL_CAPACITIES packs, read under VIBE_SECTION_ROTATION):
  // a stud end stands on its plate, so at rest the joint is a compressed
  // contact, as stiff as the cross-grain wood under it (E90 A / t, t the 45 mm
  // plate) in every direction until it slips or opens -- not the nails' slip,
  // which left the studs 23x softer than they are and hung the walls' load on
  // the drywall's screw rows (1.9x their capacity at rest). In rotation it is
  // the pin a stud is designed as (EN 1995-1-1 6.3.2, buckling length the
  // stud's height; AS 1684.2 stud tables): its nails' K_ser sum r^2, graded
  // at the most loaded nail.
  'stud-plate': { per: 'joint', ...toe(2), shear: 2 * NAIL.lateral * 0.67, compression: BEARING.compression, slip: 2 * SLIP.nail, twist: fastenerRow(2, NAIL_ROW), restBearing: 0.045 },
  // Ceiling joist to top plate: 3 toe nails (R602.3(1) "3-8d toe nails") and a tie-down.
  'joist-plate': { per: 'joint', ...tied(3), compression: BEARING.compression, slip: 3 * SLIP.nail, twist: fastenerRow(3, NAIL_ROW) },
  // Rafter seat (birdsmouth) to top plate: 3 toe nails (R602.3(1) "3-16d toe nails") and a tie-down.
  'rafter-seat': { per: 'joint', ...tied(3), compression: BEARING.compression, slip: 3 * SLIP.nail, twist: fastenerRow(3, NAIL_ROW) },
  // Rafter plumb cut to ridge board: 4 toe nails (R602.3(1) "4-16d toenail").
  ridge: { per: 'joint', ...toe(4), compression: BEARING.compression, slip: 4 * SLIP.nail, twist: fastenerRow(4, NAIL_ROW) },
  // Rafter heel to the ceiling joist beside it, which ties the rafter feet
  // together: one M12 grade 4.6 bolt (AS 1684.2 allows a bolted heel).
  // EN 1995-1-1 8.5.1 / 8.2.2, single shear, two 45 mm C24 members:
  // f_h,0,k = 0.082 (1 - 0.01 d) rho_k = 25.3 MPa; M_y,Rk = 0.3 x 400 x
  // 12^2.6 = 77 N m; mode f: 1.15 sqrt(2 M f_h d) = 7.8 kN, the lowest of
  // the modes but (a) 13.7 kN -> 7 kN. Tension: the washer crushing the wood,
  // 3 f_c,90,k x washer area (8.5.2(2), 36 mm square washer, 1e-3 m^2) = 7.5 kN.
  heel: { per: 'joint', tension: 7.5e3, shear: 7e3, compression: BEARING.compression, slip: SLIP.bolt, twist: fastenerRow(1, 0.012) },
  // Ceiling joists spliced over the centre wall: lapped and face-nailed with
  // as many nails as the heel needs, since the splice carries the same tie
  // force (IRC R802.5.2 and its table: 4+ 16d for this span and pitch), or a
  // nail plate. The model's joist halves butt end to end, so the nails'
  // lateral capacity is the butt's tension as well as its shear.
  'joist-splice': { per: 'joint', tension: 4 * NAIL.lateral, shear: 4 * NAIL.lateral, compression: BEARING.compression, slip: 4 * SLIP.nail, twist: fastenerRow(4, NAIL_ROW) },
  // Top plates at corners and intersections: the upper plate laps the other
  // wall's, 2 face nails (R602.3(1) "2-16d face nails"). The model's plates
  // meet end on, so the nails' lateral capacity is the butt's tension too.
  'plate-lap': { per: 'joint', tension: 2 * NAIL.lateral, shear: 2 * NAIL.lateral, compression: BEARING.compression, slip: 2 * SLIP.nail, twist: fastenerRow(2, NAIL_ROW) },
  // The same joint nail-plated as well, where the upper storey's walls meet
  // on the floor platform, whose settlement loads them: AS 1684.2 allows a
  // nail plate at top-plate joints; a 75 x 150 mm toothed plate each face,
  // ~2.5 kN characteristic each in tension or shear in softwood
  // (manufacturers' tables).
  'plate-lap-plated': { per: 'joint', tension: 2 * NAIL.lateral + 2 * 2500, shear: 2 * NAIL.lateral + 2 * 2500, compression: BEARING.compression, slip: 2 * SLIP.nail },
  // Studs nailed face to face: king to jack, junction backers, a partition's
  // end stud to its backer (R602.3(1) "16d at 24 in. o.c."): one nail per
  // 600 mm of a 90 mm face.
  'stud-lap': { per: 'area', tension: NAIL.withdrawal / 0.054, shear: NAIL.lateral / 0.054, compression: BEARING.compression, slip: SLIP.nail / 0.054 },
  // Gable-end studs at 600 mm, end-nailed to the side wall's top plate and to
  // the verge rafter above them (2 nails each end): 2 nails per 0.6 x 0.09 m.
  'gable-stud': { per: 'area', ...toe(2), shear: 2 * NAIL.lateral * 0.67, compression: BEARING.compression, slip: 2 * SLIP.nail, perArea: 0.054 },
  // Face-nailed laps: top plates lapped at corners and intersections
  // (R602.3(1) "2-16d face nails"), built-up and junction studs, ceiling joists
  // lapped over the centre wall (3 face nails), header ends to king studs.
  // One nail per 40 cm^2 of lapped face (two in a 90 x 90 mm plate lap).
  lap: { per: 'area', tension: NAIL.withdrawal / 40e-4, shear: NAIL.lateral / 40e-4, compression: BEARING.compression, slip: SLIP.nail / 40e-4 },
  // Bottom plate to slab: M12 anchor bolts at 1.2 m (AS 1684.2; IRC R403.1.6
  // allows 1.8 m) through a 90 mm plate: 0.108 m^2 of plate per bolt. Per bolt
  // 8 kN lateral (EN 1995-1-1 8.2.3, steel/concrete to 45 mm timber, mode
  // between 13.7 kN embedment and the bolt's yield) and 7.5 kN washer bearing.
  // Slip: bolt in steel/concrete-to-timber, twice K_ser (EN 1995-1-1 7.1(3)).
  anchor: { per: 'area', tension: 7.5e3 / 0.108, shear: 8e3 / 0.108, compression: BEARING.compression, slip: 2 * SLIP.bolt / 0.108 },
  // Gypsum board to framing: screws at 300 mm along each stud, plate and
  // joist (AS/NZS 2589, GA-216), one per 0.30 x 0.045 m of contact. Per screw
  // ~0.35 kN lateral (edge bearing in the gypsum) and ~0.34 kN pull-through
  // (ASTM C473 nail-pull, 77 lbf for 12.7 mm board).
  'drywall-screw': { per: 'area', tension: 340 / 0.0135, shear: 350 / 0.0135, compression: 3.5e6, slip: SLIP.gypsumScrew / 0.0135 },
  // Concrete roof tiles hung on 38 x 25 battens at 330 mm gauge, each nailed
  // to every rafter it crosses with one 3.15 x 75 mm nail: one nail per 0.33
  // x 0.045 m of rafter top. Withdrawal at 50 mm penetration 0.39 kN.
  'roof-batten': { per: 'area', tension: 2.45 * 3.15 * 50 / 0.01485, shear: NAIL.lateral / 0.01485, compression: BEARING.compression, slip: SLIP.nail / 0.01485 },
  // Gable weatherboards: one nail per board (150 mm cover) per rafter or
  // plate it crosses, over a 45 mm face.
  weatherboard: { per: 'area', tension: NAIL.withdrawal / (0.15 * 0.045), shear: NAIL.lateral / (0.15 * 0.045), compression: BEARING.compression, slip: SLIP.nail / (0.15 * 0.045) },
  // Window and door frames screwed through the jambs, head and sill into the
  // rough opening at <= 450 mm (AS 2047 installation), ~1 kN per screw each
  // way, over a 90 mm deep frame.
  'window-fixing': { per: 'area', tension: 1e3 / (0.45 * 0.09), shear: 1e3 / (0.45 * 0.09), compression: BEARING.compression, slip: SLIP.screw / (0.45 * 0.09) },
};
// A stud beside a plate's end or side, not standing on it (real-capacity packs): the same nails, no bearing.
CONNECTIONS['stud-plate-side'] = (({ restBearing, ...c }) => c)(CONNECTIONS['stud-plate']);

/**
 * One 8d common nail (2-1/2 in x 0.131 in: 3.33 x 63.5 mm) in C24, rho_k 350,
 * as NAIL above (EN 1995-1-1): M_y,Rk = 0.3 x 600 x 3.33^2.6 = 4.1 N m;
 * f_h,k = 0.082 x 350 x 3.33^-0.3 = 20.0 MPa; F_v,Rk = 1.15 sqrt(2 M_y,Rk
 * f_h,k d) = 0.85 kN (8.2.2, mode f). Toe-nailed (driven at 30 deg, started
 * L/3 from the member's end: NDS 2018 12.1.5 / Fig. 12A) it reaches L cos 30
 * - L/3 = 34 mm into the other member: withdrawal f_ax,k d l = 2.45 x 3.33 x
 * 34 = 0.28 kN (8.3.2). K_ser rho_m^1.5 d^0.8 / 30 = 0.75 kN/mm (Table 7.1).
 */
export const NAIL_8D = { lateral: 850, withdrawal: 276, slip: 751e3 };
/**
 * Face nails at 16 in. (406 mm) centres along a 90 mm wide plate: the contact
 * area each 16d (the kit's 3.15 x 90 NAIL) serves. IRC 2021 Table R602.3(1)
 * item 12, "top plate to top plate: 16d common, 16 in. o.c., face nail" (the
 * same nailing a framer gives a plate over a header built up to it).
 */
const FACE_NAILED_PLATE = 0.406 * 0.09;
/**
 * Splices in long timber runs (veneer-houses.mjs splices; high-profile packs).
 * Lumber comes in stock lengths; 16 ft (4.877 m) is a standard one (ALSC PS
 * 20 / NLGA), so a plate or rim longer than that is jointed.
 * - Double top plate: the two plies' end joints offset >= 24 in. (610 mm), with
 *   8-16d common face nails each side of a joint within the lap (IRC 2021
 *   R602.3.2, Table R602.3(1) item 13). A tension in the plate crosses from
 *   one ply to the other through the 8 nails between the two joints.
 * - Doubled rim (band) joist, a built-up member: 2-20d common at each splice,
 *   20d at 32 in. staggered top and bottom (Table R602.3(1), built-up girders
 *   and beams); the lap between the plies' joints (taken at the plate's 610
 *   mm) holds the 2 + 2 splice nails.
 * - Bottom plate, a single 45 mm ply: a butt joint, nothing across it (its
 *   pieces are nailed down each on their own: R602.3(1) item 14).
 * Nails (EN 1995-1-1 8.2.2 mode f, C24 rho_k 350, as NAIL; K_ser Table 7.1 at
 * rho_m 420): 16d common 4.11 x 88.9 mm: M_y,Rk 7.1 N m, f_h,k 18.8 MPa,
 * F_v,Rk 1.21 kN, K_ser 0.89 kN/mm; 20d common 4.88 x 101.6 mm: M_y,Rk 11.1 N m,
 * f_h,k 17.8 MPa, F_v,Rk 1.60 kN, K_ser 1.02 kN/mm.
 */
export const NAIL_16D_COMMON = { lateral: 1207, slip: 889e3 };
export const NAIL_20D_COMMON = { lateral: 1596, slip: 1020e3 };
export const STOCK_LENGTH = 4.877;
export const SPLICE_LAP = 0.610;
export const SPLICES = {
  // The two plies (90 x 45 each) stacked: in-plane they bend apart (DOUBLE_TOP_PLATE).
  'plate-splice': { nails: 8, nail: NAIL_16D_COMMON, ply: (h, w) => ({ b: w, t: h / 2 }) },
  // The rim's two plies (45 thick each) side by side: each its full depth.
  'rim-splice': { nails: 4, nail: NAIL_20D_COMMON, ply: (h, w) => ({ b: w / 2, t: h }) },
};

/**
 * The house's load path, re-authored (veneer-houses.mjs `revision: 2`,
 * 2026-10-08; docs/calibration/house-headers.md): the connections revision 1
 * rated as something else.
 */
export const REVISION_2_CONNECTIONS = {
  // Header to king stud: IRC 2021 Table R602.3(1) item 11, "continuous
  // header to stud: 4-8d common toe nails", at each end. (Revision 1 rated
  // it as a stud against a plate's side: 2 end-grain nails, 1.0 kN.) Lateral
  // 4 x 0.85 x 0.83 (NDS 12.5.4 toe-nail factor) = 2.8 kN; withdrawal 4 x
  // 0.28 x 0.67 = 0.74 kN. The nails run down the lintel's 190 mm depth.
  // The header bears on its jack studs (stud-plate, as revision 1): the king
  // stud's nails only locate it.
  'header-king': { per: 'joint', tension: 4 * NAIL_8D.withdrawal * NAIL.toeWithdrawal, shear: 4 * NAIL_8D.lateral * NAIL.toeLateral,
    compression: BEARING.compression, slip: 4 * NAIL_8D.slip, twist: fastenerRow(4, 0.19 - 2 * 5 * 3.33e-3) },
  // Top plate to the header (built up solid to it) under it: face-nailed as
  // the plates are to each other, one 16d per 406 mm (R602.3(1) item 12).
  // Revision 1 rated it as a corner lap, one nail per 40 cm^2: 20 nails along
  // a 1 m door head where a framer drives 2-3, which made plate and header
  // one 0.5 m deep glued beam.
  // The plate bears on the header (restBearing: as stiff as its 90 mm of
  // cross-grain wood, as a stud on its plate) and turns on its row of nails,
  // a pin: 2-3 nails do not make plate and header one beam.
  // (`perArea`: the patch one fastener group serves; its capacities and slip in N and N/m.)
  'header-plate': { per: 'area', perArea: FACE_NAILED_PLATE, tension: NAIL.withdrawal, shear: NAIL.lateral, compression: BEARING.compression, slip: SLIP.nail,
    row: { spacing: 0.406, width: 0.09 } },
};

/**
 * A brick wall tie (veneer to stud): a corrugated or twisted steel strip
 * nailed to the stud and bedded in a mortar joint, every 600 mm along and
 * ~400 mm up (BS EN 845-1 ties for timber frame, PD 6697 / NHBC 6.2: one per
 * 0.25 m^2 at most; TMS 402 6.2: one per 0.25 m^2). Tested capacity of
 * corrugated ties (Choi & LaFave 2004, J. Struct. Eng. 130(9)) ~0.9 kN in
 * tension (the nail pulling out of the stud), ~0.6 kN in compression (the
 * strip buckling across the cavity), ~0.4 kN sliding along the wall (it is
 * made flexible there, for the frame's shrinkage).
 * Stiffness: ~1 kN/mm along the tie, but a timber-frame tie is made to let
 * the frame shrink 10-15 mm past the brick without loading it (BS EN 845-1
 * movement-tolerant ties, NHBC 6.2.13): ~0.2 kN at 10 mm, 0.02 kN/mm, in the
 * plane of the wall. The solver gives a bond one stiffness and shares load by
 * it; at 1 kN/mm the 484 ties of the bungalow hung its frame's load on the
 * brick (0.4 kN each, at their sliding capacity, 2026-10-06), so a tie gets
 * the in-plane stiffness, the one gravity load sharing sees.
 * A tie is a bond between two chunks that do not touch: it gets the solver's
 * stiffness-floor area (1e-4 m^2, structure_lint SOLVER_MIN_BOND_AREA_M2, so
 * it is neither a sliver nor stiffened), strengths of capacity / area, and the
 * modulus that gives that stiffness over a 0.4 m chunk-to-chunk distance.
 */
export const WALL_TIE = { area: 1e-4, tension: 900, compression: 600, shear: 400, stiffness: 2e4, length: 0.4, axialStiffness: 1e6 };
/*
 * A hit on the brick loads the tie along its axis, where it is ~1 kN/mm (above):
 * the impact solve (PhysX impactStiffness, opt-in) takes the tie's joints at
 * that stiffness, `impactElasticModulus`, the modulus that gives it over the
 * same 0.4 m and 1e-4 m^2; the stress solve keeps the in-plane one.
 */

/**
 * Gypsum plasterboard, EN 520 type A 12.5 mm (~8.75 kg/m^2 -> 700 kg/m^3).
 * Flexural strength from EN 520's breaking load (550 N over 350 mm, 300 mm
 * wide, 12.5 mm thick: 3PL/2bh^2 = 6.2 MPa along the paper, 2.4 MPa across);
 * the gypsum core crushes at ~3.5 MPa; E ~2 GPa. A sheet is one chunk, so these
 * only matter where it is the weaker side of a bond; its screws (CONNECTIONS
 * 'drywall-screw') are what holds it.
 */
export const GYPSUM = { density: 700, elasticModulus: 2e9, ...limits({ compression: 3.5e6, tension: 2.4e6, shear: 1.5e6 }), residualAreaFraction: 0 };

/**
 * Concrete roof tiles on battens as one 50 mm layer: tiles 45 kg/m^2
 * (~10.5 tiles/m^2 at 4.3 kg, AS 1170.1 Table A: 0.53 kPa with battens) over
 * the 50 mm the battens and tile profile occupy: 920 kg/m^3. A thinner layer
 * would be a sliver hull (PhysX GPU hulls fail past extent/radius 100).
 */
export const ROOF_TILE_LAYER = { density: 920 };

/** Painted timber weatherboards (18 mm boards lapped to a 25 mm layer, ~11 kg/m^2). */
export const WEATHERBOARD = { density: 450 };

/**
 * Chunk crushing (comminution), opt-in: a `crush` block on a material lets the
 * native stage destroy a chunk of it whose mean stress (its contact and bond
 * forces' virial over its volume) leaves a Drucker-Prager cone capped at
 * `capPressure`, at the Perzyna rate overstress^2 dt / (crushViscosity
 * crushEnergy) (PhysX NvBlastExtStressMaterialFormula.h extStressCrushStep).
 * The cone is pinned to the material's unconfined compressive strength fc
 * (cohesion fc (1 - k/3), k = 1.2: ~30 degrees of internal friction; cap at
 * 2.5 fc, where confined pore collapse begins), as the PhysX reference
 * building derives it (blast-stress-solver export-reference-building.mjs).
 * crushEnergy: specific comminution energy, Bond's law W = 10 Wi (1/sqrt(P80)
 * - 1/sqrt(F80)) kWh/t with Bond's (1961) work indices. crushViscosity: the
 * overstress the CEB-FIP Model Code 1990 (2.1.6.4) dynamic increase factor
 * gives at a 30/s strain rate, over that rate: (DIF - 1) fc / 30.
 * Natural-stone masonry, structural softwood and roof tiles crush too (below,
 * each cited). Steel does not: see `crushFor`.
 */
const crushOf = (fc, energy, viscosity, impedance, k = 1.2) => ({ capPressure: 2.5 * fc, cohesion: fc * (1 - k / 3), frictionSlope: k, crushEnergy: energy, crushViscosity: viscosity, impedance });
/** Bond (1961): specific comminution energy, J/m^3, from F80 to P80 (m) at work index Wi (kWh/t) and density rho. */
const bond = (wi, from, to, rho) => 10 * wi * (1 / Math.sqrt(to * 1e6) - 1 / Math.sqrt(from * 1e6)) * 3.6e6 / 1000 * rho;
/** CEB-FIP MC90 (2.1.6.4) compressive DIF at 30/s for strength fc (Pa), as the viscosity (DIF - 1) fc / 30. */
const mc90Viscosity = (fc) => { const a = 1 / (5 + 9 * fc / 10e6); return (Math.pow(30 / 30e-6, 1.026 * a) - 1) * fc / 30; };
/**
 * Acoustic impedance rho c = sqrt(rho E), Pa s/m: the native stage's
 * impact-pressure crush (PhysX impactImpedance, opt-in with
 * VIBE_IMPACT_CAPACITY=1) crushes a struck chunk at the 1-D elastic impact
 * stress Z1 Z2 / (Z1 + Z2) v instead of at the virial of the solve's forces
 * (PhysX docs/destruction/IMPACT_CAPACITY_DESIGN.md "Ci").
 */
const impedance = (density, modulus) => Math.sqrt(density * modulus);
export const CRUSH = {
  // Clay-brick veneer panel: masonry f_k = 0.55 f_b^0.7 f_m^0.3 (EN 1996-1-1
  // eq. 3.1, Group 1 clay units, general-purpose mortar) = 6.8 MPa for common
  // facing brick (f_b 20 MPa, EN 771-1 / AS/NZS 4455) in M4 mortar. Brick to
  // 20 mm rubble from 100 mm at Wi 13 kWh/t (fired clay; cement clinker 13.5):
  // 0.51 kWh/t = 1.8 kJ/kg x 1900 kg/m^3 = 3.5 MJ/m^3. DIF 3.6 -> 5.9e5 Pa s.
  // E = 1000 f_k (EN 1996-1-1 3.7.2) = 6.8 GPa at 1900 kg/m^3: 3.6 MPa s/m.
  brickVeneer: crushOf(6.8e6, 3.5e6, 5.9e5, impedance(1900, 6.8e9)),
  // Gypsum board: core crushes at ~3.5 MPa (GYPSUM above). To 5 mm from its
  // 13 mm at Wi 8.2 (gypsum rock 8.16): 0.44 kWh/t = 1.6 kJ/kg x 700 kg/m^3 =
  // 1.1 MJ/m^3. DIF 5.4 -> 5.1e5 Pa s.
  // E 2 GPa (GYPSUM) at 700 kg/m^3: 1.2 MPa s/m.
  gypsum: crushOf(3.5e6, 1.1e6, 5.1e5, impedance(700, 2e9)),
  // Concrete C30/37: f_ck 30 MPa (EN 1992-1-1 Table 3.1). Rubble to 20 mm from
  // 100 mm at Wi 11.6 kWh/t (limestone aggregate, Bond 1961): 0.45 kWh/t =
  // 1.6 kJ/kg x 2400 = 3.9 MJ/m^3. MC90 DIF at 30/s 1.56 -> 5.6e5 Pa s. Reinforced
  // concrete crushes its concrete only; the cage (bonds) still has to snap.
  // E_cm 33 GPa (EN 1992-1-1 Table 3.1) at 2400 kg/m^3: 8.9 MPa s/m.
  concrete: crushOf(30e6, 3.9e6, 5.6e5, impedance(2400, 33e9)),
  // Annealed float glass fails by tensile cracking under contact (Hertzian
  // cones), at its characteristic bending strength f_g,k = 45 MPa (EN 572-1),
  // pressure-independent (slope 0). To 1 mm from a 6 mm pane at Wi 3.08 kWh/t
  // (glass, Bond 1961): 0.58 kWh/t = 2.1 kJ/kg x 2500 = 5.2 MJ/m^3. Taken as
  // rate-insensitive -- an assumption, not a measurement: the viscosity lets
  // 1 MPa of overstress shatter a pane within one 60 Hz tick. Shards, not
  // dust: all of its mass in a dozen pieces (for the client's debris).
  glass: { capPressure: 45e6, cohesion: 45e6, frictionSlope: 0, crushEnergy: 5.2e6, crushViscosity: 3.2e3, debrisMassFraction: 1, debrisFragmentCount: 12,
    // E 70 GPa (EN 572-1) at 2500 kg/m^3: 13 MPa s/m.
    impedance: impedance(2500, 70e9) },
  // Natural-stone masonry (a wall of dimensioned limestone or sandstone units in
  // mortar, as the brick veneer is of brick): f_k = K f_b^0.7 f_m^0.3 (EN 1996-1-1
  // eq. 3.1, Table 3.3 natural stone K 0.45) = 10.5 MPa for units of f_b 50 MPa
  // (building limestone and sandstone, 30-90 MPa unconfined: BS EN 1926 tests,
  // e.g. Portland limestone ~50 MPa) in M4 mortar. Rubble to 20 mm from 100 mm
  // at Wi 11.6 kWh/t (limestone, Bond 1961; sandstone similar): 0.45 kWh/t =
  // 1.6 kJ/kg x 2600 = 4.2 MJ/m^3. MC90 DIF 2.67 at 30/s -> 5.8e5 Pa s.
  // E = 1000 f_k (EN 1996-1-1 3.7.2) = 10.5 GPa at 2600 kg/m^3: 5.2 MPa s/m.
  // The bonds' 102 MPa (the legacy table's) is a solid stone's, not a wall's.
  stone: crushOf(10.5e6, bond(11.6, 0.1, 0.02, 2600), mc90Viscosity(10.5e6), impedance(2600, 10.5e9)),
  // Structural softwood (C24, EN 338): a member is destroyed when its fibres
  // fail, crushing along the grain at f_c,0,k 21 MPa. Across the grain it
  // yields at f_c,90,k 2.5 MPa, but that densifies the wood (a dent) and keeps
  // the member, and the stage's cone is one isotropic law, so the along-grain
  // strength is the crush. Energy: the crush plateau to densification, f_c,0
  // x (1 - rho / rho_cell) = 21 MPa x (1 - 420 / 1500) = 15 MJ/m^3 (cellular
  // crushing of wood along the grain, Reid & Peng 1997, Int. J. Impact Eng.
  // 19(5-6); cell-wall density ~1500 kg/m^3, Wood Handbook FPL-GTR-282 ch. 4).
  // Rate: strength rises ~10% per tenfold loading rate (Wood Handbook ch. 5),
  // 30/s against a 1e-5/s test: 6.5 decades, DIF 1.86 -> 6.0e5 Pa s.
  // E_0 11 GPa at 420 kg/m^3: 2.1 MPa s/m.
  softwood: crushOf(21e6, 21e6 * (1 - 420 / 1500), (Math.pow(1.1, 6.5) - 1) * 21e6 / 30, impedance(420, 11e9)),
  // Concrete roof tiles (EN 490/491; the kit's ROOF_TILE_LAYER, a 50 mm layer
  // of 920 kg/m^3 smearing tiles of 2300 kg/m^3 and air): a tile breaks in
  // flexure, pressure-independent like glass, at the flexural tensile strength
  // of its concrete, f_ctm,fl = (1.6 - h/1000) f_ctm = 1.59 x 3.5 MPa = 5.6 MPa
  // (EN 1992-1-1 3.1.8, C40/50 f_ctm 3.5 MPa, 12 mm tile), on the layer's
  // stress (its virial over the smeared volume) 920/2300 of that: 2.2 MPa.
  // Pieces to 5 mm from 12 mm at Wi 11.6: 0.58 kWh/t = 2.1 kJ/kg x 920 =
  // 1.9 MJ/m^3. MC90 tensile DIF at 30/s 1.53 -> 3.9e4 Pa s. Shards: all of its
  // mass in pieces. Z: sqrt(920 x 0.4 x 30 GPa) = 3.3 MPa s/m.
  roofTile: { capPressure: 2.2e6, cohesion: 2.2e6, frictionSlope: 0, crushEnergy: bond(11.6, 0.012, 0.005, 920), crushViscosity: 0.53 * 2.2e6 / 30,
    debrisMassFraction: 1, debrisFragmentCount: 8, impedance: impedance(920, 0.4 * 30e9) },
  // Roofing slate (EN 12326): a natural stone that also breaks in flexure,
  // modulus of rupture >= 35 MPa along the grain (EN 12326-1 characteristic,
  // typical slates 50-90), on a 2100 kg/m^3 layer of 2800 kg/m^3 slate: 26 MPa.
  // Pieces to 5 mm from 6 mm slates at Wi 13.8 kWh/t (slate, Bond 1961 table): 0.17
  // kWh/t = 0.58 kJ/kg x 2100 = 1.2 MJ/m^3. Rate-insensitive as glass (an
  // assumption). Z: sqrt(2100 x 0.75 x 60 GPa) = 9.7 MPa s/m.
  slate: { capPressure: 26e6, cohesion: 26e6, frictionSlope: 0, crushEnergy: bond(13.8, 0.006, 0.005, 2100), crushViscosity: 3.2e3,
    debrisMassFraction: 1, debrisFragmentCount: 8, impedance: impedance(2100, 0.75 * 60e9) },
};
/**
 * The crush block a material gets by what it is, by name: masonry (brick and
 * natural stone), concrete, gypsum, glass, structural softwood and roof tiles
 * crush. Steel does not: it is ductile, so a struck steel member yields and
 * bends (its joints' ductileSlip, the bonds' yield to rupture), and under the
 * pressures here it never comminutes (S355's f_y 355 MPa sets an indentation,
 * not rubble; a cone fitted to it would delete a member a ball only dents).
 * Trim, joinery, siding, furniture timber and trees are left as they were (not
 * structural softwood; their own values are another item). Anchors (zero-mass
 * chunks) never crush whatever they are.
 */
export function crushFor(name = '') {
  if (/^stone$/.test(name)) return CRUSH.stone;
  if (/^(stud-timber|double-top-plate|wood-frame|structure-timber)$/.test(name)) return CRUSH.softwood;
  if (/^concrete-roof-tile$/.test(name)) return CRUSH.roofTile;
  if (/^slate-roof$/.test(name)) return CRUSH.slate;
  if (/^(brick|garden-masonry)/.test(name) || /masonry/.test(name) && !/connection|seam|joint/.test(name)) return CRUSH.brickVeneer;
  if (/^(reinforced-concrete|concrete-slab|concrete-wall|concrete-footing|pale-paving)$/.test(name)) return CRUSH.concrete;
  if (/^(plaster|drywall|gypsum)$/.test(name)) return CRUSH.gypsum;
  if (/^(glass|window-glass)$/.test(name)) return CRUSH.glass;
  return null;
}
/** Crushing on, for builds that opt in (VIBE_CRUSH=1). */
export const crushEnabled = () => (globalThis.process?.env?.VIBE_CRUSH ?? '0') === '1';
