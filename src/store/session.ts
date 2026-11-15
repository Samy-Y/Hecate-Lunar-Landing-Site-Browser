/** Save / open a working session (criteria, power, mode, selected sites, timing, view). */
import { useApp } from './useApp';

const KEY = 'hecate.session';

export function sessionPayload() {
  const s = useApp.getState();
  return {
    format: 'hecate-session/1',
    saved: new Date().toISOString(),
    mode: s.mode,
    view: s.view,
    presetId: s.presetId,
    criteria: s.criteria,
    power: s.power,
    slipOffsetH: s.slipOffsetH,
    epoch: s.epoch,
    selection: s.selection,
    pins: s.pins,
    compareIds: s.compareIds,
    layer: s.layer,
    globe: s.globe,
  };
}

export function saveSession(download = true) {
  const p = sessionPayload();
  const text = JSON.stringify(p, null, 2);
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* storage unavailable */
  }
  if (download) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hecate-session-${p.saved.slice(0, 16).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  useApp.getState().notify(download ? 'Session saved (file downloaded and kept in this browser)' : 'Session saved in this browser');
}

export function applySession(raw: unknown) {
  const p = raw as ReturnType<typeof sessionPayload>;
  if (!p || p.format !== 'hecate-session/1') throw new Error('Not a HECATE session file');
  useApp.setState({
    mode: p.mode, view: p.view, presetId: p.presetId, basePresetId: p.presetId && p.presetId !== 'custom' ? p.presetId : 'artemis3',
    criteria: p.criteria, power: p.power, slipOffsetH: p.slipOffsetH,
    epoch: p.epoch, selection: p.selection, pins: p.pins ?? [], compareIds: p.compareIds ?? [], layer: p.layer,
    globe: { ...useApp.getState().globe, ...p.globe }, screen: 'workbench',
  });
  useApp.getState().notify(`Session from ${p.saved.slice(0, 16).replace('T', ' ')}Z restored`);
}

export function openSessionFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      applySession(JSON.parse(await f.text()));
    } catch (e) {
      useApp.getState().notify(`Could not open session: ${(e as Error).message}`);
    }
  };
  inp.click();
}

export function restoreBrowserSession() {
  try {
    const t = localStorage.getItem(KEY);
    if (!t) {
      useApp.getState().notify('No session saved in this browser yet');
      return;
    }
    applySession(JSON.parse(t));
  } catch (e) {
    useApp.getState().notify(`Could not restore session: ${(e as Error).message}`);
  }
}
