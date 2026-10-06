// What a driven course measured (client/native/films/turning.mjs captions
// and log; the node simulations): cones hit, lateral g, path error, the
// radius and g held on each segment of a circle, the time. Pure: fed the
// car's state every frame.

/** A circle through points [[x, z], ...], least squares (Kasa): { cx, cz, R }. */
export function fitCircle(points) {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0, mz = 0;
  for (const [x, z] of points) { mx += x; mz += z; }
  mx /= n; mz /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, z] of points) {
    const u = x - mx, v = z - mz;
    suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const a = suu, b = suv, c = suv, d = svv, e = (suuu + suvv) / 2, f = (svvv + svuu) / 2;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) return null;
  const uc = (e * d - b * f) / det, vc = (a * f - c * e) / det;
  return { cx: uc + mx, cz: vc + mz, R: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/**
 * Is a cone at (cx, cz) inside the truck's footprint (half length hl, half
 * width hw, about its reference point, heading psi), grown by the cone's
 * half size?
 */
export function coneInFootprint(st, cx, cz, { hl, hw, cone }) {
  const dx = cx - st.p[0], dz = cz - st.p[2];
  const fwd = dx * Math.sin(st.psi) + dz * Math.cos(st.psi), lat = dx * Math.cos(st.psi) - dz * Math.sin(st.psi);
  return Math.abs(fwd) <= hl + cone && Math.abs(lat) <= hw + cone;
}

/** The nearest a cone comes to the footprint's edge (m; negative inside). */
export function coneClearance(st, cx, cz, { hl, hw, cone }) {
  const dx = cx - st.p[0], dz = cz - st.p[2];
  const fwd = Math.abs(dx * Math.sin(st.psi) + dz * Math.cos(st.psi)) - hl, lat = Math.abs(dx * Math.cos(st.psi) - dz * Math.sin(st.psi)) - hw;
  const out = Math.hypot(Math.max(0, fwd), Math.max(0, lat));
  return (out > 0 ? out : Math.max(fwd, lat)) - cone;
}

/**
 * A meter for one episode: { cones: [[x, z]], circle: { segments: [{ s0, s1,
 * label }] } (arc length on leg 0), timing: { from, to } (z lines, north),
 * gate: { x, z, psi, half } }. sample(st, t, { leg, s, e }) every frame;
 * result() the summary.
 */
export function createMeter(ep, { hl = 2.45, hw = 1.5, cone = 0.16 } = {}) {
  const hit = new Set(), firstHit = [], touched = new Set();
  let awakeBefore = null;
  const cones = ep.cones ?? [];
  let minClear = Infinity, errSq = 0, errN = 0, errMax = 0, maxLat = 0, latWin = [], t0 = null, t1 = null, last = null, gatePassed = null;
  const seg = (ep.circle?.segments ?? []).map((g) => ({ ...g, pts: [], lat: [], speed: [], err: [] }));
  return {
    sample(st, t, { leg = 0, s = null, e = null, tracking = true, awake = null } = {}) {
      // Physics' own word: a cone the truck touched wakes up (the scene is
      // otherwise asleep). When the awake count rises, the nearest cone within
      // a metre of the footprint is the one it touched.
      if (awake != null) {
        if (awakeBefore != null && awake > awakeBefore) {
          let best = null;
          for (let i = 0; i < cones.length; i += 1) {
            if (touched.has(i)) continue;
            const c = coneClearance(st, cones[i][0], cones[i][1], { hl, hw, cone });
            if (c < 1.0 && (!best || c < best.c)) best = { i, c };
          }
          if (best) touched.add(best.i);
        }
        awakeBefore = awake;
      }
      for (let i = 0; i < cones.length; i += 1) {
        const [cx, cz] = cones[i];
        if (Math.abs(cx - st.p[0]) > 8 || Math.abs(cz - st.p[2]) > 8) continue;
        const c = coneClearance(st, cx, cz, { hl, hw, cone });
        minClear = Math.min(minClear, c);
        if (c <= 0 && !hit.has(i)) { hit.add(i); firstHit.push({ cone: i, t: +t.toFixed(2) }); }
      }
      if (tracking && e != null) { errSq += e * e; errN += 1; errMax = Math.max(errMax, Math.abs(e)); }
      // Lateral acceleration: the change of the velocity across its direction
      // over 0.1 s (v x yaw rate overstates it in a slide).
      latWin.push([t, st.v[0], st.v[2]]); if (latWin.length > 7) latWin.shift();
      if (latWin.length === 7) {
        const [ta, ax, az] = latWin[0], [tb, bx, bz] = latWin[6], dt = tb - ta;
        const sp = Math.hypot(bx + ax, bz + az) / 2;
        if (dt > 0 && sp > 1) maxLat = Math.max(maxLat, Math.abs(((bx - ax) * (bz + az) - (bz - az) * (bx + ax)) / 2 / sp / dt));
      }
      if (leg === 0 && s != null) for (const g of seg) if (s >= g.s0 && s < g.s1) { g.pts.push([st.p[0], st.p[2]]); g.lat.push(Math.abs(st.vf * st.w[1])); g.speed.push(st.vf); if (e != null) g.err.push(e * e); }
      if (ep.timing) {
        if (t0 == null && st.p[2] >= ep.timing.from) t0 = t;
        if (t1 == null && st.p[2] >= ep.timing.to) t1 = t;
      } else {
        if (t0 == null && st.speed > 0.3) t0 = t;
      }
      if (ep.gate && gatePassed == null && last) {
        const { x, z, psi, half } = ep.gate, along = (q) => (q[0] - x) * Math.sin(psi) + (q[2] - z) * Math.cos(psi);
        if (along(last.p) < 0 && along(st.p) >= 0) {
          const lat = (st.p[0] - x) * Math.cos(psi) - (st.p[2] - z) * Math.sin(psi);
          gatePassed = { offset: +lat.toFixed(2), clean: Math.abs(lat) + hw <= half };
        }
      }
      last = st;
    },
    finish(t) { if (t1 == null && !ep.timing) t1 = t; },
    result() {
      const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      return {
        conesHit: hit.size, conesTouched: awakeBefore == null ? null : touched.size, cones: cones.length, firstHits: firstHit.slice(0, 6), minConeClearance: Number.isFinite(minClear) ? +minClear.toFixed(2) : null,
        pathRms: errN ? +Math.sqrt(errSq / errN).toFixed(3) : null, pathMax: +errMax.toFixed(2), maxLatG: +(maxLat / 9.81).toFixed(3),
        seconds: t0 != null && t1 != null ? +(t1 - t0).toFixed(2) : null, gate: gatePassed,
        segments: seg.map((g) => {
          const c = fitCircle(g.pts.filter((_, k) => k % 3 === 0));
          return { label: g.label, radius: c ? +c.R.toFixed(1) : null, pathRms: g.err.length ? +Math.sqrt(mean(g.err)).toFixed(2) : null, latG: g.lat.length ? +(mean(g.lat) / 9.81).toFixed(3) : null, speed: g.speed.length ? +mean(g.speed).toFixed(2) : null };
        }),
      };
    },
  };
}
