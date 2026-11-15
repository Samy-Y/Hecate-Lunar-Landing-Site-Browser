/**
 * Presentation Mode choreography, state snapshot/restore, and Q&A hotkeys (Shift+Alt+P pitch deck).
 * Keeps every multi-step camera/UI transition cancellable and reversible cleanly.
 */
import { latLonToPolar } from '../lib/geo';
import { HOUR_MS } from '../lib/math';
import { parseUtc } from '../lib/time';
import { PRESETS } from './criteria';
import { runtime, scheduleAnalysis, scheduleForward, validateShadows, verifyWithHorizons } from '../store/runtime';
import { useApp, type AppMode, type AppState, type LeftSection, type Pin, type RightSection, type Selection, type ViewMode } from '../store/useApp';

export interface PresSlideSpec {
  id: number;
  badge: string;
  label: string;
  title: string;
  texLead?: string;
}

export const SLIDE_COUNT = 10;

export const PRES_SLIDES: PresSlideSpec[] = [
  { id: 0, badge: '00 / 09', label: 'Opener', title: 'HECATE Lunar South Pole Navigator' },
  { id: 1, badge: '01 / 09', label: 'South Pole Paradox', title: 'Illumination vs. Cold Traps (<110 K)' },
  { id: 2, badge: '02 / 09', label: 'Forward Search', title: 'Continuous 80°S–90°S Grid Screening' },
  { id: 3, badge: '03 / 09', label: 'Multi-Scale LOD', title: 'Quadtree LOD (5 m LOLA) · Spatial HUD' },
  { id: 4, badge: '04 / 09', label: 'Site Assessment', title: 'Feasibility · Suitability · Confidence' },
  { id: 5, badge: '05 / 09', label: 'NLE Timeline', title: 'Terrain-Masked Power & DTE Windows' },
  { id: 6, badge: '06 / 09', label: 'Horizon & Limits', title: '5 m Horizon Ray-Cast vs. Sub-Meter Limits' },
  { id: 7, badge: '07 / 09', label: 'Ephemeris Check', title: 'Client Analytical Model vs. JPL Horizons' },
  { id: 8, badge: '08 / 09', label: 'Future Roadmap', title: 'Next-Gen Risk, Thermal & ML Pipeline' },
  { id: 9, badge: '09 / 09', label: 'Overview', title: 'HECATE · Keyboard-First Navigation' },
];

export interface QaSpec {
  id: number;
  hotkey: string;
  label: string;
  title: string;
}

export const QA_VIEWS: QaSpec[] = [
  { id: 1, hotkey: 'Alt+1', label: '2D Polar View', title: 'Polar Stereographic Map & Snap Grid' },
  { id: 2, hotkey: 'Alt+2', label: 'Math & Scoring', title: 'Live Mathematical Model & Gate Weights' },
  { id: 3, hotkey: 'Alt+3', label: 'JPL Horizons', title: 'Tier-2 NASA JPL Horizons Ephemeris Check' },
  { id: 4, hotkey: 'Alt+4', label: '360° Horizon', title: 'Ray-Cast Sky Panorama & PSR Contours' },
  { id: 5, hotkey: 'Alt+5', label: 'Disclaimers', title: 'Scientific Disclaimers & Data Provenance' },
  { id: 6, hotkey: 'Alt+6', label: 'Baselines', title: 'Artemis III vs. CLPS vs. Rover Baselines' },
  { id: 7, hotkey: 'Alt+7', label: 'Confidence Grid', title: 'Regional Search & LOLA Shot Confidence' },
  { id: 8, hotkey: 'Alt+8', label: 'Diagnostics', title: 'GPU Shadow Ray-March vs. CPU Validation' },
];

interface Snapshot {
  screen: AppState['screen'];
  mode: AppMode;
  view: ViewMode;
  leftSection: LeftSection | null;
  rightSection: RightSection | null;
  modal: AppState['modal'];
  tutorialStep: number | null;
  uiHidden: boolean;
  layer: AppState['layer'];
  layerOpacity: number;
  showSites: boolean;
  playing: boolean;
  playSpeed: number;
  followPlayhead: boolean;
  slipOffsetH: number;
  epoch: number;
  presetId: string;
  basePresetId: string;
  weightPresetId: string;
  baseWeightPresetId: string;
  criteria: AppState['criteria'];
  power: AppState['power'];
  mathDrawerOpen: boolean;
  globe: AppState['globe'];
  selection: AppState['selection'];
  pins: Pin[];
  compareIds: string[];
  compare: AppState['compare'];
  analysis: AppState['analysis'];
  analysisError: string | null;
  ephem: AppState['ephem'];
  cam: AppState['cam'];
}

let savedSnap: Snapshot | null = null;
let runSeq = 0;
let activeTimers: number[] = [];
let diagSummaryCache: string | null = null;

/** Low southern-summer Sun over Shackleton rim casts long dark crater-floor shadows. */
const SHACKLETON_DRAMATIC_EPOCH = parseUtc('2027-10-18T12:00:00Z');

function clearTimers() {
  for (const t of activeTimers) globalThis.clearTimeout(t);
  activeTimers = [];
}

function later(seq: number, ms: number, fn: () => void) {
  const id = globalThis.setTimeout(() => {
    activeTimers = activeTimers.filter((x) => x !== id);
    if (runSeq === seq && useApp.getState().presentation.active) fn();
  }, ms) as unknown as number;
  activeTimers.push(id);
}

export function getDiagSummary() {
  return diagSummaryCache;
}

export function getCuratedSelection(id: string): Selection {
  const sites = runtime.data?.manifest.sites ?? [];
  const found = sites.find((q) => q.id === id);
  if (found) {
    return { x: found.x, y: found.y, lat: found.lat, lon: found.lon, siteId: found.id, name: found.name };
  }
  const lat = id === 'SHK-R' ? -89.9 : -89.45;
  const lon = id === 'SHK-R' ? 0 : 222.1;
  const [x, y] = latLonToPolar(lat, lon);
  return { x, y, lat, lon, siteId: id, name: id === 'SHK-R' ? 'Shackleton Rim (VAL-03)' : 'Connecting Ridge Candidate A' };
}

function ensureCandidatePinned(id: string): Selection {
  const sel = getCuratedSelection(id);
  const st = useApp.getState();
  const alreadyPinned = st.pins.some((p) => Math.hypot(p.x - sel.x, p.y - sel.y) < 1);
  const nextSel = !st.selection || Math.hypot(st.selection.x - sel.x, st.selection.y - sel.y) >= 1 ? sel : st.selection;
  if (alreadyPinned) {
    if (nextSel !== st.selection) useApp.setState({ selection: nextSel, nextWindow: null });
    return sel;
  }
  // Keep Presentation Mode pins isolated in-memory so they never trigger toasts or localStorage leaks.
  const presPin: Pin = { ...sel, id: `pres-${id}`, color: '#56B4E9', addedAt: Date.now() };
  useApp.setState({
    selection: nextSel,
    nextWindow: null,
    pins: [...st.pins, presPin],
    compareIds: [...st.compareIds, presPin.id].slice(-6),
    toast: null,
  });
  return sel;
}

function scrollRightTarget(seq: number, target: string) {
  later(seq, 140, () => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector(`.side.right [data-pres="${target}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function captureSnapshot() {
  const s = useApp.getState();
  savedSnap = {
    screen: s.screen,
    mode: s.mode,
    view: s.view,
    leftSection: s.leftSection,
    rightSection: s.rightSection,
    modal: s.modal,
    tutorialStep: s.tutorialStep,
    uiHidden: s.uiHidden,
    layer: s.layer,
    layerOpacity: s.layerOpacity,
    showSites: s.showSites,
    playing: s.playing,
    playSpeed: s.playSpeed,
    followPlayhead: s.followPlayhead,
    slipOffsetH: s.slipOffsetH,
    epoch: s.epoch,
    presetId: s.presetId,
    basePresetId: s.basePresetId,
    weightPresetId: s.weightPresetId,
    baseWeightPresetId: s.baseWeightPresetId,
    criteria: { ...s.criteria, weights: { ...s.criteria.weights } },
    power: { ...s.power },
    mathDrawerOpen: s.mathDrawerOpen,
    globe: { ...s.globe },
    selection: s.selection ? { ...s.selection } : null,
    pins: s.pins.map((p) => ({ ...p })),
    compareIds: [...s.compareIds],
    compare: s.compare,
    analysis: s.analysis,
    analysisError: s.analysisError,
    ephem: { ...s.ephem },
    cam: { ...s.cam },
  };
}

/** Enter Presentation Mode from any screen, bypassing main menu and warming up Shackleton behind Slide 00. */
export function enterPresentation(startSlide = 0) {
  const s = useApp.getState();
  if (!s.presentation.active) captureSnapshot();
  clearTimers();
  runSeq++;
  s.set({
    screen: 'workbench',
    modal: null,
    tutorialStep: null,
    uiHidden: false,
    toast: null,
    playing: false,
    followPlayhead: false,
    presentation: { active: true, slide: startSlide, qaId: null, orbit: false, openerFading: false, qaPanel: null },
  });
  applyPresentationSlide(startSlide);
}

/** Exit Presentation Mode cleanly and restore pre-presentation workbench controls & state. */
export function exitPresentation() {
  const s = useApp.getState();
  if (!s.presentation.active) return;
  clearTimers();
  runSeq++;
  diagSummaryCache = null;
  const snap = savedSnap;
  const stayInWorkbench = !snap || snap.screen === 'workbench' || s.presentation.slide > 0;
  savedSnap = null;
  if (snap) {
    s.set({
      screen: stayInWorkbench ? 'workbench' : snap.screen,
      mode: snap.mode,
      view: snap.view,
      leftSection: stayInWorkbench ? snap.leftSection : null,
      rightSection: stayInWorkbench ? snap.rightSection : null,
      modal: snap.modal,
      tutorialStep: snap.tutorialStep,
      uiHidden: false,
      layer: snap.layer,
      layerOpacity: snap.layerOpacity,
      showSites: snap.showSites,
      playing: false,
      playSpeed: snap.playSpeed,
      followPlayhead: false,
      slipOffsetH: snap.slipOffsetH,
      epoch: snap.epoch,
      criteria: snap.criteria,
      presetId: snap.presetId,
      basePresetId: snap.basePresetId,
      weightPresetId: snap.weightPresetId,
      baseWeightPresetId: snap.baseWeightPresetId,
      power: snap.power,
      mathDrawerOpen: false,
      globe: snap.globe,
      selection: snap.selection,
      pins: snap.pins,
      compareIds: snap.compareIds,
      compare: snap.compare,
      analysis: snap.analysis,
      analysisBusy: false,
      analysisError: snap.analysisError,
      ephem: snap.ephem,
      toast: null,
      presentation: { active: false, slide: 0, qaId: null, orbit: false, openerFading: false, qaPanel: null },
    });
    s.requestFlyTo(snap.cam.lat, snap.cam.lon, snap.cam.rangeKm, { heading: snap.cam.heading, tilt: snap.cam.tilt, dur: 0 });
  } else {
    s.set({
      screen: 'workbench',
      modal: null,
      uiHidden: false,
      playing: false,
      followPlayhead: false,
      mathDrawerOpen: false,
      pins: s.pins.filter((p) => !String(p.id).startsWith('pres-')),
      compareIds: s.compareIds.filter((id) => !String(id).startsWith('pres-')),
      toast: null,
      presentation: { active: false, slide: 0, qaId: null, orbit: false, openerFading: false, qaPanel: null },
    });
  }
}

export function togglePresentation() {
  if (useApp.getState().presentation.active) exitPresentation();
  else enterPresentation(0);
}

/** Apply choreography state for slide 0..9. Cancels pending timers and clears Q&A overrides. */
export function applyPresentationSlide(index: number) {
  const slide = Math.max(0, Math.min(SLIDE_COUNT - 1, index));
  const seq = ++runSeq;
  clearTimers();
  const s = useApp.getState();
  const prevSlide = s.presentation.slide;
  const revealingFromOpener = prevSlide === 0 && slide === 1 && s.presentation.active;

  // Always reset transient playback/modals unless explicitly needed by the target slide.
  s.set({
    screen: 'workbench',
    modal: null,
    tutorialStep: null,
    uiHidden: false,
    playing: false,
    followPlayhead: false,
    presentation: {
      active: true,
      slide,
      qaId: null,
      orbit: slide === 1 || slide === 9,
      openerFading: revealingFromOpener,
      qaPanel: null,
    },
  });

  if (revealingFromOpener) {
    later(seq, 460, () => {
      const cur = useApp.getState();
      if (cur.presentation.active && cur.presentation.openerFading) {
        cur.set({ presentation: { ...cur.presentation, openerFading: false } });
      }
    });
  }

  const cr = getCuratedSelection('CR-A');

  switch (slide) {
    case 0: {
      // Pre-load 3D Shackleton Rim low-sun scene cleanly behind the black Slide 00 curtain.
      s.applyPreset('artemis3');
      s.setGlobe({ shadows: true, lighting: 'sun', showEarth: true, showVectors: true, polarTerrain: 'polar' });
      s.set({
        mode: 'forward',
        view: '3d',
        leftSection: null,
        rightSection: null,
        layer: 'none',
        showSites: true,
        mathDrawerOpen: false,
        epoch: SHACKLETON_DRAMATIC_EPOCH,
      });
      s.requestFlyTo(-89.4, 0, 280, { heading: 35, tilt: 45, dur: 0 });
      break;
    }

    case 1: {
      // Slide 01: Shackleton Crater rim casting dramatic shadows with slow orbit.
      s.setGlobe({ shadows: true, lighting: 'sun', showEarth: true, showVectors: true, polarTerrain: 'polar' });
      s.set({
        mode: 'forward',
        view: '3d',
        leftSection: null,
        rightSection: null,
        layer: 'none',
        showSites: true,
        mathDrawerOpen: false,
        epoch: SHACKLETON_DRAMATIC_EPOCH,
      });
      s.requestFlyTo(-89.4, 0, 280, { heading: 35, tilt: 45, dur: revealingFromOpener ? 0 : 1.4 });
      break;
    }

    case 2: {
      // Slide 02: Open Forward Search, apply Artemis III, show Slope heatmap & run grid search.
      s.applyPreset('artemis3');
      s.setGlobe({ shadows: true, lighting: 'sun', polarTerrain: 'polar' });
      s.set({
        mode: 'forward',
        view: '3d',
        leftSection: 'search',
        rightSection: null,
        layer: 'slope',
        layerOpacity: 0.72,
        mathDrawerOpen: false,
      });
      s.requestFlyTo(-88.2, 10, 420, { heading: 180, tilt: 22, dur: 1.4 });
      scheduleForward(0);
      break;
    }

    case 3: {
      // Slide 03: Zoom into Connecting Ridge in 3D (100m -> 20m -> 5m LOLA) with spatial HUD.
      s.setGlobe({ shadows: true, lighting: 'sun', polarTerrain: 'polar' });
      s.set({
        mode: 'forward',
        view: '3d',
        leftSection: null,
        rightSection: null,
        layer: 'none',
        mathDrawerOpen: false,
      });
      s.requestFlyTo(cr.lat, cr.lon, 18, { heading: 220, tilt: 48, dur: 1.5 });
      break;
    }

    case 4: {
      // Slide 04: Select & pin candidate ridge, open Site Analysis -> Adequacy + Math drawer.
      s.applyPreset('artemis3');
      ensureCandidatePinned('CR-A');
      s.set({
        mode: 'site',
        view: '3d',
        leftSection: null,
        rightSection: 'adequacy',
        layer: 'none',
        mathDrawerOpen: true,
      });
      s.requestFlyTo(cr.lat, cr.lon, 24, { heading: 225, tilt: 46, dur: 1.2 });
      scheduleAnalysis(0);
      scrollRightTarget(seq, 'math-drawer');
      break;
    }

    case 5: {
      // Slide 05: Coupled Solar + DTE Timeline over a 28-day (±14 d) synodic cycle.
      const baseCrit = PRESETS.find((p) => p.id === 'artemis3')?.criteria ?? s.criteria;
      ensureCandidatePinned('CR-A');
      s.setCriteria({ ...baseCrit, slipH: 336 });
      s.set({
        mode: 'site',
        view: '3d',
        leftSection: null,
        rightSection: 'adequacy',
        layer: 'none',
        mathDrawerOpen: false,
        epoch: s.criteria.t0 - 300 * HOUR_MS,
        slipOffsetH: -300,
        playSpeed: 48,
        followPlayhead: true,
        playing: true,
      });
      s.requestFlyTo(cr.lat, cr.lon, 28, { heading: 200, tilt: 44, dur: 1.1 });
      scrollRightTarget(seq, 'power-box');
      break;
    }

    case 6: {
      // Slide 06: 360° Horizon Panorama + PSR proximity layer + Geometric/Resolution disclaimer callouts.
      s.applyPreset('artemis3');
      ensureCandidatePinned('CR-A');
      s.set({
        mode: 'site',
        view: '3d',
        leftSection: null,
        rightSection: 'horizon',
        layer: 'psrdist',
        layerOpacity: 0.72,
        mathDrawerOpen: false,
      });
      s.requestFlyTo(cr.lat, cr.lon, 34, { heading: 215, tilt: 42, dur: 1.2 });
      break;
    }

    case 7: {
      // Slide 07: Live NASA JPL Horizons verification panel.
      s.applyPreset('artemis3');
      const site = ensureCandidatePinned('CR-A');
      s.set({
        mode: 'site',
        view: '3d',
        leftSection: null,
        rightSection: 'adequacy',
        layer: 'none',
        mathDrawerOpen: false,
      });
      s.requestFlyTo(site.lat, site.lon, 30, { heading: 210, tilt: 44, dur: 1.0 });
      scrollRightTarget(seq, 'ephem-box');
      if (typeof document !== 'undefined') void verifyWithHorizons(site);
      break;
    }

    case 8: {
      // Slide 08: Future roadmap over a crisp lunar South Pole crater complex (Haworth / Shackleton sector).
      s.setGlobe({ shadows: true, lighting: 'sun', polarTerrain: 'polar' });
      s.set({
        mode: 'site',
        view: '3d',
        leftSection: null,
        rightSection: null,
        layer: 'none',
        epoch: SHACKLETON_DRAMATIC_EPOCH,
      });
      s.requestFlyTo(-87.4, 332, 135, { heading: 145, tilt: 48, dur: 1.6 });
      break;
    }

    case 9: {
      // Slide 09: Full 3D South Pole overview with pinned candidate site highlighted.
      ensureCandidatePinned('CR-A');
      s.setGlobe({ shadows: true, lighting: 'sun', showEarth: true, showVectors: true, polarTerrain: 'polar' });
      s.set({
        mode: 'site',
        view: '3d',
        leftSection: null,
        rightSection: null,
        layer: 'none',
        showSites: true,
        epoch: SHACKLETON_DRAMATIC_EPOCH,
      });
      s.requestFlyTo(-89.3, 20, 480, { heading: 180, tilt: 28, dur: 1.8 });
      break;
    }
  }
}

export function stepPresentationSlide(delta: number) {
  const s = useApp.getState();
  if (!s.presentation.active) return;
  const next = Math.max(0, Math.min(SLIDE_COUNT - 1, s.presentation.slide + delta));
  if (next === s.presentation.slide && s.presentation.qaId === null) return;
  applyPresentationSlide(next);
}

/** Q&A Quick-Jump hotkeys Alt+1 .. Alt+8 available during Presentation Mode. */
export function jumpPresentationQa(qaId: number) {
  const s = useApp.getState();
  if (!s.presentation.active || qaId < 1 || qaId > 8) return;
  const seq = ++runSeq;
  clearTimers();
  const cr = getCuratedSelection('CR-A');

  s.set({
    screen: 'workbench',
    modal: null,
    tutorialStep: null,
    uiHidden: false,
    playing: false,
    followPlayhead: false,
    presentation: { ...s.presentation, qaId, orbit: false, openerFading: false, qaPanel: null },
  });

  switch (qaId) {
    case 1:
      // Alt+1: 2D Polar Stereographic view
      s.set({ view: '2d', leftSection: null, rightSection: null });
      s.requestFlyTo(cr.lat, cr.lon, 40);
      break;
    case 2:
      // Alt+2: Mathematical Model & Scoring drawer
      ensureCandidatePinned('CR-A');
      s.set({ view: '3d', mode: 'site', leftSection: null, rightSection: 'adequacy', mathDrawerOpen: true });
      s.requestFlyTo(cr.lat, cr.lon, 24, { heading: 220, tilt: 45, dur: 0.9 });
      scrollRightTarget(seq, 'math-drawer');
      break;
    case 3:
      // Alt+3: JPL Horizons validation panel
      {
        const site = ensureCandidatePinned('CR-A');
        s.set({ view: '3d', mode: 'site', leftSection: null, rightSection: 'adequacy', mathDrawerOpen: false });
        scrollRightTarget(seq, 'ephem-box');
        if (typeof document !== 'undefined') void verifyWithHorizons(site);
      }
      break;
    case 4:
      // Alt+4: 360° Horizon Panorama + PSR Contours
      ensureCandidatePinned('CR-A');
      s.set({ view: '3d', mode: 'site', leftSection: null, rightSection: 'horizon', layer: 'psrdist', layerOpacity: 0.72 });
      break;
    case 5:
      // Alt+5: Scientific Disclaimers / About cards
      s.set({ modal: 'about' });
      break;
    case 6:
      // Alt+6: Artemis III vs. CLPS vs. Rover baseline comparison overlay
      s.set({
        view: '3d',
        leftSection: null,
        presentation: { ...useApp.getState().presentation, qaPanel: 'baselines' },
      });
      break;
    case 7:
      // Alt+7: Forward Search & Data Confidence screen
      s.set({ view: '3d', mode: 'forward', leftSection: 'search', rightSection: 'recap', layer: 'confidence', layerOpacity: 0.72 });
      s.requestFlyTo(-88.5, 0, 420, { heading: 180, tilt: 22, dur: 1.0 });
      scheduleForward(0);
      break;
    case 8:
      // Alt+8: Live GPU vs. CPU Shadow Validation & Engine Diagnostics
      s.set({ view: '3d', leftSection: null, rightSection: null, presentation: { ...useApp.getState().presentation, qaPanel: 'telemetry' } });
      diagSummaryCache = 'Running GPU horizon ray-march vs. CPU comparison…';
      useApp.getState().set({ presentation: { ...useApp.getState().presentation } });
      void validateShadows().then((res) => {
        if (runSeq !== seq) return;
        diagSummaryCache = res;
        useApp.getState().set({ presentation: { ...useApp.getState().presentation } });
      });
      break;
  }
}
