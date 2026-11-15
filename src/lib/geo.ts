/**
 * Lunar coordinate contract (spec v2.0 ch. 4.1).
 *
 *  - Body-fixed frame MOON_ME, IAU reference sphere R = 1 737 400 m.
 *  - Planetocentric latitude, east-positive longitude.
 *  - South polar stereographic map plane:  R = 2 R_moon tan((90 - |lat|)/2),
 *    X = R sin(lon), Y = R cos(lon)   (0 deg longitude points to screen-top).
 *  - Topocentric horizon: azimuth clockwise from lunar north, elevation above the
 *    local tangent plane. At the pole, azimuth is referenced to the prime meridian.
 *
 * Scene mapping for Three.js (Y-up):  scene = (bx, bz, -by)  (a proper rotation).
 */
import { DEG, RAD, R_MOON_M, R_MOON_KM, type Vec3, wrap360 } from './math';

/** Lat/lon (deg) -> south polar stereographic (m). Valid for the southern hemisphere. */
export function latLonToPolar(latDeg: number, lonDeg: number): [number, number] {
  const colat = (90 + latDeg) * DEG;
  const r = 2 * R_MOON_M * Math.tan(colat / 2);
  const l = lonDeg * DEG;
  return [r * Math.sin(l), r * Math.cos(l)];
}

/** South polar stereographic (m) -> [lat, lon 0..360) in degrees. */
export function polarToLatLon(x: number, y: number): [number, number] {
  const rho = Math.hypot(x, y);
  const colat = 2 * Math.atan(rho / (2 * R_MOON_M));
  return [-90 + colat * RAD, wrap360(Math.atan2(x, y) * RAD)];
}

/** Stereographic scale factor k = map distance / true surface distance. */
export function polarScale(x: number, y: number): number {
  const colat = 2 * Math.atan(Math.hypot(x, y) / (2 * R_MOON_M));
  const c = Math.cos(colat / 2);
  return 1 / (c * c);
}

/** Unit vectors (in the map plane) of local north (away from pole) and east. */
export function mapNorthEast(x: number, y: number): { n: [number, number]; e: [number, number] } {
  const r = Math.hypot(x, y);
  const n: [number, number] = r > 1e-6 ? [x / r, y / r] : [0, 1];
  return { n, e: [n[1], -n[0]] };
}

/** Map-plane unit direction for a topocentric azimuth (deg, clockwise from north). */
export function mapDirForAzimuth(x: number, y: number, azDeg: number): [number, number] {
  const { n, e } = mapNorthEast(x, y);
  const c = Math.cos(azDeg * DEG);
  const s = Math.sin(azDeg * DEG);
  return [c * n[0] + s * e[0], c * n[1] + s * e[1]];
}

/** Body-fixed Cartesian (same unit as radius). */
export function bodyFixed(latDeg: number, lonDeg: number, radius: number): Vec3 {
  const cl = Math.cos(latDeg * DEG);
  return [radius * cl * Math.cos(lonDeg * DEG), radius * cl * Math.sin(lonDeg * DEG), radius * Math.sin(latDeg * DEG)];
}

export function unitToLatLon(v: Vec3): [number, number] {
  const r = Math.hypot(v[0], v[1], v[2]) || 1;
  return [Math.asin(Math.max(-1, Math.min(1, v[2] / r))) * RAD, Math.atan2(v[1], v[0]) * RAD];
}

export interface SiteFrame {
  lat: number;
  lon: number;
  elevM: number;
  /** Observer position, km, body-fixed. */
  P: Vec3;
  up: Vec3;
  east: Vec3;
  north: Vec3;
}

/** Local East-North-Up frame at a surface point (elevation in metres above R_moon). */
export function siteFrame(latDeg: number, lonDeg: number, elevM = 0): SiteFrame {
  const cp = Math.cos(latDeg * DEG);
  const sp = Math.sin(latDeg * DEG);
  const cl = Math.cos(lonDeg * DEG);
  const sl = Math.sin(lonDeg * DEG);
  const r = R_MOON_KM + elevM / 1000;
  const up: Vec3 = [cp * cl, cp * sl, sp];
  let east: Vec3 = [-sl, cl, 0];
  let north: Vec3 = [-sp * cl, -sp * sl, cp];
  if (Math.abs(latDeg) > 89.99999) {
    // Pole convention: azimuth referenced to the prime meridian.
    east = [0, 1, 0];
    north = latDeg < 0 ? [1, 0, 0] : [-1, 0, 0];
  }
  return { lat: latDeg, lon: lonDeg, elevM, P: [up[0] * r, up[1] * r, up[2] * r], up, east, north };
}

/** Body-fixed -> Three.js scene axes (Y-up). */
export const bodyToScene = (v: Vec3): Vec3 => [v[0], v[2], -v[1]];
export const sceneToBody = (v: Vec3): Vec3 => [v[0], -v[2], v[1]];

export function fmtLat(lat: number, digits = 3) {
  return `${Math.abs(lat).toFixed(digits)}°${lat < 0 ? 'S' : 'N'}`;
}
export function fmtLon(lon: number, convention: '360' | '180' = '360', digits = 2) {
  if (convention === '360') return `${wrap360(lon).toFixed(digits)}°E`;
  const l = ((wrap360(lon) + 180) % 360) - 180;
  return `${Math.abs(l).toFixed(digits)}°${l < 0 ? 'W' : 'E'}`;
}

/** Great-circle surface distance between two lat/lon points (km on the reference sphere). */
export function surfaceDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = bodyFixed(lat1, lon1, 1);
  const b = bodyFixed(lat2, lon2, 1);
  const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(c) * R_MOON_KM;
}
