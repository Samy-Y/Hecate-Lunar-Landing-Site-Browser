/**
 * Unit tests for Presentation Mode choreography, state restoration, and Q&A jumps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../store/useApp';
import {
  applyPresentationSlide,
  enterPresentation,
  exitPresentation,
  jumpPresentationQa,
  PRES_SLIDES,
  QA_VIEWS,
  stepPresentationSlide,
} from './presentation';

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  exitPresentation();
  useApp.getState().set({
    screen: 'menu',
    mode: 'forward',
    view: '3d',
    leftSection: null,
    rightSection: null,
    layer: 'none',
    modal: null,
    playing: false,
    followPlayhead: false,
    mathDrawerOpen: false,
    selection: null,
    pins: [],
    compareIds: [],
    compare: null,
    analysis: null,
    analysisError: null,
    toast: null,
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Presentation Mode choreography', () => {
  it('defines 10 slides (00/09 .. 09/09) and 8 Q&A quick-jumps', () => {
    expect(PRES_SLIDES).toHaveLength(10);
    expect(PRES_SLIDES[0].badge).toBe('00 / 09');
    expect(PRES_SLIDES[9].badge).toBe('09 / 09');
    expect(QA_VIEWS).toHaveLength(8);
  });

  it('bypasses menu on entry, fades Slide 00 opener on advance, and restores cleanly on exit', () => {
    useApp.getState().set({ screen: 'menu', layer: 'elevation', uiHidden: true });
    enterPresentation(0);

    let st = useApp.getState();
    expect(st.presentation.active).toBe(true);
    expect(st.presentation.slide).toBe(0);
    expect(st.screen).toBe('workbench');
    expect(st.uiHidden).toBe(false);
    expect(st.flyTo?.lat).toBeCloseTo(-89.4, 2);
    expect(st.flyTo?.rangeKm).toBe(280);

    stepPresentationSlide(1);
    st = useApp.getState();
    expect(st.presentation.slide).toBe(1);
    expect(st.presentation.openerFading).toBe(true);
    expect(st.presentation.orbit).toBe(true);

    exitPresentation();
    st = useApp.getState();
    expect(st.presentation.active).toBe(false);
    expect(st.screen).toBe('workbench');
    expect(st.layer).toBe('elevation');
    expect(st.playing).toBe(false);
  });

  it('orchestrates Slide 02..09 transitions, timers, and clamping cleanly', () => {
    vi.useFakeTimers();
    enterPresentation(0);

    applyPresentationSlide(2);
    expect(useApp.getState().leftSection).toBe('search');
    expect(useApp.getState().layer).toBe('slope');

    // Slide 03 zooms smoothly in 3D without triggering a 2D map load.
    applyPresentationSlide(3);
    vi.advanceTimersByTime(5000);
    expect(useApp.getState().view).toBe('3d');
    expect(useApp.getState().flyTo?.rangeKm).toBe(18);

    // Slide 04 opens Adequacy & Mathematical drawer.
    applyPresentationSlide(4);
    expect(useApp.getState().view).toBe('3d');
    expect(useApp.getState().rightSection).toBe('adequacy');
    expect(useApp.getState().mathDrawerOpen).toBe(true);
    expect(useApp.getState().pins.some((p) => p.siteId === 'CR-A')).toBe(true);

    applyPresentationSlide(5);
    expect(useApp.getState().playing).toBe(true);
    expect(useApp.getState().followPlayhead).toBe(true);

    applyPresentationSlide(6);
    expect(useApp.getState().playing).toBe(false);
    expect(useApp.getState().rightSection).toBe('horizon');
    expect(useApp.getState().layer).toBe('psrdist');

    applyPresentationSlide(9);
    stepPresentationSlide(1);
    expect(useApp.getState().presentation.slide).toBe(9);
  });

  it('activates Q&A hotkeys Alt+1 .. Alt+8 and returns to sequence on step', () => {
    enterPresentation(1);

    jumpPresentationQa(1);
    expect(useApp.getState().view).toBe('2d');
    expect(useApp.getState().presentation.qaId).toBe(1);

    jumpPresentationQa(2);
    expect(useApp.getState().view).toBe('3d');
    expect(useApp.getState().mathDrawerOpen).toBe(true);

    jumpPresentationQa(5);
    expect(useApp.getState().modal).toBe('about');

    jumpPresentationQa(6);
    expect(useApp.getState().presentation.qaPanel).toBe('baselines');
    expect(useApp.getState().modal).toBeNull();

    jumpPresentationQa(7);
    expect(useApp.getState().layer).toBe('confidence');
    expect(useApp.getState().rightSection).toBe('recap');

    jumpPresentationQa(8);
    expect(useApp.getState().presentation.qaPanel).toBe('telemetry');

    // Stepping forward resumes sequence cleanly without stale Q&A panel.
    stepPresentationSlide(1);
    expect(useApp.getState().presentation.qaId).toBeNull();
    expect(useApp.getState().presentation.qaPanel).toBeNull();
    expect(useApp.getState().presentation.slide).toBe(2);
  });

  it('isolates CR-A pins, selection, mathDrawerOpen, camera, and localStorage from normal mode', () => {
    const storeMap = new Map<string, string>();
    const mockStorage = {
      getItem: vi.fn((k: string) => storeMap.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        storeMap.set(k, v);
      }),
      removeItem: vi.fn((k: string) => {
        storeMap.delete(k);
      }),
    };
    vi.stubGlobal('localStorage', mockStorage);

    useApp.getState().set({
      screen: 'workbench',
      mode: 'forward',
      view: '3d',
      leftSection: null,
      rightSection: null,
      layer: 'none',
      selection: null,
      pins: [],
      compareIds: [],
      mathDrawerOpen: false,
      cam: { lat: -85, lon: 15, rangeKm: 120, heading: 90, tilt: 40, mPerPx: 100 },
    });
    mockStorage.setItem.mockClear();

    enterPresentation(0);
    applyPresentationSlide(4);
    applyPresentationSlide(5);
    applyPresentationSlide(9);
    jumpPresentationQa(2);

    expect(useApp.getState().pins.some((p) => p.siteId === 'CR-A')).toBe(true);
    expect(useApp.getState().selection?.siteId).toBe('CR-A');
    expect(useApp.getState().mathDrawerOpen).toBe(true);
    // Presentation Mode must never persist its CR-A pin or speed into localStorage.
    expect(mockStorage.setItem).not.toHaveBeenCalled();

    exitPresentation();

    const st = useApp.getState();
    expect(st.presentation.active).toBe(false);
    expect(st.pins).toEqual([]);
    expect(st.compareIds).toEqual([]);
    expect(st.selection).toBeNull();
    expect(st.analysis).toBeNull();
    expect(st.rightSection).toBeNull();
    expect(st.leftSection).toBeNull();
    expect(st.mathDrawerOpen).toBe(false);
    expect(st.layer).toBe('none');
    expect(st.flyTo).toMatchObject({ lat: -85, lon: 15, rangeKm: 120, heading: 90, tilt: 40, dur: 0 });
    expect(mockStorage.setItem).not.toHaveBeenCalled();
  });

  it('restores prior normal-mode user selection and pins without leaving pres-CR-A behind', () => {
    const userPin = {
      id: 'user-shk',
      siteId: 'SHK-R',
      name: 'Shackleton Rim (VAL-03)',
      lat: -89.9,
      lon: 0,
      x: 0,
      y: 3032,
      color: '#E69F00',
      addedAt: 1000,
    };
    const userSel = { siteId: 'SHK-R', name: 'Shackleton Rim (VAL-03)', lat: -89.9, lon: 0, x: 0, y: 3032 };
    useApp.getState().set({
      screen: 'workbench',
      selection: userSel,
      pins: [userPin],
      compareIds: ['user-shk'],
      rightSection: 'recap',
    });

    enterPresentation(4);
    expect(useApp.getState().pins).toHaveLength(2);
    expect(useApp.getState().selection?.siteId).toBe('CR-A');

    exitPresentation();

    const st = useApp.getState();
    expect(st.pins).toEqual([userPin]);
    expect(st.compareIds).toEqual(['user-shk']);
    expect(st.selection).toEqual(userSel);
    expect(st.rightSection).toBe('recap');
    expect(st.mathDrawerOpen).toBe(false);
  });
});
