/**
 * Application shell: main menu over the live globe, then the workbench -
 * header, left ribbon panel, centre viewport (3D globe / 2D polar map + HUD + timeline),
 * right ribbon panel, status bar. "Hide UI" collapses every panel but keeps the view.
 */
import { useEffect } from 'react';
import { boot } from './store/runtime';
import { useApp } from './store/useApp';
import { Globe3D } from './components/globe/Globe3D';
import { PolarMap } from './components/map2d/PolarMap';
import { LeftPanel } from './components/panels/LeftPanel';
import { RightPanel } from './components/panels/RightPanel';
import { Timeline } from './components/panels/Timeline';
import { FullscreenButton, Header, LayerPanel, StatusBar, Toast, ViewportTools } from './components/chrome/Chrome';
import { AboutModal, SettingsModal, Tutorial } from './components/chrome/Modals';
import { MainMenu } from './components/chrome/MainMenu';
import { PresentationCard, PresentationOverlays } from './components/chrome/PresentationMode';
import { ViewportHud } from './components/chrome/ViewportHud';
import './styles/app.css';
import './styles/v21.css';

export function App() {
  const view = useApp((s) => s.view);
  const load = useApp((s) => s.load);
  const theme = useApp((s) => s.theme);
  const modal = useApp((s) => s.modal);
  const screen = useApp((s) => s.screen);
  const hidden = useApp((s) => s.uiHidden);
  const pres = useApp((s) => s.presentation);
  const presCls = pres.active ? ` pres-active pres-s-${pres.slide}${pres.qaId !== null ? ` pres-qa pres-qa-${pres.qaId}` : ''}` : '';
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const dataReady = load.phase === 'ready';
  return (
    <div className={`app${screen === 'menu' ? ' in-menu' : ''}${hidden ? ' ui-hidden' : ''}${presCls}`}>
      <Header />
      <div className="workbench">
        <LeftPanel />
        <main className="center">
          <div className="viewport">
            {dataReady ? (
              <>
                <div className="vp-layer" style={{ visibility: view === '3d' || screen === 'menu' ? 'visible' : 'hidden' }}>
                  <Globe3D />
                </div>
                {view === '2d' && screen === 'workbench' && (
                  <div className="vp-layer"><PolarMap /></div>
                )}
                {screen === 'workbench' && (
                  <div className="vp-overlay">
                    <LayerPanel />
                    <ViewportTools />
                    <ViewportHud />
                    <FullscreenButton />
                  </div>
                )}
                <PresentationCard />
              </>
            ) : (
              <div className="boot">
                <div className="loader" aria-hidden />
                <span>{load.error ?? load.label}</span>
                <div className="progress"><div style={{ width: `${load.progress * 100}%` }} /></div>
              </div>
            )}
          </div>
          <Timeline />
        </main>
        <RightPanel />
      </div>
      <StatusBar />
      <MainMenu />
      {modal === 'about' && <AboutModal />}
      {modal === 'settings' && <SettingsModal />}
      <Tutorial />
      <Toast />
      <PresentationOverlays />
    </div>
  );
}
