/**
 * Linear-elastic plane frame analysis (the direct stiffness method), the
 * calibration structures' hand calculation made reproducible: what an
 * engineer would do with moment distribution or a frame program. Euler-
 * Bernoulli members, rigid joints unless released, loads at the nodes and
 * uniformly distributed along members (self-weight), supports fixed in any of
 * ux, uy, rz. Units SI (N, m, Pa).
 *
 *   const f = frame();
 *   const a = f.node(0, 0), b = f.node(10, 0);
 *   f.member(a, b, {E: 34e9, A: 5.6, I: 0.229, w: 140e3});   // w: N/m, downward (global -y)
 *   f.fix(a, 'xyz'); f.fix(b, 'y');
 *   const r = f.solve();   // r.moment(memberIndex, s) at s metres from its start, r.reactions, ...
 *
 * Sign convention of results: N tension positive; M sagging positive for a
 * member drawn left to right (bottom fibre in tension). Shear V by the usual
 * beam convention (dM/ds = V).
 */
export function frame() {
  const nodes = [], members = [], fixed = new Map(), loads = new Map();
  return {
    nodes, members,
    node(x, y) { nodes.push({ x, y }); return nodes.length - 1; },
    /** {E, A, I, w (N/m downward, global), q (N/m along local -y), release: [startMoment, endMoment]} */
    member(i, j, p) { members.push({ i, j, w: 0, q: 0, release: [false, false], ...p }); return members.length - 1; },
    fix(n, dofs = 'xyz') { const s = fixed.get(n) ?? new Set(); for (const d of dofs) s.add('xyz'.indexOf(d)); fixed.set(n, s); },
    load(n, fx = 0, fy = 0, mz = 0) { const l = loads.get(n) ?? [0, 0, 0]; l[0] += fx; l[1] += fy; l[2] += mz; loads.set(n, l); },
    solve() { return solve(nodes, members, fixed, loads); },
  };
}

function geometry(nodes, m) {
  const a = nodes[m.i], b = nodes[m.j], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  return { L, c: dx / L, s: dy / L };
}

/** Local stiffness (6x6) with optional moment releases (static condensation). */
function localStiffness(m, L) {
  const { E, A, I } = m, k = Array.from({ length: 6 }, () => new Float64Array(6));
  const a = E * A / L, b = 12 * E * I / L ** 3, c = 6 * E * I / L ** 2, d = 4 * E * I / L, e = 2 * E * I / L;
  const set = (r, q, v) => { k[r][q] = v; };
  set(0, 0, a); set(0, 3, -a); set(3, 0, -a); set(3, 3, a);
  set(1, 1, b); set(1, 2, c); set(1, 4, -b); set(1, 5, c);
  set(2, 1, c); set(2, 2, d); set(2, 4, -c); set(2, 5, e);
  set(4, 1, -b); set(4, 2, -c); set(4, 4, b); set(4, 5, -c);
  set(5, 1, c); set(5, 2, e); set(5, 4, -c); set(5, 5, d);
  for (const [end, dof] of [[0, 2], [1, 5]]) if (m.release[end]) condense(k, dof);
  return k;
}
function condense(k, r) {
  const p = k[r][r];
  if (!(Math.abs(p) > 0)) return;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (i !== r && j !== r) k[i][j] -= k[i][r] * k[r][j] / p;
  for (let i = 0; i < 6; i++) { k[i][r] = 0; k[r][i] = 0; }
}

/** Fixed-end forces (local) of a member under a uniform transverse load q (local -y) and axial p (local +x per m). */
function fixedEnd(m, L, q, p) {
  // Reactions at the ends that hold the member: [N1, V1, M1, N2, V2, M2] in local axes.
  let f = [-p * L / 2, q * L / 2, q * L * L / 12, -p * L / 2, q * L / 2, -q * L * L / 12];
  const [r0, r1] = m.release;
  if (r0 && r1) f = [f[0], q * L / 2, 0, f[3], q * L / 2, 0];
  else if (r0) f = [f[0], 3 * q * L / 8, 0, f[3], 5 * q * L / 8, -q * L * L / 8];
  else if (r1) f = [f[0], 5 * q * L / 8, q * L * L / 8, f[3], 3 * q * L / 8, 0];
  return f;
}

function solve(nodes, members, fixed, loads) {
  const n = nodes.length * 3, K = Array.from({ length: n }, () => new Float64Array(n)), F = new Float64Array(n);
  const info = members.map((m) => {
    const g = geometry(nodes, m), k = localStiffness(m, g.L);
    // Distributed loads in local axes: gravity w (global -y) has components along and across.
    const q = m.w * g.c + (m.q ?? 0), p = -m.w * g.s;
    const fe = fixedEnd(m, g.L, q, p);
    const T = transform(g.c, g.s), dofs = [m.i * 3, m.i * 3 + 1, m.i * 3 + 2, m.j * 3, m.j * 3 + 1, m.j * 3 + 2];
    const kg = mul(transpose(T), mul(k, T));
    for (let r = 0; r < 6; r++) for (let s = 0; s < 6; s++) K[dofs[r]][dofs[s]] += kg[r][s];
    // Equivalent nodal loads: minus the fixed-end reactions, to global.
    const feg = mulVec(transpose(T), fe);
    for (let r = 0; r < 6; r++) F[dofs[r]] -= feg[r];
    return { g, k, T, dofs, fe, q, p };
  });
  for (const [node, l] of loads) for (let d = 0; d < 3; d++) F[node * 3 + d] += l[d];
  const isFixed = new Uint8Array(n);
  for (const [node, set] of fixed) for (const d of set) isFixed[node * 3 + d] = 1;
  // Rotational dofs at nodes where every member is released carry no stiffness: hold them.
  for (let i = 0; i < n; i++) if (!isFixed[i] && Math.abs(K[i][i]) < 1e-9) isFixed[i] = 1;
  const free = [...Array(n).keys()].filter((i) => !isFixed[i]);
  const Kff = free.map((r) => free.map((c) => K[r][c])), Ff = free.map((r) => F[r]);
  const uf = gauss(Kff, Ff), u = new Float64Array(n);
  free.forEach((d, i) => { u[d] = uf[i]; });
  const reactions = new Map();
  for (const [node] of fixed) {
    const r = [0, 1, 2].map((d) => { let v = -F[node * 3 + d]; for (let c = 0; c < n; c++) v += K[node * 3 + d][c] * u[c]; return v; });
    reactions.set(node, r);
  }
  const ends = info.map(({ k, T, dofs, fe }) => {
    const ul = mulVec(T, dofs.map((d) => u[d])), f = mulVec(k, ul);
    return f.map((x, r) => x + fe[r]);   // local end forces acting ON the member
  });
  const result = {
    u, reactions, ends,
    /** Member internal forces at s metres from its start: {N (tension +), V, M (sagging +)}. */
    at(mi, s) {
      const e = ends[mi], { q, p } = info[mi];
      const N = -e[0] - p * s, V = e[1] - q * s, M = -e[2] + e[1] * s - q * s * s / 2;
      return { N, V, M };
    },
    moment(mi, s) { return result.at(mi, s).M; },
    member: info,
  };
  return result;
}

function transform(c, s) {
  const T = Array.from({ length: 6 }, () => new Float64Array(6));
  for (const o of [0, 3]) { T[o][o] = c; T[o][o + 1] = s; T[o + 1][o] = -s; T[o + 1][o + 1] = c; T[o + 2][o + 2] = 1; }
  return T;
}
const rows = (A) => A.map((r) => Array.from(r));
const transpose = (A) => rows(A)[0].map((_, j) => rows(A).map((r) => r[j]));
const mul = (A, B) => rows(A).map((r) => rows(B)[0].map((_, j) => r.reduce((t, x, k) => t + x * B[k][j], 0)));
const mulVec = (A, v) => rows(A).map((r) => r.reduce((t, x, k) => t + x * v[k], 0));

/** Dense Gaussian elimination with partial pivoting (systems here are a few hundred dofs). */
function gauss(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-12 * Math.max(1, Math.abs(M[c][c])))) throw Error(`frame2d: singular stiffness (a mechanism) at dof ${c}`);
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let v = M[r][n]; for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k]; x[r] = v / M[r][r]; }
  return x;
}
