/**
 * Coordinate-consistency and power-model tests (3D-mapping review: "verify that the six cube faces,
 * the polar stereographic analysis grid and the lunar body-fixed system remain aligned").
 */
import { describe, expect, it } from 'vitest';
import { bodyFixed, bodyToScene, latLonToPolar, polarScale, polarToLatLon, sceneToBody, unitToLatLon } from '../lib/geo';
import { faceDir, FACES } from '../components/globe/TerrainSystem';
import { cosIncidence, missionPower, powerAt, SOLAR_CONSTANT, AU_KM, DEFAULT_POWER } from './power';
import type { Vec3 } from '../lib/math';

let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe('coordinate contract', () => {
  it('polar stereographic round trip is exact to 1e-9 deg (80S-90S)', () => {
    for (let i = 0; i < 2000; i++) {
      const lat = -80 - rnd() * 9.999, lon = rnd() * 360;
      const [x, y] = latLonToPolar(lat, lon);
      const [la, lo] = polarToLatLon(x, y);
      expect(Math.abs(la - lat)).toBeLessThan(1e-9);
      expect(Math.abs(((lo - lon + 540) % 360) - 180)).toBeLessThan(1e-7);
    }
  });
  it('prime meridian points to +Y and 90E to +X (spec 4.1)', () => {
    const [x0, y0] = latLonToPolar(-85, 0);
    const [x1, y1] = latLonToPolar(-85, 90);
    expect(Math.abs(x0)).toBeLessThan(1e-6);
    expect(y0).toBeGreaterThan(0);
    expect(x1).toBeGreaterThan(0);
    expect(Math.abs(y1)).toBeLessThan(1e-6);
  });
  it('stereographic scale factor k = 1/cos^2(colat/2) is conformal', () => {
    const lat = -86, h = 1e-6;
    const [xa, ya] = latLonToPolar(lat, 10), [xb] = latLonToPolar(lat, 10 + h);
    const [, yc] = latLonToPolar(lat + h, 0);
    const [, yd] = latLonToPolar(lat, 0);
    const R = 1737400, d2r = Math.PI / 180;
    const kEast = Math.hypot(xb - xa, 0) / (R * Math.cos(lat * d2r) * h * d2r * Math.cos(10 * d2r));
    const kNorth = Math.abs(yc - yd) / (R * h * d2r);
    expect(kNorth).toBeCloseTo(polarScale(xa, ya), 4);
    expect(Math.abs(kEast - kNorth) / kNorth).toBeLessThan(0.02);
  });
  it('scene mapping (bx, bz, -by) is a proper rotation with an exact inverse', () => {
    const v: Vec3 = [0.3, -0.5, 0.81];
    expect(sceneToBody(bodyToScene(v))).toEqual(v);
    const ex = bodyToScene([1, 0, 0]), ey = bodyToScene([0, 1, 0]), ez = bodyToScene([0, 0, 1]);
    const det = ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) - ex[1] * (ey[0] * ez[2] - ey[2] * ez[0]) + ex[2] * (ey[0] * ez[1] - ey[1] * ez[0]);
    expect(det).toBe(1);
  });
  it('body-fixed <-> lat/lon round trip', () => {
    for (let i = 0; i < 500; i++) {
      const lat = rnd() * 180 - 90, lon = rnd() * 360 - 180;
      const [la, lo] = unitToLatLon(bodyFixed(lat, lon, 1));
      expect(Math.abs(la - lat)).toBeLessThan(1e-9);
      if (Math.abs(lat) < 89.999) expect(Math.abs(((lo - lon + 540) % 360) - 180)).toBeLessThan(1e-7);
    }
  });
});

describe('cube-sphere quadtree geometry', () => {
  it('face axes are right-handed (u x v = n) and the -Z face is centred on the South Pole', () => {
    for (const f of FACES) {
      const c: Vec3 = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]];
      c.forEach((v, i) => expect(v + 0).toBeCloseTo(f.n[i], 12));
    }
    const d: Vec3 = [0, 0, 0];
    faceDir(5, 0, 0, d);
    expect(unitToLatLon(d)[0]).toBeCloseTo(-90, 9);
  });
  it('every direction on the sphere maps to exactly one face point and back', () => {
    const d: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const lat = Math.asin(rnd() * 2 - 1) * (180 / Math.PI), lon = rnd() * 360;
      const p = bodyFixed(lat, lon, 1);
      // face = axis of largest |component|, then invert the equal-angle warp
      let fi = 0, best = -1;
      FACES.forEach((f, k) => {
        const dp = p[0] * f.n[0] + p[1] * f.n[1] + p[2] * f.n[2];
        if (dp > best) { best = dp; fi = k; }
      });
      const f = FACES[fi];
      const a = (p[0] * f.u[0] + p[1] * f.u[1] + p[2] * f.u[2]) / best;
      const b = (p[0] * f.v[0] + p[1] * f.v[1] + p[2] * f.v[2]) / best;
      const s = (Math.atan(a) * 4) / Math.PI, t = (Math.atan(b) * 4) / Math.PI;
      expect(Math.abs(s)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(t)).toBeLessThanOrEqual(1 + 1e-9);
      faceDir(fi, s, t, d);
      expect(Math.hypot(d[0] - p[0], d[1] - p[1], d[2] - p[2])).toBeLessThan(1e-9);
    }
  });
  it('shared face edges coincide (no geometric seam between faces)', () => {
    // +X face right edge (s = 1) is the +Y face's left edge (s = -1) after its own (t) parameter.
    const a: Vec3 = [0, 0, 0], b: Vec3 = [0, 0, 0];
    for (const t of [-0.9, -0.3, 0, 0.4, 0.95]) {
      faceDir(0, 1, t, a);
      faceDir(2, -1, t, b);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-12);
    }
  });
});

describe('polar pyramid alignment', () => {
  it('level-0 pixel edges coincide with the PDS 5 m and PGDA 80 m grids', () => {
    const W = 327680;
    expect((W - 15168 * 5) % 5).toBe(0); // PDS LDEM_875S_5M: 30336 px, pole on a pixel corner
    expect((W - 304000) % 80).toBe(0); // PGDA Product 90 80 m map spans +/-304 km
    expect((W - 19000) % 5).toBe(0); // Product 78 boxes are 1 km aligned
  });
});

describe('solar power model', () => {
  it('cos i: vertical Sun-tracking panel at grazing Sun = 1, flat panel = sin(el)', () => {
    expect(cosIncidence(0, 123, { ...DEFAULT_POWER, tiltDeg: 90, azMode: 'track' })).toBeCloseTo(1, 12);
    expect(cosIncidence(30, 10, { ...DEFAULT_POWER, tiltDeg: 0 })).toBeCloseTo(0.5, 12);
    expect(cosIncidence(5, 180, { ...DEFAULT_POWER, tiltDeg: 90, azMode: 'fixed', azDeg: 0 })).toBeLessThan(0);
  });
  it('P = 1361 W/m2 x A x eta x (1 - L) at 1 AU, normal incidence, full disk', () => {
    const p = { ...DEFAULT_POWER, areaM2: 2, efficiency: 0.3, lossesPct: 10, tiltDeg: 90, azMode: 'track' as const };
    expect(powerAt(0, 0, 1, AU_KM, p)).toBeCloseTo(SOLAR_CONSTANT * 2 * 0.3 * 0.9, 9);
    expect(powerAt(0, 0, 0.5, AU_KM, p)).toBeCloseTo(SOLAR_CONSTANT * 2 * 0.3 * 0.9 * 0.5, 9);
  });
  it('mission energy integrates the hourly series (trapezoid)', () => {
    const n = 25;
    const series = {
      t: Float64Array.from({ length: n }, (_, i) => i * 3.6e6), sunEl: new Float32Array(n).fill(0), sunAz: new Float32Array(n),
      sunH: new Float32Array(n), sunF: new Float32Array(n).fill(1), earthEl: new Float32Array(n), earthAz: new Float32Array(n), earthH: new Float32Array(n),
    };
    const r = missionPower(series, 0, 24, AU_KM, { ...DEFAULT_POWER, areaM2: 1, efficiency: 1, lossesPct: 0, tiltDeg: 90, azMode: 'track' });
    expect(r.energyKWh).toBeCloseTo((SOLAR_CONSTANT * 24) / 1000, 6);
    expect(r.meanW).toBeCloseTo(SOLAR_CONSTANT, 6);
  });
});
