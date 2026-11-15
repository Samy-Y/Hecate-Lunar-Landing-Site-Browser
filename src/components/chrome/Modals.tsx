/** About modal, unified Settings modal (Beginner / Advanced) and the interactive tutorial. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../store/useApp';
import { runtime, validateShadows } from '../../store/runtime';
import { Icon } from '../common/Icons';
import { Field, Toggle, useBasePreset } from '../panels/LeftPanel';
import { tx } from '../common/Tx';

function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const DISCLAIMERS = [
  {
    id: 'real_nasa_terrain',
    title: 'Real NASA terrain',
    body: 'All terrain is real LOLA altimetry: 5 m polar DEMs (PDS GDR cap to 87.5°S and PGDA Product 78 Artemis site patches), the PGDA Product 90 adjusted 80 m regional DEM, and the 16 ppd global model. Data confidence uses per-pixel LOLA shot counts and published uncertainty maps.',
  },
  {
    id: 'resolution_honesty',
    title: 'Resolution honesty',
    body: 'A 5 m grid is not 5 m of measurement — most 5 m pixels are interpolated between LOLA tracks. Unsupported cells are UNKNOWN / LOW CONFIDENCE, never PASS. The resolution indicator shows source spacing, mesh spacing and effective resolution.',
  },
  {
    id: 'geometric_only',
    title: 'Geometric only',
    body: 'Sunlight is geometric visibility of the finite solar disk above the terrain horizon; DTE is line-of-sight, not a closed RF link budget. Solar power uses a cosine-loss array model.',
  },
  {
    id: 'ephemeris',
    title: 'Ephemeris',
    body: 'Tier 1 local model (Astronomy Engine + IAU lunar orientation) validated against NASA JPL Horizons; inspected sites are re-verified live when online.',
  },
] as const;

export function AboutModal() {
  const m = runtime.data?.manifest;
  return (
    <Modal title="About HECATE" onClose={() => useApp.getState().set({ modal: null })} wide>
      <p>HECATE evaluates how solar illumination and direct-to-Earth line-of-sight interact with South-Pole topography, while tracking how much of the terrain is actually measured. Two modes: <b>Forward Search</b> (criteria-first screening of 80°S–90°S) and <b>Site Analysis</b> (inspect, select, rank and compare chosen sites).</p>
      <h3>Scientific disclaimers</h3>
      <div className="disclaimer-grid">
        {DISCLAIMERS.map((d) => (
          <article key={d.id} className="disclaimer-card">
            <div className="disclaimer-media">
              <img
                src={`/about/${d.id}.png`}
                alt={d.title}
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = `/about/${d.id}.svg`;
                }}
              />
            </div>
            <div className="disclaimer-copy">
              <strong>{d.title}</strong>
              <p>{d.body}</p>
            </div>
          </article>
        ))}
      </div>
      <h3>Data registry</h3>
      <table className="checks compact">
        <tbody>
          {(m?.registry ?? []).map((r) => (
            <tr key={r.name}><td><b>{r.name}</b><div className="small muted">{r.role}</div></td><td>{r.source}<div className="small muted">{r.resolution}</div></td></tr>
          ))}
        </tbody>
      </table>
      <h3>References</h3>
      <ul className="small refs">
        <li><a href="https://doi.org/10.1016/j.pss.2020.105119" target="_blank" rel="noopener noreferrer">Barker et al. 2021, PSS 203, 105119</a> — Improved LOLA elevation maps for South Pole landing sites (PGDA Product 78)</li>
        <li><a href="https://doi.org/10.3847/PSJ/acf3e1" target="_blank" rel="noopener noreferrer">Barker et al. 2023, PSJ 4(9), 183</a> — A new view of the lunar South Pole from LOLA (<a href="https://doi.org/10.60903/gsfcpgda-lola-spole" target="_blank" rel="noopener noreferrer">PGDA Product 90 dataset</a>)</li>
        <li><a href="https://doi.org/10.1016/j.icarus.2010.10.030" target="_blank" rel="noopener noreferrer">Mazarico et al. 2011, Icarus 211</a> — Illumination conditions of the lunar polar regions (PGDA Product 69)</li>
        <li><a href="https://doi.org/10.1007/s11214-009-9512-y" target="_blank" rel="noopener noreferrer">Smith et al. 2010</a> / LOLA team — <a href="https://pds-geosciences.wustl.edu/missions/lro/lola.htm" target="_blank" rel="noopener noreferrer">LRO LOLA Gridded Data Records, NASA PDS Geosciences Node</a></li>
        <li><a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noopener noreferrer">NASA JPL Horizons</a> — Ephemeris System; <a href="https://www.nasa.gov/wp-content/uploads/2015/01/artemis-iii-science-definition-report-12042020c.pdf" target="_blank" rel="noopener noreferrer">NASA SP-2020-5009602 Artemis III SDT Report</a>; <a href="https://ntrs.nasa.gov/citations/20250002845" target="_blank" rel="noopener noreferrer">NASA M2M-30044 (TP-20250002845)</a></li>
        <li><a href="https://doi.org/10.1016/j.icarus.2014.07.018" target="_blank" rel="noopener noreferrer">Cahill et al. 2014</a> — <a href="https://doi.org/10.17189/1520656" target="_blank" rel="noopener noreferrer">LRO Mini-RF global CPR mosaic (PDS)</a>; <a href="https://svs.gsfc.nasa.gov/4720" target="_blank" rel="noopener noreferrer">NASA SVS 4720 CGI Moon Kit</a></li>
      </ul>
      <p className="small muted">NASA Space Apps 2026 · HECATE v2.1 · technical documentation: docs/TECHNICAL_ENGINEERING.md</p>
    </Modal>
  );
}

export function SettingsModal() {
  const st = useApp();
  const c = st.criteria;
  const setC = st.setCriteria;
  const base = useBasePreset();
  const [diag, setDiag] = useState<string | null>(null);
  return (
    <Modal title="Settings" onClose={() => useApp.getState().set({ modal: null })} wide>
      <div className="settings-grid">
        <section>
          <h3>Experience tier</h3>
          <div className="seg">
            <button className={st.tier === 'beginner' ? 'on' : ''} onClick={() => st.set({ tier: 'beginner' })}>Beginner</button>
            <button className={st.tier === 'advanced' ? 'on' : ''} onClick={() => st.set({ tier: 'advanced' })}>Advanced</button>
          </div>
          <p className="small muted">Beginner shows primary controls and curated presets; Advanced adds every engineering threshold, gate, baseline and diagnostic.</p>
          <h3>Display</h3>
          <div className="seg">
            <button className={st.theme === 'dark' ? 'on' : ''} onClick={() => st.set({ theme: 'dark' })}>Dark</button>
            <button className={st.theme === 'light' ? 'on' : ''} onClick={() => st.set({ theme: 'light' })}>Light</button>
          </div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button className={st.lonConvention === '360' ? 'on' : ''} onClick={() => st.set({ lonConvention: '360' })}>Longitude 0–360°E</button>
            <button className={st.lonConvention === '180' ? 'on' : ''} onClick={() => st.set({ lonConvention: '180' })}>±180°</button>
          </div>
          <h3>3D globe</h3>
          <label className="lp-opt"><input type="checkbox" checked={st.globe.shadows} onChange={(e) => st.setGlobe({ shadows: e.target.checked })} /><span>Cast shadows (GPU horizon ray-march)</span></label>
          <label className="lp-opt"><input type="checkbox" checked={st.globe.showVectors} onChange={(e) => st.setGlobe({ showVectors: e.target.checked })} /><span>Sub-solar / sub-Earth vectors</span></label>
          <label className="lp-opt"><input type="checkbox" checked={st.globe.showEarth} onChange={(e) => st.setGlobe({ showEarth: e.target.checked })} /><span>Show Earth</span></label>
          <label className="lp-opt"><input type="checkbox" checked={st.globe.imagery === 'trek'} onChange={(e) => st.setGlobe({ imagery: e.target.checked ? 'trek' : 'local' })} /><span>Stream LROC WAC imagery (NASA Moon Trek, 100 m) when online</span></label>
          <label className="lp-opt"><input type="checkbox" checked={st.globe.morph} onChange={(e) => st.setGlobe({ morph: e.target.checked })} /><span>Continuous LOD (vertex morphing across tile levels)</span></label>
          <span className="field-label">South-pole relief on the globe</span>
          <div className="seg">
            <button className={st.globe.polarTerrain === 'polar' ? 'on' : ''} onClick={() => st.setGlobe({ polarTerrain: 'polar' })}>Polar LOLA 5 m / 80 m</button>
            <button className={st.globe.polarTerrain === 'l0' ? 'on' : ''} onClick={() => st.setGlobe({ polarTerrain: 'l0' })}>Global LOLA only (1.9 km)</button>
          </div>
          <span className="field-label">Level-of-detail quality</span>
          <div className="seg">
            {(['low', 'medium', 'high'] as const).map((q) => <button key={q} className={st.globe.quality === q ? 'on' : ''} onClick={() => st.setGlobe({ quality: q })}>{q}</button>)}
          </div>
          <h3>Ephemeris</h3>
          <label className="lp-opt"><input type="checkbox" checked={st.autoVerify} onChange={(e) => st.set({ autoVerify: e.target.checked })} /><span>Auto-verify inspected sites with JPL Horizons (Tier 2)</span></label>
          {st.tier === 'advanced' && (
            <>
              <h3>Diagnostics</h3>
              <label className="lp-opt"><input type="checkbox" checked={st.globe.debugLod} onChange={(e) => st.setGlobe({ debugLod: e.target.checked })} /><span>Colour terrain tiles by LOD level</span></label>
              <button className="btn small" onClick={async () => { setDiag('Running GPU vs CPU shadow comparison…'); setDiag(await validateShadows()); }}>Validate GPU shadows vs CPU ray-cast</button>
              {diag && <p className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{tx(diag)}</p>}
            </>
          )}
        </section>
        <section>
          <h3>Advanced mission parameters</h3>
          <Field label="Max darkness $D_{\mathrm{dark,max}}$" tip="dDark" unit="h" value={c.dDarkMaxH} min={0} max={200} step={1} onChange={(v) => setC({ dDarkMaxH: v })} defaultValue={base.criteria.dDarkMaxH} onReset={() => setC({ dDarkMaxH: base.criteria.dDarkMaxH })} />
          <Field label="Min disk fraction $f_{\mathrm{sun,min}}$" tip="fSun" unit="%" value={Math.round(c.fSunMin * 100)} min={1} max={100} step={1} onChange={(v) => setC({ fSunMin: v / 100 })} defaultValue={Math.round(base.criteria.fSunMin * 100)} onReset={() => setC({ fSunMin: base.criteria.fSunMin })} />
          <Field label="Min Earth clearance $\theta_{\mathrm{earth,min}}$" unit="°" value={c.earthMinEl} min={0} max={7} step={0.1} onChange={(v) => setC({ earthMinEl: v })} defaultValue={base.criteria.earthMinEl} onReset={() => setC({ earthMinEl: base.criteria.earthMinEl })} />
          <Field label="Max TRI" tip="tri" unit="m" value={c.triMax} min={0.1} max={1.5} step={0.05} onChange={(v) => setC({ triMax: v })} defaultValue={base.criteria.triMax} onReset={() => setC({ triMax: base.criteria.triMax })} />
          <Field label="Max radar CPR" tip="cpr" value={c.cprMax} min={0.2} max={1.5} step={0.05} onChange={(v) => setC({ cprMax: v })} defaultValue={base.criteria.cprMax} onReset={() => setC({ cprMax: base.criteria.cprMax })} />
          <Field label="Max distance to PSR $d_{\mathrm{PSR,max}}$" tip="psr" unit="km" value={c.dPsrMax} min={0.5} max={30} step={0.5} onChange={(v) => setC({ dPsrMax: v })} defaultValue={base.criteria.dPsrMax} onReset={() => setC({ dPsrMax: base.criteria.dPsrMax })} />
          <Field label="Min data confidence $C_{\mathrm{data,min}}$" tip="confidence" value={c.confMin} min={0} max={100} step={1} onChange={(v) => setC({ confMin: v })} defaultValue={base.criteria.confMin} onReset={() => setC({ confMin: base.criteria.confMin })} />
          <Toggle label="TRI hard gate" checked={c.triGate} onChange={(v) => setC({ triGate: v })} defaultChecked={base.criteria.triGate} onReset={() => setC({ triGate: base.criteria.triGate })} />
          <Toggle label="CPR hard gate" checked={c.cprGate} onChange={(v) => setC({ cprGate: v })} defaultChecked={base.criteria.cprGate} onReset={() => setC({ cprGate: base.criteria.cprGate })} />
          <Toggle label="PSR science filter" checked={c.psrFilter} onChange={(v) => setC({ psrFilter: v })} defaultChecked={base.criteria.psrFilter} onReset={() => setC({ psrFilter: base.criteria.psrFilter })} />
        </section>
      </div>
    </Modal>
  );
}

interface Step {
  sel: string;
  title: string;
  body: ReactNode;
  prepare?: () => void;
}

const STEPS: Step[] = [
  { sel: '[data-tour="mode"]', title: '1 · Two working modes', body: 'Forward Search screens the whole 80°S–90°S cap against your criteria. Site Analysis inspects, selects and compares specific sites. The HECATE logo returns to the main menu.' },
  { sel: '[data-tour="criteria"]', title: '2 · Mission criteria', body: 'Each ribbon icon opens its own section: Mission presets, Time window, Sunlight, DTE, Terrain, Science, Power, and Search at the end. Click the highlighted icon again to collapse. Save sits at the bottom, above Settings.', prepare: () => useApp.getState().set({ leftSection: 'mission' }) },
  { sel: '[data-tour="presets"]', title: '3 · Traceable presets', body: 'One click loads an Artemis III, CLPS or VIPER-class baseline with citations. Hover any (i) for the definition, the equation and its live value.', prepare: () => useApp.getState().set({ leftSection: 'mission' }) },
  { sel: '[data-tour="viewport"]', title: '4 · Explore the real Moon', body: <>Real NASA LOLA terrain, streamed down to 5 m near the pole. <kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> pan, <kbd>Shift</kbd>+<kbd>Arrows</kbd> tilt/rotate, <kbd>PageUp</kbd> / <kbd>PageDown</kbd> zoom, wheel zooms at the cursor, <kbd>P</kbd> adds/removes a site pin. Click inside 80°S–90°S to inspect a snapped 4.75 km cell (hold <kbd>Alt</kbd> for a free point), and hold <kbd>Shift</kbd>+click to multi-select sites for Compare.</> },
  { sel: '[data-tour="navhub"]', title: '5 · Navigation hub', body: 'Look ring (drag to rotate, N resets north), move pad and zoom slider work like Google Earth; they stay translucent until you hover them. The three round buttons below return to the South Pole, hide the UI and save a PNG.' },
  { sel: '[data-tour="dial"]', title: '6 · Sun & Earth dial', body: 'Azimuth and elevation of the Sun (orange) and Earth (blue, DTE) at the inspected site or view focus, turning with the view heading.' },
  { sel: '[data-tour="layers"]', title: '7 · Layers', body: 'Shaded illumination (with cast shadows), feasibility heatmaps, Sun/DTE now, PSRs, slope, data confidence… ⏱ marks layers that change with the timeline.' },
  { sel: '[data-tour="forward"]', title: '8 · Forward search', body: 'The regional screen ranks candidates for the landing epoch at the start of the pink mission window. Click a candidate to inspect it; ＋ adds it to the selected sites.', prepare: () => useApp.getState().set({ mode: 'forward', leftSection: 'search' }) },
  { sel: '[data-tour="inspector"]', title: '9 · Results panel', body: <>{tx('Recap lists every cell that passed the search, lets you filter by feasibility or $C_{\\mathrm{data}}$, and selects sites for Compare; Adequacy details one site; Compare puts sites side by side; Horizon shows the 360° panorama.')}</>, prepare: () => useApp.getState().set({ rightSection: 'recap' }) },
  { sel: '[data-tour="timeline"]', title: '10 · Time & animation', body: <>Scrub with <kbd>[</kbd> and <kbd>]</kbd>, play with <kbd>Space</kbd> at the chosen speed, drag the pink mission window, or let it follow the playhead so every ⏱ layer animates. “Next viable window” runs the Brent-refined search.</> },
  { sel: '[data-tour="save"]', title: '11 · Save your work', body: 'Save the session (criteria, power, selected sites, timing, view) as a file or in the browser, and reopen it later.', prepare: () => useApp.getState().set({ leftSection: 'mission' }) },
];

export function Tutorial() {
  const step = useApp((s) => s.tutorialStep);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ w: 340, h: 170 });
  const close = useCallback(() => useApp.getState().set({ tutorialStep: null }), []);
  const go = useCallback((n: number) => {
    if (n < 0) return;
    if (n >= STEPS.length) close();
    else useApp.getState().set({ tutorialStep: n });
  }, [close]);

  useLayoutEffect(() => {
    if (step === null) return;
    const s = STEPS[step];
    if (useApp.getState().uiHidden) useApp.getState().set({ uiHidden: false });
    s.prepare?.();
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const el = document.querySelector(s.sel) as HTMLElement | null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    // measure immediately (target usually exists), then again once the prepared panel has rendered
    const now = document.querySelector(s.sel) as HTMLElement | null;
    now?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setRect(now ? now.getBoundingClientRect() : null);
    const t1 = window.setTimeout(() => {
      const el = document.querySelector(s.sel) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      measure();
    }, 60);
    const iv = window.setInterval(measure, 350);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      alive = false;
      window.clearTimeout(t1);
      window.clearInterval(iv);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardSize({ w: cardRef.current.offsetWidth, h: cardRef.current.offsetHeight });
  }, [step, rect]);

  useEffect(() => {
    if (step === null) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(step + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(step - 1); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [step, go, close]);

  if (step === null) return null;
  const s = STEPS[step];
  const vw = window.innerWidth, vh = window.innerHeight, m = 12, gap = 12;
  let left = vw / 2 - cardSize.w / 2, top = vh / 2 - cardSize.h / 2;
  if (rect) {
    const centerLeft = rect.width > vw * 0.5 ? rect.left + 24 : rect.left + rect.width / 2 - cardSize.w / 2;
    const clampLeft = (x: number) => Math.min(vw - cardSize.w - m, Math.max(m, x));
    const clampTop = (y: number) => Math.min(vh - cardSize.h - m, Math.max(m, y));
    const fitsLeft = rect.left - cardSize.w - gap >= m;
    const fitsRight = rect.right + gap + cardSize.w <= vw - m;
    const fitsBelow = rect.bottom + gap + cardSize.h <= vh - m;
    const fitsAbove = rect.top - cardSize.h - gap >= m;
    if (fitsBelow) {
      left = clampLeft(centerLeft);
      top = rect.bottom + gap;
    } else if (fitsAbove) {
      left = clampLeft(centerLeft);
      top = rect.top - cardSize.h - gap;
    } else if (fitsLeft) {
      left = rect.left - cardSize.w - gap;
      top = clampTop(rect.top);
    } else if (fitsRight) {
      left = rect.right + gap;
      top = clampTop(rect.top);
    } else {
      left = clampLeft(rect.left + 24);
      top = clampTop(rect.bottom - cardSize.h - 24);
    }
  } else {
    left = Math.min(vw - cardSize.w - m, Math.max(m, left));
    top = Math.min(vh - cardSize.h - m, Math.max(m, top));
  }
  return (
    <div className="tour">
      {rect && <div className="tour-hole" style={{ left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }} />}
      <div className="tour-card" ref={cardRef} style={{ left, top }} role="dialog" aria-label={s.title}>
        <strong>{s.title}</strong>
        <p>{s.body}</p>
        <div className="row gap">
          <span className="small muted">{step + 1} / {STEPS.length} · <kbd>←</kbd> <kbd>→</kbd> keys</span>
          <span className="grow" />
          <button className="btn small ghost" onClick={close}>Skip</button>
          {step > 0 && <button className="btn small" onClick={() => go(step - 1)}>Back</button>}
          <button className="btn small primary" onClick={() => go(step + 1)}>{step + 1 < STEPS.length ? 'Next' : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}
