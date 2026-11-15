/**
 * GPU cast-shadow baker ("bespoke lunar shadow shaders", spec v2.0 sec. 7.1).
 *
 * For every texel we march along the surface toward the Sun's azimuth and keep the maximum
 * curvature-corrected elevation angle of the terrain (identical formula to the science engine's
 * ray caster), then store the visible fraction of the finite 0.53 deg solar disk.
 *
 * Bakes (roles per the 3D-mapping review):
 *   global : 2048 x 1024 equirect over the 8 ppd LOLA DEM       -> visual day / night only
 *   polar  : 2048^2 over the 320 m regional DEM (80 S -> pole)  -> preliminary regional illumination
 *   focus  : 1024^2 over a view-dependent rectangle, near field from a mosaic of the finest LOLA
 *            pyramid tiles (down to 5 m), far field from the regional DEM -> detailed local shadows
 * Output RGBA8: R = Sun disk visible fraction, G = Earth disk visibility, B = Lambert term
 * (DEM normal . Sun) used by the 2D illumination layer.
 */
import * as THREE from 'three';
import type { GridSpec } from '../../data/types';
import type { Vec3 } from '../../lib/math';

const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */ `
precision highp float;
precision highp sampler2D;
const float PI = 3.141592653589793;
const float R = 1737400.0;
const float SUN_R = 0.2666;
float diskFraction(float el, float h, float r) {
  float x = (el - h) / r;
  if (x >= 1.0) return 1.0;
  if (x <= -1.0) return 0.0;
  return (acos(-x) + x * sqrt(1.0 - x * x)) / PI;
}`;

const GLOBAL_FS = /* glsl */ `
${COMMON}
uniform sampler2D uDem;
uniform vec2 uDemSize;
uniform vec3 uSun;
varying vec2 vUv;
float tex(int x, int y) {
  int W = int(uDemSize.x), H = int(uDemSize.y);
  x = (x % W + W) % W; y = clamp(y, 0, H - 1);
  return texelFetch(uDem, ivec2(x, y), 0).r;
}
float demAt(vec3 q) {
  float lat = asin(clamp(q.z, -1.0, 1.0));
  float lon = atan(q.y, q.x);
  float px = (lon + PI) / (2.0 * PI) * uDemSize.x - 0.5;
  float py = (0.5 * PI - lat) / PI * uDemSize.y - 0.5;
  int x0 = int(floor(px)), y0 = int(floor(py));
  float fx = px - floor(px), fy = py - floor(py);
  return mix(mix(tex(x0, y0), tex(x0 + 1, y0), fx), mix(tex(x0, y0 + 1), tex(x0 + 1, y0 + 1), fx), fy);
}
void main() {
  float lat = (vUv.y - 0.5) * PI;
  float lon = (vUv.x - 0.5) * 2.0 * PI;
  vec3 P = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  float el = degrees(asin(clamp(dot(uSun, P), -1.0, 1.0)));
  if (el > 25.0) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
  if (el < -8.0) { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); return; }
  vec3 T = uSun - dot(uSun, P) * P;
  float tl = length(T);
  if (tl < 1e-6) { gl_FragColor = vec4(1.0); return; }
  T /= tl;
  float z0 = demAt(P) + 2.0;
  float hmax = -90.0;
  float psi = 1800.0 / R;
  for (int i = 0; i < 56; i++) {
    vec3 Q = cos(psi) * P + sin(psi) * T;
    float rz = R + demAt(Q);
    float th = degrees(atan(rz * cos(psi) - (R + z0), rz * sin(psi)));
    hmax = max(hmax, th);
    psi *= 1.105;
    if (psi * R > 420000.0) break;
  }
  gl_FragColor = vec4(diskFraction(el, hmax, SUN_R), 1.0, 0.0, 1.0);
}`;

const POLAR_FS = /* glsl */ `
${COMMON}
uniform sampler2D uDem1;   // far field (regional)
uniform vec4 uG1;          // x0, y0, dx, n
uniform sampler2D uDem2;   // near field (pyramid mosaic)
uniform vec4 uG2;
uniform float uHas2;
uniform vec4 uOut;         // x0, yTop, width
uniform vec3 uSun;
uniform vec3 uEarth;
uniform vec4 uSteps;       // nearStep, nearLimit, farStep, farLimit (m)
uniform float uFirst;
varying vec2 vUv;

float fetchGrid(sampler2D t, vec4 g, vec2 xy, out bool ok) {
  float c = (xy.x - g.x) / g.z - 0.5;
  float r = (g.y - xy.y) / g.z - 0.5;
  ok = c >= 0.0 && r >= 0.0 && c < g.w - 1.0 && r < g.w - 1.0;
  if (!ok) return 0.0;
  int c0 = int(floor(c)), r0 = int(floor(r));
  float fx = c - floor(c), fy = r - floor(r);
  float a = texelFetch(t, ivec2(c0, r0), 0).r, b = texelFetch(t, ivec2(c0 + 1, r0), 0).r;
  float d = texelFetch(t, ivec2(c0, r0 + 1), 0).r, e = texelFetch(t, ivec2(c0 + 1, r0 + 1), 0).r;
  ok = a > -20000.0 && b > -20000.0 && d > -20000.0 && e > -20000.0;
  return mix(mix(a, b, fx), mix(d, e, fx), fy);
}
float demAt(vec2 xy, out bool ok) {
  if (uHas2 > 0.5) {
    float v = fetchGrid(uDem2, uG2, xy, ok);
    if (ok) return v;
  }
  return fetchGrid(uDem1, uG1, xy, ok);
}
float horizon(vec2 xy, vec2 d, float z0, float k) {
  float hmax = -90.0;
  float s = uFirst;
  for (int i = 0; i < 460; i++) {
    bool ok;
    float z = demAt(xy + d * s, ok);
    if (!ok) break;
    float A = s / k;
    float psi = A / R;
    float rz = R + z;
    float th = degrees(atan(rz * cos(psi) - (R + z0), rz * sin(psi)));
    hmax = max(hmax, th);
    s += s < uSteps.y ? uSteps.x : max(uSteps.z, s * 0.02);
    if (s > uSteps.w) break;
  }
  return hmax;
}
void main() {
  vec2 xy = vec2(uOut.x + vUv.x * uOut.z, uOut.y - uOut.z + vUv.y * uOut.z);
  bool ok;
  float z0 = demAt(xy, ok);
  if (!ok) { gl_FragColor = vec4(1.0, 1.0, 0.5, 0.0); return; }
  z0 += 2.0;
  float rho = length(xy);
  float colat = 2.0 * atan(rho / (2.0 * R));
  float lat = -0.5 * PI + colat;
  float lon = atan(xy.x, xy.y);
  vec3 up = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  vec3 east = vec3(-sin(lon), cos(lon), 0.0);
  vec3 north = vec3(-sin(lat) * cos(lon), -sin(lat) * sin(lon), cos(lat));
  vec2 nmap = rho > 1.0 ? xy / rho : vec2(0.0, 1.0);
  if (rho <= 1.0) { east = vec3(0.0, 1.0, 0.0); north = vec3(1.0, 0.0, 0.0); }
  vec2 emap = vec2(nmap.y, -nmap.x);
  float k = 1.0 / pow(cos(colat * 0.5), 2.0);

  float elS = degrees(asin(clamp(dot(uSun, up), -1.0, 1.0)));
  float azS = atan(dot(uSun, east), dot(uSun, north));
  float fS;
  if (elS > 25.0) fS = 1.0;
  else if (elS < -8.0) fS = 0.0;
  else fS = diskFraction(elS, horizon(xy, cos(azS) * nmap + sin(azS) * emap, z0, k), SUN_R);

  vec3 P = up * (R + z0) / 1000.0;
  vec3 ev = uEarth - P;
  float evl = length(ev);
  float elE = degrees(asin(clamp(dot(ev, up) / evl, -1.0, 1.0)));
  float azE = atan(dot(ev, east), dot(ev, north));
  float fE;
  if (elE > 25.0) fE = 1.0;
  else if (elE < -8.0) fE = 0.0;
  else fE = diskFraction(elE, horizon(xy, cos(azE) * nmap + sin(azE) * emap, z0, k), 0.95);

  // Lambert term from the DEM gradient (map-plane normal in the local ENU frame)
  float h = (uHas2 > 0.5 ? uG2.z : uG1.z);
  bool o1, o2, o3, o4;
  float zx1 = demAt(xy + emap * h, o1), zx0 = demAt(xy - emap * h, o2);
  float zy1 = demAt(xy + nmap * h, o3), zy0 = demAt(xy - nmap * h, o4);
  float lam = 0.5;
  if (o1 && o2 && o3 && o4) {
    float dzE = (zx1 - zx0) / (2.0 * h / k), dzN = (zy1 - zy0) / (2.0 * h / k);
    vec3 n = normalize(vec3(-dzE, -dzN, 1.0));
    vec3 s = vec3(dot(uSun, east), dot(uSun, north), dot(uSun, up));
    lam = clamp(dot(n, normalize(s)), 0.0, 1.0);
  }
  gl_FragColor = vec4(fS, fE, lam, 1.0);
}`;

function floatTexture(data: Float32Array, w: number, h: number) {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

function makeRT(w: number, h: number, wrapS: THREE.Wrapping = THREE.ClampToEdgeWrapping) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  rt.texture.wrapS = wrapS;
  return rt;
}

export interface DemSource {
  data: Float32Array;
  grid: GridSpec;
}
export interface Rect {
  x0: number;
  yTop: number;
  width: number;
}

export class ShadowBaker {
  readonly globalRT = makeRT(2048, 1024, THREE.RepeatWrapping);
  readonly polarRT = makeRT(2048, 2048);
  readonly focusRT = makeRT(1024, 1024);
  private scratchRT: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private globalMat: THREE.ShaderMaterial;
  private polarMat: THREE.ShaderMaterial;
  hasGlobal = false;
  hasRegional = false;
  regionalGrid: GridSpec | null = null;
  focus: { rect: Rect; near: GridSpec | null } | null = null;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.globalMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: GLOBAL_FS,
      uniforms: { uDem: { value: null }, uDemSize: { value: new THREE.Vector2(1, 1) }, uSun: { value: new THREE.Vector3(1, 0, 0) } },
      depthTest: false, depthWrite: false,
    });
    this.polarMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: POLAR_FS,
      uniforms: {
        uDem1: { value: null }, uG1: { value: new THREE.Vector4() },
        uDem2: { value: null }, uG2: { value: new THREE.Vector4() }, uHas2: { value: 0 },
        uOut: { value: new THREE.Vector4() }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uEarth: { value: new THREE.Vector3(384400, 0, 0) },
        uSteps: { value: new THREE.Vector4(320, 10000, 640, 150000) }, uFirst: { value: 320 },
      },
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.globalMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setGlobalDem(src: Int16Array, w: number, h: number, scale: number) {
    const f = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) f[i] = src[i] * scale;
    this.globalMat.uniforms.uDem.value?.dispose?.();
    this.globalMat.uniforms.uDem.value = floatTexture(f, w, h);
    this.globalMat.uniforms.uDemSize.value.set(w, h);
    this.hasGlobal = true;
  }

  /** Regional (far-field) DEM: NaN must already be replaced by a large negative sentinel. */
  setRegionalDem(src: DemSource) {
    this.polarMat.uniforms.uDem1.value?.dispose?.();
    this.polarMat.uniforms.uDem1.value = floatTexture(src.data, src.grid.n, src.grid.n);
    this.polarMat.uniforms.uG1.value.set(src.grid.x0, src.grid.y0, src.grid.dx_m, src.grid.n);
    this.regionalGrid = src.grid;
    this.hasRegional = true;
  }

  /** Near-field mosaic for the focus bake (or null). */
  setFocus(rect: Rect | null, near: DemSource | null) {
    const u = this.polarMat.uniforms;
    if (near) {
      u.uDem2.value?.dispose?.();
      u.uDem2.value = floatTexture(near.data, near.grid.n, near.grid.n);
      u.uG2.value.set(near.grid.x0, near.grid.y0, near.grid.dx_m, near.grid.n);
    }
    this.focus = rect ? { rect, near: near?.grid ?? this.focus?.near ?? null } : null;
  }

  private run(mat: THREE.ShaderMaterial, rt: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    const prev = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAuto;
  }

  private setSunEarth(sun: Vec3, earth: Vec3) {
    const u = this.polarMat.uniforms;
    u.uSun.value.set(sun[0], sun[1], sun[2]);
    u.uEarth.value.set(earth[0], earth[1], earth[2]);
  }

  private configure(rect: Rect, useNear: boolean) {
    const u = this.polarMat.uniforms;
    u.uOut.value.set(rect.x0, rect.yTop, rect.width, 0);
    const nearDx = useNear && this.focus?.near ? this.focus.near.dx_m : 0;
    u.uHas2.value = nearDx > 0 ? 1 : 0;
    const regDx = this.regionalGrid?.dx_m ?? 320;
    if (nearDx > 0) {
      const nearLimit = Math.min(this.focus!.near!.n * nearDx * 0.5, 400 * nearDx);
      u.uSteps.value.set(nearDx, nearLimit, regDx, 150000);
      u.uFirst.value = nearDx;
    } else {
      u.uSteps.value.set(regDx, 10000, 2 * regDx, 150000);
      u.uFirst.value = regDx;
    }
  }

  /** Bake the global, polar and focus maps for a body-fixed Sun unit vector and Earth position (km). */
  bake(sun: Vec3, earth: Vec3, opts: { global: boolean; polar: boolean; focus: boolean }) {
    const t0 = performance.now();
    if (opts.global && this.hasGlobal) {
      this.globalMat.uniforms.uSun.value.set(sun[0], sun[1], sun[2]);
      this.run(this.globalMat, this.globalRT);
    }
    if (!this.hasRegional || !this.regionalGrid) return performance.now() - t0;
    this.setSunEarth(sun, earth);
    if (opts.polar) {
      const g = this.regionalGrid;
      this.configure({ x0: g.x0, yTop: g.y0, width: g.n * g.dx_m }, false);
      this.run(this.polarMat, this.polarRT);
    }
    if (opts.focus && this.focus) {
      this.configure(this.focus.rect, true);
      this.run(this.polarMat, this.focusRT);
    }
    return performance.now() - t0;
  }

  /** Bake an arbitrary rectangle (2D map illumination) and read it back as RGBA bytes. */
  bakePixels(rect: Rect, size: number, sun: Vec3, earth: Vec3, useNear: boolean): Uint8Array | null {
    if (!this.hasRegional) return null;
    if (!this.scratchRT || this.scratchRT.width !== size) {
      this.scratchRT?.dispose();
      this.scratchRT = makeRT(size, size);
    }
    this.setSunEarth(sun, earth);
    this.configure(rect, useNear);
    this.run(this.polarMat, this.scratchRT);
    const out = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(this.scratchRT, 0, 0, size, size, out);
    return out;
  }

  /** Read the focus (or polar) bake at map points (GPU side of the shadow validation). */
  sampleSun(points: [number, number][], bake: 'focus' | 'polar'): number[] | null {
    const useFocus = bake === 'focus';
    if (useFocus && !this.focus) return null;
    const rt = useFocus ? this.focusRT : this.polarRT;
    const rect = useFocus ? this.focus!.rect : this.regionalGrid ? { x0: this.regionalGrid.x0, yTop: this.regionalGrid.y0, width: this.regionalGrid.n * this.regionalGrid.dx_m } : null;
    if (!rect) return null;
    const px = new Uint8Array(4);
    return points.map(([x, y]) => {
      const u = (x - rect.x0) / rect.width, v = (y - (rect.yTop - rect.width)) / rect.width;
      if (u < 0 || v < 0 || u > 1 || v > 1) return NaN;
      this.renderer.readRenderTargetPixels(rt, Math.min(rt.width - 1, Math.floor(u * rt.width)), Math.min(rt.height - 1, Math.floor(v * rt.height)), 1, 1, px);
      return px[0] / 255;
    });
  }

  dispose() {
    this.globalRT.dispose();
    this.polarRT.dispose();
    this.focusRT.dispose();
    this.scratchRT?.dispose();
    this.globalMat.dispose();
    this.polarMat.dispose();
  }
}
