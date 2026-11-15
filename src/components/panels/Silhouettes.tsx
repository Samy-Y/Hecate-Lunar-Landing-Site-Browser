/**
 * Physical scale silhouette comparison (spec v2.0 sec. 8.1): Apollo A7L astronaut 1.8 m,
 * VIPER rover 2.5 m, Starship HLS 50 m, against the DEM pixel spacing at the site and the
 * local relief (TRI) - making "what can this DEM actually see?" tangible.
 */
import { useApp } from '../../store/useApp';
import { fmt } from '../../lib/math';

export function Silhouettes() {
  const a = useApp((s) => s.analysis);
  if (!a) return null;
  const px = a.terrain.sourceSpacingM;
  const maxM = 60;
  const H = 120, base = 108;
  const sc = (m: number) => (m / maxM) * (base - 8);
  const items = [
    { label: 'Astronaut 1.8 m', h: 1.8, w: 0.6, x: 40 },
    { label: 'VIPER 2.5 m', h: 2.5, w: 1.5, x: 100 },
    { label: 'Starship HLS 50 m', h: 50, w: 9, x: 175 },
  ];
  return (
    <div className="silhouettes">
      <h4>Scale check</h4>
      <svg viewBox={`0 0 340 ${H}`} role="img" aria-label="Scale silhouettes">
        <line x1="10" x2="330" y1={base} y2={base} className="ground" />
        {items.map((it) => {
          const h = Math.max(2, sc(it.h));
          const w = Math.max(2, sc(it.w));
          return (
            <g key={it.label}>
              {it.h > 40 ? (
                <path d={`M${it.x - w / 2} ${base} L${it.x - w / 2} ${base - h * 0.82} Q${it.x} ${base - h * 1.05} ${it.x + w / 2} ${base - h * 0.82} L${it.x + w / 2} ${base} Z`} className="sil" />
              ) : (
                <rect x={it.x - w / 2} y={base - h} width={w} height={h} className="sil" />
              )}
              <text x={it.x} y={base + 10} className="axis mid">{it.label}</text>
            </g>
          );
        })}
        <g>
          <rect x={250} y={base - Math.min(sc(px), base - 4)} width={Math.min(sc(px), 70)} height={Math.min(sc(px), base - 4)} className="pix" />
          <text x={285} y={base + 10} className="axis mid">{px} m DEM pixel</text>
        </g>
      </svg>
      <p className="small muted">
        One {px} m pixel {px >= 50 ? 'is larger than the HLS' : 'is wider than a rover'}; boulders below {px} m are invisible to this DEM{a.terrain.tri != null ? ` (local TRI ${fmt(a.terrain.tri, 2)} m)` : ''}. Verify with LROC NAC imagery (0.5–2 m/px).
      </p>
    </div>
  );
}
