import { describe, expect, it } from 'vitest';

import { eonAlbedo, eonBrdf, fonAlbedo, fonG, fonMeanAlbedo } from './roughDiffuseMath';

type V3 = [number, number, number];
const N: V3 = [0, 0, 1];
const dir = (theta: number, phi: number): V3 => [
  Math.sin(theta) * Math.cos(phi),
  Math.sin(theta) * Math.sin(phi),
  Math.cos(theta),
];

/** Midpoint quadrature over the hemisphere of f(wi) * cos(theta_i). */
function hemisphere(f: (wi: V3) => number, steps = 400): number {
  let sum = 0;
  const dt = Math.PI / 2 / steps;
  const dp = (2 * Math.PI) / (2 * steps);
  for (let i = 0; i < steps; i++) {
    const theta = (i + 0.5) * dt;
    const weight = Math.cos(theta) * Math.sin(theta) * dt * dp;
    for (let j = 0; j < 2 * steps; j++) sum += f(dir(theta, (j + 0.5) * dp)) * weight;
  }
  return sum;
}

describe('EON rough diffuse', () => {
  it('is Lambert at roughness 0', () => {
    for (const rho of [0.2, 0.5, 0.9]) {
      expect(eonBrdf(rho, 0, dir(0.3, 0.1), dir(1.1, 2.4), N)).toBeCloseTo(rho / Math.PI, 6);
    }
  });

  it('is reciprocal', () => {
    for (const sigma of [0.1, 0.5, 1]) {
      const a = dir(0.4, 0.3);
      const b = dir(1.2, 2.0);
      expect(eonBrdf(0.6, sigma, a, b, N)).toBeCloseTo(eonBrdf(0.6, sigma, b, a, N), 10);
    }
  });

  it('has the exact FON directional albedo', () => {
    // E_FON(mu) against brute-force integration of the single-scattering lobe.
    for (const sigma of [0.25, 1]) {
      for (const theta of [0.1, 0.7, 1.3]) {
        const wo = dir(theta, 0);
        const single = hemisphere((wi) => {
          const s = wi[0] * wo[0] + wi[1] * wo[1] + wi[2] * wo[2] - wi[2] * wo[2];
          const t = s > 0 ? Math.max(wi[2], wo[2]) : 1;
          return (1 / Math.PI) * (1 / (1 + (0.5 - 2 / (3 * Math.PI)) * sigma)) * (1 + (sigma * s) / t);
        });
        expect(fonAlbedo(Math.cos(theta), sigma)).toBeCloseTo(single, 3);
      }
    }
  });

  it('has the closed-form mean albedo', () => {
    // Ebar = integral of E(mu) 2 mu dmu, against quadrature of the exact G.
    const steps = 4000;
    let integral = 0;
    for (let i = 0; i < steps; i++) {
      const mu = (i + 0.5) / steps;
      integral += fonG(mu) * 2 * mu / steps;
    }
    const sigma = 1;
    const a = 1 / (1 + (0.5 - 2 / (3 * Math.PI)) * sigma);
    expect(fonMeanAlbedo(sigma)).toBeCloseTo(a * (1 + sigma * integral), 4);
  });

  it('passes the white furnace: a white surface reflects all it receives', () => {
    for (const sigma of [0, 0.3, 0.7, 1]) {
      for (const theta of [0.05, 0.6, 1.2, 1.5]) {
        const wo = dir(theta, 0);
        const total = hemisphere((wi) => eonBrdf(1, sigma, wi, wo, N));
        expect(total).toBeLessThanOrEqual(1.002);
        expect(total).toBeGreaterThan(0.995);
        expect(eonAlbedo(1, Math.cos(theta), sigma)).toBeCloseTo(1, 6);
      }
    }
  });

  it('never gains energy for coloured surfaces, and its albedo matches the integral', () => {
    for (const rho of [0.3, 0.8]) {
      for (const sigma of [0.5, 1]) {
        const theta = 0.9;
        const total = hemisphere((wi) => eonBrdf(rho, sigma, wi, dir(theta, 0), N));
        expect(total).toBeLessThan(rho + 1e-3);
        expect(eonAlbedo(rho, Math.cos(theta), sigma)).toBeCloseTo(total, 3);
      }
    }
  });
});
