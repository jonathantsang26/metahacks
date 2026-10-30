/**
 * DESIGN.md §9 Analysis → Homes: one structure's exposure over the replay window. The distance to
 * the burned area comes from the CPU copy of arrival.png (the Fire Progression layer, interpolated
 * between mapped perimeters); the gust from the nearest wind_field.json point. Both are computed
 * once per selected structure; only the t cursor and the readout follow the scrubber.
 */
import {useMemo, useState, type MouseEvent} from 'react';
import type {FireData} from '../data/fire';
import {useFireJson, type WindField} from '../data/files';
import {decodeArrival, useRaster} from '../data/raster';
import {tickParts} from '../lib/format';
import {useFireImage} from '../stage/load';
import {useTime} from '../state/time';
import {meters, stamp} from './fmt';
import {greatCircleM, nearestWindPoint, windHour} from './geo';
import {Missing} from './ui';

const HOUR = 3600_000;
/** Burned cells farther than this from the structure are not gathered. */
const REACH_M = 5000;
const M_PER_DEG = 111_320;
/** arrival.png green 32: inside the final perimeter but in no timed footprint (step 06), so no burn time. */
const UNRESOLVED = 32;

/** viewBox geometry: distance panel over gust panel, one shared time axis. */
const VW = 268;
const L = 34;
const R = 6;
const DIST = {top: 4, h: 50};
const GUST = {top: 68, h: 30};
const AXIS_Y = GUST.top + GUST.h + 10;
const VH = AXIS_Y + 3;
const AXIS_TEXT = {fontSize: 9, fill: 'var(--text-muted)'} as const;

type ArrivalMeta = {window_utc: [string, string]};

/**
 * Hourly distance (m) from (lon, lat) to the nearest cell burned by each hour, within REACH_M:
 * every resolved burned cell in reach is binned at the first hour on or after its arrival, then a
 * running minimum gives the burned area's distance at each hour (null while none is in reach).
 * `cellM` is half a cell's diagonal: a distance under it means the structure's own cell has burned.
 */
function frontDistance(
  raster: NonNullable<ReturnType<typeof useRaster>>,
  window: [number, number],
  lon: number,
  lat: number,
  start: number,
  hours: number
): {vals: (number | null)[]; cellM: number} {
  const {width: W, height: H, bounds, data} = raster;
  const [w, s, e, n] = bounds;
  const dLon = (e - w) / W;
  const dLat = (n - s) / H;
  // Local flat-earth meters: exact enough within 5 km, and cheap over a few hundred thousand cells.
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ky = M_PER_DEG;
  const cf = (lon - w) / dLon - 0.5;
  const rf = (n - lat) / dLat - 0.5;
  const c0 = Math.max(0, Math.floor(cf - REACH_M / (dLon * kx)));
  const c1 = Math.min(W - 1, Math.ceil(cf + REACH_M / (dLon * kx)));
  const r0 = Math.max(0, Math.floor(rf - REACH_M / (dLat * ky)));
  const r1 = Math.min(H - 1, Math.ceil(rf + REACH_M / (dLat * ky)));
  const best = new Float64Array(hours + 1).fill(Infinity);
  for (let r = r0; r <= r1; r++) {
    const dy = (n - (r + 0.5) * dLat - lat) * ky;
    for (let c = c0; c <= c1; c++) {
      const i = (r * W + c) * 4;
      if (data[i + 1] === UNRESOLVED) continue;
      const at = decodeArrival(data[i], window[0], window[1]);
      if (at === null) continue;
      const d = Math.hypot((w + (c + 0.5) * dLon - lon) * kx, dy);
      if (d > REACH_M) continue;
      const k = Math.max(0, Math.ceil((at - start) / HOUR));
      if (k <= hours && d < best[k]) best[k] = d;
    }
  }
  const vals: (number | null)[] = [];
  let min = Infinity;
  for (let k = 0; k <= hours; k++) {
    min = Math.min(min, best[k]);
    vals.push(Number.isFinite(min) ? min : null);
  }
  return {vals, cellM: Math.hypot(dLon * kx, dLat * ky) / 2};
}

/** SVG path through the defined points, broken where a value is null. */
function linePath(vals: (number | null)[], x: (k: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  vals.forEach((v, k) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function ExposureTimeline({
  fire,
  lon,
  lat,
  arrivalMs
}: {
  fire: FireData;
  lon: number;
  lat: number;
  /** exposure.json arrival_t for this structure, marked on the chart. */
  arrivalMs: number | null;
}) {
  // useRaster is null both while loading and on failure, and keeps the last fire's raster until the
  // new one loads; the stage's image state (the same arrival.png it already fetched) tells them apart.
  const image = useFireImage(fire, 'arrival.png');
  const cpu = useRaster(fire, 'arrival.png');
  const current = cpu !== null && cpu.bounds.every((v, i) => v === fire.dem.bounds[i]);
  const raster = image.status === 'ok' && current ? cpu : null;
  const meta = useFireJson<ArrivalMeta>(fire, 'arrival_meta.json');
  const {data: wf} = useFireJson<WindField>(fire, 'wind_field.json');
  const start = useTime(s => s.start);
  const end = useTime(s => s.end);
  const tz = fire.aoi.timezone;
  const hours = Math.max(1, Math.floor((end - start) / HOUR));

  // Arrival codes are fractions of arrival_meta.window_utc (aoi.window_utc only if that file is missing).
  const win = meta.data?.window_utc ?? (meta.error ? fire.aoi.window_utc : null);
  const w0 = win ? Date.parse(win[0]) : NaN;
  const w1 = win ? Date.parse(win[1]) : NaN;

  const dist = useMemo(
    () => (raster && Number.isFinite(w0) ? frontDistance(raster, [w0, w1], lon, lat, start, hours) : null),
    [raster, w0, w1, lon, lat, start, hours]
  );

  const gust = useMemo(() => {
    if (!wf) return null;
    const p = nearestWindPoint(wf, lon, lat);
    const vals = Array.from({length: hours + 1}, (_, k) => {
      const i = windHour(wf, wf.t, start + k * HOUR, 2 * HOUR);
      return i >= 0 ? wf.gust_mph[p][i] : null;
    });
    const [plon, plat] = wf.points[p];
    return {vals, pointM: greatCircleM(lon, lat, plon, plat)};
  }, [wf, lon, lat, start, hours]);

  const x = (k: number) => L + (k / hours) * (VW - L - R);
  const xMs = (ms: number) => x((ms - start) / HOUR);

  // Gust axis tops out at the next 10 mph above the peak.
  const gustMax = useMemo(
    () => Math.max(10, Math.ceil(Math.max(0, ...(gust?.vals ?? []).filter((v): v is number => v !== null)) / 10) * 10),
    [gust]
  );
  const paths = useMemo(() => {
    const px = (k: number) => L + (k / hours) * (VW - L - R);
    const yD = (m: number) => DIST.top + DIST.h - (m / REACH_M) * DIST.h;
    const yG = (mph: number) => GUST.top + GUST.h - (mph / gustMax) * GUST.h;
    return {dist: dist ? linePath(dist.vals, px, yD) : '', gust: gust ? linePath(gust.vals, px, yG) : ''};
  }, [dist, gust, gustMax, hours]);

  // Day ticks at local midnight, labelled "Jan 8".
  const days = useMemo(() => {
    const out: {k: number; label: string}[] = [];
    for (let k = 0; k <= hours; k++) {
      const p = tickParts(start + k * HOUR, tz);
      if (p.hour === '00:00') out.push({k, label: p.day});
    }
    return out;
  }, [start, hours, tz]);

  const [hoverK, setHoverK] = useState<number | null>(null);
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * VW;
    const k = Math.round(((vx - L) / (VW - L - R)) * hours);
    setHoverK(k >= 0 && k <= hours ? k : null);
  };

  if (image.status === 'error') return <Missing file="arrival.png" error="did not load" />;
  if (!dist) {
    return <div className="py-2 text-xs text-muted">{raster === null ? 'Loading arrival.png…' : 'Loading arrival_meta.json…'}</div>;
  }
  const anyInReach = dist.vals.some(v => v !== null);
  const arrivalIn = arrivalMs !== null && arrivalMs >= start && arrivalMs <= end;

  return (
    <div className="mt-1.5">
      <div className="mb-0.5 flex items-center gap-3 text-2xs text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-[2px] w-3" style={{background: 'var(--chart-area-stroke)'}} />
          Distance to burned area
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-[2px] w-3" style={{background: 'var(--chart-elev-stroke)'}} />
          Gust (HRRR)
        </span>
      </div>
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        className="block w-full overflow-visible"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverK(null)}
        role="img"
        aria-label="Distance from this structure to the burned area, and gust, by hour"
      >
        {/* Panel frames: baselines solid, tops dashed. */}
        {[DIST, GUST].map(p => (
          <g key={p.top}>
            <line x1={L} x2={VW - R} y1={p.top + p.h} y2={p.top + p.h} stroke="var(--text)" strokeOpacity={0.25} />
            <line x1={L} x2={VW - R} y1={p.top} y2={p.top} stroke="var(--text)" strokeOpacity={0.1} strokeDasharray="2 3" />
          </g>
        ))}
        <text x={L - 4} y={DIST.top} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>
          {REACH_M / 1000} km
        </text>
        <text x={L - 4} y={DIST.top + DIST.h} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>
          0
        </text>
        <text x={L - 4} y={GUST.top} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>
          {gustMax} mph
        </text>
        <text x={L - 4} y={GUST.top + GUST.h} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>
          0
        </text>
        {days.map(d => (
          <g key={d.k}>
            <line x1={x(d.k)} x2={x(d.k)} y1={DIST.top} y2={GUST.top + GUST.h} stroke="var(--text)" strokeOpacity={0.06} />
            <text x={x(d.k)} y={AXIS_Y} textAnchor="middle" {...AXIS_TEXT}>
              {d.label}
            </text>
          </g>
        ))}
        <path d={paths.dist} fill="none" stroke="var(--chart-area-stroke)" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={paths.gust} fill="none" stroke="var(--chart-elev-stroke)" strokeWidth={1.2} strokeLinejoin="round" />
        {arrivalIn && (
          <g>
            <line
              x1={xMs(arrivalMs!)}
              x2={xMs(arrivalMs!)}
              y1={DIST.top}
              y2={GUST.top + GUST.h}
              stroke="var(--text)"
              strokeWidth={1.2}
              strokeDasharray="3 2"
            />
            <text
              x={xMs(arrivalMs!) + 3}
              y={DIST.top + 7}
              {...AXIS_TEXT}
              fill="var(--text)"
              stroke="var(--bg-card)"
              strokeWidth={3}
              paintOrder="stroke"
            >
              arrival
            </text>
          </g>
        )}
        <TimeCursor x={xMs} start={start} end={end} />
        {hoverK !== null && (
          <line x1={x(hoverK)} x2={x(hoverK)} y1={DIST.top} y2={GUST.top + GUST.h} stroke="var(--text)" strokeOpacity={0.3} />
        )}
        {!anyInReach && (
          <text x={(L + VW - R) / 2} y={DIST.top + DIST.h / 2} textAnchor="middle" dominantBaseline="middle" {...AXIS_TEXT}>
            No burned cell within {REACH_M / 1000} km in the replay window
          </text>
        )}
      </svg>
      <Readout start={start} hours={hours} hoverK={hoverK} dist={dist.vals} cellM={dist.cellM} gust={gust?.vals ?? null} tz={tz} />
      <div className="mt-0.5 text-2xs text-muted">
        Nearest burned cell of the Fire Progression layer (interpolated between mapped perimeters), hourly, within{' '}
        {REACH_M / 1000} km; no line while none is in reach.
        {gust && <> Gust: HRRR max of the preceding hour at the nearest grid point, {meters(gust.pointM)} away.</>}
        {arrivalIn && <> Dashed: fire arrival (exposure.json).</>} Solid: t.
      </div>
    </div>
  );
}

/** The global t, the one part of the chart that moves with the scrubber. */
function TimeCursor({x, start, end}: {x: (ms: number) => number; start: number; end: number}) {
  const t = useTime(s => s.t);
  if (t < start || t > end) return null;
  return <line x1={x(t)} x2={x(t)} y1={DIST.top} y2={GUST.top + GUST.h} stroke="var(--text)" strokeOpacity={0.6} />;
}

/** Values at the hovered hour, else at the hour at or before t. */
function Readout({
  start,
  hours,
  hoverK,
  dist,
  cellM,
  gust,
  tz
}: {
  start: number;
  hours: number;
  hoverK: number | null;
  dist: (number | null)[];
  cellM: number;
  gust: (number | null)[] | null;
  tz: string;
}) {
  const t = useTime(s => s.t);
  const k = hoverK ?? Math.min(hours, Math.max(0, Math.floor((t - start) / HOUR)));
  const d = dist[k];
  const g = gust?.[k] ?? null;
  return (
    <div className="mt-0.5 text-xs tabular-nums">
      <span className="text-muted">{hoverK === null ? 'At t' : 'At'} {stamp(start + k * HOUR, tz)}:</span>{' '}
      {d === null
        ? `over ${REACH_M / 1000} km from the burned area`
        : d <= cellM
          ? 'the burned area reaches the structure'
          : `${meters(d)} from the burned area`}
      {g !== null && <> · gust {Math.round(g)} mph</>}
    </div>
  );
}
