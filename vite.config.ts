import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Tier-2 ephemeris caching proxy (spec v2.0 sec. 4.2).
 *
 * NASA JPL Horizons does not send CORS headers, so the browser cannot call it
 * directly. This middleware forwards `/api/horizons?<query>` to
 * https://ssd.jpl.nasa.gov/api/horizons.api and memoises responses in memory,
 * so pinned-site verification queries are only paid once per server session.
 * It is active in both `vite` (dev) and `vite preview`.
 */
function horizonsProxy(): Plugin {
  const cache = new Map<string, { at: number; body: string; status: number }>();
  const TTL_MS = 6 * 3600_000;
  const handler = async (req: any, res: any, next: () => void) => {
    if (!req.url || !req.url.startsWith('/api/horizons')) return next();
    const q = req.url.slice('/api/horizons'.length).replace(/^\?/, '');
    const hit = cache.get(q);
    res.setHeader('Content-Type', 'application/json');
    if (hit && Date.now() - hit.at < TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      res.statusCode = hit.status;
      res.end(hit.body);
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${q}`, { signal: ctrl.signal });
      clearTimeout(timer);
      const body = await r.text();
      if (r.ok) cache.set(q, { at: Date.now(), body, status: r.status });
      res.setHeader('X-Cache', 'MISS');
      res.statusCode = r.status;
      res.end(body);
    } catch (err) {
      res.statusCode = 504;
      res.end(JSON.stringify({ error: `Horizons unreachable: ${(err as Error).message}` }));
    }
  };
  return {
    name: 'hecate-horizons-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), horizonsProxy()],
  worker: { format: 'es' },
  // The real-data tile pyramid holds thousands of files: never watch it (it would exhaust OS watch handles).
  server: { port: 5173, strictPort: false, watch: { ignored: ['**/public/data/**'] } },
  preview: { port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500, sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);
