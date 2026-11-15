/**
 * Forward-search regional screening over the 80S-90S horizon grid (spec v2.0 Workflow A, Phase 3).
 *
 * Geometry stage (cached per t0 / slip / T_mission / landing range): for every valid horizon cell and every
 * hour in [t0 - slip, t0 + slip + T], store theta - h_mask(phi) for the Sun and the Earth as
 * int16 centi-degrees. Threshold stage (re-run on every slider change, ~10-30 ms): derive
 * D_sun, D_dark, C_earth with sub-hour linear crossing interpolation, apply the hard gates,
 * score suitability / confidence, and count viable landing hours across the slip window.
 *
 * Heatmap feasibility codes:  0 = FAIL, 1 = CANDIDATE (regional screen passed, footpad slope
 * unresolved at L_base -> UNKNOWN), 2 = PASS (only if L_base is resolved and C_data >= min).
 */
import { polarToLatLon, siteFrame } from '../lib/geo';
import { HOUR_MS, RAD, SUN_SEMIDIAMETER_DEG } from '../lib/math';
import { confidenceScore, suitability, utilities } from './assessment';
import type { Criteria } from './criteria';
import { geometryAt } from './ephemeris';
import type { RegionalData } from './regional';
import { offsetForFraction } from './sunDisk';

export const FAIL_BITS = { slope: 1, dsun: 2, ddark: 4, dte: 8, cpr: 16, psr: 32 } as const;

interface GeometryCache {
  key: string;
  hours: number;
  cells: Int32Array;
  gs: Int16Array; // sun   (el - h) * 100
  ge: Int16Array; // earth (el - h) * 100
}

let cache: GeometryCache | null = null;

/** Geometry range: the slip window plus the mission, extended to include the landing epoch. */
function rangeFor(c: Criteria, tLand: number) {
  const tA = Math.min(c.t0 - c.slipH * HOUR_MS, tLand);
  const tEnd = Math.max(c.t0 + c.slipH * HOUR_MS, tLand) + c.missionH * HOUR_MS;
  return { tA, hours: Math.round((tEnd - tA) / HOUR_MS) + 1 };
}

function buildGeometry(d: RegionalData, c: Criteria, tLand: number, progress?: (f: number) => void): GeometryCache & { tA: number } {
  const { tA, hours } = rangeFor(c, tLand);
  const key = `${tA}|${hours}|${c.t0}|${c.slipH}`;
  if (cache && cache.key === key) return cache as GeometryCache & { tA: number };
  const g = d.hzGrid;
  const n = g.n;
  const list: number[] = [];
  for (let i = 0; i < n * n; i++) if (d.hz[i * 360] !== -32768) list.push(i);
  const cells = Int32Array.from(list);
  const N = cells.length;
  const P = new Float64Array(N * 3), U = new Float64Array(N * 3), E = new Float64Array(N * 3), No = new Float64Array(N * 3);
  for (let k = 0; k < N; k++) {
    const idx = cells[k];
    const row = Math.floor(idx / n), col = idx % n;
    const x = g.x0 + (col + 0.5) * g.dx_m, y = g.y0 - (row + 0.5) * g.dx_m;
    const [lat, lon] = polarToLatLon(x, y);
    const f = siteFrame(lat, lon, d.dem.sample(x, y) || 0);
    for (let j = 0; j < 3; j++) {
      P[k * 3 + j] = f.P[j]; U[k * 3 + j] = f.up[j]; E[k * 3 + j] = f.east[j]; No[k * 3 + j] = f.north[j];
    }
  }
  const gs = new Int16Array(N * hours), ge = new Int16Array(N * hours);
  const hz = d.hz;
  for (let hIdx = 0; hIdx < hours; hIdx++) {
    const geo = geometryAt(tA + hIdx * HOUR_MS);
    for (let body = 0; body < 2; body++) {
      const v = body === 0 ? geo.sun : geo.earth;
      const out = body === 0 ? gs : ge;
      for (let k = 0; k < N; k++) {
        const dx = v[0] - P[k * 3], dy = v[1] - P[k * 3 + 1], dz = v[2] - P[k * 3 + 2];
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        const u = (dx * U[k * 3] + dy * U[k * 3 + 1] + dz * U[k * 3 + 2]) * inv;
        const e = dx * E[k * 3] + dy * E[k * 3 + 1] + dz * E[k * 3 + 2];
        const nn = dx * No[k * 3] + dy * No[k * 3 + 1] + dz * No[k * 3 + 2];
        let az = Math.atan2(e, nn) * RAD;
        if (az < 0) az += 360;
        const b0 = Math.floor(az) % 360, t = az - Math.floor(az);
        const base = cells[k] * 360;
        const h = (hz[base + b0] * (1 - t) + hz[base + ((b0 + 1) % 360)] * t) * 0.01;
        const val = (Math.asin(u) * RAD - h) * 100;
        out[k * hours + hIdx] = val > 32767 ? 32767 : val < -32767 ? -32767 : val;
      }
    }
    if (progress && hIdx % 24 === 0) progress(hIdx / hours);
  }
  cache = { key, hours, cells, gs, ge, tA } as GeometryCache & { tA: number };
  return cache as GeometryCache & { tA: number };
}

/** Hours of continuous g >= thr starting at index s (fractional end), capped at cap. */
function runFrom(a: Int16Array, base: number, hours: number, s: number, thr: number, cap: number) {
  if (a[base + s] < thr) return 0;
  for (let i = s; i < Math.min(hours - 1, s + cap); i++) {
    const p = a[base + i], q = a[base + i + 1];
    if (q < thr) return Math.min(cap, i - s + (p - thr) / (p - q));
  }
  return Math.min(cap, hours - 1 - s);
}

export interface Candidate {
  idx: number;
  x: number;
  y: number;
  lat: number;
  lon: number;
  suit: number;
  conf: number;
  avail: number;
}

export interface ForwardResult {
  n: number;
  status: Uint8Array; // 255 = no data
  suit: Float32Array;
  conf: Float32Array;
  avail: Float32Array;
  dSun: Float32Array;
  dDark: Float32Array;
  cEarth: Float32Array;
  fail: Uint8Array;
  top: Candidate[];
  counts: { cells: number; fail: number; candidates: number; pass: number; byReason: Record<keyof typeof FAIL_BITS, number> };
  ms: { geometry: number; thresholds: number };
  cached: boolean;
  lBase: number;
  regionalDx: number;
  tLand: number;
}

export function forwardSearch(d: RegionalData, c: Criteria, tLand: number, progress?: (f: number) => void): ForwardResult {
  const t0 = performance.now();
  const rg = rangeFor(c, tLand);
  const hadCache = cache !== null && cache.key === `${rg.tA}|${rg.hours}|${c.t0}|${c.slipH}`;
  const geo = buildGeometry(d, c, tLand, progress);
  const t1 = performance.now();
  const g = d.hzGrid;
  const n = g.n;
  const NN = n * n;
  const H = geo.hours;
  const darkOff = offsetForFraction(c.fSunMin, SUN_SEMIDIAMETER_DEG);
  const sunThr = Math.max(c.sunMinEl, darkOff) * 100;
  const darkThr = darkOff * 100;
  const earthThr = c.earthMinEl * 100;
  const M = Math.round(c.missionH);
  // Landing index inside the cached hourly geometry (start of the pink mission window).
  const slip = Math.max(0, Math.min(H - 1 - M, Math.round((tLand - geo.tA) / HOUR_MS)));
  const slipStart = Math.max(0, Math.round((c.t0 - c.slipH * HOUR_MS - geo.tA) / HOUR_MS));
  const slipSpan = Math.round(2 * c.slipH);
  const status = new Uint8Array(NN).fill(255);
  const fail = new Uint8Array(NN);
  const suit = new Float32Array(NN).fill(NaN);
  const conf = new Float32Array(NN).fill(NaN);
  const avail = new Float32Array(NN).fill(NaN);
  const dSunA = new Float32Array(NN).fill(NaN);
  const dDarkA = new Float32Array(NN).fill(NaN);
  const cEarthA = new Float32Array(NN).fill(NaN);
  const byReason = { slope: 0, dsun: 0, ddark: 0, dte: 0, cpr: 0, psr: 0 };
  let nFail = 0, nCand = 0, nPass = 0;
  const S = new Int32Array(H + 1), F = new Int32Array(H + 1), Lp = new Int32Array(H + 1), Dp = new Int32Array(H + 1);
  const regionalDx = 80; // slope screen uses the PGDA Product 90 80 m DEM baseline

  for (let k = 0; k < geo.cells.length; k++) {
    const idx = geo.cells[k];
    const row = Math.floor(idx / n), col = idx % n;
    const x = g.x0 + (col + 0.5) * g.dx_m, y = g.y0 - (row + 0.5) * g.dx_m;
    const base = k * H;
    const slope = d.slope.sample(x, y);
    const cpr = d.cpr.sample(x, y);
    const dPsr = d.psrDist.sample(x, y);
    const dens = d.dens.sample(x, y);

    const dSun = runFrom(geo.gs, base, H, slip, sunThr, M);
    // D_dark and C_earth across [slip, slip + M] with fractional crossings.
    let longest = 0, run = 0, earthH = 0;
    for (let i = slip; i < slip + M; i++) {
      const a = geo.gs[base + i], b = geo.gs[base + i + 1];
      const da = a < darkThr, db = b < darkThr;
      if (da && db) run += 1;
      else if (da !== db) {
        const f = (a - darkThr) / (a - b);
        if (da) { run += f; longest = Math.max(longest, run); run = 0; }
        else { longest = Math.max(longest, run); run = 1 - f; }
      } else { longest = Math.max(longest, run); run = 0; }
      const ea = geo.ge[base + i], eb = geo.ge[base + i + 1];
      const va = ea >= earthThr, vb = eb >= earthThr;
      if (va && vb) earthH += 1;
      else if (va !== vb) {
        const f = (ea - earthThr) / (ea - eb);
        earthH += va ? f : 1 - f;
      }
    }
    longest = Math.max(longest, run);
    const cEarth = (100 * earthH) / M;

    let bits = 0;
    if (slope > c.slopeMax) bits |= FAIL_BITS.slope;
    if (dSun < c.dSunMinH - 1e-6) bits |= FAIL_BITS.dsun;
    if (longest > c.dDarkMaxH + 1e-6) bits |= FAIL_BITS.ddark;
    if (c.dteRequired && cEarth < c.cEarthMin - 1e-6) bits |= FAIL_BITS.dte;
    if (c.cprGate && cpr > c.cprMax) bits |= FAIL_BITS.cpr;
    if (c.psrFilter && dPsr > c.dPsrMax) bits |= FAIL_BITS.psr;

    // Launch-slip availability: hourly landing offsets inside [t0 - slip, t0 + slip].
    let viable = 0;
    if (!(bits & (FAIL_BITS.slope | FAIL_BITS.cpr | FAIL_BITS.psr))) {
      const Z = Math.floor(c.dDarkMaxH + 1e-6);
      S[H] = 0; F[H] = 0; Lp[0] = 0; Dp[0] = 0;
      for (let i = H - 1; i >= 0; i--) {
        S[i] = geo.gs[base + i] >= sunThr ? S[i + 1] + 1 : 0;
        F[i] = geo.gs[base + i] < darkThr ? F[i + 1] + 1 : 0;
      }
      for (let i = 0; i < H; i++) {
        Lp[i + 1] = Lp[i] + (geo.ge[base + i] >= earthThr ? 1 : 0);
        Dp[i + 1] = Dp[i] + (F[i] > Z ? 1 : 0);
      }
      for (let s = slipStart; s <= slipStart + slipSpan && s + M <= H; s++) {
        if (Math.min(S[s], M) < c.dSunMinH - 1e-6) continue;
        const last = s + M - Z - 1;
        if (last >= s && Dp[last + 1] - Dp[s] > 0) continue;
        if (c.dteRequired && (100 * (Lp[s + M] - Lp[s])) / M < c.cEarthMin - 1e-6) continue;
        viable++;
      }
    }

    const lambda = dens * (c.lBase / 1000) ** 2;
    const direct = 1 - Math.exp(-lambda);
    const cd = confidenceScore(0.85 * direct + 0.4 * (1 - direct), 1 - direct, d.hzSig[idx]).c;
    const metrics = { dSunH: dSun, dDarkH: longest, cEarth };
    const s = suitability(c, utilities(c, { slopeCenter: slope, tri: null, dPsrKm: dPsr }, metrics)).s;

    fail[idx] = bits;
    suit[idx] = s;
    conf[idx] = cd;
    avail[idx] = (100 * viable) / (slipSpan + 1);
    dSunA[idx] = dSun;
    dDarkA[idx] = longest;
    cEarthA[idx] = cEarth;
    if (bits) {
      status[idx] = 0;
      nFail++;
      for (const [name, b] of Object.entries(FAIL_BITS)) if (bits & b) byReason[name as keyof typeof FAIL_BITS]++;
    } else if (regionalDx <= c.lBase && cd >= c.confMin) {
      status[idx] = 2;
      nPass++;
    } else {
      status[idx] = 1;
      nCand++;
    }
  }

  const order: number[] = [];
  for (let i = 0; i < NN; i++) if (status[i] === 1 || status[i] === 2) order.push(i);
  order.sort((a, b) => suit[b] - suit[a] || conf[b] - conf[a]);
  const top: Candidate[] = order.slice(0, 12).map((idx) => {
    const row = Math.floor(idx / n), col = idx % n;
    const x = g.x0 + (col + 0.5) * g.dx_m, y = g.y0 - (row + 0.5) * g.dx_m;
    const [lat, lon] = polarToLatLon(x, y);
    return { idx, x, y, lat, lon, suit: suit[idx], conf: conf[idx], avail: avail[idx] };
  });

  return {
    n, status, suit, conf, avail, dSun: dSunA, dDark: dDarkA, cEarth: cEarthA, fail, top,
    counts: { cells: geo.cells.length, fail: nFail, candidates: nCand, pass: nPass, byReason },
    ms: { geometry: hadCache ? 0 : t1 - t0, thresholds: performance.now() - t1 },
    cached: hadCache, lBase: c.lBase, regionalDx, tLand,
  };
}

/** Instantaneous Sun-visibility / DTE map on the horizon grid (for the "now" layers). */
export function instantVisibility(d: RegionalData, utcMs: number) {
  const g = d.hzGrid;
  const n = g.n;
  const geo = geometryAt(utcMs);
  const sun = new Float32Array(n * n).fill(NaN);
  const earth = new Float32Array(n * n).fill(NaN);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      if (d.hz[idx * 360] === -32768) continue;
      const x = g.x0 + (col + 0.5) * g.dx_m, y = g.y0 - (row + 0.5) * g.dx_m;
      const [lat, lon] = polarToLatLon(x, y);
      const f = siteFrame(lat, lon, d.dem.sample(x, y) || 0);
      for (let body = 0; body < 2; body++) {
        const v = body === 0 ? geo.sun : geo.earth;
        const dx = v[0] - f.P[0], dy = v[1] - f.P[1], dz = v[2] - f.P[2];
        const inv = 1 / Math.hypot(dx, dy, dz);
        const u = (dx * f.up[0] + dy * f.up[1] + dz * f.up[2]) * inv;
        let az = Math.atan2(dx * f.east[0] + dy * f.east[1] + dz * f.east[2], dx * f.north[0] + dy * f.north[1] + dz * f.north[2]) * RAD;
        if (az < 0) az += 360;
        const b0 = Math.floor(az) % 360, t = az - Math.floor(az);
        const h = (d.hz[idx * 360 + b0] * (1 - t) + d.hz[idx * 360 + ((b0 + 1) % 360)] * t) * 0.01;
        const clr = Math.asin(u) * RAD - h;
        if (body === 0) {
          const xr = clr / SUN_SEMIDIAMETER_DEG;
          sun[idx] = xr >= 1 ? 1 : xr <= -1 ? 0 : (Math.acos(-xr) + xr * Math.sqrt(1 - xr * xr)) / Math.PI;
        } else earth[idx] = clr;
      }
    }
  }
  return { n, sun, earth };
}
