/**
 * Main menu (feedback v2): a real start screen over the live, slowly orbiting, blurred 3D Moon,
 * with the HECATE logo centred, the two working modes, Settings, Tutorial and an About (i) button
 * in the bottom-right corner. The header logo returns here.
 */
import { useApp, type AppMode } from '../../store/useApp';
import { Icon } from '../common/Icons';

/** Enter a mode. Panels and the analysis layer are left as they are: closed / 'none' on first open. */
function enter(mode: AppMode, tutorial = false) {
  useApp.getState().set({
    screen: 'workbench',
    mode,
    tutorialStep: tutorial ? 0 : null,
    uiHidden: false,
  });
  if (mode === 'forward' || tutorial) useApp.getState().nav({ type: 'pole' });
}

export function MainMenu() {
  const screen = useApp((s) => s.screen);
  const load = useApp((s) => s.load);
  const theme = useApp((s) => s.theme);
  const tier = useApp((s) => s.tier);
  if (screen !== 'menu') return null;
  const ready = load.phase === 'ready';
  return (
    <div className="menu" role="dialog" aria-label="HECATE main menu">
      <div className="menu-glow" aria-hidden />
      <div className="menu-center">
        <img className="menu-logo" src={`/brand/logo-${theme === 'dark' ? 'white' : 'black'}-crop.svg`} alt="HECATE — Lunar Landing Site Navigator" />
        <p className="menu-tag">Decision support for lunar South Pole landing sites — every site gets three separate answers: <b>Feasibility</b>, <b>Suitability</b> and <b>Data Confidence</b>, computed from real NASA LOLA terrain.</p>
        <div className="menu-buttons">
          <button className="menu-btn primary" disabled={!ready} onClick={() => enter('forward')}>
            <Icon.search width={22} height={22} />
            <span><b>Forward Search Mode</b><small>Criteria first — screen the whole 80°S–90°S cap and rank candidates</small></span>
          </button>
          <button className="menu-btn primary" disabled={!ready} onClick={() => enter('site')}>
            <Icon.target width={22} height={22} />
            <span><b>Site Analysis Mode</b><small>Site first — inspect, select and compare specific landing sites</small></span>
          </button>
          <div className="menu-row">
            <button className="menu-btn" onClick={() => useApp.getState().set({ modal: 'settings' })}><Icon.gear /> <span><b>Settings</b></span></button>
            <button className="menu-btn" disabled={!ready} onClick={() => enter('forward', true)}><Icon.book /> <span><b>Tutorial</b></span></button>
          </div>
          <div className="menu-tier" role="radiogroup" aria-label="Experience tier">
            {(['beginner', 'advanced'] as const).map((t) => (
              <button key={t} role="radio" aria-checked={tier === t} className={tier === t ? 'on' : ''} onClick={() => useApp.getState().set({ tier: t })}>{t === 'beginner' ? 'Beginner' : 'Advanced'}</button>
            ))}
          </div>
        </div>
        {!ready && (
          <div className="menu-load">
            <div className="progress"><div style={{ width: `${load.progress * 100}%` }} /></div>
            <span className="small">{load.phase === 'error' ? load.error : load.label}</span>
          </div>
        )}
      </div>
      <button className="menu-about" onClick={() => useApp.getState().set({ modal: 'about' })} aria-label="About HECATE" title="About & mission purpose"><Icon.info width={22} height={22} /></button>
      <p className="menu-credit small">NASA Space Apps 2026 · LOLA (PDS GDR, PGDA Products 69/78/90) · LROC WAC · Mini-RF · JPL Horizons</p>
    </div>
  );
}
