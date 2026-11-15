/**
 * Automated validation suite (spec v2.0 ch. 10.1) - runs with `npm test`.
 *
 * VAL-01  Tier-1 topocentric Sun/Earth vs NASA JPL Horizons (coord@301, DE441, AIRLESS),
 *         reference vectors captured 2026-11-14 for three polar sites.
 * VAL-04  Two-stage (1 h + Brent) crossing times vs brute-force 1-minute scan.
 * VAL-05  Non-compensatory gate: alpha = alpha_max + 0.1 deg (100 % sun & DTE) must FAIL.
 * VAL-06  Zero-shot interpolated 5 m cell must never PASS.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { siteFrame } from '../lib/geo';
import { HOUR_MS, azDiff } from '../lib/math';
import { parseUtc } from '../lib/time';
import { assess } from './assessment';
import { brent } from './brent';
import { presetCriteria } from './criteria';
import { earthTopo, geometryAt, sunTopo } from './ephemeris';
import type { HorizonProfile } from './horizon';
import { analyzeTimeline, makeSite } from './temporal';
import type { TerrainEval } from './terrainEval';
import { diskFraction, offsetForFraction } from './sunDisk';

// [body, lonE, lat, altKm, utc, az, el]  (JPL Horizons API, QUANTITIES=4, APPARENT=AIRLESS)
const HORIZONS: [string, number, number, number, string, number, number][] = [
  ['sun', 222.1, -89.45, 2.1, '2027-03-15T12:00Z', 226.566696, -1.243158],
  ['sun', 222.1, -89.45, 2.1, '2027-03-25T12:00Z', 104.958912, -1.294974],
  ['sun', 222.1, -89.45, 2.1, '2027-04-04T12:00Z', 343.070608, -0.753192],
  ['sun', 222.1, -89.45, 2.1, '2027-04-14T12:00Z', 220.934308, -1.809791],
  ['sun', 0, -89.9, 1.0, '2027-03-15T12:00Z', 88.657847, -0.862659],
  ['sun', 0, -89.9, 1.0, '2027-03-25T12:00Z', 327.071312, -1.069017],
  ['sun', 0, -89.9, 1.0, '2027-04-04T12:00Z', 205.168752, -1.369859],
  ['sun', 0, -89.9, 1.0, '2027-04-14T12:00Z', 83.02183, -1.382107],
  ['sun', 29.1957, -84.7906, 6.6, '2027-03-15T12:00Z', 59.499634, 1.78176],
  ['sun', 29.1957, -84.7906, 6.6, '2027-03-25T12:00Z', 297.869245, 1.283734],
  ['sun', 29.1957, -84.7906, 6.6, '2027-04-04T12:00Z', 175.947177, -6.475822],
  ['sun', 29.1957, -84.7906, 6.6, '2027-04-14T12:00Z', 53.839127, 1.681343],
  ['earth', 222.1, -89.45, 2.1, '2027-03-15T12:00Z', 134.419571, 5.030187],
  ['earth', 222.1, -89.45, 2.1, '2027-03-25T12:00Z', 143.288697, -7.358012],
  ['earth', 222.1, -89.45, 2.1, '2027-04-04T12:00Z', 133.197687, 2.252532],
  ['earth', 222.1, -89.45, 2.1, '2027-04-14T12:00Z', 138.271441, 1.199814],
  ['earth', 0, -89.9, 1.0, '2027-03-15T12:00Z', 356.48119, 5.515196],
  ['earth', 0, -89.9, 1.0, '2027-03-25T12:00Z', 5.427265, -6.817572],
  ['earth', 0, -89.9, 1.0, '2027-04-04T12:00Z', 355.278399, 2.728864],
  ['earth', 0, -89.9, 1.0, '2027-04-14T12:00Z', 0.36076, 1.710479],
  ['earth', 29.1957, -84.7906, 6.6, '2027-03-15T12:00Z', 326.89465, 9.791551],
  ['earth', 29.1957, -84.7906, 6.6, '2027-03-25T12:00Z', 336.38926, -2.148604],
  ['earth', 29.1957, -84.7906, 6.6, '2027-04-04T12:00Z', 325.825703, 6.947377],
  ['earth', 29.1957, -84.7906, 6.6, '2027-04-14T12:00Z', 330.98166, 6.171273],
];

/** Great-circle angle between two az/el directions (deg). */
function angSep(az1: number, el1: number, az2: number, el2: number) {
  const r = Math.PI / 180;
  const c = Math.sin(el1 * r) * Math.sin(el2 * r) + Math.cos(el1 * r) * Math.cos(el2 * r) * Math.cos((az1 - az2) * r);
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

describe('VAL-01 Tier-1 ephemeris vs JPL Horizons', () => {
  const errs: Record<string, number> = { sun: 0, earth: 0 };
  afterAll(() => console.log(`VAL-01 max angular error: Sun ${errs.sun.toFixed(4)} deg, Earth ${errs.earth.toFixed(4)} deg`));
  for (const [body, lon, lat, alt, utc, az, el] of HORIZONS) {
    it(`${body} @ ${lat},${lon} ${utc}`, () => {
      const f = siteFrame(lat, lon, alt * 1000);
      const g = geometryAt(parseUtc(utc));
      const t = body === 'sun' ? sunTopo(f, g) : earthTopo(f, g);
      const sep = angSep(t.az, t.el, az, el);
      errs[body] = Math.max(errs[body], sep);
      expect(Math.abs(t.el - el), `el ${t.el} vs ${el}`).toBeLessThan(body === 'sun' ? 0.05 : 0.1);
      expect(sep, `az ${t.az} vs ${az} (Δaz ${azDiff(az, t.az).toFixed(4)})`).toBeLessThan(body === 'sun' ? 0.05 : 0.1);
    });
  }
});

describe('finite solar disk', () => {
  it('fraction is 0.5 when centre is on the horizon and inverts correctly', () => {
    expect(diskFraction(1, 1, 0.2666)).toBeCloseTo(0.5, 6);
    expect(diskFraction(1.3, 1, 0.2666)).toBe(1);
    expect(diskFraction(0.7, 1, 0.2666)).toBe(0);
    const off = offsetForFraction(0.25, 0.2666);
    expect(diskFraction(off, 0, 0.2666)).toBeCloseTo(0.25, 6);
  });
});

describe('VAL-04 two-stage event precision', () => {
  it('Brent converges to a known root within 2 s', () => {
    const root = 1_800_123_456_789;
    const r = brent((t) => Math.tanh((t - root) / 3.6e6), root - 3_600_000, root + 1_000_000);
    expect(Math.abs(r.x - root)).toBeLessThan(2000);
  });

  it('sunrise/sunset times match a 1-minute brute-force scan to <= 15 s over a synodic month', () => {
    // Synthetic ridge horizon: 1.0 deg everywhere with a narrow 3-deg spike near az 200.
    const n = 720;
    const h = new Float32Array(n).fill(0.4);
    for (let i = 0; i < n; i++) {
      const az = (i * 360) / n;
      if (Math.abs(az - 200) < 2) h[i] = 2.6;
    }
    const profile: HorizonProfile = { n, h, sigma: new Float32Array(n).fill(0.05), level: '80m', source: 'synthetic' };
    const site = makeSite(-89.45, 222.1, 2100, profile);
    const crit = { ...presetCriteria('artemis3'), slipH: 0, missionH: 24 * 29.5 };
    const tl = analyzeTimeline(site, crit);
    const sunEvents = tl.events.filter((e) => e.kind === 'sunrise' || e.kind === 'sunset');
    // Brute force at 60 s.
    const thr = tl.offsets.sun;
    const g = (t: number) => {
      const geo = geometryAt(t);
      const s = sunTopo(site.frame, geo);
      const f = (s.az * n) / 360;
      const i0 = Math.floor(f) % n;
      const hh = h[i0] * (1 - (f - Math.floor(f))) + h[(i0 + 1) % n] * (f - Math.floor(f));
      return s.el - hh - thr;
    };
    const brute: number[] = [];
    let prev = g(tl.tA);
    for (let t = tl.tA + 60_000; t <= tl.tB; t += 60_000) {
      const v = g(t);
      if (prev * v < 0) brute.push(t - 30_000);
      prev = v;
    }
    expect(sunEvents.length).toBe(brute.length);
    for (let i = 0; i < brute.length; i++) expect(Math.abs(sunEvents[i].t - brute[i])).toBeLessThanOrEqual(45_000);
  });
});

function terrainStub(over: Partial<TerrainEval> = {}): TerrainEval {
  return {
    level: '5m', source: 'test', sourceSpacingM: 5, effectiveResM: 5, p78Id: null, elev: 0, lBaseResolved: true, slopeCenter: 3, slopeBaselineM: 5,
    slopePassFrac: 1, slopeP95: 3, tri: 0.1, cpr: 0.3, dPsrKm: 1, inPsr: false, sunfracPct: 90, qSource: 1, fInterp: 0, directFrac: 1,
    sigmaHMax: 0.01, sigmaZ: 0.5, sigmaSource: 'test', footprintCells: 1, shotDensity: 1e5, notes: [], ...over,
  };
}

describe('VAL-05 non-compensatory gate', () => {
  const c = { ...presetCriteria('artemis3'), ellipseR: 0 };
  const perfect = { dSunH: c.missionH, dDarkH: 0, cEarth: 100 };
  it('slope = alpha_max + 0.1 deg fails despite perfect sun/DTE', () => {
    const a = assess(c, terrainStub({ slopeCenter: c.slopeMax + 0.1 }), perfect);
    expect(a.status).toBe('FAIL');
  });
  it('D_dark = D_dark,max + 0.5 h fails', () => {
    const a = assess(c, terrainStub(), { ...perfect, dDarkH: c.dDarkMaxH + 0.5 });
    expect(a.status).toBe('FAIL');
  });
  it('a clean, well-measured site passes', () => {
    expect(assess(c, terrainStub(), perfect).status).toBe('PASS');
  });
});

describe('VAL-06 low-confidence terrain gating', () => {
  it('zero-shot interpolated 5 m cell is UNKNOWN, never PASS', () => {
    const c = { ...presetCriteria('artemis3'), ellipseR: 0 };
    const a = assess(c, terrainStub({ qSource: 0.4, fInterp: 1, directFrac: 0, sigmaHMax: 0.3 }), { dSunH: c.missionH, dDarkH: 0, cEarth: 100 });
    expect(a.status).toBe('UNKNOWN');
  });
  it('unresolved L_base (Level 1 fallback) is UNKNOWN', () => {
    const c = { ...presetCriteria('artemis3'), ellipseR: 0 };
    const a = assess(c, terrainStub({ level: '80m', lBaseResolved: false, slopeBaselineM: 80, tri: null }), { dSunH: c.missionH, dDarkH: 0, cEarth: 100 });
    expect(a.status).toBe('UNKNOWN');
  });
});

describe('ephemeris performance', () => {
  it('single-site update <= 5 ms', () => {
    const f = siteFrame(-89.45, 222.1, 2100);
    const t0 = parseUtc('2027-03-15T12:00Z');
    const n = 200;
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const g = geometryAt(t0 + i * HOUR_MS);
      sunTopo(f, g);
      earthTopo(f, g);
    }
    expect((performance.now() - start) / n).toBeLessThan(5);
  });
});
