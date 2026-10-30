/**
 * Incident charts (DESIGN.md §6.2): Fire Area and Rate of Spread over the replay window from
 * series.json, and the Elevation Profile along the spread spine from profile.json. Paths are
 * built once per data/size; only the past/future clip and the cursor move with t.
 */
import {useId, useMemo, type ReactNode} from 'react';
import type {Profile, Series} from '../data/files';
import {tickParts} from '../lib/format';
import {useTime} from '../state/time';
import {Icon} from '../ui/Icon';
import {
  formatMinutes,
  formatValue,
  indexAtOrAfter,
  interpolate,
  niceTicks,
  rosAxis,
  shortInterval,
  tickLabel,
  useSize,
  type ArrivalIntervals
} from './scale';

const HOUR = 3600_000;
/** Plot margins in px: room for y labels on the left and x labels below. */
const M = {l: 40, r: 8, t: 7, b: 14};
const AXIS_TEXT = {fontSize: 10, fill: 'var(--text-muted)'} as const;
/** Rough advance of 10px Inter, for choosing which side of a mark a label fits on. */
const CHAR_PX = 5.2;

const RASTER_NOTE = 'Derived from the arrival raster, which is interpolated between mapped perimeters';
const PROFILE_NOTE =
  "Elevation from the terrain model (DEM). The spine path and the front's times come from the arrival raster, which is interpolated between mapped perimeters";

type DataFile = {name: string; href: string};

/** ⋮ menu: the pipeline files a chart is drawn from. */
function ChartMenu({files}: {files: DataFile[]}) {
  return (
    <details className="relative shrink-0">
      <summary
        className="flex cursor-pointer list-none text-muted hover:text-ink [&::-webkit-details-marker]:hidden"
        title="Source files"
      >
        <Icon name="dots" size={14} />
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1 flex flex-col whitespace-nowrap rounded-md bg-card py-1 text-xs shadow-[0_0_0_1px_var(--hairline)]">
        {files.map(f => (
          <a key={f.href} href={f.href} target="_blank" rel="noreferrer" className="px-3 py-1 hover:bg-tabgroup">
            Open {f.name}
          </a>
        ))}
      </div>
    </details>
  );
}

/**
 * One chart cell: title row with the value at t, the plot, and a muted source line.
 * `modeled` is the MODELED chip's tooltip (no chip when absent).
 */
export function ChartFrame({
  title,
  unit,
  modeled,
  value,
  valueTitle,
  foot,
  footTitle,
  files,
  children
}: {
  title: string;
  unit?: string;
  modeled?: string;
  value?: ReactNode;
  valueTitle?: string;
  foot?: ReactNode;
  footTitle?: string;
  files?: DataFile[];
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col border-r border-hairline px-3 pt-1.5 last:border-r-0">
      <div className="flex items-center gap-1.5">
        <span className="truncate text-sm font-medium">
          {title} {unit && <span className="font-normal text-muted">({unit})</span>}
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-xs font-medium tabular-nums" title={valueTitle}>
          {value}
        </span>
        {files && files.length > 0 && <ChartMenu files={files} />}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
      {(foot || modeled) && (
        <div className="flex items-center gap-1.5 pb-1 text-2xs text-muted">
          {modeled && (
            <span className="shrink-0 rounded bg-tabgroup px-1 font-mono text-ink" title={modeled}>
              MODELED
            </span>
          )}
          <span className="truncate" title={footTitle ?? (typeof foot === 'string' ? foot : undefined)}>
            {foot}
          </span>
        </div>
      )}
    </div>
  );
}

/** Centered muted text for a chart with no data (loading, or the file is missing). */
export function ChartEmpty({children}: {children: ReactNode}) {
  return <div className="absolute inset-0 flex items-center justify-center text-center text-xs text-muted">{children}</div>;
}

/** Sizes the plot to its frame; renders nothing until the frame has been measured. */
function Plot({children}: {children: (w: number, h: number) => ReactNode}) {
  const [ref, {width, height}] = useSize<HTMLDivElement>();
  return (
    <div ref={ref} className="absolute inset-0">
      {width > 0 && height > 0 && (
        <svg width={width} height={height} className="block overflow-visible">
          {children(width, height)}
        </svg>
      )}
    </div>
  );
}

/** Unique, url()-safe ids for the past/future clips of one chart. */
function useClipIds() {
  const id = useId().replace(/:/g, '');
  return {past: `${id}-past`, future: `${id}-future`};
}

/** Horizontal grid and y labels; the top label carries the unit, and a "+" when the axis is capped. */
function YAxis({
  ticks,
  step,
  y,
  w,
  unit,
  compact = true,
  capped = false
}: {
  ticks: number[];
  step: number;
  y: (v: number) => number;
  w: number;
  unit: string;
  compact?: boolean;
  capped?: boolean;
}) {
  return (
    <g>
      {ticks.map((v, i) => (
        <g key={v}>
          <line
            x1={M.l}
            x2={w - M.r}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--text)"
            strokeOpacity={i === 0 ? 0.25 : 0.1}
            strokeDasharray={i === 0 ? undefined : '2 3'}
          />
          <text x={M.l - 4} y={y(v)} textAnchor="end" dominantBaseline="middle" {...AXIS_TEXT}>
            {tickLabel(v, step, compact)}
            {i === ticks.length - 1 ? `${capped ? '+' : ''} ${unit}` : ''}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Day labels at local midnights across the replay window, thinned to fit. */
function TimeXAxis({start, end, tz, x, w, h}: {start: number; end: number; tz: string; x: (ms: number) => number; w: number; h: number}) {
  const days = useMemo(() => {
    const out: {t: number; day: string}[] = [];
    for (let t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) {
      const {day, hour} = tickParts(t, tz);
      if (hour === '00:00') out.push({t, day});
    }
    return out;
  }, [start, end, tz]);
  const every = days.length > 1 && x(days[1].t) - x(days[0].t) < 38 ? 2 : 1;
  return (
    <g>
      {days.map((d, i) => {
        const px = x(d.t);
        const label = i % every === 0 && px - 16 >= M.l && px + 16 <= w;
        return (
          <g key={d.t}>
            <line x1={px} x2={px} y1={M.t} y2={h - M.b} stroke="var(--text)" strokeOpacity={0.06} />
            {label && (
              <text x={px} y={h - 2} textAnchor="middle" {...AXIS_TEXT}>
                {d.day}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Vertical cursor at x with hollow handles at both ends and on the series. */
function Cursor({x, y, h, color}: {x: number; y: number | null; h: number; color: string}) {
  const handle = {r: 2.5, fill: 'var(--bg-chrome)', stroke: 'var(--text)', strokeWidth: 1.2};
  return (
    <g>
      <line x1={x} x2={x} y1={M.t} y2={h - M.b} stroke="var(--text)" strokeOpacity={0.6} />
      <circle cx={x} cy={M.t} {...handle} />
      <circle cx={x} cy={h - M.b} {...handle} />
      {y !== null && <circle cx={x} cy={y} r={3.5} fill="var(--bg-chrome)" stroke={color} strokeWidth={1.6} />}
    </g>
  );
}

type Span = [number, number];

/** Sorted, merged spans clamped to [0, w], and the gaps between them. */
function partition(spans: Span[], w: number): {past: Span[]; future: Span[]} {
  const past: Span[] = [];
  for (const [a, b] of spans.map(([a, b]): Span => [Math.max(0, a), Math.min(w, b)]).sort((p, q) => p[0] - q[0])) {
    if (b <= a) continue;
    const last = past[past.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else past.push([a, b]);
  }
  const future: Span[] = [];
  let at = 0;
  for (const [a, b] of past) {
    if (a > at) future.push([at, a]);
    at = b;
  }
  if (at < w) future.push([at, w]);
  return {past, future};
}

/** Past solid, future faded: the same marks drawn twice under complementary clips. `past` lists x spans. */
function PastFuture({past, w, h, children}: {past: Span[]; w: number; h: number; children: (past: boolean) => ReactNode}) {
  const ids = useClipIds();
  const p = partition(past, w);
  const rects = (spans: Span[]) => spans.map(([a, b]) => <rect key={a} x={a} y={0} width={b - a} height={h} />);
  return (
    <g>
      <defs>
        <clipPath id={ids.past}>{rects(p.past)}</clipPath>
        <clipPath id={ids.future}>{rects(p.future)}</clipPath>
      </defs>
      <g clipPath={`url(#${ids.future})`} opacity={0.4}>
        {children(false)}
      </g>
      <g clipPath={`url(#${ids.past})`}>{children(true)}</g>
    </g>
  );
}

/** A label beside a mark: on the right if it fits, else the left, else the next shorter text. */
function placeLabel(cx: number, w: number, texts: string[]): {text: string; x: number; anchor: 'start' | 'end'} | null {
  for (const text of texts) {
    const need = 6 + text.length * CHAR_PX;
    if (cx + need <= w - M.r) return {text, x: cx + 6, anchor: 'start'};
    if (cx - need >= M.l) return {text, x: cx - 6, anchor: 'end'};
  }
  return null;
}

type TimeChartProps = {series: Series; tz: string; w: number; h: number};

/** Hourly series parsed once: epoch-ms times and the window-relative x/y scales. */
function useTimeScales(series: Series, w: number, h: number, top: number) {
  const start = useTime(s => s.start);
  const end = useTime(s => s.end);
  return useMemo(() => {
    const times = series.t.map(Date.parse);
    const yt = niceTicks(0, top, 3);
    const x = (ms: number) => M.l + ((ms - start) / (end - start)) * (w - M.l - M.r);
    const y = (v: number) => M.t + (1 - (Math.min(v, yt.hi) - yt.lo) / (yt.hi - yt.lo)) * (h - M.t - M.b);
    return {start, end, times, yt, x, y};
  }, [series, w, h, top, start, end]);
}

/** Fire Area: cumulative acres, linear between the hourly samples. */
function AreaPlot({series, tz, w, h}: TimeChartProps) {
  const t = useTime(s => s.t);
  const max = Math.max(0, ...series.area_acres);
  const {start, end, times, yt, x, y} = useTimeScales(series, w, h, max);
  const {line, area} = useMemo(() => {
    const pts = times.map((ms, i) => `${x(ms).toFixed(1)},${y(series.area_acres[i]).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    const base = y(yt.lo).toFixed(1);
    return {line, area: `${line}L${x(times[times.length - 1]).toFixed(1)},${base}L${x(times[0]).toFixed(1)},${base}Z`};
  }, [times, x, y, yt, series]);
  const v = interpolate(times, series.area_acres, t);
  return (
    <>
      <YAxis ticks={yt.ticks} step={yt.step} y={y} w={w} unit="ac" />
      <TimeXAxis start={start} end={end} tz={tz} x={x} w={w} h={h} />
      <PastFuture past={[[0, x(t)]]} w={w} h={h}>
        {past => (
          <>
            <path d={area} fill="var(--chart-area-fill)" />
            <path d={line} fill="none" stroke="var(--chart-area-stroke)" strokeWidth={1.5} strokeDasharray={past ? undefined : '3 3'} />
          </>
        )}
      </PastFuture>
      <Cursor x={x(t)} y={v === null ? null : y(v)} h={h} color="var(--chart-area-stroke)" />
    </>
  );
}

/**
 * series.json writes 0.0 both for "no front this hour" and for "too few burning cells to
 * estimate" (step 06). Hour i is the second kind when the area still grew during it.
 */
function unestimated(series: Series, i: number): boolean {
  return series.ros_chains_hr[i] === 0 && i > 0 && series.area_acres[i] > series.area_acres[i - 1];
}

/** Why hour (a, b] spiked, when the arrival raster's perimeter timing explains it. */
function spike(meta: ArrivalIntervals | null, a: number, b: number): {minutes: number; note: string} | null {
  const s = shortInterval(meta, a, b);
  return (
    s && {
      minutes: s.minutes,
      note:
        `Two perimeters were mapped ${formatMinutes(s.minutes)} apart in this hour, so the arrival raster fills ` +
        `${s.cells.toLocaleString('en-US')} cells within those minutes: an interpolation spike, not a measured speed.`
    }
  );
}

type OffScale = {cx: number; v: number; minutes: number | null; note: string | null};

/**
 * Rate of Spread: each hourly value covers the hour ending at its time, so it is drawn as steps.
 * Hours above a capped axis are clipped and marked ▲; unestimated hours are left as gaps.
 */
function RosPlot({
  series,
  meta,
  tz,
  w,
  h,
  top,
  capped
}: TimeChartProps & {meta: ArrivalIntervals | null; top: number; capped: boolean}) {
  const t = useTime(s => s.t);
  const {start, end, times, yt, x, y} = useTimeScales(series, w, h, top);
  const ros = series.ros_chains_hr;
  const {line, off, peak} = useMemo(() => {
    let d = '';
    let pen = false;
    const off: OffScale[] = [];
    for (let i = 1; i < times.length; i++) {
      if (unestimated(series, i)) {
        pen = false;
        continue;
      }
      const x0 = x(times[i - 1]);
      const x1 = x(times[i]);
      d += `${pen ? 'L' : 'M'}${x0.toFixed(1)},${y(ros[i]).toFixed(1)}H${x1.toFixed(1)}`;
      pen = true;
      if (ros[i] > yt.hi) {
        const s = spike(meta, times[i - 1], times[i]);
        off.push({cx: (x0 + x1) / 2, v: ros[i], minutes: s?.minutes ?? null, note: s?.note ?? null});
      }
    }
    const peak = off.reduce<OffScale | null>((a, b) => (!a || b.v > a.v ? b : a), null);
    return {line: d, off, peak};
  }, [times, x, y, yt, ros, series, meta]);
  const i = Math.max(1, indexAtOrAfter(times, t));
  const v = times.length > 1 && !unestimated(series, i) ? ros[i] : null;
  const pv = peak && formatValue(peak.v);
  const label =
    peak &&
    placeLabel(
      peak.cx,
      w,
      peak.minutes !== null
        ? [`▲ ${pv} · perimeters ${formatMinutes(peak.minutes)} apart`, `▲ ${pv} · ${formatMinutes(peak.minutes)} gap`, pv!]
        : [`${pv} ch/hr off scale`, `${pv} off scale`, pv!]
    );
  return (
    <>
      <YAxis ticks={yt.ticks} step={yt.step} y={y} w={w} unit="ch/hr" capped={capped} />
      <TimeXAxis start={start} end={end} tz={tz} x={x} w={w} h={h} />
      <PastFuture past={[[0, x(t)]]} w={w} h={h}>
        {past => (
          <>
            <path d={line} fill="none" stroke="var(--chart-rate)" strokeWidth={1.5} strokeDasharray={past ? undefined : '3 3'} />
            {off.map(o => (
              <path key={o.cx} d={`M${o.cx - 3.5},${M.t + 1}L${o.cx + 3.5},${M.t + 1}L${o.cx},${M.t - 4}Z`} fill="var(--chart-rate)">
                <title>{`${formatValue(o.v)} ch/hr, above the ${formatValue(yt.hi)} ch/hr axis.${o.note ? ` ${o.note}` : ''}`}</title>
              </path>
            ))}
          </>
        )}
      </PastFuture>
      {peak && label && (
        <text
          x={label.x}
          y={M.t + 4}
          textAnchor={label.anchor}
          fontSize={10}
          fontWeight={500}
          fill="var(--chart-rate)"
          stroke="var(--bg-chrome)"
          strokeWidth={3}
          paintOrder="stroke"
          opacity={peak.cx > x(t) ? 0.4 : 1}
        >
          {label.text}
          {peak.note && <title>{peak.note}</title>}
        </text>
      )}
      <Cursor x={x(t)} y={v === null ? null : y(v)} h={h} color="var(--chart-rate)" />
    </>
  );
}

type Loaded<T> = {data: T | null; error: string | null};

function empty<T>(file: string, s: Loaded<T>): ReactNode | null {
  if (s.error) return <ChartEmpty>{file} unavailable</ChartEmpty>;
  if (!s.data) return <ChartEmpty>Loading…</ChartEmpty>;
  return null;
}

const dataFiles = (base: string, ...names: string[]): DataFile[] => names.map(name => ({name, href: `${base}/${name}`}));

export function FireAreaChart({series, tz, base}: {series: Loaded<Series>; tz: string; base: string}) {
  const t = useTime(s => s.t);
  const v = useMemo(() => series.data && {times: series.data.t.map(Date.parse), area: series.data.area_acres}, [series.data]);
  const now = v ? interpolate(v.times, v.area, t) : null;
  return (
    <ChartFrame
      title="Fire Area"
      unit="acres"
      modeled={RASTER_NOTE}
      value={now === null ? null : `${formatValue(now)} ac`}
      foot="From the modeled arrival raster · hourly"
      footTitle="Burned area by hour, derived from the modeled arrival raster (interpolated between mapped perimeters); linear between hours"
      files={dataFiles(base, 'series.json')}
    >
      {empty('series.json', series) ?? <Plot>{(w, h) => <AreaPlot series={series.data!} tz={tz} w={w} h={h} />}</Plot>}
    </ChartFrame>
  );
}

export function RateOfSpreadChart({
  series,
  meta,
  tz,
  base
}: {
  series: Loaded<Series>;
  meta: Loaded<ArrivalIntervals>;
  tz: string;
  base: string;
}) {
  const t = useTime(s => s.t);
  const d = series.data;
  const times = useMemo(() => (d ? d.t.map(Date.parse) : []), [d]);
  const {top: axisTop, capped} = useMemo(() => rosAxis(d ? d.ros_chains_hr : []), [d]);
  const i = Math.max(1, indexAtOrAfter(times, t));
  const now = d && times.length > 1 ? d.ros_chains_hr[i] : null;
  const unest = d !== null && times.length > 1 && unestimated(d, i);
  const note = d && times.length > 1 ? spike(meta.data, times[i - 1], times[i])?.note : null;
  const value =
    now === null ? null : unest ? (
      <span className="font-normal text-muted">— ch/hr</span>
    ) : (
      `${now > axisTop ? '▲ ' : ''}${formatValue(now)} ch/hr`
    );
  return (
    <ChartFrame
      title="Rate of Spread"
      unit="chains/hr"
      modeled={RASTER_NOTE}
      value={value}
      valueTitle={
        unest
          ? 'Too few burning cells this hour to estimate a speed (the area still grew)'
          : now !== null && now > axisTop
            ? `Above the ${formatValue(axisTop)} ch/hr axis.${note ? ` ${note}` : ''}`
            : undefined
      }
      foot="From the modeled arrival raster · hourly"
      footTitle={
        '90th-percentile speed of the burning front over the hour ending at each time, derived from the modeled arrival ' +
        'raster (interpolated between mapped perimeters).' +
        (capped ? ` Axis capped at ${formatValue(axisTop)} ch/hr; ▲ marks hours above it. The value at the cursor is uncapped.` : '') +
        ' Gaps are hours the area grew but too few cells burned to estimate a speed.'
      }
      files={dataFiles(base, 'series.json', 'arrival_meta.json')}
    >
      {empty('series.json', series) ?? (
        <Plot>{(w, h) => <RosPlot series={d!} meta={meta.data} tz={tz} w={w} h={h} top={axisTop} capped={capped} />}</Plot>
      )}
    </ChartFrame>
  );
}

/** Index of the farthest profile sample burned by `ms` (−1 before the first arrival). */
function frontIndex(times: (number | null)[], ms: number): number {
  let front = -1;
  for (let i = 0; i < times.length; i++) {
    const at = times[i];
    if (at !== null && at <= ms) front = i;
  }
  return front;
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Elevation along the spine. A step far wider than the usual sample spacing has no samples in
 * it (step 06 closes the spine with a straight segment to the seed), so it is drawn dashed and
 * unfilled. A segment is solid once both its samples have burned; null-t samples never burn.
 */
function ProfilePlot({profile, times, w, h}: {profile: Profile; times: (number | null)[]; w: number; h: number}) {
  const t = useTime(s => s.t);
  const g = useMemo(() => {
    const d = profile.distance_km;
    const e = profile.elevation_m;
    const maxD = d[d.length - 1];
    const xt = niceTicks(0, maxD, 4);
    const yt = niceTicks(Math.min(...e), Math.max(...e), 3);
    const x = (km: number) => M.l + (km / maxD) * (w - M.l - M.r);
    const y = (m: number) => M.t + (1 - (m - yt.lo) / (yt.hi - yt.lo)) * (h - M.t - M.b);
    const steps = d.slice(1).map((v, i) => v - d[i]);
    const limit = 3 * median(steps);
    const pt = (i: number) => `${x(d[i]).toFixed(1)},${y(e[i]).toFixed(1)}`;
    const base = y(yt.lo).toFixed(1);
    let line = '';
    let area = '';
    let dashed = '';
    const gaps: Span[] = [];
    const lone: number[] = [];
    let run = 0;
    for (let i = 0; i < d.length; i++) {
      if (i < d.length - 1 && !(limit > 0 && steps[i] > limit)) continue;
      // Samples run..i are evenly spaced; a gap (or the end) follows.
      if (i > run) {
        const l = `M${Array.from({length: i - run + 1}, (_, k) => pt(run + k)).join('L')}`;
        line += l;
        area += `${l}L${x(d[i]).toFixed(1)},${base}L${x(d[run]).toFixed(1)},${base}Z`;
      } else lone.push(i);
      if (i < d.length - 1) {
        dashed += `M${pt(i)}L${pt(i + 1)}`;
        gaps.push([x(d[i]), x(d[i + 1])]);
      }
      run = i + 1;
    }
    return {xt: {...xt, ticks: xt.ticks.filter(k => k <= maxD + 1e-9)}, yt, x, y, line, area, dashed, gaps, lone};
  }, [profile, w, h]);
  const d = profile.distance_km;
  const burned = times.map(at => at !== null && at <= t);
  const past: Span[] = [];
  burned.forEach((b, i) => {
    if (!b) return;
    const px = g.x(d[i]);
    past.push([px - 2, px + 2]);
    if (burned[i + 1]) past.push([px, g.x(d[i + 1])]);
  });
  const f = frontIndex(times, t);
  const fx = f < 0 ? M.l : g.x(d[f]);
  return (
    <>
      <YAxis ticks={g.yt.ticks} step={g.yt.step} y={g.y} w={w} unit="m" compact={false} />
      {g.xt.ticks.map((k, i) => (
        <text key={k} x={g.x(k)} y={h - 2} textAnchor={i === 0 ? 'start' : 'middle'} {...AXIS_TEXT}>
          {tickLabel(k, g.xt.step)}
          {i === g.xt.ticks.length - 1 ? ' km' : ''}
        </text>
      ))}
      {g.gaps
        .filter(([a, b]) => b - a > 60)
        .map(([a, b]) => (
          <text key={a} x={(a + b) / 2} y={h - M.b - 4} textAnchor="middle" fontSize={9} fill="var(--text-muted)">
            no samples
          </text>
        ))}
      <PastFuture past={past} w={w} h={h}>
        {() => (
          <>
            <path d={g.area} fill="var(--chart-elev-fill)" />
            <path d={g.line} fill="none" stroke="var(--chart-elev-stroke)" strokeWidth={1.5} />
            <path d={g.dashed} fill="none" stroke="var(--chart-elev-stroke)" strokeWidth={1.2} strokeDasharray="3 3" opacity={0.7} />
            {g.lone.map(i => (
              <circle key={i} cx={g.x(d[i])} cy={g.y(profile.elevation_m[i])} r={1.8} fill="var(--chart-elev-stroke)" />
            ))}
          </>
        )}
      </PastFuture>
      {f >= 0 && (
        <g>
          <line x1={fx} x2={fx} y1={M.t} y2={h - M.b} stroke="var(--text)" strokeOpacity={0.35} strokeDasharray="2 2" />
          <circle cx={fx} cy={g.y(profile.elevation_m[f])} r={4} fill="var(--chart-rate)" stroke="var(--bg-chrome)" strokeWidth={1.5} />
        </g>
      )}
    </>
  );
}

export function ElevationProfileChart({profile, base}: {profile: Loaded<Profile>; base: string}) {
  const t = useTime(s => s.t);
  const p = profile.data;
  const times = useMemo(() => (p ? p.t.map(s => (s === null ? null : Date.parse(s))) : []), [p]);
  const f = frontIndex(times, t);
  const short = p && p.distance_km.length > 0 && p.distance_km[p.distance_km.length - 1] < 2;
  const value =
    !p ? null : f < 0 ? (
      <span className="font-normal text-muted">no modeled arrival yet</span>
    ) : (
      `${formatValue(p.elevation_m[f])} m · ${p.distance_km[f].toFixed(short ? 2 : 1)} km`
    );
  return (
    <ChartFrame
      title="Elevation Profile"
      unit="spread spine"
      modeled={PROFILE_NOTE}
      value={value}
      foot={
        <>
          From the modeled arrival raster · <span className="text-[var(--chart-rate)]">●</span> front
        </>
      }
      footTitle={
        'Elevation along the spread spine from the terrain model (DEM). The spine and each sample’s arrival time come from ' +
        'the modeled arrival raster; the red dot is the farthest sample burned by the cursor time. Dashed spans have no samples.'
      }
      files={dataFiles(base, 'profile.json')}
    >
      {empty('profile.json', profile) ??
        (p!.distance_km.length < 2 ? (
          <ChartEmpty>profile.json has too few samples</ChartEmpty>
        ) : (
          <Plot>{(w, h) => <ProfilePlot profile={p!} times={times} w={w} h={h} />}</Plot>
        ))}
    </ChartFrame>
  );
}
