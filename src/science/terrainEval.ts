/**
 * Terrain, hazard and data-confidence evaluation at a site on real LOLA data
 * (spec v2.0 ch. 2.1-2.2, 3.3, 6.4; feedback v2: 5 m instead of 600 m).
 *
 * 5 m coverage (PDS LOLA cap 87.5 S -> pole, PGDA Product 78 Artemis site DEMs):
 *   - bidirectional slope at L_base from central differences over +/-L/2 on the 5 m grid,
 *     converted to true distance with the stereographic scale factor;
 *   - footprint statistics over R_ellipse (fraction with alpha <= alpha_max, p95);
 *   - TRI (mean |dz| to the 8 neighbours, 3x3-averaged) at 5 m;
 *   - evidence from the real LOLA shot-count map: each L_base block is "direct" (>= 1 shot,
 *     q = 0.85) or "interpolated" (q = 0.40); f_interp is the interpolated fraction;
 *   - sigma_z from the Product 78 total-error map when present, else the Product 90 error map;
 *   - effective resolution ~ mean LOLA shot spacing in a 250 m neighbourhood.
 * Outside 5 m coverage: PGDA Product 90 adjusted 80 m DEM, slope at the 80 m baseline,
 * confidence from the LOLA shot-density model, L_base < 80 m unresolved -> UNKNOWN.
 */
import { polarScale } from '../lib/geo';
import type { Criteria } from './criteria';
import type { RegionalData } from './regional';

export interface TerrainEval {
  level: '5m' | '80m';
  source: string;
  sourceSpacingM: number;
  effectiveResM: number | null;
  p78Id: string | null;
  elev: number;
  lBaseResolved: boolean;
  slopeCenter: number;
  slopeBaselineM: number;
  slopePassFrac: number;
  slopeP95: number;
  tri: number | null;
  cpr: number;
  dPsrKm: number;
  inPsr: boolean;
  sunfracPct: number;
  qSource: number;
  fInterp: number;
  directFrac: number;
  sigmaHMax: number;
  sigmaZ: number;
  sigmaSource: string;
  footprintCells: number;
  shotDensity: number;
  notes: string[];
}

const PX = 5;

/** Load the 5 m (and 80 m) tiles needed to evaluate terrain at (x, y). */
export async function prepareTerrain(d: RegionalData, x: number, y: number, c: Criteria) {
  const r = c.ellipseR + c.lBase + 300;
  await Promise.all([d.pyr.ensureRect(0, x - r, y - r, x + r, y + r), d.pyr.ensureRect(4, x - 400, y - 400, x + 400, y + 400)]);
}

export function evaluateTerrain(d: RegionalData, x: number, y: number, c: Criteria, sigmaHMax: number): TerrainEval {
  const notes: string[] = [];
  const pyr = d.pyr;
  const W = pyr.info.W;
  const cpr = d.cpr.sample(x, y);
  const dPsrKm = d.psrDist.sample(x, y);
  const inPsr = d.psr.sample(x, y) > 0.5;
  const sunfracPct = d.illum.sample(x, y);
  const regDens = d.dens.sample(x, y);
  const regErr = d.err.sample(x, y);
  const site78 = d.manifest.sites.find((s) => s.p78 && x >= s.p78.x0 && x <= s.p78.x1 && y >= s.p78.y0 && y <= s.p78.y1)?.p78?.id ?? null;
  const z5 = pyr.sample(0, x, y);
  const k = polarScale(x, y);

  if (!Number.isNaN(z5)) {
    const z = (px: number, py: number) => pyr.sample(0, px, py);
    const slopeAt = (px: number, py: number, L: number) => {
      const h = L / 2;
      const a = z(px + h, py), b = z(px - h, py), e = z(px, py + h), f = z(px, py - h);
      if ([a, b, e, f].some(Number.isNaN)) return NaN;
      return (Math.atan(Math.hypot((a - b) / (L / k), (e - f) / (L / k))) * 180) / Math.PI;
    };
    const L = c.lBase;
    const R = c.ellipseR;
    const slopeCenter = slopeAt(x, y, L);
    const slopes: number[] = [];
    if (R > 0) {
      const step = Math.max(PX, R / 30);
      for (let dy = -R; dy <= R + 1e-6; dy += step)
        for (let dx = -R; dx <= R + 1e-6; dx += step) {
          if (dx * dx + dy * dy > R * R) continue;
          const s = slopeAt(x + dx, y + dy, L);
          if (!Number.isNaN(s)) slopes.push(s);
        }
      const expected = Math.PI * (R / step) ** 2;
      if (slopes.length < 0.9 * expected) notes.push('Landing ellipse extends beyond the 5 m coverage: footprint statistics use the covered part');
    }
    if (!slopes.length && !Number.isNaN(slopeCenter)) slopes.push(slopeCenter);
    slopes.sort((a, b) => a - b);
    const passFrac = slopes.length ? slopes.filter((s) => s <= c.slopeMax).length / slopes.length : 0;
    const p95 = slopes.length ? slopes[Math.min(slopes.length - 1, Math.floor(0.95 * (slopes.length - 1)))] : slopeCenter;

    // TRI at the 5 m pixel containing the site (3x3 average of the 8-neighbour mean |dz|).
    const cx = -W + (Math.floor((x + W) / PX) + 0.5) * PX, cy = W - (Math.floor((W - y) / PX) + 0.5) * PX;
    let triSum = 0, triN = 0;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const px = cx + j * PX, py = cy + i * PX;
        const z0 = z(px, py);
        let s = 0, n = 0;
        for (let a = -1; a <= 1; a++)
          for (let b = -1; b <= 1; b++) {
            if (!a && !b) continue;
            const v = z(px + b * PX, py + a * PX);
            if (!Number.isNaN(v)) { s += Math.abs(v - z0); n++; }
          }
        if (n) { triSum += s / n; triN++; }
      }

    // Evidence: classify every L_base block inside max(R, L) by the real LOLA shot counts.
    const block = Math.max(1, Math.round(L / PX));
    const radius = Math.max(R, L);
    const span = Math.ceil(radius / L) + 1;
    let direct = 0, interp = 0;
    for (let bi = -span; bi <= span; bi++)
      for (let bj = -span; bj <= span; bj++) {
        const ox = bj * L, oy = bi * L;
        if (radius > L ? ox * ox + oy * oy > radius * radius : bi !== 0 || bj !== 0) continue;
        let shots = 0, known = false;
        for (let a = 0; a < block; a++)
          for (let b = 0; b < block; b++) {
            const n = pyr.count(cx + ox + (b - (block - 1) / 2) * PX, cy + oy - (a - (block - 1) / 2) * PX);
            if (n >= 0) { known = true; shots += n; }
          }
        if (!known) continue;
        if (shots > 0) direct++;
        else interp++;
      }
    const tot = Math.max(1, direct + interp);
    const fInterp = interp / tot;
    // Local shot density / effective resolution in a 250 m box.
    let nShots = 0, nPix = 0;
    for (let a = -25; a <= 25; a += 1)
      for (let b = -25; b <= 25; b += 1) {
        const n = pyr.count(cx + b * PX * 2, cy + a * PX * 2);
        if (n >= 0) { nShots += n; nPix++; }
      }
    const areaKm2 = (nPix * (2 * PX) * (2 * PX)) / 1e6;
    // Every other 5 m pixel is sampled (1/4 of the pixels) over a box of area nPix * (10 m)^2.
    const density = areaKm2 > 0 ? (4 * nShots) / areaKm2 : regDens;
    const effRes = density > 0 ? 1000 / Math.sqrt(density) : null;
    const sP78 = pyr.sigma(x, y);
    const sigmaZ = Number.isNaN(sP78) ? regErr : sP78;
    if (fInterp > 0.5) notes.push(`${(fInterp * 100).toFixed(0)} % of ${L} m cells hold no LOLA shot (interpolated between tracks) — NAC stereo verification recommended`);
    if (site78) notes.push(`Terrain from PGDA Product 78 (${site78}), track-adjusted LOLA with per-pixel error map`);
    return {
      level: '5m', source: site78 ? `LOLA 5 m · PGDA Product 78 (${site78})` : 'LOLA 5 m · PDS GDR polar cap', sourceSpacingM: 5, effectiveResM: effRes, p78Id: site78,
      elev: z5, lBaseResolved: true, slopeCenter, slopeBaselineM: L, slopePassFrac: passFrac, slopeP95: p95,
      tri: triN ? triSum / triN : null, cpr, dPsrKm, inPsr, sunfracPct, qSource: (direct * 0.85 + interp * 0.4) / tot, fInterp,
      directFrac: direct / tot, sigmaHMax, sigmaZ, sigmaSource: Number.isNaN(sP78) ? 'PGDA Product 90 error map' : 'PGDA Product 78 total error', footprintCells: slopes.length, shotDensity: density, notes,
    };
  }

  // 80 m fallback (PGDA Product 90 adjusted DEM).
  const z80 = pyr.sample(4, x, y);
  const elev = Number.isNaN(z80) ? d.dem.sample(x, y) : z80;
  const zz = (px: number, py: number) => {
    const v = pyr.sample(4, px, py);
    return Number.isNaN(v) ? d.dem.sample(px, py) : v;
  };
  const h = 40;
  const slope = (Math.atan(Math.hypot((zz(x + h, y) - zz(x - h, y)) / (80 / k), (zz(x, y + h) - zz(x, y - h)) / (80 / k))) * 180) / Math.PI;
  const lambda = regDens * (c.lBase / 1000) ** 2;
  const direct = 1 - Math.exp(-lambda);
  notes.push('5 m DEM unavailable here — using the 80 m LOLA regional baseline (PGDA Product 90)');
  notes.push(`Confidence from the LOLA shot-density model: ~${regDens.toFixed(0)} shots/km² ⇒ ${(direct * 100).toFixed(0)} % of ${c.lBase} m cells would hold a direct shot`);
  return {
    level: '80m', source: 'LOLA 80 m · PGDA Product 90 (adjusted)', sourceSpacingM: 80, effectiveResM: d.effres.sample(x, y) || null, p78Id: null,
    elev, lBaseResolved: 80 <= c.lBase, slopeCenter: slope, slopeBaselineM: 80, slopePassFrac: slope <= c.slopeMax ? 1 : 0, slopeP95: slope,
    tri: null, cpr, dPsrKm, inPsr, sunfracPct, qSource: 0.85 * direct + 0.4 * (1 - direct), fInterp: 1 - direct, directFrac: direct,
    sigmaHMax, sigmaZ: regErr, sigmaSource: 'PGDA Product 90 error map', footprintCells: 1, shotDensity: regDens, notes,
  };
}
