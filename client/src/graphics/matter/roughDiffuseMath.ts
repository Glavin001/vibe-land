// The EON rough diffuse equations as plain numbers: the mirror of the TSL in
// roughDiffuse.ts, for unit tests and CPU-side checks. See roughDiffuse.ts
// for the model and its source.

export const SINGLE_A = 0.5 - 2 / (3 * Math.PI);
export const MEAN_G = 2 / 3 - 28 / (15 * Math.PI);
/** Smallest cosine the albedo takes: keeps 1/cos finite at grazing. */
export const MU_FLOOR = 1e-4;

export function fonA(sigma: number): number {
  return 1 / (1 + SINGLE_A * sigma);
}

/** The exact (1/pi) * hemispherical integral of (s/t) * mu_i, for view cosine mu. */
export function fonG(mu: number): number {
  const c = Math.min(Math.max(mu, MU_FLOOR), 1);
  const theta = Math.acos(c);
  const sn = Math.sqrt(Math.max(1 - c * c, 0));
  const s3 = sn * sn * sn;
  const inner = theta / 2 - (sn * c) / 2 - s3 / 3 + ((1 / c - 1) * (1 - s3)) / 3;
  return (2 / Math.PI) * sn * inner;
}

/** Directional albedo of FON at rho = 1. */
export function fonAlbedo(mu: number, sigma: number): number {
  return fonA(sigma) * (1 + sigma * fonG(mu));
}

/** Cosine-weighted mean of fonAlbedo over the hemisphere. */
export function fonMeanAlbedo(sigma: number): number {
  return fonA(sigma) * (1 + sigma * MEAN_G);
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** EON BRDF value (no cosine) for one channel. */
export function eonBrdf(rho: number, sigma: number, wi: V3, wo: V3, n: V3): number {
  const mi = Math.max(dot(n, wi), MU_FLOOR);
  const mo = Math.max(dot(n, wo), MU_FLOOR);
  const s = dot(wi, wo) - mi * mo;
  const sOverT = s > 0 ? s / Math.max(mi, mo) : s;
  const single = (rho / Math.PI) * fonA(sigma) * (1 + sigma * sOverT);
  const mean = fonMeanAlbedo(sigma);
  const rhoMs = (rho * rho * mean) / (1 - rho * (1 - mean));
  const multi =
    ((rhoMs / Math.PI) * (1 - fonAlbedo(mi, sigma)) * (1 - fonAlbedo(mo, sigma))) /
    Math.max(1 - mean, 1e-7);
  return single + multi;
}

/** Directional albedo of the full EON lobe (what a uniform sky returns). */
export function eonAlbedo(rho: number, mu: number, sigma: number): number {
  const e = fonAlbedo(mu, sigma);
  const mean = fonMeanAlbedo(sigma);
  const rhoMs = (rho * rho * mean) / (1 - rho * (1 - mean));
  return rho * e + rhoMs * (1 - e);
}

