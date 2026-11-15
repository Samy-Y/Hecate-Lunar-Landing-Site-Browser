/**
 * Wikipedia-style [i] contextual cards with KaTeX formula rendering and live substitution.
 * Portalled to document.body with shared enter/leave timer so the pointer can move onto
 * the card cleanly to inspect equations, values, and sources without the popup vanishing.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../store/useApp';
import { fmt } from '../../lib/math';
import { MathTex, plainMath, tx } from './Tx';

export interface DocEntry {
  title: string;
  body: string;
  formula?: string;
  source?: string;
  live?: (s: ReturnType<typeof useApp.getState>) => string | null;
}

export const DOCS: Record<string, DocEntry> = {
  t0: {
    title: 'Mission start $t_0$ (touchdown)',
    body: 'UTC epoch of nominal touchdown; it sets the initial Sun/Earth geometry. Internally converted to TT/TDB for the ephemeris.',
    source: 'Spec v2.0 §2.5, §4.1',
  },
  slip: {
    title: 'Launch slip margin $\\Delta t_{\\mathrm{slip}}$',
    body: 'Landing epochs in $[t_0 - \\Delta t,\\; t_0 + \\Delta t]$ are screened with the two-stage engine: a 1-hour coarse scan brackets every horizon crossing and Brent’s method refines it to $\\le 2\\,\\mathrm{s}$.',
    formula: '\\mathrm{window} = [t_0 - \\Delta t_{\\mathrm{slip}},\\; t_0 + \\Delta t_{\\mathrm{slip}}]',
    source: 'Spec v2.0 §5.3',
  },
  mission: {
    title: 'Mission end / duration $T_{\\mathrm{mission}}$',
    body: 'All temporal metrics and the power budget are evaluated over $[t_{\\mathrm{land}},\\; t_{\\mathrm{land}} + T_{\\mathrm{mission}}]$. Setting the end date sets $T_{\\mathrm{mission}}$.',
    source: 'NASA SP-2020-5009602 §2.1',
  },
  sunMin: {
    title: 'Minimum solar elevation $\\theta_{\\mathrm{sun,min}}$',
    body: 'Minimum angle of the Sun’s centre above the local terrain horizon $h_{\\mathrm{mask}}(\\varphi_{\\mathrm{sun}})$ — not above the flat geometric horizon.',
    formula: '\\theta_{\\mathrm{sun}}(t) - h_{\\mathrm{mask}}(\\varphi_{\\mathrm{sun}}(t)) \\ge \\theta_{\\mathrm{sun,min}}',
    live: (s) => (s.analysis ? `\\text{now: } ${num(lastSun(s)?.el)}^\\circ - ${paren(lastSun(s)?.h)}^\\circ = ${num((lastSun(s)?.el ?? NaN) - (lastSun(s)?.h ?? NaN))}^\\circ \\;\\text{vs}\\; ${s.criteria.sunMinEl}^\\circ` : null),
    source: 'NASA-STD-1008 / M2M-30044',
  },
  fSun: {
    title: 'Solar disk visibility fraction $f_{\\mathrm{sun}}$',
    body: 'Fraction of the $0.53^\\circ$ solar disk above the local ridge line. Grazing a ridge gives the circular-segment area fraction.',
    formula: 'x = \\frac{\\theta_{\\mathrm{sun}} - h_{\\mathrm{mask}}}{R_{\\mathrm{sun}}}, \\quad f_{\\mathrm{sun}} = \\frac{\\arccos(-x) + x\\sqrt{1 - x^2}}{\\pi}',
    source: 'Spec v2.0 §2.3; Paige et al. 2010',
  },
  dSun: {
    title: 'Continuous post-landing insolation $D_{\\mathrm{sun}}$',
    body: 'Length of the uninterrupted interval starting at landing during which $f_{\\mathrm{sun}} \\ge f_{\\mathrm{sun,min}}$ and the Sun clears $\\theta_{\\mathrm{sun,min}}$, capped at $T_{\\mathrm{mission}}$.',
    live: (s) => (s.analysis ? `D_{\\mathrm{sun}} = ${fmt(s.analysis.metrics.dSunH)}\\,\\mathrm{h} \\;(\\min ${s.criteria.dSunMinH}\\,\\mathrm{h})` : null),
    source: 'Spec v2.0 §2.3',
  },
  dDark: {
    title: 'Maximum continuous darkness $D_{\\mathrm{dark}}$',
    body: 'Longest contiguous interval inside the mission where $f_{\\mathrm{sun}} < f_{\\mathrm{sun,min}}$ — what the batteries must survive.',
    live: (s) => (s.analysis ? `D_{\\mathrm{dark}} = ${fmt(s.analysis.metrics.dDarkH)}\\,\\mathrm{h} \\;(\\max ${s.criteria.dDarkMaxH}\\,\\mathrm{h})` : null),
    source: 'NASA M2M-30044',
  },
  dte: {
    title: 'Geometric DTE visibility',
    body: 'Topocentric line-of-sight to Earth from the site (including libration and parallax). Geometry only — not a closed RF link budget.',
    formula: '\\theta_{\\mathrm{earth}}(t) - h_{\\mathrm{mask}}(\\varphi_{\\mathrm{earth}}(t)) \\ge \\theta_{\\mathrm{earth,min}}, \\quad C_{\\mathrm{earth}} = \\%\\%\\text{ of } T_{\\mathrm{mission}}\\text{ satisfied}',
    live: (s) => (s.analysis ? `C_{\\mathrm{earth}} = ${fmt(s.analysis.metrics.cEarth)}\\,\\% \\;(\\min ${s.criteria.cEarthMin}\\,\\%)` : null),
    source: 'Spec v2.0 §2.4; HLS-CONOP-008',
  },
  slope: {
    title: 'Bidirectional slope $\\alpha$ at baseline $L_{\\mathrm{base}}$',
    body: 'Terrain tilt from elevation differences across $\\pm L/2$ in both map axes on the $5\\,\\mathrm{m}$ LOLA grid (true distance via the stereographic scale factor). Meaningful only where the DEM is measured, not interpolated.',
    formula: '\\alpha = \\arctan\\sqrt{\\left(\\frac{\\partial z}{\\partial x}\\right)^2 + \\left(\\frac{\\partial z}{\\partial y}\\right)^2}',
    live: (s) => (s.analysis ? `u_{\\mathrm{slope}} = \\operatorname{clamp}\\!\\left(\\frac{${s.criteria.slopeMax} - ${fmt(s.analysis.terrain.slopeCenter, 2)}}{${s.criteria.slopeMax}},\\,0,\\,1\\right) = ${fmt(s.analysis.assessment.utilities.slope, 3)}` : null),
    source: 'NASA SP-2020-5009602',
  },
  tri: {
    title: 'Terrain Ruggedness Index (TRI)',
    body: 'Mean absolute elevation difference between a $5\\,\\mathrm{m}$ cell and its 8 neighbours. Establishes local relief at the DEM’s effective resolution — not individual boulders.',
    live: (s) => (s.analysis?.terrain.tri != null ? `u_{\\mathrm{TRI}} = \\operatorname{clamp}\\!\\left(\\frac{${s.criteria.triMax} - ${fmt(s.analysis.terrain.tri, 2)}}{${s.criteria.triMax}},\\,0,\\,1\\right) = ${fmt(s.analysis.assessment.utilities.tri, 3)}` : null),
    source: 'Riley et al. 1999; LOLA 5 m',
  },
  cpr: {
    title: 'Mini-RF Circular Polarization Ratio (CPR)',
    body: 'Same-sense / opposite-sense ($\\mathrm{SC}/\\mathrm{OC}$) S-band radar backscatter from the LRO Mini-RF global mosaic. Indicates wavelength-scale roughness (or coherent volume scattering from near-surface ice); kept as an independent layer, never fused into a “boulder proxy”.',
    source: 'PDS Mini-RF global CPR mosaic (32 ppd)',
  },
  psr: {
    title: 'Distance to Permanently Shadowed Region',
    body: 'Distance $d_{\\mathrm{PSR}}$ to the nearest PSR (PGDA Product 69 map). Science filter for EVA walk-back ($2\\,\\mathrm{km}$) or LTV range ($10\\,\\mathrm{km}$).',
    live: (s) => (s.analysis && s.criteria.psrFilter ? `u_{\\mathrm{PSR}} = \\operatorname{clamp}\\!\\left(\\frac{${s.criteria.dPsrMax} - ${fmt(s.analysis.terrain.dPsrKm, 2)}}{${s.criteria.dPsrMax}},\\,0,\\,1\\right) = ${fmt(s.analysis.assessment.utilities.psr, 3)}` : null),
    source: 'Mazarico et al. 2011; Artemis III SDT Report',
  },
  ellipse: {
    title: 'Landing ellipse $R_{\\mathrm{ellipse}}$',
    body: '$3\\sigma$ guidance footprint. With a non-zero radius, $\\ge 95\\%$ of the $5\\,\\mathrm{m}$ cells inside must satisfy $\\alpha \\le \\alpha_{\\max}$.',
    source: 'Spec v2.0 §2.5',
  },
  confidence: {
    title: 'Data Confidence $C_{\\mathrm{data}}$',
    body: 'Reliability of the terrain evidence: share of $5\\,\\mathrm{m}$ cells holding direct LOLA shots, interpolation fraction inside the footprint, and horizon uncertainty propagated from the published $\\sigma_z$ maps.',
    formula: 'C_{\\mathrm{data}} = 100\\,(0.50\\,q_{\\mathrm{source}} + 0.30\\,(1 - f_{\\mathrm{interp}}) + 0.20\\,q_{\\mathrm{horizon}}), \\quad q_{\\mathrm{horizon}} = \\operatorname{clamp}\\!\\left(1 - \\frac{\\sigma_{h,\\max}}{0.5^\\circ},\\,0,\\,1\\right)',
    live: (s) => (s.analysis ? `C_{\\mathrm{data}} = 100\\,(0.50\\cdot${fmt(s.analysis.terrain.qSource, 2)} + 0.30\\,(1 - ${fmt(s.analysis.terrain.fInterp, 2)}) + 0.20\\cdot${fmt(s.analysis.assessment.qHorizon, 2)}) = ${fmt(s.analysis.assessment.confidence, 1)}` : null),
    source: 'Spec v2.0 §6.4',
  },
  suitability: {
    title: 'Suitability $S_{\\mathrm{suit}}$',
    body: 'Ranks feasible sites by engineering margins. Weights $w_k$ are user-configurable ranking weights, not engineering law; unavailable utilities are dropped and the rest renormalised.',
    formula: 'S_{\\mathrm{suit}} = 100 \\sum_k w_k\\,u_k, \\qquad \\sum_k w_k = 1',
    live: (s) => {
      const a = s.analysis?.assessment;
      if (!a) return null;
      const u = a.utilities, w = a.weights;
      return `S_{\\mathrm{suit}} = 100\\,(${fmt(w.sun, 2)}\\cdot${fmt(u.sun, 2)} + ${fmt(w.comm, 2)}\\cdot${fmt(u.comm, 2)} + ${fmt(w.slope, 2)}\\cdot${fmt(u.slope, 2)}${u.tri != null ? ` + ${fmt(w.tri, 2)}\\cdot${fmt(u.tri, 2)}` : ''}${u.psr != null ? ` + ${fmt(w.psr, 2)}\\cdot${fmt(u.psr, 2)}` : ''}) = ${fmt(a.suitability, 1)}`;
    },
    source: 'Spec v2.0 §6.3',
  },
  feasibility: {
    title: 'Feasibility gate $G_{\\mathrm{hard}}$',
    body: 'Non-compensatory: any violated mandatory constraint is FAIL regardless of weights. Missing evidence (unresolved $L_{\\mathrm{base}}$, $C_{\\mathrm{data}} < C_{\\mathrm{data,min}}$) is UNKNOWN / LOW CONFIDENCE — never PASS.',
    source: 'Spec v2.0 §6.2, VAL-05/06',
  },
  horizon: {
    title: 'Local horizon profile $h_{\\mathrm{mask}}(\\varphi)$',
    body: 'Maximum curvature-corrected terrain elevation angle per azimuth, ray-cast to $150\\,\\mathrm{km}$ over real LOLA terrain. Uncertainty $\\sigma_h$ propagates the published DEM vertical error at the ridge distance.',
    formula: '\\theta(r) = \\operatorname{atan2}\\!\\big((R+z)\\cos\\psi - (R+z_0),\\;(R+z)\\sin\\psi\\big), \\; \\psi = \\frac{r}{R}; \\quad \\sigma_h = \\arctan\\frac{\\sqrt{\\sigma_{z_0}^2 + \\sigma_{z,\\mathrm{peak}}^2}}{r_{\\mathrm{peak}}}',
    source: 'Spec v2.0 §5.2',
  },
  power: {
    title: 'Solar power generation',
    body: 'Electrical output of a solar array at the site: solar constant scaled to the Sun distance, array area $A$, efficiency $\\eta$ and losses $L$, visible solar-disk fraction $f_{\\mathrm{sun}}$, and cosine of the incidence angle $i$.',
    formula: 'P = 1361\\left(\\frac{1\\,\\mathrm{AU}}{r}\\right)^2 A\\,\\eta\\,(1-L)\\,f_{\\mathrm{sun}}\\,\\max(0,\\cos i); \\quad \\cos i = \\sin(\\mathrm{el})\\cos\\beta + \\cos(\\mathrm{el})\\sin\\beta\\cos(\\Delta\\mathrm{az})',
    live: (s) => (s.analysis?.power ? `\\overline{P} = ${fmt(s.analysis.power.meanW, 0)}\\,\\mathrm{W}, \\; E = ${fmt(s.analysis.power.energyKWh, 1)}\\,\\mathrm{kWh}\\;(${s.criteria.missionH}\\,\\mathrm{h},\\; A=${s.power.areaM2}\\,\\mathrm{m}^2,\\; \\eta=${fmt(s.power.efficiency * 100, 0)}\\%,\\; \\beta=${s.power.tiltDeg}^\\circ)` : null),
    source: 'Spec v2.0 §2.3 (Phase 4)',
  },
};

/** Typographic minus for live substitutions; `paren` brackets a negative subtrahend: a - (-b). */
const num = (v: number | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '\\text{—}' : v < 0 ? `-${fmt(-v, d)}` : fmt(v, d));
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
  const closeTimer = useRef(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const doc = DOCS[id];
  const live = useApp((s) => (open && doc?.live ? doc.live(s) : null));

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = Math.min(410, window.innerWidth - 24);
    const h = card.current?.offsetHeight ?? 160;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    setPos({ left, top });
  }, [open, live]);

  if (!doc) return <>{tx(children)}</>;
  return (
    <span className="infotip" onMouseEnter={show} onMouseLeave={hideSoon}>
      {tx(children)}
      <button type="button" ref={btn} className="i-btn" aria-label={`About ${plainMath(doc.title)}`} onFocus={show} onBlur={hideSoon}>i</button>
      {open &&
        createPortal(
          <span
            className="i-card"
            role="tooltip"
            ref={card}
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
          >
            <strong>{tx(doc.title)}</strong>
            <span>{tx(doc.body)}</span>
            {doc.formula && <div className="math-box"><MathTex tex={doc.formula} /></div>}
            {live && <div className="math-box live"><MathTex tex={live} /></div>}
            {doc.source && <em>{doc.source}</em>}
          </span>,
          document.body,
        )}
    </span>
  );
}
