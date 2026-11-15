/**
 * 2D South Polar Stereographic map, 80S-90S (spec v2.0 sec. 4.1 / 7.1 / 8.3, feedback v2).
 * Canvas renders dense rasters: a static LOLA hillshade (320 m regional, then real pyramid tiles down
 * to 5 m as you zoom), the time-dependent shaded illumination of the current epoch (GPU ray-marched
 * cast shadows over the visible area), and analysis layers. An SVG overlay renders crisp vectors
 * (graticule, labels, leader-line pins, EVA rings, Sun/Earth azimuths).
 *
 * Interaction: cursor-anchored wheel zoom (the selenographic point under the cursor stays
 * fixed), drag / arrow-key pan along map X/Y, Shift+Left/Right rotates about the pole,
 * PageUp/PageDown or +/- zoom, click selects, P pins.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { fmtLat, fmtLon, latLonToPolar, polarToLatLon } from '../../lib/geo';
import { DEG, R_MOON_M } from '../../lib/math';
import { geometryAt } from '../../science/ephemeris';
import { runtime } from '../../store/runtime';
import { useApp } from '../../store/useApp';
import { useRuntimeData } from '../common/useRuntimeData';
import { baseLayers, buildLayer, tileHillshade } from './layers';
import { levelForTexel } from '../../data/mosaic';
import { snapshotters } from '../../store/snapshot';

interface View {
  cx: number;
  cy: number;
  s: number; // metres per pixel
  rot: number; // radians
}

const rhoOf = (lat: number) => 2 * R_MOON_M * Math.tan(((90 + lat) * DEG) / 2);

export function PolarMap() {
  const [data, dataVersion] = useRuntimeData();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const view = useRef<View>({ cx: 0, cy: 0, s: 700, rot: 0 });
  const [, force] = useState(0);
  const rerender = useCallback(() => force((x) => x + 1), []);
  const keys = useRef(new Set<string>());
  const illumRef = useRef<{ canvas: HTMLCanvasElement; rect: { x0: number; yTop: number; width: number }; key: string } | null>(null);
  const illumBusy = useRef(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const { layer, layerOpacity, selection, pins, epoch, showGraticule, showLabels, showSites, showEva, criteria, forward, instant, lonConvention, view: viewMode, flyTo, globeLighting } = useApp(
    (st) => ({
      layer: st.layer, layerOpacity: st.layerOpacity, selection: st.selection, pins: st.pins, epoch: st.epoch, showGraticule: st.showGraticule,
      showLabels: st.showLabels, showSites: st.showSites, showEva: st.showEva, criteria: st.criteria, forward: st.forward, instant: st.instant,
      lonConvention: st.lonConvention, view: st.view, flyTo: st.flyTo, globeLighting: `${st.globe.lighting}|${st.globe.shadows}`,
    }),
    shallow,
  );

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      view.current.s = Math.max(view.current.s, 1);
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Initial fit: show the 80S circle.
  useEffect(() => {
    view.current.s = (2 * rhoOf(-80) * 1.08) / Math.max(200, Math.min(size.w, size.h));
    rerender();
    onViewChanged();
  }, [size.w > 0 && size.h > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const toScreen = useCallback(
    (x: number, y: number): [number, number] => {
      const v = view.current;
      const u = (x - v.cx) / v.s, w = -(y - v.cy) / v.s;
      const c = Math.cos(v.rot), sn = Math.sin(v.rot);
      return [c * u - sn * w + size.w / 2, sn * u + c * w + size.h / 2];
    },
    [size],
  );
  const toMap = useCallback(
    (px: number, py: number): [number, number] => {
      const v = view.current;
      const a = px - size.w / 2, b = py - size.h / 2;
      const c = Math.cos(-v.rot), sn = Math.sin(-v.rot);
      const u = c * a - sn * b, w = sn * a + c * b;
      return [v.cx + u * v.s, v.cy - w * v.s];
    },
    [size],
  );

  // Fly-to (centre on a site).
  useEffect(() => {
    if (!flyTo || flyTo.lat > -78) return;
    const [x, y] = latLonToPolar(flyTo.lat, flyTo.lon);
    view.current.cx = x;
    view.current.cy = y;
    view.current.s = Math.min(view.current.s, Math.max(1, (flyTo.rangeKm * 1000) / Math.max(300, size.h)));
    rerender();
    draw();
    onViewChanged();
  }, [flyTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- raster drawing
  const draw = useCallback(() => {
    const cv = canvas.current;
    if (!cv || !runtime.data) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(cv).getPropertyValue('--map-bg') || '#0b0c0e';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const v = view.current;
    const st = useApp.getState();
    const drawRaster = (img: HTMLCanvasElement, rect: { x0: number; yTop: number; width: number }, smooth: boolean, alpha = 1) => {
      const k = rect.width / img.width;
      const c = Math.cos(v.rot), sn = Math.sin(v.rot);
      const u0 = (rect.x0 - v.cx) / v.s, w0 = -(rect.yTop - v.cy) / v.s;
      ctx.setTransform(
        dpr * c * (k / v.s), dpr * sn * (k / v.s), dpr * -sn * (k / v.s), dpr * c * (k / v.s),
        dpr * (c * u0 - sn * w0 + size.w / 2), dpr * (sn * u0 + c * w0 + size.h / 2),
      );
      ctx.imageSmoothingEnabled = smooth;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1;
    };
    const base = baseLayers(runtime.data);
    drawRaster(base.reg.canvas, base.reg.rect, true);
    // Real LOLA pyramid tiles (hillshade) once the regional 320 m grid is coarser than the screen.
    const pyr = runtime.data.regional.pyr;
    if (v.s < 160) {
      const k = levelForTexel(v.s * 0.9);
      const [mx0, my0] = toMap(0, 0), [mx1, my1] = toMap(size.w, size.h), [mx2, my2] = toMap(size.w, 0), [mx3, my3] = toMap(0, size.h);
      const xs = [mx0, mx1, mx2, mx3], ys = [my0, my1, my2, my3];
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      for (let kk = Math.min(7, k + 2); kk >= k; kk--) {
        const span = pyr.tileSpan(kk);
        const [ta, tb] = pyr.tileOf(kk, x0, y1), [tc, td] = pyr.tileOf(kk, x1, y0);
        if ((tc - ta + 1) * (td - tb + 1) > 64) continue;
        for (let ty = tb; ty <= td; ty++)
          for (let tx = ta; tx <= tc; tx++) {
            if (!pyr.hasTile(kk, tx, ty)) continue;
            const tile = pyr.tile(kk, tx, ty);
            if (!tile) {
              if (kk === k) void pyr.request(kk, tx, ty);
              continue;
            }
            const cnv = tileHillshade(`${kk}/${ty}_${tx}`, tile, pyr.N, pyr.px(kk), pyr.info.nodata, pyr.info.scale);
            drawRaster(cnv, { x0: -pyr.info.W + tx * span, yTop: pyr.info.W - ty * span, width: span }, true);
          }
      }
    }
    // Time-dependent shaded illumination with cast shadows (GPU bake of the visible area).
    const il = illumRef.current;
    if (il && st.globe.lighting === 'sun') drawRaster(il.canvas, il.rect, true, 0.88);
    const { raster } = buildLayer(st.layer, runtime.data, st);
    if (raster) drawRaster(raster.canvas, raster.rect, raster.smooth, st.layerOpacity);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [size]);

  useEffect(() => {
    draw();
  }, [draw, data, dataVersion, layer, layerOpacity, criteria, forward, instant, globeLighting]);

  // Redraw when pyramid tiles arrive.
  useEffect(() => {
    if (!runtime.data) return;
    let raf = 0;
    const off = runtime.data.regional.pyr.onTile(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => draw());
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [draw, data]);

  // GPU illumination bake of the visible area for the current epoch (throttled; re-run on pan/zoom).
  const bakeIllum = useCallback(async () => {
    const st = useApp.getState();
    if (!runtime.bake2d || illumBusy.current || st.view !== '2d' || st.globe.lighting !== 'sun') return;
    const v = view.current;
    const half = (Math.max(size.w, size.h) * v.s * 1.45) / 2;
    const W = runtime.data!.regional.pyr.info.W;
    const width = Math.min(2 * W, Math.max(2000, 2 * half));
    const x0 = Math.max(-W, Math.min(W - width, v.cx - width / 2));
    const yTop = Math.min(W, Math.max(-W + width, v.cy + width / 2));
    const n = 1024;
    const k = width / n < 300 ? levelForTexel(width / n) : null;
    illumBusy.current = true;
    try {
      const px = await runtime.bake2d({ x0, yTop, width }, n, st.epoch, k);
      if (!px) return;
      const cnv = illumRef.current?.canvas.width === n ? illumRef.current.canvas : document.createElement('canvas');
      cnv.width = cnv.height = n;
      const ctx = cnv.getContext('2d')!;
      const img = ctx.createImageData(n, n);
      const useShadows = useApp.getState().globe.shadows;
      for (let j = 0; j < n; j++) {
        const src = (n - 1 - j) * n * 4;
        for (let i = 0; i < n; i++) {
          const a = src + i * 4, o = (j * n + i) * 4;
          if (px[a + 3] === 0) continue;
          const f = useShadows ? px[a] / 255 : 1, lam = px[a + 2] / 255;
          const g = Math.round(8 + 247 * Math.pow(Math.min(1, lam * f * 1.25), 0.72));
          img.data[o] = g;
          img.data[o + 1] = g;
          img.data[o + 2] = Math.min(255, g + 3);
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      illumRef.current = { canvas: cnv, rect: { x0, yTop, width }, key: `${x0}|${yTop}|${width}|${st.epoch}` };
      draw();
    } finally {
      illumBusy.current = false;
    }
  }, [size, draw]);

  useEffect(() => {
    const t = window.setTimeout(() => void bakeIllum(), 60);
    return () => window.clearTimeout(t);
  }, [epoch, bakeIllum, viewMode, globeLighting, data]);

  // Publish the 2D camera to the store (HUD dial / zoom slider / resolution) and re-bake on view change.
  const viewTimer = useRef(0);
  const onViewChanged = useCallback(() => {
    const v = view.current;
    const [lat, lon] = polarToLatLon(v.cx, v.cy);
    const r = Math.hypot(v.cx, v.cy);
    const north: [number, number] = r > 1 ? [v.cx / r, v.cy / r] : [0, 1];
    const east: [number, number] = [north[1], -north[0]];
    const up: [number, number] = [-Math.sin(v.rot), Math.cos(v.rot)];
    const heading = ((Math.atan2(up[0] * east[0] + up[1] * east[1], up[0] * north[0] + up[1] * north[1]) * 180) / Math.PI + 360) % 360;
    const st = useApp.getState();
    if (st.view === '2d') {
      st.set({ cam: { lat, lon, rangeKm: (v.s * size.h) / 1000, heading, tilt: 0, mPerPx: v.s } });
      const pyr = runtime.data?.regional.pyr;
      if (pyr) {
        const k = pyr.finestAvailable(v.cx, v.cy, 0);
        const src = k === 0 ? 'LOLA 5 m (PDS GDR / PGDA Product 78)' : k >= 0 ? 'LOLA 80 m (PGDA Product 90)' : 'outside 80°S';
        const eff = runtime.data!.regional.effres.sample(v.cx, v.cy);
        const shown = v.s < 160 ? Math.max(pyr.px(levelForTexel(v.s * 0.9)), k === 0 ? 5 : 80) : 320;
        st.set({ resolution: { source: src, sourceM: k === 0 ? 5 : 80, meshM: shown, effectiveM: Number.isNaN(eff) ? null : k === 0 ? Math.min(eff, 25) : eff, measuredPct: null, sigmaZ: runtime.data!.regional.err.sample(v.cx, v.cy) || null, imagery: `map ${v.s < 10 ? v.s.toFixed(1) : v.s.toFixed(0)} m/px · shaded relief + GPU illumination` } });
      }
    }
    window.clearTimeout(viewTimer.current);
    viewTimer.current = window.setTimeout(() => void bakeIllum(), 160);
  }, [size, bakeIllum]);

  // Navigation hub commands (2D): pan along screen axes, rotate, zoom, north-up, pole.
  useEffect(
    () =>
      useApp.subscribe((s, p) => {
        if (s.navSeq === p.navSeq || !s.navCommand || s.view !== '2d') return;
        const v = view.current;
        const c = s.navCommand;
        if (c.type === 'pan') {
          const dx = c.right * size.w * 0.04 * v.s, dy = c.fwd * size.h * 0.04 * v.s;
          const cr = Math.cos(-v.rot), sr = Math.sin(-v.rot);
          v.cx += cr * dx + sr * dy;
          v.cy += -sr * dx + cr * dy;
        } else if (c.type === 'look') v.rot += (c.dHeading * Math.PI) / 180;
        else if (c.type === 'zoom') v.s = Math.min(3000, Math.max(0.6, v.s * c.factor));
        else if (c.type === 'range') v.s = Math.min(3000, Math.max(0.6, (c.rangeKm * 1000) / Math.max(1, size.h)));
        else if (c.type === 'north') v.rot = 0;
        else if (c.type === 'pole') {
          v.cx = 0;
          v.cy = 0;
          v.rot = 0;
          v.s = 120;
        }
        draw();
        rerender();
        onViewChanged();
      }),
    [size, draw, rerender, onViewChanged],
  );

  useEffect(() => {
    snapshotters['2d'] = async () => {
      const cv = canvas.current;
      const svg = wrap.current?.querySelector('svg.map-svg') as SVGSVGElement | null;
      if (!cv) return null;
      const out = document.createElement('canvas');
      out.width = cv.width;
      out.height = cv.height;
      const ctx = out.getContext('2d')!;
      ctx.drawImage(cv, 0, 0);
      if (svg) {
        const xml = new XMLSerializer().serializeToString(svg);
        const css = '.grat{fill:none;stroke:rgba(160,175,190,.35)}.grat-label,.crater-label,.vec-label,.site text,.pin text,.eva-label{fill:#eee;font:11px sans-serif}.site path{fill:#fff}.patch{fill:none;stroke:#009E73}.eva{fill:none;stroke-dasharray:6 4}.e2{stroke:#F0E442}.e10{stroke:#56B4E9}.selmark circle,.selmark line{stroke:#fff;fill:none;stroke-width:2}.cand circle{fill:#CC79A7;stroke:#000}.cand text{fill:#000;font:700 10px sans-serif;text-anchor:middle}.crater-ring{fill:none;stroke:rgba(255,255,255,.2)}';
        const withCss = xml.replace('>', `><style>${css}</style>`);
        const img = new Image();
        await new Promise<void>((res) => {
          img.onload = () => res();
          img.onerror = () => res();
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withCss)}`;
        });
        ctx.drawImage(img, 0, 0, out.width, out.height);
      }
      return out;
    };
    return () => {
      delete snapshotters['2d'];
    };
  }, []);

  // ----- interaction
  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      const v = view.current;
      const [mx, my] = toMap(px, py);
      const ns = Math.min(3000, Math.max(0.6, v.s * factor));
      const f = ns / v.s;
      v.cx = mx - (mx - v.cx) * f;
      v.cy = my - (my - v.cy) * f;
      v.s = ns;
      draw();
      rerender();
      onViewChanged();
    },
    [toMap, draw, rerender, onViewChanged],
  );

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // keyboard (active only in 2D mode)
  useEffect(() => {
    if (viewMode !== '2d') return;
    let raf = 0;
    let last = performance.now();
    const typing = (t: EventTarget | null) => {
      const n = t as HTMLElement | null;
      if (!n) return false;
      if (n.tagName === 'INPUT') {
        return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((n as HTMLInputElement).type);
      }
      return n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable;
    };
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = keys.current;
      if (k.size) {
        const v = view.current;
        const sp = v.s * 500 * dt;
        let moved = false;
        if (k.has('Shift')) {
          if (k.has('ArrowLeft')) { v.rot -= 1.2 * dt; moved = true; }
          if (k.has('ArrowRight')) { v.rot += 1.2 * dt; moved = true; }
        } else {
          // pan along screen axes, expressed in map X/Y (respects rotation)
          let dx = 0, dy = 0;
          if (k.has('ArrowLeft')) dx -= sp;
          if (k.has('ArrowRight')) dx += sp;
          if (k.has('ArrowUp')) dy += sp;
          if (k.has('ArrowDown')) dy -= sp;
          if (dx || dy) {
            const c = Math.cos(-v.rot), sn = Math.sin(-v.rot);
            v.cx += c * dx + sn * dy;
            v.cy += -sn * dx + c * dy;
            moved = true;
          }
        }
        if (k.has('PageUp') || k.has('+') || k.has('=')) { v.s = Math.max(0.6, v.s * Math.exp(-1.8 * dt)); moved = true; }
        if (k.has('PageDown') || k.has('-')) { v.s = Math.min(3000, v.s * Math.exp(1.8 * dt)); moved = true; }
        if (moved) {
          draw();
          rerender();
          onViewChanged();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const down = (e: KeyboardEvent) => {
      const st = useApp.getState();
      if (st.screen !== 'workbench' || st.modal !== null || st.tutorialStep !== null) {
        keys.current.clear();
        return;
      }
      if (typing(e.target)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', '+', '=', '-'].includes(e.key)) {
        e.preventDefault();
        if (!e.repeat && (e.key === 'PageUp' || e.key === 'PageDown')) {
          const factor = e.key === 'PageUp' ? 0.84 : 1 / 0.84;
          view.current.s = Math.min(3000, Math.max(0.6, view.current.s * factor));
          draw();
          rerender();
          onViewChanged();
        }
        keys.current.add(e.key);
      }
      if (e.key === 'Shift') keys.current.add('Shift');
      if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) useApp.getState().togglePin();
    };
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.key);
      if (e.key === 'Shift') keys.current.delete('Shift');
    };
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [viewMode, draw, rerender, onViewChanged]);

  const selectAt = (px: number, py: number) => {
    const d = runtime.data;
    if (!d) return;
    const [x, y] = toMap(px, py);
    if (Math.hypot(x, y) > 304000) {
      const [lat, lon] = polarToLatLon(x, y);
      useApp.getState().notify(
        `This software covers only the lunar South Pole (80°S–90°S). Clicked ${fmtLat(lat, 2)} ${fmtLon(lon, useApp.getState().lonConvention)}.`,
        { icon: 'warn' },
      );
      return;
    }
    if (Number.isNaN(d.regional.dem.sample(x, y))) return;
    const site = d.manifest.sites.find((q) => Math.hypot(q.x - x, q.y - y) < view.current.s * 8);
    if (site) useApp.getState().select({ x: site.x, y: site.y, lat: site.lat, lon: site.lon, siteId: site.id, name: site.name });
    else {
      const [lat, lon] = polarToLatLon(x, y);
      useApp.getState().select({ x, y, lat, lon, siteId: null, name: `${fmtLat(lat, 3)} ${fmtLon(lon, useApp.getState().lonConvention)}` });
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (drag.current) {
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      if (drag.current.moved) {
        const v = view.current;
        const c = Math.cos(-v.rot), sn = Math.sin(-v.rot);
        const u = c * dx - sn * dy, w = sn * dx + c * dy;
        v.cx -= u * v.s;
        v.cy += w * v.s;
        drag.current.x = e.clientX;
        drag.current.y = e.clientY;
        draw();
        rerender();
        onViewChanged();
      }
      return;
    }
    const d = runtime.data;
    if (!d) return;
    const [x, y] = toMap(px, py);
    const [lat, lon] = polarToLatLon(x, y);
    const [zp] = d.regional.pyr.sampleBest(x, y, 0);
    const zr = Number.isNaN(zp) ? d.regional.dem.sample(x, y) : zp;
    const elev = Number.isNaN(zr) ? null : zr;
    useApp.getState().set({ hover: { lat, lon, elev } });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const dr = drag.current;
    drag.current = null;
    if (dr && !dr.moved && e.button === 0) {
      const r = wrap.current!.getBoundingClientRect();
      selectAt(e.clientX - r.left, e.clientY - r.top);
    }
  };

  // ----- vector overlay
  const v = view.current;
  const geo = useMemo(() => geometryAt(epoch), [epoch]);
  const overlay = useMemo(() => {
    if (!data) return null;
    const els: JSX.Element[] = [];
    const [pcx, pcy] = toScreen(0, 0);
    if (showGraticule) {
      for (let lat = -89; lat >= -80; lat--) {
        const r = rhoOf(lat) / v.s;
        if (r < 4) continue;
        els.push(<circle key={`g${lat}`} cx={pcx} cy={pcy} r={r} className={lat % 5 === 0 ? 'grat major' : 'grat'} />);
        if (showLabels && (lat % 5 === 0 || r > 120)) {
          const [lx, ly] = toScreen(0, rhoOf(lat));
          els.push(<text key={`gl${lat}`} x={lx + 3} y={ly - 3} className="grat-label">{`${-lat}°S`}</text>);
        }
      }
      for (let lon = 0; lon < 360; lon += 30) {
        const [ex, ey] = toScreen(rhoOf(-80) * Math.sin(lon * DEG), rhoOf(-80) * Math.cos(lon * DEG));
        els.push(<line key={`m${lon}`} x1={pcx} y1={pcy} x2={ex} y2={ey} className={lon === 0 ? 'grat major' : 'grat'} />);
        if (showLabels) {
          const [tx, ty] = toScreen(rhoOf(-79.6) * Math.sin(lon * DEG), rhoOf(-79.6) * Math.cos(lon * DEG));
          els.push(<text key={`ml${lon}`} x={tx} y={ty} className="grat-label mid">{lon === 0 ? '0° (Earth)' : lonConvention === '360' ? `${lon}°E` : lon <= 180 ? `${lon}°E` : `${360 - lon}°W`}</text>);
        }
      }
    }
    // Sub-solar / sub-Earth azimuth vectors from the pole.
    for (const [key, sub, color, label] of [['sun', geo.subSolar, '#E69F00', 'Sub-solar'], ['earth', geo.subEarth, '#56B4E9', 'Sub-Earth']] as const) {
      const L = rhoOf(-80.6);
      const [ex, ey] = toScreen(L * Math.sin(sub.lon * DEG), L * Math.cos(sub.lon * DEG));
      els.push(
        <g key={`v${key}`} className="vec">
          <line x1={pcx} y1={pcy} x2={ex} y2={ey} stroke={color} strokeWidth={2} markerEnd={`url(#arrow-${key})`} />
          <text x={ex} y={ey - 6} fill={color} className="vec-label">{`${label} ${sub.lon.toFixed(1)}°E, ${sub.lat.toFixed(2)}°`}</text>
        </g>,
      );
    }
    // L2 patch footprints
    if (showSites) {
      const seen = new Set<string>();
      for (const site of data.manifest.sites) {
        const b = site.p78;
        if (!b || seen.has(b.id)) continue;
        seen.add(b.id);
        const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => toScreen(x, y).join(',')).join(' ');
        els.push(<polygon key={`p${b.id}`} points={pts} className="patch" />);
      }
      const e = 75840;
      const cap = [[-e, -e], [e, -e], [e, e], [-e, e]].map(([x, y]) => toScreen(x, y).join(',')).join(' ');
      els.push(<polygon key="cap5m" points={cap} className="patch cap" />);
    }
    if (showLabels) {
      for (const c of data.manifest.named_craters) {
        if (c.lat > -79) continue;
        const [x, y] = latLonToPolar(c.lat, c.lon);
        const [sx, sy] = toScreen(x, y);
        if (sx < -50 || sy < -20 || sx > size.w + 50 || sy > size.h + 20) continue;
        const rr = (c.d_km * 500) / v.s;
        if (rr > 6) els.push(<circle key={`cr${c.name}`} cx={sx} cy={sy} r={rr} className="crater-ring" />);
        els.push(<text key={`ct${c.name}`} x={sx} y={sy} className="crater-label">{c.name}</text>);
      }
    }
    // Forward-search top candidates
    if (forward && (layer.startsWith('fs') || layer === 'none')) {
      forward.top.slice(0, 8).forEach((cand, i) => {
        const [sx, sy] = toScreen(cand.x, cand.y);
        els.push(
          <g key={`top${i}`} className="cand" onPointerDown={(e) => e.stopPropagation()} onClick={() => useApp.getState().select({ x: cand.x, y: cand.y, lat: cand.lat, lon: cand.lon, siteId: null, name: `Candidate #${i + 1}` })}>
            <circle cx={sx} cy={sy} r={9} />
            <text x={sx} y={sy + 4}>{i + 1}</text>
          </g>,
        );
      });
    }
    // Curated sites
    if (showSites) {
      for (const site of data.manifest.sites) {
        const [sx, sy] = toScreen(site.x, site.y);
        if (sx < -40 || sy < -40 || sx > size.w + 40 || sy > size.h + 40) continue;
        els.push(
          <g key={`s${site.id}`} className="site">
            <path d={`M${sx} ${sy - 6} L${sx + 6} ${sy} L${sx} ${sy + 6} L${sx - 6} ${sy} Z`} />
            {showLabels && <text x={sx + 9} y={sy + 4}>{site.id}</text>}
          </g>,
        );
      }
    }
    // EVA rings + landing ellipse around the selection
    if (selection && showEva) {
      const [sx, sy] = toScreen(selection.x, selection.y);
      els.push(<circle key="eva2" cx={sx} cy={sy} r={2000 / v.s} className="eva e2" />);
      els.push(<circle key="eva10" cx={sx} cy={sy} r={10000 / v.s} className="eva e10" />);
      if (criteria.ellipseR > 0) els.push(<circle key="ell" cx={sx} cy={sy} r={Math.max(2, criteria.ellipseR / v.s)} className="ellipse" />);
      if (10000 / v.s > 30) {
        els.push(<text key="eva10t" x={sx + 10000 / v.s * 0.71} y={sy - 10000 / v.s * 0.71} className="eva-label">10 km LTV</text>);
        els.push(<text key="eva2t" x={sx + 2000 / v.s * 0.71} y={sy - 2000 / v.s * 0.71} className="eva-label">2 km EVA</text>);
      }
    }
    // Pins with leader lines
    pins.forEach((p, i) => {
      const [sx, sy] = toScreen(p.x, p.y);
      const lx = sx + 26, ly = sy - 30 - (i % 3) * 14;
      els.push(
        <g key={`pin${p.id}`} className="pin" style={{ ['--pin' as string]: p.color }}>
          <line x1={sx} y1={sy} x2={lx} y2={ly} />
          <circle cx={sx} cy={sy} r={4} />
          <text x={lx + 3} y={ly + 4}>{p.name}</text>
        </g>,
      );
    });
    if (selection) {
      const [sx, sy] = toScreen(selection.x, selection.y);
      els.push(
        <g key="sel" className="selmark">
          <circle cx={sx} cy={sy} r={10} />
          <line x1={sx - 16} y1={sy} x2={sx - 5} y2={sy} />
          <line x1={sx + 5} y1={sy} x2={sx + 16} y2={sy} />
          <line x1={sx} y1={sy - 16} x2={sx} y2={sy - 5} />
          <line x1={sx} y1={sy + 5} x2={sx} y2={sy + 16} />
        </g>,
      );
    }
    return els;
  }, [data, dataVersion, toScreen, showGraticule, showLabels, showSites, showEva, selection, pins, forward, layer, criteria.ellipseR, geo, size, lonConvention, v.s, v.cx, v.cy, v.rot]);

  // Scale bar
  const scaleBar = useMemo(() => {
    const target = view.current.s * 120;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).filter((x) => x <= target).pop() ?? pow;
    return { px: nice / view.current.s, label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m` };
  }, [v.s]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="polar-map" ref={wrap} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => useApp.getState().set({ hover: null })} data-tour="viewport">
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      <svg width={size.w} height={size.h} className="map-svg">
        <defs>
          {[['sun', '#E69F00'], ['earth', '#56B4E9']].map(([k, c]) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {overlay}
      </svg>
      <div className="scalebar">
        <div style={{ width: scaleBar.px }} />
        <span>{scaleBar.label}</span>
        <span className="muted">· {view.current.s < 1000 ? `${view.current.s.toFixed(view.current.s < 10 ? 1 : 0)} m/px` : `${(view.current.s / 1000).toFixed(1)} km/px`}</span>
      </div>
      <div className="map-hint">Wheel: zoom at cursor · Drag/Arrows: pan · Shift+←/→: rotate · Click: select · P: pin</div>
    </div>
  );
}
