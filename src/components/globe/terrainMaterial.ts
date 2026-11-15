/**
 * Terrain surface shader for the full-Moon globe.
 *
 *  - Albedo: LROC WAC equirectangular mosaic, with stereographic polar caps (|lat| > 60)
 *    re-projected on the CPU so neither pole smears (the classic equirectangular failure).
 *  - Lighting: lunar-Lambert (McEwen) blend of Lommel-Seeliger and Lambert with the true
 *    ephemeris Sun direction, plus faint earthshine.
 *  - Cast shadows: finite-disk Sun visibility baked on the GPU (ShadowBaker) at three
 *    nested scales - global (equirect, 8 ppd DEM), polar regional (320 m) and a view-dependent focus bake
 *    on the finest LOLA pyramid level matching the camera range (down to 5 m).
 *  - CDLOD vertex morphing for elevation continuity between LOD levels.
 *  - Analysis overlay: the same polar-stereographic rasters as the 2D map (slope, PSR,
 *    feasibility heatmaps...) draped on the relief.
 *  - Graticule: analytic, anti-aliased lat/lon lines (fwidth based).
 */
import * as THREE from 'three';

export const terrainVertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aBody;
attribute vec3 aMorph;   // offset to the parent-level (half resolution) grid position, km
attribute vec3 aPar;     // parent tile size (km), parent geometric radius (km), tile level
uniform float uLodK;     // viewportH / (2 tan(fov/2)) / splitPx  (same constant as the CPU split test)
uniform float uMorphOn;
varying vec3 vBody;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vLevel;
void main() {
  vBody = aBody;
  vLevel = aPar.z;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp0 = modelMatrix * vec4(position, 1.0);
  // CDLOD morph: fully coarse at the parent's split distance, so edges shared with a coarser
  // neighbour match it exactly (no elevation discontinuity, not just no crack).
  float dCam = distance(cameraPosition, wp0.xyz);
  float Dp = aPar.y + aPar.x * uLodK;
  float pad = min(12.0, 0.5 * aPar.x);
  float m = clamp((dCam - 0.7 * (Dp - pad)) / max(1e-6, 0.3 * (Dp - pad)), 0.0, 1.0) * uMorphOn;
  vec4 wp = modelMatrix * vec4(position + aMorph * m, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

export const terrainFragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uColor;
uniform sampler2D uCapS;
uniform sampler2D uCapN;
uniform float uCapRho;          // stereographic half-width of cap textures (m)
uniform vec3 uSunDir;           // scene, unit
uniform vec3 uEarthDir;         // scene, unit (for earthshine)
uniform int uLighting;          // 0 sun, 1 albedo/headlight
uniform int uShadows;
uniform sampler2D uShadowGlobal;
uniform sampler2D uShadowPolar;
uniform vec4 uPolarRect;        // x0, yTop, width, enabled
uniform sampler2D uShadowFocus;
uniform vec4 uFocusRect;        // x0, yTop, width, enabled (view-dependent fine bake)
uniform sampler2D uTrek;
uniform vec4 uTrekRect;         // lon0, lat0, dlon, dlat (radians); dlon = 0 -> off
uniform float uDebugLod;
uniform sampler2D uOverlay;
uniform vec4 uOverlayRect;      // x0, yTop, width, opacity (0 = off)
uniform float uNeutralPolar;    // 1 = polar LOLA relief active: damp the WAC mosaic's baked-in shadows so the dynamic Sun + GPU shadows dominate
uniform float uGraticule;
uniform float uExposure;
varying vec3 vBody;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vLevel;

const float R_M = 1737400.0;

vec2 stereo(float lat, float lon, float hemi) {
  // hemi = -1 south (spec projection), +1 north (mirror)
  float colat = PI * 0.5 + hemi * -lat;
  float r = 2.0 * R_M * tan(colat * 0.5);
  return vec2(r * sin(lon), r * cos(lon) * (hemi < 0.0 ? 1.0 : -1.0));
}

vec2 rectUv(vec2 xy, vec4 rect) {
  return vec2((xy.x - rect.x) / rect.z, (xy.y - (rect.y - rect.z)) / rect.z);
}
bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }

void main() {
  #include <logdepthbuf_fragment>
  vec3 b = normalize(vBody);
  float lat = asin(clamp(b.z, -1.0, 1.0));
  float lon = atan(b.y, b.x);

  // ---- albedo (equirect with seam-safe gradients + stereographic caps)
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 + lat / PI);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  if (abs(dx.x) > 0.5) dx.x -= sign(dx.x);
  if (abs(dy.x) > 0.5) dy.x -= sign(dy.x);
  vec3 albedo = toLinear(textureGrad(uColor, uv, dx, dy).rgb);
  float capW = smoothstep(55.0, 62.0, abs(lat) * 180.0 / PI);
  if (capW > 0.0) {
    float hemi = lat < 0.0 ? -1.0 : 1.0;
    vec2 xy = stereo(lat, lon, hemi);
    vec2 cuv = xy / (2.0 * uCapRho) + 0.5;
    vec3 capc = lat < 0.0 ? texture(uCapS, cuv).rgb : texture(uCapN, cuv).rgb;
    albedo = mix(albedo, toLinear(capc), capW);
  }

  // Streamed LROC WAC imagery (NASA Moon Trek, ~100 m) for the view region when available
  if (uTrekRect.z > 0.0) {
    float dl = lon - uTrekRect.x;
    dl = dl - 2.0 * PI * floor((dl + PI) / (2.0 * PI));
    vec2 tuv = vec2(dl / uTrekRect.z, (lat - uTrekRect.y) / uTrekRect.w);
    if (inside(tuv)) {
      float e = min(min(tuv.x, 1.0 - tuv.x), min(tuv.y, 1.0 - tuv.y));
      vec3 tc = toLinear(texture(uTrek, tuv).rgb);
      albedo = mix(albedo, tc, smoothstep(0.0, 0.04, e) * (1.0 - smoothstep(72.0, 78.0, abs(lat) * 180.0 / PI)));
    }
  }

  vec2 sxy = stereo(lat, lon, -1.0);
  float rho = length(sxy);
  if (uNeutralPolar > 0.5 && lat < 0.0) {
    float w = 1.0 - smoothstep(296000.0, 318000.0, rho);
    float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(albedo, vec3(mix(0.11, lum, 0.5)), w * 0.6);
  }

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 color;
  if (uLighting == 1) {
    float hl = 0.35 + 0.65 * max(dot(N, V), 0.0);
    color = albedo * hl * 1.6;
  } else {
    float mu0 = dot(N, uSunDir);
    float mu = max(dot(N, V), 0.0);
    float refl = 0.0;
    if (mu0 > 0.0) refl = mix(mu0, 2.0 * mu0 / (mu0 + mu + 1e-4), 0.55);
    float vis = 1.0;
    if (uShadows == 1) {
      vec2 guv = vec2(lon / (2.0 * PI) + 0.5, 0.5 + lat / PI);
      vis = texture(uShadowGlobal, guv).r;
      if (uPolarRect.w > 0.5 && lat < -1.2) {
        vec2 puv = rectUv(sxy, uPolarRect);
        if (inside(puv)) {
          float wp = 1.0 - smoothstep(296000.0, 318000.0, rho);
          vis = mix(vis, texture(uShadowPolar, puv).r, wp);
        }
      }
      if (uFocusRect.w > 0.5 && lat < -1.2) {
        vec2 luv = rectUv(sxy, uFocusRect);
        if (inside(luv)) {
          float e = min(min(luv.x, 1.0 - luv.x), min(luv.y, 1.0 - luv.y));
          vis = mix(vis, texture(uShadowFocus, luv).r, smoothstep(0.0, 0.05, e));
        }
      }
    }
    float earthshine = 0.03 * max(dot(N, uEarthDir), 0.0) + 0.008;
    color = albedo * (refl * vis * 2.4 + earthshine);
  }

  // ---- analysis overlay (polar stereographic raster)
  if (uOverlayRect.w > 0.0 && lat < -1.2) {
    vec2 ouv = rectUv(sxy, uOverlayRect);
    if (inside(ouv)) {
      vec4 o = texture(uOverlay, ouv);
      color = mix(color, toLinear(o.rgb) * 0.9, o.a * uOverlayRect.w);
    }
  }

  // ---- graticule: 10 deg lines globally, 1 deg lines poleward of 80 deg
  if (uGraticule > 0.0) {
    float latD = lat * 180.0 / PI, lonD = lon * 180.0 / PI;
    float g = 0.0;
    float step10 = 10.0;
    vec2 q = vec2(latD, lonD) / step10;
    vec2 fw = fwidth(q);
    vec2 gl = abs(fract(q - 0.5) - 0.5) / max(fw, 1e-5);
    g = max(g, 1.0 - min(min(gl.x, gl.y), 1.0));
    if (abs(latD) > 79.5) {
      vec2 q1 = vec2(latD, lonD / 3.0);
      vec2 fw1 = fwidth(q1);
      vec2 g1 = abs(fract(q1 - 0.5) - 0.5) / max(fw1, 1e-5);
      g = max(g, 0.45 * (1.0 - min(min(g1.x, g1.y), 1.0)));
    }
    color += vec3(0.020, 0.026, 0.034) * g * uGraticule;
  }

  if (uDebugLod > 0.5) {
    float L = vLevel;
    vec3 dbg = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + L * 0.137));
    color = mix(color, dbg * 0.6, 0.55);
  }
  color *= uExposure;
  gl_FragColor = vec4(pow(max(color, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

export function createTerrainMaterial(): THREE.ShaderMaterial {
  const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blank.needsUpdate = true;
  const clear = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  clear.needsUpdate = true;
  const grey = new THREE.DataTexture(new Uint8Array([140, 140, 140, 255]), 1, 1);
  grey.needsUpdate = true;
  return new THREE.ShaderMaterial({
    vertexShader: terrainVertex,
    fragmentShader: terrainFragment,
    uniforms: {
      uColor: { value: grey },
      uCapS: { value: grey },
      uCapN: { value: grey },
      uCapRho: { value: 1_000_000 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uEarthDir: { value: new THREE.Vector3(1, 0, 0) },
      uLighting: { value: 0 },
      uShadows: { value: 1 },
      uShadowGlobal: { value: blank },
      uShadowPolar: { value: blank },
      uPolarRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uShadowFocus: { value: blank },
      uFocusRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uTrek: { value: grey },
      uTrekRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uDebugLod: { value: 0 },
      uLodK: { value: 1 },
      uMorphOn: { value: 1 },
      uOverlay: { value: clear },
      uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uNeutralPolar: { value: 1 },
      uGraticule: { value: 1 },
      uExposure: { value: 1 },
    },
  });
}
