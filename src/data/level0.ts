/**
 * Level 0 global terrain store (90N-90S) - multiresolution, streamed:
 *   4 ppd  (~7.6 km)  loaded at start     -> first paint
 *   8 ppd  (~3.8 km)  loaded in background -> mid zoom + GPU cast-shadow DEM
 *   16 ppd (~1.9 km)  32 tiles of 720^2, fetched on demand by the globe LOD
 * Coarser levels are block means of 16 ppd, so the finest loaded level always wins.
 */
import { fetchBuffer, DATA_ROOT } from './fetchBin';
import type { Level0Info } from './types';
import { wrap360 } from '../lib/math';

export class Level0Store {
  dem4: Int16Array | null = null;
  dem8: Int16Array | null = null;
  readonly tiles = new Map<string, Int16Array>();
  private inflight = new Set<string>();
  private listeners = new Set<(key: string) => void>();
  readonly scale: number;
  constructor(public readonly info: Level0Info) {
    this.scale = info.elevation_scale_m;
  }

  onTile(fn: (key: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async loadGlobal(ppd: 4 | 8) {
    const lv = this.info.levels[`${ppd}ppd`];
    const a = new Int16Array(await fetchBuffer(DATA_ROOT + lv.path));
    if (ppd === 4) this.dem4 = a;
    else this.dem8 = a;
    for (const l of this.listeners) l(`global${ppd}`);
  }

  tileKey(lat: number, lon: number): string {
    const t = this.info.tiles16;
    const row = Math.min(t.rows - 1, Math.max(0, Math.floor(((90 - lat) * t.ppd) / t.tile)));
    const col = Math.min(t.cols - 1, Math.max(0, Math.floor(((wrap360(lon + 180)) * t.ppd) / t.tile)));
    return `r${row}_c${col}`;
  }

  requestTile(key: string) {
    if (this.tiles.has(key) || this.inflight.has(key)) return;
    this.inflight.add(key);
    const [r, c] = key.slice(1).split('_c');
    const url = DATA_ROOT + this.info.tiles16.path.replace('{row}', r).replace('{col}', c);
    fetchBuffer(url)
      .then((buf) => {
        this.tiles.set(key, new Int16Array(buf));
        for (const l of this.listeners) l(key);
      })
      .catch(() => void 0)
      .finally(() => this.inflight.delete(key));
  }

  /** Bilinear sample of a global equirectangular level (wraps longitude). */
  private sampleGlobal(a: Int16Array, ppd: number, lat: number, lon: number): number {
    const W = 360 * ppd, H = 180 * ppd;
    const px = wrap360(lon + 180) * ppd - 0.5;
    const py = Math.min(H - 1, Math.max(0, (90 - lat) * ppd - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
    const y1 = Math.min(H - 1, y0 + 1);
    const v = (a[y0 * W + xa] * (1 - fx) + a[y0 * W + xb] * fx) * (1 - fy) + (a[y1 * W + xa] * (1 - fx) + a[y1 * W + xb] * fx) * fy;
    return v * this.scale;
  }

  /**
   * Elevation (m above R_moon) at lat/lon from the finest available level.
   * `want16` requests the 16 ppd tile when missing; `missing` collects keys still in flight.
   */
  elevation(lat: number, lon: number, want16 = false, missing?: Set<string>): number {
    if (want16) {
      const key = this.tileKey(lat, lon);
      const tile = this.tiles.get(key);
      if (tile) {
        const t = this.info.tiles16;
        const n = t.tile + 2 * t.apron;
        const [r, c] = key.slice(1).split('_c').map(Number);
        const px = wrap360(lon + 180) * t.ppd - c * t.tile - 0.5 + t.apron;
        const py = (90 - lat) * t.ppd - r * t.tile - 0.5 + t.apron;
        const x0 = Math.min(n - 2, Math.max(0, Math.floor(px))), y0 = Math.min(n - 2, Math.max(0, Math.floor(py)));
        const fx = Math.min(1, Math.max(0, px - x0)), fy = Math.min(1, Math.max(0, py - y0));
        const i = y0 * n + x0;
        const v = (tile[i] * (1 - fx) + tile[i + 1] * fx) * (1 - fy) + (tile[i + n] * (1 - fx) + tile[i + n + 1] * fx) * fy;
        return v * this.scale;
      }
      this.requestTile(key);
      missing?.add(key);
    }
    if (this.dem8) return this.sampleGlobal(this.dem8, 8, lat, lon);
    if (this.dem4) return this.sampleGlobal(this.dem4, 4, lat, lon);
    return 0;
  }
}
