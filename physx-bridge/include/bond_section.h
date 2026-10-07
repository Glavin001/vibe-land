// A bond's real cross-section, from the two chunks' collision geometry.
//
// The stress stage turns a bond's moment into a fibre stress with a section
// modulus. Without one it can only assume a square patch of the bond's area
// (6/sqrt(A)); with the gain capped at 3 /m that is a 2 m deep section for any
// joint under 4 m^2, so a 45 x 90 mm stud read a twentieth of its bending
// stress. The patch's real shape is already authored: it is where the two
// chunks meet. For two touching boxes it is the overlap rectangle the town
// kit's builder (structures/town-kit/src/geometry.mjs) computes the bond's area
// from; in general it is the intersection of the two convex chunks' sections in
// the bond plane. From that polygon: the principal second moments, the extreme
// fibres, and so the elastic section moduli and the polar modulus
// (PxDestructionBondSection). The CPU reference is the same algorithm in
// structures/town-kit/scripts/stress-share.py bond_sections().
//
// Host-side, once, in double: this is authoring geometry, not the solve.
#pragma once

#include "PxPhysicsAPI.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace vibe_bond_section {

struct P2 { double x, y; };
struct P3 { double x, y, z; };

inline P3 p3(const physx::PxVec3 &v) { return {v.x, v.y, v.z}; }
inline double dot(const P3 &a, const P3 &b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline P3 sub(const P3 &a, const P3 &b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline P3 cross(const P3 &a, const P3 &b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline P3 scale(const P3 &a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline P3 add(const P3 &a, const P3 &b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }

/// A shape's vertices in its actor's frame (box corners or hull vertices).
inline void append_vertices(const physx::PxShape &shape, std::vector<P3> &out) {
  using namespace physx;
  const PxTransform pose = shape.getLocalPose();
  const PxGeometry &g = shape.getGeometry();
  if (g.getType() == PxGeometryType::eBOX) {
    const PxVec3 h = static_cast<const PxBoxGeometry &>(g).halfExtents;
    for (int i = 0; i < 8; ++i)
      out.push_back(p3(pose.transform(PxVec3(i & 1 ? h.x : -h.x, i & 2 ? h.y : -h.y, i & 4 ? h.z : -h.z))));
  } else if (g.getType() == PxGeometryType::eCONVEXMESH) {
    const auto &c = static_cast<const PxConvexMeshGeometry &>(g);
    const PxMat33 m = c.scale.toMat33();
    const PxVec3 *v = c.convexMesh->getVertices();
    for (PxU32 i = 0; i < c.convexMesh->getNbVertices(); ++i) out.push_back(p3(pose.transform(m * v[i])));
  }
}

inline double cross2(const P2 &o, const P2 &a, const P2 &b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/// Counter-clockwise convex hull (Andrew's monotone chain).
inline std::vector<P2> hull2(std::vector<P2> p) {
  std::sort(p.begin(), p.end(), [](const P2 &a, const P2 &b) { return a.x < b.x || (a.x == b.x && a.y < b.y); });
  if (p.size() < 3) return p;
  std::vector<P2> h(2 * p.size());
  size_t k = 0;
  for (size_t i = 0; i < p.size(); ++i) {
    while (k >= 2 && cross2(h[k - 2], h[k - 1], p[i]) <= 0) --k;
    h[k++] = p[i];
  }
  for (size_t i = p.size() - 1, t = k + 1; i-- > 0;) {
    while (k >= t && cross2(h[k - 2], h[k - 1], p[i]) <= 0) --k;
    h[k++] = p[i];
  }
  h.resize(k - 1);
  return h;
}

/// The convex solid's section in the plane through c with normal n, in (u, v).
/// Vertices on the plane (a face resting on it) and every crossing of a chord
/// between vertices on opposite sides: in a convex solid each such chord lies
/// inside it, and every edge is one, so their hull is exactly the section.
/// A solid that stops short of the plane (an authored gap: a column over its
/// footing's plinth, a clip off its panel, a tie across a cavity) is cut at
/// its face nearest the plane instead -- the face the bond joins.
inline std::vector<P2> slice(const std::vector<P3> &pts, P3 c, const P3 &n, const P3 &u, const P3 &v,
                             double tol) {
  if (pts.empty()) return {};
  std::vector<double> d(pts.size());
  for (size_t i = 0; i < pts.size(); ++i) d[i] = dot(sub(pts[i], c), n);
  const double lo = *std::min_element(d.begin(), d.end()), hi = *std::max_element(d.begin(), d.end());
  const double shift = lo > tol ? lo : hi < -tol ? hi : 0.0;
  if (shift != 0.0) {
    c = add(c, scale(n, shift));
    for (double &x : d) x -= shift;
  }
  std::vector<P2> q;
  const auto put = [&](const P3 &p) { const P3 r = sub(p, c); q.push_back({dot(r, u), dot(r, v)}); };
  for (size_t i = 0; i < pts.size(); ++i)
    if (std::abs(d[i]) <= tol) put(pts[i]);
  for (size_t i = 0; i < pts.size(); ++i) {
    if (!(d[i] < -tol)) continue;
    for (size_t j = 0; j < pts.size(); ++j) {
      if (!(d[j] > tol)) continue;
      const double t = d[i] / (d[i] - d[j]);
      put(add(pts[i], scale(sub(pts[j], pts[i]), t)));
    }
  }
  return q.size() >= 3 ? hull2(q) : std::vector<P2>{};
}

/// Convex a clipped by convex b, both counter-clockwise (Sutherland-Hodgman).
inline std::vector<P2> clip(std::vector<P2> a, const std::vector<P2> &b) {
  for (size_t k = 0; k < b.size() && !a.empty(); ++k) {
    const P2 e0 = b[k], e1 = b[(k + 1) % b.size()];
    const auto inside = [&](const P2 &p) { return cross2(e0, e1, p) >= -1e-15; };
    const auto cut = [&](const P2 &p, const P2 &q) {
      const double dp = cross2(e0, e1, p), dq = cross2(e0, e1, q), t = dp / (dp - dq);
      return P2{p.x + t * (q.x - p.x), p.y + t * (q.y - p.y)};
    };
    std::vector<P2> in = std::move(a);
    a.clear();
    for (size_t i = 0; i < in.size(); ++i) {
      const P2 p = in[i], q = in[(i + 1) % in.size()];
      if (inside(q)) {
        if (!inside(p)) a.push_back(cut(p, q));
        a.push_back(q);
      } else if (inside(p)) {
        a.push_back(cut(p, q));
      }
    }
  }
  return a;
}

struct Result {
  physx::PxDestructionBondSection section{}; // zero moduli: no patch found
  double geometric_area = 0;                 // the patch's own area (m^2)
  double depth = 0;                          // 6 S_min / A: the shallow depth (m)
  bool found = false;
};

/// The patch where chunks a and b meet in the bond plane, as moduli of its
/// shape at the bond's authored area. None when the chunks' faces do not
/// overlap there.
inline Result section(const std::vector<P3> &a, const std::vector<P3> &b, const physx::PxVec3 &centroid,
                      const physx::PxVec3 &normal, double area) {
  Result r;
  const P3 c = p3(centroid);
  P3 n = p3(normal);
  const double nn = std::sqrt(dot(n, n));
  if (!(nn > 0) || !(area > 0)) return r;
  n = scale(n, 1.0 / nn);
  P3 u = cross(n, std::abs(n.x) < 0.9 ? P3{1, 0, 0} : P3{0, 1, 0});
  u = scale(u, 1.0 / std::sqrt(dot(u, u)));
  const P3 v = cross(n, u);
  // Authored contacts are coplanar to the rounding of the authoring (1e-6 m);
  // 0.1 mm is well inside any real member and well outside that.
  const double tol = 1e-4;
  const std::vector<P2> sa = slice(a, c, n, u, v, tol), sb = slice(b, c, n, u, v, tol);
  if (sa.size() < 3 || sb.size() < 3) return r;
  const std::vector<P2> p = clip(sa, sb);
  if (p.size() < 3) return r;
  double A = 0, cx = 0, cy = 0, xx = 0, yy = 0, xy = 0;
  for (size_t i = 0; i < p.size(); ++i) {
    const P2 s = p[i], t = p[(i + 1) % p.size()];
    const double w = s.x * t.y - t.x * s.y;
    A += w;
    cx += (s.x + t.x) * w;
    cy += (s.y + t.y) * w;
    xx += (s.x * s.x + s.x * t.x + t.x * t.x) * w;
    yy += (s.y * s.y + s.y * t.y + t.y * t.y) * w;
    xy += (s.x * t.y + 2 * s.x * s.y + 2 * t.x * t.y + t.x * s.y) * w;
  }
  A *= 0.5;
  if (!(A > 1e-12)) return r;
  // A contact cannot be larger than its faces' overlap. Where the authored area
  // is (beyond the authoring's 1e-6 m^2 rounding), the faces are not the
  // contact -- an angled or curved part whose bond area comes from the solids'
  // overlap -- and their overlap, a sliver, says nothing about its shape:
  // scaled up to the authored area it gave a 0.056 m^2 vehicle bond radii of
  // gyration of 94 m and 6e-5 m. Such a bond keeps the square patch of its
  // area. A smaller authored area (a fastener inside a larger overlap) keeps
  // the overlap's shape, scaled down. The slice takes faces within tol of the
  // plane, so the overlap is uncertain by a band tol wide around its perimeter.
  double perimeter = 0;
  for (size_t i = 0; i < p.size(); ++i) {
    const P2 s = p[i], t = p[(i + 1) % p.size()];
    perimeter += std::sqrt((t.x - s.x) * (t.x - s.x) + (t.y - s.y) * (t.y - s.y));
  }
  if (area > A + perimeter * tol + 1e-6) return r;
  cx /= 6 * A;
  cy /= 6 * A;
  xx = xx / 12 - A * cx * cx; // int u^2 dA about the patch centroid
  yy = yy / 12 - A * cy * cy; // int v^2 dA
  xy = xy / 24 - A * cx * cy; // int u v dA
  // Principal axes: e0 at theta, e1 = n x e0; lam_k = int (x . e_k)^2 dA.
  double theta = 0.5 * std::atan2(2 * xy, xx - yy);
  // An isotropic patch (a square, a regular polygon) has every in-plane axis
  // principal, and |M0|/S0 + |M1|/S1 is the corner fibre only on the axes the
  // corners lie on: on a square's diagonals it reads twice beam theory. Take
  // the patch's longest edge as the axis there (exact for a square).
  if (std::abs(xx - yy) <= 1e-6 * (xx + yy) && std::abs(xy) <= 1e-6 * (xx + yy)) {
    double best = -1;
    for (size_t i = 0; i < p.size(); ++i) {
      const P2 s = p[i], t = p[(i + 1) % p.size()];
      const double l = (t.x - s.x) * (t.x - s.x) + (t.y - s.y) * (t.y - s.y);
      if (l > best) { best = l; theta = std::atan2(t.y - s.y, t.x - s.x); }
    }
  }
  const double co = std::cos(theta), si = std::sin(theta);
  const double lam0 = xx * co * co + 2 * xy * co * si + yy * si * si;
  const double lam1 = xx * si * si - 2 * xy * co * si + yy * co * co;
  double reach0 = 0, reach1 = 0, rmax = 0;
  for (const P2 &q : p) {
    const double x = q.x - cx, y = q.y - cy, a0 = x * co + y * si, a1 = -x * si + y * co;
    reach0 = std::max(reach0, std::abs(a0));
    reach1 = std::max(reach1, std::abs(a1));
    rmax = std::max(rmax, std::sqrt(x * x + y * y));
  }
  if (!(lam0 > 0 && lam1 > 0 && reach0 > 0 && reach1 > 0)) return r;
  // The authored area is the contact; the geometry gives its shape. Where
  // they differ (a fastener inside a larger overlap) the patch is the
  // overlap's shape scaled to the authored area: lengths by sqrt(k), so the
  // moduli (length^3) by k^1.5.
  const double k15 = std::pow(area / A, 1.5);
  // Bending about e0 strains fibres along e1: I = lam1, c = reach1.
  const double s0 = lam1 / reach1 * k15, s1 = lam0 / reach0 * k15, zt = (lam0 + lam1) / rmax * k15;
  const P3 e0 = add(scale(u, co), scale(v, si));
  r.section.axis = physx::PxVec3(float(e0.x), float(e0.y), float(e0.z)).getNormalized();
  r.section.bendModulus0 = float(s0);
  r.section.bendModulus1 = float(s1);
  r.section.twistModulus = float(zt);
#if defined(PX_DESTRUCTION_SECTION_ROTATIONAL_STIFFNESS)
  // Radii of gyration (lengths: by sqrt(k)): rotation about e0 strains fibres
  // along e1 (I = lam1), about e1 along e0 (I = lam0), and twist I_p.
  const double k05 = std::sqrt(area / A);
  r.section.gyration0 = float(std::sqrt(lam1 / A) * k05);
  r.section.gyration1 = float(std::sqrt(lam0 / A) * k05);
  r.section.polarGyration = float(std::sqrt((lam0 + lam1) / A) * k05);
#endif
  r.geometric_area = A;
  r.depth = 6 * std::min(s0, s1) / area;
  r.found = r.section.bendModulus0 > 0 && r.section.bendModulus1 > 0 && r.section.twistModulus > 0;
  if (!r.found) r.section = {};
  return r;
}

} // namespace vibe_bond_section
