/** In-memory South-Pole dataset used by the science engine (worker) and the 2D map (real LOLA data). */
import { Grid } from '../data/Grid';
import { PolarPyramid } from '../data/polarPyramid';
import type { GridSpec, Manifest, RegionalRaw } from '../data/types';

export interface RegionalData {
  manifest: Manifest;
  /** 256 m regional DEM (PGDA Product 90, block mean of the adjusted 80 m map). */
  dem: Grid;
  /** 512 m analysis rasters. */
  slope: Grid;
  psr: Grid;
  psrDist: Grid;
  illum: Grid;
  cpr: Grid;
  dens: Grid;
  err: Grid;
  effres: Grid;
  hz: Int16Array;
  hzSig: Float32Array;
  hzGrid: GridSpec;
  siteHz: Int16Array;
  /** Streaming 5 m -> 640 m polar pyramid. */
  pyr: PolarPyramid;
}

export function buildRegional(manifest: Manifest, raw: RegionalRaw): RegionalData {
  const g = manifest.grids;
  return {
    manifest,
    dem: new Grid(raw.reg_dem, g.reg),
    slope: new Grid(raw.ana_slope, g.ana),
    psr: new Grid(raw.ana_psr, g.ana),
    psrDist: new Grid(raw.ana_psrdist, g.ana),
    illum: new Grid(raw.ana_illum, g.ana),
    cpr: new Grid(raw.ana_cpr, g.ana),
    dens: new Grid(raw.ana_dens, g.ana),
    err: new Grid(raw.ana_err, g.ana),
    effres: new Grid(raw.ana_effres, g.ana),
    hz: raw.hz_grid,
    hzSig: raw.hz_sigmax,
    hzGrid: g.hz,
    siteHz: raw.site_horizons,
    pyr: new PolarPyramid(manifest.polar),
  };
}

/** Best available elevation at (x, y): pyramid (finest loaded >= kMin) then the 256 m regional DEM. */
export function elevationAt(d: RegionalData, x: number, y: number, kMin = 0): number {
  const [z] = d.pyr.sampleBest(x, y, kMin);
  return Number.isNaN(z) ? d.dem.sample(x, y) : z;
}
