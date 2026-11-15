/**
 * Runtime orchestration: progressive loading of the real NASA datasets, engine-worker wiring and the
 * reactive triggers that keep analyses in sync with the store. Triggers are throttled (leading +
 * trailing) rather than only debounced, so analyses keep updating during timeline playback.
 */
import { fetchEntry, DATA_ROOT, toFloat } from '../data/fetchBin';
import { Level0Store } from '../data/level0';
import type { Manifest, RegionalRaw } from '../data/types';
import { buildRegional, type RegionalData } from '../science/regional';
import { EngineClient } from '../workers/engineClient';
import { tLandOf, useApp, type CompareRow, type Selection } from './useApp';
import { geometryAt, earthTopo, sunTopo } from '../science/ephemeris';
import { siteFrame } from '../lib/geo';
import { HOUR_MS, azDiff } from '../lib/math';
import type { ForwardResult } from '../science/forwardSearch';
import type { SiteAnalysis } from '../science/siteAnalysis';

export interface AppData {
  manifest: Manifest;
  regional: RegionalData;
  l0: Level0Store;
}

type Listener = () => void;
export const runtime: {
  engine: EngineClient | null;
  data: AppData | null;
  dataListeners: Set<Listener>;
  /** Registered by the globe: GPU-baked Sun visibility at map points for an epoch. */
  gpuSunProbe?: (points: [number, number][], utcMs: number, bake: 'focus' | 'polar') => Promise<number[] | null>;
  /** Registered by the globe: map rectangle of the current view-dependent (local) shadow bake. */
  gpuFocusRect?: () => { x0: number; yTop: number; width: number } | null;
  /** Registered by the globe: GPU illumination bake of a polar rectangle, read back as RGBA bytes. */
  bake2d?: (rect: { x0: number; yTop: number; width: number }, size: number, utcMs: number, k: number | null) => Promise<Uint8Array | null>;
} = { engine: null, data: null, dataListeners: new Set() };
const emitData = () => runtime.dataListeners.forEach((l) => l());

const setLoad = (label: string, progress: number, phase: 'boot' | 'core' | 'ready' = 'core') => useApp.getState().set({ load: { phase, label, progress } });

let bootPromise: Promise<void> | null = null;
/** Idempotent (React StrictMode mounts effects twice in development). */
export function boot() {
  bootPromise ??= bootOnce();
  return bootPromise;
}

const CORE = ['reg_dem', 'ana_slope', 'ana_psr', 'ana_psrdist', 'ana_illum', 'ana_cpr', 'ana_dens', 'ana_err', 'ana_effres', 'hz_grid', 'hz_sigmax', 'site_horizons'] as const;

async function bootOnce() {
  try {
    setLoad('Loading data manifest…', 0.02, 'boot');
    const manifest: Manifest = await (await fetch(`${DATA_ROOT}manifest.json`)).json();
    if (manifest.schema !== 'hecate-data/3') throw new Error(`Unsupported data schema ${manifest.schema} — run pipeline/build_polar.py`);
    const f = manifest.files;
    const total = CORE.reduce((s, k) => s + f[k].bytes_gz, 0) + (manifest.level0?.levels['4ppd'].bytes_gz ?? 0);
    let got = 0;
    const tick = (n: number) => {
      got += n;
      setLoad(`Loading real LOLA South-Pole data… ${Math.round((100 * got) / total)} %`, 0.05 + 0.85 * (got / total), 'boot');
    };
    const l0 = manifest.level0 ? new Level0Store(manifest.level0) : null;
    const arrays = await Promise.all(CORE.map((k) => fetchEntry(f[k], tick)));
    if (l0) await l0.loadGlobal(4);
    const A = Object.fromEntries(CORE.map((k, i) => [k, arrays[i]]));
    const flt = (k: (typeof CORE)[number]) => {
      const e = f[k];
      const a = toFloat(A[k], e.scale, e.offset);
      if (e.nodata !== null) {
        const src = A[k];
        for (let i = 0; i < a.length; i++) if (src[i] === e.nodata) a[i] = NaN;
      }
      return a;
    };
    const raw: RegionalRaw = {
      reg_dem: flt('reg_dem'), ana_slope: flt('ana_slope'), ana_psr: flt('ana_psr'), ana_psrdist: flt('ana_psrdist'),
      ana_illum: flt('ana_illum'), ana_cpr: flt('ana_cpr'), ana_dens: flt('ana_dens'), ana_err: flt('ana_err'), ana_effres: flt('ana_effres'),
      hz_grid: A.hz_grid as Int16Array, hz_sigmax: flt('hz_sigmax'), site_horizons: A.site_horizons as Int16Array,
    };
    setLoad('Starting science engine…', 0.93, 'boot');
    const engine = new EngineClient();
    runtime.engine = engine;
    const copy = (a: Float32Array) => a.slice();
    const workerRaw: RegionalRaw = {
      ...raw, reg_dem: copy(raw.reg_dem), ana_slope: copy(raw.ana_slope), ana_psr: copy(raw.ana_psr), ana_psrdist: copy(raw.ana_psrdist),
      ana_illum: copy(raw.ana_illum), ana_cpr: copy(raw.ana_cpr), ana_dens: copy(raw.ana_dens), ana_err: copy(raw.ana_err), ana_effres: copy(raw.ana_effres),
    };
    await engine.call('init', { manifest, raw: workerRaw }, [workerRaw.hz_grid.buffer]);
    const regional = buildRegional(manifest, { ...raw, hz_grid: new Int16Array(0) });
    runtime.data = { manifest, regional, l0: l0 ?? (null as unknown as Level0Store) };
    emitData();
    setLoad('Ready', 1, 'ready');
    wireTriggers();
    void loadSecondary();
  } catch (err) {
    console.error(err);
    useApp.getState().set({ load: { phase: 'error', label: 'Failed to load data', progress: 0, error: (err as Error).message } });
  }
}

async function loadSecondary() {
  const d = runtime.data!;
  if (d.l0) {
    useApp.getState().set({ load: { phase: 'ready', label: 'Streaming global LOLA relief (8 ppd)…', progress: 0.5 } });
    await d.l0.loadGlobal(8).catch(() => void 0);
    emitData();
  }
  useApp.getState().set({ load: { phase: 'ready', label: '', progress: 1 } });
}

/** Leading + trailing throttle that also coalesces bursts. */
function throttled(fn: () => Promise<void>, minGapMs: number) {
  let running = false, pending = false, last = 0, timer = 0;
  const run = async () => {
    running = true;
    last = performance.now();
    try {
      await fn();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };
  const schedule = (delay = 0) => {
    if (running) {
      pending = true;
      return;
    }
    window.clearTimeout(timer);
    const wait = Math.max(delay, minGapMs - (performance.now() - last));
    timer = window.setTimeout(run, Math.max(0, wait));
  };
  return schedule;
}

let analysisSeq = 0;
async function runAnalysis() {
  const s = useApp.getState();
  const sel = s.selection;
  if (!sel || !runtime.engine) {
    if (!sel) s.set({ analysis: null });
    return;
  }
  const seq = ++analysisSeq;
  s.set({ analysisBusy: true, analysisError: null });
  try {
    const result = await runtime.engine.call<SiteAnalysis>('analyze', { x: sel.x, y: sel.y, siteId: sel.siteId, crit: s.criteria, tLand: tLandOf(s), power: s.power });
    if (seq !== analysisSeq) return;
    useApp.getState().set({ analysis: result, analysisBusy: false });
    if (useApp.getState().autoVerify && !useApp.getState().playing) void verifyWithHorizons(sel);
  } catch (err) {
    if (seq === analysisSeq) useApp.getState().set({ analysisBusy: false, analysisError: (err as Error).message });
  }
}
export const scheduleAnalysis = throttled(runAnalysis, 180);

let forwardSeq = 0;
async function runForward() {
  if (!runtime.engine) return;
  const seq = ++forwardSeq;
  const s = useApp.getState();
  s.set({ forwardBusy: true, forwardProgress: 0 });
  try {
    const r = await runtime.engine.call<ForwardResult>('forward', { crit: s.criteria, tLand: tLandOf(s) }, [], (_l, f) => {
      if (seq === forwardSeq) useApp.getState().set({ forwardProgress: f });
    });
    if (seq !== forwardSeq) return;
    useApp.getState().set({ forward: r, forwardBusy: false, forwardProgress: 1 });
  } catch (err) {
    console.error(err);
    if (seq === forwardSeq) useApp.getState().set({ forwardBusy: false });
  }
}
export const scheduleForward = throttled(runForward, 250);

async function runInstant() {
  if (!runtime.engine) return;
  const utcMs = useApp.getState().epoch;
  const r = await runtime.engine.call<{ n: number; sun: Float32Array; earth: Float32Array }>('instant', { utcMs });
  useApp.getState().set({ instant: { utcMs, ...r } });
}
const scheduleInstant = throttled(runInstant, 120);

async function runCompareNow() {
  const s = useApp.getState();
  if (!runtime.engine || s.pins.length === 0) {
    s.set({ compare: null });
    return;
  }
  s.set({ compareBusy: true });
  try {
    const rows = await runtime.engine.call<CompareRow[]>('compare', {
      sites: s.pins.map((p) => ({ id: p.id, x: p.x, y: p.y, siteId: p.siteId })),
      crit: s.criteria, tLand: tLandOf(s), power: s.power, offsetsH: [0, 24, 168, 336],
    });
    useApp.getState().set({ compare: rows, compareBusy: false });
  } catch {
    useApp.getState().set({ compareBusy: false });
  }
}
const scheduleCompare = throttled(runCompareNow, 900);
export function runCompare() {
  scheduleCompare();
}

export async function findNextWindow(days = 365) {
  const s = useApp.getState();
  const sel = s.selection;
  if (!sel || !runtime.engine) return;
  const from = tLandOf(s) + HOUR_MS;
  s.set({ nextWindow: { from, windows: [], busy: true } });
  try {
    const r = await runtime.engine.call<{ windows: [number, number][]; terrainOk: boolean }>('findNext', { x: sel.x, y: sel.y, siteId: sel.siteId, crit: s.criteria, from, days });
    useApp.getState().set({ nextWindow: { from, windows: r.windows, busy: false, error: r.terrainOk ? undefined : 'Terrain constraints fail at this site — no landing epoch can make it feasible' } });
    if (r.windows.length) {
      const h = (r.windows[0][0] - s.criteria.t0) / HOUR_MS;
      useApp.getState().setSlipOffset(Math.ceil(h * 60) / 60);
      useApp.getState().notify(`Next viable window starts ${new Date(r.windows[0][0]).toISOString().slice(0, 16).replace('T', ' ')}Z`);
    } else useApp.getState().notify(`No viable window in the next ${days} days`);
  } catch (err) {
    useApp.getState().set({ nextWindow: { from, windows: [], busy: false, error: (err as Error).message } });
  }
}

/**
 * GPU-vs-CPU shadow validation (3D-mapping feedback): sample points in the focus area, read the
 * GPU-baked Sun visibility, and compare with the worker's independent CPU ray cast.
 */
export async function validateShadows(n = 40): Promise<string> {
  const s = useApp.getState();
  if (!runtime.engine || !runtime.gpuSunProbe) return 'Open the 3D globe first.';
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const compare = async (label: string, bake: 'focus' | 'polar', pts: [number, number][]) => {
    const gpu = await runtime.gpuSunProbe!(pts, s.epoch, bake);
    if (!gpu) return `${label}: bake not available at this view`;
    const cpu = await runtime.engine!.call<number[]>('sunProbe', { points: pts, utcMs: s.epoch });
    let m = 0, sum = 0, max = 0, agree = 0, lit = 0;
    for (let i = 0; i < pts.length; i++) {
      if (!Number.isFinite(gpu[i]) || !Number.isFinite(cpu[i])) continue;
      const d = Math.abs(gpu[i] - cpu[i]);
      m++;
      sum += d;
      max = Math.max(max, d);
      if ((gpu[i] > 0.5) === (cpu[i] > 0.5)) agree++;
      if (cpu[i] > 0.5) lit++;
    }
    if (!m) return `${label}: no comparable points`;
    return `${label}: ${m} pts, ${((100 * lit) / m).toFixed(0)} % lit (CPU) · mean |Δf_sun| ${(sum / m).toFixed(3)} · max ${max.toFixed(2)} · lit/shadow agreement ${((100 * agree) / m).toFixed(0)} %`;
  };
  const out: string[] = [`Epoch ${new Date(s.epoch).toISOString().slice(0, 16)}Z — GPU bake vs CPU multi-resolution ray cast`];
  // Local (detailed) bake: points inside the inner 80 % of the view-dependent focus rectangle.
  const fr = runtime.gpuFocusRect?.();
  if (fr) {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([fr.x0 + fr.width * (0.1 + 0.8 * rnd()), fr.yTop - fr.width * (0.1 + 0.8 * rnd())]);
    out.push(await compare(`Local bake (${(fr.width / 1000).toFixed(1)} km)`, 'focus', pts));
  } else out.push('Local bake: inactive (zoom below ~260 km range over the polar cap)');
  // Regional (preliminary) bake: points within +/-15 km of the selection (or the pole).
  const cx = s.selection?.x ?? 0, cy = s.selection?.y ?? 0;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([cx + (rnd() - 0.5) * 30000, cy + (rnd() - 0.5) * 30000]);
  out.push(await compare('Regional bake (320 m DEM)', 'polar', pts));
  return out.join('\n');
}

/**
 * Tier 2: fetch Sun & Earth apparent az/el for the inspected site over [t_land, t_land + T] via the caching
 * proxy, compare with Tier 1, and switch the status to "Override Active" when |dtheta| exceeds the acceptance
 * threshold (0.05 deg Sun, 0.10 deg Earth). Timeout 3 s -> "Horizons API Unreachable".
 */
export async function verifyWithHorizons(sel: Selection) {
  const s = useApp.getState();
  const tLand = tLandOf(s);
  const elevKm = ((s.analysis?.terrain.elev ?? 0) + 2) / 1000;
  const key = `${sel.x.toFixed(0)}|${sel.y.toFixed(0)}|${tLand}|${s.criteria.missionH}`;
  if (s.ephem.siteKey === key && s.ephem.mode !== 'unreachable') return;
  s.set({ ephem: { mode: 'checking', detail: 'Verifying against NASA JPL Horizons…', siteKey: key } });
  const stepH = Math.max(1, Math.round(s.criteria.missionH / 24));
  const fmtT = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const lonE = ((sel.lon % 360) + 360) % 360;
  const query = (cmd: string) =>
    new URLSearchParams({
      format: 'json', COMMAND: `'${cmd}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'", CENTER: "'coord@301'",
      COORD_TYPE: "'GEODETIC'", SITE_COORD: `'${lonE.toFixed(5)},${sel.lat.toFixed(5)},${elevKm.toFixed(4)}'`,
      START_TIME: `'${fmtT(tLand)}'`, STOP_TIME: `'${fmtT(tLand + s.criteria.missionH * HOUR_MS)}'`, STEP_SIZE: `'${stepH} h'`,
      QUANTITIES: "'4,14,20'", REF_SYSTEM: "'ICRF'", ANG_FORMAT: "'DEG'", CSV_FORMAT: "'YES'", APPARENT: "'AIRLESS'",
    }).toString();
  const get = async (cmd: string) => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(`/api/horizons?${query(cmd)}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const body = String(j.result ?? '');
      const rows = body.split('$$SOE')[1]?.split('$$EOE')[0]?.trim().split('\n') ?? [];
      return rows.map((l) => {
        const p = l.split(',').map((x) => x.trim());
        return { t: Date.parse(`${p[0].replace(/(\d{4})-(\w{3})-(\d{2}) /, '$2 $3 $1 ')} UTC`), az: Number(p[3]), el: Number(p[4]) };
      });
    } finally {
      window.clearTimeout(timer);
    }
  };
  try {
    const [sun, earth] = await Promise.all([get('10'), get('399')]);
    if (!sun.length || !earth.length) throw new Error('empty Horizons response');
    const f = siteFrame(sel.lat, sel.lon, elevKm * 1000);
    let dS = 0, dE = 0;
    for (let i = 0; i < Math.min(sun.length, earth.length); i++) {
      const g = geometryAt(sun[i].t);
      const ts = sunTopo(f, g), te = earthTopo(f, g);
      dS = Math.max(dS, Math.hypot(ts.el - sun[i].el, azDiff(sun[i].az, ts.az) * Math.cos((ts.el * Math.PI) / 180)));
      dE = Math.max(dE, Math.hypot(te.el - earth[i].el, azDiff(earth[i].az, te.az) * Math.cos((te.el * Math.PI) / 180)));
    }
    const override = dS > 0.05 || dE > 0.1;
    useApp.getState().set({
      ephem: {
        mode: override ? 'override' : 'local', siteKey: key, maxDeltaSun: dS, maxDeltaEarth: dE,
        detail: override
          ? `JPL Horizons Override Active (|Δθ| Sun ${dS.toFixed(3)}°, Earth ${dE.toFixed(3)}°)`
          : `Local Analytical Model — verified vs JPL Horizons (|Δθ| Sun ${dS.toFixed(4)}°, Earth ${dE.toFixed(4)}°, ${sun.length} epochs)`,
      },
    });
  } catch {
    useApp.getState().set({ ephem: { mode: 'unreachable', siteKey: key, detail: 'Local Ephemeris Active (Horizons API Unreachable) [Offline Mode — Unverified]' } });
  }
}

let wired = false;
function wireTriggers() {
  if (wired) return;
  wired = true;
  useApp.subscribe((s, p) => {
    const critChanged = s.criteria !== p.criteria;
    const landChanged = s.slipOffsetH !== p.slipOffsetH;
    if (s.selection !== p.selection || critChanged || landChanged || s.power !== p.power) scheduleAnalysis();
    if ((critChanged || landChanged) && s.autoForward) scheduleForward();
    if (s.epoch !== p.epoch) scheduleInstant();
    if (s.pins !== p.pins || critChanged || landChanged || s.power !== p.power) {
      if (s.pins.length) scheduleCompare();
      else if (s.compare) s.set({ compare: null });
    }
  });
  const s = useApp.getState();
  if (s.autoForward) scheduleForward();
  scheduleInstant();
  if (s.pins.length) scheduleCompare();
}
