/**
 * Presentation Mode UI & conflict-free global hotkey handler.
 * - Slide 00: fullscreen #000000 opener with centered SVG logo, fades out on first Shift+Space.
 * - Slides 01..09 & Q&A Alt+1..8: floating dark-slate glassmorphic card in bottom-left of viewport.
 */
import { useEffect, useState } from 'react';
import { PRESETS } from '../../science/criteria';
import {
  applyPresentationSlide,
  enterPresentation,
  exitPresentation,
  getDiagSummary,
  jumpPresentationQa,
  PRES_SLIDES,
  QA_VIEWS,
  stepPresentationSlide,
  togglePresentation,
} from '../../science/presentation';
import { fmt } from '../../lib/math';
import { fmtHours, fmtUtc } from '../../lib/time';
import { scheduleForward, validateShadows } from '../../store/runtime';
import { useApp } from '../../store/useApp';
import { tx } from '../common/Tx';

function isTypingTarget(t: EventTarget | null): boolean {
  const n = t as HTMLElement | null;
  if (!n) return false;
  if (n.tagName === 'INPUT') {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((n as HTMLInputElement).type);
  }
  return n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable;
}

function qaDigitFromEvent(e: KeyboardEvent): number | null {
  if (e.code && /^Digit[1-8]$/.test(e.code)) return Number(e.code.slice(5));
  if (/^[1-8]$/.test(e.key)) return Number(e.key);
  return null;
}

/** Headless global keyboard controller + fullscreen Slide 00 black opener + Q&A detail overlays. */
export function PresentationOverlays() {
  const pres = useApp((s) => s.presentation);
  const dataReady = useApp((s) => s.load.phase === 'ready');

  // Optional URL trigger ?present=1 on initial load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('present') === '1' && !useApp.getState().presentation.active) {
      enterPresentation(0);
    }
  }, []);

  // Re-apply active choreography once terrain/manifest boot completes behind Slide 00.
  useEffect(() => {
    if (dataReady && useApp.getState().presentation.active) {
      applyPresentationSlide(useApp.getState().presentation.slide);
    }
  }, [dataReady]);

  // Global capture-phase keybindings with zero conflict against Timeline Space / Canvas navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const isToggleChord = (e.code === 'KeyP' || k === 'p') && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey;
      if (isToggleChord) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!e.repeat) togglePresentation();
        return;
      }

      const st = useApp.getState();
      if (!st.presentation.active) return;

      if (e.key === 'Escape' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!e.repeat) exitPresentation();
        return;
      }

      if (isTypingTarget(e.target)) return;

      const isAdvance = (e.code === 'Space' || e.key === ' ') && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      if (isAdvance) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!e.repeat) stepPresentationSlide(1);
        return;
      }

      const isBack = (e.code === 'Backspace' || e.key === 'Backspace') && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
      if (isBack) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!e.repeat) stepPresentationSlide(-1);
        return;
      }

      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const qa = qaDigitFromEvent(e);
        if (qa !== null) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (!e.repeat) jumpPresentationQa(qa);
        }
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!pres.active) return null;

  const showOpener = pres.slide === 0 || pres.openerFading;

  return (
    <>
      {showOpener && (
        <div
          className={`pres-opener${pres.openerFading ? ' fading' : ''}`}
          role="dialog"
          aria-label="HECATE Presentation Opener"
        >
          <img src="/brand/logo-white-crop.svg" alt="HECATE" className="pres-opener-logo" />
        </div>
      )}
      {pres.qaPanel === 'baselines' && <QaBaselinesModal />}
      {pres.qaPanel === 'telemetry' && <QaTelemetryModal />}
    </>
  );
}

/** Floating bottom-left narrative card inside `.viewport`, always clear of Timeline and side drawers. */
export function PresentationCard() {
  const pres = useApp((s) => s.presentation);
  const screen = useApp((s) => s.screen);
  const view = useApp((s) => s.view);

  if (!pres.active || screen !== 'workbench' || pres.slide === 0) return null;

  const spec = PRES_SLIDES[pres.slide] ?? PRES_SLIDES[1];
  const qaSpec = pres.qaId ? QA_VIEWS.find((q) => q.id === pres.qaId) : null;
  const badgeText = qaSpec ? 'Q&A' : spec.badge;
  const titleText = qaSpec ? qaSpec.title : spec.title;

  return (
    <aside
      className={`pres-card${view === '2d' ? ' map2d' : ''}`}
      role="region"
      aria-label={`Presentation ${badgeText}`}
    >
      <div className="pres-head">
        <span className={`pres-badge${qaSpec ? ' qa' : ''}`}>{badgeText}</span>
        <span className="pres-kicker">{qaSpec ? qaSpec.label : spec.label}</span>
        <div className="pres-nav">
          <button
            type="button"
            className="pres-btn"
            onClick={() => stepPresentationSlide(-1)}
            disabled={pres.slide <= 0}
            aria-label="Previous slide"
          >
            ‹
          </button>
          <button
            type="button"
            className="pres-btn"
            onClick={() => stepPresentationSlide(1)}
            disabled={pres.slide >= PRES_SLIDES.length - 1}
            aria-label="Next slide"
          >
            ›
          </button>
          <button
            type="button"
            className="pres-btn"
            onClick={() => exitPresentation()}
            aria-label="Exit presentation mode"
          >
            ×
          </button>
        </div>
      </div>

      <h2 className="pres-title">{titleText}</h2>
      <SlideBody slide={pres.slide} qaId={pres.qaId} />
    </aside>
  );
}

function SlideBody({ slide, qaId }: { slide: number; qaId: number | null }) {
  const forward = useApp((s) => s.forward);
  const forwardBusy = useApp((s) => s.forwardBusy);
  const analysis = useApp((s) => s.analysis);
  const selection = useApp((s) => s.selection);
  const ephem = useApp((s) => s.ephem);
  const epoch = useApp((s) => s.epoch);
  const cam = useApp((s) => s.cam);
  const res = useApp((s) => s.resolution);

  if (qaId !== null) {
    return <QaBody qaId={qaId} resM={res?.meshM ?? null} ephemDetail={ephem.detail} />;
  }

  switch (slide) {
    case 1:
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Peaks catch grazing sunlight beside permanently shadowed cold traps.
          </p>
          <div className="pres-metrics">
            <span><b className="pres-num">&lt;110 K</b> Cold Traps</span>
            <span><b className="pres-num">1.54°</b> Axis Tilt</span>
          </div>
        </div>
      );

    case 2:
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Artemis III baseline screened continuously across the South Pole cap.
          </p>
          <div className="pres-metrics">
            <span>
              <b className="pres-num">{forwardBusy ? 'Screening…' : `${forward?.counts.pass ?? '—'} PASS`}</b>
              {' '}Verified
            </span>
            <span><b className="pres-num">640 m</b> Grid Step</span>
          </div>
        </div>
      );

    case 3:
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Streaming NASA LOLA quadtree down to 5 m resolution.
          </p>
          <div className="pres-metrics">
            <span><b className="pres-num">{cam.rangeKm.toFixed(1)} km</b> Range</span>
            <span><b className="pres-num">{res ? `${res.meshM} m` : '5 m'}</b> Active LOD</span>
          </div>
        </div>
      );

    case 4: {
      const a = analysis?.assessment;
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Hard safety gates separated from weighted ranking &amp; data quality.
          </p>
          <div className="pres-metrics">
            <span><b className="pres-num">{a ? a.status : 'PASS'}</b> Status</span>
            <span><b className="pres-num">{a ? `${fmt(a.suitability, 0)}/100` : '—'}</b> Suit.</span>
            <span><b className="pres-num">{a ? `${fmt(a.confidence, 0)}/100` : '—'}</b> Conf.</span>
          </div>
        </div>
      );
    }

    case 5: {
      const m = analysis?.metrics;
      const pw = analysis?.power;
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Live Sun shadows synchronized with array power &amp; Earth DTE for <b className="pres-num">{selection?.siteId ?? 'CR-A'}</b>.
          </p>
          <div className="pres-metrics">
            <span><b className="pres-num">{fmtUtc(epoch).slice(5, 16)}</b> UTC</span>
            <span><b className="pres-num">{m ? fmtHours(m.dSunH) : '—'}</b> Sun</span>
            <span><b className="pres-num">{pw ? `${fmt(pw.meanW, 0)} W` : '—'}</b> Power</span>
          </div>
        </div>
      );
    }

    case 6:
      return (
        <div className="pres-body">
          <p className="pres-copy">
            360° terrain-masked horizon &amp; PSR distance with explicit limits.
          </p>
          <div className="pres-thumbs">
            <div className="pres-thumb">
              <img src="/about/resolution_honesty.png" alt="5 m resolution limit" />
              <span><b>5 m / px DEM</b>Sub-meter rocks unresolved</span>
            </div>
            <div className="pres-thumb">
              <img src="/about/geometric_only.png" alt="Geometric lighting model" />
              <span><b>Geometric Only</b>No thermal solver</span>
            </div>
          </div>
        </div>
      );

    case 7:
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Cross-checked live against NASA JPL Horizons ephemeris.
          </p>
          <div className="pres-metrics">
            <span>
              <b className="pres-num">{ephem.mode === 'checking' ? 'QUERY…' : ephem.mode === 'override' ? 'OVERRIDE' : ephem.mode === 'unreachable' ? 'LOCAL' : 'VERIFIED'}</b>
              {' '}Horizons
            </span>
            <span><b className="pres-num">&lt;0.05°</b> Spec</span>
          </div>
        </div>
      );

    case 8:
      return (
        <div className="pres-body">
          <div className="pres-roadmap">
            <div><span className="pres-num">01</span><b>Impact Risk (50 cm)</b></div>
            <div><span className="pres-num">02</span><b>Complex craters</b></div>
            <div><span className="pres-num">03</span><b>ML Boulders &amp; &lt;110 K Volatiles</b></div>
            <div><span className="pres-num">04</span><b>UI/UX Refinements</b></div>
          </div>
        </div>
      );

    case 9:
    default:
      return (
        <div className="pres-body">
          <p className="pres-copy">
            Traceable lunar South Pole mission planning. Zero server lock-in.
          </p>
          <div className="pres-metrics">
            <span><b className="pres-num">lunar.ma</b> Live App</span>
          </div>
        </div>
      );
  }
}

function QaBody({ qaId, resM, ephemDetail }: { qaId: number; resM: number | null; ephemDetail: string }) {
  const details: Record<number, string> = {
    1: '2D Polar Stereographic projection synced to timeline illumination and snapped 4.75 km horizon cells.',
    2: 'Expanded scoring gate $G_{\\mathrm{hard}}$, normalized weights $w_k$, and LOLA shot-density confidence model.',
    3: ephemDetail,
    4: '1440-bin $5\\,\\mathrm{m}$ horizon skyline overlaid with Sun/Earth arcs and PSR distance contours.',
    5: 'Inspect scientific disclaimers, PGDA/LOLA registry tables, and peer-reviewed DOI links.',
    6: 'Compare Artemis III HLS, CLPS Solar Lander, and VIPER-class Rover criteria thresholds.',
    7: 'Color cells by LOLA shot density and PGDA vertical uncertainty $\\sigma_z$ across $80^\\circ\\mathrm{S}$–$90^\\circ\\mathrm{S}$.',
    8: `Inspect GPU shadow ray-march agreement vs CPU ray-cast at $${resM ?? 5}\\,\\mathrm{m}$ terrain scale.`,
  };
  return (
    <div className="pres-body">
      <p className="pres-copy">{tx(details[qaId] ?? '')}</p>
    </div>
  );
}

function QaBaselinesModal() {
  const activePreset = useApp((s) => s.presetId);
  const close = () => {
    const p = useApp.getState().presentation;
    useApp.getState().set({ presentation: { ...p, qaPanel: null, qaId: null } });
  };

  return (
    <div className="pres-qa-modal" role="dialog" aria-label="Mission baseline comparison">
      <div className="pres-qa-card">
        <div className="pres-head">
          <span className="pres-badge qa">Q&amp;A</span>
          <span className="pres-kicker">Mission Baselines</span>
          <div className="pres-nav">
            <button type="button" className="pres-btn" onClick={close} aria-label="Close baseline table">×</button>
          </div>
        </div>
        <h3>Artemis III vs. CLPS vs. Rover Constraints</h3>
        <table className="pres-qa-table">
          <thead>
            <tr>
              <th>Baseline</th>
              <th>Stay</th>
              <th>Dark max</th>
              <th>Slope</th>
              <th>Ellipse</th>
              <th>DTE min</th>
              <th>PSR</th>
            </tr>
          </thead>
          <tbody>
            {PRESETS.map((p) => {
              const on = activePreset === p.id;
              return (
                <tr key={p.id} className={on ? 'on' : ''}>
                  <td>
                    <button
                      type="button"
                      className="pres-apply"
                      onClick={() => {
                        useApp.getState().applyPreset(p.id);
                        scheduleForward(0);
                      }}
                    >
                      {p.short} {on ? '●' : ''}
                    </button>
                  </td>
                  <td className="pres-num">{p.criteria.missionH} h</td>
                  <td className="pres-num">{p.criteria.dDarkMaxH} h</td>
                  <td className="pres-num">{p.criteria.slopeMax}° ({p.criteria.lBase} m)</td>
                  <td className="pres-num">{p.criteria.ellipseR} m</td>
                  <td className="pres-num">{p.criteria.cEarthMin}%</td>
                  <td className="pres-num">{p.criteria.psrFilter ? `≤ ${p.criteria.dPsrMax} km` : 'Optional'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QaTelemetryModal() {
  const pres = useApp((s) => s.presentation);
  const perf = useApp((s) => s.perf);
  const res = useApp((s) => s.resolution);
  const [diag, setDiag] = useState<string | null>(null);
  void pres;
  const close = () => {
    const p = useApp.getState().presentation;
    useApp.getState().set({ presentation: { ...p, qaPanel: null, qaId: null } });
  };

  return (
    <div className="pres-qa-modal" role="dialog" aria-label="Engine diagnostics">
      <div className="pres-qa-card">
        <div className="pres-head">
          <span className="pres-badge qa">Q&amp;A</span>
          <span className="pres-kicker">GPU &amp; CPU Verification</span>
          <div className="pres-nav">
            <button type="button" className="pres-btn" onClick={close} aria-label="Close telemetry modal">×</button>
          </div>
        </div>
        <h3>Real-Time LOD &amp; Shadow Validation</h3>
        <div className="pres-metrics" style={{ marginBottom: 10 }}>
          <span><b className="pres-num">{perf.fps} fps</b> Render</span>
          <span><b className="pres-num">{perf.tiles}</b> Quadtree Tiles</span>
          <span><b className="pres-num">{perf.shadowMs.toFixed(1)} ms</b> Shadow Bake</span>
          <span><b className="pres-num">{res ? `${res.meshM} m` : '—'}</b> Active Mesh</span>
        </div>
        <pre className="pres-diag-log">{diag ?? getDiagSummary() ?? 'Running GPU horizon ray-march vs CPU multi-res ray-cast…'}</pre>
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              setDiag('Re-running GPU vs CPU check…');
              setDiag(await validateShadows());
            }}
          >
            Re-run Validation
          </button>
        </div>
      </div>
    </div>
  );
}
