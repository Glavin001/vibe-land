// Real connection capacities and masses for the outdoor props and trees, under
// each bond's real cross-section (VIBE_REAL_CAPACITIES=1, opt-in).
//
// The kit tuned these for the playground cannon under the old capped bending
// model: outdoor seams at 0.1-0.001 of their material (outdoor-props.mjs
// fractureSeamScale), tree wood at 4-40 kPa (tree.mjs), Vibe Town multiplying
// some back up by 30-100 (vibe-town/strengthen.mjs). With each bond's real
// section (PxDestructionStressDesc::sectionBending) and rotational stiffness
// (::sectionRotationalStiffness) they fall under their own weight: the oracle
// (stress-share.py --bending section --angular section) puts a bike rack's
// footing seam at 580x its limit, a shade tree's limbs at 73x.
//
// Here every limit comes from the real member or fastener a prop stands for,
// with its grade's characteristic strengths, expressed over the patch the
// model gives the joint. The models are solid boxes standing for hollow
// sections and sheet, so a capacity is converted to the equivalent stress on
// the modelled patch: bending M / S_patch, axial N / A_patch, shear V / A_patch,
// with S_patch = b h^2 / 6 of the patch. "elastic" is where the stage starts
// accruing damage (steel and bolts: yield; timber: the permanent-load kmod of
// EN 1995-1-1 Table 3.1, 0.6; wood in trees: the fibre stress at proportional
// limit, ~0.6 of the modulus of rupture), "fatal" the ultimate (steel fu, bolt
// fub, timber and wood characteristic/clear-wood strength). Masses of parts
// modelled as solid volumes are set from the real part's mass per length or
// area.
//
// References:
//   EN 10219-1:2006 Table A.3 (S235JRH, S275J0H, S355J2H: fy, fu for t <= 16 mm)
//   EN 1993-1-8:2005 Tables 3.1, 3.4 (bolt grades; Fv = 0.6 fub As, Ft = 0.9 fub As)
//   ISO 898-1 (tensile stress areas As)
//   EN 485-2 (EN AW-5754 H22 sheet: Rp0.2 130 MPa, Rm 220 MPa)
//   EN 12150-1 (thermally toughened glass, characteristic bending strength 120 MPa)
//   EN 338:2016 Table 1 (C24: fm 24, ft0 14.5, fc0 21, fv 4.0 MPa, rho 420 kg/m3)
//   EN 1995-1-1:2004 §8.2 (Johansen lateral capacity, eq. 8.6f), §8.5.1.1
//     (embedment eq. 8.32, yield moment eq. 8.30), §8.7.2 (screw withdrawal eq. 8.38)
//   EN 1561 (EN-GJL-250 grey cast iron, Rm 250 MPa)
//   ASTM A307 (Grade A bolts, Fu 414 MPa)
//   USDA FPL Wood Handbook, FPL-GTR-282 (2021), Table 5-3a/5-3b (clear wood, green:
//     modulus of rupture, compression parallel to grain, shear parallel to grain, MOE)

export const realCapacitiesEnabled = () => (globalThis.process?.env?.VIBE_REAL_CAPACITIES ?? '0') === '1';

// ------------------------------------------------------------- materials ---
import { MORTAR_JOINT, C24 as KIT_C24 } from './materials.mjs';
const MPa = 1e6;
export const STEEL = {
  S235: { fy: 235 * MPa, fu: 360 * MPa },
  S275: { fy: 275 * MPa, fu: 410 * MPa },
  S355: { fy: 355 * MPa, fu: 470 * MPa },
};
const BOLT_8_8 = { fy: 640 * MPa, fu: 800 * MPa };
const BOLT_A2_70 = { fy: 450 * MPa, fu: 700 * MPa };     // stainless property class 70 (EN ISO 3506-1)
const AS = { M6: 20.1e-6, M8: 36.6e-6, M10: 58.0e-6, M12: 84.3e-6, M16: 157e-6, 'UNC-5/8': 146e-6 }; // m2
const ALUMINIUM = { fy: 130 * MPa, fu: 220 * MPa, density: 2700 };
const C24 = { fm: 24 * MPa, ft: 14.5 * MPa, fc: 21 * MPa, fv: 4.0 * MPa, rhok: 350, density: 420, E: 11e9 };
const KMOD_PERMANENT = 0.6;
const STEEL_DENSITY = 7850;

/** Thin-walled sections: area, elastic and plastic moduli, shear area (m, m2, m3). */
export function chs(D, t) {
  const d = D - 2 * t;
  return { A: Math.PI / 4 * (D ** 2 - d ** 2), Wel: Math.PI / 32 * (D ** 4 - d ** 4) / D, Wpl: (D ** 3 - d ** 3) / 6,
    Av: 2 / Math.PI * Math.PI / 4 * (D ** 2 - d ** 2) };
}
/** Square hollow section, corner radii neglected. */
export function shs(B, t) {
  const b = B - 2 * t;
  return { A: B ** 2 - b ** 2, Wel: (B ** 4 - b ** 4) / (6 * B), Wpl: (B ** 3 - b ** 3) / 4, Av: (B ** 2 - b ** 2) / 2 };
}

/** A member's capacity as stresses on a modelled square patch of side p. */
function memberOnPatch(section, grade, p) {
  const S = p ** 3 / 6, A = p * p, r3 = Math.sqrt(3);
  const bendElastic = grade.fy * section.Wel / S, bendFatal = grade.fu * section.Wpl / S;
  return {
    tensionElastic: bendElastic, tensionFatal: bendFatal,
    compressionElastic: bendElastic, compressionFatal: bendFatal,
    shearElastic: grade.fy / r3 * section.Av / A, shearFatal: grade.fu / r3 * section.Av / A,
  };
}
/** A sheet of real thickness t modelled as thickness T: the member's own strength in the
 * sheet's plane, scaled by t / T (its loads at rest are in-plane). */
function sheet(grade, t, T) {
  const k = t / T;
  return { tensionElastic: grade.fy * k, tensionFatal: grade.fu * k, compressionElastic: grade.fy * k, compressionFatal: grade.fu * k,
    shearElastic: grade.fy / Math.sqrt(3) * k, shearFatal: grade.fu / Math.sqrt(3) * k };
}
/** Fasteners along a line joint: shear and tension per fastener at spacing s, over a patch of width w. */
function lineFasteners(shear, tension, s, w, elasticRatio) {
  const a = s * w;
  return { tensionElastic: tension * elasticRatio / a, tensionFatal: tension / a,
    compressionElastic: null, compressionFatal: null,     // bearing: the members' own (left as authored)
    shearElastic: shear * elasticRatio / a, shearFatal: shear / a };
}
/** A counted fastener group over the total patch area of the joints it serves
 * (count: all the fasteners of all those joints). */
function groupFasteners(count, shear, tension, area, elasticRatio) {
  return { tensionElastic: count * tension * elasticRatio / area, tensionFatal: count * tension / area,
    compressionElastic: null, compressionFatal: null,
    shearElastic: count * shear * elasticRatio / area, shearFatal: count * shear / area };
}
const bolt = (size, grade = BOLT_8_8) => ({ shear: 0.6 * grade.fu * AS[size], tension: 0.9 * grade.fu * AS[size], elastic: grade.fy / grade.fu });

/** A timber screw or bolt in C24 (EN 1995-1-1): single-shear lateral (eq. 8.6f,
 * without rope effect) and withdrawal (eq. 8.38) or a given head pull-through. */
function timberDowel(d, fu, lef, pullThrough = Infinity) {
  const dm = d * 1000, fh = 0.082 * (1 - 0.01 * dm) * C24.rhok, My = 0.3 * fu / MPa * dm ** 2.6;     // MPa, N mm
  const lateral = 1.15 * Math.sqrt(2 * My * fh * dm);                                                  // N
  const lm = lef * 1000, fax = 0.52 * dm ** -0.5 * lm ** -0.1 * C24.rhok ** 0.8;                        // MPa
  const withdrawal = Math.min(fax * dm * lm * Math.min(dm / 8, 1), pullThrough);
  return { shear: lateral, tension: withdrawal, elastic: KMOD_PERMANENT };
}
const timberMember = { tensionElastic: KMOD_PERMANENT * C24.fm, tensionFatal: C24.fm, compressionElastic: KMOD_PERMANENT * C24.fc,
  compressionFatal: C24.fc, shearElastic: KMOD_PERMANENT * C24.fv, shearFatal: C24.fv, elasticModulus: C24.E };

// ------------------------------------------------------------ the props ---
// Each prop: members (node type -> density standing for the real part) and
// joints (node-type pair, in either order -> limits; '*' matches any type).
// p: the modelled patch side of square members (outdoor-props.mjs post radii).
function props() {
  // A steel member modelled as a solid p x p square: its real mass per length over that area.
  const steel = (section, p) => ({ density: section.A * STEEL_DENSITY / p ** 2 });
  const rack = chs(0.0483, 0.0032), signPost = chs(0.0761, 0.0032), billboardPost = chs(0.1143, 0.0063), shelter = shs(0.100, 0.005);
  const hydrantBarrel = shs(0.240, 0.015);
  const benchScrew = timberDowel(0.008, BOLT_8_8.fu, 0.035);
  const glassClamp = bolt('M8', BOLT_A2_70), shelterScrew = { shear: 8e3, tension: 0.45 * 0.0055 * 0.005 * STEEL.S355.fu, elastic: 0.8 };
  const roofScrew = timberDowel(0.006, 600 * MPa, 0.060, 10 * MPa * 0.012 ** 2), frameBolt = timberDowel(0.012, BOLT_8_8.fu, 0.140);
  const counterScrew = timberDowel(0.006, 600 * MPa, 0.060), boxScrew = timberDowel(0.005, 600 * MPa, 0.040);
  return {
    // Sheffield stands: 48.3 x 3.2 CHS, S275, root-fixed in the 350 mm concrete
    // footing (bearing over the embedment, ~0.85 fck D L^2 / 4.5 = 8 kN m for
    // C20/25, exceeds the tube's 1.3 kN m: the tube governs). Modelled 70 mm square.
    'bike-rack': {
      members: { support: steel(rack, 0.07), 'rack-arm': steel(rack, 0.07), 'rack-leg': steel(rack, 0.07) },
      joints: [[['*', '*'], memberOnPatch(rack, STEEL.S275, 0.07)]],
    },
    // A street-name / bus-stop sign: 76.1 x 3.2 CHS S235 post (110 mm modelled),
    // a 3 mm EN AW-5754 blank (30 mm modelled), held by two band clamps of two
    // M8 8.8 bolts each.
    'street-sign': {
      members: { support: steel(signPost, 0.11), sign: { density: ALUMINIUM.density * 0.003 / 0.030 } },
      joints: [[['sign', 'sign'], sheet(ALUMINIUM, 0.003, 0.030)],
        [['support', 'sign'], (area) => groupFasteners(4, bolt('M8').shear, bolt('M8').tension, area, bolt('M8').elastic)],
        [['*', '*'], memberOnPatch(signPost, STEEL.S235, 0.11)]],
    },
    // A poster board: two 114.3 x 6.3 CHS S355 posts (140 mm modelled), a
    // 4 mm aluminium-faced panel on an aluminium frame (~13 kg/m2, 50 mm modelled)
    // bolted to each post with four M12 8.8.
    billboard: {
      members: { support: steel(billboardPost, 0.14), 'billboard-post': steel(billboardPost, 0.14), 'advertising-panel': { density: 13 / 0.05 } },
      joints: [[['advertising-panel', 'advertising-panel'], sheet(ALUMINIUM, 0.004, 0.050)],
        [['billboard-post', 'advertising-panel'], (area) => groupFasteners(8, bolt('M12').shear, bolt('M12').tension, area, bolt('M12').elastic)],
        [['*', '*'], memberOnPatch(billboardPost, STEEL.S355, 0.14)]],
    },
    // A bus shelter: 100 x 100 x 5 SHS S355 posts and beams, welded (140 mm
    // modelled); a 3 mm aluminium roof (70 mm modelled) on 5.5 mm self-drilling
    // screws, two rows at 200 mm (pull-out from the 5 mm wall, EN 1993-1-3
    // Table 8.2: 0.45 d t fu); 10 mm toughened glass (50 mm modelled) in A2-70
    // M8 clamps every 0.5 m.
    'bus-shelter': {
      members: { support: steel(shelter, 0.14), 'cross-beam': steel(shelter, 0.14), roof: { density: ALUMINIUM.density * 0.003 / 0.070 },
        'shelter-glass': { density: 2500 * 0.010 / 0.050 } },
      joints: [[['roof', 'roof'], sheet(ALUMINIUM, 0.003, 0.070)],
        [['cross-beam', 'roof'], lineFasteners(shelterScrew.shear, shelterScrew.tension, 0.2, 0.07, shelterScrew.elastic)],
        [['shelter-glass', 'shelter-glass'], sheet({ fy: 120 * MPa, fu: 120 * MPa }, 0.010, 0.050)],
        [['support', 'shelter-glass'], lineFasteners(glassClamp.shear, glassClamp.tension, 0.5, 0.05, glassClamp.elastic)],
        [['cross-beam', 'shelter-glass'], lineFasteners(glassClamp.shear, glassClamp.tension, 0.5, 0.05, glassClamp.elastic)],
        [['*', '*'], memberOnPatch(shelter, STEEL.S355, 0.14)]],
    },
    // A market stall: 140 x 140 C24 posts and beams, beams bolted to the posts
    // with two M12 8.8; a 12 mm plywood roof (70 mm modelled) screwed every
    // 150 mm (6 mm screws, 12 mm heads pulling through at 10 MPa); a 22 mm
    // plywood counter (70 mm modelled) on two 6 mm screws a joint.
    'market-stall': {
      members: { support: { density: C24.density }, 'cross-beam': { density: C24.density }, 'counter-rail': { density: C24.density },
        roof: { density: 550 * 0.012 / 0.070 }, counter: { density: 550 * 0.022 / 0.070 } },
      joints: [[['roof', 'roof'], { ...sheet({ fy: KMOD_PERMANENT * 23 * MPa, fu: 23 * MPa }, 0.012, 0.070) }],
        [['counter', 'counter'], { ...sheet({ fy: KMOD_PERMANENT * 23 * MPa, fu: 23 * MPa }, 0.022, 0.070) }],
        [['cross-beam', 'roof'], lineFasteners(roofScrew.shear, roofScrew.tension, 0.15, 0.14, roofScrew.elastic)],
        [['support', 'cross-beam'], (area) => groupFasteners(2 * 4, frameBolt.shear, frameBolt.tension, area, frameBolt.elastic)],
        [['support', 'counter'], (area) => groupFasteners(2 * 2, counterScrew.shear, counterScrew.tension, area, counterScrew.elastic)],
        [['support', 'counter-rail'], (area) => groupFasteners(2 * 4, counterScrew.shear, counterScrew.tension, area, counterScrew.elastic)],
        [['counter-rail', 'counter'], (area) => groupFasteners(2 * 2, counterScrew.shear, counterScrew.tension, area, counterScrew.elastic)],
        [['*', '*'], timberMember]],
    },
    // A street light: a 114.3 x 4.0 CHS S355 column (EN 40-5's tubular
    // columns; 110 mm modelled) on a base plate with 4 M20 8.8 anchors, whose
    // group (~70 kN m) exceeds the tube (W_pl f_u ~ 20 kN m): the tube governs.
    // An LED luminaire (aluminium housing ~2 x 4 kg, a toughened 4 mm bowl
    // ~3 kg: lantern masses 5-15 kg) on a 60 mm spigot held by 2 M10 A2-70
    // grub screws; the bowl in the housing on 4 M6 A2-70 screws each side.
    streetlight: {
      members: { support: steel(chs(0.1143, 0.004), 0.11), 'lamp-base': { density: 4 / (0.6 * 0.07 * 0.6) },
        'lamp-cap': { density: 4 / (0.6 * 0.07 * 0.6) }, 'lamp-glass': { density: 3 / (0.44 * 0.33 * 0.44) } },
      joints: [[['support', 'lamp-base'], (area, n) => groupFasteners(2 * n, bolt('M10', BOLT_A2_70).shear, bolt('M10', BOLT_A2_70).tension, area, bolt('M10', BOLT_A2_70).elastic)],
        [['lamp-glass', 'lamp-glass'], sheet({ fy: 120 * MPa, fu: 120 * MPa }, 0.004, 0.22)],
        [['lamp-base', 'lamp-glass'], (area, n) => groupFasteners(4 * n / 4, bolt('M6', BOLT_A2_70).shear, bolt('M6', BOLT_A2_70).tension, area, bolt('M6', BOLT_A2_70).elastic)],
        [['lamp-glass', 'lamp-cap'], (area, n) => groupFasteners(4 * n / 4, bolt('M6', BOLT_A2_70).shear, bolt('M6', BOLT_A2_70).tension, area, bolt('M6', BOLT_A2_70).elastic)],
        [['*', '*'], memberOnPatch(chs(0.1143, 0.004), STEEL.S355, 0.11)]],
    },
    // A security bollard: 114.3 x 6.3 CHS S355 (110 mm modelled) cast 350 mm
    // into its footing; the embedment out-carries the tube, which governs.
    bollard: {
      members: { support: steel(chs(0.1143, 0.0063), 0.11) },
      joints: [[['*', '*'], memberOnPatch(chs(0.1143, 0.0063), STEEL.S355, 0.11)]],
    },
    // A park bench: a welded 40 x 40 x 3 SHS S235 frame (legs and back posts
    // 80 mm, seat rails 110 x 50 mm modelled), 45 mm timber slats (C24) each
    // held to each rail by 2 M8 coach screws.
    bench: {
      members: { support: steel(shs(0.04, 0.003), 0.08), 'seat-rail': { density: shs(0.04, 0.003).A * STEEL_DENSITY / (0.11 * 0.05) },
        'back-post': { density: shs(0.04, 0.003).A * STEEL_DENSITY / (0.08 * 0.06) }, 'seat-slat': { density: C24.density }, 'back-slat': { density: C24.density } },
      joints: [[['seat-slat', 'seat-rail'], (area, n) => groupFasteners(2 * n, benchScrew.shear, benchScrew.tension, area, benchScrew.elastic)],
        [['back-slat', 'back-post'], (area, n) => groupFasteners(2 * n, benchScrew.shear, benchScrew.tension, area, benchScrew.elastic)],
        [['seat-slat', 'seat-slat'], timberMember], [['back-slat', 'back-slat'], timberMember],
        [['*', '*'], memberOnPatch(shs(0.04, 0.003), STEEL.S235, 0.08)]],
    },
    // A planter and a low garden wall: clay-brick masonry in M5 mortar. Every
    // joint between masonry chunks is a mortar joint (materials.mjs
    // MORTAR_JOINT, EN 1996-1-1); compression the wall's characteristic
    // strength, f_k = K f_b^0.7 f_m^0.3 = 0.55 x 20^0.7 x 5^0.3 = 7.3 MPa
    // (EN 1996-1-1 eq. 3.2, group 1 clay units).
    planter: { members: {}, joints: [[['*', '*'], MASONRY_JOINT]] },
    'low-wall': { members: {}, joints: [[['*', '*'], MASONRY_JOINT]] },
    // A kerbside mailbox: 0.8 mm galvanised steel (DX51D, EN 10346: Re 140,
    // Rm 270 MPa) folded and riveted (25-35 mm modelled), on a C24 post, held by
    // four 5 mm screws.
    mailbox: {
      members: { base: { density: STEEL_DENSITY * 0.0008 / 0.025 }, side: { density: STEEL_DENSITY * 0.0008 / 0.025 },
        panel: { density: STEEL_DENSITY * 0.0008 / 0.025 }, lid: { density: STEEL_DENSITY * 0.0008 / 0.035 }, support: { density: C24.density } },
      joints: [[['support', 'support'], timberMember], [['foundation', 'support'], timberMember],
        [['support', 'base'], (area) => groupFasteners(4, boxScrew.shear, boxScrew.tension, area, boxScrew.elastic)],
        [['*', '*'], sheet({ fy: 140 * MPa, fu: 270 * MPa }, 0.0008, 0.025)]],
    },
    // A dry-barrel hydrant: EN-GJL-250 barrel (a 240 mm square of 15 mm wall),
    // integral cast outlets, bolted to its standpipe flange by six 5/8 in A307
    // bolts on a 190 mm circle (M = F sum(y^2)/y_max = 3 F r).
    hydrant: {
      members: { support: { density: 7200 * hydrantBarrel.A / 0.24 ** 2 } },
      joints: [[['foundation', 'support'], (() => { const F = 414 * MPa * AS['UNC-5/8'], M = 3 * F * 0.095, S = 0.24 ** 3 / 6;
          return { tensionElastic: 0.9 * M / S, tensionFatal: M / S, compressionElastic: null, compressionFatal: null, shearElastic: 0.6 * 6 * F * 0.6 / 0.0576, shearFatal: 6 * F * 0.6 / 0.0576 }; })()],
        [['*', '*'], { ...memberOnPatch(hydrantBarrel, { fy: 0.9 * 250 * MPa, fu: 250 * MPa }, 0.24) }]],
    },
  };
}

const LIMIT_KEYS = ['compressionElastic', 'compressionFatal', 'tensionElastic', 'tensionFatal', 'shearElastic', 'shearFatal'];
/** Real-capacity types: props without an entry are refused under the flag. */
export const REAL_PROP_TYPES = () => Object.keys(props());

/** Apply a prop's real members and joints to its built pack. Types without an
 * entry are returned unchanged. */
export function applyRealProp(pack, type) {
  const spec = props()[type === 'bus-sign' ? 'street-sign' : type];
  if (!spec) throw new Error(`VIBE_REAL_CAPACITIES: no real members and joints are authored for '${type}'`);
  const s = pack.scenario, table = pack.defaults.solver.materials, t = s.nodeTypes;
  for (const [i, node] of s.nodes.entries()) {
    const m = spec.members[t[i]];
    if (m && node.mass > 0) node.mass = Math.round(node.volume * m.density * 1e6) / 1e6;
  }
  const match = (a, b) => spec.joints.findIndex(([[x, y]]) => (x === '*' || x === a) && (y === '*' || y === b) || (x === '*' || x === b) && (y === '*' || y === a));
  const areas = new Map(), counts = new Map();
  for (const bond of s.bonds) { const k = match(t[bond.node0], t[bond.node1]); areas.set(k, (areas.get(k) ?? 0) + bond.area); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const made = new Map();
  for (const bond of s.bonds) {
    const k = match(t[bond.node0], t[bond.node1]);
    if (k < 0) continue;
    const key = `${k}:${bond.m}`;
    if (!made.has(key)) {
      const [[x, y], limits] = spec.joints[k], values = typeof limits === 'function' ? limits(areas.get(k), counts.get(k)) : limits;
      // residualAreaFraction 0: the damage-arrest ceiling (1/residual times the
      // pre-crack load) models cracked reinforced concrete; a steel member, a
      // bolt group, a screw line or a sheet has no reinforcement to arrest it
      // (FIDELITY_AUDIT C1: steel's 0.6 pinned these just under fatal).
      const material = { ...table[bond.m], name: `${type}-${x === '*' ? 'member' : `${x}-${y}`}-real`, residualAreaFraction: 0 };
      for (const key2 of LIMIT_KEYS) if (values[key2] != null) material[key2] = values[key2];
      if (values.elasticModulus) material.elasticModulus = values.elasticModulus;
      made.set(key, table.push(material) - 1);
    }
    bond.m = made.get(key);
  }
  return pack;
}

// ----------------------------------------------------------------- trees ---
// Clear wood, green (Wood Handbook FPL-GTR-282, Tables 5-3a/5-3b): modulus of
// rupture, compression and shear parallel to grain, MOE. A living stem bends:
// its fibres fail at the modulus of rupture (tension and compression fatal);
// the compression side yields at the crushing strength (compression elastic);
// tension elastic at the fibre stress at proportional limit, ~0.6 MOR.
const GREEN_WOOD = {
  shade: { species: 'northern red oak', mor: 57, compression: 23.7, shear: 8.3, moe: 9.3 },
  ornamental: { species: 'black cherry', mor: 55, compression: 24.4, shear: 7.8, moe: 9.0 },
  street: { species: 'American sycamore', mor: 45, compression: 20.1, shear: 6.9, moe: 7.3 },
  sapling: { species: 'red maple', mor: 53, compression: 22.6, shear: 7.9, moe: 9.6 },
  conifer: { species: 'eastern white pine', mor: 34, compression: 16.8, shear: 4.7, moe: 6.8 },
};
export function greenWood(family) {
  const w = GREEN_WOOD[family] ?? GREEN_WOOD.shade;
  // residual 0: wood has no reinforcement to arrest its damage (FIDELITY_AUDIT C1).
  return { tensionElastic: 0.6 * w.mor * MPa, tensionFatal: w.mor * MPa, compressionElastic: w.compression * MPa, compressionFatal: w.mor * MPa,
    shearElastic: 0.6 * w.shear * MPa, shearFatal: w.shear * MPa, elasticModulus: w.moe * 1e9, residualAreaFraction: 0, species: w.species };
}

// ------------------------------------------------------------ masonry ---
const MASONRY_FK = 0.55 * 20 ** 0.7 * 5 ** 0.3 * MPa;   // EN 1996-1-1 eq. 3.2: clay group 1, f_b 20, M5
const MASONRY_JOINT = { ...MORTAR_JOINT, compressionElastic: KMOD_PERMANENT * MASONRY_FK, compressionFatal: MASONRY_FK };

// -------------------------------------------------------------- furniture ---
/**
 * A glued joint in furniture (a chair's mortise and tenon, a table's leg into
 * its top): the glue line governs, PVAc of EN 204 durability class D3, lap
 * shear >= 10 MPa (EN 205 test), taken over the joint's own patch; elastic
 * 0.6 of it as every timber connection here. Replaces the kit's uncited
 * furniture-joinery (0.1 MPa), the chair's x0.5 and the cafe table's x0.02
 * (FIDELITY_AUDIT D5).
 */
export const GLUED_JOINT = { tensionElastic: KMOD_PERMANENT * 10 * MPa, tensionFatal: 10 * MPa,
  shearElastic: KMOD_PERMANENT * 10 * MPa, shearFatal: 10 * MPa, residualAreaFraction: 0 };

// ----------------------------------------------------- legacy un-doubling ---
/**
 * The Blast authoring table (blast-stress-solver structures/lib/materials.mjs)
 * "roughly doubled" its timber and masonry elastic limits to survive the
 * capped bending gain (FIDELITY_AUDIT D1). With real sections that doubles
 * the strength twice. Under the flag, materials carrying those exact legacy
 * limits take characteristic values (the kit's convention: fatal f_k,
 * elastic 0.6 f_k): timber clones become C24 (EN 338); brick and stone keep
 * their units' tension and shear (their joints are mortar joints, cited) and
 * take the masonry's characteristic compression (EN 1996-1-1 eq. 3.2: clay
 * K 0.55 f_b 20 -> 7.3 MPa; natural stone K 0.45 f_b 50 -> 11.3 MPa).
 * Returns the names changed.
 */
const LEGACY = {
  timber: [36e6, 90e6, 14.4e6, 36e6, 10.08e6, 25.2e6],
  brick: [16e6, 40e6, 1.76e6, 4.4e6, 3.52e6, 8.8e6],
  stone: [34e6, 102e6, 3.06e6, 9.18e6, 6.12e6, 18.36e6],
};
const same = (m, v) => LIMIT_KEYS.every((k, i) => Math.abs((m[k] ?? NaN) - v[i]) <= 1e-6 * v[i]);
export function characteristicLegacy(table) {
  const changed = [];
  const stoneFk = 0.45 * 50 ** 0.7 * 5 ** 0.3 * MPa;
  for (const m of table) {
    if (same(m, LEGACY.timber)) {
      for (const k of LIMIT_KEYS) m[k] = KIT_C24[k];
      m.elasticModulus = KIT_C24.elasticModulus; m.residualAreaFraction = 0; changed.push(m.name);
    } else if (same(m, LEGACY.brick) && /brick|masonry/.test(m.name)) {
      m.compressionFatal = MASONRY_FK; m.compressionElastic = KMOD_PERMANENT * MASONRY_FK; m.residualAreaFraction = 0; changed.push(m.name);
    } else if (same(m, LEGACY.stone) && m.name === 'stone') {
      m.compressionFatal = stoneFk; m.compressionElastic = KMOD_PERMANENT * stoneFk; m.residualAreaFraction = 0; changed.push(m.name);
    }
  }
  return changed;
}
