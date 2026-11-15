/**
 * Whole-Moon chunked-LOD terrain (replaces the v1 South-Pole-only mesh).
 *
 * Geometry: a cube-sphere quadtree - six cube faces, equal-angle warped (tan(s pi/4)) and
 * normalised onto the sphere. Unlike a lat/lon grid this has no singular poles, and the
 * lunar South Pole sits exactly at the centre of the -Z face, where tessellation is most
 * uniform. Each node is a 32 x 32-segment patch displaced by ElevationSampler (L2 > L1 > L0),
 * with skirts to hide T-junction cracks between LOD levels.
 *
 * LOD: split when the node's projected size exceeds a screen-space threshold (quality
 * setting) and the data under it justifies more vertices (maxLevelAt). Children replace
 * a parent only once all four are built, so no holes appear while streaming. Horizon and
 * frustum culling skip hidden nodes; an LRU cap bounds GPU memory.
 *
 * Precision: vertex positions are stored relative to each tile centre (mesh.position holds
 * the centre in float64 JS), so 5 m relief stays jitter-free at 1 737 km from the origin.
 */
import * as THREE from 'three';
import { bodyToScene } from '../../lib/geo';
import { R_MOON_KM, RAD, type Vec3 } from '../../lib/math';
import type { ElevationSampler } from './ElevationSampler';

const N = 32; // segments per tile edge
const V = N + 1;
const G = N + 3; // sample grid incl. 1-vertex border for normals

export const FACES: { n: Vec3; u: Vec3; v: Vec3 }[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [0, 1, 0], v: [-1, 0, 0] },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
];

export function faceDir(face: number, s: number, t: number, out: Vec3) {
  const f = FACES[face];
  const a = Math.tan((s * Math.PI) / 4), b = Math.tan((t * Math.PI) / 4);
  const x = f.n[0] + a * f.u[0] + b * f.v[0];
  const y = f.n[1] + a * f.u[1] + b * f.v[1];
  const z = f.n[2] + a * f.u[2] + b * f.v[2];
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

function buildIndex(): THREE.BufferAttribute {
  const idx: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  // Skirts: perimeter traversed CCW (seen from outside), skirt vertices appended after the grid.
  const ring = perimeter();
  const base = V * V;
  for (let k = 0; k < ring.length; k++) {
    const e0 = ring[k], e1 = ring[(k + 1) % ring.length];
    const k0 = base + k, k1 = base + ((k + 1) % ring.length);
    idx.push(e0, k0, e1, e1, k0, k1);
  }
  return new THREE.BufferAttribute(new Uint32Array(idx), 1);
}

function perimeter(): number[] {
  const r: number[] = [];
  for (let i = 0; i < N; i++) r.push(i); // bottom j=0, i 0..N-1
  for (let j = 0; j < N; j++) r.push(j * V + N); // right i=N
  for (let i = N; i > 0; i--) r.push(N * V + i); // top j=N
  for (let j = N; j > 0; j--) r.push(j * V); // left i=0
  return r;
}
const PERIM = perimeter();

class Node {
  children: Node[] | null = null;
  mesh: THREE.Mesh | null = null;
  center = new THREE.Vector3();
  /** Culling radius (geometry + relief pad). */
  radius = 0;
  /** Geometric half-extent used for the LOD screen-space metric. */
  geomRadius = 0;
  building = false;
  dirty = false;
  pending: Set<string> | null = null;
  lastUsed = 0;
  maxLevel = 8;
  sizeKm: number;
  constructor(public face: number, public level: number, public ix: number, public iy: number, public parent: Node | null) {
    this.sizeKm = ((Math.PI / 2) * R_MOON_KM) / (1 << level);
  }
  get s0() { return -1 + (2 * this.ix) / (1 << this.level); }
  get t0() { return -1 + (2 * this.iy) / (1 << this.level); }
  get span() { return 2 / (1 << this.level); }
}

export interface TerrainStats {
  tiles: number;
  triangles: number;
  built: number;
  queue: number;
}

export class TerrainSystem {
  readonly group = new THREE.Group();
  private roots: Node[];
  private index = buildIndex();
  private frame = 0;
  private live = new Set<Node>();
  exaggeration = 1;
  splitPx = 380;
  maxTiles = 1600;
  stats: TerrainStats = { tiles: 0, triangles: 0, built: 0, queue: 0 };
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private tmpSphere = new THREE.Sphere();

  constructor(private sampler: ElevationSampler, readonly material: THREE.Material) {
    this.roots = FACES.map((_, f) => new Node(f, 0, 0, 0, null));
    for (const r of this.roots) {
      this.initBounds(r);
      this.buildNode(r);
    }
  }

  private initBounds(n: Node) {
    const d: Vec3 = [0, 0, 0];
    faceDir(n.face, n.s0 + n.span / 2, n.t0 + n.span / 2, d);
    const [lat, lon] = [Math.asin(d[2]) * RAD, Math.atan2(d[1], d[0]) * RAD];
    const c = bodyToScene(d);
    n.center.set(c[0], c[1], c[2]).multiplyScalar(R_MOON_KM);
    // Bound the patch by the farthest of its 4 corners and 4 edge midpoints: with the equal-angle
    // warp the tile centre is not equidistant from its corners (a tile touching the face centre -
    // e.g. the South Pole - reaches farther on that side). +12 km covers the lunar relief range.
    const q: Vec3 = [0, 0, 0];
    let far = 0;
    for (const [fs, ft] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
      faceDir(n.face, n.s0 + fs * n.span, n.t0 + ft * n.span, q);
      const qq = bodyToScene(q);
      far = Math.max(far, n.center.distanceTo(new THREE.Vector3(qq[0], qq[1], qq[2]).multiplyScalar(R_MOON_KM)));
    }
    n.geomRadius = far * 1.02;
    n.radius = n.geomRadius + 12;
    n.maxLevel = this.sampler.maxLevelAt(lat, lon, n.geomRadius * 1000);
  }

  /** Synchronous tile build: sample elevations, compute normals, write geometry. */
  private buildNode(n: Node) {
    const pos = new Float64Array(G * G * 3);
    const dirs = new Float32Array(G * G * 3);
    const d: Vec3 = [0, 0, 0];
    const spacingM = (n.sizeKm * 1000) / N;
    const missing = new Set<string>();
    const ex = this.exaggeration;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const s = n.s0 + ((i - 1) / N) * n.span;
        const t = n.t0 + ((j - 1) / N) * n.span;
        faceDir(n.face, s, t, d);
        const lat = Math.asin(d[2]) * RAD, lon = Math.atan2(d[1], d[0]) * RAD;
        const h = this.sampler.elevation(lat, lon, spacingM, missing);
        const r = R_MOON_KM + (h * ex) / 1000;
        const k = (j * G + i) * 3;
        // scene coords: (bx, bz, -by)
        pos[k] = d[0] * r; pos[k + 1] = d[2] * r; pos[k + 2] = -d[1] * r;
        dirs[k] = d[0]; dirs[k + 1] = d[1]; dirs[k + 2] = d[2];
      }
    }
    const ci = ((N / 2 + 1) * G + N / 2 + 1) * 3;
    const cx = pos[ci], cy = pos[ci + 1], cz = pos[ci + 2];
    const nv = V * V + PERIM.length;
    const P = new Float32Array(nv * 3), Nr = new Float32Array(nv * 3), B = new Float32Array(nv * 3);
    const Mo = new Float32Array(nv * 3), Pa = new Float32Array(nv * 3);
    const at = (i: number, j: number) => ((j + 1) * G + (i + 1)) * 3;
    // CDLOD morph target: position of the vertex on the parent's (half-resolution) grid.
    // even/even = shared vertex; odd along one axis = edge midpoint; odd/odd = midpoint of the
    // parent quad diagonal (matches the index-buffer split a-b-d / a-d-c).
    const coarse = (i: number, j: number, c: number) => {
      const oi = i & 1, oj = j & 1;
      if (!oi && !oj) return pos[at(i, j) + c];
      if (oi && !oj) return 0.5 * (pos[at(i - 1, j) + c] + pos[at(i + 1, j) + c]);
      if (!oi && oj) return 0.5 * (pos[at(i, j - 1) + c] + pos[at(i, j + 1) + c]);
      return 0.5 * (pos[at(i - 1, j - 1) + c] + pos[at(i + 1, j + 1) + c]);
    };
    const parentSize = n.parent ? n.parent.sizeKm : 1e9;
    const parentR = n.parent ? n.parent.geomRadius : 0;
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < V; i++) {
        const g = at(i, j);
        const o = (j * V + i) * 3;
        P[o] = pos[g] - cx; P[o + 1] = pos[g + 1] - cy; P[o + 2] = pos[g + 2] - cz;
        B[o] = dirs[g]; B[o + 1] = dirs[g + 1]; B[o + 2] = dirs[g + 2];
        for (let c = 0; c < 3; c++) Mo[o + c] = n.parent ? coarse(i, j, c) - pos[g + c] : 0;
        Pa[o] = parentSize; Pa[o + 1] = parentR; Pa[o + 2] = n.level;
        const gr = g + 3, gl = g - 3, gu = g + G * 3, gd = g - G * 3;
        const ax = pos[gr] - pos[gl], ay = pos[gr + 1] - pos[gl + 1], az = pos[gr + 2] - pos[gl + 2];
        const bx = pos[gu] - pos[gd], by = pos[gu + 1] - pos[gd + 1], bz = pos[gu + 2] - pos[gd + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        Nr[o] = nx; Nr[o + 1] = ny; Nr[o + 2] = nz;
      }
    }
    const skirt = Math.max(0.05, n.sizeKm * 0.015) * Math.max(1, ex);
    for (let k = 0; k < PERIM.length; k++) {
      const src = PERIM[k] * 3;
      const o = (V * V + k) * 3;
      const bx = B[src], by = B[src + 1], bz = B[src + 2];
      const sx = bx, sy = bz, sz = -by; // scene dir
      P[o] = P[src] - sx * skirt; P[o + 1] = P[src + 1] - sy * skirt; P[o + 2] = P[src + 2] - sz * skirt;
      Nr[o] = Nr[src]; Nr[o + 1] = Nr[src + 1]; Nr[o + 2] = Nr[src + 2];
      B[o] = bx; B[o + 1] = by; B[o + 2] = bz;
      Mo[o] = Mo[src]; Mo[o + 1] = Mo[src + 1]; Mo[o + 2] = Mo[src + 2];
      Pa[o] = Pa[src]; Pa[o + 1] = Pa[src + 1]; Pa[o + 2] = Pa[src + 2];
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(Nr, 3));
    geom.setAttribute('aBody', new THREE.BufferAttribute(B, 3));
    geom.setAttribute('aMorph', new THREE.BufferAttribute(Mo, 3));
    geom.setAttribute('aPar', new THREE.BufferAttribute(Pa, 3));
    geom.setIndex(this.index);
    geom.computeBoundingSphere();
    if (n.mesh) {
      n.mesh.geometry.dispose();
      n.mesh.geometry = geom;
    } else {
      n.mesh = new THREE.Mesh(geom, this.material);
      n.mesh.frustumCulled = false;
      n.mesh.matrixAutoUpdate = false;
      n.mesh.userData.node = n;
      this.group.add(n.mesh);
      this.live.add(n);
    }
    n.mesh.position.set(cx, cy, cz);
    n.mesh.updateMatrix();
    n.mesh.updateMatrixWorld(true);
    n.center.set(cx, cy, cz);
    n.pending = missing.size ? missing : null;
    n.dirty = false;
    this.stats.built++;
  }

  private ensureChildren(n: Node) {
    if (n.children) return;
    const l = n.level + 1;
    n.children = [
      new Node(n.face, l, n.ix * 2, n.iy * 2, n),
      new Node(n.face, l, n.ix * 2 + 1, n.iy * 2, n),
      new Node(n.face, l, n.ix * 2, n.iy * 2 + 1, n),
      new Node(n.face, l, n.ix * 2 + 1, n.iy * 2 + 1, n),
    ];
    for (const c of n.children) this.initBounds(c);
  }

  /** Mark tiles for rebuild (new data level arrived, exaggeration change...). */
  invalidate(pred: (lat: number, lon: number, n: { level: number }) => boolean = () => true) {
    for (const n of this.live) {
      const c = n.center;
      const lat = Math.asin(Math.max(-1, Math.min(1, c.y / c.length()))) * RAD;
      const lon = Math.atan2(-c.z, c.x) * RAD;
      if (pred(lat, lon, n)) n.dirty = true;
    }
    for (const r of this.roots) this.initBoundsRec(r);
  }
  private initBoundsRec(n: Node) {
    n.maxLevel = (() => {
      const d: Vec3 = [0, 0, 0];
      faceDir(n.face, n.s0 + n.span / 2, n.t0 + n.span / 2, d);
      return this.sampler.maxLevelAt(Math.asin(d[2]) * RAD, Math.atan2(d[1], d[0]) * RAD, n.geomRadius * 1000);
    })();
    n.children?.forEach((c) => this.initBoundsRec(c));
  }

  onTileArrived(key: string) {
    for (const n of this.live) if (n.pending?.has(key)) n.dirty = true;
  }

  /** Re-evaluate data-driven max levels (e.g. when the polar/global terrain toggle changes). */
  refreshLevels() {
    for (const r of this.roots) this.initBoundsRec(r);
  }

  /** LOD split constant K = viewportH / (2 tan(fov/2)) / splitPx, shared with the morph shader. */
  lodK = 1;

  update(camera: THREE.PerspectiveCamera, viewportH: number, budgetMs = 7) {
    this.frame++;
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const camPos = camera.position;
    const camDist = camPos.length();
    const rOcc = R_MOON_KM - 9.5;
    const horizonAng = camDist > rOcc ? Math.acos(rOcc / camDist) : Math.PI;
    const k = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.lodK = k / this.splitPx;
    const want: Node[] = [];
    let tiles = 0;

    const hideSubtree = (n: Node) => {
      if (n.mesh) n.mesh.visible = false;
      n.children?.forEach(hideSubtree);
    };
    const visible = (n: Node) => {
      this.tmpSphere.set(n.center, n.radius);
      if (!this.frustum.intersectsSphere(this.tmpSphere)) return false;
      if (camDist <= rOcc) return true;
      const cl = n.center.length();
      const ang = Math.acos(Math.max(-1, Math.min(1, n.center.dot(camPos) / (cl * camDist))));
      const extra = Math.acos(Math.min(1, rOcc / (cl + 10))) + n.radius / cl;
      return ang < horizonAng + extra;
    };
    const projected = (n: Node) => {
      const d = Math.max(0.002, camPos.distanceTo(n.center) - n.geomRadius);
      return (n.sizeKm / d) * k;
    };
    const show = (n: Node) => {
      if (!n.mesh) return;
      n.mesh.visible = true;
      n.lastUsed = this.frame;
      tiles++;
      if (n.dirty && !n.building) want.push(n);
      n.children?.forEach(hideSubtree);
    };
    const visit = (n: Node) => {
      n.lastUsed = this.frame;
      if (!visible(n)) {
        hideSubtree(n);
        return;
      }
      const px = projected(n);
      const split = n.level < n.maxLevel && px > this.splitPx;
      if (split) {
        this.ensureChildren(n);
        const ready = n.children!.every((c) => c.mesh);
        if (ready) {
          if (n.mesh) n.mesh.visible = false;
          n.children!.forEach(visit);
          return;
        }
        n.children!.forEach((c) => {
          if (!c.mesh) want.push(c);
        });
      }
      show(n);
    };
    this.roots.forEach(visit);

    // Build queue: coarse & near first.
    want.sort((a, b) => a.level - b.level || camPos.distanceTo(a.center) - camPos.distanceTo(b.center));
    const t0 = performance.now();
    let i = 0;
    for (; i < want.length; i++) {
      if (performance.now() - t0 > budgetMs && i > 0) break;
      this.buildNode(want[i]);
    }
    this.stats.queue = want.length - i;
    this.evict();
    this.stats.tiles = tiles;
    this.stats.triangles = tiles * (2 * N * N);
  }

  /** LRU eviction by whole sibling groups (a parent's four children go together). */
  private evict() {
    if (this.live.size <= this.maxTiles) return;
    const stale = this.frame - 2;
    const parents = new Set<Node>();
    for (const n of this.live) if (n.parent && n.lastUsed < stale) parents.add(n.parent);
    const newest = (p: Node) => Math.max(...p.children!.map((c) => c.lastUsed));
    const cands = [...parents].filter((p) => p.children && p.children.every((c) => c.lastUsed < stale)).sort((a, b) => newest(a) - newest(b));
    for (const p of cands) {
      if (this.live.size <= this.maxTiles * 0.85) break;
      p.children!.forEach((c) => this.dropSubtree(c));
      p.children = null;
    }
  }

  private dropSubtree(n: Node) {
    n.children?.forEach((c) => this.dropSubtree(c));
    n.children = null;
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    this.live.delete(n);
  }

  /** Visible tile meshes, for picking. */
  pickables(): THREE.Object3D[] {
    return this.group.children.filter((m) => m.visible);
  }

  dispose() {
    for (const n of this.live) n.mesh?.geometry.dispose();
    this.index = null as unknown as THREE.BufferAttribute;
    this.group.clear();
  }
}
