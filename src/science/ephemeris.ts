/**
 * Tier 1 local analytical ephemeris (spec v2.0 sec. 4.2).
 *
 * Positions come from Astronomy Engine (VSOP87 for the Earth/Sun, a Chapront-type
 * lunar theory for the Moon) in the J2000 equatorial frame (EQJ ~ ICRF).
 * Lunar orientation uses the IAU WGCCRE model (pole RA/Dec + prime-meridian angle W
 * including the 13 libration arguments E1..E13), giving body-fixed vectors that
 * approximate MOON_ME to a few arc-seconds.
 *
 * UTC -> TT is handled inside Astronomy Engine (DeltaT model). Refraction is zero
 * (airless body). Topocentric parallax is applied exactly by subtracting the
 * observer's body-fixed position (lat, lon, elevation) from the target vector.
 */
import { Body, GeoMoon, GeoVector, KM_PER_AU, MakeTime, RotationAxis } from 'astronomy-engine';
import { DEG, R_EARTH_KM, R_SUN_KM, RAD, type Vec3, wrap360 } from '../lib/math';
import type { SiteFrame } from '../lib/geo';

export interface Geometry {
  utcMs: number;
  /** Sun position relative to the Moon centre, km, body-fixed (MOON_ME approx). */
  sun: Vec3;
  /** Earth position relative to the Moon centre, km, body-fixed. */
  earth: Vec3;
  sunDist: number;
  earthDist: number;
  subSolar: { lat: number; lon: number };
  subEarth: { lat: number; lon: number };
}

type Mat3 = number[]; // row-major 3x3

/** Passive rotation about Z by angle a (rad). */
const rotZ = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
};
/** Passive rotation about X by angle a (rad). */
const rotX = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
};
const mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** ICRF -> body-fixed:  Rz(W) . Rx(90 - dec0) . Rz(90 + ra0)  (IAU convention). */
export function icrfToBodyFixed(raDeg: number, decDeg: number, wDeg: number): Mat3 {
  return mul(rotZ(wDeg * DEG), mul(rotX((90 - decDeg) * DEG), rotZ((90 + raDeg) * DEG)));
}

function subPoint(v: Vec3, d: number) {
  return { lat: Math.asin(v[2] / d) * RAD, lon: wrap360(Math.atan2(v[1], v[0]) * RAD) };
}

export function geometryAt(utcMs: number): Geometry {
  const t = MakeTime(new Date(utcMs));
  const moon = GeoMoon(t);
  const sunG = GeoVector(Body.Sun, t, true);
  const axis = RotationAxis(Body.Moon, t);
  const M = icrfToBodyFixed(axis.ra * 15, axis.dec, axis.spin);
  const sunEq: Vec3 = [(sunG.x - moon.x) * KM_PER_AU, (sunG.y - moon.y) * KM_PER_AU, (sunG.z - moon.z) * KM_PER_AU];
  const earthEq: Vec3 = [-moon.x * KM_PER_AU, -moon.y * KM_PER_AU, -moon.z * KM_PER_AU];
  const sun = apply(M, sunEq);
  const earth = apply(M, earthEq);
  const sunDist = Math.hypot(...sun);
  const earthDist = Math.hypot(...earth);
  return { utcMs, sun, earth, sunDist, earthDist, subSolar: subPoint(sun, sunDist), subEarth: subPoint(earth, earthDist) };
}

/** Linear interpolation of two geometries (used only for sub-hour transient scanning). */
export function lerpGeometry(a: Geometry, b: Geometry, f: number, utcMs: number): Geometry {
  const L = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
  return { ...a, utcMs, sun: L(a.sun, b.sun), earth: L(a.earth, b.earth) };
}

export interface Topo {
  az: number;
  el: number;
  dist: number;
  /** Apparent angular radius (deg). */
  radius: number;
}

/** Topocentric azimuth/elevation of a body-fixed target seen from a site frame. */
export function topocentric(f: SiteFrame, target: Vec3, bodyRadiusKm: number): Topo {
  const dx = target[0] - f.P[0], dy = target[1] - f.P[1], dz = target[2] - f.P[2];
  const d = Math.hypot(dx, dy, dz);
  const u = (dx * f.up[0] + dy * f.up[1] + dz * f.up[2]) / d;
  const e = dx * f.east[0] + dy * f.east[1] + dz * f.east[2];
  const n = dx * f.north[0] + dy * f.north[1] + dz * f.north[2];
  return { az: wrap360(Math.atan2(e, n) * RAD), el: Math.asin(Math.max(-1, Math.min(1, u))) * RAD, dist: d, radius: Math.asin(bodyRadiusKm / d) * RAD };
}

export const sunTopo = (f: SiteFrame, g: Geometry) => topocentric(f, g.sun, R_SUN_KM);
export const earthTopo = (f: SiteFrame, g: Geometry) => topocentric(f, g.earth, R_EARTH_KM);
