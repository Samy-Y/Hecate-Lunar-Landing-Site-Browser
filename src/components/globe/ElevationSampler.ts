/**
 * Terrain elevation for the 3D globe at any lat/lon, from the finest real dataset covering the point
 * (spec v2.0 sec. 3.1; 3D-mapping feedback):
 *
 *   polar pyramid  LOLA 5 m (PDS cap / PGDA Product 78) -> PGDA Product 90 80 m -> 160..640 m
 *   Level 0        LOLA global 16 / 8 / 4 ppd (equirectangular, streamed tiles)
 *
 * The pyramid level is chosen from the requested mesh spacing, never finer than the source data
 * (the mesh is not allowed to be denser than the DEM it samples - feedback item B). Tiles that are
 * not loaded yet are requested and reported through `missing`, so the tile can be rebuilt on arrival.
 * Between 80 S (rho = 300 km) and rho = 322 km the polar data blends into Level 0 (display only).
 */
import type { AppData } from '../../store/runtime';
import { latLonToPolar } from '../../lib/geo';
import { smoothstep } from '../../lib/math';
import type { PolarPyramid } from '../../data/polarPyramid';

export const POLAR_INNER_M = 296_000;
export const POLAR_OUTER_M = 318_000;

export interface SampleInfo {
  level: 'L0' | 'polar';
  k: number;
}

export class ElevationSampler {
  usePolar = true;
  private pyr: PolarPyramid;
  constructor(private data: AppData) {
    this.pyr = data.regional.pyr;
  }

  /** Pyramid level whose pixel size best matches a mesh spacing (m), clamped to available data at the point. */
  levelFor(spacingM: number): number {
    const k = Math.floor(Math.log2(Math.max(5, spacingM) / 5));
    return Math.max(0, Math.min(7, k));
  }

  /**
   * Max quadtree level justified by the data: vertex spacing must not go below the source spacing.
   * Face arc 2729 km / 32 segments / 2^L  -> L13 = 10.4 m, L14 = 5.2 m, L10 = 83 m, L6 = 1.33 km.
   */
  maxLevelAt(lat: number, lon: number, radiusM: number): number {
    if (this.usePolar && lat < -77.5) {
      const [x, y] = latLonToPolar(lat, lon);
      if (Math.hypot(x, y) < POLAR_OUTER_M + radiusM) {
        // finest level available anywhere within the node footprint (sample centre + 4 corners)
        let best = 7;
        for (const [dx, dy] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const k = this.pyr.finestAvailable(x + dx * radiusM * 0.7, y + dy * radiusM * 0.7, 0);
          if (k >= 0) best = Math.min(best, k);
        }
        return best === 0 ? 14 : best <= 3 ? 14 - best : 10;
      }
    }
    return 6;
  }

  /** Data spacing (m) at a point, for the resolution indicator. */
  sourceAt(lat: number, lon: number): { spacing: number; label: string; k: number } {
    if (this.usePolar && lat < -79.5) {
      const [x, y] = latLonToPolar(lat, lon);
      const k = this.pyr.finestAvailable(x, y, 0);
      if (k === 0) return { spacing: 5, label: 'LOLA 5 m (PDS GDR / PGDA Product 78)', k };
      if (k >= 0) return { spacing: 80, label: 'LOLA 80 m (PGDA Product 90)', k };
    }
    return { spacing: 1895, label: 'LOLA 16 ppd global (~1.9 km)', k: -1 };
  }

  elevation(lat: number, lon: number, spacingM: number, missing?: Set<string>, info?: SampleInfo): number {
    const l0 = () => (this.data.l0 ? this.data.l0.elevation(lat, lon, spacingM < 2500, missing) : 0);
    if (!this.usePolar || lat > -78.5) {
      if (info) { info.level = 'L0'; info.k = -1; }
      return l0();
    }
    const [x, y] = latLonToPolar(lat, lon);
    const rho = Math.hypot(x, y);
    if (rho >= POLAR_OUTER_M) {
      if (info) { info.level = 'L0'; info.k = -1; }
      return l0();
    }
    const want = this.levelFor(spacingM);
    let z = NaN, kk = -1;
    for (let k = want; k <= 7; k++) {
      const [tx, ty] = this.pyr.tileOf(k, x, y);
      if (!this.pyr.hasTile(k, tx, ty)) continue;
      if (!this.pyr.loaded(k, tx, ty)) {
        void this.pyr.request(k, tx, ty);
        missing?.add(`p${k}/${ty}_${tx}`);
        continue;
      }
      z = this.pyr.sample(k, x, y);
      if (!Number.isNaN(z)) {
        kk = k;
        break;
      }
    }
    if (Number.isNaN(z)) z = this.data.regional.dem.sample(x, y);
    if (Number.isNaN(z)) {
      if (info) { info.level = 'L0'; info.k = -1; }
      return l0();
    }
    if (info) { info.level = 'polar'; info.k = kk; }
    if (rho <= POLAR_INNER_M) return z;
    const w = smoothstep(POLAR_INNER_M, POLAR_OUTER_M, rho);
    return z + (l0() - z) * w;
  }
}
