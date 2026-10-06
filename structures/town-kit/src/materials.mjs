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
 * The house's connections, each as its real fasteners. `per: 'joint'`: a
 * capacity in newtons for the joint, which the builder spreads over the
 * measured contact area of that kind of joint (veneer-houses.mjs
 * jointMaterials); `per: 'area'`: fasteners at a spacing, a capacity per m^2
 * of contact. `compression` is bearing in Pa. Schedules: IRC 2021 Table
 * R602.3(1) (the fastening schedule), AS 1684.2 (nominal fixings).
 */
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
  'stud-plate': { per: 'joint', ...toe(2), shear: 2 * NAIL.lateral * 0.67, compression: BEARING.compression, slip: 2 * SLIP.nail },
  // Ceiling joist to top plate: 3 toe nails (R602.3(1) "3-8d toe nails") and a tie-down.
  'joist-plate': { per: 'joint', ...tied(3), compression: BEARING.compression, slip: 3 * SLIP.nail },
  // Rafter seat (birdsmouth) to top plate: 3 toe nails (R602.3(1) "3-16d toe nails") and a tie-down.
  'rafter-seat': { per: 'joint', ...tied(3), compression: BEARING.compression, slip: 3 * SLIP.nail },
  // Rafter plumb cut to ridge board: 4 toe nails (R602.3(1) "4-16d toenail").
  ridge: { per: 'joint', ...toe(4), compression: BEARING.compression, slip: 4 * SLIP.nail },
  // Rafter heel to the ceiling joist beside it, which ties the rafter feet
  // together: one M12 grade 4.6 bolt (AS 1684.2 allows a bolted heel).
  // EN 1995-1-1 8.5.1 / 8.2.2, single shear, two 45 mm C24 members:
  // f_h,0,k = 0.082 (1 - 0.01 d) rho_k = 25.3 MPa; M_y,Rk = 0.3 x 400 x
  // 12^2.6 = 77 N m; mode f: 1.15 sqrt(2 M f_h d) = 7.8 kN, the lowest of
  // the modes but (a) 13.7 kN -> 7 kN. Tension: the washer crushing the wood,
  // 3 f_c,90,k x washer area (8.5.2(2), 36 mm square washer, 1e-3 m^2) = 7.5 kN.
  heel: { per: 'joint', tension: 7.5e3, shear: 7e3, compression: BEARING.compression, slip: SLIP.bolt },
  // Ceiling joists spliced over the centre wall: lapped and face-nailed with
  // as many nails as the heel needs, since the splice carries the same tie
  // force (IRC R802.5.2 and its table: 4+ 16d for this span and pitch), or a
  // nail plate. The model's joist halves butt end to end, so the nails'
  // lateral capacity is the butt's tension as well as its shear.
  'joist-splice': { per: 'joint', tension: 4 * NAIL.lateral, shear: 4 * NAIL.lateral, compression: BEARING.compression, slip: 4 * SLIP.nail },
  // Top plates at corners and intersections: the upper plate laps the other
  // wall's, 2 face nails (R602.3(1) "2-16d face nails"). The model's plates
  // meet end on, so the nails' lateral capacity is the butt's tension too.
  'plate-lap': { per: 'joint', tension: 2 * NAIL.lateral, shear: 2 * NAIL.lateral, compression: BEARING.compression, slip: 2 * SLIP.nail },
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
export const WALL_TIE = { area: 1e-4, tension: 900, compression: 600, shear: 400, stiffness: 2e4, length: 0.4 };

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
