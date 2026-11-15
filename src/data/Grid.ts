/**
 * Regular raster on the south polar stereographic plane.
 * Pixel (col,row) centre: x = x0 + (col + .5) dx, y = y0 - (row + .5) dx  (row 0 = top / +Y).
 */
import type { GridSpec } from './types';

export class Grid {
  readonly n: number;
  constructor(public readonly data: ArrayLike<number>, public readonly g: GridSpec) {
    this.n = g.n;
  }

  /** Fractional (col,row) of a map point. */
  colRow(x: number, y: number): [number, number] {
    return [(x - this.g.x0) / this.g.dx_m - 0.5, (this.g.y0 - y) / this.g.dx_m - 0.5];
  }

  /** Bilinear sample, NaN outside the grid. */
  sample(x: number, y: number): number {
    const c = (x - this.g.x0) / this.g.dx_m - 0.5;
    const r = (this.g.y0 - y) / this.g.dx_m - 0.5;
    const n = this.n;
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0 || c0 >= n - 1 || r0 >= n - 1) return NaN;
    const fx = c - c0;
    const fy = r - r0;
    const i = r0 * n + c0;
    const d = this.data;
    const a = d[i] * (1 - fx) + d[i + 1] * fx;
    const b = d[i + n] * (1 - fx) + d[i + n + 1] * fx;
    return a * (1 - fy) + b * fy;
  }

  nearest(x: number, y: number): number {
    const c = Math.round((x - this.g.x0) / this.g.dx_m - 0.5);
    const r = Math.round((this.g.y0 - y) / this.g.dx_m - 0.5);
    if (c < 0 || r < 0 || c >= this.n || r >= this.n) return NaN;
    return this.data[r * this.n + c];
  }

  contains(x: number, y: number, margin = 0): boolean {
    const h = this.g.half_width_m - margin;
    return Math.abs(x - this.g.cx) <= h && Math.abs(y - this.g.cy) <= h;
  }

  /** Distance (m) from (x,y) to the nearest grid edge (negative outside). */
  edgeDistance(x: number, y: number): number {
    return this.g.half_width_m - Math.max(Math.abs(x - this.g.cx), Math.abs(y - this.g.cy));
  }

  cellCenter(col: number, row: number): [number, number] {
    return [this.g.x0 + (col + 0.5) * this.g.dx_m, this.g.y0 - (row + 0.5) * this.g.dx_m];
  }
}

/** Horn (3x3 Sobel) slope in degrees for a full grid. */
export function hornSlope(dem: ArrayLike<number>, n: number, dx: number): Float32Array {
  const out = new Float32Array(n * n);
  const at = (r: number, c: number) => dem[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = at(r - 1, c - 1), b = at(r - 1, c), cc = at(r - 1, c + 1);
      const d = at(r, c - 1), f = at(r, c + 1);
      const g = at(r + 1, c - 1), h = at(r + 1, c), i = at(r + 1, c + 1);
      const gx = (cc + 2 * f + i - (a + 2 * d + g)) / (8 * dx);
      const gy = (g + 2 * h + i - (a + 2 * b + cc)) / (8 * dx);
      out[r * n + c] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }
  }
  return out;
}
