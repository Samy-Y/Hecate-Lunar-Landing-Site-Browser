/** Promise-based RPC wrapper around the engine Web Worker. */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (label: string, f: number) => void };

export class EngineClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      const p = this.pending.get(m.reqId);
      if (!p) return;
      if (m.type === 'progress') {
        p.onProgress?.(m.label, m.f);
        return;
      }
      this.pending.delete(m.reqId);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m.result ?? m);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'));
      this.pending.clear();
    };
  }

  call<T = any>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<T> {
    const reqId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, onProgress });
      this.worker.postMessage({ type, reqId, ...payload }, transfer);
    });
  }
}
