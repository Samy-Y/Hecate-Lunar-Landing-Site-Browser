/**
 * Vercel serverless function: same-origin proxy for NASA JPL Horizons (Tier-2 ephemeris check).
 *
 * Horizons sends no CORS headers, so the browser cannot call it directly. In local development the
 * Vite middleware in vite.config.ts does this job; on Vercel this file serves `/api/horizons?<query>`.
 * Successful responses are cached at Vercel's edge for 6 h, like the dev proxy.
 */
export default async function handler(req, res) {
  const i = req.url.indexOf('?');
  const q = i >= 0 ? req.url.slice(i + 1) : '';
  res.setHeader('Content-Type', 'application/json');
  if (!q) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Missing Horizons query' }));
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${q}`, { signal: ctrl.signal });
    const body = await r.text();
    if (r.ok) res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.statusCode = r.status;
    res.end(body);
  } catch (err) {
    res.statusCode = 504;
    res.end(JSON.stringify({ error: `Horizons unreachable: ${err.message}` }));
  } finally {
    clearTimeout(timer);
  }
}
