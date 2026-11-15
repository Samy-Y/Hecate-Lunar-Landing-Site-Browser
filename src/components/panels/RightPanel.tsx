/**
 * Right panel (feedback v2): labelled icon ribbon + collapsible sections, mirroring the left panel.
 *   Recap     - every selected site with its main results, ranked by a user-chosen parameter
 *   Adequacy  - full detail for one site (switchable among the selected sites)
 *   Compare   - pick 2-4 sites and compare them side by side, across launch slips
 *   Horizon   - 360 deg sky-plane panorama for the inspected site
 */
import { useMemo, useState, type ReactNode } from 'react';
import { findNextWindow, runCompare, runtime, verifyWithHorizons } from '../../store/runtime';
import { tLandOf, useApp, type Pin, type RecapFeasFilter, type RecapSort, type RightSection, type Selection, type SiteSummary } from '../../store/useApp';
import { fmtLat, fmtLon } from '../../lib/geo';
import { fmt, HOUR_MS } from '../../lib/math';
import { fmtHours, fmtUtc } from '../../lib/time';
import { Meter, PassMark, StatusBadge } from '../common/Badges';
import { Icon } from '../common/Icons';
import { InfoTip } from '../common/InfoTip';
import { Panorama } from './Panorama';
import { Silhouettes } from './Silhouettes';
import { PowerChart } from './PowerChart';
import { Tx, tx } from '../common/Tx';

const ITEMS: { id: RightSection; label: string; icon: ReactNode }[] = [
  { id: 'recap', label: 'Recap', icon: <Icon.list /> },
  { id: 'adequacy', label: 'Adequacy', icon: <Icon.clipboard /> },
  { id: 'compare', label: 'Compare', icon: <Icon.columns /> },
  { id: 'horizon', label: 'Horizon', icon: <Icon.horizon /> },
];

export function RightPanel() {
  const section = useApp((s) => s.rightSection);
  const hidden = useApp((s) => s.uiHidden);
  const pins = useApp((s) => s.pins);
  if (hidden) return null;
  return (
    <aside className={`side right${section ? ' open' : ''}`} data-tour="inspector">
      {section && (
        <div className="side-content">
          <header className="side-head">
            <span>{ITEMS.find((i) => i.id === section)?.label}</span>
            <button className="icon-btn small" onClick={() => useApp.getState().set({ rightSection: null })} aria-label="Collapse panel"><Icon.chevron /></button>
          </header>
          <div className="side-scroll">
            {section === 'recap' && <Recap />}
            {section === 'adequacy' && <Adequacy />}
            {section === 'compare' && <Compare />}
            {section === 'horizon' && <HorizonSection />}
          </div>
        </div>
      )}
      <nav className="ribbon" aria-label="Results sections">
        {ITEMS.map((it) => (
          <button key={it.id} className={`rib-btn${section === it.id ? ' on' : ''}`} onClick={() => useApp.getState().openRight(it.id)} aria-pressed={section === it.id} title={it.label} data-tour={`rib-${it.id}`}>
            {it.icon}
            <span>{it.label}</span>
            {it.id === 'recap' && pins.length > 0 && <em className="rib-count">{pins.length}</em>}
          </button>
        ))}
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------- shared helpers
const STATUS_RANK = { PASS: 0, UNKNOWN: 1, FAIL: 2 } as const;

interface RecapRow {
  key: string;
  sel: Selection;
  pin: Pin | null;
  nearCurated: string | null;
  status: 'PASS' | 'UNKNOWN' | 'FAIL';
  statusDetail: string;
  suitability: number;
  confidence: number;
  dSunH: number;
  dDarkH: number;
  cEarth: number;
  slope: number;
  powerMeanW: number | null;
  avail: number | null;
  pendingCompare: boolean;
}

const SORTS: { id: RecapSort; label: string; key: (r: RecapRow) => number; desc: boolean }[] = [
  { id: 'feasibility', label: 'Feasibility', key: (s) => STATUS_RANK[s.status] * 1000 - s.suitability, desc: false },
  { id: 'suitability', label: 'Suitability', key: (s) => s.suitability, desc: true },
  { id: 'confidence', label: 'Data confidence', key: (s) => s.confidence, desc: true },
  { id: 'dSun', label: 'Continuous sunlight', key: (s) => s.dSunH, desc: true },
  { id: 'dDark', label: 'Max darkness', key: (s) => s.dDarkH, desc: false },
  { id: 'cEarth', label: 'DTE duty', key: (s) => s.cEarth, desc: true },
  { id: 'slope', label: 'Slope', key: (s) => s.slope, desc: false },
  { id: 'power', label: 'Mean power', key: (s) => s.powerMeanW ?? -1, desc: true },
];

function selectPin(p: { x: number; y: number; lat: number; lon: number; siteId: string | null; name: string }, fly = true) {
  useApp.getState().select({ x: p.x, y: p.y, lat: p.lat, lon: p.lon, siteId: p.siteId, name: p.name });
  if (fly) useApp.getState().requestFlyTo(p.lat, p.lon, 15);
}

// ---------------------------------------------------------------- Recap
function Recap() {
  const pins = useApp((s) => s.pins);
  const compare = useApp((s) => s.compare);
  const busy = useApp((s) => s.compareBusy);
  const forward = useApp((s) => s.forward);
  const sort = useApp((s) => s.recapSort);
  const filter = useApp((s) => s.recapFilter);
  const sel = useApp((s) => s.selection);
  const lBase = useApp((s) => s.criteria.lBase);
  const confMin = useApp((s) => s.criteria.confMin);
  const tLand = useApp((s) => tLandOf(s));
  const lonC = useApp((s) => s.lonConvention);
  const [limit, setLimit] = useState(60);

  const allRows = useMemo<RecapRow[]>(() => {
    const out: RecapRow[] = [];
    const sites = runtime.data?.manifest.sites ?? [];
    const nearSiteName = (x: number, y: number) => {
      const s = sites.find((q) => Math.hypot(q.x - x, q.y - y) < 2500);
      return s ? s.id : null;
    };
    const matchForward = (x: number, y: number) => forward?.passed.find((c) => Math.hypot(c.x - x, c.y - y) < 2400);

    for (const p of pins) {
      const c0 = compare?.find((r) => r.id === p.id)?.cols[0] ?? null;
      const f = matchForward(p.x, p.y);
      if (c0) {
        out.push({
          key: `pin-${p.id}`,
          sel: { x: p.x, y: p.y, lat: p.lat, lon: p.lon, siteId: p.siteId, name: p.name },
          pin: p,
          nearCurated: p.siteId ? null : nearSiteName(p.x, p.y),
          status: c0.status,
          statusDetail: c0.statusDetail,
          suitability: c0.suitability,
          confidence: c0.confidence,
          dSunH: c0.dSunH,
          dDarkH: c0.dDarkH,
          cEarth: c0.cEarth,
          slope: c0.slope,
          powerMeanW: c0.powerMeanW,
          avail: f?.avail ?? null,
          pendingCompare: false,
        });
      } else {
        const regStatus = f ? (f.status === 2 ? 'PASS' : 'UNKNOWN') : 'UNKNOWN';
        out.push({
          key: `pin-${p.id}`,
          sel: { x: p.x, y: p.y, lat: p.lat, lon: p.lon, siteId: p.siteId, name: p.name },
          pin: p,
          nearCurated: p.siteId ? null : nearSiteName(p.x, p.y),
          status: regStatus,
          statusDetail: f
            ? (f.status === 2 ? 'Passed regional screen; evaluating 5 m terrain…' : `Screen-passed — computing 5 m slope at $L_{\\mathrm{base}}$…`)
            : 'Computing full 5 m analysis…',
          suitability: f?.suit ?? 0,
          confidence: f?.conf ?? 0,
          dSunH: f?.dSunH ?? 0,
          dDarkH: f?.dDarkH ?? 0,
          cEarth: f?.cEarth ?? 0,
          slope: f?.slope ?? 0,
          powerMeanW: null,
          avail: f?.avail ?? null,
          pendingCompare: true,
        });
      }
    }

    if (forward) {
      forward.passed.forEach((cand, i) => {
        const alreadyPinned = pins.some((p) => Math.hypot(p.x - cand.x, p.y - cand.y) < 1);
        if (alreadyPinned) return;
        const name = i < 12 ? `Candidate #${i + 1}` : `Cell r${cand.row}·c${cand.col}`;
        const status: 'PASS' | 'UNKNOWN' = cand.status === 2 ? 'PASS' : 'UNKNOWN';
        const statusDetail =
          status === 'PASS'
            ? 'Passed regional forward screen (80 m slope baseline)'
            : forward.regionalDx > lBase
              ? `Screen-passed — $L_{\\mathrm{base}} = ${lBase}\\,\\mathrm{m}$ footpad slope requires 5 m inspection`
              : `LOW CONFIDENCE — $C_{\\mathrm{data}} = ${cand.conf.toFixed(0)} < ${confMin}$`;
        out.push({
          key: `cell-${cand.idx}`,
          sel: { x: cand.x, y: cand.y, lat: cand.lat, lon: cand.lon, siteId: null, name },
          pin: null,
          nearCurated: nearSiteName(cand.x, cand.y),
          status,
          statusDetail,
          suitability: cand.suit,
          confidence: cand.conf,
          dSunH: cand.dSunH,
          dDarkH: cand.dDarkH,
          cEarth: cand.cEarth,
          slope: cand.slope,
          powerMeanW: null,
          avail: cand.avail,
          pendingCompare: false,
        });
      });
    }
    return out;
  }, [pins, compare, forward, lBase, confMin]);

  const counts = useMemo(() => {
    let pass = 0, unknown = 0, fail = 0;
    for (const r of allRows) {
      if (r.status === 'PASS') pass++;
      else if (r.status === 'UNKNOWN') unknown++;
      else fail++;
    }
    return { all: allRows.length, pass, unknown, fail };
  }, [allRows]);

  const filtered = useMemo(() => {
    const def = SORTS.find((s) => s.id === sort)!;
    return allRows
      .filter((r) => {
        if (filter.selectedOnly && !r.pin) return false;
        if (filter.feasibility !== 'all' && r.status !== filter.feasibility) return false;
        if (r.confidence < filter.minConf) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.pendingCompare && !b.pendingCompare && !forward) return 1;
        const d = def.key(a) - def.key(b);
        return def.desc ? -d : d;
      });
  }, [allRows, filter, sort, forward]);

  const shown = filtered.slice(0, limit);
  const selPinned = sel && pins.some((p) => Math.hypot(p.x - sel.x, p.y - sel.y) < 1);
  const feasOpts: { id: RecapFeasFilter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: counts.all },
    { id: 'PASS', label: 'PASS', n: counts.pass },
    { id: 'UNKNOWN', label: 'Screen / ?', n: counts.unknown },
    { id: 'FAIL', label: 'FAIL', n: counts.fail },
  ];

  return (
    <div className="sec-body" data-tour="recap">
      <div className="row gap wrap">
        <label className="small muted" htmlFor="recap-sort">Rank by</label>
        <select id="recap-sort" value={sort} onChange={(e) => useApp.getState().set({ recapSort: e.target.value as RecapSort })}>
          {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <span className="grow" />
        {pins.length >= 2 && (
          <button className="btn small primary" onClick={() => useApp.getState().set({ rightSection: 'compare' })}>
            Compare ({pins.length}) →
          </button>
        )}
        <button className="btn small ghost" onClick={() => runCompare()} disabled={busy || !pins.length}>{busy ? 'Updating…' : 'Refresh'}</button>
      </div>

      <div className="recap-filters">
        <div className="seg wrap">
          {feasOpts.map((o) => (
            <button
              key={o.id}
              className={filter.feasibility === o.id ? 'on' : ''}
              onClick={() => useApp.getState().setRecapFilter({ feasibility: o.id })}
            >
              {o.label} <span className="muted">({o.n})</span>
            </button>
          ))}
        </div>
        <div className="row gap wrap">
          <button
            className={`btn small${filter.selectedOnly ? ' on' : ' ghost'}`}
            onClick={() => useApp.getState().setRecapFilter({ selectedOnly: !filter.selectedOnly })}
          >
            Selected only ({pins.length})
          </button>
          {pins.length > 0 && (
            <button className="btn small ghost" onClick={() => useApp.getState().clearPins()} title="Clear all selected sites">
              Clear selected
            </button>
          )}
          <span className="grow" />
          <label className="recap-conf-filter small">
            <span><Tx>{`Min $C_{\\mathrm{data}} \\ge ${filter.minConf}$`}</Tx></span>
            <input
              type="range"
              min={0}
              max={95}
              step={5}
              value={filter.minConf}
              onChange={(e) => useApp.getState().setRecapFilter({ minConf: Number(e.target.value) })}
              aria-label="Minimum data confidence filter"
            />
          </label>
        </div>
      </div>

      <p className="small muted">
        Landing {fmtUtc(tLand)} · {filtered.length} matching ({forward ? `${forward.passed.length} forward-passed` : 'screening…'} · {pins.length} selected) · <kbd>Shift</kbd>+Click map or tick boxes to select for Compare
      </p>

      {sel && !selPinned && (
        <button className="btn small wide" onClick={() => useApp.getState().togglePin()}><Icon.plus /> Select “{sel.name}” for Compare</button>
      )}

      {filtered.length === 0 && (
        <div className="empty small">
          <Icon.list />
          <p>
            {allRows.length === 0
              ? 'No regional cells passed the current criteria. Relax sun/darkness/slope thresholds or Shift+click sites directly on the map.'
              : 'No sites match the active Feasibility / Confidence filters.'}
          </p>
        </div>
      )}

      <ol className="recap-list">
        {shown.map((r, i) => {
          const isCurrent = !!sel && Math.hypot(r.sel.x - sel.x, r.sel.y - sel.y) < 1;
          return (
            <li
              key={r.key}
              className={`${isCurrent ? 'cur' : ''}${r.pin ? ' pinned' : ''}`}
              style={r.pin ? { ['--pin' as string]: r.pin.color } : undefined}
            >
              <button
                type="button"
                className={`recap-check${r.pin ? ' on' : ''}`}
                onClick={() => useApp.getState().togglePin(r.sel)}
                title={r.pin ? 'Remove from Compare selection' : 'Select for Compare (same as Shift+Click on map)'}
                aria-pressed={!!r.pin}
                aria-label={r.pin ? `Deselect ${r.sel.name}` : `Select ${r.sel.name}`}
              >
                {r.pin ? <Icon.check /> : <Icon.plus />}
              </button>
              <button
                type="button"
                className="recap-main"
                onClick={() => { selectPin(r.sel); useApp.getState().set({ rightSection: 'adequacy' }); }}
                title="Inspect site in Adequacy"
              >
                <span className="rank">{i + 1}</span>
                <span className="recap-name">
                  <b>{r.sel.name}{r.nearCurated && <em className="recap-tag">{r.nearCurated}</em>}</b>
                  <span className="mono small muted">{fmtLat(r.sel.lat, 2)} {fmtLon(r.sel.lon, lonC, 1)}</span>
                </span>
                {r.pendingCompare ? <span className="spinner" /> : <StatusBadge status={r.status} label={r.status === 'UNKNOWN' ? '?' : r.status} />}
              </button>
              <div className="recap-metrics mono small">
                <span title="Suitability"><Tx>$S$</Tx> {fmt(r.suitability, 0)}</span>
                <span title="Data confidence"><Tx>$C$</Tx> {fmt(r.confidence, 0)}</span>
                <span title="Continuous sunlight">☀ {fmtHours(r.dSunH)}</span>
                <span title="DTE duty">⊕ {fmt(r.cEarth, 0)} %</span>
                <span title="Slope"><Tx>$\alpha$</Tx> {fmt(r.slope, 1)}°</span>
                {r.powerMeanW !== null ? (
                  <span title="Mean solar power">⚡ {fmt(r.powerMeanW, 0)} W</span>
                ) : r.avail !== null ? (
                  <span title="Slip availability">avail {fmt(r.avail, 0)} %</span>
                ) : null}
              </div>
              {r.status !== 'PASS' && <span className="recap-why small">{tx(r.statusDetail)}</span>}
            </li>
          );
        })}
      </ol>
      {filtered.length > shown.length && (
        <button className="btn small wide ghost" onClick={() => setLimit((n) => n + 80)}>
          Show more ({filtered.length - shown.length} remaining)
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Adequacy
function SiteSwitcher() {
  const sel = useApp((s) => s.selection);
  const pins = useApp((s) => s.pins);
  if (!sel && !pins.length) return null;
  const opts = [...pins];
  const selPinned = sel && pins.find((p) => Math.hypot(p.x - sel.x, p.y - sel.y) < 1);
  const value = selPinned ? selPinned.id : 'current';
  return (
    <select className="site-switch" value={value} aria-label="Site shown in Adequacy" onChange={(e) => {
      const p = opts.find((q) => q.id === e.target.value);
      if (p) selectPin(p);
    }}>
      {sel && !selPinned && <option value="current">{sel.name} (inspecting)</option>}
      {opts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

function Adequacy() {
  const sel = useApp((s) => s.selection);
  const a = useApp((s) => s.analysis);
  const busy = useApp((s) => s.analysisBusy);
  const err = useApp((s) => s.analysisError);
  const pins = useApp((s) => s.pins);
  const lonC = useApp((s) => s.lonConvention);
  const pinned = !!sel && pins.some((p) => Math.hypot(p.x - sel.x, p.y - sel.y) < 1);
  const current = a && sel && Math.hypot(a.x - sel.x, a.y - sel.y) < 1 ? a : null;
  if (!sel)
    return (
      <div className="empty">
        <Icon.target width={36} height={36} />
        <h3>Inspect a site</h3>
        <p>Click the globe or polar map between 80°S and 90°S, choose a curated Artemis III / CLPS site, a forward-search candidate, or type coordinates (Site Analysis mode).</p>
        <p className="muted">Keyboard: <kbd>P</kbd> adds the site to the selection · <kbd>[</kbd>/<kbd>]</kbd> step time ±1 h (<kbd>Shift</kbd> ±24 h)</p>
        {pins.length > 0 && <SiteSwitcher />}
      </div>
    );
  return (
    <div className="sec-body" data-tour="adequacy">
      <SiteSwitcher />
      <header className="site-head">
        <div>
          <h2>{sel.name}</h2>
          <div className="mono small">
            {fmtLat(sel.lat, 4)} · {fmtLon(sel.lon, lonC, 3)}
            {current && <> · {fmt(current.terrain.elev, 0)} m</>}
          </div>
        </div>
        <div className="head-actions">
          <button className={`icon-btn${pinned ? ' on' : ''}`} onClick={() => useApp.getState().togglePin()} title={pinned ? 'Remove from selected sites (P)' : 'Add to selected sites (P)'} aria-pressed={pinned}>{pinned ? <Icon.check /> : <Icon.plus />}</button>
          <button className="icon-btn" onClick={() => useApp.getState().requestFlyTo(sel.lat, sel.lon, 12)} title="Fly to site"><Icon.target /></button>
          <button className="icon-btn" onClick={() => useApp.getState().select(null)} title="Stop inspecting"><Icon.close /></button>
        </div>
      </header>
      {current && (
        <div className="badges-row">
          <span className={`lvl ${current.terrain.level}`}>{current.terrain.source}</span>
          {!current.terrain.lBaseResolved && <span className="lvl warn">{current.terrain.level === '5m' ? '' : '5 m DEM unavailable here — '}slope at {Math.round(current.terrain.slopeBaselineM)} m</span>}
          <span className="lvl">{tx(`measured ${fmt(current.terrain.directFrac * 100, 0)} % · $\\sigma_z = ${fmt(current.terrain.sigmaZ, 1)}$ m`)}</span>
        </div>
      )}
      {err && <div className="error">Engine error: {err}</div>}
      {!current ? (
        <div className="loading-block"><div className="spinner" /> Analysing site… loading 5 m LOLA tiles, ray-casting horizon, solving Sun/Earth events</div>
      ) : (
        <>
          <AssessmentCard />
          <details open>
            <summary>Constraints & utilities</summary>
            <ChecksBlock />
          </details>
          <details open>
            <summary>Solar power</summary>
            <PowerChart />
          </details>
          <details>
            <summary>Launch slip & events</summary>
            <SlipBlock />
          </details>
          <details>
            <summary>Terrain & data provenance</summary>
            <DataBlock />
          </details>
          <EphemerisBox />
        </>
      )}
      {busy && <div className="busy-strip">updating…</div>}
    </div>
  );
}

function AssessmentCard() {
  const a = useApp((s) => s.analysis)!;
  const s = a.assessment;
  const tone = s.status === 'PASS' ? 'pass' : s.status === 'FAIL' ? 'fail' : 'unknown';
  return (
    <section className={`assess ${tone}`} aria-label="Three-part assessment">
      <div className="assess-row">
        <span className="assess-k"><InfoTip id="feasibility">Feasibility</InfoTip></span>
        <StatusBadge status={s.status} large />
      </div>
      <p className="assess-detail">{tx(s.statusDetail)}</p>
      <div className="assess-grid">
        <div>
          <span className="assess-k"><InfoTip id="suitability">Suitability</InfoTip></span>
          <span className="big mono">{fmt(s.suitability, 0)}<small>/100</small></span>
          <Meter value={s.suitability} tone="accent" />
        </div>
        <div>
          <span className="assess-k"><InfoTip id="confidence">Data confidence</InfoTip></span>
          <span className="big mono">{fmt(s.confidence, 0)}<small>/100</small></span>
          <Meter value={s.confidence} tone={s.confCategory === 'High' ? 'pass' : s.confCategory === 'Moderate' ? 'unknown' : 'fail'} />
          <span className="small muted">{s.confCategory} confidence</span>
        </div>
      </div>
      <div className="metrics">
        <div><InfoTip id="dSun">{tx('$D_{\\mathrm{sun}}$')}</InfoTip><b className="mono">{fmtHours(a.metrics.dSunH)}</b></div>
        <div><InfoTip id="dDark">{tx('$D_{\\mathrm{dark}}$')}</InfoTip><b className="mono">{fmtHours(a.metrics.dDarkH)}</b></div>
        <div><InfoTip id="dte">{tx('$C_{\\mathrm{earth}}$')}</InfoTip><b className="mono">{fmt(a.metrics.cEarth, 1)} %</b></div>
        <div><InfoTip id="power">{tx('$\\bar{P}$')}</InfoTip><b className="mono">{fmt(a.power.meanW, 0)} W</b></div>
      </div>
    </section>
  );
}

function ChecksBlock() {
  const a = useApp((s) => s.analysis)!;
  const tips: Record<string, string> = { slope: 'slope', dsun: 'dSun', ddark: 'dDark', dte: 'dte', tri: 'tri', cpr: 'cpr', psr: 'psr', power: 'power' };
  return (
    <div>
      <table className="checks">
        <thead><tr><th>Constraint</th><th>Value</th><th>Limit</th><th /></tr></thead>
        <tbody>
          {a.assessment.checks.map((k) => (
            <tr key={k.key} className={k.hard ? 'hard' : 'soft'}>
              <td><InfoTip id={tips[k.key]}>{k.label}</InfoTip>{!k.hard && <span className="tag">advisory</span>}</td>
              <td className="mono">{tx(k.value)}</td>
              <td className="mono">{tx(k.limit)}</td>
              <td><PassMark pass={k.pass} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="checks compact">
        <tbody>
          {(['sun', 'comm', 'slope', 'tri', 'psr'] as const).map((k) => (
            <tr key={k}>
              <td>{tx(`$u_{\\mathrm{${k}}}$`)}</td>
              <td className="mono">{fmt(a.assessment.utilities[k] as number | null, 3)}</td>
              <td className="mono">{tx(`$w_{\\mathrm{${k}}} = ${fmt(a.assessment.weights[k], 2)}$`)}</td>
              <td><Meter value={(a.assessment.utilities[k] ?? 0) * 100} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SlipBlock() {
  const a = useApp((s) => s.analysis)!;
  const crit = useApp((s) => s.criteria);
  const slipOffsetH = useApp((s) => s.slipOffsetH);
  const next = useApp((s) => s.nextWindow);
  const tLand = useApp((s) => tLandOf(s));
  const events = a.timeline.events.filter((e) => e.t >= tLand && e.t <= tLand + crit.missionH * HOUR_MS);
  return (
    <div>
      <p className="small">Landing <b className="mono">{fmtUtc(tLand)}</b> ({slipOffsetH === 0 ? tx('nominal $t_0$') : tx(`$t_0 ${slipOffsetH > 0 ? '+' : '-'} ${fmtHours(Math.abs(slipOffsetH))}$`)})</p>
      <table className="checks">
        <thead><tr><th>Landing</th><th>{tx('$D_{\\mathrm{sun}}$')}</th><th>{tx('$D_{\\mathrm{dark}}$')}</th><th>{tx('$C_{\\mathrm{earth}}$')}</th><th>Status</th></tr></thead>
        <tbody>
          {a.slipTable.map((r) => (
            <tr key={r.label} className={Math.abs(r.offsetH - slipOffsetH) < 1e-6 ? 'cur' : ''} onClick={() => useApp.getState().setSlipOffset(r.offsetH)} style={{ cursor: 'pointer' }}>
              <td>{r.label}</td>
              <td className="mono">{fmtHours(r.metrics.dSunH)}</td>
              <td className="mono">{fmtHours(r.metrics.dDarkH)}</td>
              <td className="mono">{fmt(r.metrics.cEarth, 0)} %</td>
              <td><StatusBadge status={r.status} label={r.status === 'UNKNOWN' ? '?' : r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{tx(`Viable windows inside $\\pm$${fmtHours(crit.slipH)}`)}</h4>
      {a.slip.windows.length === 0 ? (
        <p className="small muted">{a.terrainOk ? 'No landing epoch inside the slip window satisfies the temporal gates.' : 'Terrain constraints fail — no epoch can make this site feasible.'}</p>
      ) : (
        <ul className="win-list">
          {a.slip.windows.slice(0, 8).map(([s0, s1], i) => (
            <li key={i}>
              <button onClick={() => useApp.getState().setSlipOffset((s0 - crit.t0) / HOUR_MS)}>
                <span className="mono">{fmtUtc(s0)}</span> → <span className="mono">{fmtUtc(s1)}</span>
                <span className="muted"> ({fmtHours((s1 - s0) / HOUR_MS)})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="small">Slip availability: <b className="mono">{fmt(a.slip.availability, 1)} %</b> of landing epochs</p>
      <button className="btn primary" onClick={() => findNextWindow(365)} disabled={next?.busy}>{next?.busy ? 'Searching 365 days…' : 'Jump to next viable window'}</button>
      {next?.error && <p className="small warn-text">{next.error}</p>}
      <h4>Events during the mission (Brent-refined)</h4>
      <ul className="event-list">
        {events.length === 0 && <li className="muted small">No horizon crossings — conditions are constant over the mission.</li>}
        {events.slice(0, 40).map((e, i) => (
          <li key={i} className={e.kind}>
            <span className="mono">{fmtUtc(e.t, true)}</span>
            <span>{tx({ sunrise: '☀ Sun clears $\\theta_{\\min}$', sunset: '☀ Sun below $\\theta_{\\min}$', darkStart: '● darkness begins', darkEnd: '○ darkness ends', earthRise: '⊕ Earth rises (DTE)', earthSet: '⊕ Earth sets (DTE lost)' }[e.kind])}</span>
            <span className="muted small">{e.iterations} it</span>
          </li>
        ))}
      </ul>
      <p className="small muted">Two-stage engine: {a.timeline.stats.coarse} hourly samples, {a.timeline.stats.subdivided} grazing intervals subdivided, {a.timeline.stats.brentEvals} Brent evaluations, {fmt(a.timeline.stats.ms, 0)} ms.</p>
    </div>
  );
}

function DataBlock() {
  const a = useApp((s) => s.analysis)!;
  const t = a.terrain;
  return (
    <div>
      <table className="checks compact">
        <tbody>
          <tr><td>Terrain source</td><td className="mono">{t.source}</td></tr>
          <tr><td>Source grid spacing</td><td className="mono">{t.sourceSpacingM} m</td></tr>
          <tr><td>Effective resolution</td><td className="mono">{t.effectiveResM != null ? `~${fmt(t.effectiveResM, 0)} m` : '—'}</td></tr>
          <tr><td>Slope baseline used</td><td className="mono">{Math.round(t.slopeBaselineM)} m{t.lBaseResolved ? '' : <> ({tx('$L_{\\mathrm{base}}$')} unresolved)</>}</td></tr>
          <tr><td>Footprint cells</td><td className="mono">{t.footprintCells}</td></tr>
          <tr><td><InfoTip id="tri">TRI</InfoTip></td><td className="mono">{t.tri === null ? 'n/a (no 5 m DEM)' : `${fmt(t.tri, 3)} m`}</td></tr>
          <tr><td><InfoTip id="cpr">Mini-RF CPR</InfoTip></td><td className="mono">{fmt(t.cpr, 3)}</td></tr>
          <tr><td><InfoTip id="psr">Distance to PSR</InfoTip></td><td className="mono">{fmt(t.dPsrKm, 2)} km{t.inPsr ? ' (inside PSR)' : ''}</td></tr>
          <tr><td>Average Sun visibility (PGDA)</td><td className="mono">{fmt(t.sunfracPct, 0)} %</td></tr>
          <tr><td>LOLA shot density</td><td className="mono">{fmt(t.shotDensity, 0)} /km²</td></tr>
          <tr><td>Measured (shot) cells / interpolated</td><td className="mono">{fmt(t.directFrac * 100, 0)} % / {fmt(t.fInterp * 100, 0)} %</td></tr>
          <tr><td>{tx('Vertical uncertainty $\\sigma_z$')}</td><td className="mono">{fmt(t.sigmaZ, 2)} m ({t.sigmaSource})</td></tr>
          <tr><td>{tx('$q_{\\mathrm{source}}$')}</td><td className="mono">{fmt(t.qSource, 3)}</td></tr>
          <tr><td>{tx('$\\sigma_{h,\\max}$ (horizon)')}</td><td className="mono">{fmt(t.sigmaHMax, 3)}°</td></tr>
        </tbody>
      </table>
      {t.notes.length > 0 && <ul className="notes">{t.notes.map((n, i) => <li key={i}>{tx(n)}</li>)}</ul>}
      <Silhouettes />
      <p className="small muted">Compute: horizon {fmt(a.timing.horizonMs, 1)} ms · temporal {fmt(a.timing.temporalMs, 1)} ms · total {fmt(a.timing.totalMs, 1)} ms (Web Worker)</p>
    </div>
  );
}

function EphemerisBox() {
  const ephem = useApp((s) => s.ephem);
  const sel = useApp((s) => s.selection);
  return (
    <div className={`ephem-box ${ephem.mode}`}>
      <div><strong>Ephemeris</strong> <span className="small">{ephem.detail}</span></div>
      <button className="btn small" disabled={!sel || ephem.mode === 'checking'} onClick={() => sel && verifyWithHorizons(sel)}>Verify with JPL Horizons</button>
    </div>
  );
}

// ---------------------------------------------------------------- Compare
const PARAMS: { label: string; tip?: string; get: (s: SiteSummary) => string; best?: (vals: number[]) => number; val?: (s: SiteSummary) => number }[] = [
  { label: 'Feasibility', tip: 'feasibility', get: (s) => s.status },
  { label: 'Suitability', tip: 'suitability', get: (s) => fmt(s.suitability, 0), val: (s) => s.suitability, best: (v) => Math.max(...v) },
  { label: 'Data confidence', tip: 'confidence', get: (s) => fmt(s.confidence, 0), val: (s) => s.confidence, best: (v) => Math.max(...v) },
  { label: '$D_{\\mathrm{sun}}$', tip: 'dSun', get: (s) => fmtHours(s.dSunH), val: (s) => s.dSunH, best: (v) => Math.max(...v) },
  { label: '$D_{\\mathrm{dark}}$', tip: 'dDark', get: (s) => fmtHours(s.dDarkH), val: (s) => s.dDarkH, best: (v) => Math.min(...v) },
  { label: '$C_{\\mathrm{earth}}$', tip: 'dte', get: (s) => `${fmt(s.cEarth, 0)} %`, val: (s) => s.cEarth, best: (v) => Math.max(...v) },
  { label: 'Slope $\\alpha$', tip: 'slope', get: (s) => `${fmt(s.slope, 1)}°`, val: (s) => s.slope, best: (v) => Math.min(...v) },
  { label: 'Mean power $\\bar{P}$', tip: 'power', get: (s) => `${fmt(s.powerMeanW, 0)} W`, val: (s) => s.powerMeanW, best: (v) => Math.max(...v) },
  { label: 'Energy / mission', get: (s) => `${fmt(s.energyKWh, 0)} kWh`, val: (s) => s.energyKWh, best: (v) => Math.max(...v) },
  { label: 'Elevation', get: (s) => `${fmt(s.elev, 0)} m` },
  { label: 'Terrain data', get: (s) => s.level },
];
const OFFSETS = ['Landing', '+24 h', '+7 d', '+14 d'];

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Compare() {
  const pins = useApp((s) => s.pins);
  const ids = useApp((s) => s.compareIds);
  const rows = useApp((s) => s.compare);
  const busy = useApp((s) => s.compareBusy);
  const crit = useApp((s) => s.criteria);
  const tLand = useApp((s) => tLandOf(s));
  const chosen = pins.filter((p) => ids.includes(p.id));
  const toggle = (id: string) => {
    const cur = useApp.getState().compareIds;
    useApp.getState().set({ compareIds: cur.includes(id) ? cur.filter((i) => i !== id) : [...cur, id].slice(-6) });
  };
  const exportJson = () => {
    const out = {
      generated: new Date().toISOString(), generator: 'HECATE Lunar Landing Site Navigator v2.1',
      landing_utc: new Date(tLand).toISOString(), criteria: { ...crit, t0: new Date(crit.t0).toISOString() }, power: useApp.getState().power,
      sites: pins.map((p) => ({ name: p.name, lat: p.lat, lon_east: p.lon, x_m: p.x, y_m: p.y, curated_id: p.siteId, slips: rows?.find((r) => r.id === p.id)?.cols ?? null })),
    };
    download('hecate-comparison.json', JSON.stringify(out, null, 2), 'application/json');
  };
  const exportCsv = () => {
    const head = ['name', 'lat', 'lon_east', 'slip', 'landing_utc', 'status', 'suitability', 'confidence', 'D_sun_h', 'D_dark_h', 'C_earth_pct', 'slope_deg', 'mean_power_W', 'energy_kWh', 'terrain', 'elev_m'];
    const lines = [head.join(',')];
    for (const p of pins) {
      rows?.find((q) => q.id === p.id)?.cols.forEach((c, i) => {
        lines.push([JSON.stringify(p.name), p.lat.toFixed(5), p.lon.toFixed(5), OFFSETS[i], new Date(tLand + c.offsetH * HOUR_MS).toISOString(), c.status, c.suitability.toFixed(1), c.confidence.toFixed(1), c.dSunH.toFixed(2), c.dDarkH.toFixed(2), c.cEarth.toFixed(1), c.slope.toFixed(2), c.powerMeanW.toFixed(0), c.energyKWh.toFixed(1), JSON.stringify(c.level), c.elev.toFixed(1)].join(','));
      });
    }
    download('hecate-comparison.csv', lines.join('\n'), 'text/csv');
  };
  if (pins.length < 2)
    return (
      <div className="empty small">
        <Icon.columns />
        <p>Select at least two sites in <b>Recap</b>, with <kbd>Shift</kbd>+click on the map, or <kbd>P</kbd> / <b>＋</b> to compare them side by side. {pins.length === 1 ? 'One site selected so far.' : ''}</p>
        <button className="btn small" onClick={() => useApp.getState().set({ rightSection: 'recap' })}>Open Recap</button>
      </div>
    );
  return (
    <div className="sec-body" data-tour="compare">
      <span className="field-label">Sites to compare (up to 6)</span>
      <div className="chip-pick">
        {pins.map((p) => (
          <label key={p.id} className={`chip-opt${ids.includes(p.id) ? ' on' : ''}`} style={{ ['--pin' as string]: p.color }}>
            <input type="checkbox" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} />
            <span className="dot" />
            {p.name}
          </label>
        ))}
      </div>
      <div className="row gap">
        <button className="btn small" onClick={() => runCompare()} disabled={busy}>{busy ? 'Comparing…' : 'Refresh'}</button>
        <button className="btn small ghost" onClick={exportJson}><Icon.download /> JSON</button>
        <button className="btn small ghost" onClick={exportCsv}><Icon.download /> CSV</button>
      </div>
      {chosen.length >= 1 && rows && (
        <div className="compare-scroll">
          <table className="compare">
            <thead>
              <tr>
                <th>Landing {fmtUtc(tLand).slice(0, 16)}</th>
                {chosen.map((p) => <th key={p.id} style={{ color: p.color }}>{p.name.length > 16 ? `${p.name.slice(0, 15)}…` : p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {PARAMS.map((par) => {
                const sums = chosen.map((p) => rows.find((r) => r.id === p.id)?.cols[0] ?? null);
                const vals = par.val ? sums.filter(Boolean).map((s) => par.val!(s!)) : [];
                const best = par.best && vals.length > 1 ? par.best(vals) : null;
                return (
                  <tr key={par.label}>
                    <td>{par.tip ? <InfoTip id={par.tip}>{par.label}</InfoTip> : tx(par.label)}</td>
                    {sums.map((s, i) => (
                      <td key={chosen[i].id} className={`mono${best !== null && s && par.val && Math.abs(par.val(s) - best) < 1e-9 ? ' best' : ''}`}>
                        {!s ? '…' : par.label === 'Feasibility' ? <StatusBadge status={s.status} label={s.status === 'UNKNOWN' ? '?' : s.status} /> : par.get(s)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h4>Across launch slips</h4>
          <table className="compare">
            <thead><tr><th>Landing</th>{chosen.map((p) => <th key={p.id} style={{ color: p.color }}>{p.name.length > 12 ? `${p.name.slice(0, 11)}…` : p.name}</th>)}</tr></thead>
            <tbody>
              {OFFSETS.map((label, oi) => (
                <tr key={label}>
                  <td><b>{label}</b></td>
                  {chosen.map((p) => {
                    const c = rows.find((r) => r.id === p.id)?.cols[oi];
                    return (
                      <td key={p.id}>
                        {c ? <><StatusBadge status={c.status} label={c.status === 'UNKNOWN' ? '?' : c.status} /><div className="mono small muted">S {fmt(c.suitability, 0)} · ☀ {fmt(c.dSunH, 0)} h</div></> : '…'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {chosen.length === 0 && <p className="small muted">Tick at least one site above.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- Horizon
function HorizonSection() {
  const a = useApp((s) => s.analysis);
  const sel = useApp((s) => s.selection);
  const epoch = useApp((s) => s.epoch);
  if (!sel || !a || Math.hypot(a.x - sel.x, a.y - sel.y) >= 1)
    return (
      <div className="empty small">
        <Icon.horizon />
        <p>{sel ? 'Computing the horizon profile…' : 'Inspect a site to see its 360° horizon panorama with Sun and Earth trajectories.'}</p>
      </div>
    );
  const series = a.timeline.series;
  let i = 0;
  for (; i < series.t.length - 1 && series.t[i + 1] <= epoch; i++);
  const inRange = epoch >= series.t[0] && epoch <= series.t[series.t.length - 1];
  return (
    <div className="sec-body" data-tour="panorama">
      <SiteSwitcher />
      <Panorama />
      {inRange && (
        <div className="now-grid">
          <div className="now sun">
            <span>Sun now</span>
            <b className="mono">az {fmt(series.sunAz[i], 1)}° · el {fmt(series.sunEl[i], 2)}°</b>
            <span className="mono small">{tx(`$h_{\\mathrm{mask}} = ${fmt(series.sunH[i], 2)}^\\circ$ · disk $${fmt(series.sunF[i] * 100, 0)}\\,\\%$`)}</span>
          </div>
          <div className="now earth">
            <span>Earth now</span>
            <b className="mono">az {fmt(series.earthAz[i], 1)}° · el {fmt(series.earthEl[i], 2)}°</b>
            <span className="mono small">clearance {fmt(series.earthEl[i] - series.earthH[i], 2)}°</span>
          </div>
        </div>
      )}
      <p className="small muted">{tx(`Horizon: ${a.profile.n} azimuth samples (${(360 / a.profile.n).toFixed(2)}°) · ${a.profile.source} · $\\sigma_{h,\\max} = ${fmt(a.terrain.sigmaHMax, 3)}^\\circ$`)}</p>
    </div>
  );
}
