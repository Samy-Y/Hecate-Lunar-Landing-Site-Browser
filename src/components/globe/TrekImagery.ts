/**
 * Streamed LROC WAC imagery for the view region (3D-mapping feedback: sharper imagery when zooming).
 * NASA Moon Trek WMTS, layer LRO_WAC_Mosaic_Global_303ppd_v02 (geographic tile matrix: level z has
 * 2^(z+1) x 2^z tiles of 256 px; z = 8 ~ 83 m/px). An 8 x 8 block of tiles around the camera focus is
 * composed into a 2048^2 canvas texture whose lat/lon box is passed to the terrain shader. Poleward of
 * 75 deg the WAC mosaic is poorly illuminated, so the polar terrain keeps its relief shading instead.
 */
import * as THREE from 'three';

const BASE = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm';
const B = 8;
const PX = 256;

export class TrekImagery {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  rect = new THREE.Vector4(0, 0, 0, 0);
  private key = '';
  private gen = 0;
  enabled = true;
  status = 'off';

  constructor(anisotropy: number) {
    this.canvas.width = this.canvas.height = B * PX;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = anisotropy;
    this.texture.colorSpace = THREE.NoColorSpace;
  }

  /** Update for the camera focus (deg) and range (km). Returns the effective resolution label. */
  update(lat: number, lon: number, rangeKm: number) {
    if (!this.enabled || Math.abs(lat) > 76 || rangeKm > 2600) {
      this.rect.z = 0;
      this.status = 'off';
      this.key = '';
      return;
    }
    const footprint = Math.max(5, rangeKm * 2.4);
    const z = Math.max(2, Math.min(8, Math.round(Math.log2(5458 / (footprint / 3)))));
    const cols = 2 ** (z + 1), rows = 2 ** z;
    const dLon = 360 / cols, dLat = 180 / rows;
    const col = Math.floor((((lon + 180) % 360) + 360) % 360 / dLon);
    const row = Math.floor((90 - lat) / dLat);
    const c0 = col - B / 2 + 1, r0 = Math.max(0, Math.min(rows - B, row - B / 2 + 1));
    const key = `${z}/${r0}/${c0}`;
    if (key === this.key) return;
    this.key = key;
    const gen = ++this.gen;
    const ctx = this.canvas.getContext('2d')!;
    let loaded = 0;
    for (let i = 0; i < B; i++) {
      for (let j = 0; j < B; j++) {
        const r = r0 + i;
        const c = (((c0 + j) % cols) + cols) % cols;
        if (r < 0 || r >= rows) continue;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (gen !== this.gen) return;
          ctx.drawImage(img, j * PX, i * PX, PX, PX);
          loaded++;
          this.texture.needsUpdate = true;
          if (loaded === 1) this.rect.set(((c0 * dLon - 180) * Math.PI) / 180, ((90 - (r0 + B) * dLat) * Math.PI) / 180, (B * dLon * Math.PI) / 180, (B * dLat * Math.PI) / 180);
          this.status = `LROC WAC ${Math.round((dLon / 256) * 30323)} m/px (NASA Moon Trek, z${z}, ${loaded}/${B * B} tiles)`;
        };
        img.onerror = () => void 0;
        img.src = `${BASE}/${z}/${r}/${c}.jpg`;
      }
    }
  }
}
