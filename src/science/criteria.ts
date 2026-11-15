/**
 * User-definable search criteria and traceable mission presets (spec v2.0 sec. 2.5).
 * Every preset value carries the citation shown in the UI.
 */
import { parseUtc } from '../lib/time';

export interface Weights {
  sun: number;
  comm: number;
  slope: number;
  tri: number;
  psr: number;
}

export interface Criteria {
  /** Nominal touchdown epoch t_0 (UTC ms). */
  t0: number;
  /** Launch slip margin +/- (hours). */
  slipH: number;
  /** Surface mission duration T_mission (hours). */
  missionH: number;
  /** theta_sun,min (deg above local terrain horizon). */
  sunMinEl: number;
  /** f_sun,min in [0, 1]. */
  fSunMin: number;
  /** D_sun,min (hours). */
  dSunMinH: number;
  /** D_dark,max (hours). */
  dDarkMaxH: number;
  dteRequired: boolean;
  /** theta_earth,min (deg). */
  earthMinEl: number;
  /** C_earth,min (%). */
  cEarthMin: number;
  /** alpha_max (deg). */
  slopeMax: number;
  /** L_base (m): 5, 20 or 100. */
  lBase: number;
  triMax: number;
  triGate: boolean;
  cprMax: number;
  cprGate: boolean;
  /** R_ellipse (m): 0 = point. */
  ellipseR: number;
  psrFilter: boolean;
  dPsrMax: number;
  /** C_data,min (0-100). */
  confMin: number;
  weights: Weights;
}

export const DEFAULT_T0 = parseUtc('2027-03-15T12:00:00Z');

export const WEIGHTS_DEFAULT_NO_PSR: Weights = { sun: 0.35, comm: 0.25, slope: 0.25, tri: 0.15, psr: 0 };
export const WEIGHTS_DEFAULT_PSR: Weights = { sun: 0.3, comm: 0.2, slope: 0.25, tri: 0.15, psr: 0.1 };

export const WEIGHT_PRESETS: { id: string; label: string; w: Weights }[] = [
  { id: 'default', label: 'Default (spec 6.3)', w: WEIGHTS_DEFAULT_NO_PSR },
  { id: 'power', label: 'Power-priority', w: { sun: 0.5, comm: 0.2, slope: 0.15, tri: 0.15, psr: 0 } },
  { id: 'safety', label: 'Safety-priority', w: { sun: 0.2, comm: 0.2, slope: 0.35, tri: 0.25, psr: 0 } },
  { id: 'science', label: 'Science-priority', w: { sun: 0.25, comm: 0.15, slope: 0.2, tri: 0.1, psr: 0.3 } },
];

export interface MissionPreset {
  id: string;
  label: string;
  short: string;
  criteria: Omit<Criteria, 't0' | 'weights'>;
  citations: Partial<Record<keyof Criteria, string>>;
}

export const PRESETS: MissionPreset[] = [
  {
    id: 'artemis3',
    label: 'Artemis III Crewed HLS',
    short: 'Artemis III',
    criteria: {
      slipH: 72, missionH: 156, sunMinEl: 1.5, fSunMin: 0.5, dSunMinH: 156, dDarkMaxH: 0,
      dteRequired: true, earthMinEl: 2.0, cEarthMin: 100, slopeMax: 8, lBase: 5,
      triMax: 0.4, triGate: false, cprMax: 0.6, cprGate: false, ellipseR: 100,
      psrFilter: false, dPsrMax: 2.0, confMin: 50,
    },
    citations: {
      slipH: 'Crewed ±3 d (illustrative mission-planning baseline)',
      missionH: 'NASA SP-2020-5009602 §2.1 (6.5 d surface stay)',
      sunMinEl: 'NASA-STD-1008 / M2M-30044 (mast-mounted array)',
      dSunMinH: 'NASA SP-2020-5009602',
      dDarkMaxH: 'NASA M2M-30044 (crewed HLS: no darkness)',
      fSunMin: 'Paige et al. 2010, Science 330',
      earthMinEl: 'HLS-CONOP-008 (S/X-band)',
      cEarthMin: 'HLS-CONOP-008',
      slopeMax: 'NASA SP-2020-5009602 (tall HLS)',
      lBase: 'Lander footpad baseline',
      ellipseR: 'Precision GN&C, ≥95 % of cells must pass',
      dPsrMax: 'Artemis III SDT Report (EVA walkback)',
    },
  },
  {
    id: 'clps',
    label: 'CLPS Polar Solar Lander',
    short: 'CLPS',
    criteria: {
      slipH: 336, missionH: 240, sunMinEl: 5.0, fSunMin: 0.5, dSunMinH: 192, dDarkMaxH: 12,
      dteRequired: true, earthMinEl: 2.0, cEarthMin: 90, slopeMax: 10, lBase: 5,
      triMax: 0.4, triGate: false, cprMax: 0.6, cprGate: false, ellipseR: 500,
      psrFilter: false, dPsrMax: 10, confMin: 50,
    },
    citations: {
      slipH: 'Robotic ±14 d (illustrative)',
      missionH: 'CLPS 192–240 h class (NASA SP-2020-5009602)',
      sunMinEl: 'Deck-mounted array (NASA-STD-1008 / M2M-30044)',
      dSunMinH: 'NASA SP-2020-5009602 (CLPS 192–240 h)',
      dDarkMaxH: 'Illustrative battery margin',
      cEarthMin: 'Illustrative DTE robotic baseline',
      slopeMax: 'NASA SP-2020-5009602 (CLPS 10°)',
      ellipseR: 'Standard GN&C 500 m',
    },
  },
  {
    id: 'viper',
    label: 'VIPER-Class Polar Rover',
    short: 'Rover',
    criteria: {
      slipH: 336, missionH: 336, sunMinEl: 2.0, fSunMin: 0.5, dSunMinH: 96, dDarkMaxH: 60,
      dteRequired: true, earthMinEl: 2.0, cEarthMin: 70, slopeMax: 15, lBase: 100,
      triMax: 0.4, triGate: false, cprMax: 0.6, cprGate: false, ellipseR: 500,
      psrFilter: true, dPsrMax: 10, confMin: 50,
    },
    citations: {
      dDarkMaxH: 'NASA M2M-30044 (VIPER 50–70 h)',
      cEarthMin: 'HLS-CONOP-008 (rover 70 %)',
      slopeMax: 'NASA SP-2020-5009602 (rover 15°)',
      lBase: 'Traverse baseline 100 m',
      dPsrMax: 'Artemis III SDT Report (LTV rover 10 km)',
    },
  },
];

export function presetCriteria(id: string, t0 = DEFAULT_T0): Criteria {
  const p = PRESETS.find((q) => q.id === id) ?? PRESETS[0];
  return { ...p.criteria, t0, weights: p.criteria.psrFilter ? WEIGHTS_DEFAULT_PSR : WEIGHTS_DEFAULT_NO_PSR };
}

/** Normalise weights so the active ones sum to 1 (w_psr forced to 0 when the PSR filter is off). */
export function normalizedWeights(w: Weights, psrActive: boolean): Weights {
  const r = { ...w, psr: psrActive ? w.psr : 0 };
  const s = r.sun + r.comm + r.slope + r.tri + r.psr;
  if (s <= 0) return { sun: 0.25, comm: 0.25, slope: 0.25, tri: 0.25, psr: 0 };
  return { sun: r.sun / s, comm: r.comm / s, slope: r.slope / s, tri: r.tri / s, psr: r.psr / s };
}
