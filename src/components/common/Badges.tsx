/** Feasibility badges: colour (Okabe-Ito) + redundant geometry + text, never colour alone. */
import type { Feasibility } from '../../science/assessment';

export function StatusBadge({ status, large = false, label }: { status: Feasibility | 'CANDIDATE'; large?: boolean; label?: string }) {
  const cls = status === 'PASS' ? 'pass' : status === 'FAIL' ? 'fail' : 'unknown';
  const shape =
    status === 'PASS' ? (
      <svg viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="7" /><path d="M4.5 8.3l2.3 2.3 4.7-5" className="ink" /></svg>
    ) : status === 'FAIL' ? (
      <svg viewBox="0 0 16 16" aria-hidden><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" /><path d="M5 5l6 6M11 5l-6 6" className="ink" /></svg>
    ) : (
      <svg viewBox="0 0 16 16" aria-hidden><path d="M8 1.2L15 14.5H1z" /><path d="M8 6v4M8 12.2v.2" className="ink" /></svg>
    );
  return (
    <span className={`badge ${cls}${large ? ' large' : ''}`} role="status">
      {shape}
      <span>{label ?? (status === 'UNKNOWN' ? 'UNKNOWN / LOW CONFIDENCE' : status === 'CANDIDATE' ? 'CANDIDATE' : status)}</span>
    </span>
  );
}

export function PassMark({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="mark na" title="Not evaluable / not applicable">—</span>;
  return pass ? <span className="mark ok" title="pass">✓</span> : <span className="mark bad" title="fail">✕</span>;
}

export function Meter({ value, max = 100, tone }: { value: number; max?: number; tone?: 'pass' | 'unknown' | 'fail' | 'accent' }) {
  const v = Math.max(0, Math.min(1, value / max));
  return (
    <div className={`meter ${tone ?? 'accent'}`} role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max}>
      <div style={{ width: `${v * 100}%` }} />
    </div>
  );
}
