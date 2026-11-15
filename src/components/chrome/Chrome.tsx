/** Header (logo title, mode switch, view toggle), viewport tools, layer panel, resolution HUD, status bar, toast. */
import { useEffect, useState } from 'react';
import { useApp, type AppMode } from '../../store/useApp';
import { runtime } from '../../store/runtime';
import { fmtLat, fmtLon } from '../../lib/geo';
import { fmt } from '../../lib/math';
import { Icon } from '../common/Icons';
import { MiniStatus } from '../panels/LeftPanel';
import { LAYERS, legendFor } from '../map2d/layers';
import { tx } from '../common/Tx';

export function Header() {
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.theme);
  const tier = useApp((s) => s.tier);
  const mode = useApp((s) => s.mode);
  const hidden = useApp((s) => s.uiHidden);
  if (hidden) return null;
  const setMode = (m: AppMode) =>
    useApp.getState().set({ mode: m, leftSection: m === 'forward' ? 'search' : 'sites', rightSection: m === 'forward' ? 'recap' : 'adequacy' });
  return (
    <header className="app-header">
      <button className="brand" onClick={() => useApp.getState().set({ screen: 'menu', playing: false })} title="Back to the main menu">
        <img src={`/brand/logo-${theme === 'dark' ? 'white' : 'black'}-crop.svg`} alt="HECATE — Lunar Landing Site Navigator (main menu)" />
      </button>
      <div className="seg mode-toggle" role="tablist" aria-label="Working mode" data-tour="mode">
        <button className={mode === 'forward' ? 'on' : ''} onClick={() => setMode('forward')} role="tab" aria-selected={mode === 'forward'}><Icon.search /> Forward Search</button>
        <button className={mode === 'site' ? 'on' : ''} onClick={() => setMode('site')} role="tab" aria-selected={mode === 'site'}><Icon.target /> Site Analysis</button>
      </div>
      <div className="seg view-toggle" role="tablist" aria-label="View">
        <button className={view === '3d' ? 'on' : ''} onClick={() => useApp.getState().set({ view: '3d' })} role="tab" aria-selected={view === '3d'}><Icon.globe /> 3D globe</button>
        <button className={view === '2d' ? 'on' : ''} onClick={() => useApp.getState().set({ view: '2d' })} role="tab" aria-selected={view === '2d'}><Icon.map /> 2D polar map</button>
      </div>
      <div className="header-mid"><MiniStatus /></div>
      <div className="header-actions">
        <button className="tier-chip" onClick={() => useApp.getState().set({ tier: tier === 'beginner' ? 'advanced' : 'beginner' })} title="Experience tier — click to switch">{tier}</button>
        <button className="icon-btn" onClick={() => useApp.getState().set({ tutorialStep: 0 })} title="Interactive tutorial"><Icon.book /></button>
        <button className="icon-btn" onClick={() => useApp.getState().set({ theme: theme === 'dark' ? 'light' : 'dark' })} title="Toggle light / dark theme"><Icon.moon /></button>
        <button className="icon-btn" onClick={() => useApp.getState().set({ modal: 'about' })} title="About & mission purpose"><Icon.info /></button>
        <button className="icon-btn" onClick={() => useApp.getState().set({ modal: 'settings' })} title="Settings"><Icon.gear /></button>
      </div>
    </header>
  );
}

export function FullscreenButton() {
  const fullscreen = useApp((s) => s.fullscreen);
  const hidden = useApp((s) => s.uiHidden);
  useEffect(() => {
    const on = () => useApp.getState().set({ fullscreen: !!document.fullscreenElement });
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFs = () => {
    const el = document.querySelector('.viewport') as HTMLElement | null;
    if (!document.fullscreenElement) el?.requestFullscreen?.().catch(() => void 0);
    else document.exitFullscreen().catch(() => void 0);
  };
  if (hidden && !fullscreen) return null;
  return (
    <button className="vp-fs" onClick={toggleFs} title={fullscreen ? 'Exit full screen' : 'Full screen view'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen view'} aria-pressed={fullscreen}>
      {fullscreen ? <Icon.shrink /> : <Icon.expand />}
    </button>
  );
}

export function ViewportTools() {
  const view = useApp((s) => s.view);
  const globe = useApp((s) => s.globe);
  const hidden = useApp((s) => s.uiHidden);
  if (hidden) return null;
  const isAlbedo = globe.lighting === 'albedo';
  const reliefDisabled = view !== '3d';
  return (
    <div className="vp-tools">
      <button
        className={`btn small${globe.shadows && !isAlbedo ? ' on' : ''}`}
        disabled={isAlbedo}
        onClick={() => useApp.getState().setGlobe({ shadows: !globe.shadows })}
        title={isAlbedo ? 'Cast shadows apply only in Sun-lit mode' : 'Enable / disable lunar cast shadows'}
      >
        Shadows {globe.shadows ? 'on' : 'off'}
      </button>
      <button
        className={`btn small${isAlbedo ? ' on' : ''}`}
        onClick={() => useApp.getState().setGlobe({ lighting: globe.lighting === 'sun' ? 'albedo' : 'sun' })}
        title={isAlbedo ? 'Switch back to physical Sun illumination' : 'Unoccluded albedo inspection'}
      >
        {globe.lighting === 'sun' ? 'Sun-lit' : 'Albedo'}
      </button>
      <select
        value={globe.exaggeration}
        disabled={reliefDisabled}
        onChange={(e) => useApp.getState().setGlobe({ exaggeration: Number(e.target.value) })}
        aria-label="Vertical exaggeration (display only)"
        title={reliefDisabled ? 'Vertical exaggeration applies in 3D view only' : 'Vertical exaggeration — display only; analysis always uses true elevations'}
      >
        {[1, 2, 4, 8].map((v) => <option key={v} value={v}>{v}× relief{v > 1 ? ' (display)' : ''}</option>)}
      </select>
    </div>
  );
}

export function LayerPanel() {
  const layer = useApp((s) => s.layer);
  const opacity = useApp((s) => s.layerOpacity);
  const tier = useApp((s) => s.tier);
  const hidden = useApp((s) => s.uiHidden);
  const st = useApp();
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  const legend = legendFor(layer, st);
  const groups = [...new Set(LAYERS.map((l) => l.group))];
  return (
    <div className={`layer-panel${open ? '' : ' closed'}`} data-tour="layers">
      <button className="lp-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon.layers /> <span>Layers</span> <Icon.chevron className="chev" />
      </button>
      {open && (
        <div className="lp-body">
          {groups.map((g) => (
            <div key={g} className="lp-group">
              <span className="lp-gtitle">{g}</span>
              {LAYERS.filter((l) => l.group === g && (!l.adv || tier !== 'beginner')).map((l) => (
                <label key={l.id} className="lp-opt">
                  <input type="radio" name="layer" checked={layer === l.id} onChange={() => useApp.getState().set({ layer: l.id })} />
                  <span>{tx(l.label)}{l.timeDependent && <em className="td" title="Changes with the timeline / mission window">⏱</em>}</span>
                </label>
              ))}
            </div>
          ))}
          {layer !== 'none' && (
            <label className="lp-opacity">
              <span className="small">Opacity</span>
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => useApp.getState().set({ layerOpacity: Number(e.target.value) })} />
            </label>
          )}
          <div className="lp-toggles">
            {([['showGraticule', 'Graticule'], ['showLabels', 'Labels'], ['showSites', 'Sites'], ['showEva', 'EVA rings'], ['snapToCells', 'Cell snap']] as const).map(([k, l]) => (
              <label key={k} className="lp-opt" title={k === 'snapToCells' ? 'Snap hover & clicks to 4.75 km polar cells (hold Alt to override)' : undefined}>
                <input type="checkbox" checked={st[k]} onChange={(e) => useApp.getState().set({ [k]: e.target.checked } as never)} />
                <span>{l}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {legend && (
        <div className="legend">
          <span className="lg-title">{tx(legend.title)}</span>
          {legend.kind === 'ramp' ? (
            <>
              <div className="ramp" style={{ background: legend.stops }} />
              <div className="ramp-lbl"><span>{tx(legend.min ?? '')}</span><span>{tx(legend.max ?? '')}</span></div>
            </>
          ) : (
            legend.cats!.map((c) => (
              <div key={c.label} className="cat"><span className="sw" style={{ background: c.color }}>{c.badge}</span>{tx(c.label)}</div>
            ))
          )}
          {legend.note && <span className="small muted">{tx(legend.note)}</span>}
        </div>
      )}
    </div>
  );
}

/** Data-resolution indicator (3D-mapping feedback): source spacing vs mesh spacing vs effective resolution. */
export function StatusBar() {
  const hover = useApp((s) => s.hover);
  const ephem = useApp((s) => s.ephem);
  const load = useApp((s) => s.load);
  const perf = useApp((s) => s.perf);
  const view = useApp((s) => s.view);
  const lonC = useApp((s) => s.lonConvention);
  const hidden = useApp((s) => s.uiHidden);
  if (hidden) return null;
  const ephemLabel = { local: 'Ephemeris: Local Analytical Model', override: 'Ephemeris: JPL Horizons Override Active', unreachable: 'Ephemeris: Local Analytical Model [Offline Mode — Unverified]', checking: 'Ephemeris: verifying with JPL Horizons…' }[ephem.mode];
  return (
    <footer className="statusbar">
      <span className={`eph ${ephem.mode}`} title={ephem.detail}>● {ephemLabel}</span>
      <span className="mono">{hover ? `${fmtLat(hover.lat, 4)} ${fmtLon(hover.lon, lonC, 3)}${hover.elev != null ? ` · ${fmt(hover.elev, 0)} m` : ''}${hover.label ? ` · ${hover.label}` : ''}` : <span className="muted">Cursor not on map</span>}</span>
      {load.label && load.phase === 'ready' && load.progress < 1 && (
        <span className="loadinfo"><span className="mini-progress"><span style={{ width: `${load.progress * 100}%` }} /></span>{load.label}</span>
      )}
      <span className="grow" />
      <span className="muted">{runtime.data?.manifest.provenance_short ?? ''}</span>
      {view === '3d' && <span className="mono muted">{perf.fps.toFixed(0)} fps · {perf.tiles} tiles · {(perf.triangles / 1000).toFixed(0)}k tris</span>}
    </footer>
  );
}

export function Toast() {
  const t = useApp((s) => s.toast);
  if (!t) return null;
  const icon = t.icon === 'warn' ? <Icon.warn /> : t.icon === 'pole' ? <Icon.pole /> : t.icon === 'info' ? <Icon.info /> : null;
  return (
    <div className={`toast${t.icon === 'warn' ? ' warn' : ''}`} role="status">
      {icon && <span className="toast-icon">{icon}</span>}
      <span>{t.msg}</span>
    </div>
  );
}
