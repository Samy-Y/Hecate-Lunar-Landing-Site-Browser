/**
 * 3D Lunar Globe (Three.js + React Three Fiber) - spec v2.0 sec. 7.1 / 8.1 / 8.3, feedback v2.
 * Whole-Moon chunked LOD terrain on real LOLA data (5 m near the pole), CDLOD morphing,
 * true-ephemeris lighting with nested GPU cast shadows (global / polar / view-dependent focus),
 * streamed LROC WAC imagery, Sun / Earth / sub-point vectors, pins, EVA rings, navigation hub,
 * resolution indicator, PNG snapshots and the GPU-vs-CPU shadow probe.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { bodyFixed, bodyToScene, latLonToPolar, polarToLatLon, fmtLat, fmtLon } from '../../lib/geo';
import { R_MOON_KM, normalize, type Vec3 } from '../../lib/math';
import { geometryAt } from '../../science/ephemeris';
import { resolvePolarHover, resolvePolarSelection } from '../../science/gridSnap';
import { runtime } from '../../store/runtime';
import { useApp } from '../../store/useApp';
import { useRuntimeData } from '../common/useRuntimeData';
import { buildLayer } from '../map2d/layers';
import { CameraRig } from './CameraRig';
import { ElevationSampler } from './ElevationSampler';
import { ShadowBaker } from './ShadowBaker';
import { TerrainSystem } from './TerrainSystem';
import { createTerrainMaterial } from './terrainMaterial';
import { TrekImagery } from './TrekImagery';
import { DATA_ROOT } from '../../data/fetchBin';
import { buildMosaic, levelForTexel, NODATA_SENTINEL } from '../../data/mosaic';
import { snapshotters } from '../../store/snapshot';

const CAP_RHO = 1_050_000;

/** Re-project the equirectangular mosaic into two stereographic polar caps (removes pole smearing). */
function buildCaps(img: HTMLImageElement, size = 2048): [HTMLCanvasElement, HTMLCanvasElement] {
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0);
  const W = img.width, H = img.height;
  const sd = sctx.getImageData(0, 0, W, H).data;
  const R = 1_737_400;
  const caps: HTMLCanvasElement[] = [];
  for (const hemi of [-1, 1]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const out = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      const y = CAP_RHO * (1 - (2 * (j + 0.5)) / size);
      for (let i = 0; i < size; i++) {
        const x = CAP_RHO * ((2 * (i + 0.5)) / size - 1);
        const rho = Math.hypot(x, y);
        const colat = 2 * Math.atan(rho / (2 * R));
        const lat = hemi < 0 ? -90 + (colat * 180) / Math.PI : 90 - (colat * 180) / Math.PI;
        const lon = (Math.atan2(x, hemi < 0 ? y : -y) * 180) / Math.PI;
        const px = ((lon + 180) / 360) * W - 0.5, py = ((90 - lat) / 180) * H - 0.5;
        const x0 = Math.floor(px), y0 = Math.max(0, Math.min(H - 2, Math.floor(py)));
        const fx = px - x0, fy = Math.max(0, Math.min(1, py - y0));
        const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
        const o = (j * size + i) * 4;
        for (let k = 0; k < 3; k++) {
          const a = sd[(y0 * W + xa) * 4 + k] * (1 - fx) + sd[(y0 * W + xb) * 4 + k] * fx;
          const b = sd[((y0 + 1) * W + xa) * 4 + k] * (1 - fx) + sd[((y0 + 1) * W + xb) * 4 + k] * fx;
          out.data[o + k] = a * (1 - fy) + b * fy;
        }
        out.data[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    caps.push(c);
  }
  return [caps[0], caps[1]];
}

function glowTexture(inner: string, outer: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.18, inner);
  grad.addColorStop(0.35, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);
const sceneDir = (bf: Vec3) => v3(bodyToScene(normalize(bf)));

function surfacePoint(lat: number, lon: number, elevM: number, lift = 0) {
  return v3(bodyToScene(bodyFixed(lat, lon, R_MOON_KM + elevM / 1000 + lift)));
}

function ringPoints(sampler: ElevationSampler, lat: number, lon: number, radiusKm: number, ex: number, seg = 96) {
  const [x0, y0] = latLonToPolar(lat, lon);
  const useStereo = lat < -60;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    let la: number, lo: number;
    if (useStereo) {
      [la, lo] = polarToLatLon(x0 + radiusKm * 1000 * Math.cos(a), y0 + radiusKm * 1000 * Math.sin(a));
    } else {
      la = lat + (radiusKm / R_MOON_KM) * (180 / Math.PI) * Math.cos(a);
      lo = lon + ((radiusKm / R_MOON_KM) * (180 / Math.PI) * Math.sin(a)) / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    }
    pts.push(surfacePoint(la, lo, sampler.elevation(la, lo, Math.max(5, radiusKm * 20)) * ex, 0.004 + radiusKm * 0.0005));
  }
  return pts;
}

interface LabelRef {
  el: HTMLDivElement;
  pos: THREE.Vector3;
}

interface Sys {
  sampler: ElevationSampler;
  terrain: TerrainSystem;
  baker: ShadowBaker;
  rig: CameraRig;
  mat: THREE.ShaderMaterial;
  trek: TrekImagery;
}

function GlobeScene({ labelsRef }: { labelsRef: React.MutableRefObject<HTMLDivElement | null> }) {
  const { gl, camera, size, scene } = useThree();
  const [data, dataVersion] = useRuntimeData();
  const sys = useRef<Sys | null>(null);
  const lastBake = useRef({ t: 0, epoch: NaN, globalReady: false, force: true, n: 0 });
  const focus = useRef<{ busy: boolean; cx: number; cy: number; width: number; k: number; dirty: boolean } | null>(null);
  const fpsAcc = useRef({ n: 0, t: 0, pub: 0, res: 0 });
  const markers = useMemo(() => new THREE.Group(), []);
  const hoverCellGroup = useMemo(() => new THREE.Group(), []);
  const vectors = useMemo(() => {
    const g = new THREE.Group();
    const len = R_MOON_KM * 1.9;
    for (const [name, c] of [['sunArrow', 0xe69f00], ['earthArrow', 0x56b4e9]] as const) {
      const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), len, c, 160, 70);
      a.name = name;
      g.add(a);
      const ring = new THREE.Mesh(new THREE.RingGeometry(18, 26, 32), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      ring.name = `${name}Ring`;
      g.add(ring);
    }
    return g;
  }, []);
  const labels = useRef<LabelRef[]>([]);
  const rigRangeRef = useRef({ v: 5200 });

  const furniture = useMemo(() => {
    const g = new THREE.Group();
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,250,235,1)', 'rgba(255,200,120,0.25)'), depthWrite: false, transparent: true }));
    sun.name = 'sun';
    g.add(sun);
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(6371, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
        fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun; varying vec3 vN; void main(){
#include <logdepthbuf_fragment>
float d = max(dot(normalize(vN), uSun), 0.0); float lat = vN.y;
vec3 ocean = vec3(0.10,0.28,0.62); vec3 cloud = vec3(0.92); float c = smoothstep(0.55,0.9, 0.5+0.5*sin(vN.x*9.0+vN.z*7.0)*cos(vN.y*11.0));
vec3 col = mix(ocean, cloud, c*0.55); col = mix(col, vec3(0.95), smoothstep(0.82,0.9,abs(lat)));
gl_FragColor = vec4(col*(0.03+1.1*d), 1.0); }`,
      }),
    );
    earth.name = 'earth';
    g.add(earth);
    return g;
  }, []);

  // Build the terrain system once data is ready.
  useEffect(() => {
    if (!data || sys.current) return;
    const sampler = new ElevationSampler(data);
    const mat = createTerrainMaterial();
    const terrain = new TerrainSystem(sampler, mat);
    const baker = new ShadowBaker(gl);
    const reg = data.regional.dem;
    const regData = Float32Array.from(reg.data as ArrayLike<number>, (v) => (Number.isNaN(v) ? NODATA_SENTINEL : v));
    baker.setRegionalDem({ data: regData, grid: reg.g });
    if (data.l0?.dem8) baker.setGlobalDem(data.l0.dem8, 2880, 1440, data.l0.scale);
    else if (data.l0?.dem4) baker.setGlobalDem(data.l0.dem4, 1440, 720, data.l0.scale);
    mat.uniforms.uShadowGlobal.value = baker.globalRT.texture;
    mat.uniforms.uShadowPolar.value = baker.polarRT.texture;
    mat.uniforms.uShadowFocus.value = baker.focusRT.texture;
    mat.uniforms.uPolarRect.value.set(reg.g.x0, reg.g.y0, reg.g.n * reg.g.dx_m, 1);
    mat.uniforms.uCapRho.value = CAP_RHO;
    const aniso = gl.capabilities.getMaxAnisotropy();
    const trek = new TrekImagery(aniso);
    mat.uniforms.uTrek.value = trek.texture;
    scene.add(terrain.group);

    const raycaster = new THREE.Raycaster();
    const pickAt = (ndc: THREE.Vector2) => {
      raycaster.setFromCamera(ndc, camera);
      return raycaster.intersectObjects(terrain.pickables(), false)[0] ?? null;
    };
    const rigRange = rigRangeRef.current;
    const rig: CameraRig = new CameraRig(camera as THREE.PerspectiveCamera, gl.domElement, {
      elevationM: (lat: number, lon: number): number => sampler.elevation(lat, lon, Math.max(5, rigRange.v * 2.5)) * terrain.exaggeration,
      pick: (ndc) => pickAt(ndc)?.point.clone() ?? null,
      onSelect: (lat, lon, shiftKey, altKey) => {
        const st = useApp.getState();
        if (st.screen !== 'workbench') return;
        if (lat > -79.9) {
          st.notify(
            `This software covers only the lunar South Pole (80°S–90°S). Clicked ${fmtLat(lat, 2)} ${fmtLon(lon, st.lonConvention)}.`,
            { icon: 'warn' },
          );
          return;
        }
        const [x, y] = latLonToPolar(lat, lon);
        const resolved = resolvePolarSelection(data, st.forward, x, y, {
          siteSnapM: Math.max(150, rig.range * 8),
          snapCells: st.snapToCells && !altKey,
          lonConvention: st.lonConvention,
        });
        if (resolved) st.pickMapSite(resolved.selection, shiftKey);
        else st.pickMapSite({ x, y, lat, lon: (lon + 360) % 360, siteId: null, name: `${fmtLat(lat, 3)} ${fmtLon(lon)}` }, shiftKey);
      },
      onHover: (lat, lon, elevM, altKey) => {
        const st = useApp.getState();
        if (Number.isNaN(lat)) {
          st.set({ hover: null });
          return;
        }
        const rawElev = elevM === null ? null : elevM / terrain.exaggeration;
        if (lat <= -79.9 && st.screen === 'workbench') {
          const h = resolvePolarHover(data, st.forward, lat, lon, rawElev, {
            siteSnapM: Math.max(150, rig.range * 8),
            snapCells: st.snapToCells && !altKey,
            lonConvention: st.lonConvention,
          });
          st.set({
            hover: {
              lat: h.lat,
              lon: h.lon,
              elev: h.elev,
              ...(h.cell ? { cell: { row: h.cell.row, col: h.cell.col, x: h.cell.x, y: h.cell.y, dx: h.cell.dx, status: h.cell.status, passedRank: h.cell.passedRank } } : {}),
              label: h.label || undefined,
            },
          });
        } else {
          st.set({ hover: { lat, lon, elev: rawElev } });
        }
      },
      onPinKey: () => useApp.getState().screen === 'workbench' && useApp.getState().togglePin(),
    });
    rig.focus = normalize(bodyFixed(-75, 20, 1));
    rig.range = 5200;
    rig.tilt = 20;
    rig.heading = 180;
    rig.apply();

    const offL0 = data.l0?.onTile((key) => {
      if (key.startsWith('global')) {
        if (key === 'global8' && data.l0.dem8) {
          baker.setGlobalDem(data.l0.dem8, 2880, 1440, data.l0.scale);
          lastBake.current.globalReady = false;
        }
        terrain.invalidate((lat) => lat > -79);
      } else terrain.onTileArrived(key);
    });
    const offPyr = data.regional.pyr.onTile((k, key) => {
      terrain.onTileArrived(`p${k}/${key}`);
      const f = focus.current;
      if (f && k === f.k) f.dirty = true;
    });

    // Snapshot + GPU shadow probe hooks.
    snapshotters['3d'] = async () => {
      gl.render(scene, camera);
      const c = document.createElement('canvas');
      c.width = gl.domElement.width;
      c.height = gl.domElement.height;
      c.getContext('2d')!.drawImage(gl.domElement, 0, 0);
      return c;
    };
    let mosaicKey = '';
    runtime.bake2d = async (rect, n, utcMs, k) => {
      let near: { data: Float32Array; grid: import('../../data/types').GridSpec } | null = null;
      if (k !== null) {
        const kk = Math.min(7, k + 1);
        const key = `${Math.round(rect.x0)}|${Math.round(rect.yTop)}|${Math.round(rect.width)}|${kk}`;
        if (key !== mosaicKey) {
          const m = await buildMosaic(data.regional.pyr, data.regional.dem, rect.x0 + rect.width / 2, rect.yTop - rect.width / 2, kk, Math.min(1024, Math.ceil(rect.width / (5 * 2 ** kk))));
          near = { data: m.data, grid: m.grid };
          mosaicKey = key;
        }
      } else mosaicKey = '';
      baker.setFocus(rect, near);
      focus.current = null;
      const g = geometryAt(utcMs);
      const px = baker.bakePixels(rect, n, normalize(g.sun), g.earth, k !== null);
      return px;
    };
    runtime.gpuSunProbe = async (pts, utcMs, which) => {
      const g = geometryAt(utcMs);
      baker.bake(normalize(g.sun), g.earth, { global: false, polar: true, focus: true });
      lastBake.current.force = true;
      const v = baker.sampleSun(pts, which);
      return v && v.some((x) => !Number.isNaN(x)) ? v : null;
    };
    runtime.gpuFocusRect = () => baker.focus?.rect ?? null;

    // Imagery: 1k first paint, then 4k + re-projected stereographic polar caps.
    let disposed = false;
    if (data.manifest.level0) {
      const u = mat.uniforms;
      const loader = new THREE.TextureLoader();
      const lv = data.manifest.level0.imagery;
      loader.load(DATA_ROOT + lv.color_1k.path, (t) => {
        if (disposed) return;
        t.anisotropy = aniso;
        u.uColor.value = t;
        loader.load(DATA_ROOT + lv.color_4k.path, (t4) => {
          if (disposed) return;
          t4.anisotropy = aniso;
          u.uColor.value = t4;
          const run = () => {
            if (disposed) return;
            const [cs, cn] = buildCaps(t4.image as HTMLImageElement);
            const mk = (c: HTMLCanvasElement) => {
              const ct = new THREE.CanvasTexture(c);
              ct.anisotropy = aniso;
              return ct;
            };
            u.uCapS.value = mk(cs);
            u.uCapN.value = mk(cn);
          };
          const ric = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback;
          if (ric) ric(run);
          else setTimeout(run, 50);
        });
      });
    }
    sys.current = { sampler, terrain, baker, rig, mat, trek };
    if (import.meta.env.DEV) (window as unknown as { __hecate: unknown }).__hecate = { ...sys.current, camera, THREE, focus };
    return () => {
      disposed = true;
      offL0?.();
      offPyr();
      delete snapshotters['3d'];
      runtime.gpuSunProbe = undefined;
      runtime.gpuFocusRect = undefined;
      runtime.bake2d = undefined;
      rig.dispose();
      scene.remove(terrain.group);
      terrain.dispose();
      baker.dispose();
      sys.current = null;
    };
  }, [data, gl, camera, scene]);

  // Store-driven settings.
  useEffect(() => {
    const apply = () => {
      const s = useApp.getState();
      const sy = sys.current;
      if (!sy) return;
      const u = sy.mat.uniforms;
      u.uShadows.value = s.globe.shadows ? 1 : 0;
      u.uLighting.value = s.globe.lighting === 'albedo' ? 1 : 0;
      u.uGraticule.value = s.showGraticule ? 1 : 0;
      u.uNeutralPolar.value = s.globe.polarTerrain === 'polar' ? 1 : 0;
      u.uMorphOn.value = s.globe.morph ? 1 : 0;
      u.uDebugLod.value = s.globe.debugLod ? 1 : 0;
      sy.trek.enabled = s.globe.imagery === 'trek';
      sy.rig.active = s.view === '3d' && s.screen === 'workbench' && s.modal === null && s.tutorialStep === null;
      const q = s.globe.quality;
      sy.terrain.splitPx = q === 'high' ? 260 : q === 'low' ? 560 : 380;
      if (sy.terrain.exaggeration !== s.globe.exaggeration) {
        sy.terrain.exaggeration = s.globe.exaggeration;
        sy.terrain.invalidate();
      }
      const polar = s.globe.polarTerrain === 'polar';
      if (sy.sampler.usePolar !== polar) {
        sy.sampler.usePolar = polar;
        u.uPolarRect.value.w = polar ? 1 : 0;
        sy.terrain.refreshLevels();
        sy.terrain.invalidate((lat) => lat < -76);
      }
      furniture.getObjectByName('earth')!.visible = s.globe.showEarth;
      vectors.visible = s.globe.showVectors;
      if (runtime.data) {
        const { raster } = buildLayer(s.layer, runtime.data, s);
        const prev = u.uOverlay.value as THREE.Texture;
        if (raster && s.layer !== 'illum') {
          if (prev.userData?.canvas !== raster.canvas) {
            const t = new THREE.CanvasTexture(raster.canvas);
            t.userData.canvas = raster.canvas;
            t.minFilter = raster.smooth ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
            t.magFilter = raster.smooth ? THREE.LinearFilter : THREE.NearestFilter;
            t.generateMipmaps = raster.smooth;
            u.uOverlay.value = t;
            if (prev.userData?.canvas) prev.dispose();
          }
          u.uOverlayRect.value.set(raster.rect.x0, raster.rect.yTop, raster.rect.width, s.layerOpacity);
        } else u.uOverlayRect.value.w = 0;
      }
    };
    apply();
    return useApp.subscribe(apply);
  }, [furniture, vectors, data]);

  // Navigation hub commands.
  useEffect(
    () =>
      useApp.subscribe((s, p) => {
        if (s.navSeq === p.navSeq || !s.navCommand || s.view !== '3d') return;
        const rig = sys.current?.rig;
        if (!rig) return;
        const c = s.navCommand;
        if (c.type === 'pan') rig.navPan(c.fwd, c.right);
        else if (c.type === 'look') rig.navLook(c.dHeading, c.dTilt);
        else if (c.type === 'zoom') rig.navZoom(c.factor);
        else if (c.type === 'range') rig.navRange(c.rangeKm);
        else if (c.type === 'north') rig.flyTo(rig.latLon[0], rig.latLon[1], rig.range, 0, rig.tilt, 0.6);
        else if (c.type === 'pole') rig.flyTo(-90, 0, 230, 0, 0, 1.6);
      }),
    [],
  );

  // Markers: selection + selected sites + EVA rings + landing ellipse.
  const selection = useApp((s) => s.selection);
  const pins = useApp((s) => s.pins);
  const showEva = useApp((s) => s.showEva);
  const ellipseR = useApp((s) => s.criteria.ellipseR);
  const exaggeration = useApp((s) => s.globe.exaggeration);
  const screen = useApp((s) => s.screen);
  useEffect(() => {
    const sy = sys.current;
    markers.clear();
    const host = labelsRef.current;
    labels.current.forEach((l) => l.el.remove());
    labels.current = [];
    if (!sy || screen !== 'workbench') return;
    const add = (lat: number, lon: number, name: string, color: string, isSel: boolean) => {
      const h = sy.sampler.elevation(lat, lon, 20) * exaggeration;
      const base = surfacePoint(lat, lon, h);
      const head = surfacePoint(lat, lon, h, isSel ? 1.2 : 0.9);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([base, head]), new THREE.LineBasicMaterial({ color, depthTest: true, transparent: true, opacity: 0.95 }));
      line.userData = { base, lat, lon, h, isSel };
      markers.add(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
      dot.renderOrder = 10;
      dot.userData = { head: true, base, isSel };
      dot.position.copy(head);
      markers.add(dot);
      if (host) {
        const el = document.createElement('div');
        el.className = `globe-label${isSel ? ' sel' : ''}`;
        el.style.setProperty('--pin', color);
        el.textContent = name;
        host.appendChild(el);
        labels.current.push({ el, pos: head });
      }
    };
    for (const p of pins) add(p.lat, p.lon, p.name, p.color, false);
    if (selection) {
      add(selection.lat, selection.lon, selection.name, '#ffffff', true);
      if (showEva && selection.lat < -60) {
        for (const [r, c] of [[2, '#F0E442'], [10, '#56B4E9']] as const) {
          const loop = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(sy.sampler, selection.lat, selection.lon, r, exaggeration)), new THREE.LineDashedMaterial({ color: c, dashSize: r * 0.06, gapSize: r * 0.04 }));
          loop.computeLineDistances();
          markers.add(loop);
        }
        if (ellipseR > 0) markers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(sy.sampler, selection.lat, selection.lon, ellipseR / 1000, exaggeration, 64)), new THREE.LineBasicMaterial({ color: '#CC79A7' })));
      }
    }
  }, [selection, pins, showEva, ellipseR, exaggeration, markers, labelsRef, dataVersion, data, screen]);

  const hoverCell = useApp((s) => s.hover?.cell);
  useEffect(() => {
    const sy = sys.current;
    hoverCellGroup.clear();
    if (!sy || screen !== 'workbench' || !hoverCell) return;
    const h = hoverCell.dx / 2;
    const corners: [number, number][] = [
      [hoverCell.x - h, hoverCell.y + h],
      [hoverCell.x + h, hoverCell.y + h],
      [hoverCell.x + h, hoverCell.y - h],
      [hoverCell.x - h, hoverCell.y - h],
      [hoverCell.x - h, hoverCell.y + h],
    ];
    const pts = corners.map(([cx, cy]) => {
      const [la, lo] = polarToLatLon(cx, cy);
      return surfacePoint(la, lo, sy.sampler.elevation(la, lo, 80) * exaggeration, 0.08);
    });
    const col = hoverCell.status === 2 ? '#009E73' : hoverCell.status === 1 ? '#E69F00' : '#56B4E9';
    hoverCellGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 })));
  }, [hoverCell, exaggeration, hoverCellGroup, screen]);

  const flyTo = useApp((s) => s.flyTo);
  useEffect(() => {
    if (flyTo && sys.current) {
      sys.current.rig.flyTo(
        flyTo.lat,
        flyTo.lon,
        flyTo.rangeKm,
        flyTo.heading ?? sys.current.rig.heading,
        flyTo.tilt ?? Math.min(sys.current.rig.tilt, 50),
        flyTo.dur,
      );
    }
  }, [flyTo]);

  useEffect(() => {
    scene.add(furniture, markers, hoverCellGroup, vectors);
    return () => {
      scene.remove(furniture, markers, hoverCellGroup, vectors);
    };
  }, [scene, furniture, markers, hoverCellGroup, vectors]);

  useFrame((_, dt) => {
    const sy = sys.current;
    if (!sy || !runtime.data) return;
    const s = useApp.getState();
    if (s.screen === 'menu') sy.rig.orbit(Math.min(dt, 0.1));
    else if (s.presentation.active && s.presentation.orbit) sy.rig.orbitFocus(Math.min(dt, 0.1));
    sy.rig.update(Math.min(dt, 0.1));
    rigRangeRef.current.v = sy.rig.range;
    const cam = camera as THREE.PerspectiveCamera;
    sy.terrain.update(cam, size.height, s.view === '3d' || s.screen === 'menu' ? 7 : 2);
    sy.mat.uniforms.uLodK.value = sy.terrain.lodK;
    const [flat, flon] = sy.rig.latLon;
    sy.trek.update(flat, flon, sy.rig.range);
    sy.mat.uniforms.uTrekRect.value.copy(sy.trek.rect);

    const geo = geometryAt(s.epoch);
    const sunDir = sceneDir(geo.sun);
    const earthPos = v3(bodyToScene(geo.earth));
    sy.mat.uniforms.uSunDir.value.copy(sunDir);
    sy.mat.uniforms.uEarthDir.value.copy(earthPos.clone().normalize());
    const sunSprite = furniture.getObjectByName('sun') as THREE.Sprite;
    sunSprite.position.copy(sunDir).multiplyScalar(1.5e6);
    sunSprite.scale.setScalar(1.5e6 * 0.0093 * 6);
    const earth = furniture.getObjectByName('earth') as THREE.Mesh;
    earth.position.copy(earthPos);
    ((earth.material as THREE.ShaderMaterial).uniforms.uSun.value as THREE.Vector3).copy(sunDir);
    for (const [name, d] of [['sunArrow', sunDir], ['earthArrow', earthPos.clone().normalize()]] as const) {
      (vectors.getObjectByName(name) as THREE.ArrowHelper).setDirection(d);
      const ring = vectors.getObjectByName(`${name}Ring`)!;
      ring.position.copy(d).multiplyScalar(R_MOON_KM + 12);
      ring.lookAt(d.clone().multiplyScalar(R_MOON_KM * 2));
    }

    // View-dependent focus bake: finest LOLA level matching the camera range (down to 5 m).
    const lb = lastBake.current;
    const usePolar = s.globe.polarTerrain === 'polar';
    const f = focus.current;
    if (usePolar && flat < -79.3 && sy.rig.range < 260) {
      const width = Math.max(4000, Math.min(300000, sy.rig.range * 1000 * 3));
      const k = levelForTexel(width / 1024);
      const [fx, fy] = latLonToPolar(flat, flon);
      const stale = !f || f.k !== k || Math.hypot(fx - f.cx, fy - f.cy) > 0.22 * f.width || f.dirty;
      if (stale && !(f && f.busy)) {
        const job = { busy: true, cx: fx, cy: fy, width: 1024 * 5 * 2 ** k, k, dirty: false };
        focus.current = job;
        void buildMosaic(runtime.data.regional.pyr, runtime.data.regional.dem, fx, fy, k, 1024).then((m) => {
          if (focus.current !== job || !sys.current) return;
          const rect = { x0: m.grid.x0, yTop: m.grid.y0, width: m.grid.n * m.grid.dx_m };
          sys.current.baker.setFocus(rect, { data: m.data, grid: m.grid });
          sys.current.mat.uniforms.uFocusRect.value.set(rect.x0, rect.yTop, rect.width, 1);
          job.busy = false;
          lb.force = true;
        });
      }
    } else if (f) {
      focus.current = null;
      sy.baker.setFocus(null, null);
      sy.mat.uniforms.uFocusRect.value.w = 0;
    }
    const now = performance.now();
    if (s.globe.shadows && (s.view === '3d' || s.screen === 'menu') && (s.epoch !== lb.epoch || !lb.globalReady || lb.force) && now - lb.t > 110) {
      lb.n++;
      const playing = s.playing;
      const ms = sy.baker.bake(normalize(geo.sun), geo.earth, { global: !playing || lb.n % 3 === 0 || !lb.globalReady, polar: !playing || lb.n % 2 === 0 || lb.force, focus: true });
      lb.t = now;
      lb.epoch = s.epoch;
      lb.globalReady = true;
      lb.force = false;
      s.perf.shadowMs = ms;
    }

    // Marker scaling & labels.
    const camPos = cam.position;
    const host = labelsRef.current;
    for (const o of markers.children) {
      const ud = o.userData as { head?: boolean; base?: THREE.Vector3; isSel?: boolean };
      if (!ud.base) continue;
      const dist = camPos.distanceTo(ud.base);
      const lift = Math.max(0.03, dist * (ud.isSel ? 0.07 : 0.055));
      const head = ud.base.clone().add(ud.base.clone().normalize().multiplyScalar(lift));
      if (ud.head) {
        o.position.copy(head);
        o.scale.setScalar(Math.max(0.002, dist * 0.004));
      } else if ((o as THREE.Line).geometry) {
        const g = (o as THREE.Line).geometry as THREE.BufferGeometry;
        const a = g.getAttribute('position') as THREE.BufferAttribute;
        if (a.count === 2) {
          a.setXYZ(1, head.x, head.y, head.z);
          a.needsUpdate = true;
          g.computeBoundingSphere();
        }
      }
    }
    if (host) {
      const w = size.width, h = size.height;
      let li = 0;
      for (const o of markers.children) {
        const ud = o.userData as { head?: boolean; base?: THREE.Vector3 };
        if (!ud.head) continue;
        const lab = labels.current[li++];
        if (!lab) continue;
        const p = o.position.clone();
        const facing = p.clone().normalize().dot(camPos.clone().sub(p).normalize()) > -0.15;
        const ndc = p.clone().project(cam);
        const on = facing && ndc.z < 1 && Math.abs(ndc.x) < 1.1 && Math.abs(ndc.y) < 1.1 && s.view === '3d' && s.showLabels && s.screen === 'workbench';
        lab.el.style.display = on ? 'block' : 'none';
        if (on) lab.el.style.transform = `translate(${((ndc.x + 1) / 2) * w}px, ${((1 - ndc.y) / 2) * h}px)`;
      }
    }

    // Publish camera state (HUD), resolution indicator and perf at modest rates.
    const acc = fpsAcc.current;
    acc.n++;
    acc.t += dt;
    acc.pub += dt;
    acc.res += dt;
    if (acc.pub > 0.1 && s.view === '3d') {
      acc.pub = 0;
      const mPerPx = (sy.rig.range * 1000 * 2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, size.height);
      const c = s.cam;
      if (Math.abs(c.lat - flat) > 1e-5 || Math.abs(c.lon - flon) > 1e-5 || Math.abs(c.rangeKm - sy.rig.range) / sy.rig.range > 0.002 || Math.abs(c.heading - sy.rig.heading) > 0.05 || Math.abs(c.tilt - sy.rig.tilt) > 0.05)
        s.set({ cam: { lat: flat, lon: flon, rangeKm: sy.rig.range, heading: sy.rig.heading, tilt: sy.rig.tilt, mPerPx } });
    }
    if (acc.res > 0.5 && s.view === '3d' && s.screen === 'workbench') {
      acc.res = 0;
      const src = sy.sampler.sourceAt(flat, flon);
      const hit = (() => {
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(0, 0), cam);
        return rc.intersectObjects(sy.terrain.pickables(), false)[0];
      })();
      const node = hit?.object.userData.node as { sizeKm: number } | undefined;
      const meshM = node ? (node.sizeKm * 1000) / 32 : src.spacing;
      const d = runtime.data.regional;
      let measured: number | null = null, eff: number | null = null, sig: number | null = null;
      if (src.k >= 0) {
        const [x, y] = latLonToPolar(flat, flon);
        if (src.k === 0) {
          let n = 0, w = 0;
          for (let i = -10; i <= 10; i++)
            for (let j = -10; j <= 10; j++) {
              const c = d.pyr.count(x + j * 25, y + i * 25);
              if (c >= 0) { n++; if (c > 0) w++; }
            }
          measured = n ? (100 * w) / n : null;
          const sp = d.pyr.sigma(x, y);
          sig = Number.isNaN(sp) ? d.err.sample(x, y) : sp;
        } else {
          sig = d.err.sample(x, y);
        }
        const e = d.effres.sample(x, y);
        eff = Number.isNaN(e) ? null : src.k === 0 ? Math.min(e, 25) : e;
      }
      const imagery = sy.trek.status !== 'off' ? sy.trek.status : src.k >= 0 && usePolar ? 'relief shading from LOLA + LROC WAC polar mosaic (4k)' : 'LROC WAC global mosaic 4k (~2.7 km/px)';
      const r = { source: src.label, sourceM: src.spacing, meshM: Math.max(meshM, 0.1), effectiveM: eff, measuredPct: measured, sigmaZ: sig != null && Number.isFinite(sig) ? sig : null, imagery };
      const prev = s.resolution;
      if (!prev || prev.source !== r.source || Math.abs(prev.meshM - r.meshM) > 0.5 || prev.imagery !== r.imagery || prev.measuredPct !== r.measuredPct || prev.effectiveM !== r.effectiveM) s.set({ resolution: r });
    }
    if (acc.t > 0.5) {
      const st = sy.terrain.stats;
      s.set({ perf: { fps: acc.n / acc.t, tiles: st.tiles, triangles: st.triangles, shadowMs: s.perf.shadowMs } });
      acc.n = 0;
      acc.t = 0;
    }
  });

  return null;
}

export function Globe3D() {
  const labelsRef = useRef<HTMLDivElement | null>(null);
  // Pause the 3D render loop while the 2D map is shown (the GL context stays alive for 2D bakes).
  const frameloop = useApp((s) => (s.view === '2d' && s.screen === 'workbench' ? 'never' : 'always'));
  return (
    <div className="globe-wrap" data-tour="viewport">
      <Canvas
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance', preserveDrawingBuffer: false }}
        frameloop={frameloop}
        flat
        dpr={[1, 2]}
        camera={{ fov: 42, near: 0.01, far: 3e6, position: [0, 0, 6000] }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <GlobeScene labelsRef={labelsRef} />
      </Canvas>
      <div className="globe-labels" ref={labelsRef} />
    </div>
  );
}
