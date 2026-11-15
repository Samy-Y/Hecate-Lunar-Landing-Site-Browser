/**
 * Client compute engine (spec v2.0 sec. 7.1): tile streaming, horizon ray casting, Brent root finding,
 * three-part scoring, power and forward-search grid evaluation run here, off the UI thread.
 * Protocol: { type, reqId, ...payload } -> { type, reqId, result } | { type:'error' } | { type:'progress' }.
 */
import type { Criteria } from '../science/criteria';
import { forwardSearch, instantVisibility } from '../science/forwardSearch';
import { buildRegional, type RegionalData } from '../science/regional';
import { analyzeSite, findNextWindow, summarizeSite } from '../science/siteAnalysis';
import { prepareHorizon, raycastHorizon, hAt } from '../science/horizon';
import { geometryAt, sunTopo } from '../science/ephemeris';
import { diskFraction } from '../science/sunDisk';
import { polarToLatLon, siteFrame } from '../lib/geo';
import { SUN_SEMIDIAMETER_DEG } from '../lib/math';
import type { PowerParams } from '../science/power';
import type { Manifest, RegionalRaw } from '../data/types';

declare const self: { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((ev: MessageEvent) => void) | null };
let data: RegionalData | null = null;

function post(msg: unknown, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      data = buildRegional(m.manifest as Manifest, m.raw as RegionalRaw);
      post({ type: 'init', reqId: m.reqId });
      return;
    }
    if (!data) throw new Error('engine not initialised');
    switch (m.type) {
      case 'analyze': {
        const a = await analyzeSite(data, m.x, m.y, m.crit as Criteria, m.tLand, m.siteId ?? null, m.power as PowerParams);
        post({ type: 'analyze', reqId: m.reqId, result: a });
        return;
      }
      case 'findNext': {
        const r = await findNextWindow(data, m.x, m.y, m.crit as Criteria, m.from, m.days ?? 365, m.siteId ?? null);
        post({ type: 'findNext', reqId: m.reqId, result: r });
        return;
      }
      case 'forward': {
        const r = forwardSearch(data, m.crit as Criteria, m.tLand, (f) => post({ type: 'progress', reqId: m.reqId, label: 'Forward search · Sun/Earth geometry', f }));
        post({ type: 'forward', reqId: m.reqId, result: r }, [r.status.buffer, r.suit.buffer, r.conf.buffer, r.avail.buffer, r.dSun.buffer, r.dDark.buffer, r.cEarth.buffer, r.fail.buffer]);
        return;
      }
      case 'instant': {
        const r = instantVisibility(data, m.utcMs);
        post({ type: 'instant', reqId: m.reqId, result: r }, [r.sun.buffer, r.earth.buffer]);
        return;
      }
      case 'compare': {
        const crit = m.crit as Criteria;
        const rows = [];
        for (const s of m.sites as { id: string; x: number; y: number; siteId: string | null }[]) {
          rows.push({ id: s.id, cols: await summarizeSite(data, s.x, s.y, crit, m.tLand, s.siteId, m.power as PowerParams, m.offsetsH as number[]) });
        }
        post({ type: 'compare', reqId: m.reqId, result: rows });
        return;
      }
      case 'sunProbe': {
        // CPU reference for the GPU shadow validation: finite-disk Sun visibility at map points.
        const geo = geometryAt(m.utcMs);
        const out: number[] = [];
        for (const [x, y] of m.points as [number, number][]) {
          await prepareHorizon(data, x, y);
          const p = raycastHorizon(data, x, y, 720);
          const [lat, lon] = polarToLatLon(x, y);
          const s = sunTopo(siteFrame(lat, lon, 0), geo);
          out.push(diskFraction(s.el, hAt(p, s.az), SUN_SEMIDIAMETER_DEG));
        }
        post({ type: 'sunProbe', reqId: m.reqId, result: out });
        return;
      }
      default:
        throw new Error(`unknown message ${m.type}`);
    }
  } catch (err) {
    post({ type: 'error', reqId: m.reqId, message: (err as Error).message, stack: (err as Error).stack });
  }
};
