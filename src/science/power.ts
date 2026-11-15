/**
 * Solar array power generation (spec v2.0 sec. 2.3, Phase 4 extension).
 *
 *   P(t) = S(t) . A . eta . (1 - L) . f_sun(t) . max(0, cos i(t))
 *   S(t) = 1361 W/m^2 . (1 AU / r_sun)^2                    solar constant at the Moon's distance
 *   cos i = sin(el) cos(beta) + cos(el) sin(beta) cos(az_sun - az_panel)
 *
 * beta = panel inclination from horizontal (0 = flat deck, 90 = vertical mast panel);
 * az_panel = Sun azimuth when the array tracks in azimuth (typical polar mast), or a fixed heading.
 * f_sun is the visible solar-disk fraction above the local terrain horizon (terrain shadowing),
 * so P is zero during cast-shadow darkness even if the Sun is above the geometric horizon.
 * P_rated = 1361 . A . eta is the array output at 1 AU, normal incidence, no losses.
 */
import { DEG } from '../lib/math';
import type { TimelineSeries } from './temporal';

export interface PowerParams {
  /** Array area (m^2). */
  areaM2: number;
  /** Cell + conversion efficiency (0-1). */
  efficiency: number;
  /** Panel inclination from horizontal (deg). */
  tiltDeg: number;
  azMode: 'track' | 'fixed';
  /** Fixed panel azimuth (deg clockwise from north) when azMode = 'fixed'. */
  azDeg: number;
  /** Thermal, degradation and wiring losses (%). */
  lossesPct: number;
  /** Optional requirement: minimum mean power over the mission (W, 0 = no gate). */
  minMeanW: number;
}

export const DEFAULT_POWER: PowerParams = { areaM2: 10, efficiency: 0.3, tiltDeg: 90, azMode: 'track', azDeg: 0, lossesPct: 15, minMeanW: 0 };

export const SOLAR_CONSTANT = 1361;
export const AU_KM = 149_597_870.7;

export function cosIncidence(elDeg: number, azDeg: number, p: PowerParams): number {
  const b = p.tiltDeg * DEG;
  const azp = p.azMode === 'track' ? azDeg : p.azDeg;
  return Math.sin(elDeg * DEG) * Math.cos(b) + Math.cos(elDeg * DEG) * Math.sin(b) * Math.cos((azDeg - azp) * DEG);
}

export function powerAt(elDeg: number, azDeg: number, fSun: number, sunDistKm: number, p: PowerParams): number {
  const S = SOLAR_CONSTANT * (AU_KM / sunDistKm) ** 2;
  return S * p.areaM2 * p.efficiency * (1 - p.lossesPct / 100) * fSun * Math.max(0, cosIncidence(elDeg, azDeg, p));
}

export interface PowerResult {
  ratedW: number;
  meanW: number;
  minW: number;
  maxW: number;
  energyKWh: number;
  /** Hours with less than 1 % of rated power. */
  hoursBelow1pct: number;
  /** Hourly samples across the mission window. */
  t: number[];
  watts: number[];
}

export function missionPower(series: TimelineSeries, tLand: number, missionH: number, sunDistKm: number, p: PowerParams): PowerResult {
  const end = tLand + missionH * 3_600_000;
  const t: number[] = [], w: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    if (series.t[i] < tLand - 1 || series.t[i] > end + 1) continue;
    t.push(series.t[i]);
    w.push(powerAt(series.sunEl[i], series.sunAz[i], series.sunF[i], sunDistKm, p));
  }
  const rated = SOLAR_CONSTANT * p.areaM2 * p.efficiency;
  let e = 0, below = 0;
  for (let i = 1; i < t.length; i++) {
    const dtH = (t[i] - t[i - 1]) / 3_600_000;
    e += 0.5 * (w[i] + w[i - 1]) * dtH;
    if (w[i] < 0.01 * rated) below += dtH;
  }
  const mean = t.length > 1 ? e / ((t[t.length - 1] - t[0]) / 3_600_000) : w[0] ?? 0;
  return {
    ratedW: rated, meanW: mean, minW: w.length ? Math.min(...w) : 0, maxW: w.length ? Math.max(...w) : 0,
    energyKWh: e / 1000, hoursBelow1pct: below, t, watts: w,
  };
}
