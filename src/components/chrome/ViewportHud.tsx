/**
 * Viewport HUD (feedback v2), docked at the right edge of the view, Google Earth Pro style: no panels,
 * controls stay translucent until hovered.
 *   - Sun & Earth vector dial: compass rose turned with the view heading, showing the solar
 *     azimuth and the Earth (DTE) azimuth at the focus point / inspected site, with elevations.
 *   - Navigation hub in the Google Earth style: look ring (tilt / heading), move pad (pan),
 *     north reset, and a vertical logarithmic zoom slider with +/- buttons.
 *   - South-Pole centre, hide-UI and PNG snapshot buttons.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useApp, type NavCommand } from '../../store/useApp';
import { geometryAt, sunTopo, earthTopo } from '../../science/ephemeris';
import { siteFrame } from '../../lib/geo';
import { fmt } from '../../lib/math';
import { Icon } from '../common/Icons';
import { takeSnapshot } from '../../store/snapshot';

function useHold(cmd: () => NavCommand) {
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      useApp.getState().nav(cmd());
      stop();
      timer.current = window.setInterval(() => useApp.getState().nav(cmd()), 40);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  };
}

function Dial() {
  const cam = useApp((s) => s.cam);
  const epoch = useApp((s) => s.epoch);
  const sel = useApp((s) => s.selection);
  const ref = sel ?? { lat: cam.lat, lon: cam.lon };
  const info = useMemo(() => {
    const f = siteFrame(ref.lat, ref.lon, 0);
    const g = geometryAt(epoch);
    return { sun: sunTopo(f, g), earth: earthTopo(f, g) };
  }, [ref.lat, ref.lon, epoch]);
  const rot = -cam.heading;
  const R = 46;
  const mark = (az: number, el: number) => {
    const a = ((az + rot) * Math.PI) / 180;
    const r = R * (1 - Math.max(-0.15, Math.min(1, el / 90)) * 0.85);
    return [60 + r * Math.sin(a), 60 - r * Math.cos(a)];
  };
  const [sx, sy] = mark(info.sun.az, info.sun.el);
  const [ex, ey] = mark(info.earth.az, info.earth.el);
  return (
    <div className="dial" title={`Sun & Earth vectors at ${sel ? sel.name : 'the view focus'}`} data-tour="dial">
      <svg viewBox="0 0 120 120" aria-label="Sun and Earth vector dial">
        <circle cx="60" cy="60" r="52" className="dial-face" />
        <circle cx="60" cy="60" r={R * (1 - 0.85 * (10 / 90))} className="dial-ring" />
        <circle cx="60" cy="60" r={R} className="dial-ring hz" />
        <g transform={`rotate(${rot} 60 60)`}>
          {['N', 'E', 'S', 'W'].map((l, i) => (
            <text key={l} x="60" y="22" className={`dial-card${l === 'N' ? ' n' : ''}`} transform={`rotate(${i * 90} 60 60)`}>{l}</text>
          ))}
          {[...Array(12)].map((_, i) => <line key={i} x1="60" y1="9" x2="60" y2={i % 3 ? 12 : 14} className="dial-tick" transform={`rotate(${i * 30} 60 60)`} />)}
        </g>
        <line x1="60" y1="60" x2={sx} y2={sy} className="dial-vec sun" />
        <line x1="60" y1="60" x2={ex} y2={ey} className="dial-vec earth" />
        <circle cx={sx} cy={sy} r="5" className={`dial-sun${info.sun.el < 0 ? ' below' : ''}`} />
        <circle cx={ex} cy={ey} r="5" className={`dial-earth${info.earth.el < 0 ? ' below' : ''}`} />
        <circle cx="60" cy="60" r="2" className="dial-center" />
      </svg>
      <div className="dial-read mono">
        <span className="sun">☀ {fmt(info.sun.az, 0)}° / {fmt(info.sun.el, 1)}°</span>
        <span className="earth">⊕ {fmt(info.earth.az, 0)}° / {fmt(info.earth.el, 1)}°</span>
      </div>
    </div>
  );
}

const RMIN = 0.05, RMAX = 60000;
const toSlider = (r: number) => (Math.log(r) - Math.log(RMIN)) / (Math.log(RMAX) - Math.log(RMIN));
const fromSlider = (v: number) => Math.exp(Math.log(RMIN) + v * (Math.log(RMAX) - Math.log(RMIN)));

function NavHub() {
  const cam = useApp((s) => s.cam);
  const view = useApp((s) => s.view);
  const lookUp = useHold(() => ({ type: 'look', dHeading: 0, dTilt: 2 }));
  const lookDown = useHold(() => ({ type: 'look', dHeading: 0, dTilt: -2 }));
  const lookL = useHold(() => ({ type: 'look', dHeading: -3, dTilt: 0 }));
  const lookR = useHold(() => ({ type: 'look', dHeading: 3, dTilt: 0 }));
  const mvU = useHold(() => ({ type: 'pan', fwd: 1, right: 0 }));
  const mvD = useHold(() => ({ type: 'pan', fwd: -1, right: 0 }));
  const mvL = useHold(() => ({ type: 'pan', fwd: 0, right: -1 }));
  const mvR = useHold(() => ({ type: 'pan', fwd: 0, right: 1 }));
  const zin = useHold(() => ({ type: 'zoom', factor: 0.93 }));
  const zout = useHold(() => ({ type: 'zoom', factor: 1.075 }));
  const track = useRef<HTMLDivElement>(null);
  const setFromY = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    useApp.getState().nav({ type: 'range', rangeKm: fromSlider(v) });
  };
  const ringDrag = useRef<{ a: number; h: number } | null>(null);
  const ringAngle = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
  };
  return (
    <div className="navhub">
      <div className="nav-look"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          ringDrag.current = { a: ringAngle(e), h: useApp.getState().cam.heading };
        }}
        onPointerMove={(e) => {
          if (!ringDrag.current) return;
          const d = ringAngle(e) - ringDrag.current.a;
          const target = ringDrag.current.h - d;
          useApp.getState().nav({ type: 'look', dHeading: ((target - useApp.getState().cam.heading + 540) % 360) - 180, dTilt: 0 });
        }}
        onPointerUp={() => (ringDrag.current = null)}
        title="Drag the ring to rotate · arrows look around">
        <button className="nav-n" style={{ transform: `rotate(${-cam.heading}deg) translateY(-37px) rotate(${cam.heading}deg)` }} onClick={() => useApp.getState().nav({ type: 'north' })} title="Reset north up" aria-label="Reset north up">N</button>
        <button className="nav-a up" {...lookUp} title={view === '3d' ? 'Tilt toward horizon' : 'Rotate'} aria-label="Look up">▲</button>
        <button className="nav-a down" {...lookDown} aria-label="Look down">▼</button>
        <button className="nav-a left" {...lookL} aria-label="Rotate left">◀</button>
        <button className="nav-a right" {...lookR} aria-label="Rotate right">▶</button>
        <span className="nav-eye"><Icon.eye /></span>
      </div>
      <div className="nav-move" title="Move">
        <button className="nav-a up" {...mvU} aria-label="Move forward">▲</button>
        <button className="nav-a down" {...mvD} aria-label="Move back">▼</button>
        <button className="nav-a left" {...mvL} aria-label="Move left">◀</button>
        <button className="nav-a right" {...mvR} aria-label="Move right">▶</button>
        <span className="nav-hand">✥</span>
      </div>
      <div className="nav-zoom">
        <button className="nav-z" {...zin} aria-label="Zoom in"><Icon.plus /></button>
        <div className="nav-track" ref={track}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setFromY(e.clientY); }}
          onPointerMove={(e) => e.buttons === 1 && setFromY(e.clientY)}
          role="slider" aria-label="Zoom" aria-valuenow={Math.round(cam.rangeKm)} aria-valuetext={cam.rangeKm >= 1 ? `${cam.rangeKm.toFixed(0)} km` : `${(cam.rangeKm * 1000).toFixed(0)} m`}>
          <div className="nav-thumb" style={{ top: `${toSlider(Math.max(RMIN, Math.min(RMAX, cam.rangeKm))) * 100}%` }} />
        </div>
        <button className="nav-z" {...zout} aria-label="Zoom out"><Icon.minus /></button>
        <span className="nav-range mono">{cam.rangeKm >= 10 ? `${cam.rangeKm.toFixed(0)} km` : cam.rangeKm >= 1 ? `${cam.rangeKm.toFixed(1)} km` : `${(cam.rangeKm * 1000).toFixed(0)} m`}</span>
      </div>
    </div>
  );
}

export function ViewportHud() {
  const hidden = useApp((s) => s.uiHidden);
  const view = useApp((s) => s.view);
  const tutorialStep = useApp((s) => s.tutorialStep);
  const tourActive = tutorialStep === 4;
  return (
    <div className="vp-hud">
      <Dial />
      <div className={`navhub-group${tourActive ? ' tour-active' : ''}`} data-tour="navhub">
        <NavHub />
        <div className="hud-buttons">
          <button className="hud-btn" onClick={() => useApp.getState().nav({ type: 'pole' })} title="Back to the centre of the South Pole" aria-label="Back to the South Pole"><Icon.pole /></button>
          <button className="hud-btn" onClick={() => useApp.getState().set({ uiHidden: !hidden })} title={hidden ? 'Show panels' : 'Hide all panels'} aria-label={hidden ? 'Show UI' : 'Hide UI'} aria-pressed={hidden}>{hidden ? <Icon.eye /> : <Icon.eyeOff />}</button>
          <button className="hud-btn" onClick={() => void takeSnapshot(view)} title="Save a PNG of the current view" aria-label="Save PNG"><Icon.camera /></button>
        </div>
      </div>
    </div>
  );
}
