"""The compliant contact row's law, shared by the explicit step's harnesses (explicit-step.py,
two-body.py) and specified for the GPU kernel (PhysX PxgDestructionImpactExplicit.cuh: exBuild's
compliant block, exCompliantRow, exFinish's row bound).

A contact between two chunks is a flat elastic contact, k = 2 a E* (Johnson, Contact Mechanics,
1985, sec. 3.8; 1/E* = 1/E_a + 1/E_b, Poisson's ratio left out: (1 - nu^2) >= 0.91 for nu <= 0.3,
so k is at most 10% stiff), a from the stage's contact patch between the Hertz radius sqrt(R d) of
the depth d reached and the smaller chunk's face. Its normal impulse over a substep h is backward
Euler's (unconditionally stable, dissipative), the tangential one the impulse that stops the slip,
at most mu |P_N|. A substep resolves the shortest contact's period to eps: h <= sqrt(3 eps m / k).
"""
import numpy as np


def punch_stiffness(area, E1, E2, nu1=0.3, nu2=0.2):
    """A flat contact's normal stiffness: a rigid flat punch of the patch's equivalent radius a on an
    elastic half-space, k = 2 a E*, 1/E* = (1 - nu1^2)/E1 + (1 - nu2^2)/E2 (K. L. Johnson, Contact
    Mechanics, 1985, sec. 3.8; the same law the bridge uses for a bond's contact length)."""
    a = np.sqrt(max(area, 1e-8) / np.pi)
    return 2.0 * a / ((1 - nu1 ** 2) / E1 + (1 - nu2 ** 2) / E2)


def punch_row(Ea, Eb, pts, Va, Vb=None):
    """The kernel's compliant row (PxgDestructionImpactExplicit.cuh exBuild): 1/E* = 1/E_a + 1/E_b
    (Poisson's ratio left out; a rigid side 1/E = 0), the patch's spread sigma (its points' RMS
    distance from their centroid), the smaller chunk's equivalent sphere R and face radius:
    k(d) = 2 E* min(face, max(sigma, sqrt(R d)))."""
    pts = np.asarray(pts, float); c = pts.mean(0)
    sigma = float(np.sqrt(np.mean(np.sum((pts - c) ** 2, 1)))) if len(pts) > 1 else 0.0
    V = min(Va, Vb) if Vb else Va
    return dict(Estar=1.0 / (1.0 / Ea + (1.0 / Eb if Eb else 0.0)), sigma=sigma, Rh=(0.75 * V / np.pi) ** (1 / 3),
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


def compliant_impulse(W, g, d, row, mu, h, theta=1.0):
    """One compliant row's impulse over h: P_N = min(0, -k h (d + h g_N) / (1 + theta k h^2 W_NN))
    (k at depth d: row_k; theta 1 backward Euler, the kernel's), then the tangential impulse that
    stops the slip given P_N, clipped to mu |P_N|. W the row's 3 x 3 (split) inverse mass, g its
    relative motion (g_N > 0 closing). A tyre (a 'p' law) pushes with its force at d."""
    W = np.asarray(W, float); g = np.asarray(g, float)
    if 'k' in row or 'Estar' in row:
        kc = row_k(row, d); PN = min(0.0, -kc * h * (d + h * g[0]) / (1.0 + theta * kc * h * h * W[0, 0]))
    else:
        PN = -tyre_force(row, d) * h
    PT = -np.linalg.solve(W[1:, 1:], g[1:] + W[1:, 0] * PN)
    n = np.linalg.norm(PT); lim = mu * -PN
    if n > lim: PT *= lim / n
    return np.array([PN, PT[0], PT[1]])


def row_step(Wtrue_NN, k, eps):
    """The substep that resolves a compliant row of stiffness k and effective mass 1 / W_NN to a
    relative period error eps under backward Euler ((w h)^2 / 3): sqrt(3 eps / (W_NN k))."""
    return float(np.sqrt(3.0 * eps / (Wtrue_NN * k)))
