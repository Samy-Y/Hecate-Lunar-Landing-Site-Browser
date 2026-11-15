/** Assemble a square DEM mosaic from the polar pyramid (finest level first, regional fallback). */
import type { PolarPyramid } from './polarPyramid';
import type { Grid } from './Grid';
import type { GridSpec } from './types';

export const NODATA_SENTINEL = -30000;

export interface Mosaic {
  data: Float32Array;
  grid: GridSpec;
  k: number;
}

/** Pyramid level whose pixel matches a target texel size (m). */
export function levelForTexel(texelM: number) {
  return Math.max(0, Math.min(7, Math.floor(Math.log2(Math.max(5, texelM) / 5))));
}

export async function buildMosaic(pyr: PolarPyramid, regional: Grid, cx: number, cy: number, k: number, n: number): Promise<Mosaic> {
  const dx = 5 * 2 ** k;
  const W = pyr.info.W;
  // snap to the level-k pixel lattice so mosaic texels coincide with DEM pixels
  const x0 = -W + Math.round((cx - (n * dx) / 2 + W) / dx) * dx;
  const yTop = W - Math.round((W - (cy + (n * dx) / 2)) / dx) * dx;
  const width = n * dx;
  await pyr.ensureRect(k, x0, yTop - width, x0 + width, yTop);
  if (k < 4) await pyr.ensureRect(4, x0, yTop - width, x0 + width, yTop);
  const data = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    const y = yTop - (r + 0.5) * dx;
    for (let c = 0; c < n; c++) {
      const x = x0 + (c + 0.5) * dx;
      let z = pyr.sample(k, x, y);
      if (Number.isNaN(z)) z = pyr.sampleBest(x, y, Math.max(k + 1, 4))[0];
      if (Number.isNaN(z)) z = regional.sample(x, y);
      data[r * n + c] = Number.isNaN(z) ? NODATA_SENTINEL : z;
    }
  }
  return { data, grid: { half_width_m: width / 2, n, cx: x0 + width / 2, cy: yTop - width / 2, dx_m: dx, x0, y0: yTop }, k };
}
