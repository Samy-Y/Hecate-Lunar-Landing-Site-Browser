/** Solar power over the mission window for the inspected site (P(t), mean, energy). */
import { scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
import { useMemo } from 'react';
import { useApp } from '../../store/useApp';
import { fmt } from '../../lib/math';
import { fmtUtc } from '../../lib/time';
import { tx } from '../common/Tx';

const W = 420, H = 175, ML = 44, MR = 14, MT = 16, MB = 26;

export function PowerChart() {
  const a = useApp((s) => s.analysis);
  const p = useApp((s) => s.power);
  const epoch = useApp((s) => s.epoch);
  const pw = a?.power;
  const g = useMemo(() => {
    if (!pw || pw.t.length < 2) return null;
    const x = scaleLinear().domain([pw.t[0], pw.t[pw.t.length - 1]]).range([ML, W - MR]);
    const yMax = Math.max(1, pw.ratedW * 1.02, ...pw.watts);
    const y = scaleLinear().domain([0, yMax]).range([H - MB, MT]).nice();
    const idx = pw.t.map((_, i) => i);
    return {
      x, y,
      area: area<number>().x((i) => x(pw.t[i])).y0(H - MB).y1((i) => y(pw.watts[i]))(idx) ?? '',
      line: line<number>().x((i) => x(pw.t[i])).y((i) => y(pw.watts[i]))(idx) ?? '',
      ticks: y.ticks(4),
    };
  }, [pw]);
  if (!pw) return <p className="small muted">Power is computed with the site analysis.</p>;
  return (
    <div className="power">
      <div className="kv">
        <span>Rated (1 AU, normal incidence)</span><b className="mono">{fmt(pw.ratedW, 0)} W</b>
        <span>Mean over mission</span><b className="mono">{fmt(pw.meanW, 0)} W</b>
        <span>Energy over mission</span><b className="mono">{fmt(pw.energyKWh, 1)} kWh</b>
        <span>Peak / minimum</span><b className="mono">{fmt(pw.maxW, 0)} / {fmt(pw.minW, 0)} W</b>
        <span>Hours below 1 % rated</span><b className="mono">{fmt(pw.hoursBelow1pct, 1)} h</b>
      </div>
      <div className="power-spec">
        <span className="power-spec-title">Array configuration</span>
        <div className="kv">
          <span>Area / efficiency</span><b className="mono">{tx(`${p.areaM2} $\\mathrm{m}^2$ · $\\eta = ${fmt(p.efficiency * 100, 1)}$ %`)}</b>
          <span>Inclination / orientation</span><b className="mono">{tx(`$\\beta = ${p.tiltDeg}^\\circ$ · ${p.azMode === 'track' ? 'Sun-tracking' : `fixed $${p.azDeg}^\\circ$`}`)}</b>
          <span>System losses</span><b className="mono">{p.lossesPct} %</b>
        </div>
      </div>
      {g && (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Solar power over the mission">
          {g.ticks.map((t) => (
            <g key={t}>
              <line x1={ML} x2={W - MR} y1={g.y(t)} y2={g.y(t)} className="gridl" />
              <text x={ML - 5} y={g.y(t) + 4} className="axis end">{t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}</text>
            </g>
          ))}
          <path d={g.area} className="pw-area" />
          <path d={g.line} className="pw-line" />
          <line x1={ML} x2={W - MR} y1={g.y(pw.meanW)} y2={g.y(pw.meanW)} className="pw-mean" />
          <text x={W - MR - 4} y={Math.max(MT + 11, g.y(pw.meanW) - 5)} className="axis end">mean</text>
          {epoch >= pw.t[0] && epoch <= pw.t[pw.t.length - 1] && <line x1={g.x(epoch)} x2={g.x(epoch)} y1={MT} y2={H - MB} className="pw-now" />}
          <text x={ML} y={H - 7} className="axis">{fmtUtc(pw.t[0]).slice(5, 16)}</text>
          <text x={W - MR} y={H - 7} className="axis end">{fmtUtc(pw.t[pw.t.length - 1]).slice(5, 16)}</text>
        </svg>
      )}
      <p className="small muted">{tx('$P(t) = S \\cdot A \\cdot \\eta \\cdot (1 - L) \\cdot f_{\\mathrm{sun}} \\cdot \\max(0, \\cos i)$; $S = 1361\\,\\mathrm{W/m}^2 \\times (1\\,\\mathrm{AU} / r)^2$. Zero when the terrain hides the solar disk. Configure the array in the left panel → Power.')}</p>
    </div>
  );
}
