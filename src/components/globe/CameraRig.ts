/**
 * Google-Earth-Pro-style globe camera (spec v2.0 sec. 8.3).
 *
 * State: focus point (unit body-fixed vector + terrain elevation), range (km from focus),
 * heading (deg clockwise from lunar north) and tilt (0 = nadir, -> 90 = horizon view).
 *
 *   Arrow keys          lateral move across the surface at the current altitude
 *   Shift + Up/Down     tilt between nadir look-down and horizon view
 *   Shift + Left/Right  rotate heading about the focus point
 *   PageUp/PageDown, +/-  zoom range
 *   Wheel / pinch       zoom along the ray through the cursor (cursor-anchored)
 *   Left drag           grab-and-drag the surface;  Right/Ctrl drag: heading & tilt
 *   Double click        fly toward the clicked point;  Click: select;  P: pin
 *
 * Lateral motion parallel-transports the forward vector, so crossing the pole never flips
 * the view (a lat/lon camera cannot do this).
 */
import * as THREE from 'three';
import { bodyToScene, sceneToBody, unitToLatLon } from '../../lib/geo';
import { clamp, cross, DEG, dot, normalize, R_MOON_KM, type Vec3 } from '../../lib/math';

export interface RigCallbacks {
  elevationM: (lat: number, lon: number) => number;
  pick: (ndc: THREE.Vector2) => THREE.Vector3 | null;
  onSelect: (lat: number, lon: number, shiftKey: boolean, altKey: boolean) => void;
  onHover: (lat: number, lon: number, elevM: number | null, altKey?: boolean) => void;
  onPinKey: () => void;
}

function rotate(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = normalize(axis);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

function localFrame(up: Vec3) {
  let east: Vec3;
  if (Math.abs(up[2]) > 0.999999) east = [0, 1, 0];
  else east = normalize(cross([0, 0, 1], up));
  const north = cross(up, east);
  return { east, north };
}

function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = clamp(dot(a, b), -1, 1);
  const w = Math.acos(d);
  if (w < 1e-9) return a;
  const s = Math.sin(w);
  const fa = Math.sin((1 - t) * w) / s, fb = Math.sin(t * w) / s;
  return normalize([a[0] * fa + b[0] * fb, a[1] * fa + b[1] * fb, a[2] * fa + b[2] * fb]);
}

export class CameraRig {
  focus: Vec3 = normalize([0.35, 0, -0.94]);
  focusElevKm = 0;
  range = 5200;
  heading = 0;
  tilt = 0;
  private keys = new Set<string>();
  private anim: null | { t: number; dur: number; from: { f: Vec3; r: number; h: number; tl: number }; to: { f: Vec3; r: number; h: number; tl: number } } = null;
  private drag: null | { mode: 'grab' | 'rotate'; x: number; y: number; moved: boolean; grab: Vec3 | null; grabR: number } = null;
  private ndc = new THREE.Vector2();
  active = true;
  private cleanup: (() => void)[] = [];

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement, private cb: RigCallbacks) {
    this.attach();
  }

  get latLon() {
    return unitToLatLon(this.focus);
  }

  /** Forward (heading) vector in body frame. */
  private fwd(): Vec3 {
    const { east, north } = localFrame(this.focus);
    const h = this.heading * DEG;
    return normalize([north[0] * Math.cos(h) + east[0] * Math.sin(h), north[1] * Math.cos(h) + east[1] * Math.sin(h), north[2] * Math.cos(h) + east[2] * Math.sin(h)]);
  }

  private setFromFwd(fwd: Vec3) {
    const { east, north } = localFrame(this.focus);
    this.heading = (Math.atan2(dot(fwd, east), dot(fwd, north)) / DEG + 360) % 360;
  }

  /** Rigidly rotate the rig about the Moon centre (keeps heading continuous). */
  private rotateRig(axis: Vec3, ang: number) {
    if (!Number.isFinite(ang) || Math.abs(ang) < 1e-12) return;
    const f = this.fwd();
    this.focus = normalize(rotate(this.focus, axis, ang));
    const nf = rotate(f, axis, ang);
    const up = this.focus;
    const proj = normalize([nf[0] - up[0] * dot(nf, up), nf[1] - up[1] * dot(nf, up), nf[2] - up[2] * dot(nf, up)]);
    this.setFromFwd(proj);
  }

  moveLateral(forwardKm: number, rightKm: number) {
    const up = this.focus;
    const f = this.fwd();
    const r = cross(f, up);
    const dir: Vec3 = normalize([f[0] * forwardKm + r[0] * rightKm, f[1] * forwardKm + r[1] * rightKm, f[2] * forwardKm + r[2] * rightKm]);
    const dist = Math.hypot(forwardKm, rightKm);
    if (dist === 0) return;
    this.rotateRig(cross(up, dir), dist / R_MOON_KM);
  }

  /** Navigation-hub commands (Google-Earth style). */
  navPan(fwd: number, right: number) {
    this.anim = null;
    this.moveLateral(fwd * this.range * 0.035, right * this.range * 0.035);
  }
  navLook(dHeading: number, dTilt: number) {
    this.anim = null;
    this.heading = (this.heading + dHeading + 360) % 360;
    this.tilt = clamp(this.tilt + dTilt, 0, 88);
  }
  navZoom(factor: number) {
    this.anim = null;
    this.range = clamp(this.range * factor, 0.03, 60000);
  }
  navRange(r: number) {
    this.anim = null;
    this.range = clamp(r, 0.03, 60000);
  }
  /** Slow orbit used behind the main menu. */
  orbit(dt: number) {
    if (this.anim) return;
    this.moveLateral(0, this.range * 0.012 * dt);
  }

  flyTo(lat: number, lon: number, rangeKm: number, heading = this.heading, tilt = this.tilt, dur = 1.4) {
    const cl = Math.cos(lat * DEG);
    const to: Vec3 = [cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG)];
    this.anim = { t: 0, dur, from: { f: this.focus, r: this.range, h: this.heading, tl: this.tilt }, to: { f: to, r: rangeKm, h: heading, tl: tilt } };
  }

  update(dt: number) {
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
      // Zoom out mid-flight for long hops (Google-Earth arc).
      const hop = Math.acos(clamp(dot(a.from.f, a.to.f), -1, 1)) * R_MOON_KM;
      const peak = Math.max(a.from.r, a.to.r, Math.min(hop * 1.2, 6000));
      const base = Math.exp(Math.log(a.from.r) * (1 - e) + Math.log(a.to.r) * e);
      this.range = base + (peak - Math.max(a.from.r, a.to.r)) * Math.sin(Math.PI * e) * 0.6;
      this.focus = slerp(a.from.f, a.to.f, e);
      const dh = ((a.to.h - a.from.h + 540) % 360) - 180;
      this.heading = (a.from.h + dh * e + 360) % 360;
      this.tilt = a.from.tl + (a.to.tl - a.from.tl) * e;
      if (a.t >= 1) this.anim = null;
    }
    if (this.active && this.keys.size) {
      const shift = this.keys.has('Shift');
      const sp = this.range * 0.7 * dt;
      if (!shift) {
        let fw = 0, rt = 0;
        if (this.keys.has('ArrowUp')) fw += sp;
        if (this.keys.has('ArrowDown')) fw -= sp;
        if (this.keys.has('ArrowRight')) rt += sp;
        if (this.keys.has('ArrowLeft')) rt -= sp;
        if (fw || rt) {
          this.anim = null;
          this.moveLateral(fw, rt);
        }
      } else {
        if (this.keys.has('ArrowUp')) this.tilt = clamp(this.tilt + 45 * dt, 0, 88);
        if (this.keys.has('ArrowDown')) this.tilt = clamp(this.tilt - 45 * dt, 0, 88);
        if (this.keys.has('ArrowRight')) this.heading = (this.heading + 60 * dt + 360) % 360;
        if (this.keys.has('ArrowLeft')) this.heading = (this.heading - 60 * dt + 360) % 360;
      }
      if (this.keys.has('PageUp') || this.keys.has('+') || this.keys.has('=')) this.range = clamp(this.range * Math.exp(-1.6 * dt), 0.03, 60000);
      if (this.keys.has('PageDown') || this.keys.has('-')) this.range = clamp(this.range * Math.exp(1.6 * dt), 0.03, 60000);
    }
    const [lat, lon] = this.latLon;
    const target = this.cb.elevationM(lat, lon) / 1000;
    this.focusElevKm += (target - this.focusElevKm) * Math.min(1, dt * 6);
    this.apply();
  }

  /** Compute camera pose from rig state and write it into the Three camera. */
  apply() {
    const up = this.focus;
    const f = this.fwd();
    const t = this.tilt * DEG;
    const F: Vec3 = [up[0] * (R_MOON_KM + this.focusElevKm), up[1] * (R_MOON_KM + this.focusElevKm), up[2] * (R_MOON_KM + this.focusElevKm)];
    const off: Vec3 = normalize([up[0] * Math.cos(t) - f[0] * Math.sin(t), up[1] * Math.cos(t) - f[1] * Math.sin(t), up[2] * Math.cos(t) - f[2] * Math.sin(t)]);
    let C: Vec3 = [F[0] + off[0] * this.range, F[1] + off[1] * this.range, F[2] + off[2] * this.range];
    // Terrain clearance under the camera.
    const cr = Math.hypot(...C);
    const [clat, clon] = unitToLatLon(C);
    const minR = R_MOON_KM + this.cb.elevationM(clat, clon) / 1000 + Math.max(0.004, this.range * 0.02);
    if (cr < minR) C = [(C[0] / cr) * minR, (C[1] / cr) * minR, (C[2] / cr) * minR];
    const zAxis = normalize([C[0] - F[0], C[1] - F[1], C[2] - F[2]]);
    let yHint: Vec3 = [f[0] * Math.cos(t) + up[0] * Math.sin(t), f[1] * Math.cos(t) + up[1] * Math.sin(t), f[2] * Math.cos(t) + up[2] * Math.sin(t)];
    const xAxis = normalize(cross(yHint, zAxis));
    yHint = cross(zAxis, xAxis);
    const s = (v: Vec3) => new THREE.Vector3(...bodyToScene(v));
    const m = new THREE.Matrix4().makeBasis(s(xAxis), s(yHint), s(zAxis));
    this.camera.position.copy(s(C));
    this.camera.quaternion.setFromRotationMatrix(m);
    const alt = Math.max(0.001, Math.hypot(...C) - (R_MOON_KM + this.focusElevKm));
    this.camera.near = clamp(alt * 0.2, 0.0005, 50);
    this.camera.far = 3e6;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private toNdc(e: { clientX: number; clientY: number }) {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return this.ndc;
  }

  private rayHitSphere(ndc: THREE.Vector2, radius: number): Vec3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const b = o.dot(d), c = o.lengthSq() - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const tHit = -b - Math.sqrt(disc);
    if (tHit < 0) return null;
    const p = o.clone().addScaledVector(d, tHit);
    return sceneToBody([p.x, p.y, p.z]);
  }

  private pickBody(ndc: THREE.Vector2): Vec3 | null {
    const p = this.cb.pick(ndc);
    if (p) return sceneToBody([p.x, p.y, p.z]);
    return this.rayHitSphere(ndc, R_MOON_KM + this.focusElevKm);
  }

  private attach() {
    const el = this.dom;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.anim = null;
      const factor = Math.exp(clamp(e.deltaY, -300, 300) * 0.0013);
      const hit = this.pickBody(this.toNdc(e));
      const newRange = clamp(this.range * factor, 0.03, 60000);
      const realFactor = newRange / this.range;
      if (hit) {
        const hd = normalize(hit);
        const frac = 1 - realFactor;
        const ang = Math.acos(clamp(dot(this.focus, hd), -1, 1));
        if (ang > 1e-9 && ang < Math.PI / 2) this.rotateRig(cross(this.focus, hd), ang * frac);
      }
      this.range = newRange;
    };
    const onDown = (e: PointerEvent) => {
      if (!this.active) return;
      el.setPointerCapture(e.pointerId);
      this.anim = null;
      const rotateMode = e.button === 2 || e.button === 1 || e.ctrlKey;
      const grab = rotateMode ? null : this.pickBody(this.toNdc(e));
      this.drag = { mode: rotateMode ? 'rotate' : 'grab', x: e.clientX, y: e.clientY, moved: false, grab, grabR: grab ? Math.hypot(...grab) : 0 };
    };
    const onMove = (e: PointerEvent) => {
      const ndc = this.toNdc(e);
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        if (this.drag.mode === 'rotate') {
          this.heading = (this.heading - dx * 0.3 + 360) % 360;
          this.tilt = clamp(this.tilt - dy * 0.25, 0, 88);
          this.drag.x = e.clientX;
          this.drag.y = e.clientY;
        } else if (this.drag.grab) {
          this.apply();
          const now = this.rayHitSphere(ndc, this.drag.grabR);
          if (now) {
            const a = normalize(now), b = normalize(this.drag.grab);
            const ang = Math.acos(clamp(dot(a, b), -1, 1));
            if (ang > 1e-10) this.rotateRig(cross(a, b), ang);
          }
        }
        return;
      }
      const hit = this.cb.pick(ndc);
      if (hit) {
        const [lat, lon] = unitToLatLon(sceneToBody([hit.x, hit.y, hit.z]));
        this.cb.onHover(lat, lon, (hit.length() - R_MOON_KM) * 1000, e.altKey);
      } else this.cb.onHover(NaN, NaN, null);
    };
    const onUp = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved && e.button === 0) {
        const hit = this.pickBody(this.toNdc(e));
        if (hit) {
          const [lat, lon] = unitToLatLon(hit);
          this.cb.onSelect(lat, lon, e.shiftKey, e.altKey);
        }
      }
    };
    const onDbl = (e: MouseEvent) => {
      const hit = this.pickBody(this.toNdc(e));
      if (!hit) return;
      const [lat, lon] = unitToLatLon(hit);
      this.flyTo(lat, lon, Math.max(0.05, this.range * 0.35), this.heading, this.tilt, 0.9);
    };
    const typing = (t: EventTarget | null) => {
      const n = t as HTMLElement | null;
      if (!n) return false;
      if (n.tagName === 'INPUT') {
        return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((n as HTMLInputElement).type);
      }
      return n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable;
    };
    const keyName = (e: KeyboardEvent) => (e.key === '+' || e.key === '=' || e.key === '-' ? e.key : e.key);
    const onKey = (e: KeyboardEvent) => {
      if (!this.active) {
        this.keys.clear();
        return;
      }
      if (typing(e.target)) return;
      const k = keyName(e);
      if (k === 'Shift') {
        this.keys.add('Shift');
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', '+', '=', '-'].includes(k)) {
        e.preventDefault();
        if (!e.repeat && (k === 'PageUp' || k === 'PageDown')) {
          this.navZoom(k === 'PageUp' ? 0.84 : 1 / 0.84);
        }
        this.keys.add(k);
        if (e.shiftKey) this.keys.add('Shift');
      }
      if ((k === 'p' || k === 'P') && !e.ctrlKey && !e.metaKey) this.cb.onPinKey();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(keyName(e));
      if (e.key === 'Shift') this.keys.delete('Shift');
    };
    const onBlur = () => this.keys.clear();
    const noCtx = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('contextmenu', noCtx);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.cleanup.push(() => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('dblclick', onDbl);
      el.removeEventListener('contextmenu', noCtx);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    });
  }

  dispose() {
    this.cleanup.forEach((f) => f());
  }
}
