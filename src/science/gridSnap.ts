/**
 * South-polar site and grid-cell snapping helpers shared by 2D PolarMap and 3D Globe3D.
 * Snaps pointer coordinates inside the 80S-90S cap either to a nearby curated site or to the
 * enclosing 4.75 km forward-search horizon grid cell center so clicking heatmap cells is exact.
 */
import { fmtLat, fmtLon, latLonToPolar, polarToLatLon } from '../lib/geo';
import type { AppData } from '../store/runtime';
import type { Selection } from '../store/useApp';
import type { ForwardResult } from './forwardSearch';

export interface SnappedCell {
  idx: number;
  row: number;
  col: number;
  x: number;
  y: number;
  dx: number;
  lat: number;
  lon: number;
  status: number;
  passedRank: number | null;
}

export interface PolarHoverTarget {
  lat: number;
  lon: number;
  x: number;
  y: number;
  elev: number | null;
  cell: SnappedCell | null;
  siteId: string | null;
  label: string;
}

function validCellAt(data: AppData, row: number, col: number): { idx: number; x: number; y: number } | null {
  const g = data.regional.hzGrid;
  if (row < 0 || row >= g.n || col < 0 || col >= g.n) return null;
  const idx = row * g.n + col;
  if (data.regional.hz[idx * 360] === -32768) return null;
  return {
    idx,
    x: g.x0 + (col + 0.5) * g.dx_m,
    y: g.y0 - (row + 0.5) * g.dx_m,
  };
}

/** Find the valid 4.75 km horizon grid cell containing (or closest nearby to) polar stereographic (x, y). */
export function snapToHzCell(
  data: AppData,
  forward: ForwardResult | null,
  x: number,
  y: number,
): SnappedCell | null {
  const g = data.regional.hzGrid;
  const col0 = Math.floor((x - g.x0) / g.dx_m);
  const row0 = Math.floor((g.y0 - y) / g.dx_m);
  let best = validCellAt(data, row0, col0);
  if (!best) {
    let bestD = g.dx_m * 0.95;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const cand = validCellAt(data, row0 + dr, col0 + dc);
        if (!cand) continue;
        const d = Math.hypot(cand.x - x, cand.y - y);
        if (d < bestD) {
          bestD = d;
          best = cand;
        }
      }
    }
  }
  if (!best) return null;
  const row = Math.floor(best.idx / g.n);
  const col = best.idx % g.n;
  const [lat, lon] = polarToLatLon(best.x, best.y);
  const status = forward ? forward.status[best.idx] : 255;
  let passedRank: number | null = null;
  if (forward && (status === 1 || status === 2)) {
    const pos = forward.passed.findIndex((p) => p.idx === best!.idx);
    if (pos >= 0) passedRank = pos + 1;
  }
  return { idx: best.idx, row, col, x: best.x, y: best.y, dx: g.dx_m, lat, lon, status, passedRank };
}

function elevationAtBest(data: AppData, x: number, y: number): number | null {
  const [zp] = data.regional.pyr.sampleBest(x, y, 0);
  const zr = Number.isNaN(zp) ? data.regional.dem.sample(x, y) : zp;
  return Number.isNaN(zr) ? null : zr;
}

/** Resolve a South-Pole hover or click target in stereographic coords, honoring curated sites and cell snapping. */
export function resolvePolarSelection(
  data: AppData,
  forward: ForwardResult | null,
  x: number,
  y: number,
  opts: { siteSnapM: number; snapCells: boolean; lonConvention: '360' | '180' },
): { selection: Selection; cell: SnappedCell | null } | null {
  const site = data.manifest.sites.find((q) => Math.hypot(q.x - x, q.y - y) < opts.siteSnapM);
  const cell = opts.snapCells ? snapToHzCell(data, forward, site ? site.x : x, site ? site.y : y) : null;
  if (site) {
    return {
      selection: { x: site.x, y: site.y, lat: site.lat, lon: site.lon, siteId: site.id, name: site.name },
      cell,
    };
  }
  if (cell) {
    const name = cell.passedRank != null && cell.passedRank <= 12
      ? `Candidate #${cell.passedRank}`
      : `Cell r${cell.row}·c${cell.col}`;
    return {
      selection: { x: cell.x, y: cell.y, lat: cell.lat, lon: cell.lon, siteId: null, name },
      cell,
    };
  }
  if (Number.isNaN(data.regional.dem.sample(x, y))) return null;
  const [lat, lon] = polarToLatLon(x, y);
  return {
    selection: {
      x,
      y,
      lat,
      lon,
      siteId: null,
      name: `${fmtLat(lat, 3)} ${fmtLon(lon, opts.lonConvention)}`,
    },
    cell: null,
  };
}

/** Compute hover telemetry for 2D/3D cursor display including optional cell snap highlight. */
export function resolvePolarHover(
  data: AppData,
  forward: ForwardResult | null,
  lat: number,
  lon: number,
  elevFallback: number | null,
  opts: { siteSnapM: number; snapCells: boolean; lonConvention: '360' | '180' },
): PolarHoverTarget {
  if (lat > -79.9) {
    return { lat, lon, x: 0, y: 0, elev: elevFallback, cell: null, siteId: null, label: '' };
  }
  const [x, y] = latLonToPolar(lat, lon);
  const resolved = resolvePolarSelection(data, forward, x, y, opts);
  if (!resolved) {
    return { lat, lon, x, y, elev: elevFallback ?? elevationAtBest(data, x, y), cell: null, siteId: null, label: '' };
  }
  const s = resolved.selection;
  const elev = elevationAtBest(data, s.x, s.y) ?? elevFallback;
  const label = s.siteId ? `${s.siteId} · ${s.name}` : resolved.cell ? s.name : '';
  return { lat: s.lat, lon: s.lon, x: s.x, y: s.y, elev, cell: resolved.cell, siteId: s.siteId, label };
}
