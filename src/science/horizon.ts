/**
 * Local topographic horizon profiles (spec v2.0 ch. 5.1-5.2), on real LOLA terrain.
 *
 * A profile stores h_mask(phi_k) and its propagated uncertainty sigma_h(phi_k) for N equally spaced
 * azimuth bins (360 regional grid, 720 on-demand points, 1440 curated sites). Sub-bin azimuths use
 * piecewise-linear interpolation.
 *
 * Ray casting (multi-resolution, finest data first):
 *   0 - 2.5 km   : 5 m steps on the 5 m LOLA pyramid level (PDS cap / PGDA Product 78) when present
 *   2.5 - 20 km  : 80 m steps on the PGDA Product 90 adjusted 80 m DEM
 *   20 - 150 km  : 256 m then 512 m steps on the 256 m regional DEM
 * with true distance r = s_map / k (stereographic scale factor) and the curvature-corrected angle
 *   theta(r) = atan2((R + z(r)) cos psi - (R + z0), (R + z(r)) sin psi),  psi = r / R.
 * sigma_h = atan( sqrt(sigma_z0^2 + sigma_z(r_peak)^2) / r_peak ) with sigma_z from the Product 78
 * total-error map (5 m) or the Product 90 error map (regional).
 */
import { mapDirForAzimuth, polarScale } from '../lib/geo';
import { R_MOON_M, RAD, wrap360 } from '../lib/math';
import type { RegionalData } from './regional';

export interface HorizonProfile {
  n: number;
  h: Float32Array; // deg
  sigma: Float32Array; // deg
  level: '5m' | '80m';
  source: string;
}

export function hAt(p: HorizonProfile, azDeg: number): number {
  const f = (wrap360(azDeg) * p.n) / 360;
  const i0 = Math.floor(f) % p.n;
  const i1 = (i0 + 1) % p.n;
  const t = f - Math.floor(f);
  return p.h[i0] * (1 - t) + p.h[i1] * t;
}

export function sigmaAt(p: HorizonProfile, azDeg: number): number {
  const f = (wrap360(azDeg) * p.n) / 360;
  const i0 = Math.floor(f) % p.n;
  const t = f - Math.floor(f);
  return p.sigma[i0] * (1 - t) + p.sigma[(i0 + 1) % p.n] * t;
}

export function maxSigma(p: HorizonProfile): number {
  let m = 0;
  for (let i = 0; i < p.n; i++) if (p.sigma[i] > m) m = p.sigma[i];
  return m;
}

/** Max (or min) horizon elevation over the azimuth arc swept from a1 to a2 (shortest way). */
export function arcExtreme(p: HorizonProfile, a1: number, a2: number, wantMax: boolean): number {
  let d = ((a2 - a1 + 540) % 360) - 180;
  const start = d >= 0 ? a1 : a1 + d;
  d = Math.abs(d);
  const pick = wantMax ? Math.max : Math.min;
  let v = pick(hAt(p, a1), hAt(p, a2));
  const bin = 360 / p.n;
  for (let k = Math.ceil(start / bin); k <= Math.floor((start + d) / bin); k++) v = pick(v, p.h[((k % p.n) + p.n) % p.n]);
  return v;
}

export const NEAR_M = 2_500;
export const MID_M = 20_000;
export const D_MAX_M = 150_000;

/** Load the pyramid tiles a horizon cast at (x, y) needs (5 m near field, 80 m mid field). */
export async function prepareHorizon(d: RegionalData, x: number, y: number) {
  const n = NEAR_M + 120, m = MID_M + 1200;
  await Promise.all([d.pyr.ensureRect(0, x - n, y - n, x + n, y + n), d.pyr.ensureRect(4, x - m, y - m, x + m, y + m)]);
}

function stepSchedule(has5m: boolean): Float64Array {
  const s: number[] = [];
  let r = has5m ? 5 : 80;
  if (has5m) for (; r <= NEAR_M; r += 5) s.push(r);
  for (; r <= MID_M; r += 80) s.push(r);
  for (; r <= 40_000; r += 256) s.push(r);
  for (; r <= D_MAX_M; r += 512) s.push(r);
  return Float64Array.from(s);
}

/** Ray-cast a horizon profile at map point (x, y). Call prepareHorizon first. */
export function raycastHorizon(d: RegionalData, x: number, y: number, nBins: number, observerHeightM = 2): HorizonProfile {
  const pyr = d.pyr;
  const z5 = pyr.sample(0, x, y);
  const has5m = !Number.isNaN(z5);
  const z80 = pyr.sample(4, x, y);
  let z0 = has5m ? z5 : !Number.isNaN(z80) ? z80 : d.dem.sample(x, y);
  z0 += observerHeightM;
  const sp = pyr.sigma(x, y);
  const s0 = Number.isNaN(sp) ? d.err.sample(x, y) || 1 : sp;
  const k = polarScale(x, y);
  const steps = stepSchedule(has5m);
  const R = R_MOON_M;
  const h = new Float32Array(nBins).fill(-90);
  const sigma = new Float32Array(nBins);
  for (let b = 0; b < nBins; b++) {
    const [dx, dy] = mapDirForAzimuth(x, y, (b * 360) / nBins);
    let best = -90, rPeak = D_MAX_M, xPeak = x, yPeak = y;
    for (let i = 0; i < steps.length; i++) {
      const sm = steps[i];
      const px = x + sm * dx, py = y + sm * dy;
      let z = NaN;
      if (sm <= NEAR_M && has5m) z = pyr.sample(0, px, py);
      if (Number.isNaN(z) && sm <= MID_M) z = pyr.sample(4, px, py);
      if (Number.isNaN(z)) z = d.dem.sample(px, py);
      if (Number.isNaN(z)) break;
      const dist = sm / k;
      const psi = dist / R;
      const rz = R + z;
      const th = Math.atan2(rz * Math.cos(psi) - (R + z0), rz * Math.sin(psi)) * RAD;
      if (th > best) {
        best = th;
        rPeak = dist;
        xPeak = px;
        yPeak = py;
      }
    }
    h[b] = best;
    const spk = pyr.sigma(xPeak, yPeak);
    const sPeak = Number.isNaN(spk) ? d.err.sample(xPeak, yPeak) || 1 : spk;
    sigma[b] = Math.atan(Math.sqrt(s0 * s0 + sPeak * sPeak) / rPeak) * RAD;
  }
  return {
    n: nBins, h, sigma, level: has5m ? '5m' : '80m',
    source: has5m ? 'ray-cast: LOLA 5 m (≤2.5 km) + PGDA 80 m (≤20 km) + 256 m regional' : 'ray-cast: PGDA 80 m (≤20 km) + 256 m regional',
  };
}
