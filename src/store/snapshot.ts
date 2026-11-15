/** PNG snapshot of the current 3D or 2D view with a provenance caption strip. */
import { useApp } from './useApp';
import { fmtUtc } from '../lib/time';
import { fmtLat, fmtLon } from '../lib/geo';

type Grabber = () => Promise<HTMLCanvasElement | null>;
export const snapshotters: { '3d'?: Grabber; '2d'?: Grabber } = {};

export async function takeSnapshot(view: '3d' | '2d') {
  const grab = snapshotters[view];
  if (!grab) return;
  const img = await grab();
  if (!img) {
    useApp.getState().notify('Snapshot failed');
    return;
  }
  const s = useApp.getState();
  const band = 34;
  const out = document.createElement('canvas');
  out.width = img.width;
  out.height = img.height + band;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#121316';
  ctx.fillRect(0, img.height, out.width, band);
  ctx.fillStyle = '#ecebe6';
  ctx.font = '14px "Atkinson Hyperlegible", system-ui, sans-serif';
  const where = s.selection ? `${s.selection.name} (${fmtLat(s.selection.lat, 3)} ${fmtLon(s.selection.lon, s.lonConvention)})` : `${fmtLat(s.cam.lat, 2)} ${fmtLon(s.cam.lon, s.lonConvention)}`;
  const r = s.resolution;
  const res = r ? ` · terrain ${r.source}, ${r.sourceM >= 1000 ? `${(r.sourceM / 1000).toFixed(1)} km` : `${r.sourceM} m`} grid${r.effectiveM != null ? `, effective ~${r.effectiveM >= 1000 ? `${(r.effectiveM / 1000).toFixed(1)} km` : `${Math.round(r.effectiveM)} m`}` : ''}${r.sigmaZ != null ? `, σz ${r.sigmaZ.toFixed(1)} m` : ''}` : '';
  ctx.fillText(`HECATE · ${fmtUtc(s.epoch)} · ${where}${res} · ${view.toUpperCase()}`, 12, img.height + 22);
  const url = out.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `hecate-${view}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  a.click();
  s.notify('Snapshot saved as PNG');
}
