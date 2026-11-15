/**
 * 360 deg rectangular horizontal sky-plane panorama (spec v2.0 sec. 8.2), D3 scales + SVG.
 * X: azimuth N -> E -> S -> W -> N.  Y: elevation -10 .. +30 deg (expandable to +90).
 * Layers: LOLA ridge silhouette with +/- sigma_h band, clearance thresholds, Sun (0.53 deg) and
 * Earth (1.9 deg) disk trajectories across the mission window, and their current positions.
 */
import { scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
import { useMemo, useState } from 'react';
import { tLandOf, useApp } from '../../store/useApp';
import { HOUR_MS, fmt, SUN_SEMIDIAMETER_DEG } from '../../lib/math';
import { hAt } from '../../science/horizon';
import { fmtUtc } from '../../lib/time';
import { tx } from '../common/Tx';

const W = 420, H = 195, ML = 40, MR = 14, MT = 16, MB = 26;

function splitWrap(points: [number, number][]): [number, number][][] {
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && Math.abs(points[i][0] - points[i - 1][0]) > 180) {
      segs.push(cur);
      cur = [];
    }
    cur.push(points[i]);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export function Panorama() {
  const a = useApp((s) => s.analysis)!;
  const epoch = useApp((s) => s.epoch);
  const crit = useApp((s) => s.criteria);
  const tLand = useApp((s) => tLandOf(s));
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const yMax = expanded ? 90 : 30;
  const x = useMemo(() => scaleLinear().domain([0, 360]).range([ML, W - MR]), []);
  const y = useMemo(() => scaleLinear().domain([-10, yMax]).range([H - MB, MT]).clamp(true), [yMax]);
  const p = a.profile;

  const paths = useMemo(() => {
    const pts = Array.from({ length: p.n + 1 }, (_, i) => i % p.n);
    const az = (i: number, k: number) => (k === p.n ? 360 : (i * 360) / p.n);
    const ridge = area<number>().x((i, k) => x(az(i, k))).y0(H - MB).y1((i) => y(p.h[i]))(pts) ?? '';
    const band = area<number>().x((i, k) => x(az(i, k))).y0((i) => y(p.h[i] - p.sigma[i])).y1((i) => y(p.h[i] + p.sigma[i]))(pts) ?? '';
    const ln = (off: number) => line<number>().x((i, k) => x(az(i, k))).y((i) => y(p.h[i] + off))(pts) ?? '';
    return { ridge, band, sunThr: ln(crit.sunMinEl), earthThr: ln(crit.earthMinEl), edge: ln(0) };
  }, [p, x, y, crit.sunMinEl, crit.earthMinEl]);

  const traj = useMemo(() => {
    const s = a.timeline.series;
    const end = tLand + crit.missionH * HOUR_MS;
    const sunAll: [number, number][] = [], sunMis: [number, number][] = [], earthMis: [number, number][] = [];
    for (let i = 0; i < s.t.length; i++) {
      sunAll.push([s.sunAz[i], s.sunEl[i]]);
      if (s.t[i] >= tLand && s.t[i] <= end) {
        sunMis.push([s.sunAz[i], s.sunEl[i]]);
        earthMis.push([s.earthAz[i], s.earthEl[i]]);
      }
    }
    const mk = (pts: [number, number][]) => splitWrap(pts).map((seg) => line<[number, number]>().x((d) => x(d[0])).y((d) => y(d[1]))(seg) ?? '');
    return { sunAll: mk(sunAll), sunMis: mk(sunMis), earthMis: mk(earthMis) };
  }, [a, tLand, crit.missionH, x, y]);

  const now = useMemo(() => {
    const s = a.timeline.series;
    if (epoch < s.t[0] || epoch > s.t[s.t.length - 1]) return null;
    let i = 0;
    for (; i < s.t.length - 1 && s.t[i + 1] <= epoch; i++);
    const f = Math.min(1, (epoch - s.t[i]) / HOUR_MS);
    const lerpAz = (a0: number, a1: number) => (a0 + ((((a1 - a0 + 540) % 360) - 180) * f) + 360) % 360;
    const j = Math.min(s.t.length - 1, i + 1);
    return {
      sun: [lerpAz(s.sunAz[i], s.sunAz[j]), s.sunEl[i] + (s.sunEl[j] - s.sunEl[i]) * f] as [number, number],
      earth: [lerpAz(s.earthAz[i], s.earthAz[j]), s.earthEl[i] + (s.earthEl[j] - s.earthEl[i]) * f] as [number, number],
    };
  }, [a, epoch]);

  const pxPerDeg = (x(1) - x(0));
  const pyPerDeg = Math.abs(y(1) - y(0));
  const disk = (pos: [number, number], r: number, cls: string, label: string) => {
    const cx = x(pos[0]), cy = y(pos[1]);
    const flipX = cx > W - MR - 52;
    const flipY = cy < MT + 18;
    return (
      <g className={cls}>
        <ellipse cx={cx} cy={cy} rx={Math.max(2.5, r * pxPerDeg)} ry={Math.max(2.5, r * pyPerDeg)} />
        <circle cx={cx} cy={cy} r={7} className="halo" />
        <text x={flipX ? cx - 10 : cx + 10} y={flipY ? cy + 14 : cy - 7} textAnchor={flipX ? 'end' : 'start'}>{label}</text>
      </g>
    );
  };

  return (
    <div className="panorama" data-tour="panorama">
      <div className="pano-head">
        <span>360° horizon panorama</span>
        <button className="btn small ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'El −10…30°' : 'Expand to 90°'}</button>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Horizon panorama with Sun and Earth trajectories"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const az = x.invert(((e.clientX - r.left) / r.width) * W);
          setHover(az >= 0 && az <= 360 ? az : null);
        }}
        onMouseLeave={() => setHover(null)}>
        <rect x={ML} y={MT} width={W - ML - MR} height={H - MT - MB} className="sky" />
        {[...Array(9)].map((_, i) => (
          <g key={i}>
            <line x1={x(i * 45)} x2={x(i * 45)} y1={MT} y2={H - MB} className="gridl" />
            <text x={x(i * 45)} y={H - 7} className="axis mid">{['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][i]}</text>
          </g>
        ))}
        {y.ticks(expanded ? 9 : 8).map((t) => (
          <g key={t}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className={t === 0 ? 'gridl zero' : 'gridl'} />
            <text x={ML - 5} y={y(t) + 4} className="axis end">{t}°</text>
          </g>
        ))}
        <path d={traj.sunAll.join(' ')} className="traj sun faint" />
        <path d={paths.band} className="band" />
        <path d={paths.ridge} className="ridge" />
        <path d={paths.edge} className="ridge-edge" />
        <path d={paths.sunThr} className="thr sun" />
        <path d={paths.earthThr} className="thr earth" />
        {traj.sunMis.map((d, i) => <path key={`s${i}`} d={d} className="traj sun" />)}
        {traj.earthMis.map((d, i) => <path key={`e${i}`} d={d} className="traj earth" />)}
        {now && disk(now.earth, 0.95, 'disk earth', 'Earth')}
        {now && disk(now.sun, SUN_SEMIDIAMETER_DEG, 'disk sun', 'Sun')}
        {hover !== null && (
          <g className="hover">
            <line x1={x(hover)} x2={x(hover)} y1={MT} y2={H - MB} />
            <text x={hover > 200 ? x(hover) - 6 : x(hover) + 6} y={MT + 13} textAnchor={hover > 200 ? 'end' : 'start'}>{`az ${hover.toFixed(1)}° · h ${fmt(hAt(p, hover), 2)}°`}</text>
          </g>
        )}
      </svg>
      <div className="pano-legend small">
        <span className="lg sun">— Sun path (mission)</span>
        <span className="lg earth">— Earth path</span>
        <span className="lg thr">- - {tx('$\\theta_{\\min}$ above ridge')}</span>
        <span className="lg band">▒ {tx('$\\pm\\sigma_h$')}</span>
        {now && <span className="mono muted">{fmtUtc(epoch)}</span>}
      </div>
    </div>
  );
}
