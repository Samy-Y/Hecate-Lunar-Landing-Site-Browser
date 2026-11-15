/**
 * Two-stage temporal event & launch-slip engine (spec v2.0 sec. 5.3).
 *
 * Stage 1 - coarse bracket scan at 1-hour steps over [t0 - slip, t0 + slip + T]
 *           of g(t) = theta(t) - h_mask(phi(t)) - theta_min, plus a grazing test:
 *           when two samples share a sign but the trajectory could touch the
 *           horizon in between (ridge maxima / valley minima along the swept
 *           azimuth arc), the hour is subdivided so short transients are not missed.
 * Stage 2 - Brent's method refines every bracketed crossing to <= 2 s.
 *
 * Three conditions are tracked:
 *   sun   : theta_sun - h >= max(theta_sun,min, offset(f_sun,min))   (lit & cleared)
 *   dark  : f_sun < f_sun,min                                         (darkness)
 *   earth : theta_earth - h >= theta_earth,min                        (geometric DTE)
 */
import { siteFrame, type SiteFrame } from '../lib/geo';
import { HOUR_MS, SUN_SEMIDIAMETER_DEG } from '../lib/math';
import { brent } from './brent';
import type { Criteria } from './criteria';
import { earthTopo, geometryAt, lerpGeometry, sunTopo, type Geometry } from './ephemeris';
import { arcExtreme, hAt, type HorizonProfile } from './horizon';
import { diskFraction, offsetForFraction } from './sunDisk';

export interface SiteContext {
  frame: SiteFrame;
  profile: HorizonProfile;
}

export function makeSite(lat: number, lon: number, elevM: number, profile: HorizonProfile): SiteContext {
  return { frame: siteFrame(lat, lon, elevM), profile };
}

interface Sample {
  t: number;
  g: Geometry;
  sEl: number;
  sAz: number;
  sH: number;
  sR: number;
  eEl: number;
  eAz: number;
  eH: number;
}

function sampleAt(site: SiteContext, t: number, g?: Geometry): Sample {
  const geo = g ?? geometryAt(t);
  const s = sunTopo(site.frame, geo);
  const e = earthTopo(site.frame, geo);
  return { t, g: geo, sEl: s.el, sAz: s.az, sH: hAt(site.profile, s.az), sR: s.radius, eEl: e.el, eAz: e.az, eH: hAt(site.profile, e.az) };
}

export type Interval = [number, number];
export type EventKind = 'sunrise' | 'sunset' | 'darkEnd' | 'darkStart' | 'earthRise' | 'earthSet';
export interface TemporalEvent {
  t: number;
  kind: EventKind;
  iterations: number;
}

export interface TimelineSeries {
  t: Float64Array;
  sunEl: Float32Array;
  sunAz: Float32Array;
  sunH: Float32Array;
  sunF: Float32Array;
  earthEl: Float32Array;
  earthAz: Float32Array;
  earthH: Float32Array;
}

export interface Timeline {
  tA: number;
  tB: number;
  sunOk: Interval[];
  dark: Interval[];
  earthOk: Interval[];
  events: TemporalEvent[];
  series: TimelineSeries;
  stats: { coarse: number; subdivided: number; brentEvals: number; ms: number };
  offsets: { sun: number; dark: number; earth: number };
}

type Kind = 'sun' | 'dark' | 'earth';

function toIntervals(tA: number, tB: number, startOn: boolean, crossings: number[]): Interval[] {
  const out: Interval[] = [];
  let on = startOn, from = tA;
  for (const c of crossings) {
    if (on) out.push([from, c]);
    else from = c;
    on = !on;
  }
  if (on) out.push([from, tB]);
  return out.filter(([a, b]) => b > a);
}

export function analyzeTimeline(site: SiteContext, crit: Criteria, range: { tA?: number; tB?: number } = {}): Timeline {
  const t0perf = performance.now();
  const tA = range.tA ?? crit.t0 - crit.slipH * HOUR_MS;
  const tB = range.tB ?? crit.t0 + (crit.slipH + crit.missionH) * HOUR_MS;
  const darkOff = offsetForFraction(crit.fSunMin, SUN_SEMIDIAMETER_DEG);
  const sunOff = Math.max(crit.sunMinEl, darkOff);
  const earthOff = crit.earthMinEl;
  const nCoarse = Math.max(2, Math.ceil((tB - tA) / HOUR_MS) + 1);

  const coarse: Sample[] = [];
  for (let i = 0; i < nCoarse; i++) coarse.push(sampleAt(site, Math.min(tB, tA + i * HOUR_MS)));

  const series: TimelineSeries = {
    t: new Float64Array(nCoarse), sunEl: new Float32Array(nCoarse), sunAz: new Float32Array(nCoarse), sunH: new Float32Array(nCoarse),
    sunF: new Float32Array(nCoarse), earthEl: new Float32Array(nCoarse), earthAz: new Float32Array(nCoarse), earthH: new Float32Array(nCoarse),
  };
  coarse.forEach((s, i) => {
    series.t[i] = s.t; series.sunEl[i] = s.sEl; series.sunAz[i] = s.sAz; series.sunH[i] = s.sH;
    series.sunF[i] = diskFraction(s.sEl, s.sH, s.sR);
    series.earthEl[i] = s.eEl; series.earthAz[i] = s.eAz; series.earthH[i] = s.eH;
  });

  const offset = (k: Kind) => (k === 'earth' ? earthOff : k === 'sun' ? sunOff : darkOff);
  const g = (s: Sample, k: Kind) => (k === 'earth' ? s.eEl - s.eH : s.sEl - s.sH) - offset(k);
  const el = (s: Sample, k: Kind) => (k === 'earth' ? s.eEl : s.sEl);
  const az = (s: Sample, k: Kind) => (k === 'earth' ? s.eAz : s.sAz);

  let subdivided = 0, brentEvals = 0;
  const events: TemporalEvent[] = [];

  const crossingsFor = (k: Kind): number[] => {
    const out: number[] = [];
    const fn = (t: number) => {
      brentEvals++;
      return g(sampleAt(site, t), k);
    };
    const refine = (ta: number, tb: number, ga: number, gb: number) => {
      const r = brent(fn, ta, tb, ga, gb, 2000);
      out.push(r.x);
      const rising = gb > ga;
      const kind: EventKind = k === 'sun' ? (rising ? 'sunrise' : 'sunset') : k === 'dark' ? (rising ? 'darkEnd' : 'darkStart') : rising ? 'earthRise' : 'earthSet';
      events.push({ t: r.x, kind, iterations: r.iterations });
    };
    for (let i = 0; i < nCoarse - 1; i++) {
      const a = coarse[i], b = coarse[i + 1];
      const ga = g(a, k), gb = g(b, k);
      if (ga * gb < 0) {
        refine(a.t, b.t, ga, gb);
        continue;
      }
      // Grazing test: could the trajectory touch the horizon inside this hour?
      const off = offset(k);
      const graze = ga > 0
        ? Math.min(el(a, k), el(b, k)) - 0.05 - arcExtreme(site.profile, az(a, k), az(b, k), true) - off < 0
        : Math.max(el(a, k), el(b, k)) + 0.05 - arcExtreme(site.profile, az(a, k), az(b, k), false) - off > 0;
      if (!graze) continue;
      subdivided++;
      const sweep = Math.abs(((az(b, k) - az(a, k) + 540) % 360) - 180);
      const nSub = Math.min(48, Math.max(4, Math.ceil((2 * sweep * site.profile.n) / 360)));
      let prev = a, gp = ga;
      for (let j = 1; j <= nSub; j++) {
        const tj = a.t + ((b.t - a.t) * j) / nSub;
        const sj = j === nSub ? b : sampleAt(site, tj, lerpGeometry(a.g, b.g, j / nSub, tj));
        const gj = g(sj, k);
        if (gp * gj < 0) refine(prev.t, sj.t, gp, gj);
        prev = sj;
        gp = gj;
      }
    }
    out.sort((x, y) => x - y);
    return out;
  };

  const sunOk = toIntervals(tA, tB, g(coarse[0], 'sun') >= 0, crossingsFor('sun'));
  const lit = toIntervals(tA, tB, g(coarse[0], 'dark') >= 0, crossingsFor('dark'));
  const earthOk = toIntervals(tA, tB, g(coarse[0], 'earth') >= 0, crossingsFor('earth'));
  // Darkness = complement of "disk fraction >= f_min".
  const dark: Interval[] = [];
  let cur = tA;
  for (const [a, b] of lit) {
    if (a > cur) dark.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (cur < tB) dark.push([cur, tB]);
  events.sort((a, b) => a.t - b.t);

  return {
    tA, tB, sunOk, dark, earthOk, events, series,
    stats: { coarse: nCoarse, subdivided, brentEvals, ms: performance.now() - t0perf },
    offsets: { sun: sunOff, dark: darkOff, earth: earthOff },
  };
}

function overlap(iv: Interval[], a: number, b: number) {
  let s = 0;
  for (const [p, q] of iv) s += Math.max(0, Math.min(q, b) - Math.max(p, a));
  return s;
}

export interface MissionMetrics {
  /** Continuous post-landing insolation D_sun (h), capped at T_mission. */
  dSunH: number;
  /** Longest continuous darkness within the mission D_dark (h). */
  dDarkH: number;
  /** Geometric DTE duty cycle C_earth (%). */
  cEarth: number;
}

export function metricsAt(tl: Timeline, tLand: number, missionH: number): MissionMetrics {
  const T = missionH * HOUR_MS;
  const end = tLand + T;
  let dSun = 0;
  for (const [a, b] of tl.sunOk) if (a <= tLand + 1 && b > tLand) dSun = Math.min(b, end) - tLand;
  let dDark = 0;
  for (const [a, b] of tl.dark) dDark = Math.max(dDark, Math.max(0, Math.min(b, end) - Math.max(a, tLand)));
  return { dSunH: dSun / HOUR_MS, dDarkH: dDark / HOUR_MS, cEarth: (100 * overlap(tl.earthOk, tLand, end)) / T };
}

export function temporalPass(m: MissionMetrics, c: Criteria): boolean {
  return m.dSunH >= c.dSunMinH - 1e-6 && m.dDarkH <= c.dDarkMaxH + 1e-6 && (!c.dteRequired || m.cEarth >= c.cEarthMin - 1e-6);
}

/**
 * Viable landing windows inside [from, to]: 10-minute scan of the temporal gate,
 * boundaries refined by bisection to ~0.15 s. Requires the timeline to cover
 * [from, to + T_mission].
 */
export function viableWindows(tl: Timeline, c: Criteria, terrainOk: boolean, from: number, to: number) {
  if (!terrainOk) return { windows: [] as Interval[], availability: 0 };
  to = Math.min(to, tl.tB - c.missionH * HOUR_MS);
  const ok = (t: number) => temporalPass(metricsAt(tl, t, c.missionH), c);
  if (to <= from) {
    const p = ok(from);
    return { windows: p ? ([[from, from]] as Interval[]) : [], availability: p ? 100 : 0 };
  }
  const step = 10 * 60_000;
  const windows: Interval[] = [];
  const bisect = (lo: number, hi: number, loState: boolean) => {
    for (let i = 0; i < 12; i++) {
      const m = (lo + hi) / 2;
      if (ok(m) === loState) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  let prevT = from, prev = ok(from), start = from;
  for (let t = from + step; t < to + step; t += step) {
    const tc = Math.min(t, to);
    const s = ok(tc);
    if (s !== prev) {
      const edge = bisect(prevT, tc, prev);
      if (s) start = edge;
      else windows.push([start, edge]);
    }
    prevT = tc;
    prev = s;
    if (tc >= to) break;
  }
  if (prev) windows.push([start, to]);
  const total = windows.reduce((s, [a, b]) => s + (b - a), 0);
  return { windows, availability: (100 * total) / (to - from) };
}

/** Instantaneous Sun/Earth state for the scrubbed epoch (panorama + telemetry). */
export function instant(site: SiteContext, t: number) {
  const s = sampleAt(site, t);
  return {
    t,
    sun: { az: s.sAz, el: s.sEl, h: s.sH, f: diskFraction(s.sEl, s.sH, s.sR), radius: s.sR },
    earth: { az: s.eAz, el: s.eEl, h: s.eH, clearance: s.eEl - s.eH },
    subSolar: s.g.subSolar,
    subEarth: s.g.subEarth,
  };
}
