// A calibration scenario on film (structures/calibration): each case's
// structure framed from its own bounding box, filmed from tick 0, captioned
// with the hand calculation's prediction and then what the engine did,
// measured live during the take. structures/calibration/film/reel.sh films an
// overview and every case as its own take and splices them:
//
//   structures/calibration/film/reel.sh bridge-piers
//
// One take by hand (CALIB_CASE: a case id, or `overview` for every case side
// by side; CALIB_SCENE the scene the app loads -- the scenario's scene.json
// for the overview, one case alone (reel.sh writes it) for a case):
//
//   CALIB_SCENE=structures/calibration/out/bridge-piers/scene.json VIBE_SECTION_BENDING=1 \
//   FILM_DEFINES='--define:CALIB_SCENARIO="bridge-piers" --define:CALIB_CASE="overview"' \
//     scripts/native-mac.sh film calibration --scene calib
//
// Defines (FILM_DEFINES):
//   CALIB_SCENARIO  the scenario id (default bridge-piers)
//   CALIB_CASE      `overview` (default) or a case id
//   CALIB_SCENE_CASES  the cases the loaded scene holds, a comma list (default:
//                   the case alone for a case take, every case for the overview):
//                   case-scene.mjs keeps their nodes in spec order, so chunk k
//                   is the k-th of their nodes; one case alone, and the scene's
//                   broken bonds are that case's own; `all`: the whole scenario
//   CALIB_CONFIG    the engine configuration filmed, for captions and the
//                   verdict fallback: section (default), default or rotation
//                   (its env -- VIBE_SECTION_BENDING=1 for section -- is the caller's)
//   CALIB_FREEZE    seconds the first frame is held, captioned, before the
//                   structure moves (reel.sh pads the recording): the intro
//                   captions are logged as `freeze {json}`; 0 puts them over
//                   the moving picture
//   CALIB_ONLY      the overview's cases, a comma list (default: every case)
//   CALIB_DIR       the scenario's directory relative to client/dist-native
//                   (default ../../structures/calibration/out/<scenario>)
//
// What it reads (the contract with structures/calibration; nothing else):
//   spec.json      title; criteria.{holdsMaxDrop, collapseMinDrop} (metres);
//                  cases[]: id, label, nodes [from, to) and bonds [from, to)
//                  (index ranges into scene.json), bondKeys (names of the case's
//                  bonds, in order), predictions.real.{state: holds|collapses|either,
//                  u, worst (a bond key), bonds {key: u}}
//                  Optional camera hints, per scenario (spec.camera) or per
//                  case (case.camera, which wins): { bearing, elevation, fov }
//                  for the wide shot (bearing: degrees, 0 looks from +z, 90
//                  from +x; default square to the long side, from -z/-x),
//                  focus: { min, max } (world box) for the close shot (default:
//                  the bonds the hand calculation works hardest), and
//                  closeBearing / closeElevation.
//   scene.json     the scene pack: node centroids, sizes and masses (mass 0 =
//                  an anchor, which locates the scene in the world), bond centroids
//   verdict.json   (optional) configs[CALIB_CONFIG].cases[]: { case, measured:
//                  { state, broken, maxDrop } } -- the GPU test's numbers,
//                  used where the take cannot measure (bonds per case in the overview)
//
// Measured live: broken bonds (the scene's, when it holds the case alone) and
// how far the case's chunks came down (each chunk's drawn height against its
// authored centroid, from the drawn-world sample; the anchors give the
// offset). The log has a `calib {json}` line per measurement for the report.
/* global CALIB_SCENARIO, CALIB_CASE, CALIB_SCENE_CASES, CALIB_CONFIG, CALIB_FREEZE, CALIB_ONLY, CALIB_DIR */
import { boot, hold, path } from '../film/film.mjs';
import { nodesBox, criticalBox, union, padded, size, fit, sideBearing } from './calibration-frame.mjs';

const SCENARIO = typeof CALIB_SCENARIO === 'string' && CALIB_SCENARIO ? CALIB_SCENARIO : 'bridge-piers';
const CASE = typeof CALIB_CASE === 'string' && CALIB_CASE ? CALIB_CASE : 'overview';
// `all`: the scenario's whole scene.
const SCENE_CASES = typeof CALIB_SCENE_CASES === 'string' && CALIB_SCENE_CASES ? CALIB_SCENE_CASES.split(',').map((x) => x.trim()) : null;
const CONFIG = typeof CALIB_CONFIG === 'string' && CALIB_CONFIG ? CALIB_CONFIG : 'section';
const FREEZE = typeof CALIB_FREEZE === 'number' ? CALIB_FREEZE : 0;
const ONLY = typeof CALIB_ONLY === 'string' && CALIB_ONLY ? CALIB_ONLY.split(',').map((x) => x.trim()) : null;
const DIR = typeof CALIB_DIR === 'string' && CALIB_DIR ? CALIB_DIR : `../../structures/calibration/out/${SCENARIO}`;

const ENGINE = {
  section: 'section bending',
  default: 'the default stage',
  rotation: 'section bending and rotational stiffness',
}[CONFIG] ?? CONFIG;
const STATE = { holds: 'holds', collapses: 'collapses', either: 'could go either way' };
const fmtU = (u) => (u >= 10 ? u.toFixed(1) : u.toFixed(2));
const metres = (m) => (m >= 0.1 ? `${m.toFixed(1)} m` : `${Math.round(m * 1000)} mm`);

const readJson = async (file, optional = false) => {
  try { return JSON.parse(await (await fetch(`file://${file}`)).text()); } catch (error) {
    if (optional) return null;
    throw new Error(`cannot read ${file}: ${error?.message ?? error}`);
  }
};

/**
 * How far one case's chunks have come down: each chunk's last drawn height
 * against its authored centroid (the drawn-world sample is a rotating subset,
 * so each chunk keeps the height it was last drawn at). The anchors (mass 0)
 * never move: their drawn height less their centroid's is the scene's offset.
 */
/**
 * The scene's chunk -> the spec's node: the scene holds `held` (case objects,
 * or null for the whole scenario), their nodes in spec order.
 */
function slotMap(held) {
  if (!held) return null;
  const map = [];
  for (const c of [...held].sort((a, b) => a.nodes[0] - b.nodes[0])) for (let n = c.nodes[0]; n < c.nodes[1]; n += 1) map.push(n);
  return map;
}

function dropMeter(scenario, c, slots) {
  const [from, to] = c.nodes;
  const last = new Map(), anchorOffsets = new Map();
  return {
    take(city) {
      city.slots.forEach((slot, i) => {
        const node = slots ? slots[slot] : slot;
        if (node == null || node < from || node >= to) return;
        const y = city.positions[3 * i + 1], ref = scenario.nodes[node].centroid.y;
        if (scenario.nodes[node].mass === 0) anchorOffsets.set(node, y - ref);
        else last.set(node, y - ref);
      });
    },
    /** { drop: the largest, fallen: chunks down by more than `fall` m, seen, offset }. */
    read(fall) {
      const offsets = [...anchorOffsets.values()];
      const offset = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
      let drop = 0, fallen = 0;
      for (const dy of last.values()) { const d = offset - dy; drop = Math.max(drop, d); if (d > fall) fallen += 1; }
      return { drop, fallen, seen: last.size, offset };
    },
  };
}

/** What the engine did, from the live drop and broken bonds (judge.mjs's states, less `free`, which needs the bond graph). */
function outcome({ broken, drop }, criteria) {
  if (drop >= criteria.collapseMinDrop) return 'collapses';
  if (broken > 0) return drop > criteria.holdsMaxDrop ? 'damaged' : 'fractured';
  return drop <= criteria.holdsMaxDrop ? 'holds' : 'damaged';
}

function engineLine(m) {
  // Bonds per case are only counted live in a scene of that case alone; else the GPU test's.
  const bonds = `${m.broken} bond${m.broken === 1 ? '' : 's'} broken${m.brokenFrom === 'verdict' ? ' (GPU test)' : ''}`;
  switch (m.state) {
    case 'collapses': return `Engine: collapses -- ${bonds}, ${m.fallen} chunks down, fell ${metres(m.drop)}`;
    case 'fractured': return `Engine: ${bonds}, but nothing fell${m.drop >= 0.001 ? ` (largest drop ${metres(m.drop)})` : ''}`;
    case 'holds': return `Engine: holds -- no bond broken${m.drop >= 0.001 ? `, sags ${metres(m.drop)}` : ''}`;
    default: return `Engine: ${bonds}, moved ${metres(m.drop)}`;
  }
}

/** The engine against the hand calculation, in a line or two. */
function verdictLine(c, m) {
  const p = c.predictions?.real ?? {};
  if (p.state === 'collapses' && m.state === 'fractured') return 'Broken into a mechanism, jammed between the supports:\nrigid chunks arch -- an engine gap';
  if (p.state === 'either') return `The hand calculation is borderline (u = ${fmtU(p.u)}); the engine ${STATE[m.state] ?? m.state}`;
  if (p.state === m.state) return `Agrees with the hand calculation: ${STATE[m.state]}`;
  if (p.state === 'holds') return `Disagrees: the hand calculation says it holds (u = ${fmtU(p.u)})`;
  return `Disagrees: the hand calculation says it collapses (u = ${fmtU(p.u)}); the engine ${STATE[m.state] ?? m.state}`;
}

const predictionLine = (c) => {
  const p = c.predictions?.real;
  return p ? `Hand calculation: u = ${fmtU(p.u)} -> ${STATE[p.state] ?? p.state}` : 'No hand calculation';
};

/** A caption cue (post.py `caption`): `seconds` long from `lead` after the cue. */
const caption = (text, seconds, lead = 0.2) => (ctx) => ctx.edit({ type: 'title', style: 'caption', text, from: ctx.t + lead, to: ctx.t + lead + seconds });

/**
 * The intro captions: over the first frame, held FREEZE seconds before the
 * structure moves (logged for reel.sh, which pads the recording and puts
 * them in), or over the opening seconds when nothing is frozen.
 */
function intro(lines, seconds) {
  if (FREEZE > 0) {
    return [[0, (ctx) => ctx.log(`freeze ${JSON.stringify({ seconds: FREEZE, captions: lines.map((text, k) => ({ text, from: (k * FREEZE) / lines.length + 0.25, to: ((k + 1) * FREEZE) / lines.length - 0.1 })) })}`)]];
  }
  const each = seconds / lines.length;
  return lines.map((text, k) => [k * each, caption(text, each - 0.3)]);
}

/**
 * The shot, calling `fn(ctx)` whenever its pose is asked for: every film
 * frame (and when the film checks its camera before rolling) -- a meter that
 * cues would fill the log with a line a frame.
 */
/** The lens for a move between fitted poses: the widest of them. */
const lens = (...poses) => Math.max(...poses.map((p) => p.fov));

function sampled(shot, fn) {
  const build = shot.build;
  return { ...shot, build: (ctx) => { const pose = build(ctx); return (t) => { fn(ctx); return pose(t); }; } };
}

function caseTake({ spec, scenario, verdict, c, held }) {
  const criteria = spec.criteria ?? { holdsMaxDrop: 0.02, collapseMinDrop: 1 };
  const hints = { ...(spec.camera ?? {}), ...(c.camera ?? {}) };
  const box = nodesBox(scenario, c.nodes);
  const side = hints.bearing ?? sideBearing(box) + 40;
  const fov = hints.fov ?? 40;
  const along = size(box)[0] >= size(box)[2] ? 0 : 2;
  // The close shot: where the hand calculation works it hardest, a few metres
  // either way along the structure, its whole height and width.
  const crit = hints.focus ?? criticalBox(scenario, c);
  const focus = crit ? { min: [...box.min], max: [...box.max] } : box;
  if (crit) {
    const reach = Math.max(8, 0.12 * size(box)[along]);
    focus.min[along] = Math.max(box.min[along], crit.min[along] - reach);
    focus.max[along] = Math.min(box.max[along], crit.max[along] + reach);
  }
  const meter = dropMeter(scenario, c, slotMap(held));
  const fromVerdict = verdict?.configs?.[CONFIG]?.cases?.find((r) => r.case === c.id)?.measured ?? null;
  const measure = (ctx, when) => {
    const d = meter.read(criteria.collapseMinDrop);
    const live = held?.length === 1;
    const broken = live ? (ctx.e2e.snapshot()?.city?.brokenBonds ?? 0) : (fromVerdict?.broken ?? 0);
    const m = { ...d, broken, brokenFrom: live ? 'live' : 'verdict' };
    if (!d.seen && fromVerdict) Object.assign(m, { drop: fromVerdict.maxDrop, fallen: fromVerdict.fallen ?? 0, dropFrom: 'verdict' });
    m.state = outcome(m, criteria);
    ctx.log(`calib ${JSON.stringify({ case: c.id, when, t: +ctx.t.toFixed(2), ...m, drop: +m.drop.toFixed(3), offset: +m.offset.toFixed(3), predicted: c.predictions?.real?.state, u: c.predictions?.real?.u, verdict: fromVerdict ? { state: fromVerdict.state, broken: fromVerdict.broken, maxDrop: fromVerdict.maxDrop } : null })}`);
    return m;
  };
  const sample = (ctx) => { const city = ctx.e2e.drawnWorld?.()?.city; if (city) meter.take(city); };

  const WIDE = 7, CLOSE = 6.5;
  // Among the other cases (a scene of more than this one), from high enough to
  // see this one's foot over the top of the case in front of it (the nearest
  // on the camera's side, the -z or -x side).
  const crowded = !held || held.length > 1;
  const across = along === 0 ? 2 : 0;
  const inFront = crowded ? (held ?? spec.cases).filter((x) => x.id !== c.id).map((x) => nodesBox(scenario, x.nodes))
    .filter((b) => b.max[across] <= box.min[across] + 0.01).sort((a, b) => b.max[across] - a.max[across])[0] : null;
  const over = inFront ? Math.min(55, Math.max(24, (Math.atan2(Math.max(0, inFront.max[1]) + 1, Math.max(1, box.min[across] - inFront.max[across])) * 180) / Math.PI + 3)) : null;
  const elevation = hints.elevation ?? over ?? 8, closeElevation = hints.closeElevation ?? (over != null ? over + 2 : 12);
  const wideA = fit(box, { bearing: side - 4, elevation, fov, margin: 0.92 });
  const wideB = fit(box, { bearing: side + 6, elevation: elevation + 3, fov, margin: 0.86 });
  const closeBearing = hints.closeBearing ?? sideBearing(box) - 40;
  const closeA = fit(focus, { bearing: closeBearing + 6, elevation: closeElevation, fov: 45, margin: 1.15 });
  const closeB = fit(focus, { bearing: closeBearing - 6, elevation: closeElevation + 3, fov: 45, margin: 1.05 });
  const lines = [`${c.label}\n${predictionLine(c)}`];
  return [
    sampled(path([wideA, wideB], WIDE, {
      name: `${c.id}-wide`, fov: lens(wideA, wideB), ease: 'out',
      cues: [
        ...(FREEZE > 0 ? intro(lines, 0) : []),
        [0, caption(FREEZE > 0 ? `Engine (${ENGINE}), from the first tick` : lines[0], 3.4)],
        [3.9, (ctx) => caption(engineLine(measure(ctx, 'wide')), WIDE - 4.0, 0)(ctx)],
      ],
    }), sample),
    sampled(path([closeA, closeB], CLOSE, {
      name: `${c.id}-close`, fov: lens(closeA, closeB),
      cues: [
        [0.1, (ctx) => {
          const m = measure(ctx, 'close');
          caption(verdictLine(c, m), CLOSE - 0.5, 0.1)(ctx);
        }],
        [CLOSE - 0.15, (ctx) => { measure(ctx, 'end'); }],
      ],
    }), sample),
  ];
}

function overviewTake({ spec: full, scenario, verdict, held }) {
  const spec = ONLY ? { ...full, cases: full.cases.filter((c) => ONLY.includes(c.id)) } : full;
  if (!spec.cases.length) throw new Error(`CALIB_ONLY ${ONLY}: no such cases`);
  const criteria = spec.criteria ?? { holdsMaxDrop: 0.02, collapseMinDrop: 1 };
  const boxes = spec.cases.map((c) => nodesBox(scenario, c.nodes));
  const all = union(boxes);
  const hints = spec.camera ?? {};
  const side = hints.bearing ?? sideBearing(boxes[0]) + 18;
  // The opening: every case at once, low and from the corner (the app's far
  // plane is 200 m, and a high camera sees past it into a black lower sky).
  const oside = hints.overviewBearing ?? sideBearing(boxes[0]) + 65;
  const slots = slotMap(held);
  const meters = spec.cases.map((c) => dropMeter(scenario, c, slots));
  const sample = (ctx) => { const city = ctx.e2e.drawnWorld?.()?.city; if (city) for (const m of meters) m.take(city); };
  const OPEN = 7, MOVE = 1.3, STAY = 3.4;
  const wideA = fit(all, { bearing: oside - 4, elevation: 12, fov: 45 });
  const wideB = fit(all, { bearing: oside + 4, elevation: 15, fov: 45, margin: 0.92 });
  const n = spec.cases.length;
  const shots = [sampled(path([wideA, wideB], OPEN, {
    name: 'overview-wide', fov: lens(wideA, wideB), ease: 'out',
    cues: [
      ...intro([spec.title?.replace(/^Calibration:\s*/, '') ?? SCENARIO, `${n} cases side by side: the hand calculation against the engine (${ENGINE})`], 6.6),
      ...(FREEZE > 0 ? [[0, caption(`All ${n} at once, from the first tick`, OPEN - 0.5)]] : []),
    ],
  }), sample)];
  let from = wideB;
  spec.cases.forEach((c, k) => {
    const at = fit(padded(boxes[k], [2, 0, 2]), { bearing: side + 4, elevation: 38, fov: 40, margin: 0.95 });
    const fromVerdict = verdict?.configs?.[CONFIG]?.cases?.find((r) => r.case === c.id)?.measured ?? null;
    shots.push(sampled(path([from, at], MOVE, { name: `overview-to-${c.id}`, fov: lens(from, at) }), sample));
    shots.push(sampled(hold(at, STAY, {
      name: `overview-${c.id}`, fov: at.fov,
      cues: [
        [0, (ctx) => {
          const d = meters[k].read(criteria.collapseMinDrop);
          const m = { ...d, broken: fromVerdict?.broken ?? 0, brokenFrom: 'verdict' };
          m.state = outcome(m, criteria);
          ctx.log(`calib ${JSON.stringify({ case: c.id, when: 'overview', t: +ctx.t.toFixed(2), ...m, drop: +m.drop.toFixed(3), offset: +m.offset.toFixed(3), predicted: c.predictions?.real?.state, verdict: fromVerdict ? { state: fromVerdict.state, broken: fromVerdict.broken, maxDrop: fromVerdict.maxDrop } : null })}`);
          const p = c.predictions?.real;
          const engine = m.state === 'collapses' ? `collapses (fell ${metres(m.drop)})`
            : m.state === 'fractured' ? 'breaks, but nothing falls (jammed)'
              : m.state === 'holds' ? 'holds' : `damaged (moved ${metres(m.drop)})`;
          caption(`${c.label}\nHand calc u = ${p ? fmtU(p.u) : '?'} -> ${p ? STATE[p.state] ?? p.state : '?'} · engine: ${engine}`, STAY - 0.3, 0.1)(ctx);
        }],
      ],
    }), sample));
    from = at;
  });
  return shots;
}

try {
  const spec = await readJson(`${DIR}/spec.json`);
  const scenario = (await readJson(`${DIR}/scene.json`)).scenario;
  const verdict = await readJson(`${DIR}/verdict.json`, true);
  const c = CASE === 'overview' ? null : spec.cases.find((x) => x.id === CASE);
  if (CASE !== 'overview' && !c) throw new Error(`no case ${CASE} in ${DIR}/spec.json (cases: ${spec.cases.map((x) => x.id).join(', ')})`);
  // From tick 0: a case with its supports out starts to fail on its first tick.
  const film = await boot({ scene: 'calib', settle: 0 });
  const chunks = film.e2e.snapshot()?.city?.chunksTotal ?? 0;
  const ids = SCENE_CASES?.[0] === 'all' ? null : SCENE_CASES ?? (c ? [c.id] : null);
  const held = ids ? ids.map((id) => spec.cases.find((x) => x.id === id) ?? (() => { throw new Error(`CALIB_SCENE_CASES: no case ${id}`); })()) : null;
  const expected = held ? held.reduce((n, x) => n + x.nodes[1] - x.nodes[0], 0) : scenario.nodes.length;
  film.log(`calib ${SCENARIO} ${CASE} (${CONFIG}; scene: ${ids ? ids.join(', ') : 'every case'}): ${chunks} chunks in the scene, ${expected} expected${chunks !== expected ? ' -- WARNING: the scene is not the one the spec describes' : ''}`);
  await film.play(c ? caseTake({ spec, scenario, verdict, c, held }) : overviewTake({ spec, scenario, verdict, held }), { settle: 0 });
} catch (error) {
  console.log(`[film] FAILED: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
}
