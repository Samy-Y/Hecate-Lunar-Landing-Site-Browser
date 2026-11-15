/** UTC helpers. All epochs inside the app are UTC milliseconds since 1970 (number). */
import { DAY_MS, HOUR_MS } from './math';

export function parseUtc(iso: string): number {
  const s = iso.trim();
  const withZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`;
  return Date.parse(withZone);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2027-03-15 12:00Z" (or with seconds). */
export function fmtUtc(ms: number, seconds = false): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${base}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}Z`;
}

/** Value for <input type="datetime-local"> interpreted as UTC. */
export function toInputUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return '—';
  if (Math.abs(h) >= 48) return `${(h / 24).toFixed(1)} d`;
  return `${h.toFixed(1)} h`;
}

export function fmtOffset(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  const a = Math.abs(ms);
  if (a >= DAY_MS) return `${sign}${(a / DAY_MS).toFixed(a % DAY_MS === 0 ? 0 : 1)} d`;
  return `${sign}${(a / HOUR_MS).toFixed(a % HOUR_MS === 0 ? 0 : 1)} h`;
}
