/**
 * Raster layer rendering shared by the 2D polar map and the 3D globe overlay.
 * Every layer is a canvas in the south polar stereographic plane plus its map rectangle.
 * Palettes: viridis / inferno (perceptually uniform, colour-vision-deficiency safe) and the
 * Okabe-Ito categorical set for feasibility, always paired with geometric badges in the UI.
 */
import type { AppData } from '../../store/runtime';
import type { AppState, LayerId } from '../../store/useApp';
import type { GridSpec } from '../../data/types';

export interface LayerRaster {
  canvas: HTMLCanvasElement;
  rect: { x0: number; yTop: number; width: number };
  smooth: boolean;
}

export interface LegendSpec {
  title: string;
  kind: 'ramp' | 'cats';
  stops?: string;
  min?: string;
  max?: string;
  cats?: { color: string; label: string; badge?: string }[];
  note?: string;
}

type RGB = [number, number, number];
const poly = (c: number[][], t: number): RGB => {
  const r = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let v = c[6][k];
    for (let i = 5; i >= 0; i--) v = c[i][k] + t * v;
    r[k] = Math.max(0, Math.min(1, v)) * 255;
  }
  return r as RGB;
};
const VIRIDIS = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
];
const INFERNO = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];
export const viridis = (t: number) => poly(VIRIDIS, Math.max(0, Math.min(1, t)));
export const inferno = (t: number) => poly(INFERNO, Math.max(0, Math.min(1, t)));
const css = (fn: (t: number) => RGB) =>
  `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `rgb(${fn(t).map(Math.round).join(',')}) ${t * 100}%`).join(', ')})`;
export const VIRIDIS_CSS = css(viridis);
export const INFERNO_CSS = css(inferno);

export const OKABE = { pass: '#009E73', unknown: '#E69F00', fail: '#D55E00', sky: '#56B4E9', blue: '#0072B2', yellow: '#F0E442', purple: '#CC79A7' };
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function canvasFor(n: number) {
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  return c;
}

function paint(n: number, fn: (i: number) => [number, number, number, number] | null) {
  const c = canvasFor(n);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = fn(i);
    if (!v) continue;
    img.data[i * 4] = v[0];
    img.data[i * 4 + 1] = v[1];
    img.data[i * 4 + 2] = v[2];
    img.data[i * 4 + 3] = v[3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const rectOf = (g: GridSpec) => ({ x0: g.x0, yTop: g.y0, width: g.n * g.dx_m });

/** Multi-directional hillshade (static) used as the 2D base map. */
export function hillshade(dem: ArrayLike<number>, n: number, dx: number, zf = 2.5): HTMLCanvasElement {
  const c = canvasFor(n);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const at = (r: number, q: number) => dem[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, q))];
  const lights = [[315, 40, 0.5], [270, 45, 0.25], [0, 45, 0.25]].map(([az, el, w]) => [(az * Math.PI) / 180, (el * Math.PI) / 180, w]);
  for (let r = 0; r < n; r++) {
    for (let q = 0; q < n; q++) {
      const gx = ((at(r - 1, q + 1) + 2 * at(r, q + 1) + at(r + 1, q + 1)) - (at(r - 1, q - 1) + 2 * at(r, q - 1) + at(r + 1, q - 1))) / (8 * dx) * zf;
      const gy = ((at(r + 1, q - 1) + 2 * at(r + 1, q) + at(r + 1, q + 1)) - (at(r - 1, q - 1) + 2 * at(r - 1, q) + at(r - 1, q + 1))) / (8 * dx) * zf;
      const slope = Math.atan(Math.hypot(gx, gy));
      const aspect = Math.atan2(gy, -gx);
      let v = 0;
      for (const [az, el, w] of lights) v += w * Math.max(0, Math.sin(el) * Math.cos(slope) + Math.cos(el) * Math.sin(slope) * Math.cos(az - aspect));
      const g = Math.round(28 + 200 * Math.pow(v, 0.9));
      const i = (r * n + q) * 4;
      img.data[i] = g;
      img.data[i + 1] = g;
      img.data[i + 2] = Math.min(255, g + 4);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const cache = new Map<string, LayerRaster>();
let baseCache: { reg: LayerRaster } | null = null;

/** Static multi-directional hillshade of the 320 m regional LOLA DEM (2D base at overview scales). */
export function baseLayers(data: AppData) {
  if (!baseCache) {
    const g = data.regional.dem;
    const d = Float32Array.from(g.data as ArrayLike<number>, (v) => (Number.isNaN(v) ? 0 : v));
    baseCache = { reg: { canvas: hillshade(d, g.n, g.g.dx_m), rect: rectOf(g.g), smooth: true } };
  }
  return baseCache;
}

/** Hillshade canvas for one pyramid tile (512 px core), cached by key. */
const tileShadeCache = new Map<string, HTMLCanvasElement>();
export function tileHillshade(key: string, tile: Int16Array, n: number, dx: number, nodata: number, scale: number): HTMLCanvasElement {
  const hit = tileShadeCache.get(key);
  if (hit) return hit;
  const f = new Float32Array(n * n);
  for (let i = 0; i < f.length; i++) f[i] = tile[i] === nodata ? 0 : tile[i] * scale;
  const full = hillshade(f, n, dx, dx < 20 ? 1.2 : 2);
  const c = canvasFor(n - 2);
  c.getContext('2d')!.drawImage(full, -1, -1);
  if (tileShadeCache.size > 400) tileShadeCache.delete(tileShadeCache.keys().next().value as string);
  tileShadeCache.set(key, c);
  return c;
}

/** Build (cached) the overlay raster for a layer id given current state. */
export function buildLayer(id: LayerId, data: AppData, s: AppState): { raster: LayerRaster | null; legend: LegendSpec | null } {
  const reg = data.regional;
  const ga = reg.slope.g;
  const c = s.criteria;
  const key = (() => {
    switch (id) {
      case 'slope': return `slope|${c.slopeMax}`;
      case 'confidence': return `conf|${c.lBase}`;
      case 'sunNow': case 'earthNow': return `${id}|${s.instant?.utcMs ?? 0}|${c.earthMinEl}`;
      case 'fsStatus': case 'fsSuit': case 'fsConf': case 'fsAvail': return `${id}|${s.forward ? `${s.forward.tLand}|${s.forward.ms.thresholds}|${s.forward.counts.fail}` : 0}`;
      default: return id;
    }
  })();
  const legend = legendFor(id, s);
  if (id === 'none' || id === 'illum') return { raster: null, legend };
  const hit = cache.get(key);
  if (hit) return { raster: hit, legend };
  let raster: LayerRaster | null = null;
  const na = ga.n;
  const ok = (v: number) => !Number.isNaN(v);
  switch (id) {
    case 'elevation': {
      const g = reg.dem;
      const d = g.data;
      raster = { canvas: paint(g.n, (i) => (ok(d[i]) ? [...viridis((d[i] + 5000) / 12000), 255] : null)), rect: rectOf(g.g), smooth: true };
      break;
    }
    case 'slope': {
      const d = reg.slope.data;
      const sm = c.slopeMax;
      const f = hex(OKABE.fail);
      raster = { canvas: paint(na, (i) => (!ok(d[i]) ? null : d[i] <= sm ? [...viridis(0.15 + 0.85 * (d[i] / sm)), 235] : [f[0], f[1], f[2], 235])), rect: rectOf(ga), smooth: true };
      break;
    }
    case 'psr': {
      const d = reg.psr.data;
      const b = hex(OKABE.blue);
      raster = { canvas: paint(na, (i) => (d[i] > 0.02 ? [b[0], b[1], b[2], Math.round(90 + 165 * Math.min(1, d[i]))] : null)), rect: rectOf(ga), smooth: false };
      break;
    }
    case 'sunfrac': {
      const d = reg.illum.data;
      raster = { canvas: paint(na, (i) => (ok(d[i]) ? [...inferno(d[i] / 60), 235] : null)), rect: rectOf(ga), smooth: true };
      break;
    }
    case 'psrdist': {
      const d = reg.psrDist.data;
      raster = { canvas: paint(na, (i) => (ok(d[i]) ? [...viridis(1 - Math.min(1, d[i] / 20)), 225] : null)), rect: rectOf(ga), smooth: true };
      break;
    }
    case 'cpr': {
      const d = reg.cpr.data;
      raster = { canvas: paint(na, (i) => (ok(d[i]) ? [...viridis((d[i] - 0.25) / 0.8), 230] : null)), rect: rectOf(ga), smooth: true };
      break;
    }
    case 'effres': {
      const d = reg.effres.data;
      raster = { canvas: paint(na, (i) => (ok(d[i]) ? [...viridis(1 - Math.min(1, Math.log10(Math.max(5, d[i]) / 5) / Math.log10(40))), 230] : null)), rect: rectOf(ga), smooth: true };
      break;
    }
    case 'sigma': {
      const d = reg.err.data;
      raster = { canvas: paint(na, (i) => (ok(d[i]) ? [...inferno(Math.min(1, d[i] / 3)), 230] : null)), rect: rectOf(ga), smooth: true };
      break;
    }
    case 'confidence': {
      const d = reg.dens.data;
      const L = c.lBase / 1000;
      raster = {
        canvas: paint(na, (i) => {
          if (!ok(d[i])) return null;
          const x = 1 - Math.exp(-d[i] * L * L);
          const conf = 100 * (0.5 * (0.85 * x + 0.4 * (1 - x)) + 0.3 * x + 0.2);
          const col = conf >= 80 ? hex(OKABE.pass) : conf >= 50 ? hex(OKABE.unknown) : hex(OKABE.fail);
          return [col[0], col[1], col[2], 200];
        }),
        rect: rectOf(ga), smooth: false,
      };
      break;
    }
    case 'sunNow':
    case 'earthNow': {
      const inst = s.instant;
      if (!inst) return { raster: null, legend };
      const gh = reg.hzGrid;
      raster = {
        canvas: paint(inst.n, (i) => {
          if (id === 'sunNow') {
            const v = inst.sun[i];
            return Number.isNaN(v) ? null : [...inferno(0.08 + 0.9 * v), 225];
          }
          const v = inst.earth[i];
          if (Number.isNaN(v)) return null;
          const ok = v >= c.earthMinEl;
          const col = ok ? hex(OKABE.sky) : v >= 0 ? hex(OKABE.yellow) : [40, 40, 48];
          return [col[0], col[1], col[2], ok ? 210 : 190];
        }),
        rect: rectOf(gh), smooth: false,
      };
      break;
    }
    case 'fsStatus':
    case 'fsSuit':
    case 'fsConf':
    case 'fsAvail': {
      const fr = s.forward;
      if (!fr) return { raster: null, legend };
      const gh = reg.hzGrid;
      const P = hex(OKABE.pass), U = hex(OKABE.unknown), F = hex(OKABE.fail);
      raster = {
        canvas: paint(fr.n, (i) => {
          const st = fr.status[i];
          if (st === 255) return null;
          if (id === 'fsStatus') return st === 2 ? [P[0], P[1], P[2], 240] : st === 1 ? [U[0], U[1], U[2], 240] : [F[0] * 0.45, F[1] * 0.45, F[2] * 0.45, 70];
          if (st === 0) return [60, 60, 66, 110];
          const v = id === 'fsSuit' ? fr.suit[i] : id === 'fsConf' ? fr.conf[i] : fr.avail[i];
          return [...viridis(v / 100), 235];
        }),
        rect: rectOf(gh), smooth: false,
      };
      break;
    }
  }
  if (raster) {
    if (cache.size > 24) cache.clear();
    cache.set(key, raster);
  }
  return { raster, legend };
}

export function legendFor(id: LayerId, s: AppState): LegendSpec | null {
  const c = s.criteria;
  switch (id) {
    case 'elevation': return { title: 'Elevation (LOLA, m above $R = 1737.4\\,\\mathrm{km}$)', kind: 'ramp', stops: VIRIDIS_CSS, min: '−5000', max: '+7000' };
    case 'slope': return { title: 'Slope $\\alpha$ at the 80 m LOLA baseline (640 m cell mean)', kind: 'ramp', stops: VIRIDIS_CSS, min: '0°', max: `$${c.slopeMax}^\\circ$ · above = vermillion`, note: 'Regional slope underestimates footpad-scale (5 m) slope — inspect sites for 5 m values.' };
    case 'psr': return { title: 'Permanently Shadowed Regions (PGDA Product 69)', kind: 'cats', cats: [{ color: OKABE.blue, label: 'PSR fraction of the 640 m cell' }] };
    case 'sunfrac': return { title: 'Average Sun visibility (PGDA Product 69, % of time)', kind: 'ramp', stops: INFERNO_CSS, min: '0 %', max: '$\\ge 60\\%$' };
    case 'effres': return { title: 'Effective DEM resolution (PGDA Product 90 EFFRES)', kind: 'ramp', stops: VIRIDIS_CSS, min: '$\\ge 200\\,\\mathrm{m}$', max: '$5\\,\\mathrm{m}$', note: 'Where tracks are sparse the true resolution is much coarser than the grid spacing.' };
    case 'sigma': return { title: 'Vertical uncertainty $\\sigma_z$ (PGDA Product 90 ERR)', kind: 'ramp', stops: INFERNO_CSS, min: '0 m', max: '$\\ge 3\\,\\mathrm{m}$' };
    case 'illum': return { title: 'Shaded illumination at the current epoch (cast shadows, finite Sun disk)', kind: 'ramp', stops: INFERNO_CSS, min: 'shadow', max: 'fully lit' };
    case 'psrdist': return { title: 'Distance to nearest PSR', kind: 'ramp', stops: VIRIDIS_CSS, min: '$\\ge 20\\,\\mathrm{km}$', max: '0 km' };
    case 'cpr': return { title: 'Mini-RF CPR (LRO Mini-RF global mosaic)', kind: 'ramp', stops: VIRIDIS_CSS, min: '0.25', max: '1.05', note: 'Independent layer — not a boulder count.' };
    case 'confidence': return { title: `Data confidence at $L_{\\mathrm{base}} = ${c.lBase}\\,\\mathrm{m}$ (LOLA spot-density model)`, kind: 'cats', cats: [{ color: OKABE.pass, label: 'High ($\\ge 80$)', badge: '●' }, { color: OKABE.unknown, label: 'Moderate ($50\\text{–}79$)', badge: '▲' }, { color: OKABE.fail, label: 'Low ($< 50$)', badge: '■' }] };
    case 'sunNow': return { title: 'Sun disk visible now (horizon grid, 4.75 km)', kind: 'ramp', stops: INFERNO_CSS, min: 'occulted', max: 'full disk' };
    case 'earthNow': return { title: 'Geometric DTE now', kind: 'cats', cats: [{ color: OKABE.sky, label: `Earth $\\ge ${c.earthMinEl}^\\circ$ above terrain` }, { color: OKABE.yellow, label: 'Visible, below clearance' }, { color: '#28282f', label: 'Earth hidden' }] };
    case 'fsStatus': return { title: 'Forward search · regional feasibility screen (landing = start of mission window)', kind: 'cats', cats: [{ color: OKABE.pass, label: 'PASS', badge: '✓' }, { color: OKABE.unknown, label: `UNKNOWN — screen passed, $${c.lBase}\\,\\mathrm{m}$ slope unresolved`, badge: '?' }, { color: OKABE.fail, label: 'FAIL', badge: '✕' }], note: 'FAIL cells are dimmed for legibility so terrain relief and passing sites stay clear; the outer rim (> 300 km from the pole) has no horizon grid.' };
    case 'fsSuit': return { title: 'Forward search · Suitability (0–100)', kind: 'ramp', stops: VIRIDIS_CSS, min: '0', max: '100', note: 'Grey = FAIL' };
    case 'fsConf': return { title: 'Forward search · Data Confidence (0–100)', kind: 'ramp', stops: VIRIDIS_CSS, min: '0', max: '100' };
    case 'fsAvail': return { title: 'Forward search · Launch-slip availability (% of hourly landing epochs viable)', kind: 'ramp', stops: VIRIDIS_CSS, min: '0 %', max: '100 %' };
    default: return null;
  }
}

export const LAYERS: { id: LayerId; label: string; group: string; adv?: boolean; timeDependent?: boolean }[] = [
  { id: 'none', label: 'None (relief only)', group: 'Base' },
  { id: 'fsStatus', label: 'Feasibility screen', group: 'Forward search', timeDependent: true },
  { id: 'fsSuit', label: 'Suitability', group: 'Forward search', timeDependent: true },
  { id: 'fsConf', label: 'Data confidence', group: 'Forward search', timeDependent: true },
  { id: 'fsAvail', label: 'Launch-slip availability', group: 'Forward search', timeDependent: true },
  { id: 'sunNow', label: 'Sun visible now', group: 'Illumination & comms', timeDependent: true },
  { id: 'earthNow', label: 'Earth visible now (DTE)', group: 'Illumination & comms', timeDependent: true },
  { id: 'sunfrac', label: 'Average Sun visibility', group: 'Illumination & comms' },
  { id: 'psr', label: 'Permanently shadowed regions', group: 'Illumination & comms' },
  { id: 'elevation', label: 'Elevation', group: 'Terrain & hazards' },
  { id: 'slope', label: 'Slope ($\\alpha$)', group: 'Terrain & hazards' },
  { id: 'cpr', label: 'Mini-RF CPR', group: 'Terrain & hazards', adv: true },
  { id: 'psrdist', label: 'Distance to PSR', group: 'Terrain & hazards', adv: true },
  { id: 'confidence', label: 'Data confidence ($L_{\\mathrm{base}}$)', group: 'Data quality' },
  { id: 'effres', label: 'Effective resolution', group: 'Data quality', adv: true },
  { id: 'sigma', label: 'Vertical uncertainty $\\sigma_z$', group: 'Data quality', adv: true },
];
