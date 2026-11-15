/** Typed view of public/data/manifest.json (schema hecate-data/3, real NASA data). */
import type { PolarInfo } from './polarPyramid';

export interface GridSpec {
  half_width_m: number;
  n: number;
  cx: number;
  cy: number;
  dx_m: number;
  x0: number;
  y0: number;
}

export interface FileEntry {
  path: string;
  dtype: 'int16' | 'uint16' | 'uint8' | 'float32';
  shape: number[];
  scale: number;
  offset: number;
  nodata: number | null;
  description: string;
  bytes: number;
  bytes_gz: number;
  grid?: string;
  source?: string;
}

export interface SiteDef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  x: number;
  y: number;
  kind: string;
  provenance: string;
  /** True if real 5 m LOLA terrain covers the site (PDS cap or PGDA Product 78). */
  has5m: boolean;
  /** PGDA Product 78 site DEM covering the site, if any (polar stereographic box). */
  p78?: { id: string; x0: number; y0: number; x1: number; y1: number };
}

export interface Level0Info {
  source: string;
  source_url: string;
  reference_radius_m: number;
  elevation_scale_m: number;
  effective_resolution_m: number;
  levels: Record<string, { path: string; shape: [number, number]; ppd: number; scale: number; bytes_gz: number }>;
  tiles16: { path: string; rows: number; cols: number; tile: number; apron: number; ppd: number; scale: number; bytes_gz_total: number };
  imagery: Record<string, { path: string; size: [number, number]; bytes: number }>;
}

export interface RegistryEntry {
  name: string;
  role: string;
  source: string;
  resolution: string;
  url?: string;
}

export interface Manifest {
  schema: string;
  generator: string;
  frame: string;
  radius_m: number;
  projection: string;
  provenance_short: string;
  registry: RegistryEntry[];
  grids: { reg: GridSpec; ana: GridSpec; hz: GridSpec };
  horizon: { observer_height_m: number; d_max_m: number; regional_bins: number; site_bins: number };
  polar: PolarInfo;
  sites: SiteDef[];
  named_craters: { name: string; lat: number; lon: number; d_km: number }[];
  files: Record<string, FileEntry>;
  level0?: Level0Info;
}

export type NumArray = Float32Array | Int16Array | Uint16Array | Uint8Array;

/** Raw regional payload shared between the main thread and the engine worker. */
export interface RegionalRaw {
  reg_dem: Float32Array; // m, 256 m grid
  ana_slope: Float32Array; // deg (80 m baseline), 512 m grid
  ana_psr: Float32Array; // PSR area fraction 0-1
  ana_psrdist: Float32Array; // km
  ana_illum: Float32Array; // average Sun visibility %
  ana_cpr: Float32Array; // Mini-RF CPR
  ana_dens: Float32Array; // LOLA shots / km^2
  ana_err: Float32Array; // vertical uncertainty sigma_z (m)
  ana_effres: Float32Array; // effective resolution (m)
  hz_grid: Int16Array; // 0.01 deg, [row][col][az]
  hz_sigmax: Float32Array; // deg
  site_horizons: Int16Array; // [site][2][1440]
}
