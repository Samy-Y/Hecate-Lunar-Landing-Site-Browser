/**
 * Left panel (spec v2.0 sec. 8.1, feedback v2): a permanent, labelled icon ribbon plus one
 * content section at a time. Clicking an icon opens exactly that section (highlighted in the
 * ribbon); clicking it again collapses the panel to the ribbon. Save and Settings sit at the
 * bottom of the ribbon. The site picker belongs to Site Analysis mode only; Forward Search
 * mode shows the regional screen instead.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_T0, PRESETS, WEIGHT_PRESETS, WEIGHTS_DEFAULT_NO_PSR, WEIGHTS_DEFAULT_PSR, normalizedWeights, type Criteria, type Weights } from '../../science/criteria';
import { DEFAULT_POWER } from '../../science/power';
import { runtime, scheduleForward } from '../../store/runtime';
import { useApp, type LeftSection } from '../../store/useApp';
import { openSessionFile, restoreBrowserSession, saveSession } from '../../store/session';
import { parseUtc, toInputUtc, fmtHours } from '../../lib/time';
import { fmtLat, fmtLon, latLonToPolar } from '../../lib/geo';
import { fmt, HOUR_MS } from '../../lib/math';
import { Icon } from '../common/Icons';
import { InfoTip } from '../common/InfoTip';
import { StatusBadge } from '../common/Badges';
import { plainMath, tx } from '../common/Tx';

export function ResetButton({ isDefault, defaultLabel, onReset }: { isDefault: boolean; defaultLabel: string; onReset: () => void }) {
  return (
    <button
      type="button"
      className="reset-btn"
      onClick={onReset}
      disabled={isDefault}
      title={isDefault ? `At preset default (${defaultLabel})` : `Reset to default (${defaultLabel})`}
      aria-label={`Reset to default (${defaultLabel})`}
    >
      <Icon.reset />
    </button>
  );
}

export function useBasePreset() {
  const baseId = useApp((s) => s.basePresetId);
  return PRESETS.find((p) => p.id === baseId) ?? PRESETS[0];
}

export function Field({
  label, tip, unit, value, min, max, step, onChange, cite, defaultValue, defaultLabel, onReset,
}: {
  label: string;
  tip?: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  cite?: string;
  defaultValue?: number;
  defaultLabel?: string;
  onReset?: () => void;
}) {
  const isDefault = defaultValue === undefined ? true : Math.abs(value - defaultValue) < 1e-6;
  const defText = defaultLabel ?? (defaultValue === undefined ? '' : `${+defaultValue.toFixed(4)}${unit ? ` ${unit}` : ''}`);
  return (
    <div className="field">
      <span className="field-label">
        {tip ? <InfoTip id={tip}>{label}</InfoTip> : <span>{tx(label)}</span>}
        <span className="field-val">
          <input type="number" value={Number.isFinite(value) ? +value.toFixed(4) : ''} min={min} max={max} step={step} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} aria-label={plainMath(label)} />
          {unit && <span className="unit">{unit}</span>}
          {onReset && <ResetButton isDefault={isDefault} defaultLabel={defText} onReset={onReset} />}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${plainMath(label)} slider`} />
      {cite && <span className="cite">{cite}</span>}
    </div>
  );
}

export function Toggle({
  label, checked, onChange, tip, defaultChecked, onReset,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tip?: string;
  defaultChecked?: boolean;
  onReset?: () => void;
}) {
  const control = (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      {tip ? <InfoTip id={tip}>{label}</InfoTip> : <span>{tx(label)}</span>}
    </label>
  );
  if (!onReset) return control;
  return (
    <div className="toggle-row">
      {control}
      <ResetButton isDefault={defaultChecked === undefined ? true : checked === defaultChecked} defaultLabel={defaultChecked ? 'On' : 'Off'} onReset={onReset} />
    </div>
  );
}

const adv = () => useApp.getState().tier === 'advanced';

interface RibbonItem {
  id: LeftSection;
  label: string;
  icon: ReactNode;
}

function ribbonFor(mode: 'forward' | 'site'): RibbonItem[] {
  const common: RibbonItem[] = [
    { id: 'mission', label: 'Mission', icon: <Icon.rocket /> },
    { id: 'time', label: 'Time', icon: <Icon.clock /> },
    { id: 'sun', label: 'Sunlight', icon: <Icon.sun /> },
    { id: 'comm', label: 'DTE', icon: <Icon.antenna /> },
    { id: 'terrain', label: 'Terrain', icon: <Icon.mountain /> },
    { id: 'science', label: 'Science', icon: <Icon.flask /> },
    { id: 'power', label: 'Power', icon: <Icon.bolt /> },
  ];
  return mode === 'forward' ? [...common, { id: 'search', label: 'Search', icon: <Icon.search /> }] : [{ id: 'sites', label: 'Sites', icon: <Icon.target /> }, ...common];
}

/**
 * Save / open session. The menu is portalled to <body> with fixed positioning: the ribbon scrolls
 * (overflow: auto), so an absolutely positioned child would be clipped behind the side panel.
 */
function SaveButton() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.min(r.right + 8, window.innerWidth - 250), bottom: Math.max(8, window.innerHeight - r.bottom) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const run = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  return (
    <>
      <button ref={btn} className={`rib-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)} title="Save / open session" aria-haspopup="menu" aria-expanded={open} data-tour="save">
        <Icon.save />
        <span>Save</span>
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="popover save-menu" role="menu" style={{ left: pos?.left ?? -9999, bottom: pos?.bottom ?? 0 }}>
            <strong className="small">Session</strong>
            <button role="menuitem" className="btn small wide" onClick={run(() => saveSession(true))}><Icon.save /> Save session file</button>
            <button role="menuitem" className="btn small wide ghost" onClick={run(openSessionFile)}><Icon.open /> Open session file…</button>
            <button role="menuitem" className="btn small wide ghost" onClick={run(restoreBrowserSession)}>Restore last saved</button>
          </div>,
          document.body,
        )}
    </>
  );
}

export function LeftPanel() {
  const mode = useApp((s) => s.mode);
  const section = useApp((s) => s.leftSection);
  const hidden = useApp((s) => s.uiHidden);
  const items = ribbonFor(mode);
  const open = section && items.some((i) => i.id === section) ? section : null;
  if (hidden) return null;
  return (
    <aside className={`side left${open ? ' open' : ''}`} data-tour="criteria">
      <nav className="ribbon" aria-label="Criteria sections">
        {items.map((it) => (
          <button key={it.id} className={`rib-btn${open === it.id ? ' on' : ''}`} onClick={() => useApp.getState().openLeft(it.id)} aria-pressed={open === it.id} title={it.label} data-tour={`rib-${it.id}`}>
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
        <span className="grow" />
        <SaveButton />
        <button className="rib-btn" onClick={() => useApp.getState().set({ modal: 'settings' })} title="Settings">
          <Icon.gear />
          <span>Settings</span>
        </button>
      </nav>
      {open && (
        <div className="side-content">
          <header className="side-head">
            <span>{items.find((i) => i.id === open)?.label}</span>
            <button className="icon-btn small" onClick={() => useApp.getState().set({ leftSection: null })} aria-label="Collapse panel"><Icon.chevron style={{ transform: 'rotate(180deg)' }} /></button>
          </header>
          <div className="side-scroll">
            {open === 'mission' && <MissionSection />}
            {open === 'time' && <TimeSection />}
            {open === 'sun' && <SunSection />}
            {open === 'comm' && <CommSection />}
            {open === 'terrain' && <TerrainSection />}
            {open === 'science' && <ScienceSection />}
            {open === 'power' && <PowerSection />}
            {open === 'search' && <SearchSection />}
            {open === 'sites' && <SitesSection />}
          </div>
        </div>
      )}
    </aside>
  );
}

function useCite() {
  const preset = useBasePreset();
  return (k: keyof Criteria) => preset.citations[k];
}

function MissionSection() {
  const presetId = useApp((s) => s.presetId);
  return (
    <div className="sec-body">
      <p className="sec-intro">Pick a traceable NASA baseline; every value can then be tuned in the other sections.</p>
      <div className="presets" data-tour="presets">
        {PRESETS.map((p) => (
          <button key={p.id} className={`preset${presetId === p.id ? ' on' : ''}`} onClick={() => useApp.getState().applyPreset(p.id)}>
            <strong>{p.short}</strong>
            <span>{p.label}</span>
          </button>
        ))}
        {presetId === 'custom' && <span className="preset-note">Custom criteria (modified preset)</span>}
      </div>
      <RankingWeights />
    </div>
  );
}

const WEIGHT_KEYS: { k: keyof Weights; label: string }[] = [
  { k: 'sun', label: 'Sunlight $w_{\\mathrm{sun}}$' },
  { k: 'comm', label: 'Earth link (DTE) $w_{\\mathrm{comm}}$' },
  { k: 'slope', label: 'Slope $w_{\\mathrm{slope}}$' },
  { k: 'tri', label: 'Roughness (TRI) $w_{\\mathrm{tri}}$' },
  { k: 'psr', label: 'PSR proximity $w_{\\mathrm{psr}}$' },
];

/**
 * Ranking-weight presets plus manual tuning (moved here from Settings). "Custom" opens one slider per
 * weight, starting from the active preset; each shows its normalised value (sum w = 1), and its reset
 * arrow returns it to the preset the user started from.
 */
function RankingWeights() {
  const wp = useApp((s) => s.weightPresetId);
  const baseId = useApp((s) => s.baseWeightPresetId);
  const c = useApp((s) => s.criteria);
  const [editing, setEditing] = useState(false);
  const showEditor = editing || wp === 'custom';
  const w = c.weights;
  const nw = normalizedWeights(w, c.psrFilter);
  const baseW = baseId === 'default'
    ? (c.psrFilter ? WEIGHTS_DEFAULT_PSR : WEIGHTS_DEFAULT_NO_PSR)
    : (WEIGHT_PRESETS.find((q) => q.id === baseId)?.w ?? WEIGHT_PRESETS[0].w);
  const setW = (p: Partial<Weights>) => {
    const nextW = { ...w, ...p };
    useApp.getState().setCriteria({ weights: nextW });
    const modified = (Object.keys(baseW) as (keyof Weights)[]).some((k) => Math.abs(nextW[k] - baseW[k]) > 1e-6);
    useApp.getState().set({ weightPresetId: modified ? 'custom' : baseId });
  };
  return (
    <>
      <div className="field">
        <span className="field-label">
          <InfoTip id="suitability">Ranking weights</InfoTip>
          <ResetButton
            isDefault={wp === 'default'}
            defaultLabel="Default (spec 6.3)"
            onReset={() => {
              const baseW = useApp.getState().criteria.psrFilter ? WEIGHTS_DEFAULT_PSR : WEIGHTS_DEFAULT_NO_PSR;
              useApp.getState().setCriteria({ weights: baseW });
              useApp.getState().set({ weightPresetId: 'default', baseWeightPresetId: 'default' });
              setEditing(false);
            }}
          />
        </span>
        <div className="seg wrap" data-tour="weights">
          {WEIGHT_PRESETS.map((p) => (
            <button key={p.id} className={!showEditor && wp === p.id ? 'on' : ''} onClick={() => { useApp.getState().setCriteria({ weights: p.w }); useApp.getState().set({ weightPresetId: p.id, baseWeightPresetId: p.id }); setEditing(false); }}>{p.label}</button>
          ))}
          <button className={showEditor ? 'on' : ''} onClick={() => setEditing(true)} title="Set each weight manually, starting from the active preset">Custom</button>
        </div>
      </div>
      {showEditor && (
        <div className="weights-edit">
          {WEIGHT_KEYS.map(({ k, label }) => (
            <Field key={k} label={`${label}${k === 'psr' && !c.psrFilter ? ' (PSR filter off → 0)' : ''}`} unit={`→ ${nw[k].toFixed(2)}`} value={w[k]} min={0} max={1} step={0.05} onChange={(v) => setW({ [k]: v })} defaultValue={baseW[k]} onReset={() => setW({ [k]: baseW[k] })} />
          ))}
          <p className="small muted">{tx('Each arrow value is the weight after normalisation to $\\sum w = 1$. Reset buttons return to the preset you started from.')}</p>
        </div>
      )}
      <p className="small muted">Weights rank feasible sites only; they never turn a FAIL into a PASS.</p>
    </>
  );
}

function TimeSection() {
  const c = useApp((s) => s.criteria);
  const setC = useApp((s) => s.setCriteria);
  const base = useBasePreset();
  const cite = useCite();
  const end = c.t0 + c.missionH * HOUR_MS;
  return (
    <div className="sec-body">
      <div className="field">
        <span className="field-label">
          <InfoTip id="t0">Mission start — touchdown (UTC)</InfoTip>
          <ResetButton
            isDefault={Math.abs(c.t0 - DEFAULT_T0) < 1000}
            defaultLabel="2027-03-15 12:00Z"
            onReset={() => {
              setC({ t0: DEFAULT_T0 });
              useApp.getState().set({ epoch: DEFAULT_T0, slipOffsetH: 0 });
            }}
          />
        </span>
        <input type="datetime-local" value={toInputUtc(c.t0)} onChange={(e) => {
          const t = parseUtc(e.target.value);
          if (Number.isFinite(t)) {
            setC({ t0: t });
            useApp.getState().set({ epoch: t, slipOffsetH: 0 });
          }
        }} />
      </div>
      <div className="field">
        <span className="field-label">
          <InfoTip id="mission">Mission end (UTC)</InfoTip>
          <ResetButton
            isDefault={Math.abs(c.missionH - base.criteria.missionH) < 1e-6}
            defaultLabel={`${base.criteria.missionH} h (${base.short})`}
            onReset={() => setC({ missionH: base.criteria.missionH })}
          />
        </span>
        <input type="datetime-local" value={toInputUtc(end)} min={toInputUtc(c.t0 + 6 * HOUR_MS)} onChange={(e) => {
          const t = parseUtc(e.target.value);
          if (Number.isFinite(t) && t > c.t0) setC({ missionH: Math.round(((t - c.t0) / HOUR_MS) * 10) / 10 });
        }} />
        <span className="cite">{tx(`Duration $T_{\\mathrm{mission}} = ${fmtHours(c.missionH)}$ (${c.missionH} h)${cite('missionH') ? ` · ${cite('missionH')}` : ''}`)}</span>
      </div>
      <Field label="Launch slip $\pm\Delta t$" tip="slip" unit={`${(c.slipH / 24).toFixed(1)} d`} value={c.slipH} min={0} max={720} step={6} onChange={(v) => setC({ slipH: v })} cite={cite('slipH')} defaultValue={base.criteria.slipH} defaultLabel={`${base.criteria.slipH} h`} onReset={() => setC({ slipH: base.criteria.slipH })} />
      <p className="small muted">The pink mission window on the timeline can be dragged; turn on “follow playhead” there to animate every time-dependent layer.</p>
    </div>
  );
}

function SunSection() {
  const c = useApp((s) => s.criteria);
  const setC = useApp((s) => s.setCriteria);
  const base = useBasePreset();
  const cite = useCite();
  useApp((s) => s.tier);
  return (
    <div className="sec-body">
      <Field label="Min Sun elevation $\theta_{\mathrm{sun,min}}$" tip="sunMin" unit="°" value={c.sunMinEl} min={0} max={10} step={0.1} onChange={(v) => setC({ sunMinEl: v })} cite={cite('sunMinEl')} defaultValue={base.criteria.sunMinEl} onReset={() => setC({ sunMinEl: base.criteria.sunMinEl })} />
      <Field label="Min continuous sunlight $D_{\mathrm{sun,min}}$" tip="dSun" unit="h" value={c.dSunMinH} min={0} max={720} step={1} onChange={(v) => setC({ dSunMinH: v })} cite={cite('dSunMinH')} defaultValue={base.criteria.dSunMinH} onReset={() => setC({ dSunMinH: base.criteria.dSunMinH })} />
      {adv() && <Field label="Max darkness $D_{\mathrm{dark,max}}$" tip="dDark" unit="h" value={c.dDarkMaxH} min={0} max={200} step={1} onChange={(v) => setC({ dDarkMaxH: v })} cite={cite('dDarkMaxH')} defaultValue={base.criteria.dDarkMaxH} onReset={() => setC({ dDarkMaxH: base.criteria.dDarkMaxH })} />}
      {adv() && <Field label="Min disk fraction $f_{\mathrm{sun,min}}$" tip="fSun" unit="%" value={Math.round(c.fSunMin * 100)} min={1} max={100} step={1} onChange={(v) => setC({ fSunMin: v / 100 })} defaultValue={Math.round(base.criteria.fSunMin * 100)} onReset={() => setC({ fSunMin: base.criteria.fSunMin })} />}
      {!adv() && <p className="small muted">{tx('Advanced tier shows $D_{\\mathrm{dark,max}}$ and $f_{\\mathrm{sun,min}}$.')}</p>}
    </div>
  );
}

function CommSection() {
  const c = useApp((s) => s.criteria);
  const setC = useApp((s) => s.setCriteria);
  const base = useBasePreset();
  const cite = useCite();
  useApp((s) => s.tier);
  return (
    <div className="sec-body">
      <Toggle label="Geometric DTE required" tip="dte" checked={c.dteRequired} onChange={(v) => setC({ dteRequired: v })} defaultChecked={base.criteria.dteRequired} onReset={() => setC({ dteRequired: base.criteria.dteRequired })} />
      <Field label="Min DTE duty $C_{\mathrm{earth,min}}$" tip="dte" unit="%" value={c.cEarthMin} min={0} max={100} step={1} onChange={(v) => setC({ cEarthMin: v })} cite={cite('cEarthMin')} defaultValue={base.criteria.cEarthMin} onReset={() => setC({ cEarthMin: base.criteria.cEarthMin })} />
      {adv() && <Field label="Min Earth clearance $\theta_{\mathrm{earth,min}}$" unit="°" value={c.earthMinEl} min={0} max={7} step={0.1} onChange={(v) => setC({ earthMinEl: v })} cite={cite('earthMinEl')} defaultValue={base.criteria.earthMinEl} onReset={() => setC({ earthMinEl: base.criteria.earthMinEl })} />}
    </div>
  );
}

function TerrainSection() {
  const c = useApp((s) => s.criteria);
  const setC = useApp((s) => s.setCriteria);
  const base = useBasePreset();
  const cite = useCite();
  useApp((s) => s.tier);
  return (
    <div className="sec-body">
      <Field label="Max slope $\alpha_{\max}$" tip="slope" unit="°" value={c.slopeMax} min={2} max={25} step={0.5} onChange={(v) => setC({ slopeMax: v })} cite={cite('slopeMax')} defaultValue={base.criteria.slopeMax} onReset={() => setC({ slopeMax: base.criteria.slopeMax })} />
      <div className="field">
        <span className="field-label">
          <InfoTip id="slope">{'Slope baseline $L_{\\mathrm{base}}$'}</InfoTip>
          <ResetButton isDefault={c.lBase === base.criteria.lBase} defaultLabel={`${base.criteria.lBase} m`} onReset={() => setC({ lBase: base.criteria.lBase })} />
        </span>
        <div className="seg">
          {[5, 20, 100].map((b) => <button key={b} className={c.lBase === b ? 'on' : ''} onClick={() => setC({ lBase: b })}>{b} m</button>)}
        </div>
      </div>
      <div className="field">
        <span className="field-label">
          <InfoTip id="ellipse">{'Landing ellipse $R_{\\mathrm{ellipse}}$'}</InfoTip>
          <ResetButton isDefault={c.ellipseR === base.criteria.ellipseR} defaultLabel={base.criteria.ellipseR === 0 ? 'Point' : `${base.criteria.ellipseR} m`} onReset={() => setC({ ellipseR: base.criteria.ellipseR })} />
        </span>
        <div className="seg">
          {[0, 100, 500].map((r) => <button key={r} className={c.ellipseR === r ? 'on' : ''} onClick={() => setC({ ellipseR: r })}>{r === 0 ? 'Point' : `${r} m`}</button>)}
        </div>
      </div>
      {adv() && (
        <>
          <Field label="Max TRI" tip="tri" unit="m" value={c.triMax} min={0.1} max={1.5} step={0.05} onChange={(v) => setC({ triMax: v })} defaultValue={base.criteria.triMax} onReset={() => setC({ triMax: base.criteria.triMax })} />
          <Toggle label="TRI as hard gate" checked={c.triGate} onChange={(v) => setC({ triGate: v })} defaultChecked={base.criteria.triGate} onReset={() => setC({ triGate: base.criteria.triGate })} />
          <Field label="Max radar CPR" tip="cpr" value={c.cprMax} min={0.2} max={1.5} step={0.05} onChange={(v) => setC({ cprMax: v })} defaultValue={base.criteria.cprMax} onReset={() => setC({ cprMax: base.criteria.cprMax })} />
          <Toggle label="CPR as hard gate" checked={c.cprGate} onChange={(v) => setC({ cprGate: v })} defaultChecked={base.criteria.cprGate} onReset={() => setC({ cprGate: base.criteria.cprGate })} />
          <Field label="Min data confidence $C_{\mathrm{data,min}}$" tip="confidence" value={c.confMin} min={0} max={100} step={1} onChange={(v) => setC({ confMin: v })} defaultValue={base.criteria.confMin} onReset={() => setC({ confMin: base.criteria.confMin })} />
        </>
      )}
    </div>
  );
}

function ScienceSection() {
  const c = useApp((s) => s.criteria);
  const setC = useApp((s) => s.setCriteria);
  const base = useBasePreset();
  const cite = useCite();
  return (
    <div className="sec-body">
      <Toggle label="PSR proximity filter" tip="psr" checked={c.psrFilter} onChange={(v) => setC({ psrFilter: v })} defaultChecked={base.criteria.psrFilter} onReset={() => setC({ psrFilter: base.criteria.psrFilter })} />
      <Field label="Max distance to PSR $d_{\mathrm{PSR,max}}$" unit="km" value={c.dPsrMax} min={0.5} max={30} step={0.5} onChange={(v) => setC({ dPsrMax: v })} cite={cite('dPsrMax')} defaultValue={base.criteria.dPsrMax} onReset={() => setC({ dPsrMax: base.criteria.dPsrMax })} />
      <p className="small muted">PSR outlines: PGDA Product 69 (LOLA-derived permanently shadowed regions).</p>
    </div>
  );
}

function PowerSection() {
  const p = useApp((s) => s.power);
  const set = useApp((s) => s.setPower);
  const a = useApp((s) => s.analysis);
  const rated = 1361 * p.areaM2 * p.efficiency;
  return (
    <div className="sec-body">
      <p className="sec-intro"><InfoTip id="power">Solar power generation</InfoTip> — {tx('$P = S \\cdot A \\cdot \\eta \\cdot (1 - L) \\cdot f_{\\mathrm{sun}} \\cdot \\max(0, \\cos i)$')}</p>
      <Field label="Panel inclination $\beta$ (from horizontal)" unit="°" value={p.tiltDeg} min={0} max={90} step={1} onChange={(v) => set({ tiltDeg: v })} cite="90° = vertical mast panel (typical at the pole), 0° = flat deck" defaultValue={DEFAULT_POWER.tiltDeg} onReset={() => set({ tiltDeg: DEFAULT_POWER.tiltDeg })} />
      <div className="field">
        <span className="field-label">
          <span>Panel orientation</span>
          <ResetButton isDefault={p.azMode === DEFAULT_POWER.azMode} defaultLabel="Sun-tracking" onReset={() => set({ azMode: DEFAULT_POWER.azMode })} />
        </span>
        <div className="seg">
          <button className={p.azMode === 'track' ? 'on' : ''} onClick={() => set({ azMode: 'track' })}>Sun-tracking (azimuth)</button>
          <button className={p.azMode === 'fixed' ? 'on' : ''} onClick={() => set({ azMode: 'fixed' })}>Fixed azimuth</button>
        </div>
      </div>
      {p.azMode === 'fixed' && <Field label="Panel azimuth (clockwise from N)" unit="°" value={p.azDeg} min={0} max={359} step={1} onChange={(v) => set({ azDeg: v })} defaultValue={DEFAULT_POWER.azDeg} onReset={() => set({ azDeg: DEFAULT_POWER.azDeg })} />}
      <Field label="Array area $A$" unit="m²" value={p.areaM2} min={0.5} max={200} step={0.5} onChange={(v) => set({ areaM2: v })} defaultValue={DEFAULT_POWER.areaM2} onReset={() => set({ areaM2: DEFAULT_POWER.areaM2 })} />
      <Field label="Conversion efficiency $\eta$" unit="%" value={Math.round(p.efficiency * 1000) / 10} min={5} max={45} step={0.5} onChange={(v) => set({ efficiency: v / 100 })} cite="Triple-junction GaAs ≈ 28–32 %, silicon ≈ 18–22 %" defaultValue={Math.round(DEFAULT_POWER.efficiency * 1000) / 10} onReset={() => set({ efficiency: DEFAULT_POWER.efficiency })} />
      <Field label="System losses $L$" unit="%" value={p.lossesPct} min={0} max={60} step={1} onChange={(v) => set({ lossesPct: v })} cite="Thermal, degradation, wiring, MPPT" defaultValue={DEFAULT_POWER.lossesPct} onReset={() => set({ lossesPct: DEFAULT_POWER.lossesPct })} />
      <Field label="Required mean power (0 = none)" unit="W" value={p.minMeanW} min={0} max={10000} step={50} onChange={(v) => set({ minMeanW: v })} defaultValue={DEFAULT_POWER.minMeanW} onReset={() => set({ minMeanW: DEFAULT_POWER.minMeanW })} />
      <div className="kv">
        <span>{tx('Rated at $1\\,\\mathrm{AU}$ ($P_{\\mathrm{rated}}$)')}</span><b className="mono">{fmt(rated / 1000, 2)} kW</b>
        {a?.power && (
          <>
            <span>Mean over mission</span><b className="mono">{fmt(a.power.meanW, 0)} W</b>
            <span>Energy over mission</span><b className="mono">{fmt(a.power.energyKWh, 1)} kWh</b>
          </>
        )}
      </div>
      {!a && <p className="small muted">Select a site to see its power profile (Adequacy → Power).</p>}
    </div>
  );
}

function SearchSection() {
  const fr = useApp((s) => s.forward);
  const busy = useApp((s) => s.forwardBusy);
  const prog = useApp((s) => s.forwardProgress);
  const auto = useApp((s) => s.autoForward);
  const lonC = useApp((s) => s.lonConvention);
  const tLand = useApp((s) => s.criteria.t0 + s.slipOffsetH * HOUR_MS);
  return (
    <div className="sec-body" data-tour="forward">
      <p className="sec-intro">Regional screen of every 4.75 km cell between 80°S and the pole, for the landing epoch at the start of the pink mission window.</p>
      {auto && (
        <div className="auto-banner" role="status">
          <span className="dot" aria-hidden />
          <span>{busy ? `Auto-screening now… ${Math.round(prog * 100)} %` : 'Auto active — regional screening runs automatically whenever parameters or epoch change.'}</span>
        </div>
      )}
      <div className="row gap">
        <button className={`btn${auto ? '' : ' primary'}`} onClick={() => scheduleForward(0)} disabled={busy}>
          {busy ? `Screening… ${Math.round(prog * 100)} %` : auto ? 'Re-run screen' : 'Run regional screen'}
        </button>
        <Toggle
          label="Auto"
          checked={auto}
          onChange={(v) => {
            useApp.getState().set({ autoForward: v });
            if (v) scheduleForward(0);
          }}
        />
      </div>
      {busy && <div className="progress"><div style={{ width: `${prog * 100}%` }} /></div>}
      {fr && (
        <>
          <div className="fs-stats">
            <span><b>{fr.counts.cells.toLocaleString()}</b> cells</span>
            <span className="c-pass"><b>{fr.counts.pass}</b> pass</span>
            <span className="c-unknown"><b>{fr.counts.candidates}</b> screen-passed</span>
            <span className="c-fail"><b>{fr.counts.fail}</b> fail</span>
            <span className="muted">landing {new Date(fr.tLand).toISOString().slice(0, 16).replace('T', ' ')}Z · {fr.cached ? 'cached geometry · ' : `geometry ${fr.ms.geometry.toFixed(0)} ms · `}scoring {fr.ms.thresholds.toFixed(0)} ms</span>
          </div>
          {Math.abs(fr.tLand - tLand) > 60_000 && <p className="note">Mission window moved — results update automatically when Auto is on.</p>}
          <div className="fs-reasons">
            {Object.entries(fr.counts.byReason).filter(([, n]) => n > 0).map(([k, n]) => (
              <span key={k} className="chip">{k === 'dsun' ? tx('$D_{\\mathrm{sun}}$') : k === 'ddark' ? tx('$D_{\\mathrm{dark}}$') : k === 'dte' ? 'DTE' : k.toUpperCase()} ✕ {n}</span>
            ))}
          </div>
          {fr.counts.pass === 0 && fr.counts.candidates > 0 && (
            <p className="note">{tx(`Footpad slope at $L_{\\mathrm{base}} = ${fr.lBase}\\,\\mathrm{m}$ is not resolved by the ${Math.round(fr.regionalDx)} m regional screen, so screen-passed cells are `)}<b>UNKNOWN</b> until inspected on 5 m LOLA data (Site Analysis).</p>
          )}
          <ol className="cand-list">
            {fr.top.slice(0, 10).map((t, i) => (
              <li key={t.idx}>
                <button onClick={() => {
                  useApp.getState().select({ x: t.x, y: t.y, lat: t.lat, lon: t.lon, siteId: null, name: `Candidate #${i + 1}` });
                  useApp.getState().requestFlyTo(t.lat, t.lon, 40);
                  useApp.getState().set({ rightSection: 'adequacy' });
                }}>
                  <span className="num">{i + 1}</span>
                  <span className="mono">{fmtLat(t.lat, 2)} {fmtLon(t.lon, lonC, 1)}</span>
                  <span className="mono">S {t.suit.toFixed(0)}</span>
                  <span className="mono muted">C {t.conf.toFixed(0)}</span>
                </button>
                <button className="icon-btn small" title="Add to selected sites" onClick={() => useApp.getState().togglePin({ x: t.x, y: t.y, lat: t.lat, lon: t.lon, siteId: null, name: `Candidate #${i + 1}` })}><Icon.plus /></button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function SitesSection() {
  const lonC = useApp((s) => s.lonConvention);
  const sel = useApp((s) => s.selection);
  const pins = useApp((s) => s.pins);
  const [lat, setLat] = useState('-89.45');
  const [lon, setLon] = useState('222.10');
  const sites = runtime.data?.manifest.sites ?? [];
  const pick = (s: { x: number; y: number; lat: number; lon: number; id: string | null; name: string }, range: number) => {
    useApp.getState().select({ x: s.x, y: s.y, lat: s.lat, lon: s.lon, siteId: s.id, name: s.name });
    useApp.getState().requestFlyTo(s.lat, s.lon, range);
    useApp.getState().set({ rightSection: 'adequacy' });
  };
  const go = () => {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la > -80 || la < -90) {
      useApp.getState().notify('This software covers only the lunar South Pole (enter a latitude between −80° and −90°).', { icon: 'warn' });
      return;
    }
    const [x, y] = latLonToPolar(la, lo);
    pick({ x, y, lat: la, lon: ((lo % 360) + 360) % 360, id: null, name: `${fmtLat(la, 3)} ${fmtLon(lo, lonC)}` }, 20);
  };
  const isPinned = (x: number, y: number) => pins.some((p) => Math.hypot(p.x - x, p.y - y) < 1);
  return (
    <div className="sec-body" data-tour="sites">
      <p className="sec-intro">Click the globe or map (80°S–90°S) to inspect any point. <kbd>P</kbd> or <b>＋</b> adds it to the selected sites used by Recap and Compare.</p>
      <div className="coord-row">
        <input aria-label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat (°)" />
        <input aria-label="Longitude east" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="lon (°E)" />
        <button className="btn" onClick={go}>Go</button>
      </div>
      {sel && (
        <div className="cur-site">
          <span className="small muted">Inspecting</span>
          <b>{sel.name}</b>
          <button className={`btn small${isPinned(sel.x, sel.y) ? ' on' : ''}`} onClick={() => useApp.getState().togglePin()}>{isPinned(sel.x, sel.y) ? '✓ Selected' : '＋ Add to selected (P)'}</button>
        </div>
      )}
      <span className="field-label">Curated Artemis III / CLPS sites</span>
      <ul className="site-list">
        {sites.map((s) => (
          <li key={s.id}>
            <button className={sel?.siteId === s.id ? 'on' : ''} onClick={() => pick({ ...s }, s.has5m ? 12 : 40)}>
              <span className="site-id">{s.id}</span>
              <span className="site-name">{s.name}</span>
              <span className="site-kind">{s.has5m ? '5 m LOLA' : '80 m LOLA'} · {s.kind}</span>
            </button>
            <button className={`icon-btn small${isPinned(s.x, s.y) ? ' on' : ''}`} title="Add to / remove from selected sites" onClick={() => useApp.getState().togglePin({ x: s.x, y: s.y, lat: s.lat, lon: s.lon, siteId: s.id, name: s.name })}>
              {isPinned(s.x, s.y) ? <Icon.check /> : <Icon.plus />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MiniStatus() {
  const a = useApp((s) => s.analysis);
  if (!a) return null;
  return <StatusBadge status={a.assessment.status} label={`${a.assessment.status} · S ${fmt(a.assessment.suitability, 0)} · C ${fmt(a.assessment.confidence, 0)}`} />;
}
