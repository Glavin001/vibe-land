"""The compliant contact row's law, shared by the explicit step's harnesses (explicit-step.py,
two-body.py) and specified for the GPU kernel (PhysX PxgDestructionImpactExplicit.cuh: exBuild's
compliant block, exCompliantRow, exFinish's row bound).

A contact between two chunks is a flat elastic contact, k = 2 a E* (Johnson, Contact Mechanics,
1985, sec. 3.8; 1/E* = 1/E_a + 1/E_b, Poisson's ratio left out: (1 - nu^2) >= 0.91 for nu <= 0.3,
so k is at most 10% stiff), a from the stage's contact patch between the Hertz radius sqrt(R d) of
the depth d reached and the smaller chunk's face. Its normal impulse over a substep h is backward
Euler's on its force F(d) = the integral of k (a flat punch below the Hertz radius, Hertz between,
the face's punch past it; linearised at d: unconditionally stable, dissipative), the tangential one
the impulse that stops the slip,
at most mu |P_N|. A substep resolves the shortest contact's period to eps: h <= sqrt(3 eps m / k).
"""
import numpy as np


def punch_stiffness(area, E1, E2, nu1=0.3, nu2=0.2):
    """A flat contact's normal stiffness: a rigid flat punch of the patch's equivalent radius a on an
    elastic half-space, k = 2 a E*, 1/E* = (1 - nu1^2)/E1 + (1 - nu2^2)/E2 (K. L. Johnson, Contact
    Mechanics, 1985, sec. 3.8; the same law the bridge uses for a bond's contact length)."""
    a = np.sqrt(max(area, 1e-8) / np.pi)
    return 2.0 * a / ((1 - nu1 ** 2) / E1 + (1 - nu2 ** 2) / E2)


def punch_row(Ea, Eb, pts, Va, Vb=None, Rb=None):
    """The kernel's compliant row (PxgDestructionImpactExplicit.cuh exBuild): 1/E* = 1/E_a + 1/E_b
    (Poisson's ratio left out; a rigid side 1/E = 0), the patch's spread sigma (its points' RMS
    distance from their centroid), Hertz's relative curvature 1/R = 1/R_a + 1/R_b (each chunk's
    equivalent sphere; a rigid impactor's Rb from its own mass and inertia, sqrt(5 I / 2 m)), the
    smaller chunk's face radius: k(d) = 2 E* min(face, max(sigma, sqrt(R d)))."""
    pts = np.asarray(pts, float); c = pts.mean(0)
    sigma = float(np.sqrt(np.mean(np.sum((pts - c) ** 2, 1)))) if len(pts) > 1 else 0.0
    V = min(Va, Vb) if Vb else Va
    Ra = (0.75 * Va / np.pi) ** (1 / 3)
    if Rb is None and Vb: Rb = (0.75 * Vb / np.pi) ** (1 / 3)
    R = Ra * Rb / (Ra + Rb) if Rb else Ra
    return dict(Estar=1.0 / (1.0 / Ea + (1.0 / Eb if Eb else 0.0)), sigma=sigma, Rh=R,
                face=np.sqrt(V ** (2 / 3) / np.pi), sec=np.inf)

def row_k(t, d):
    """A compliant row's stiffness at depth d."""
    if 'k' in t: return t['k']
    return 2.0 * t['Estar'] * min(t['face'], max(t['sigma'], np.sqrt(t['Rh'] * max(d, 0.0))))


def tyre_force(t, d):
    """A pneumatic tyre pressed radially by d (m): the inflation pressure over the contact patch,
    F = p A, the patch a chord of the tread, A = b 2 sqrt(2 R d) (the membrane approximation;
    Gent & Walter, The Pneumatic Tire, NHTSA 2006, ch. 7: the load is carried by the inflation
    pressure over the contact area). Past the section height the rim bears (a rigid row)."""
    if 'k' in t: return t['k'] * max(d, 0.0)
    return t['p'] * t['b'] * 2.0 * np.sqrt(2.0 * t['R'] * max(d, 0.0))


def row_force(t, d):
    """A compliant row's force at depth d: the integral of its tangent stiffness k(s) = 2 E* a(s),
    a(s) = min(face, max(sigma, sqrt(R s))) -- a flat patch of radius sigma (F = 2 sigma E* d,
    Johnson 3.8), past d1 = sigma^2 / R the Hertz contact of the curvature R (dF = 2 E* sqrt(R s) ds:
    F = 4/3 E* sqrt(R) d^(3/2), Johnson 4.2), past d2 = face^2 / R the face's flat punch."""
    if 'k' in t: return t['k'] * max(d, 0.0)
    d = max(d, 0.0); E, R, sg, fc = t['Estar'], t['Rh'], min(t['sigma'], t['face']), t['face']
    d1 = sg * sg / R if R > 0 else np.inf; d2 = fc * fc / R if R > 0 else np.inf
    if d <= d1: return 2.0 * E * sg * d
    F = 2.0 * E * sg * d1
    if d <= d2: return F + 4.0 / 3.0 * E * np.sqrt(R) * (d ** 1.5 - d1 ** 1.5)
    return F + 4.0 / 3.0 * E * np.sqrt(R) * (d2 ** 1.5 - d1 ** 1.5) + 2.0 * E * fc * (d - d2)


def crush_of(mat):
    """(onset, plateau) for a material record with the stage's fields (capPressure, cohesion,
    frictionSlope, crushEnergy, compressionFatalLimit). The onset: the uniaxial crush stress of its
    own crush law, min(c / (1 - s / 3), 3 p_cap) (q = sigma, p = sigma / 3; the cone never for
    s >= 3). The plateau: its crush energy density (J/m^3 = Pa: the work per crushed volume is the
    plateau stress, Gibson & Ashby, Cellular Solids, 1997, ch. 5), at most the onset. A material with
    no crush law (capPressure 0) cannot carry more than its compressive strength under the contact
    without failing there: onset and plateau both (Johnson 1985, sec. 11.5: the contact of an impact
    past first yield is plastic and dissipative)."""
    c, s, cap = float(mat['cohesion']), float(mat['frictionSlope']), float(mat['capPressure'])
    if cap > 0:
        cone = c / (1.0 - s / 3.0) if s < 3.0 and c > 0 else np.inf
        on = min(cone, 3.0 * cap)
        return on, min(float(mat['crushEnergy']), on)
    cf = float(mat['compressionFatalLimit'])
    return (cf, cf) if cf > 0 else (np.inf, np.inf)


def crater_row(row, crush, R=None):
    """The row while its struck side crushes: a flat punch of the crater's radius, a^2 = 2 R d at the
    whole intrusion d = crush['d_tot'] (a plastic indentation's truncated cap, Johnson 1985 sec. 6.3;
    the elastic Hertz radius is sqrt(R d)), at most the face. R the row's relative curvature."""
    R = row['Rh'] if R is None else R
    return dict(row, sigma=max(row['sigma'], min(row['face'], np.sqrt(2.0 * R * max(crush['d_tot'], 0.0)))))


def compliant_impulse(W, g, d, row, mu, h, theta=1.0, crush=None):
    """One compliant row's impulse over h: P_N = min(0, -k h (d + h g_N) / (1 + theta k h^2 W_NN))
    (k at depth d: row_k; theta 1 backward Euler, the kernel's), then the tangential impulse that
    stops the slip given P_N, clipped to mu |P_N|. W the row's 3 x 3 (split) inverse mass, g its
    relative motion (g_N > 0 closing). A tyre (a 'p' law) pushes with its force at d.

    crush (optional; the struck side's crush, scripts/impact/compliant-step.py): a dict with 'on',
    'pl' (crush_of), 'crushing' (sticky), 'd_tot' (the whole intrusion). Crushing, the row is the
    crater's flat punch (crater_row). The normal force reaching 'on' x pi a^2 starts the crush; while
    crushing it is at most 'pl' x pi a^2 (the tangential within mu of it). Sets crush['a'], ['F'].
    Without crush (None) the law is unchanged."""
    W = np.asarray(W, float); g = np.asarray(g, float)
    if crush is not None and crush.get('crushing'): row = crater_row(row, crush, crush.get('R'))
    if 'k' in row or 'Estar' in row:
        # its force at the substep's end, F(d) + k(d) h g+ (linearised at d; g+ = g_N + W_NN P_N)
        kc = row_k(row, d); PN = min(0.0, -h * (row_force(row, d) + kc * h * g[0]) / (1.0 + theta * kc * h * h * W[0, 0]))
    else:
        PN = -tyre_force(row, d) * h
    if crush is not None and 'Estar' in row:
        a = min(row['face'], max(row['sigma'], np.sqrt(row['Rh'] * max(d, 0.0))))
        A = np.pi * a * a; F = -PN / h
        if not crush.get('crushing') and A > 0 and F >= crush['on'] * A: crush['crushing'] = True
        if crush.get('crushing') and F > crush['pl'] * A: PN = -crush['pl'] * A * h
        crush['a'] = a; crush['F'] = -PN / h; crush['Estar'] = row['Estar']
    PT = -np.linalg.solve(W[1:, 1:], g[1:] + W[1:, 0] * PN)
    n = np.linalg.norm(PT); lim = mu * -PN
    if n > lim: PT *= lim / n
    return np.array([PN, PT[0], PT[1]])


def crush_advance(crush, d_el, gN, h):
    """After the substep's impulses (gN the row's closing rate after them): the intrusion past the
    elastic depth F / (2 a E*) is crushed. Returns the crushed depth increment; its work is crush['F']
    times it (the striker's)."""
    if not crush.get('crushing') or not crush.get('a', 0) > 0: return 0.0
    dn = d_el + h * gN; dy = crush['F'] / (2.0 * crush['a'] * crush['Estar'])
    return max(0.0, dn - dy)


def row_step(Wtrue_NN, k, eps):
    """The substep that resolves a compliant row of stiffness k and effective mass 1 / W_NN to a
    relative period error eps under backward Euler ((w h)^2 / 3): sqrt(3 eps / (W_NN k))."""
    return float(np.sqrt(3.0 * eps / (Wtrue_NN * k)))


def hertz_check(m=10.0, R=0.1, E=210e9, v=1.0, eps=0.1):
    """The law on a sphere (mass m, radius R, E) striking a rigid flat at v, against Hertz's closed form
    (Johnson 1985, 11.4): delta_max = (15 m v^2 / (16 E* sqrt R))^(2/5), F_max = 4/3 E* sqrt(R)
    delta_max^(3/2), contact time 2.87 (m^2 / (R E*^2 v))^(1/5). One row, the sphere's single contact
    point (sigma 0), its own radius as R, the flat's face far larger; h from row_step at eps."""
    Es = E / 1.0
    dmax = (15 * m * v * v / (16 * Es * np.sqrt(R))) ** 0.4; Fmax = 4 / 3 * Es * np.sqrt(R) * dmax ** 1.5
    tc = 2.87 * (m * m / (R * Es * Es * v)) ** 0.2
    row = dict(Estar=Es, sigma=0.0, Rh=R, face=10.0)
    W = np.eye(3) / m
    h = row_step(1.0 / m, row_k(row, dmax), eps)
    vel = v; d = 0.0; t = 0.0; F = 0.0; started = None; ended = None
    for s in range(200000):
        g = np.array([vel, 0.0, 0.0])
        P = compliant_impulse(W, g, d, row, 0.0, h)
        vel += P[0] / m
        F = max(F, -P[0] / h)
        if P[0] < 0 and started is None: started = t
        d = max(d + vel * h, 0.0); t += h
        if started is not None and d <= 0.0 and vel < 0: ended = t; break
    return dict(h=h, Fmax=F, Fmax_hertz=Fmax, t=ended - started if ended else None, t_hertz=tc, v_out=-vel)


if __name__ == '__main__':
    for eps in (0.1, 0.02):
        r = hertz_check(eps=eps)
        print(f"eps {eps}: h {r['h'] * 1e6:.2f} us; F_max {r['Fmax'] / 1e3:.1f} kN against Hertz {r['Fmax_hertz'] / 1e3:.1f} kN "
              f"({(r['Fmax'] / r['Fmax_hertz'] - 1) * 100:+.1f}%); contact {r['t'] * 1e6:.1f} us against {r['t_hertz'] * 1e6:.1f} us "
              f"({(r['t'] / r['t_hertz'] - 1) * 100:+.1f}%); rebound {r['v_out']:.3f} m/s of 1")
