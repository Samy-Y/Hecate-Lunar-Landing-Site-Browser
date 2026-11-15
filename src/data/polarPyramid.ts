/**
 * South-polar terrain pyramid (real LOLA data, feedback v2: 5 m instead of 600 m).
 *
 * Tiling on the polar stereographic plane, square [-W, W] with W = 327 680 m:
 *   level k  pixel p_k = 5 * 2^k m  (k = 0..7 -> 5 m ... 640 m), tile = 512 px (+1 px apron).
 *   tile (tx, ty) covers x in [-W + tx*512*p, ...), y in (W - (ty+1)*512*p, W - ty*512*p].
 *   pixel centre (i, j) of tile: x = -W + (tx*512 + i + 0.5) p,  y = W - (ty*512 + j + 0.5) p.
 *
 * Sources (pipeline/build_polar.py): k = 0 from the PDS LOLA 5 m cap (87.5 S -> pole) with the
 * PGDA Product 78 5 m site DEMs blended in; k = 1-3 are block means of k = 0; k = 4 is the PGDA
 * Product 90 adjusted 80 m DEM; k = 5-7 are block means of k = 4. Nothing is upsampled.
 * Elevation tiles are int16 at 0.5 m/LSB above R = 1 737.4 km (nodata -32768). Level-0 tiles also
 * carry the LOLA shot count per 5 m pixel ('cnt', uint8) and, where Product 78 exists, the total
 * vertical uncertainty ('sig', uint8, 0.1 m/LSB, 255 = none).
 */
import { fetchBuffer, DATA_ROOT } from './fetchBin';

export interface PolarInfo {
  W: number;
  tile: number;
  apron: number;
  scale: number;
  nodata: number;
  levels: { k: number; px: number; source: string; tiles: string[] }[];
  layers: { cnt: number[]; sig: number[] };
  path: string; // e.g. "polar/{layer}/{k}/{ty}_{tx}.bin.gz"
}

type Layer = 'dem' | 'cnt' | 'sig';

export class PolarPyramid {
  readonly avail: Set<string>[];
  private dem = new Map<string, Int16Array>();
  private cnt = new Map<string, Uint8Array>();
  private sig = new Map<string, Uint8Array>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<(k: number, key: string) => void>();
  private lru: string[] = [];
  readonly N: number;
  maxTiles = 260;

  constructor(readonly info: PolarInfo) {
    this.avail = info.levels.map((l) => new Set(l.tiles));
    this.N = info.tile + 2 * info.apron;
  }

  px(k: number) {
    return 5 * 2 ** k;
  }
  tileSpan(k: number) {
    return this.info.tile * this.px(k);
  }
  tileOf(k: number, x: number, y: number): [number, number] {
    const s = this.tileSpan(k);
    return [Math.floor((x + this.info.W) / s), Math.floor((this.info.W - y) / s)];
  }
  key(_k: number, tx: number, ty: number) {
    return `${ty}_${tx}`;
  }
  hasTile(k: number, tx: number, ty: number) {
    return this.avail[k]?.has(this.key(k, tx, ty)) ?? false;
  }
  /** Finest level >= minK with a tile covering (x, y). */
  finestAvailable(x: number, y: number, minK = 0): number {
    for (let k = minK; k < this.avail.length; k++) {
      const [tx, ty] = this.tileOf(k, x, y);
      if (this.hasTile(k, tx, ty)) return k;
    }
    return -1;
  }
  onTile(fn: (k: number, key: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private url(layer: Layer, k: number, key: string) {
    return DATA_ROOT + this.info.path.replace('{layer}', layer).replace('{k}', String(k)).replace('{key}', key);
  }

  loaded(k: number, tx: number, ty: number) {
    return this.dem.has(`${k}/${this.key(k, tx, ty)}`);
  }

  /** Load one tile (dem + cnt/sig where defined). Resolves when present or unavailable. */
  request(k: number, tx: number, ty: number): Promise<void> {
    const key = this.key(k, tx, ty);
    const id = `${k}/${key}`;
    if (!this.hasTile(k, tx, ty) || this.dem.has(id)) return Promise.resolve();
    const inflight = this.inflight.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const jobs: Promise<void>[] = [fetchBuffer(this.url('dem', k, key)).then((b) => void this.dem.set(id, new Int16Array(b)))];
        if (this.info.layers.cnt.includes(k)) jobs.push(fetchBuffer(this.url('cnt', k, key)).then((b) => void this.cnt.set(id, new Uint8Array(b))).catch(() => void 0));
        if (this.info.layers.sig.includes(k)) jobs.push(fetchBuffer(this.url('sig', k, key)).then((b) => void this.sig.set(id, new Uint8Array(b))).catch(() => void 0));
        await Promise.all(jobs);
        this.lru.push(id);
        this.evict();
        for (const l of this.listeners) l(k, key);
      } catch {
        /* network error: leave unloaded, may be retried */
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, p);
    return p;
  }

  private evict() {
    while (this.lru.length > this.maxTiles) {
      const id = this.lru.shift()!;
      this.dem.delete(id);
      this.cnt.delete(id);
      this.sig.delete(id);
    }
  }

  /** Load every available level-k tile intersecting the rectangle. */
  async ensureRect(k: number, x0: number, y0: number, x1: number, y1: number) {
    const [ta, tb] = this.tileOf(k, Math.min(x0, x1), Math.max(y0, y1));
    const [tc, td] = this.tileOf(k, Math.max(x0, x1), Math.min(y0, y1));
    const jobs: Promise<void>[] = [];
    for (let ty = tb; ty <= td; ty++) for (let tx = ta; tx <= tc; tx++) jobs.push(this.request(k, tx, ty));
    await Promise.all(jobs);
  }

  private raw(layer: Layer, k: number, x: number, y: number): { arr: ArrayLike<number>; c: number; r: number } | null {
    const p = this.px(k);
    const gx = (x + this.info.W) / p - 0.5;
    const gy = (this.info.W - y) / p - 0.5;
    const tx = Math.floor((gx + 0.5) / this.info.tile), ty = Math.floor((gy + 0.5) / this.info.tile);
    const id = `${k}/${ty}_${tx}`;
    const arr = layer === 'dem' ? this.dem.get(id) : layer === 'cnt' ? this.cnt.get(id) : this.sig.get(id);
    if (!arr) return null;
    return { arr, c: gx - tx * this.info.tile + this.info.apron, r: gy - ty * this.info.tile + this.info.apron };
  }

  /** Bilinear elevation (m) at level k, NaN when the tile is not loaded or has no data. */
  sample(k: number, x: number, y: number): number {
    const t = this.raw('dem', k, x, y);
    if (!t) return NaN;
    const N = this.N;
    const c0 = Math.max(0, Math.min(N - 2, Math.floor(t.c))), r0 = Math.max(0, Math.min(N - 2, Math.floor(t.r)));
    const fx = t.c - c0, fy = t.r - r0;
    const a = t.arr as Int16Array;
    const i = r0 * N + c0;
    const v00 = a[i], v01 = a[i + 1], v10 = a[i + N], v11 = a[i + N + 1];
    const nd = this.info.nodata;
    if (v00 === nd || v01 === nd || v10 === nd || v11 === nd) {
      const n = Math.round(t.r) * N + Math.round(t.c);
      return a[n] === nd ? NaN : a[n] * this.info.scale;
    }
    return ((v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy) * this.info.scale;
  }

  /** Elevation from the finest *loaded* level in [kMin, kMax]; returns [z, k] or [NaN, -1]. */
  sampleBest(x: number, y: number, kMin: number, kMax = this.avail.length - 1): [number, number] {
    for (let k = kMin; k <= kMax; k++) {
      const z = this.sample(k, x, y);
      if (!Number.isNaN(z)) return [z, k];
    }
    return [NaN, -1];
  }

  /** LOLA shot count of the level-0 pixel containing (x, y); -1 when unknown. */
  count(x: number, y: number): number {
    const t = this.raw('cnt', 0, x, y);
    if (!t) return -1;
    return t.arr[Math.round(t.r) * this.N + Math.round(t.c)];
  }

  /** Product 78 total vertical uncertainty (m) of the level-0 pixel; NaN when not available. */
  sigma(x: number, y: number): number {
    const t = this.raw('sig', 0, x, y);
    if (!t) return NaN;
    const v = t.arr[Math.round(t.r) * this.N + Math.round(t.c)];
    return v === 255 ? NaN : v * 0.1;
  }

  /** Raw tile access (for mosaicking / hillshades). */
  tile(k: number, tx: number, ty: number): Int16Array | undefined {
    return this.dem.get(`${k}/${this.key(k, tx, ty)}`);
  }
}
