/**
 * Wikipedia-style [i] contextual cards with live formula substitution. The card is rendered in a
 * portal with fixed positioning, clamped to the viewport, so it never causes horizontal scroll
 * inside narrow side panels.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../store/useApp';
import { fmt } from '../../lib/math';
import { tx } from './Tx';

export interface DocEntry {
  title: string;
  body: string;
  formula?: string;
  source?: string;
  live?: (s: ReturnType<typeof useApp.getState>) => string | null;
}

export const DOCS: Record<string, DocEntry> = {
  t0: { title: 'Mission start t₀ (touchdown)', body: 'UTC epoch of nominal touchdown; it sets the initial Sun/Earth geometry. Internally converted to TT/TDB for the ephemeris.', source: 'Spec v2.0 §2.5, §4.1' },
  slip: { title: 'Launch slip margin Δt_slip', body: 'Landing epochs in [t₀ − Δt, t₀ + Δt] are screened with the two-stage engine: a 1-hour coarse scan brackets every horizon crossing, Brent’s method refines it to ≤ 2 s.', formula: 'window = [t₀ − Δt_slip, t₀ + Δt_slip]', source: 'Spec v2.0 §5.3' },
  mission: { title: 'Mission end / duration T_mission', body: 'All temporal metrics and the power budget are evaluated over [t_land, t_land + T_mission]. Setting the end date sets T_mission.', source: 'NASA SP-2020-5009602 §2.1' },
  sunMin: {
    title: 'Minimum solar elevation θ_sun,min',
    body: 'Minimum angle of the Sun’s centre above the local terrain horizon h_mask(φ_sun) — not above the flat geometric horizon.',
    formula: 'θ_sun(t) − h_mask(φ_sun(t)) ≥ θ_sun,min',
    live: (s) => (s.analysis ? `now: ${num(lastSun(s)?.el)}° − ${paren(lastSun(s)?.h)}° = ${num((lastSun(s)?.el ?? NaN) - (lastSun(s)?.h ?? NaN))}° vs ${s.criteria.sunMinEl}°` : null),
    source: 'NASA-STD-1008 / M2M-30044',
  },
  fSun: { title: 'Solar disk visibility fraction f_sun', body: 'Fraction of the 0.53° solar disk above the local ridge line. Grazing a ridge gives the circular-segment area fraction.', formula: 'x = (θ_sun − h_mask)/R_sun;  f = (acos(−x) + x√(1−x²))/π', source: 'Spec v2.0 §2.3; Paige et al. 2010' },
  dSun: { title: 'Continuous post-landing insolation D_sun', body: 'Length of the uninterrupted interval starting at landing during which f_sun ≥ f_sun,min and the Sun clears θ_sun,min. Capped at T_mission.', live: (s) => (s.analysis ? `D_sun = ${fmt(s.analysis.metrics.dSunH)} h (min ${s.criteria.dSunMinH} h)` : null), source: 'Spec v2.0 §2.3' },
  dDark: { title: 'Maximum continuous darkness D_dark', body: 'Longest contiguous interval inside the mission where f_sun < f_sun,min — what the batteries must survive.', live: (s) => (s.analysis ? `D_dark = ${fmt(s.analysis.metrics.dDarkH)} h (max ${s.criteria.dDarkMaxH} h)` : null), source: 'NASA M2M-30044' },
  dte: { title: 'Geometric DTE visibility', body: 'Topocentric line-of-sight to Earth from the site (including libration and parallax). Geometry only — not a closed RF link budget.', formula: 'θ_earth(t) − h_mask(φ_earth(t)) ≥ θ_earth,min;   C_earth = % of T_mission satisfied', live: (s) => (s.analysis ? `C_earth = ${fmt(s.analysis.metrics.cEarth)} % (min ${s.criteria.cEarthMin} %)` : null), source: 'Spec v2.0 §2.4; HLS-CONOP-008' },
  slope: { title: 'Bidirectional slope α at baseline L_base', body: 'Terrain tilt from elevation differences across ±L/2 in both map axes on the 5 m LOLA grid (true distance via the stereographic scale factor). Meaningful only where the DEM is measured, not interpolated.', formula: 'α = arctan √((∂z/∂x)² + (∂z/∂y)²)', live: (s) => (s.analysis ? `u_slope = clamp((${s.criteria.slopeMax} − ${fmt(s.analysis.terrain.slopeCenter, 2)}) / ${s.criteria.slopeMax}, 0, 1) = ${fmt(s.analysis.assessment.utilities.slope, 3)}` : null), source: 'NASA SP-2020-5009602' },
  tri: { title: 'Terrain Ruggedness Index (TRI)', body: 'Mean absolute elevation difference between a 5 m cell and its 8 neighbours. Establishes local relief at the DEM’s effective resolution — not individual boulders.', live: (s) => (s.analysis?.terrain.tri != null ? `u_tri = clamp((${s.criteria.triMax} − ${fmt(s.analysis.terrain.tri, 2)}) / ${s.criteria.triMax}, 0, 1) = ${fmt(s.analysis.assessment.utilities.tri, 3)}` : null), source: 'Riley et al. 1999; LOLA 5 m' },
  cpr: { title: 'Mini-RF Circular Polarization Ratio', body: 'Same-sense / opposite-sense S-band radar backscatter from the LRO Mini-RF global mosaic. Indicates wavelength-scale roughness (or ice); kept as an independent layer, never fused into a “boulder proxy”.', source: 'PDS Mini-RF global CPR mosaic (32 ppd)' },
  psr: { title: 'Distance to Permanently Shadowed Region', body: 'Distance to the nearest PSR (PGDA Product 69 map). Science filter for EVA walk-back (2 km) or LTV range (10 km).', live: (s) => (s.analysis && s.criteria.psrFilter ? `u_psr = clamp((${s.criteria.dPsrMax} − ${fmt(s.analysis.terrain.dPsrKm, 2)}) / ${s.criteria.dPsrMax}, 0, 1) = ${fmt(s.analysis.assessment.utilities.psr, 3)}` : null), source: 'Mazarico et al. 2011; Artemis III SDT Report' },
  ellipse: { title: 'Landing ellipse R_ellipse', body: '3σ guidance footprint. With a non-zero radius, ≥ 95 % of the 5 m cells inside must satisfy α ≤ α_max.', source: 'Spec v2.0 §2.5' },
  confidence: {
    title: 'Data Confidence C_data',
    body: 'Reliability of the terrain evidence: share of 5 m cells holding direct LOLA shots, interpolation fraction inside the footprint, and horizon uncertainty propagated from the published σ_z maps.',
    formula: 'C_data = 100·(0.50·q_source + 0.30·(1 − f_interp) + 0.20·q_horizon),  q_horizon = clamp(1 − σ_h,max/0.5°, 0, 1)',
    live: (s) => (s.analysis ? `= 100·(0.5·${fmt(s.analysis.terrain.qSource, 2)} + 0.3·(1 − ${fmt(s.analysis.terrain.fInterp, 2)}) + 0.2·${fmt(s.analysis.assessment.qHorizon, 2)}) = ${fmt(s.analysis.assessment.confidence, 1)}` : null),
    source: 'Spec v2.0 §6.4',
  },
  suitability: {
    title: 'Suitability S_suit',
    body: 'Ranks feasible sites by margins. Weights are user-configurable ranking weights, not engineering law; unavailable utilities are dropped and the rest renormalised.',
    formula: 'S_suit = 100·Σ w_k·u_k,  Σw_k = 1',
    live: (s) => {
      const a = s.analysis?.assessment;
      if (!a) return null;
      const u = a.utilities, w = a.weights;
      return `= 100·(${fmt(w.sun, 2)}·${fmt(u.sun, 2)} + ${fmt(w.comm, 2)}·${fmt(u.comm, 2)} + ${fmt(w.slope, 2)}·${fmt(u.slope, 2)}${u.tri != null ? ` + ${fmt(w.tri, 2)}·${fmt(u.tri, 2)}` : ''}${u.psr != null ? ` + ${fmt(w.psr, 2)}·${fmt(u.psr, 2)}` : ''}) = ${fmt(a.suitability, 1)}`;
    },
    source: 'Spec v2.0 §6.3',
  },
  feasibility: { title: 'Feasibility gate G_hard', body: 'Non-compensatory: any violated mandatory constraint is FAIL regardless of weights. Missing evidence (unresolved L_base, C_data below minimum) is UNKNOWN / LOW CONFIDENCE — never PASS.', source: 'Spec v2.0 §6.2, VAL-05/06' },
  horizon: { title: 'Local horizon profile h_mask(φ)', body: 'Maximum curvature-corrected terrain elevation angle per azimuth, ray-cast to 150 km over real LOLA terrain. Uncertainty σ_h propagates the published DEM vertical error at the ridge distance.', formula: 'θ(r) = atan2((R+z)cosψ − (R+z₀), (R+z)sinψ),  ψ = r/R;   σ_h = atan(√(σz₀² + σz_peak²)/r_peak)', source: 'Spec v2.0 §5.2' },
  power: {
    title: 'Solar power generation',
    body: 'Electrical output of a solar array at the site: solar constant scaled to the Sun distance, array area, efficiency and losses, the visible solar-disk fraction above the terrain, and the cosine of the incidence angle on the panel.',
    formula: 'P = 1361·(1 AU/r)²·A·η·(1−L)·f_sun·max(0, cos i);   cos i = sin(el)cos β + cos(el) sin β cos(Δaz)',
    live: (s) => (s.analysis?.power ? `mean ${fmt(s.analysis.power.meanW, 0)} W · ${fmt(s.analysis.power.energyKWh, 1)} kWh over ${s.criteria.missionH} h (A ${s.power.areaM2} m², η ${fmt(s.power.efficiency * 100, 0)} %, β ${s.power.tiltDeg}°)` : null),
    source: 'Spec v2.0 §2.3 (Phase 4)',
  },
};

/** Typographic minus for live substitutions; `paren` brackets a negative subtrahend: a − (−b). */
const num = (v: number | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v < 0 ? `−${fmt(-v, d)}` : fmt(v, d));
const paren = (v: number | undefined, d = 2) => (v != null && v < 0 ? `(${num(v, d)})` : num(v, d));

function lastSun(s: ReturnType<typeof useApp.getState>) {
  const a = s.analysis;
  if (!a) return null;
  const t = a.timeline.series;
  let i = 0;
  for (; i < t.t.length - 1 && t.t[i + 1] <= s.epoch; i++);
  return { el: t.sunEl[i], h: t.sunH[i] };
}

export function InfoTip({ id, children }: { id: keyof typeof DOCS | string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const doc = DOCS[id];
  const live = useApp((s) => (open && doc?.live ? doc.live(s) : null));
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = Math.min(380, window.innerWidth - 24);
    const h = card.current?.offsetHeight ?? 160;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    setPos({ left, top });
  }, [open, live]);
  if (!doc) return <>{children}</>;
  return (
    <span className="infotip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {tx(children)}
      <button type="button" ref={btn} className="i-btn" aria-label={`About ${doc.title}`} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>i</button>
      {open &&
        createPortal(
          <span className="i-card" role="tooltip" ref={card} style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
            <strong>{tx(doc.title)}</strong>
            <span>{tx(doc.body)}</span>
            {doc.formula && <code className="math">{tx(doc.formula)}</code>}
            {live && <code className="live math">{tx(live)}</code>}
            {doc.source && <em>{doc.source}</em>}
          </span>,
          document.body,
        )}
    </span>
  );
}
