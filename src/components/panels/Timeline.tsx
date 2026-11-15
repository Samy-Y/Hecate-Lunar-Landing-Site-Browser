/**
 * Bottom timeline (spec v2.0 sec. 8.1 / 8.3, feedback v2).
 * Tracks over [t0 - slip, t0 + slip + T]: Sun disk visibility, geometric DTE, viable windows and
 * Brent-refined events. The pink mission window [t_land, t_land + T] is draggable; with
 * "Follow playhead" it rides with the playhead during playback so every time-dependent layer
 * (illumination, Sun/DTE now, forward-search heatmaps, site metrics, power) animates.
 * Keys: [ and ] step +/-1 h (Shift: +/-24 h), Space plays/pauses.
 */
import { useEffect, useMemo, useRef } from 'react';
import { tLandOf, useApp } from '../../store/useApp';
import { findNextWindow } from '../../store/runtime';
import { HOUR_MS } from '../../lib/math';
import { fmtUtc } from '../../lib/time';
import { Icon } from '../common/Icons';

const SPEEDS = [1, 3, 6, 12, 24, 48, 96];

export function Timeline() {
  const crit = useApp((s) => s.criteria);
  const epoch = useApp((s) => s.epoch);
  const playing = useApp((s) => s.playing);
  const speed = useApp((s) => s.playSpeed);
  const follow = useApp((s) => s.followPlayhead);
  const slipOffsetH = useApp((s) => s.slipOffsetH);
  const a = useApp((s) => s.analysis);
  const tLand = useApp((s) => tLandOf(s));
  const next = useApp((s) => s.nextWindow);
  const hidden = useApp((s) => s.uiHidden);
  const track = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const drag = useRef<null | { kind: 'scrub' } | { kind: 'window'; grabT: number; startOffset: number }>(null);

  const tA = crit.t0 - crit.slipH * HOUR_MS;
  const tB = Math.max(crit.t0 + (crit.slipH + crit.missionH) * HOUR_MS, tLand + crit.missionH * HOUR_MS);
  const frac = (t: number) => Math.max(0, Math.min(1, (t - tA) / (tB - tA)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = e.target as HTMLElement | null;
      if (n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT')) return;
      if (useApp.getState().screen !== 'workbench' || useApp.getState().tutorialStep !== null) return;
      if (!e.altKey && (e.key === '[' || e.key === '{')) useApp.getState().stepEpoch(e.shiftKey || e.key === '{' ? -24 : -1);
      if (!e.altKey && (e.key === ']' || e.key === '}')) useApp.getState().stepEpoch(e.shiftKey || e.key === '}' ? 24 : 1);
      if (e.key === ' ' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && n?.tagName !== 'BUTTON') {
        e.preventDefault();
        useApp.getState().set({ playing: !useApp.getState().playing });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Playback at playSpeed simulated hours per second; loops over the timeline extent.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const s = useApp.getState();
      const c = s.criteria;
      const start = c.t0 - c.slipH * HOUR_MS;
      const end = s.followPlayhead ? c.t0 + c.slipH * HOUR_MS : Math.max(c.t0 + (c.slipH + c.missionH) * HOUR_MS, tLandOf(s) + c.missionH * HOUR_MS);
      let e = s.epoch + dt * s.playSpeed * HOUR_MS;
      if (e > end || e < start) e = start;
      s.setEpoch(e);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const X = (t: number) => frac(t) * w;
    ctx.fillStyle = 'rgba(204,121,167,0.12)';
    ctx.fillRect(X(crit.t0 - crit.slipH * HOUR_MS), 0, X(crit.t0 + crit.slipH * HOUR_MS) - X(crit.t0 - crit.slipH * HOUR_MS), h);
    const rowH = (h - 6) / 3;
    if (a) {
      const s = a.timeline.series;
      for (let i = 0; i < s.t.length - 1; i++) {
        if (s.t[i] > tB) break;
        const x0 = X(s.t[i]), x1 = X(s.t[i + 1]);
        const f = s.sunF[i];
        ctx.fillStyle = f > 0 ? `rgba(230,159,0,${0.18 + 0.8 * f})` : 'rgba(20,20,26,0.9)';
        ctx.fillRect(x0, 2, Math.max(1, x1 - x0 + 0.5), rowH - 2);
        const clr = s.earthEl[i] - s.earthH[i];
        ctx.fillStyle = clr >= crit.earthMinEl ? 'rgba(86,180,233,0.85)' : clr >= 0 ? 'rgba(240,228,66,0.6)' : 'rgba(20,20,26,0.9)';
        ctx.fillRect(x0, 2 + rowH, Math.max(1, x1 - x0 + 0.5), rowH - 2);
      }
      ctx.fillStyle = 'rgba(0,158,115,0.85)';
      for (const [w0, w1] of a.slip.windows) ctx.fillRect(X(w0), 2 + 2 * rowH, Math.max(2, X(w1) - X(w0)), rowH - 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      for (const e of a.timeline.events) {
        if (e.t < tA || e.t > tB) continue;
        const x = Math.round(X(e.t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, e.kind.startsWith('earth') ? 2 + rowH : 2);
        ctx.lineTo(x, e.kind.startsWith('earth') ? 2 * rowH : rowH);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = 'rgba(128,128,128,0.15)';
      ctx.fillRect(0, 2, w, h - 4);
    }
  }, [a, crit, tA, tB]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return tA + f * (tB - tA);
  };
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const t = timeAt(e.clientX);
    const inWindow = (e.target as HTMLElement).classList.contains('tl-window');
    if (inWindow) drag.current = { kind: 'window', grabT: t, startOffset: useApp.getState().slipOffsetH };
    else {
      drag.current = { kind: 'scrub' };
      useApp.getState().setEpoch(Math.round(t / 60000) * 60000);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.buttons !== 1) return;
    const t = timeAt(e.clientX);
    if (d.kind === 'scrub') useApp.getState().setEpoch(Math.round(t / 60000) * 60000);
    else {
      const c = useApp.getState().criteria;
      const off = Math.max(-c.slipH, Math.min(c.slipH + 14 * 24, d.startOffset + (t - d.grabT) / HOUR_MS));
      useApp.getState().setSlipOffset(Math.round(off));
    }
  };

  const ticks = useMemo(() => {
    const spanD = (tB - tA) / (24 * HOUR_MS);
    const stepD = spanD > 40 ? 7 : spanD > 14 ? 2 : 1;
    const out: number[] = [];
    const first = Math.ceil(tA / (24 * HOUR_MS)) * 24 * HOUR_MS;
    for (let t = first; t <= tB; t += stepD * 24 * HOUR_MS) out.push(t);
    return out;
  }, [tA, tB]);

  if (hidden) return null;
  const btn = (label: string, h: number, title: string) => <button className="btn small ghost" title={title} onClick={() => useApp.getState().stepEpoch(h)}>{label}</button>;
  const slipBtn = (label: string, h: number) => (
    <button className={`btn small${Math.abs(slipOffsetH - h) < 1e-6 ? ' on' : ''}`} onClick={() => useApp.getState().setSlipOffset(h)} title={`Landing epoch t₀ ${label}`}>{label}</button>
  );

  return (
    <div className="timeline" data-tour="timeline">
      <div className="tl-controls">
        <button className="icon-btn" onClick={() => useApp.getState().set({ playing: !playing })} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (Space)">{playing ? <Icon.pause /> : <Icon.play />}</button>
        <select value={speed} onChange={(e) => useApp.getState().set({ playSpeed: Number(e.target.value) })} aria-label="Animation speed" title="Animation speed (simulated hours per second)">
          {SPEEDS.map((v) => <option key={v} value={v}>{v} h/s</option>)}
        </select>
        {btn('−24h', -24, 'Shift+[')}
        {btn('−1h', -1, '[')}
        <span className="tl-epoch mono" title="Displayed epoch (UTC)">{fmtUtc(epoch)}</span>
        {btn('+1h', 1, ']')}
        {btn('+24h', 24, 'Shift+]')}
        <button className="btn small ghost" onClick={() => useApp.getState().setEpoch(tLand)} title="Jump to landing epoch">↦ landing</button>
        <span className="tl-sep" />
        <label className="toggle small" title="Mission window (and every time-dependent layer) follows the playhead">
          <input type="checkbox" checked={follow} onChange={(e) => useApp.getState().set({ followPlayhead: e.target.checked })} />
          <span className="switch" aria-hidden />
          <span>Window follows playhead</span>
        </label>
        <span className="tl-sep" />
        <span className="small muted">Slip</span>
        {slipBtn('t₀', 0)}
        {slipBtn('+24 h', 24)}
        {slipBtn('+7 d', 168)}
        {slipBtn('+14 d', 336)}
        <button className="btn small primary" onClick={() => findNextWindow(365)} disabled={!a || next?.busy} title="Two-stage search for the next landing epoch that passes all temporal gates">{next?.busy ? 'Searching…' : 'Next viable window'}</button>
      </div>
      <div className="tl-track" ref={track} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
        <div className="tl-labels"><span>☀ Sun</span><span>⊕ DTE</span><span>✓ Viable</span></div>
        <canvas ref={cv} className="tl-canvas" />
        <div className="tl-window" style={{ left: `${frac(tLand) * 100}%`, width: `${(frac(tLand + crit.missionH * HOUR_MS) - frac(tLand)) * 100}%` }} title={`Mission window ${fmtUtc(tLand)} → ${fmtUtc(tLand + crit.missionH * HOUR_MS)} — drag to move the landing epoch`}>
          <span className="tl-window-label">{fmtUtc(tLand).slice(5, 16)} → {fmtUtc(tLand + crit.missionH * HOUR_MS).slice(5, 16)}</span>
        </div>
        {ticks.map((t) => <span key={t} className="tl-tick" style={{ left: `${frac(t) * 100}%` }}>{fmtUtc(t).slice(5, 10)}</span>)}
        <div className="tl-cursor" style={{ left: `${frac(epoch) * 100}%` }} />
        <div className="tl-t0" style={{ left: `${frac(crit.t0) * 100}%` }} title="Nominal t₀" />
      </div>
    </div>
  );
}
