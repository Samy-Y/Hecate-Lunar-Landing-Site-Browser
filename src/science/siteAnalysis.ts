/**
 * Single-site pipeline (Workflow B) on real LOLA terrain: stream tiles -> horizon -> terrain ->
 * temporal -> power -> three-part assessment -> launch-slip windows. Runs inside the engine worker.
 */
import { polarToLatLon } from '../lib/geo';
import { DAY_MS, HOUR_MS } from '../lib/math';
import { assess, type Assessment } from './assessment';
import type { Criteria } from './criteria';
import { geometryAt } from './ephemeris';
import { maxSigma, prepareHorizon, raycastHorizon, type HorizonProfile } from './horizon';
import { missionPower, type PowerParams, type PowerResult } from './power';
import type { RegionalData } from './regional';
import { evaluateTerrain, prepareTerrain, type TerrainEval } from './terrainEval';
import { analyzeTimeline, makeSite, metricsAt, viableWindows, type Interval, type MissionMetrics, type Timeline } from './temporal';

const profileCache = new Map<string, HorizonProfile>();

/** Horizon profile: pre-computed 1440-bin pipeline profile for curated sites, else on-demand ray cast. */
export async function profileFor(d: RegionalData, x: number, y: number, siteId?: string | null): Promise<HorizonProfile> {
  const sites = d.manifest.sites;
  const si = siteId ? sites.findIndex((s) => s.id === siteId) : -1;
  if (si >= 0 && Math.hypot(sites[si].x - x, sites[si].y - y) < 1) {
    const N = 1440;
    const off = si * 2 * N;
    const h = new Float32Array(N), sigma = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      h[i] = d.siteHz[off + i] / 100;
      sigma[i] = d.siteHz[off + N + i] / 1000;
    }
    const lvl = sites[si].has5m ? '5m' : '80m';
    return { n: N, h, sigma, level: lvl, source: `pipeline profile, 0.25° (${lvl === '5m' ? 'LOLA 5 m + ' : ''}PGDA 80 m + 256 m regional)` };
  }
  const key = `${Math.round(x)}|${Math.round(y)}`;
  const hit = profileCache.get(key);
  if (hit) return hit;
  await prepareHorizon(d, x, y);
  const p = raycastHorizon(d, x, y, 720, d.manifest.horizon.observer_height_m);
  if (profileCache.size > 64) profileCache.clear();
  profileCache.set(key, p);
  return p;
}

export interface SlipRow {
  label: string;
  offsetH: number;
  tLand: number;
  metrics: MissionMetrics;
  status: Assessment['status'];
  suitability: number;
}

export interface SiteAnalysis {
  x: number;
  y: number;
  lat: number;
  lon: number;
  siteId: string | null;
  tLand: number;
  profile: HorizonProfile;
  terrain: TerrainEval;
  timeline: Timeline;
  metrics: MissionMetrics;
  power: PowerResult;
  assessment: Assessment;
  slip: { windows: Interval[]; availability: number };
  slipTable: SlipRow[];
  terrainOk: boolean;
  timing: { horizonMs: number; temporalMs: number; totalMs: number };
}

export async function analyzeSite(d: RegionalData, x: number, y: number, c: Criteria, tLand: number, siteId: string | null, power: PowerParams): Promise<SiteAnalysis> {
  const t0 = performance.now();
  const [lat, lon] = polarToLatLon(x, y);
  const [profile] = await Promise.all([profileFor(d, x, y, siteId), prepareTerrain(d, x, y, c)]);
  const tH = performance.now();
  const terrain = evaluateTerrain(d, x, y, c, maxSigma(profile));
  const site = makeSite(lat, lon, terrain.elev, profile);
  const extra = Math.max(c.slipH, 14 * 24);
  const timeline = analyzeTimeline(site, c, { tA: Math.min(c.t0 - c.slipH * HOUR_MS, tLand), tB: Math.max(c.t0 + (extra + c.missionH) * HOUR_MS, tLand + c.missionH * HOUR_MS) });
  const metrics = metricsAt(timeline, tLand, c.missionH);
  const sunDist = geometryAt(tLand + (c.missionH * HOUR_MS) / 2).sunDist;
  const pw = missionPower(timeline.series, tLand, c.missionH, sunDist, power);
  const assessment = assess(c, terrain, metrics, { meanW: pw.meanW, minMeanW: power.minMeanW });
  const terrainOk = !assessment.checks.some((k) => (k.terrain || k.key === 'psr') && k.hard && k.pass === false);
  const slip = viableWindows(timeline, c, terrainOk, c.t0 - c.slipH * HOUR_MS, c.t0 + c.slipH * HOUR_MS);
  const slipTable: SlipRow[] = [
    { label: 'Nominal t₀', offsetH: 0 },
    { label: '+24 h', offsetH: 24 },
    { label: '+7 d', offsetH: 168 },
    { label: '+14 d', offsetH: 336 },
  ].map((r) => {
    const tl = c.t0 + r.offsetH * HOUR_MS;
    const m = metricsAt(timeline, tl, c.missionH);
    const a = assess(c, terrain, m);
    return { ...r, tLand: tl, metrics: m, status: a.status, suitability: a.suitability };
  });
  return {
    x, y, lat, lon, siteId, tLand, profile, terrain, timeline, metrics, power: pw, assessment, slip, slipTable, terrainOk,
    timing: { horizonMs: tH - t0, temporalMs: timeline.stats.ms, totalMs: performance.now() - t0 },
  };
}

/** Compact per-site summary for Recap / Compare at landing offsets (hours from t_land). */
export async function summarizeSite(d: RegionalData, x: number, y: number, c: Criteria, tLand: number, siteId: string | null, power: PowerParams, offsetsH: number[]) {
  const [lat, lon] = polarToLatLon(x, y);
  const [profile] = await Promise.all([profileFor(d, x, y, siteId), prepareTerrain(d, x, y, c)]);
  const terrain = evaluateTerrain(d, x, y, c, maxSigma(profile));
  const site = makeSite(lat, lon, terrain.elev, profile);
  const last = Math.max(...offsetsH);
  const tl = analyzeTimeline(site, c, { tA: tLand, tB: tLand + (last + c.missionH) * HOUR_MS });
  const sunDist = geometryAt(tLand).sunDist;
  return offsetsH.map((o) => {
    const t = tLand + o * HOUR_MS;
    const m = metricsAt(tl, t, c.missionH);
    const pw = missionPower(tl.series, t, c.missionH, sunDist, power);
    const a = assess(c, terrain, m, { meanW: pw.meanW, minMeanW: power.minMeanW });
    return {
      offsetH: o, status: a.status, statusDetail: a.statusDetail, suitability: a.suitability, confidence: a.confidence,
      dSunH: m.dSunH, dDarkH: m.dDarkH, cEarth: m.cEarth, slope: terrain.slopeCenter, level: terrain.source, elev: terrain.elev,
      powerMeanW: pw.meanW, energyKWh: pw.energyKWh, failed: a.checks.filter((k) => k.hard && k.pass === false).map((k) => k.key),
    };
  });
}

/** Next viable window after `from`, searching `days` ahead (two-stage engine over a long span). */
export async function findNextWindow(d: RegionalData, x: number, y: number, c: Criteria, from: number, days: number, siteId: string | null) {
  const [lat, lon] = polarToLatLon(x, y);
  const [profile] = await Promise.all([profileFor(d, x, y, siteId), prepareTerrain(d, x, y, c)]);
  const terrain = evaluateTerrain(d, x, y, c, maxSigma(profile));
  const terrainOk = assess(c, terrain, { dSunH: c.dSunMinH, dDarkH: 0, cEarth: 100 }).checks.every((k) => !((k.terrain || k.key === 'psr') && k.hard && k.pass === false));
  const site = makeSite(lat, lon, terrain.elev, profile);
  const tl = analyzeTimeline(site, c, { tA: from, tB: from + days * DAY_MS + c.missionH * HOUR_MS });
  const w = viableWindows(tl, c, terrainOk, from, from + days * DAY_MS);
  return { windows: w.windows, availability: w.availability, terrainOk, ms: tl.stats.ms };
}
