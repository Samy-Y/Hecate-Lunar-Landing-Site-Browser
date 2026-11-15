/** Shared numeric constants and small vector helpers (no allocation-heavy classes). */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** IAU mean lunar radius - reference sphere for every elevation in the app. */
export const R_MOON_M = 1_737_400;
export const R_MOON_KM = 1737.4;
export const R_SUN_KM = 696_000;
export const R_EARTH_KM = 6378.137;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Mean angular semidiameter of the solar disk seen from the Moon (deg). */
export const SUN_SEMIDIAMETER_DEG = 0.2666;

export type Vec3 = [number, number, number];

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const wrap360 = (a: number) => ((a % 360) + 360) % 360;
export const wrap180 = (a: number) => wrap360(a + 180) - 180;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Smallest signed difference b - a between two azimuths, in (-180, 180]. */
export const azDiff = (a: number, b: number) => ((b - a + 540) % 360) - 180;

export const fmt = (v: number | null | undefined, digits = 1, fallback = '—') =>
  v === null || v === undefined || !Number.isFinite(v) ? fallback : v.toFixed(digits);
