/**
 * Centralised reactive store (Zustand, spec v2.0 sec. 7.1). Components subscribe to
 * narrow slices so 60 fps timeline scrubbing does not re-render the whole tree.
 */
import { create } from 'zustand';
import { DEFAULT_T0, PRESETS, presetCriteria, WEIGHTS_DEFAULT_NO_PSR, WEIGHTS_DEFAULT_PSR, type Criteria } from '../science/criteria';
import type { ForwardResult } from '../science/forwardSearch';
import type { SiteAnalysis } from '../science/siteAnalysis';
import type { PowerParams } from '../science/power';
import { DEFAULT_POWER } from '../science/power';
import { HOUR_MS } from '../lib/math';

export type Tier = 'beginner' | 'advanced';
export type ViewMode = '3d' | '2d';
export type Theme = 'dark' | 'light';
export type AppMode = 'forward' | 'site';
export type Screen = 'menu' | 'workbench';
export type LeftSection = 'mission' | 'time' | 'sun' | 'comm' | 'terrain' | 'science' | 'power' | 'search' | 'sites';
export type RightSection = 'recap' | 'adequacy' | 'compare' | 'horizon';
export type RecapSort = 'feasibility' | 'suitability' | 'confidence' | 'dSun' | 'dDark' | 'cEarth' | 'slope' | 'power';
export type RecapFeasFilter = 'all' | 'PASS' | 'UNKNOWN' | 'FAIL';

export interface RecapFilter {
  feasibility: RecapFeasFilter;
  minConf: number;
  selectedOnly: boolean;
}

export type LayerId =
  | 'none' | 'illum' | 'elevation' | 'slope' | 'psr' | 'sunfrac' | 'psrdist' | 'cpr' | 'confidence' | 'effres' | 'sigma'
  | 'sunNow' | 'earthNow' | 'fsStatus' | 'fsSuit' | 'fsConf' | 'fsAvail';

export interface Selection {
  x: number;
  y: number;
  lat: number;
  lon: number;
  siteId: string | null;
  name: string;
}

export interface Pin extends Selection {
  id: string;
  color: string;
  addedAt: number;
}

export interface EphemStatus {
  mode: 'local' | 'override' | 'unreachable' | 'checking';
  detail: string;
  maxDeltaSun?: number;
  maxDeltaEarth?: number;
  siteKey?: string;
}

export interface LoadState {
  phase: 'boot' | 'core' | 'ready' | 'error';
  label: string;
  progress: number;
  error?: string;
}

export interface SiteSummary {
  offsetH: number;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  statusDetail: string;
  suitability: number;
  confidence: number;
  dSunH: number;
  dDarkH: number;
  cEarth: number;
  slope: number;
  level: string;
  elev: number;
  powerMeanW: number;
  energyKWh: number;
  failed: string[];
}

export interface CompareRow {
  id: string;
  cols: SiteSummary[];
}

export interface CamState {
  lat: number;
  lon: number;
  rangeKm: number;
  heading: number;
  tilt: number;
  /** Metres per screen pixel at the focus (2D map or 3D approximation). */
  mPerPx: number;
}

export type NavCommand =
  | { type: 'pan'; fwd: number; right: number }
  | { type: 'look'; dHeading: number; dTilt: number }
  | { type: 'zoom'; factor: number }
  | { type: 'range'; rangeKm: number }
  | { type: 'north' }
  | { type: 'pole' };

export interface AppState {
  load: LoadState;
  screen: Screen;
  mode: AppMode;
  modal: null | 'about' | 'settings';
  tutorialStep: number | null;
  tier: Tier;
  theme: Theme;
  view: ViewMode;
  leftSection: LeftSection | null;
  rightSection: RightSection | null;
  uiHidden: boolean;
  lonConvention: '360' | '180';

  presetId: string;
  basePresetId: string;
  weightPresetId: string;
  baseWeightPresetId: string;
  criteria: Criteria;
  power: PowerParams;
  /** Landing epoch offset from t0 (hours) - launch-slip stress test / mission-window position. */
  slipOffsetH: number;
  /** Displayed epoch (scrubber). */
  epoch: number;
  playing: boolean;
  /** Simulated hours per real second during playback. */
  playSpeed: number;
  /** When true the mission window (landing epoch) follows the playhead, so every time-dependent layer animates. */
  followPlayhead: boolean;

  selection: Selection | null;
  hover: {
    lat: number;
    lon: number;
    elev: number | null;
    cell?: { row: number; col: number; x: number; y: number; dx: number; status: number; passedRank: number | null };
    label?: string;
  } | null;
  snapToCells: boolean;
  /** Multi-site selection ("selected sites"). */
  pins: Pin[];
  compareIds: string[];
  recapSort: RecapSort;
  recapFilter: RecapFilter;
  compare: CompareRow[] | null;
  compareBusy: boolean;

  analysis: SiteAnalysis | null;
  analysisBusy: boolean;
  analysisError: string | null;
  nextWindow: { from: number; windows: [number, number][]; busy: boolean; error?: string } | null;

  forward: ForwardResult | null;
  forwardBusy: boolean;
  forwardProgress: number;
  autoForward: boolean;

  instant: { utcMs: number; n: number; sun: Float32Array; earth: Float32Array } | null;

  layer: LayerId;
  layerOpacity: number;
  showGraticule: boolean;
  showLabels: boolean;
  showSites: boolean;
  showEva: boolean;

  globe: {
    shadows: boolean;
    lighting: 'sun' | 'albedo';
    exaggeration: number;
    imagery: 'local' | 'trek';
    polarTerrain: 'polar' | 'l0';
    showVectors: boolean;
    showEarth: boolean;
    quality: 'low' | 'medium' | 'high';
    morph: boolean;
    debugLod: boolean;
  };
  cam: CamState;
  navSeq: number;
  navCommand: NavCommand | null;
  fullscreen: boolean;
  ephem: EphemStatus;
  autoVerify: boolean;
  perf: { fps: number; tiles: number; triangles: number; shadowMs: number };
  resolution: { source: string; sourceM: number; meshM: number; effectiveM: number | null; measuredPct: number | null; sigmaZ: number | null; imagery: string } | null;
  flyTo: { lat: number; lon: number; rangeKm: number; key: number } | null;
  toast: { msg: string; icon?: 'warn' | 'info' | 'pole' } | null;

  set: (p: Partial<AppState>) => void;
  setCriteria: (p: Partial<Criteria>) => void;
  setPower: (p: Partial<PowerParams>) => void;
  applyPreset: (id: string) => void;
  setEpoch: (ms: number) => void;
  stepEpoch: (hours: number) => void;
  setSlipOffset: (h: number) => void;
  select: (s: Selection | null) => void;
  pickMapSite: (s: Selection, multi?: boolean) => void;
  togglePin: (s?: Selection | null) => void;
  removePin: (id: string) => void;
  clearPins: () => void;
  setRecapFilter: (p: Partial<RecapFilter>) => void;
  setGlobe: (p: Partial<AppState['globe']>) => void;
  requestFlyTo: (lat: number, lon: number, rangeKm: number) => void;
  nav: (c: NavCommand) => void;
  notify: (msg: string, opts?: { icon?: 'warn' | 'info' | 'pole' }) => void;
  openLeft: (s: LeftSection) => void;
  openRight: (s: RightSection) => void;
}

const PIN_COLORS = ['#56B4E9', '#E69F00', '#CC79A7', '#F0E442', '#009E73', '#0072B2', '#D55E00', '#999999'];

function loadPrefs(): Partial<AppState> {
  try {
    const raw = localStorage.getItem('hecate.prefs');
    if (!raw) return {};
    const p = JSON.parse(raw);
    const pins: Pin[] = Array.isArray(p.pins) ? p.pins : [];
    return {
      theme: p.theme === 'light' ? 'light' : 'dark',
      tier: p.tier === 'advanced' ? 'advanced' : 'beginner',
      lonConvention: p.lonConvention === '180' ? '180' : '360',
      pins,
      compareIds: pins.slice(0, 6).map((q) => q.id),
      playSpeed: typeof p.playSpeed === 'number' ? p.playSpeed : 6,
    };
  } catch {
    return {};
  }
}

const initialCriteria = presetCriteria('artemis3');

const narrow = () => typeof window !== 'undefined' && window.innerWidth <= 1100;

export const useApp = create<AppState>((set, get) => ({
  load: { phase: 'boot', label: 'Starting…', progress: 0 },
  screen: 'menu',
  mode: 'forward',
  modal: null,
  tutorialStep: null,
  tier: 'beginner',
  theme: 'dark',
  view: '3d',
  // The app opens with both side panels collapsed and no analysis layer (relief only).
  leftSection: null,
  rightSection: null,
  uiHidden: false,
  lonConvention: '360',

  presetId: 'artemis3',
  basePresetId: 'artemis3',
  weightPresetId: 'default',
  baseWeightPresetId: 'default',
  criteria: initialCriteria,
  power: DEFAULT_POWER,
  slipOffsetH: 0,
  epoch: DEFAULT_T0,
  playing: false,
  playSpeed: 6,
  followPlayhead: false,

  selection: null,
  hover: null,
  snapToCells: true,
  pins: [],
  compareIds: [],
  recapSort: 'feasibility',
  recapFilter: { feasibility: 'all', minConf: 0, selectedOnly: false },
  compare: null,
  compareBusy: false,

  analysis: null,
  analysisBusy: false,
  analysisError: null,
  nextWindow: null,

  forward: null,
  forwardBusy: false,
  forwardProgress: 0,
  autoForward: true,

  instant: null,

  layer: 'none',
  layerOpacity: 0.75,
  showGraticule: true,
  showLabels: true,
  showSites: true,
  showEva: true,

  globe: { shadows: true, lighting: 'sun', exaggeration: 1, imagery: 'trek', polarTerrain: 'polar', showVectors: true, showEarth: true, quality: 'medium', morph: true, debugLod: false },
  cam: { lat: -78, lon: 0, rangeKm: 4200, heading: 180, tilt: 30, mPerPx: 5000 },
  navSeq: 0,
  navCommand: null,
  fullscreen: false,
  ephem: { mode: 'local', detail: 'Local Analytical Model (Astronomy Engine) — select a site to verify against JPL Horizons' },
  autoVerify: true,
  perf: { fps: 0, tiles: 0, triangles: 0, shadowMs: 0 },
  resolution: null,
  flyTo: null,
  toast: null,
  ...loadPrefs(),

  set: (p) => set(p),
  setCriteria: (p) =>
    set((s) => {
      const next = { ...s.criteria, ...p };
      if (p.psrFilter !== undefined && s.weightPresetId === 'default') next.weights = p.psrFilter ? WEIGHTS_DEFAULT_PSR : WEIGHTS_DEFAULT_NO_PSR;
      const base = PRESETS.find((q) => q.id === s.basePresetId) ?? PRESETS[0];
      const sameVal = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b);
      const modified = (Object.keys(base.criteria) as (keyof typeof base.criteria)[]).some((k) => !sameVal(next[k], base.criteria[k]));
      return { criteria: next, presetId: modified ? 'custom' : base.id };
    }),
  setPower: (p) => set((s) => ({ power: { ...s.power, ...p } })),
  applyPreset: (id) =>
    set((s) => ({ presetId: id, basePresetId: id, weightPresetId: 'default', baseWeightPresetId: 'default', criteria: presetCriteria(id, s.criteria.t0), slipOffsetH: 0, epoch: s.criteria.t0 })),
  setEpoch: (ms) => {
    const s = get();
    if (s.followPlayhead) set({ epoch: ms, slipOffsetH: Math.round(((ms - s.criteria.t0) / HOUR_MS) * 60) / 60 });
    else set({ epoch: ms });
  },
  stepEpoch: (h) => get().setEpoch(get().epoch + h * HOUR_MS),
  setSlipOffset: (h) => set((s) => ({ slipOffsetH: h, epoch: s.criteria.t0 + h * HOUR_MS })),
  select: (sel) => set((s) => ({ selection: sel, nextWindow: null, rightSection: sel && s.rightSection === null ? 'adequacy' : s.rightSection })),
  pickMapSite: (sel, multi = false) => {
    if (multi) {
      get().togglePin(sel);
      set((s) => ({ selection: sel, nextWindow: null, rightSection: s.rightSection ?? 'recap' }));
    } else {
      get().select(sel);
    }
  },
  togglePin: (s0) => {
    const s = s0 ?? get().selection;
    if (!s) return;
    const pins = get().pins;
    const existing = pins.find((p) => Math.hypot(p.x - s.x, p.y - s.y) < 1);
    if (existing) {
      set({ pins: pins.filter((p) => p !== existing), compareIds: get().compareIds.filter((i) => i !== existing.id) });
      get().notify(`Removed ${existing.name} from selected sites`);
      return;
    }
    if (pins.length >= 24) {
      get().notify('Up to 24 sites can be selected for comparison — remove one first', { icon: 'warn' });
      return;
    }
    const color = PIN_COLORS[pins.length % PIN_COLORS.length];
    const pin: Pin = { ...s, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, color, addedAt: Date.now() };
    const nextCompare = [...get().compareIds, pin.id].slice(-6);
    set({ pins: [...pins, pin], compareIds: nextCompare });
    get().notify(`Added ${s.name} to Recap & Compare (${pins.length + 1} selected)`);
  },
  removePin: (id) => set((s) => ({ pins: s.pins.filter((p) => p.id !== id), compareIds: s.compareIds.filter((i) => i !== id) })),
  clearPins: () => set({ pins: [], compareIds: [], compare: null }),
  setRecapFilter: (p) => set((s) => ({ recapFilter: { ...s.recapFilter, ...p } })),
  setGlobe: (p) => set((s) => ({ globe: { ...s.globe, ...p } })),
  requestFlyTo: (lat, lon, rangeKm) => set((s) => ({ flyTo: { lat, lon, rangeKm, key: (s.flyTo?.key ?? 0) + 1 } })),
  nav: (c) => set((s) => ({ navCommand: c, navSeq: s.navSeq + 1 })),
  notify: (msg, opts) => {
    const next = { msg, icon: opts?.icon };
    set({ toast: next });
    window.setTimeout(() => {
      if (get().toast === next) set({ toast: null });
    }, opts?.icon === 'warn' ? 4500 : 3200);
  },
  // Below 1100 px the panels are drawers over the view: keep at most one open so they never stack.
  openLeft: (sec) => set((s) => ({ leftSection: s.leftSection === sec ? null : sec, uiHidden: false, ...(narrow() && s.leftSection !== sec ? { rightSection: null } : {}) })),
  openRight: (sec) => set((s) => ({ rightSection: s.rightSection === sec ? null : sec, uiHidden: false, ...(narrow() && s.rightSection !== sec ? { leftSection: null } : {}) })),
}));

// Persist a few per-viewer conveniences.
useApp.subscribe((s, prev) => {
  if (s.theme === prev.theme && s.tier === prev.tier && s.lonConvention === prev.lonConvention && s.pins === prev.pins && s.playSpeed === prev.playSpeed) return;
  try {
    localStorage.setItem('hecate.prefs', JSON.stringify({ theme: s.theme, tier: s.tier, lonConvention: s.lonConvention, pins: s.pins, playSpeed: s.playSpeed }));
  } catch {
    /* storage unavailable */
  }
});

export const tLandOf = (s: Pick<AppState, 'criteria' | 'slipOffsetH'>) => s.criteria.t0 + s.slipOffsetH * HOUR_MS;
