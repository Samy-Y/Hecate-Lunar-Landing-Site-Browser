/**
 * Three-part assessment architecture (spec v2.0 ch. 6).
 *
 *  1. Feasibility  in {PASS, FAIL, UNKNOWN}  - non-compensatory gate G_hard
 *  2. Suitability  S_suit = 100 * sum_k w_k u_k   (normalised user weights)
 *  3. Confidence   C_data = 100 * (0.5 q_source + 0.3 (1 - f_interp) + 0.2 q_horizon)
 *
 * A violated mandatory constraint is FAIL regardless of weights (VAL-05). Missing
 * evidence (L_base unresolved, C_data < C_data,min, unevaluable hard gate) is
 * UNKNOWN / LOW CONFIDENCE - never PASS (VAL-06).
 */
import { clamp, fmt } from '../lib/math';
import { normalizedWeights, type Criteria, type Weights } from './criteria';
import type { MissionMetrics } from './temporal';
import type { TerrainEval } from './terrainEval';

export type Feasibility = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface Check {
  key: 'slope' | 'dsun' | 'ddark' | 'dte' | 'tri' | 'cpr' | 'psr' | 'power';
  label: string;
  value: string;
  limit: string;
  /** true pass, false fail, null not evaluable / not applicable */
  pass: boolean | null;
  hard: boolean;
  terrain: boolean;
}

export interface Utilities {
  slope: number;
  sun: number;
  comm: number;
  tri: number | null;
  psr: number | null;
}

export interface Assessment {
  status: Feasibility;
  statusDetail: string;
  checks: Check[];
  suitability: number;
  confidence: number;
  confCategory: 'High' | 'Moderate' | 'Low';
  utilities: Utilities;
  weights: Weights;
  qHorizon: number;
}

export function confidenceScore(qSource: number, fInterp: number, sigmaHMax: number) {
  const qHorizon = clamp(1 - sigmaHMax / 0.5, 0, 1);
  return { c: 100 * (0.5 * qSource + 0.3 * (1 - fInterp) + 0.2 * qHorizon), qHorizon };
}

export const confCategory = (c: number): Assessment['confCategory'] => (c >= 80 ? 'High' : c >= 50 ? 'Moderate' : 'Low');

export function utilities(c: Criteria, t: Pick<TerrainEval, 'slopeCenter' | 'tri' | 'dPsrKm'>, m: MissionMetrics): Utilities {
  return {
    slope: clamp((c.slopeMax - t.slopeCenter) / c.slopeMax, 0, 1),
    sun: clamp((m.dSunH - c.dSunMinH) / Math.max(1, c.missionH - c.dSunMinH), 0, 1),
    comm: c.dteRequired ? clamp((m.cEarth - c.cEarthMin) / Math.max(1, 100 - c.cEarthMin), 0, 1) : 1,
    tri: t.tri === null ? null : clamp((c.triMax - t.tri) / c.triMax, 0, 1),
    psr: c.psrFilter ? clamp((c.dPsrMax - t.dPsrKm) / c.dPsrMax, 0, 1) : null,
  };
}

/** Weighted suitability over the utilities that could be evaluated (weights renormalised). */
export function suitability(c: Criteria, u: Utilities) {
  const w = normalizedWeights(c.weights, c.psrFilter);
  const pairs: [number, number | null][] = [[w.sun, u.sun], [w.comm, u.comm], [w.slope, u.slope], [w.tri, u.tri], [w.psr, u.psr]];
  let ws = 0, s = 0;
  for (const [wk, uk] of pairs) if (uk !== null && wk > 0) { ws += wk; s += wk * uk; }
  return { s: ws > 0 ? (100 * s) / ws : 0, w };
}

export function assess(c: Criteria, t: TerrainEval, m: MissionMetrics, power?: { meanW: number; minMeanW: number }): Assessment {
  const checks: Check[] = [];
  const add = (key: Check['key'], label: string, value: string, limit: string, pass: boolean | null, hard: boolean, terrain: boolean) =>
    checks.push({ key, label, value, limit, pass, hard, terrain });

  if (c.ellipseR > 0 && t.footprintCells > 1) {
    add('slope', `Slope $\\alpha(${t.slopeBaselineM}\\,\\mathrm{m})$, $\\ge 95\\%$ of $R_{\\mathrm{ellipse}}$`, `${fmt(t.slopePassFrac * 100, 0)} % pass · $p_{95} = ${fmt(t.slopeP95)}^\\circ$`, `$\\alpha \\le ${c.slopeMax}^\\circ$`, t.slopePassFrac >= 0.95, true, true);
  } else {
    add('slope', `Slope $\\alpha(${Math.round(t.slopeBaselineM)}\\,\\mathrm{m})$`, `${fmt(t.slopeCenter)}°`, `$\\le ${c.slopeMax}^\\circ$`, t.slopeCenter <= c.slopeMax, true, true);
  }
  add('dsun', 'Continuous insolation $D_{\\mathrm{sun}}$', `${fmt(m.dSunH)} h`, `$\\ge ${c.dSunMinH}\\,\\mathrm{h}$`, m.dSunH >= c.dSunMinH - 1e-6, true, false);
  add('ddark', 'Max continuous darkness $D_{\\mathrm{dark}}$', `${fmt(m.dDarkH)} h`, `$\\le ${c.dDarkMaxH}\\,\\mathrm{h}$`, m.dDarkH <= c.dDarkMaxH + 1e-6, true, false);
  add('dte', 'Geometric DTE duty $C_{\\mathrm{earth}}$', `${fmt(m.cEarth)} %`, c.dteRequired ? `$\\ge ${c.cEarthMin}\\%$` : 'not required', c.dteRequired ? m.cEarth >= c.cEarthMin - 1e-6 : null, c.dteRequired, false);
  if (t.tri === null) add('tri', 'Terrain Ruggedness Index', 'n/a (no 5 m DEM here)', `$\\le ${c.triMax}\\,\\mathrm{m}$`, null, c.triGate, true);
  else add('tri', 'Terrain Ruggedness Index', `${fmt(t.tri, 2)} m${!c.triGate && t.tri > c.triMax ? ' (advisory)' : ''}`, `$\\le ${c.triMax}\\,\\mathrm{m}$`, c.triGate ? t.tri <= c.triMax : null, c.triGate, true);
  add('cpr', 'Mini-RF CPR indicator', `${fmt(t.cpr, 2)}${!c.cprGate && t.cpr > c.cprMax ? ' (advisory)' : ''}`, `$\\le ${c.cprMax}$`, c.cprGate ? t.cpr <= c.cprMax : null, c.cprGate, true);
  add('psr', 'Distance to PSR $d_{\\mathrm{PSR}}$', `${fmt(t.dPsrKm, 2)} km`, c.psrFilter ? `$\\le ${c.dPsrMax}\\,\\mathrm{km}$` : 'filter off', c.psrFilter ? t.dPsrKm <= c.dPsrMax : null, c.psrFilter, false);
  if (power) add('power', 'Mean solar power $\\bar{P}$', `${fmt(power.meanW, 0)} W`, power.minMeanW > 0 ? `$\\ge ${power.minMeanW}\\,\\mathrm{W}$` : 'no requirement', power.minMeanW > 0 ? power.meanW >= power.minMeanW : null, power.minMeanW > 0, false);

  const { c: conf, qHorizon } = confidenceScore(t.qSource, t.fInterp, t.sigmaHMax);
  const u = utilities(c, t, m);
  const { s, w } = suitability(c, u);

  const failed = checks.filter((k) => k.hard && k.pass === false);
  let status: Feasibility;
  let detail: string;
  const names: Record<string, string> = { slope: 'slope $\\alpha$', dsun: '$D_{\\mathrm{sun}}$', ddark: '$D_{\\mathrm{dark}}$', dte: '$C_{\\mathrm{earth}}$', tri: 'TRI', cpr: 'CPR', psr: '$d_{\\mathrm{PSR}}$', power: 'mean power $\\bar{P}$' };
  if (failed.length) {
    status = 'FAIL';
    detail = `Mandatory constraint violated: ${failed.map((f) => names[f.key]).join(', ')}`;
  } else if (!t.lBaseResolved) {
    status = 'UNKNOWN';
    detail = `Resolution Limited — $${c.lBase}\\,\\mathrm{m}$ DEM unavailable here; slope evaluated at ${Math.round(t.slopeBaselineM)} m regional baseline`;
  } else if (conf < c.confMin) {
    status = 'UNKNOWN';
    detail = `LOW CONFIDENCE — $C_{\\mathrm{data}} = ${conf.toFixed(0)} < ${c.confMin}$ at $L_{\\mathrm{base}} = ${c.lBase}\\,\\mathrm{m}$ (${(t.fInterp * 100).toFixed(0)} % interpolated)`;
  } else if (checks.some((k) => k.hard && k.pass === null)) {
    status = 'UNKNOWN';
    detail = 'A mandatory constraint could not be evaluated with the loaded data';
  } else {
    status = 'PASS';
    detail = 'All mandatory thresholds met with sufficient terrain evidence';
  }
  return { status, statusDetail: detail, checks, suitability: s, confidence: conf, confCategory: confCategory(conf), utilities: u, weights: w, qHorizon };
}
